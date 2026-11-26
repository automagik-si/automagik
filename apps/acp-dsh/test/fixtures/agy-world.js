// Antigravity with the Bot team's native-tools switch (#1564): the plugin's real wiring with a
// cliHome (agy's own isolated home), and an `agy` that is a shell script running the fake ACP
// agent. It records its argv, environment and pid, answers an agy version, and writes agy's own
// per-process log at `session/new` as the test's control file says (dev/fake-agent.mjs). No real
// agy runs and nothing is downloaded.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { apply, SERVICE } from '../../index.js'
import { fakeContext } from '../../../bots-dsh/test/fake-ctx.js'

export const AGY = 'acp-antigravity'
export const AGY_OFF_ARGS = ['acp', '--agent', 'automagik-native-off', '--cli_dir_name', 'automagik-native-off']
export const unixOnly = { skip: process.platform === 'win32' ? 'the fake agy uses a POSIX shebang' : false }
export const ownerMessage = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
export const BOOT = 'I1124 02:21:34.066294      84 boot.go:65] Booting backend (overlay=false)'
export const FAILED = 'I1124 02:21:34.069909      84 boot.go:109] Failed to load CLI settings, using defaults: open settings.json: no such file or directory'
export const MALFORMED = 'I1124 02:21:34.069909      84 boot.go:109] Failed to load CLI settings, using defaults: malformed settings json: unexpected end of JSON input'

const FAKE = join(import.meta.dirname, '..', '..', 'dev', 'fake-agent.mjs')
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const writeCli = (path, env) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `#!/bin/sh
${Object.entries(env).map(([key, value]) => `export ${key}=${quote(value)}`).join('\n')}
exec ${quote(process.execPath)} ${quote(FAKE)} "$@"
`)
  chmodSync(path, 0o755)
  return path
}

const waterfall = (listeners, terminal, invoke) => [...listeners].reduceRight(
  (next, listener) => () => invoke(listener, next), terminal)()

