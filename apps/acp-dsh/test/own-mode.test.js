// Which of an ACP agent's actions a `tools/execute` guard can refuse, and which it cannot. The
// Bot team marks a Session whose permission level could not be set and refuses every tool
// there in its `tools/execute` guard (bots-dsh, permissions.js `levelHolds`). These tests run
// the adapter over the fake agent on real stdio and DSH's real tool pipeline (its ToolsService
// and native executor), with a stand-in for that guard: a `tools/execute` listener that throws
// on the Sessions a test marks. This package's tests need no Bot team.
//
// The facts, one test each: an own tool that asks is refused before it runs; an own tool that
// does not ask (its mode lets it through) has run whatever the guard says, in the wide mode the
// Session's unset level gave the agent; a DSH tool over the bridge is refused.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session } from '@deepseek-ai/dsh-session'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import * as native from '@deepseek-ai/dsh-tool-executor-native'
import { AcpAdapter } from '../src/host/adapter.js'
import { KILL_AFTER_MS } from '../src/host/acp.js'
import { fileIdentity } from '../src/host/session-files.js'
import { AGENTS, CLAUDE_HARD_ASK } from '../src/host/agents.js'
import { PermissionDiagnostics } from '../src/host/permission-diagnostics.js'
import { apply, SERVICE } from '../index.js'
import { Backchannel } from '../src/host/backchannel.js'
import { isRemoteJsonValue } from '@deepseek-ai/dsh-typert-protocol'
import { mirrorTool } from '../src/host/tool.js'

// What DSH's gateway sends a remote approval card (dsh-api-gateway projectRemoteEventRequest): every own key but agent and signal, as lossless JSON.
const remoteJson = request => isRemoteJsonValue(Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'agent' && key !== 'signal')))

const FAKE = join(import.meta.dirname, '..', 'dev', 'fake-agent.mjs')
const PROVIDER = 'acp-fake'
const FULL = 'danger-full-access'
const WRITE = 'workspace-write'
// The sentence the Bot team's guard refuses with (bots-dsh, permissions.js).
const SENTENCE = 'The workspace-write permission level could not be set on this conversation, so no tool runs here until it is. Tell the user: restarting DeepSeek Harness, or changing the permission level, tries again.'

// Nothing here waits without a bound: a hanging agent fails its test, it never hangs the run.
const within = (promise, what, ms = 15_000) => {
  let timer
  return Promise.race([promise, new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(`${what} did not finish in ${ms} ms`)), ms) })]).finally(() => clearTimeout(timer))
}
const waitFor = async (check, ms = 10_000) => {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const said = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

/**
 * One DSH host: the real pipeline, fakes for the services around it, and the adapter on the
 * fake agent. `level` is what every Session reads (the level it HAS, which on a marked Session
 * is not the one chosen), `modes` what the fake agent offers, `modeFor` the agent's own map
 * from a level to its modes, `bridge` whether DSH's tools reach the agent.
 */
async function world(t, { level: startLevel = FULL, modes, modeFor, bridge = false, env = {}, gates = [], holdWaitMs, access, ownMode, ownModeWaitMs = 10, spec: extra = {}, answer = 'allowed-once', bash } = {}) {
  let level = startLevel
  const dir = mkdtempSync(join(tmpdir(), 'acp-own-tools-'))
  const tracePath = join(dir, 'trace.jsonl')
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() {}, section() {} })
  await ctx.plugin(ToolsService)
  await ctx.plugin(native)
  // A DSH tool of its own, for the bridge: its body records that it ran.
  const executed = []
  ctx.tools.register({
    name: 'bash',
    description: 'Run a command',
    parameters: { type: 'object', properties: {} },
    output: { schema: {}, render: () => [{ type: 'text', text: 'ran bash' }] },
    async execute(args) {
      executed.push(args)
      await bash?.(executed.length)
      return {}
    },
  })
  const asked = []
  ctx.provide('approval', {
    effectivePolicy: () => (level === FULL ? 'never' : 'ask'),
    overrideOf: () => 'ask',
    request: async (request) => { asked.push(request); return typeof answer === 'function' ? answer(request) : answer },
  })
  ctx.provide('permissionPresets', { current: () => level, set() {}, registerAuto: () => () => {} })
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: level }) })
  ctx.provide('sessions', { list: () => [] })
  const workspaceRegistry = { archivedSessionIds: [] }
  ctx.provide('workspaceRegistry', workspaceRegistry)
  ctx.provide('workingDirectory', { ensure: async () => dir })
  ctx.provide('agentPresets', { presetForSession: () => 'standard' })
  const agents = new Map()
  ctx.provide('agents', { get: id => agents.get(id), list: () => [...agents.values()], turnBoundaryOf: () => ({ lastTurn: 1 }) })

  // The stand-in for the Bot team's guard: every tool of a marked Session is refused at
  // `tools/execute`, before its body.
  const marked = new Set()
  const guarded = []
  ctx.on('tools/execute', (exec, next) => {
    const id = exec.agent?.session?.id
    if (!marked.has(id)) return next()
    guarded.push(exec.name)
    throw Object.assign(new Error(SENTENCE), { code: 'bot/refused' })
  }, { prepend: true })

  const spec = {
    name: 'Fake agent',
    catalog: { models: async () => [{ id: 'default', name: 'Fake agent' }], model: async () => undefined, ownEffort: () => undefined, dispose() {} },
    installed: () => true,
    spawn: () => ({ command: process.execPath, args: [FAKE], env: { FAKE_ACP_TRACE: tracePath, ...(modes === undefined ? {} : { FAKE_ACP_MODES: modes.join(',') }), ...env } }),
    ...(modeFor === undefined ? {} : { modeFor }),
    ...extra,
  }
  const backchannel = new Backchannel({ ctx })
  const adapter = new AcpAdapter(ctx, new Map([[PROVIDER, spec]]), { ownMode: () => ownMode, ownModeWaitMs, dshTools: () => bridge, backchannel, holds: () => gates, ...(access === undefined ? {} : { access }), ...(holdWaitMs === undefined ? {} : { holdWaitMs }) })
  adapter.diagnostics = new PermissionDiagnostics()
  let scopes
  await ctx.plugin({ name: 'test-agents', inject: ['tools'], apply(child) { scopes = child } })
  // Every agent process a test started, whatever became of its run: none outlives its test.
  const runs = new Set()
  const pids = () => { try { return new Set(readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).pid)) } catch { return new Set() } }
  t.after(async () => {
    for (const run of runs) { try { run.child?.kill('SIGKILL') } catch {} }
    for (const pid of pids()) { try { process.kill(pid, 'SIGKILL') } catch {} }
    adapter.dispose()
    backchannel.dispose()
    await ctx.root.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  // One chat on the agent: a DSH Session in an open step, its agent scope, the mirror in it.
  const chat = (id) => {
    const session = Session.create(id, undefined, { version: 4, id, createdAt: 0, isSeeded: false, cwd: dir })
    const agent = { session, status: 'idle' }
    const scope = createScope(scopes, agent)
    t.after(() => scope.dispose())
    agent.ctx = scope.ctx
    agents.set(id, agent)
    adapter.registerMirror(agent)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const { name, description, parameters } = adapter.tool
    session.append('request/header', { header: { config: { provider: PROVIDER, model: 'default' }, tools: [{ name, description, parameters }] } })
    const messages = []
    // One model step, as DSH's loop streams it.
    const step = ({ signal, input = messages } = {}) => within((async () => {
      const chunks = []
      for await (const chunk of adapter.stream(markAgentLoopRequest({ provider: PROVIDER, model: 'default', sessionId: id, messages: input, signal }))) chunks.push(chunk)
      input.push({ role: 'assistant', source: { kind: 'model', provider: PROVIDER, model: 'default' }, content: chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block) })
      return chunks
    })(), 'the step')
    // The step's mirror call through the pipeline, as the loop runs it: the assistant row, the
    // step's admission, the batch with its log. The result goes back as the tool message.
    const run = block => within((async () => {
      session.append('assistant/message', {
        turn: 1, step: 1, stream: [],
        message: createAssistantMessage({ content: [{ type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments }], source: { provider: PROVIDER, model: 'default' } }),
      }, { surfaceOp: 'append' })
      const signal = new AbortController().signal
      const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: PROVIDER, model: 'default' }, signal })
      try {
        const batch = await ctx.tools.execute({ calls: [{ id: block.id, name: block.name, arguments: block.arguments }], agent, signal, log: { turn: 1, step: 1 }, toolSet, maxParallelToolCalls: 1 })
        const result = batch.results[0].result
        messages.push({ role: 'tool', toolCallId: block.id, source: { kind: 'tool', callId: block.id }, content: result.content })
        return result
      } finally {
        toolSet.dispose()
      }
    })(), 'the tool call')
    const say = text => messages.push(said(text))
    return { id, session, agent, messages, step, run, say }
  }
  const trace = () => (existsSync(tracePath) ? readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [])
  const events = name => trace().filter(entry => entry.event === name)
  // The fake writes its trace beside its updates: a line is waited for, never assumed there.
  const seen = async (name, count = 1) => { await waitFor(() => events(name).length >= count); return events(name) }
  const markArchived = id => { workspaceRegistry.archivedSessionIds.push(id) }
  const archive = async id => {
    markArchived(id)
    await ctx.parallel('workspace/session-archived', { sessionId: id })
  }
  const undo = id => { workspaceRegistry.archivedSessionIds = workspaceRegistry.archivedSessionIds.filter(archived => archived !== id) }
  return { ctx, adapter, backchannel, runs, chat, marked, guarded, executed, asked, trace, events, seen, gates, markArchived, archive, undo, setLevel: (next) => { level = next } }
}

