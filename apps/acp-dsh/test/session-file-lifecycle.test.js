import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session } from '@deepseek-ai/dsh-session'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import * as native from '@deepseek-ai/dsh-tool-executor-native'
import { AcpAdapter } from '../src/host/adapter.js'
import { AGENTS } from '../src/host/agents.js'
import { chatProfileModesFor } from '../src/host/codex-chat-profiles.js'
import { sessionFileConfig, FILE_ALLOW } from '../src/host/session-files.js'
import { callArguments, TOOL_NAME } from '../src/host/tool.js'
const PROVIDER = 'acp-codex'
const said = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const collect = async stream => { const rows = []; for await (const row of stream) rows.push(row); return rows }
const fixture = join(import.meta.dirname, 'support/session-file-agent.mjs')
async function world(t, { env = {}, own = false, level = 'read-only' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'session-file-lifecycle-'))
  for (const dir of ['ws', 'outside', 'codex', 'bin']) mkdirSync(join(root, dir))
  const file = join(root, 'outside', 'approved.png'), trace = join(root, 'trace')
  writeFileSync(file, 'image'); writeFileSync(join(root, 'bin/codex'), '')
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() {}, section() {} })
  await ctx.plugin(ToolsService); await ctx.plugin(native)
  const current = { level, own }
  ctx.provide('approval', { effectivePolicy: () => current.level === 'danger-full-access' ? 'never' : 'ask', request: () => { throw new Error('generic approval must not grant') } })
  ctx.provide('permissionPresets', { current: () => current.level })
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: current.level === 'auto' ? 'danger-full-access' : current.level }) })
  ctx.provide('sessions', { list: () => [] }); ctx.provide('workingDirectory', { ensure: async () => join(root, 'ws') })
  const agents = new Map()
  ctx.provide('agents', { get: id => agents.get(id), list: () => [...agents.values()], turnBoundaryOf: () => ({ lastTurn: 1 }) })
  const requests = []
  ctx.provide('userQuestions', { ask: async request => { requests.push(request); return { answers: [{ id: request.questions[0].id, selected: [FILE_ALLOW] }] } } })
  const launches = []
  const spec = { name: 'Codex', sessionFiles: true, ownMode: 'agent', modeFor: AGENTS[PROVIDER].modeFor,
    catalog: { ownEffort: () => undefined, dispose() {} }, spawn: context => {
      launches.push(context)
      const base = { CODEX_HOME: join(root, 'codex'), CODEX_PATH: join(root, 'bin/codex'), FILE_TRACE: trace, FILE_PATH: file, ...env }
      const setup = context?.sessionFiles ? sessionFileConfig(base, context.sessionFiles, chatProfileModesFor('0123456789abcdef0123456789abcdef')) : { env: base }
      return { command: process.execPath, args: [fixture], ...setup, env: { ...setup.env, ...(setup.sessionFileMode ? { FILE_MODE: setup.sessionFileMode } : {}) } }
    } }
  const adapter = new AcpAdapter(ctx, new Map([[PROVIDER, spec]]), { dshTools: () => false, ownMode: () => () => current.own, fileDrainMs: 300 })
  let scopes
  await ctx.plugin({ name: 'file-test-agents', inject: ['tools'], apply(child) { scopes = child } })
  const session = Session.create('chat', undefined, { version: 4, id: 'chat', createdAt: 0, isSeeded: false, cwd: join(root, 'ws') })
  const agent = { id: 'chat', session, status: 'idle' }, scope = createScope(scopes, agent)
  agent.ctx = scope.ctx; agents.set('chat', agent); adapter.registerMirror(agent)
  session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
  const { name, description, parameters } = adapter.tool
  session.append('request/header', { header: { config: { provider: PROVIDER, model: 'default' }, tools: [{ name, description, parameters }] } })
  t.after(async () => { adapter.dispose(); scope.dispose(); await ctx.root.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
  const events = () => existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
  const step = (messages, signal) => collect(adapter.stream(markAgentLoopRequest({ sessionId: 'chat', provider: PROVIDER, model: 'default', messages, signal })))
  const consent = async () => {
    await step([said('Open the image, then an unrelated action.')])
    const live = adapter.live.get('chat'), tool = live.run.tools.get('native-image'), callId = [...live.calls][0]
    const exec = { agent, callId, name: TOOL_NAME }
    const result = await adapter.tool.execute(callArguments(tool), exec)
    adapter.refusedFirst(exec) // the existing tools/result observer releases the mirror row
    return { live, result, callId, owner: live.fileOwner }
  }
  return { adapter, agent, session, current, spec, requests, launches, events, step, consent, env, root }
}

test('real ACP lifecycle: session consent cancels old process; unchanged tool-result guard never spawns; only next user selects exact acknowledged mode', { timeout: 10000 }, async t => {
  const w = await world(t)
  const { result, callId, owner, live } = await w.consent()
  assert.match(result.text, /has not been opened/)
  assert.equal(w.launches.length, 1); assert.equal(w.adapter.live.size, 0)
  await owner.grant.ready
  assert.equal(live.run.disposed, true)
  const guard = await w.step([said('old task'), { role: 'tool', toolCallId: callId, content: [{ type: 'text', text: result.text }] }])
  assert.ok(JSON.stringify(guard).includes('was interrupted')); assert.equal(w.launches.length, 1)
  const rows = await w.step([said('Open only the approved image now.')])
  assert.ok(JSON.stringify(rows).includes('New user turn on exact profile'))
  assert.equal(w.launches.length, 2)
  const exact = w.adapter.live.get('chat').sessionFileMode
  assert.ok(exact === chatProfileModesFor('0123456789abcdef0123456789abcdef')['read-only'])
  assert.ok(w.events().some(row => row.event === 'mode' && row.mode === exact), 'forced acknowledgement even though it started in that mode')
  const lastPrompt = w.events().filter(row => row.event === 'prompt').at(-1)
  assert.equal(lastPrompt.mode, exact)
  assert.equal(JSON.stringify(lastPrompt.prompt).includes('unrelated action'), false)
})

for (const failure of ['FILE_NO_MODE', 'FILE_REFUSE']) test(`granted profile ${failure}: no legacy fallback and no next prompt`, { timeout: 10000 }, async t => {
  const w = await world(t, { env: { [failure]: '1' } })
  const { owner } = await w.consent(); await owner.grant.ready
  const rows = await w.step([said('Open it now.')])
  assert.ok(JSON.stringify(rows).includes('would not take'))
  assert.equal(w.events().filter(row => row.event === 'prompt').length, 1)
  assert.equal(w.adapter.sessionFiles.owners.size, 0); assert.equal(w.adapter.live.size, 0)
})

for (const type of ['permission/preset', 'sandbox/mode', 'approval/policy', 'model/selection']) test(`bridge off: ${type} away/back destroys staged authority`, { timeout: 10000 }, async t => {
  const w = await world(t); const { owner } = await w.consent(); await owner.grant.ready
  w.adapter.noteEvent(w.session, { type, data: { provider: 'elsewhere' } })
  w.adapter.noteEvent(w.session, { type, data: { provider: PROVIDER } })
  assert.equal(owner.lifetime.signal.aborted, true); assert.equal(w.adapter.sessionFiles.owners.size, 0)
})

for (const how of ['external', 'provider', 'dispose', 'agent']) test(`bridge off: ${how} teardown destroys staged authority`, { timeout: 10000 }, async t => {
  const w = await world(t); const { owner } = await w.consent(); await owner.grant.ready
  if (how === 'external') w.adapter.endSession('chat')
  if (how === 'provider') w.adapter.endProvider(PROVIDER)
  if (how === 'dispose') w.adapter.dispose()
  if (how === 'agent') await w.agent.ctx.parallel('agent/disposed', { agent: w.agent })
  assert.equal(owner.lifetime.signal.aborted, true); assert.equal(w.adapter.sessionFiles.owners.size, 0)
})

for (const [level, own] of [['danger-full-access', false], ['auto', false], ['workspace-write', true]]) test(`${level}, own=${own}: launch configuration receives no image feature`, { timeout: 10000 }, async t => {
  const w = await world(t, { level, own })
  await w.step([said('Ask permission')])
  assert.equal(w.launches[0], undefined)
  assert.equal(w.events().find(row => row.event === 'start').env, undefined)
  assert.equal(w.requests.length, 0)
})

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
for (const how of ['level', 'route', 'external', 'provider', 'dispose', 'agent', 'owner', 'stop']) test(`active overlay: ${how} revokes its actual process`, { timeout: 10000 }, async t => {
  const w = await world(t), { owner } = await w.consent(); await owner.grant.ready
  await w.step([said('Open it now.')])
  const live = w.adapter.live.get('chat')
  assert.ok(live.sessionFileMode)
  if (how === 'level') w.adapter.noteEvent(w.session, { type: 'permission/preset' })
  if (how === 'route') w.adapter.noteEvent(w.session, { type: 'model/selection' })
  if (how === 'external') w.adapter.endSession('chat')
  if (how === 'provider') w.adapter.endProvider(PROVIDER)
  if (how === 'dispose') w.adapter.dispose()
  if (how === 'agent') await w.agent.ctx.parallel('agent/disposed', { agent: w.agent })
  if (how === 'owner') w.adapter.sessionFiles.clear('chat')
  if (how === 'stop') {
    const controller = new AbortController(); controller.abort()
    await w.step([said('Stopped before starting.')], controller.signal)
  }
  assert.equal(owner.lifetime.signal.aborted, true)
  assert.equal(live.run.disposed, true)
  assert.equal(w.adapter.live.size, 0)
  assert.equal(w.events().filter(row => row.event === 'prompt').length, 2)
})

for (const how of ['level', 'provider', 'stop', 'dispose']) test(`${how} while spawn awaits: no replacement process or prompt`, { timeout: 10000 }, async t => {
  const w = await world(t), { owner } = await w.consent(); await owner.grant.ready
  const waiting = deferred(), release = deferred(), spawn = w.spec.spawn
  w.spec.spawn = async context => { waiting.resolve(); await release.promise; return spawn(context) }
  const controller = new AbortController()
  const next = w.step([said('Open it now.')], controller.signal)
  await waiting.promise
  if (how === 'level') w.adapter.noteEvent(w.session, { type: 'sandbox/mode' })
  if (how === 'provider') w.adapter.endProvider(PROVIDER)
  if (how === 'stop') controller.abort()
  if (how === 'dispose') w.adapter.dispose()
  release.resolve(); await next
  assert.equal(owner.lifetime.signal.aborted, true)
  assert.equal(w.adapter.live.size, 0)
  assert.equal(w.events().filter(row => row.event === 'start').length, 1)
  assert.equal(w.events().filter(row => row.event === 'prompt').length, 1)
})

test('concurrent next-user startup has one claimant and one replacement prompt', { timeout: 10000 }, async t => {
  const w = await world(t), { owner } = await w.consent(); await owner.grant.ready
  const waiting = deferred(), release = deferred(), spawn = w.spec.spawn
  w.spec.spawn = async context => { waiting.resolve(); await release.promise; return spawn(context) }
  const first = w.step([said('Open it now.')]); await waiting.promise
  const duplicate = await w.step([said('Open it again.')])
  assert.match(JSON.stringify(duplicate), /already starting/)
  release.resolve(); await first
  assert.equal(w.launches.length, 2)
  assert.equal(w.events().filter(row => row.event === 'prompt').length, 2)
})

for (const how of ['spawn-throws', 'missing-command', 'no-overlay', 'no-feature', 'access', 'model', 'mode', 'hold']) test(`${how}: failed or revoked startup clears grant and sends no granted prompt`, { timeout: 10000 }, async t => {
  const w = await world(t), { owner } = await w.consent(); await owner.grant.ready
  const spawn = w.spec.spawn
  if (how === 'spawn-throws') w.spec.spawn = () => { throw new Error('spawn failed') }
  if (how === 'missing-command') w.spec.spawn = context => ({ ...spawn(context), command: join(w.root, 'missing-executable') })
  if (how === 'no-overlay') w.spec.spawn = context => ({ ...spawn(context), sessionFileMode: undefined })
  if (how === 'no-feature') w.spec.spawn = context => ({ ...spawn(context), sessionFileEnabled: false })
  if (how === 'access') w.adapter.access = async () => 'Account unavailable'
  if (how === 'model') w.spec.proven = () => { w.adapter.live.get('chat').run.option = () => { throw new Error('model unavailable') } }
  if (how === 'mode') w.spec.proven = () => {
    const run = w.adapter.live.get('chat').run, setMode = run.setMode.bind(run)
    run.setMode = async (...args) => { await setMode(...args); w.adapter.noteEvent(w.session, { type: 'permission/preset' }) }
  }
  if (how === 'hold') w.adapter.heldBack = async () => {
    if (w.adapter.live.get('chat')?.sessionFileMode) w.adapter.endSession('chat', 'Held during startup')
  }
  await w.step([said('Open it now.')])
  assert.equal(owner.lifetime.signal.aborted, true, how)
  assert.equal(w.adapter.sessionFiles.owners.size, 0)
  assert.equal(w.adapter.live.size, 0)
  assert.equal(w.events().filter(row => row.event === 'prompt').length, 1)
})

test('unsupported ordinary spawn retains legacy mode and no file owner', { timeout: 10000 }, async t => {
  const w = await world(t, { env: { FILE_QUIET: '1' } })
  const spawn = w.spec.spawn
  w.spec.spawn = () => spawn(undefined)
  await w.step([said('Ordinary legacy turn.')])
  const live = w.adapter.live.get('chat')
  assert.equal(live.run.modes.currentModeId, 'read-only')
  assert.equal(live.fileOwner, undefined)
  assert.equal(w.adapter.sessionFiles.owners.size, 0)
  assert.equal(w.events().find(row => row.event === 'start').env, undefined)
  assert.equal(w.requests.length, 0)
})

test('stop during synchronous retirement cannot miss the cancellation listener', { timeout: 10000 }, async t => {
  const w = await world(t)
  await w.step([said('Open the outside image.')])
  const live = w.adapter.live.get('chat'), tool = live.run.tools.get('native-image'), callId = [...live.calls][0]
  const controller = new AbortController(), retire = w.adapter.sessionFiles.host.retire
  w.adapter.sessionFiles.host.retire = (...args) => { retire(...args); controller.abort() }
  await w.adapter.tool.execute(callArguments(tool), { agent: w.agent, callId, signal: controller.signal })
  assert.equal(w.adapter.sessionFiles.owners.size, 0)
  assert.equal(live.run.disposed, true)
  assert.equal(w.launches.length, 1)
})

test('failed result-row drain refuses the next user turn without a new process', { timeout: 10000 }, async t => {
  const w = await world(t)
  w.adapter.sessionFiles.host.drainMs = 40
  const retire = w.adapter.sessionFiles.host.retire
  w.adapter.sessionFiles.host.retire = (id, live) => { live.pendingMirrors.add('unfinished-other-row'); retire(id, live) }
  const { owner } = await w.consent()
  await w.step([said('Open it now.')])
  assert.equal(owner.grant, undefined)
  assert.equal(w.adapter.sessionFiles.owners.size, 0)
  assert.equal(w.launches.length, 1)
})

test('level crossing during own-mode preflight refuses stale strict startup', { timeout: 10000 }, async t => {
  const w = await world(t, { level: 'workspace-write' })
  const waiting = deferred(), answer = deferred()
  w.adapter.ownMode = () => () => { waiting.resolve(); return answer.promise }
  const step = w.step([said('Initial strict request.')]); await waiting.promise
  w.current.level = 'auto'; answer.resolve(false); await step
  assert.equal(w.launches.length, 0)
  assert.equal(w.adapter.sessionFiles.owners.size, 0)
})

test('a native tool-refresh fork cannot inherit the process overlay', { timeout: 10000 }, async t => {
  const w = await world(t), { owner } = await w.consent(); await owner.grant.ready
  await w.step([said('Open it now.')])
  const live = w.adapter.live.get('chat')
  live.bridge = { calls: 0 }
  let forks = 0, revoked = 0
  live.run.fork = async () => { forks++ }
  w.adapter.bridgeOn = () => true
  w.adapter.backchannel = { refresh: () => true, revoke: () => { revoked++ } }
  w.spec.refresh = 'fork'
  await w.step([said('Another image turn.')])
  assert.equal(forks, 0)
  assert.equal(revoked, 1)
  assert.equal(owner.lifetime.signal.aborted, true)
  assert.equal(live.run.disposed, true)
  assert.equal(w.events().filter(row => row.event === 'prompt').length, 2)
})

for (const [level, own] of [['danger-full-access', false], ['auto', false], ['workspace-write', true]]) test(`active overlay to ${level}, own=${own}: no feature reaches the next ordinary process`, { timeout: 10000 }, async t => {
  const w = await world(t), { owner } = await w.consent(); await owner.grant.ready
  await w.step([said('Open it now.')])
  const old = w.adapter.live.get('chat')
  w.current.level = level; w.current.own = own
  w.adapter.noteEvent(w.session, { type: 'permission/preset' })
  await w.step([said('An ordinary new turn.')])
  assert.equal(old.run.disposed, true)
  assert.equal(w.launches.at(-1), undefined)
  assert.equal(w.events().filter(row => row.event === 'start').at(-1).env, undefined)
})