// Run the real Bots approval listeners with the same prepend and removal rules as Cordis.
// The plugin's peer imports use the ACP test's pinned harness on this integration path.
export async function approvalTeam(t, { provider = AGY, level = 'workspace-write', botAuto = false, reviewer = 'allow' } = {}) {
  const botsUrl = new URL('../../../bots-dsh/', import.meta.url).href
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.startsWith(botsUrl) && specifier.startsWith('@deepseek-ai/')) {
        return nextResolve(specifier, { ...context, parentURL: import.meta.url })
      }
      return nextResolve(specifier, context)
    },
  })
  t.after(() => hook.deregister())
  const { apply: applyBots } = await import('../../../bots-dsh/index.js')
  const home = mkdtempSync(join(tmpdir(), 'approval-team-'))
  const botId = 'fixture-bot'
  const id = 'fixture-owned-chat'
  const model = `${provider}/default`
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, mainBotIds: [botId], revision: 1, rooms: {}, exchanges: [], exchangeTurns: {}, questions: {},
    bots: { [botId]: { id: botId, sessionId: id, name: 'Fixture Bot', role: '', instructions: '', createdAt: 1, model, appliedModel: model } },
  }))
  // Let the Pocket module construct its real approval source, while occupying the socket path
  // with a fixture-only file so the plugin starts no Pocket server.
  mkdirSync(join(home, 'pocket'))
  writeFileSync(join(home, 'pocket', 'chat.sock'), '')
  const presets = {
    current: () => level,
    resolve: name => ({ sandbox: name === 'auto' ? 'danger-full-access' : 'workspace-write', approval: 'ask' }),
    set: (_session, name) => { level = name },
  }
  const sandboxPolicy = { resolve: () => ({ mode: 'workspace-write' }) }
  const chatSessions = new Map()
  const ctx = fakeContext({ services: {
    permissionPresets: presets, sandboxPolicy, sessions: chatSessions,
    approval: { request: request => approval.request(request), effectivePolicy: () => 'ask' },
  } })
  const reviewers = []
  ctx.llm = {
    ...ctx.llm,
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }),
    async* stream(request) {
      reviewers.push(request)
      if (reviewer === 'failure') throw new Error('fixture reviewer unavailable')
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ decision: reviewer, reason: 'fixture decision' }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  ctx.sessions = { get: key => chatSessions.get(key), list: () => [...chatSessions.values()], async flush() {} }
  ctx.sessionController = {
    follow() {}, events() {}, state() {}, observeState() {}, prompt() {}, cancel() {},
    async resolveAgent(key) { return { agent: { session: chatSessions.get(key) ?? { id: key } } } },
  }
  const origin = new WeakMap()
  ctx.on = (name, listener, { prepend } = {}) => {
    if (name === 'approval/request') {
      const location = new Error().stack.split('\n')[2]
      origin.set(listener, /[/\\]([\w-]+)\.js:\d+:\d+/.exec(location)?.[1])
    }
    const registered = ctx.listeners.get(name) ?? []
    ctx.listeners.set(name, registered)
    if (prepend) registered.unshift(listener)
    else registered.push(listener)
    return () => {
      const index = registered.indexOf(listener)
      if (index !== -1) registered.splice(index, 1)
    }
  }
  const pocketReady = Promise.withResolvers()
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  applyBots(ctx, { home })
  const rt = ctx.provided.get('omniTeam')
  rt.warn = message => {
    if (String(message).includes('Pocket chat is off')) pocketReady.resolve()
  }
  await rt.load()
  assert.equal(rt.chatOf(botId), id)
  assert.equal(rt.chatOwners.get(id), botId)
  await pocketReady.promise
  rt.backgroundModel = async () => 'deepseek/fixture'
  rt.cachedBackground = () => 'deepseek/fixture'
  if (botAuto) {
    await rt.setBotAuto(botId, 0)
    assert.equal(rt.botOf(botId).permission, 'workspace-write')
    assert.equal(rt.botOf(botId).permissionAuto, AGY)
  }
  const controls = { ask: () => 'allowed-once' }
  const approvals = []
  const requests = []
  const terminal = []
  const settled = []
  const order = new Map()
  const stop = rt.onApproval((kind, entry) => {
    if (kind === 'open' && entry.answerable === true) approvals.push(entry)
    if (kind === 'settled') settled.push(entry)
  })
  t.after(stop)
  function attach(session) {
    chatSessions.set(session.id, session)
    t.mock.method(session, 'append', function (...args) {
      const result = Session.prototype.append.apply(this, args)
      for (const row of Array.isArray(result) ? result : [result]) {
        for (const listener of ctx.listeners.get('session/event') ?? []) listener(session, row)
      }
      return result
    })
  }
  const approval = {
    effectivePolicy: () => 'ask',
    async request(request) {
      const { agent: { session }, toolName, callId, reason } = request
      const id = randomUUID()
      requests.push(request)
      const trace = []
      order.set(callId, trace)
      session.append('approval/asked', { id, toolName, callId, ...(reason !== undefined && { reason }) })
      const outcome = await waterfall(ctx.listeners.get('approval/request'), () => {
        terminal.push(callId)
        return controls.ask(request)
      }, (listener, next) => {
        trace.push(origin.get(listener))
        return listener(request, next)
      })
      session.append('approval/decided', { id, outcome })
      return outcome
    },
  }
  return { id, rt, controls, approval, attach, approvals, requests, terminal, settled, order, reviewers, presets }
}