const MODES = ['workspace-write', 'read-only', 'agent', 'agent-full-access']
for (const [name, answer, expected] of [
  ['two exact true answers', () => true, 'agent'],
  ['no answerer', undefined, WRITE],
  ['false', () => false, WRITE],
  ['string true', () => 'true', WRITE],
  ['number one', () => 1, WRITE],
  ['object', () => ({}), WRITE],
  ['throw', () => { throw new Error('no') }, WRITE],
  ['late', () => new Promise(() => {}), WRITE],
]) test(`own mode: ${name}`, async t => {
  const w = await world(t, { level: WRITE, modes: MODES, modeFor: AGENTS['acp-codex'].modeFor, spec: { ownMode: 'agent' }, ownMode: answer })
  const chat = w.chat('chat')
  chat.say('hello')
  const chunks = await chat.step()
  assert.ok(w.trace().length > 0, JSON.stringify(chunks))
  const trace = w.trace().filter(row => ['set-mode', 'prompt'].includes(row.event))
  assert.ok(trace.length > 0, JSON.stringify({ chunks, trace: w.trace() }))
  assert.deepEqual(trace.map(row => [row.event, row.modeId]), expected === 'agent'
    ? [['set-mode', 'agent'], ['prompt', undefined]]
    : [['prompt', undefined]])
  assert.equal(w.adapter.diagnostics.read('chat').version, 2)
  const record = w.adapter.diagnostics.read('chat').ownMode
  if (expected === 'agent' || name === 'late') assert.equal(record.taken, expected === 'agent')
  else assert.equal(record, undefined)
})
test('own mode: a changed answer forces strict before the prompt', async t => {
  let asks = 0
  const w = await world(t, { level: WRITE, modes: MODES, modeFor: AGENTS['acp-codex'].modeFor, spec: { ownMode: 'agent' }, ownMode: () => ++asks === 1 })
  const chat = w.chat('chat'); chat.say('hello'); await chat.step()
  assert.deepEqual(w.events('set-mode').map(row => row.modeId), ['agent', WRITE])
  assert.equal(w.adapter.diagnostics.read('chat').ownMode.answer, 'changed')
})
test('own mode: refused own mode falls back to confirmed strict', async t => {
  const w = await world(t, { level: WRITE, modes: MODES, modeFor: AGENTS['acp-codex'].modeFor, spec: { ownMode: 'agent' }, ownMode: () => true, env: { FAKE_ACP_REFUSE_MODES: 'agent' } })
  const chat = w.chat('chat'); chat.say('hello'); await chat.step()
  assert.deepEqual(w.events('set-mode').map(row => row.modeId), [WRITE])
  assert.equal(w.adapter.diagnostics.read('chat').ownMode.answer, 'refused')
})

for (const verdict of ['allowed-once', 'rejected', 'unavailable', 'throw', 'stop']) test(`own mode still asks the person: ${verdict}`, async t => {
  let release
  const waiting = new Promise(resolve => { release = resolve })
  const w = await world(t, { level: WRITE, modes: MODES, modeFor: AGENTS['acp-codex'].modeFor, spec: { ownMode: 'agent' }, ownMode: () => true,
    answer: async () => { await waiting; if (verdict === 'throw') throw new Error('approval unavailable'); return verdict } })
  const c = w.chat('approval'); c.say('hi')
  const first = await c.step()
  const call = first.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block).find(block => block.type === 'tool-call')
  assert.ok(call)
  assert.deepEqual(w.events('set-mode').map(row => row.modeId), ['agent'])
  assert.equal(w.adapter.ownModeIn(c.id), true)
  const live = w.adapter.live.get(c.id)
  await waitFor(() => live.run.tools.get('call-1-1')?.permission !== undefined)
  const permission = live.run.tools.get('call-1-1').permission
  const answers = []
  const original = permission.answer.bind(permission)
  permission.answer = value => { answers.push(value); return original(value) }
  let done = false
  const running = c.run(call).finally(() => { done = true })
  await waitFor(() => w.asked.length === 1)
  assert.equal(done, false)
  assert.deepEqual(answers, [])
  assert.equal(JSON.stringify(c.messages).includes('It printed'), false)
  if (verdict === 'stop') w.adapter.endSession(c.id)
  release()
  await running
  const outcome = answers[0]?.outcome
  if (verdict === 'allowed-once') assert.deepEqual(outcome, { outcome: 'selected', optionId: 'yes' })
  else if (verdict === 'rejected') assert.deepEqual(outcome, { outcome: 'selected', optionId: 'no' })
  else assert.equal(outcome?.outcome, 'cancelled')
})

