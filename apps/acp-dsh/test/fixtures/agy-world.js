// Antigravity with the Bot team's native-tools switch (#1564): the plugin's real wiring with a
// cliHome (agy's own isolated home), and an `agy` that is a shell script running the fake ACP
// agent. It records its argv, environment and pid, answers an agy version, and writes agy's own
// per-process log at `session/new` as the test's control file says (dev/fake-agent.mjs). No real
// agy runs and nothing is downloaded.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { apply, SERVICE } from '../../index.js'

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

export function agyWorld(t, { sandbox = true, version, registry, platform = process.platform, cliHome: withHome = true, deps = {}, env = {} } = {}) {
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
  const approvals = []
  const logs = []
  const services = {
    approval: { effectivePolicy: () => 'ask', request: async request => { approvals.push(request); return 'allowed-once' } },
    ...(sandbox ? { sandboxPolicy: {
      defaultMode: 'workspace-write',
      resolve: ({ session }) => ({ mode: session?.snapshotEvents().findLast(event => event.type === 'sandbox/mode')?.data.mode ?? 'workspace-write' }),
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
    on: (name, listener) => {
      const callbacks = listeners.get(name) ?? new Set()
      callbacks.add(listener)
      listeners.set(name, callbacks)
      return () => callbacks.delete(listener)
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
  function chat(id = 'chat') {
    const session = Session.create(id, undefined, { version: 4, id, createdAt: 0, isSeeded: false, cwd: dir })
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
    dir, cliHome, agy, control, logs, approvals, services, service, events, home, logDir, logOf, conversation, chat, startsAfter,
    get adapter() { return adapter },
    envs: () => read(envFile),
    setLog: value => writeFileSync(control, JSON.stringify(value)),
  }
}