export function agyWorld(t, { sandbox = true, version, registry, platform = process.platform, cliHome: withHome = true, deps = {}, env = {}, level = 'workspace', team } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-dsh-agy-off-'))
  const cliHome = join(dir, 'acp', 'cli-homes')
  const trace = join(dir, 'agy-trace.jsonl')
  const envFile = join(dir, 'agy-env.jsonl')
  const control = join(dir, 'agy-log.json')
  writeFileSync(control, JSON.stringify({ lines: [BOOT] }))
  const agy = writeCli(join(dir, 'bin', 'agy'), {
    FAKE_ACP_MODES: 'default', FAKE_ACP_TRACE: trace, FAKE_ACP_ENV_FILE: envFile, FAKE_ACP_AGY_LOG: control,
    ...(version === undefined ? {} : { FAKE_ACP_AGENT_VERSION: version }),
    ...(registry === undefined ? {} : { FAKE_ACP_AGY_REGISTRY: registry }),
    ...env,
  })
  const agents = new Map()
  const approvals = team?.approvals ?? []
  const requests = team?.requests ?? []
  const controls = team?.controls ?? { ask: () => 'allowed-once' }
  const logs = []
  const services = {
    approval: team?.approval ?? { effectivePolicy: () => level === 'full' ? 'never' : 'ask', request: async request => {
      requests.push(request)
      approvals.push(request)
      return controls.ask(request)
    } },
    permissionPresets: team?.presets ?? { current: () => level },
    ...(sandbox ? { sandboxPolicy: {
      defaultMode: 'workspace-write',
      resolve: ({ session }) => ({ mode: session?.snapshotEvents().findLast(event => event.type === 'sandbox/mode')?.data.mode ??
        (level === 'full' ? 'danger-full-access' : 'workspace-write') }),
    } } : {}),
  }
  const disposers = []
  const listeners = new Map()
  let adapter
  const ctx = {
    logger: { warn: line => logs.push(line), info() {} },
    llm: { registerAdapter: (_providers, candidate) => { adapter = candidate; return () => {} } },
    agents: { get: id => agents.get(id), turnBoundaryOf: () => ({ lastTurn: 1 }) },
    get: name => services[name],
    on: (name, listener, { prepend } = {}) => {
      const callbacks = listeners.get(name) ?? []
      if (prepend) callbacks.unshift(listener)
      else callbacks.push(listener)
      listeners.set(name, callbacks)
      return () => {
        const index = callbacks.indexOf(listener)
        if (index !== -1) callbacks.splice(index, 1)
      }
    },
    effect: fn => { disposers.push(fn()) },
    provide: (name, service) => { services[name] = service },
    emit() {},
  }
  const store = {
    binOf: () => undefined, busy: () => false, lastError: () => undefined, lastFailure: () => undefined,
    update: async () => {}, stateOf: () => undefined, markGood: () => {}, rollback: () => undefined, dispose: () => {},
  }
  apply(ctx, { claude: false, codex: false, antigravity: true, dshTools: true }, {
    store, find: name => (name === 'agy' ? agy : undefined), signedIn: async () => undefined,
    catalogHome: join(dir, 'catalog'), ...(withHome ? { cliHome } : {}), platform, ...deps,
  })
  t.after(async () => {
    for (const dispose of disposers) dispose?.()
    await sleep(50)
    rmSync(dir, { recursive: true, force: true })
  })
  const service = services[SERVICE]
  const read = file => {
    try { return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
    catch (error) { if (error.code === 'ENOENT') return []; throw error }
  }
  const events = event => read(trace).filter(row => event === undefined || row.event === event)
  // The agy home the app selects now: the generation the pointer names, else the first home.
  const home = () => {
    const pointer = join(cliHome, 'current', 'antigravity')
    if (!existsSync(pointer)) return join(cliHome, 'antigravity')
    return join(cliHome, 'homes', 'antigravity', readFileSync(pointer, 'utf8'))
  }
  const logDir = (base = home()) => join(base, '.gemini', 'antigravity-cli', 'automagik-native-off', 'log')
  const logOf = pid => {
    const folder = logDir()
    if (!existsSync(folder)) return undefined
    const name = readdirSync(folder).find(entry => entry.endsWith(`-${pid}.log`))
    return name === undefined ? undefined : join(folder, name)
  }
  function conversation(marker) {
    const prompts = events('prompt').filter(row => row.text.includes(marker))
    assert.equal(prompts.length, 1, marker)
    const { pid } = prompts[0]
    const child = events().filter(row => row.pid === pid)
    return { pid, args: child.find(row => row.event === 'start').args, prompt: prompts[0].text }
  }
  const startsAfter = count => events('start').slice(count).filter(row => row.args[0] === 'acp')
  const onExecute = listener => ctx.on('tools/execute', listener)
  const execute = (call, dispatch) => waterfall(listeners.get('tools/execute') ?? [], dispatch,
    (listener, next) => listener(call, next))
  const preExecute = exec => waterfall(listeners.get('tools/pre-execute') ?? [], () => ({ kind: 'allow' }),
    (listener, next) => listener(exec, next))
  const postExecute = (exec, result) => waterfall(listeners.get('tools/post-execute') ?? [], () => ({ kind: 'accept' }),
    (listener, next) => listener(exec, result, next))
  function chat(id = team?.id ?? 'chat') {
    const session = Session.create(id, undefined, { version: 4, id, createdAt: 0, isSeeded: false, cwd: dir })
    team?.attach(session)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const agent = { session, ctx: { tools: { register: () => () => {} } } }
    agents.set(id, agent)
    const history = []
    async function turn(message, prior = [], signal) {
      history.push(...prior, typeof message === 'string' ? ownerMessage(message) : message)
      const chunks = []
      for await (const chunk of adapter.stream(markAgentLoopRequest({ provider: AGY, model: 'default', sessionId: id, messages: [...history], signal }))) chunks.push(chunk)
      const content = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
      history.push({ role: 'assistant', source: { kind: 'model', provider: AGY, model: 'default' }, content })
      return chunks
    }
    function policyEvent(type, data) {
      const event = session.append(type, data)
      for (const listener of listeners.get('session/event') ?? []) listener(session, event)
    }
    return { session, turn, policyEvent }
  }
  return {
    dir, cliHome, agy, control, controls, onExecute, execute, preExecute, postExecute, logs, approvals, requests, services, service, events, home, logDir, logOf, conversation, chat, startsAfter,
    get adapter() { return adapter },
    envs: () => read(envFile),
    setLog: value => writeFileSync(control, JSON.stringify(value)),
  }
}