test('own mode: bridged Workspace asks and takes its own mode', async t => {
  let asks = 0
  const w = await world(t, { level: WRITE, modes: MODES, bridge: true, modeFor: AGENTS['acp-codex'].modeFor, spec: { ownMode: 'agent' }, ownMode: () => { asks++; return true } })
  const c = w.chat('bridge'); c.say('hi'); await c.step()
  assert.equal(asks, 2)
  assert.deepEqual(w.events('set-mode').map(row => row.modeId), ['agent'])
})
for (const [level, mode] of [['read-only', 'read-only'], [FULL, 'agent-full-access'], ['auto', 'agent']]) test(`own mode: ${level} keeps its existing mode`, async t => {
  let asks = 0
  const w = await world(t, { level, modes: MODES, modeFor: AGENTS['acp-codex'].modeFor, spec: { ownMode: 'agent' }, ownMode: () => { asks++; return true } })
  const c = w.chat('other'); c.say('hi'); await c.step()
  assert.equal(asks, 0)
  assert.deepEqual(w.events('set-mode').map(row => row.modeId), [mode])
})
test('own mode: refused strict mode without an own-mode attempt keeps the session without prompting', async t => {
  const w = await world(t, { level: WRITE, modes: ['read-only', ...MODES.filter(mode => mode !== 'read-only')], modeFor: AGENTS['acp-codex'].modeFor, spec: { ownMode: 'agent' }, env: { FAKE_ACP_REFUSE_MODES: WRITE } })
  const c = w.chat('refused'); c.say('hi'); const chunks = await c.step()
  assert.equal(w.events('prompt').length, 0)
  assert.equal(w.adapter.live.has(c.id), true)
  assert.notEqual(w.adapter.live.get(c.id).ownSent, true)
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.match(JSON.stringify(chunks.at(-1)), /Refused mode: workspace-write/)
})

for (const [name, answer] of [['no answerer', undefined], ['false', () => false]]) test(`own mode: ${name} never re-sends cached Workspace, even if the agent would refuse it`, async t => {
  const w = await world(t, { level: WRITE, modes: MODES, modeFor: AGENTS['acp-codex'].modeFor, spec: { ownMode: 'agent' }, ownMode: answer, env: { FAKE_ACP_REFUSE_MODES: WRITE } })
  const c = w.chat('cached')
  for (let turn = 1; turn <= 2; turn++) {
    c.say('plain'); const chunks = await c.step()
    assert.notEqual(chunks.at(-1).reason.kind, 'error')
    assert.equal(w.events('prompt').length, turn)
    assert.deepEqual(w.events('set-mode'), [])
    assert.equal(w.adapter.diagnostics.read(c.id).ownMode, undefined)
  }
})

for (const refuses of [false, true]) test(`own mode: after an own-mode prompt, cached strict is awaited${refuses ? ' and refusal ends the session' : ''}`, async t => {
  let asks = 0
  const w = await world(t, { level: WRITE, modes: MODES, modeFor: AGENTS['acp-codex'].modeFor, spec: { ownMode: 'agent' }, ownMode: () => ++asks <= 2, env: refuses ? { FAKE_ACP_REFUSE_MODES: WRITE } : {} })
  const c = w.chat('changed'); c.say('plain'); await c.step()
  const live = w.adapter.live.get(c.id)
  assert.equal(live.ownSent, true)
  assert.equal(asks, 2)
  assert.deepEqual(w.events('set-mode').map(row => row.modeId), ['agent'])
  // The cache says strict already, but an earlier own-mode send requires confirmation.
  live.run.modes.currentModeId = WRITE
  let release
  const waiting = new Promise(resolve => { release = resolve })
  t.after(() => release())
  let sent = false
  const setMode = live.run.conn.setSessionMode.bind(live.run.conn)
  t.mock.method(live.run.conn, 'setSessionMode', async params => {
    assert.equal(params.modeId, WRITE)
    sent = true
    await waiting
    return setMode(params)
  })
  c.say('plain again')
  const next = c.step()
  await waitFor(() => sent)
  assert.equal(w.events('prompt').length, 1, 'the next prompt waits for strict confirmation')
  release()
  const chunks = await next
  assert.equal(asks, 3)
  if (refuses) {
    assert.equal(w.adapter.live.has(c.id), false)
    assert.equal(chunks.at(-1).reason.kind, 'error')
    assert.match(JSON.stringify(chunks.at(-1)), /Refused mode: workspace-write/)
    assert.equal(w.events('prompt').length, 1)
  } else {
    assert.deepEqual(w.trace().filter(row => ['set-mode', 'prompt'].includes(row.event)).map(row => [row.event, row.modeId]), [
      ['set-mode', 'agent'], ['prompt', undefined], ['set-mode', WRITE], ['prompt', undefined],
    ])
    assert.equal(w.adapter.live.get(c.id), live)
    assert.equal(live.ownSent, true)
    assert.equal(w.adapter.diagnostics.read(c.id).ownMode.answer, 'no')
  }
})
for (const event of ['agent/status', 'agent/disposed']) test(`own mode: ${event} ends a busy own-mode session`, async t => {
  const w = await world(t, { level: WRITE, modes: MODES, modeFor: AGENTS['acp-codex'].modeFor, spec: { ownMode: 'agent' }, ownMode: () => true, env: { FAKE_ACP_IGNORE_CANCEL: '1' } })
  const c = w.chat('busy'); c.say('hi'); await c.step()
  assert.equal(w.adapter.ownModeIn(c.id), true)
  w.ctx.emit(event, { agent: c.agent, status: 'idle' })
  assert.equal(w.adapter.live.has(c.id), false)
  assert.equal(w.adapter.ownModeIn(c.id), false)
})

function harness({ clis = {}, signedIn = {}, bins = {}, busy = {}, errors = {}, failures = {} } = {}) {
  const log = []
  const logs = []
  const emitted = []
  const listeners = new Map()
  const services = {}
  const routes = { now: [] }
  const registered = {}
  const ctx = {
    logger: {
      warn: message => logs.push(['warn', message]),
      info: message => logs.push(['info', message]),
    },
    llm: {
      registerAdapter(providers, adapter) {
        registered.adapter = adapter
        routes.now = [...providers]
        log.push(['register', [...providers]])
        const handle = () => { routes.now = []; log.push(['dispose']) }
        handle.replace = (next) => { routes.now = [...next]; log.push(['replace', [...next]]) }
        return handle
      },
      listProviders: () => routes.now.map(id => ({ id, name: id })),
      // The status never asks for models: a first read of an agent's models may take seconds.
      listModels: () => new Promise(() => {}),
    },
    agents: { get: () => undefined },
    get: () => undefined,
    provide: (name, value) => { services[name] = value },
    on: (name, listener) => listeners.set(name, [...(listeners.get(name) ?? []), listener]),
    effect: (setup) => { const cleanup = setup(); listeners.set('stop', [...(listeners.get('stop') ?? []), cleanup]) },
    emit: (name, ...args) => {
      emitted.push([name, ...args])
      for (const listener of listeners.get(name) ?? []) listener(...args)
    },
  }
  const installs = []
  const store = {
    binOf: pkg => bins[pkg],
    busy: pkg => busy[pkg] === true,
    lastError: pkg => errors[pkg],
    lastFailure: pkg => failures[pkg] ?? (errors[pkg] === undefined ? undefined : { message: errors[pkg] }),
    update: async (pkg) => { installs.push(pkg) },
    dispose: () => { log.push(['store disposed']) },
  }
  const probes = []
  const deps = {
    store,
    find: name => clis[name],
    signedIn: async (spec, cli) => { probes.push([spec.key, cli]); return signedIn[spec.key] },
  }
  return {
    ctx, deps, log, logs, emitted, services, installs, probes, routes, store, bins, busy, errors,
    failures, clis, registered,
  }
}

// A session that never attempts the own mode leaves no record for ordinary strict prompts.
test('own mode: no record for an agent without its own mode', async t => {
  const w = await world(t, { level: WRITE, modes: ['default', 'auto', 'bypassPermissions'], modeFor: AGENTS['acp-claude'].modeFor })
  const c = w.chat('claude'); c.say('plain'); await c.step()
  assert.equal(w.adapter.diagnostics.read(c.id).ownMode, undefined)
})
for (const level of ['read-only', FULL, 'auto']) test(`own mode: no record at ${level}`, async t => {
  const w = await world(t, { level, modes: MODES, modeFor: AGENTS['acp-codex'].modeFor, spec: { ownMode: 'agent' }, ownMode: () => true })
  const c = w.chat('other'); c.say('hi'); await c.step()
  assert.equal(w.adapter.diagnostics.read(c.id).ownMode, undefined)
})
test('own mode: a bridged Workspace prompt records its own mode', async t => {
  const w = await world(t, { level: WRITE, modes: MODES, bridge: true, modeFor: AGENTS['acp-codex'].modeFor, spec: { ownMode: 'agent' }, ownMode: () => true })
  const c = w.chat('kept'); c.say('plain'); await c.step()
  assert.equal(w.adapter.diagnostics.read(c.id).ownMode.taken, true)
})
for (const [name, options] of [['no answerer', {}], ['bridged', { bridge: true, ownMode: () => true }]]) test(`own mode: a busy strict prompt is not in its own mode (${name})`, async t => {
  const w = await world(t, { level: WRITE, modes: MODES, modeFor: AGENTS['acp-codex'].modeFor, spec: { ownMode: 'agent' }, ...options })
  const c = w.chat('strict'); c.say('hi'); await c.step()
  assert.equal(w.adapter.live.get(c.id).run.busy, true)
  assert.equal(w.adapter.ownModeIn(c.id), name === 'bridged')
})
test('own mode: idle does not end a busy strict prompt', async t => {
  const w = await world(t, { level: WRITE, modes: MODES, modeFor: AGENTS['acp-codex'].modeFor, spec: { ownMode: 'agent' } })
  const c = w.chat('strict'); c.say('hi'); await c.step()
  assert.equal(w.adapter.live.get(c.id).run.busy, true)
  w.ctx.emit('agent/status', { agent: c.agent, status: 'idle' })
  assert.equal(w.adapter.live.has(c.id), true)
})
test('own mode: ownModeOf reports a bridged Codex', () => {
  const h = harness({ clis: { codex: '/fake/codex' }, bins: { [AGENTS['acp-codex'].adapter]: '/fake/adapter' } })
  apply(h.ctx, { claude: false, codex: true, dshTools: true }, h.deps)
  assert.equal(h.services[SERVICE].ownModeOf('acp-codex').bridged, true)
})

test('own mode: ownModeOf uses the Session identity for the Codex bridge default', () => {
  const h = harness({ clis: { codex: '/fake/codex' }, bins: { [AGENTS['acp-codex'].adapter]: '/fake/adapter' } })
  apply(h.ctx, { claude: false, codex: true }, h.deps)
  const service = h.services[SERVICE]
  service.botIdentity(id => id === 's1' ? { name: 'Bot', needsDshTools: true } : undefined)
  assert.deepEqual(service.ownModeOf('acp-codex', 's1'), { mode: 'agent', bridged: true, answerer: false })
  assert.deepEqual(service.ownModeOf('acp-codex'), { mode: 'agent', bridged: false, answerer: false })
})

test('own mode service disposers are scoped and competing registrations disable it permanently', () => {
  const h = harness({ clis: { codex: '/fake/codex' }, bins: { [AGENTS['acp-codex'].adapter]: '/fake/adapter' } })
  apply(h.ctx, { claude: false, codex: true }, h.deps)
  const service = h.services[SERVICE]
  service.ownMode(null)()
  assert.deepEqual(service.ownModeOf('acp-codex'), { mode: 'agent', bridged: false, answerer: false })
  const first = service.ownMode(() => true)
  first()
  const second = service.ownMode(() => true)
  first()
  assert.equal(h.registered.adapter.ownMode()(), true)
  assert.equal(service.ownModeOf('acp-codex').answerer, true)
  service.ownMode(() => true)
  assert.equal(h.registered.adapter.ownMode(), undefined)
  second()
  service.ownMode(() => true)
  assert.equal(h.registered.adapter.ownMode(), undefined)
  assert.equal(h.logs.filter(([kind]) => kind === 'warn').length, 1)
})

for (const answer of [undefined, false, 'true', true]) test(`Claude own mode requires exact true: ${answer}`, async t => {
  const w = await world(t, { level: WRITE, modes: ['default', 'auto', 'bypassPermissions'], modeFor: AGENTS['acp-claude'].modeFor, spec: { ownMode: 'auto' }, ownMode: answer === undefined ? undefined : () => answer })
  const c = w.chat('ada'); c.say('x'); await c.step()
  assert.deepEqual(w.events('set-mode').map(row => row.modeId), answer === true ? ['auto'] : [])
})
test('Claude own mode restores strict mode when its answer changes', async t => {
  let calls = 0
  const w = await world(t, { level: WRITE, modes: ['default', 'auto', 'bypassPermissions'], modeFor: AGENTS['acp-claude'].modeFor, spec: { ownMode: 'auto' }, ownMode: () => ++calls === 1 })
  const c = w.chat('ada'); c.say('x'); await c.step()
  assert.deepEqual(w.events('set-mode').map(row => row.modeId), ['auto', 'default'])
})
for (const prompt of ['bridge bash', 'bridge-permit bash']) test(`bridged own asks carry agentAsked: ${prompt}`, async t => {
  const w = await world(t, { level: WRITE, modes: MODES, bridge: true, modeFor: AGENTS['acp-codex'].modeFor, spec: { ownMode: 'agent' }, ownMode: () => true })
  const c = w.chat('ada'); c.say(prompt); await c.step()
  assert.equal(w.asked[0].bridgeCall.agentAsked, prompt.includes('permit'))
  assert.equal(remoteJson(w.asked[0]), true)
  c.say('bridge bash'); await c.step()
  assert.equal(w.asked.at(-1).bridgeCall.agentAsked, false)
})
test('bridge judge refusals identify the judge', async t => {
  const w = await world(t, { level: WRITE, modes: MODES, bridge: true, modeFor: AGENTS['acp-codex'].modeFor, spec: { ownMode: 'agent' }, ownMode: () => true, answer: request => { request.bridgeCall.judged = { reason: 'not needed' }; return 'rejected' } })
  const c = w.chat('ada'); c.say('bridge bash'); await c.step()
  assert.match(JSON.stringify(c.messages), /Auto's judge refused bash: not needed\./)
})
for (const own of [true, false]) test(`reviewer refusal stop notice only in own mode: ${own}`, async t => {
  const w = await world(t, { level: WRITE, modes: MODES, modeFor: AGENTS['acp-codex'].modeFor, spec: { ownMode: 'agent' }, ownMode: () => own })
  const c = w.chat('ada'); c.say('reviewer denies 3'); let chunks = await c.step()
  while (chunks.findLast(chunk => chunk.type === 'finish').reason.kind === 'tool-calls') {
    for (const chunk of chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')) await c.run(chunk.block)
    chunks = await c.step()
  }
  const notices = c.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source?.stop === 'refusals')
  assert.equal(notices.length, own ? 1 : 0)
  assert.equal(chunks.findLast(chunk => chunk.type === 'finish').reason.kind, own ? 'stop' : 'aborted', JSON.stringify(chunks))
})
test('one reviewer refusal followed by text does not claim a refusal stop', async t => {
  const w = await world(t, { level: WRITE, modes: MODES, modeFor: AGENTS['acp-codex'].modeFor, spec: { ownMode: 'agent' }, ownMode: () => true })
  const c = w.chat('ada'); c.say('reviewer denies 1 then text'); let chunks = await c.step()
  while (chunks.findLast(chunk => chunk.type === 'finish').reason.kind === 'tool-calls') {
    for (const chunk of chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')) await c.run(chunk.block)
    chunks = await c.step()
  }
  assert.equal(chunks.findLast(chunk => chunk.type === 'finish').reason.kind, 'aborted', JSON.stringify(chunks))
  assert.equal(c.session.snapshotEvents().some(e => e.data?.source?.stop === 'refusals'), false)
})
for (const always of [false]) test(`mirror asks carry current input and one-shot availability: ${always}`, async t => {
  const w = await world(t, { level: WRITE, modes: MODES, modeFor: AGENTS['acp-codex'].modeFor, env: { FAKE_ACP_ALWAYS_ONLY: always ? '1' : '0' } })
  const c = w.chat('ada'); c.say('ask edited'); const chunks = await c.step()
  const block = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block
  await c.run(block)
  assert.equal(w.asked[0].mirrorCall.input.command, 'echo second')
  assert.equal(w.asked[0].mirrorCall.allowOnce, !always)
  assert.equal(remoteJson(w.asked[0]), true)
  assert.equal(Object.hasOwn(w.asked[0].mirrorCall, 'locations'), false)
  await c.step()
  assert.match(JSON.stringify(c.messages), /It printed/)
})

test('a mirror question with only a lasting allow lets the fake agent report the refusal', async t => {
  const w = await world(t, { level: WRITE, modes: MODES, modeFor: AGENTS['acp-codex'].modeFor, env: { FAKE_ACP_ALWAYS_ONLY: '1' } })
  const c = w.chat('ada'); c.say('ask edited'); const chunks = await c.step()
  const block = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block
  await c.run(block)
  assert.equal(w.asked.length, 0)
  const tool = c.messages.find(message => message.role === 'tool' && message.toolCallId === block.id)
  assert.deepEqual(tool.content, [{ type: 'text', text: 'Fake agent offered to allow Run echo first only from now on ("Allow"), not just once, so Automagik did not approve it.' }])
  const next = await c.step()
  assert.equal(next.findLast(chunk => chunk.type === 'finish').reason.kind, 'stop')
  assert.match(c.messages.at(-1).content.map(part => part.text).join(''), /I was not allowed to run it/)
  assert.doesNotMatch(JSON.stringify(c.messages), /It printed/)
})

for (const [answer, text] of [['rejected', 'The person rejected bash.'], ['unavailable', 'DSH could not approve bash: nobody could answer its approval request.']]) test(`plain bridge ${answer} keeps its existing text`, async t => {
  const w = await world(t, { level: WRITE, modes: MODES, bridge: true, modeFor: AGENTS['acp-codex'].modeFor, spec: { ownMode: 'agent' }, ownMode: () => true, answer })
  const c = w.chat('ada'); c.say('bridge bash'); await c.step()
  assert.ok(JSON.stringify(c.messages).includes(text))
  assert.doesNotMatch(JSON.stringify(c.messages), /Auto's judge refused/)
  assert.equal(w.executed.length, 0)
})

test('a judged mirror refusal names the judge and answers the agent with its own reject', async t => {
  const w = await world(t, { level: WRITE, modes: MODES, modeFor: AGENTS['acp-codex'].modeFor, answer: request => { request.mirrorCall.judged = { reason: 'not needed' }; return 'rejected' } })
  const c = w.chat('ada'); c.say('hi'); const chunks = await c.step()
  await c.run(chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block)
  await c.step()
  assert.match(JSON.stringify(c.messages), /Auto's judge refused Run echo hello 1: not needed\./)
  assert.match(JSON.stringify(c.messages), /I was not allowed to run it/)
  assert.equal(remoteJson(w.asked[0]), true)
})

// The mirror's body over a stand-in run: one asking call; the approval service answers through `answer`.
async function mirrorAsk({ title = 'Run echo x', locations = [], answer = async () => 'rejected' } = {}) {
  let seen
  const approval = { effectivePolicy: () => 'ask', request: async request => { seen = request; return answer(request) } }
  const tool = {
    id: 'x', title, kind: 'execute', status: 'pending', content: [], locations, rawInput: { command: 'echo x' }, listeners: new Set(),
    permission: { options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }], answer(value) { tool.answered = value; tool.permission = undefined } },
  }
  const live = { name: 'x', run: { tools: new Map([['x', tool]]), busy: false, cancel: async () => {} } }
  const host = { runOf: () => live, approval: () => approval, sandboxPolicy: () => ({ resolve: () => ({ mode: WRITE }) }), permissionPresets: () => ({ current: () => WRITE }) }
  const exec = { callId: 'x', agent: { session: { id: 'x', snapshotEvents: () => [] } }, signal: new AbortController().signal }
  const result = await mirrorTool(host).execute({ id: 'x', title, kind: 'execute' }, exec)
  return { seen, result, tool }
}
for (const locations of [[], [{ path: 'x' }]]) test(`mirror approval requests are lossless JSON: ${locations.length} locations`, async () => {
  const { seen } = await mirrorAsk({ locations })
  assert.equal(remoteJson(seen), true)
  if (locations.length) assert.deepEqual(seen.mirrorCall.locations, [{ path: 'x' }])
  else assert.equal(Object.hasOwn(seen.mirrorCall, 'locations'), false)
})
test('a mirror question with an unreadable location still asks the person', async () => {
  let asks = 0
  const { seen, tool } = await mirrorAsk({ locations: [null], answer: async () => { asks++; return 'allowed-once' } })
  assert.equal(asks, 1)
  assert.equal(Object.hasOwn(seen, 'mirrorCall'), false)
  assert.equal(remoteJson(seen), true)
  assert.deepEqual(tool.answered, { outcome: { outcome: 'selected', optionId: 'yes' } })
})
for (const [name, title, judged] of [['judged', 'Run echo x', true], ['plain', 'Run echo x', false], ['judged image', 'generate_image x', true]]) test(`a mirror refusal names Auto's judge only when it refused: ${name}`, async () => {
  const { result, tool } = await mirrorAsk({ title, answer: async request => { if (judged) request.mirrorCall.judged = { reason: 'not needed' }; return 'rejected' } })
  assert.deepEqual(tool.answered, { outcome: { outcome: 'selected', optionId: 'no' } })
  if (judged) assert.equal(result.text, `Auto's judge refused ${title}: not needed.`)
  else assert.doesNotMatch(result.text, /Auto's judge/)
})

test('a judged refusal that is answered cancelled does not name the judge', async () => {
  const { result, tool } = await mirrorAsk({ answer: async request => { request.mirrorCall.judged = { reason: 'not needed' }; return 'cancelled' } })
  assert.deepEqual(tool.answered, { outcome: { outcome: 'cancelled' } })
  assert.doesNotMatch(result.text, /Auto's judge/)
})


test('D14 unbridged Claude receives session-only hard ask rules at Workspace', async t => {
  const w = await world(t, { level: WRITE, modes: ['default', 'auto', 'bypassPermissions'], modeFor: AGENTS['acp-claude'].modeFor, spec: { hardAsk: AGENTS['acp-claude'].hardAsk } })
  const c = w.chat('ada'); c.say('x'); await c.step()
  assert.deepEqual(w.events('new-session')[0].meta.claudeCode.options.settings.permissions.ask, CLAUDE_HARD_ASK)
})
test('D15 crossing Full access restarts Claude with the current ask rules', async t => {
  const w = await world(t, { level: FULL, modes: ['default', 'auto', 'bypassPermissions'], modeFor: AGENTS['acp-claude'].modeFor, spec: { hardAsk: AGENTS['acp-claude'].hardAsk }, env: { FAKE_ACP_SKIP_MCP: '1' } })
  const c = w.chat('ada')
  // End each fake prompt through its mirror before starting the next turn.
  const turn = async () => {
    c.say('x')
    let chunks = await c.step()
    while (chunks.findLast(chunk => chunk.type === 'finish').reason.kind === 'tool-calls') {
      for (const chunk of chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')) await c.run(chunk.block)
      chunks = await c.step()
    }
  }
  await turn()
  assert.equal(w.events('new-session')[0].meta, undefined)
  w.setLevel(WRITE); await turn()
  assert.deepEqual(w.events('new-session')[1].meta.claudeCode.options.settings.permissions.ask, CLAUDE_HARD_ASK)
  await turn()
  assert.equal(w.events('new-session').length, 2)
  w.setLevel(FULL); await turn()
  assert.equal(w.events('new-session').length, 3)
  assert.equal(w.events('new-session')[2].meta, undefined)
})
test('D16 Claude wildcard rules catch recursive delete without matching ordinary rm', () => {
  const matches = command => CLAUDE_HARD_ASK.filter(rule => rule.startsWith('Bash(')).some(rule => {
    const pattern = rule.slice(5, -1).split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
    return new RegExp(`^${pattern}$`).test(command)
  })
  assert.equal(matches('rm -rf build'), true)
  assert.equal(matches('rm x'), false)
  assert.equal(CLAUDE_HARD_ASK.some(rule => rule.endsWith(':*)')), false)
})

test('#1092 Claude asks about secret commands and shared pushes without matching ordinary work', () => {
  const matches = command => CLAUDE_HARD_ASK.filter(rule => rule.startsWith('Bash(')).some(rule => {
    const pattern = rule.slice(5, -1).split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
    return new RegExp(`^${pattern}$`).test(command)
  })
  for (const command of ['gh auth token', 'git push origin main', 'git push']) assert.equal(matches(command), true, command)
  for (const command of ['git push origin feat/x', 'cat README.md']) assert.equal(matches(command), false, command)
})

test('#1092 narrowed Claude ask rules preserve ordinary environment and branch commands', () => {
  const matches = command => CLAUDE_HARD_ASK.filter(rule => rule.startsWith('Bash(')).some(rule => {
    const pattern = rule.slice(5, -1).split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
    return new RegExp(`^${pattern}$`).test(command)
  })
  for (const command of ['printenv PATH', 'git push origin maintenance', 'git push origin masterplan', 'git push origin development']) assert.equal(matches(command), false, command)
  for (const command of ['printenv', 'printenv GITHUB_TOKEN', 'printenv APP_SECRET', 'printenv PASSWORD', 'printenv API_KEY', 'git push origin main', 'git push origin master', 'git push origin develop']) assert.equal(matches(command), true, command)
  assert.equal(CLAUDE_HARD_ASK.includes('Read(~/.ssh/**)'), false)
  for (const rule of ['Read(~/.ssh/id_*)', 'Read(~/.ssh/*.pem)', 'Read(~/.ssh/*.key)']) assert.equal(CLAUDE_HARD_ASK.includes(rule), true, rule)
})

test('RFC 0034 Claude asks about password-manager reads', () => {
  const reads = [
    'bw get password x', 'bw list items', 'bw export', 'bw unlock', 'bw serve',
    'bws secret get id', 'bws secret list', 'bws run -- env',
    'op read op://vault/item/field', 'op run -- env', 'op inject -i a.tpl', 'op item get x',
    'pass-cli item view pass://v/i/f', 'pass-cli item get pass://v/i/f', 'pass-cli item run -- env', 'pass-cli run -- env',
    'keepassxc-cli show db e', 'keepassxc-cli export db', 'secret-tool lookup a b',
    'vault kv get x', 'vault read x',
  ]
  for (const shell of process.platform === 'win32' ? ['Bash', 'PowerShell'] : ['Bash']) {
    const matches = command => CLAUDE_HARD_ASK.filter(rule => rule.startsWith(shell + '(')).some(rule => {
      const pattern = rule.slice(shell.length + 1, -1).split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
      return new RegExp(`^${pattern}$`).test(command)
    })
    for (const command of reads) assert.equal(matches(command), true, command)
    for (const command of ['bw status', 'op whoami', 'secret-tool store x']) assert.equal(matches(command), false, command)
  }
})

const archiveBarrier = () => {
  const { promise: entered, resolve: enter } = Promise.withResolvers()
  const { promise: released, resolve: release } = Promise.withResolvers()
  return { entered, enter, released, release }
}

const archiveReply = async (chat, text) => {
  chat.say(text)
  const rows = await chat.step()
  assert.equal(rows.at(-1).reason.kind, 'stop', JSON.stringify(rows))
  assert.ok(rows.some(row => row.type === 'block-end' && row.block.type === 'text' && row.block.text.includes(text)), JSON.stringify(rows))
}

const archiveChild = (w, chat) => {
  const live = w.adapter.live.get(chat.id)
  assert.equal(live?.own, false)
  assert.equal(live.run.busy, false)
  const child = live.run.child
  assert.ok(child.pid > 1)
  assert.equal(child.exitCode, null)
  assert.equal(child.signalCode, null)
  w.runs.add(live.run)
  return child
}

const archiveExited = child => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise(resolve => {
    const exited = () => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      child.off('exit', exited)
      resolve(false)
    }, KILL_AFTER_MS + 3000)
    child.once('exit', exited)
  })
}
const quietArchive = rows => assert.deepEqual(rows, [{ type: 'finish', reason: { kind: 'stop' } }])

test('acp archive 1 ends an idle ordinary run', async t => {
  const w = await world(t)
  const a = w.chat('archive-a')
  await archiveReply(a, 'plain first answer')
  const child = archiveChild(w, a)
  await w.archive(a.id)
  assert.ok(await archiveExited(child), `Archived child PID ${child.pid} survived the exit deadline`)
  assert.equal(w.adapter.live.has(a.id), false)
})

test('acp archive 2 leaves the other run on its original child', async t => {
  const w = await world(t)
  const a = w.chat('archive-a')
  const b = w.chat('archive-b')
  await archiveReply(a, 'plain target')
  const target = archiveChild(w, a)
  await archiveReply(b, 'plain control')
  const control = archiveChild(w, b)
  await w.archive(a.id)
  assert.ok(await archiveExited(target), `Archived child PID ${target.pid} survived the exit deadline`)
  await archiveReply(b, 'plain control again')
  assert.equal(archiveChild(w, b), control)
  assert.equal(w.events('prompt').at(-1).pid, control.pid)
})

test('acp archive 3 ignores an unknown id and ends the known run', async t => {
  const w = await world(t)
  const a = w.chat('archive-a')
  await archiveReply(a, 'plain first answer')
  const child = archiveChild(w, a)
  // The real registry only emits for known ids. Deliver an unexpected event directly.
  await w.ctx.parallel('workspace/session-archived', { sessionId: 'absent' })
  await archiveReply(a, 'plain after unknown id')
  assert.equal(archiveChild(w, a), child)
  await w.archive(a.id)
  assert.ok(await archiveExited(child), `Archived child PID ${child.pid} survived the exit deadline`)
})

test('acp archive 4 suppresses a late start and connector recovery', async t => {
  for (const [name, emit, reject] of [
    ['archive during preparation', true, false],
    ['preparation rejects after archive', true, true],
    ['durable archive before the event', false, false],
  ]) await t.test(name, async t => {
    const barrier = archiveBarrier()
    let rollbacks = 0
    let repairs = 0
    const w = await world(t, { spec: {
      rollback: () => { rollbacks++; return false },
      repair: () => { repairs++; return true },
    } })
    const spec = w.adapter.agents.get(PROVIDER)
    const spawn = spec.spawn
    const prepare = t.mock.method(spec, 'spawn', async context => {
      barrier.enter()
      await barrier.released
      if (reject) throw new Error('launch preparation failed')
      return spawn(context)
    })
    const a = w.chat('archive-a')
    a.say('plain held start')
    const pending = a.step()
    await within(barrier.entered, 'launch preparation')
    if (emit) {
      await w.archive(a.id)
      w.undo(a.id)
    } else {
      w.markArchived(a.id)
    }
    barrier.release()
    const rows = await pending
    assert.equal(rollbacks, 0)
    assert.equal(repairs, 0)
    assert.equal(prepare.mock.callCount(), 1)
    assert.deepEqual(w.events('start'), [])
    assert.deepEqual(w.events('prompt'), [])
    assert.equal(w.adapter.live.has(a.id), false)
    quietArchive(rows)
  })

  await t.test('durable archive at admission survives Undo', async t => {
    const barrier = archiveBarrier()
    let hold = true
    const w = await world(t, { holdWaitMs: 15_000, gates: [() => {
      if (!hold) return
      hold = false
      barrier.enter()
      return barrier.released
    }] })
    const prepare = t.mock.method(w.adapter.agents.get(PROVIDER), 'spawn')
    const a = w.chat('archive-a')
    w.markArchived(a.id)
    const pending = a.step({ input: [said('plain archived admission')] })
    await within(barrier.entered, 'archived admission')
    w.undo(a.id)
    barrier.release()
    const rows = await pending
    assert.equal(prepare.mock.callCount(), 0)
    assert.deepEqual(w.events('start'), [])
    assert.deepEqual(w.events('prompt'), [])
    quietArchive(rows)
    await archiveReply(a, 'plain fresh admission')
    assert.equal(prepare.mock.callCount(), 1)
    assert.equal(w.events('new-session').at(-1).pid, archiveChild(w, a).pid)
  })
})

test('acp archive 5 keeps an undone replacement through old cleanup', async t => {
  const oldFork = archiveBarrier()
  const oldAdmission = archiveBarrier()
  let holdAdmission = false
  const oldStop = new AbortController()
  const w = await world(t, { bridge: true, level: WRITE, holdWaitMs: 15_000,
    spec: { sessionFiles: true, refresh: 'fork' },
    gates: [() => {
      if (!holdAdmission) return
      holdAdmission = false
      oldAdmission.enter()
      return oldAdmission.released
    }],
  })
  const spec = w.adapter.agents.get(PROVIDER)
  const spawn = spec.spawn
  const prepare = t.mock.method(spec, 'spawn', context => ({ ...spawn(context), sessionFileEnabled: true }))
  const a = w.chat('archive-a')
  await archiveReply(a, 'plain original')
  const original = archiveChild(w, a)
  const live = w.adapter.live.get(a.id)
  const originalOwner = live.fileOwner
  assert.ok(originalOwner)
  let refreshOld = true
  t.mock.method(w.backchannel, 'refresh', () => {
    const changed = refreshOld
    refreshOld = false
    return changed
  })
  // Hold only the refork's completion, even if the archive closes its process first.
  const held = live.run.held.bind(live.run)
  t.mock.method(live.run, 'held', (work, options) => options?.ms === 0 ? work() : held(work, options))
  t.mock.method(live.run, 'fork', async () => {
    oldFork.enter()
    await oldFork.released
    throw new Error('old fork failed')
  })
  const assertQuietStep = async (settled, name) => {
    const [result] = await settled
    assert.equal(result.status, 'fulfilled', `${name} did not complete: ${result.reason?.message}`)
    quietArchive(result.value)
  }
  // Observe both bounded steps from launch so an early assertion can still drain them.
  const forking = Promise.allSettled([a.step({ signal: oldStop.signal, input: [said('plain old fork')] })])
  let admitted
  try {
    await within(oldFork.entered, 'old refork')
    await w.archive(a.id)
    holdAdmission = true
    admitted = Promise.allSettled([a.step({ input: [said('plain admitted while archived')] })])
    await within(oldAdmission.entered, 'old archived admission')
    w.undo(a.id)
    await archiveReply(a, 'plain fresh after Undo')
    const replacement = w.adapter.live.get(a.id)
    const child = archiveChild(w, a)
    assert.ok(child !== original, 'Undo reused the original child')
    assert.ok(replacement.fileOwner !== originalOwner, 'Undo reused the original file owner')
    assert.ok(replacement.fileOwner, 'Undo did not create a replacement file owner')
    assert.equal(w.events('new-session').at(-1).pid, child.pid)
    assert.ok(await archiveExited(original), `Archived child PID ${original.pid} survived the exit deadline`)

    // Keep Cordis objects out of the assertion diagnostics.
    const assertReplacement = after => {
      const current = w.adapter.live.get(a.id)
      assert.ok(w.adapter.sessionFiles.owners.get(a.id) === replacement.fileOwner, `${after} lost the replacement file owner`)
      assert.equal(current?.run?.child?.pid, child.pid, `${after} lost the replacement child`)
      assert.ok(current === replacement, `${after} changed the replacement live entry`)
    }
    oldStop.abort()
    assertReplacement('Old Stop')
    oldFork.release()
    oldAdmission.release()
    await assertQuietStep(forking, 'Old refork')
    await assertQuietStep(admitted, 'Old archived admission')
    assert.equal(prepare.mock.callCount(), 2)
    assertReplacement('Old refork cleanup')
    assert.equal(w.events('prompt').length, 2)

    await new Promise(resolve => setTimeout(resolve, KILL_AFTER_MS))
    await archiveReply(a, 'plain after old cleanup')
    assert.ok(w.adapter.live.get(a.id) === replacement, 'The next reply changed the replacement live entry')
    assert.ok(archiveChild(w, a) === child, 'The next reply changed the replacement child')
    assert.equal(w.events('prompt').at(-1).pid, child.pid)
  } finally {
    oldFork.release()
    oldAdmission.release()
    await Promise.all([forking, admitted])
  }
})

test('acp archive 6 revokes a staged image grant without a run', async t => {
  const w = await world(t, { level: WRITE, modes: [WRITE], spec: { sessionFiles: true } })
  const a = w.chat('archive-a')
  const image = join(a.session.header.cwd, 'staged.png')
  writeFileSync(image, 'test image')
  const owner = w.adapter.sessionFiles.owner(a.agent, PROVIDER)
  owner.grant = { staged: true, ready: Promise.resolve(), files: [fileIdentity(image)] }
  owner.pending = {}
  assert.equal(w.adapter.live.has(a.id), false)
  await w.archive(a.id)
  assert.equal(w.adapter.sessionFiles.owners.has(a.id), false)
  assert.equal(owner.lifetime.signal.aborted, true)
  assert.equal(owner.grant, undefined)
  assert.equal(owner.pending, undefined)

  const spec = w.adapter.agents.get(PROVIDER)
  const spawn = spec.spawn
  const prepare = t.mock.method(spec, 'spawn', context => ({ ...spawn(context), sessionFileEnabled: true, sessionFileMode: WRITE }))
  w.undo(a.id)
  await archiveReply(a, 'plain after grant was revoked')
  assert.deepEqual(prepare.mock.calls[0].arguments[0].sessionFiles.files, [])
  assert.notEqual(w.adapter.live.get(a.id).fileOwner, owner)
  assert.ok(w.adapter.live.get(a.id).fileOwner)
})

test('acp archive 7 ignores a late tool update from the archived run', async t => {
  const bridge = archiveBarrier()
  const w = await world(t, {
    bridge: true,
    spec: { drift: true },
    bash: () => {
      bridge.enter()
      return bridge.released
    },
  })
  const a = w.chat('archive-a')
  await archiveReply(a, 'plain original')
  const original = archiveChild(w, a)
  const oldRun = w.adapter.live.get(a.id).run
  const oldSessionId = oldRun.sessionId

  await w.archive(a.id)
  w.undo(a.id)
  await archiveReply(a, 'plain fresh after Undo')
  const child = archiveChild(w, a)
  const replacement = w.adapter.live.get(a.id).run
  assert.ok(child !== original, 'Undo reused the original child')

  const answering = a.step({ input: [said('bridge bash')] })
  const settled = Promise.allSettled([answering])
  try {
    await within(bridge.entered, 'the replacement bridge call')
    assert.equal(replacement.busy, true)
    // Deliver the buffered update at the same entry point as the old child's stdout.
    await oldRun.onUpdate({
      sessionUpdate: 'tool_call_update', toolCallId: 'late-archived-call',
      name: 'Bash', title: 'Run echo archived', kind: 'execute', status: 'in_progress',
    }, oldSessionId)
    assert.equal(replacement.cancelled, false, 'Late tool update cancelled the replacement')
  } finally {
    bridge.release()
    await settled
  }

  const rows = await answering
  assert.equal(rows.at(-1)?.reason?.kind, 'stop', JSON.stringify(rows))
  assert.ok(rows.some(row =>
    row.type === 'block-end' && row.block.type === 'text' && row.block.text.includes('The bridge said: ran bash'),
  ), JSON.stringify(rows))
  assert.ok(archiveChild(w, a) === child, 'The replacement reply changed its child')
  assert.equal(w.events('prompt').at(-1).pid, child.pid)
})
