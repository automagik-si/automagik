import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session } from '@deepseek-ai/dsh-session'
import LocalSpillStore from '@deepseek-ai/dsh-spill-local'
import { apply as applySpill, inject as spillInject } from '@deepseek-ai/dsh-spill-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { apply as applyExecutor, inject as executorInject } from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { AcpAdapter, BRIDGE_PATH } from '../src/host/adapter.js'
import { Backchannel, signatureOf } from '../src/host/backchannel.js'
import { codexWorld, scheduled, turnOn } from './fixtures/codex-native-world.js'
import { CLAUDE, nativeWorld, person } from './fixtures/managed-native-world.js'
import { ompWorld, OMP } from './fixtures/omp-world.js'
import { CANCELLED, picked, probe, soon } from './support/state-probe.js'

const HISTORY = 'read_own_chat'
const SKILL = 'load_skill'
const definitions = [HISTORY, SKILL, 'bash', 'update_bot', 'read_group_chat', 'write'].map(name => ({
  name, description: name, parameters: { type: 'object' },
}))
const attachment = 'a'.repeat(32)

function wire(backchannel, record, id = attachment, path = backchannel.urlFor(record)) {
  return async (op, body = {}) => {
    const response = await fetch(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${record.credential}`, 'x-dsh-bridge-attachment': id },
      body: JSON.stringify({ op, ...body }),
    })
    return { status: response.status, body: await response.json() }
  }
}

function world(t, { level = 'manual', only = new Set([HISTORY]), sandbox = level === 'full' ? 'danger-full-access' : 'workspace-write' } = {}) {
  const session = Session.create('history-chat')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', { header: { config: { provider: OMP, model: 'default' }, tools: definitions }, reason: 'initial' })
  const agent = { session }
  const requests = []
  const executed = []
  const events = new Map()
  const controls = { ask: () => 'allowed-once', beforeBody: () => {}, body: () => 'private history' }
  const services = {
    approval: {
      effectivePolicy: () => level === 'full' ? 'never' : 'ask',
      async request(request) {
        requests.push(request)
        return controls.ask(request)
      },
    },
    sandboxPolicy: { resolve: () => ({ mode: sandbox }) },
    permissionPresets: { current: () => level },
    tools: {
      definitions: () => definitions,
      async execute({ calls: [call], agent, signal }) {
        await controls.beforeBody({ call, agent, signal })
        const exec = { agent, callId: call.id, name: call.name, signal }
        const dispatch = async () => {
          executed.push(call)
          const value = await controls.body(call)
          return { content: Array.isArray(value) ? value : [{ type: 'text', text: value }], isError: false }
        }
        const execute = [...(events.get('tools/execute') ?? [])].reduceRight(
          (next, listener) => () => listener(exec, next), dispatch)
        return { results: [{ result: await execute() }] }
      },
    },
  }
  const ctx = {
    get: name => services[name],
    agents: { get: () => agent, turnBoundaryOf: () => ({ lastTurn: 1 }) },
    on(name, listener) {
      if (!events.has(name)) events.set(name, new Set())
      events.get(name).add(listener)
      return () => events.get(name).delete(listener)
    },
  }
  const backchannel = new Backchannel({ ctx })
  t.after(() => backchannel.dispose())
  let prompt = new AbortController()
  const claims = new Map()
  const record = backchannel.mint({
    sessionId: session.id, agent, only, promptRunning: () => !prompt.signal.aborted,
    historyPrompt: () => prompt.signal,
    restrictedCall: (id, name, signal) => {
      if (id === undefined || signal !== prompt.signal || signal.aborted) return
      if (!claims.has(id)) claims.set(id, { name, signal })
      const claim = claims.get(id)
      if (claim.signal === signal && claim.name === name) return claim
    },
  })
  return {
    ctx, services, backchannel, record, requests, executed, session, agent, controls,
    stop: () => { prompt.abort(); backchannel.cancel(record) },
    replacePrompt: () => { prompt = new AbortController() },
    call: (callId, name = HISTORY) => backchannel.call(record, { name, arguments: { query: 'marker' }, callId }),
  }
}

test('C1 the dsh bridge filters its preset and refuses every operation outside the allowlist', async t => {
  const only = new Set([HISTORY, SKILL, 'write'])
  const h = world(t, { only, sandbox: 'read-only' })
  await h.backchannel.listen()
  const post = wire(h.backchannel, h.record)
  assert.deepEqual((await post('list')).body.tools.map(tool => tool.name), [HISTORY, SKILL])
  for (const name of ['bash', 'update_bot', 'read_group_chat']) {
    assert.equal((await post('call', { name })).status, 403, name)
    assert.equal((await h.call('denied', name)).isError, true)
  }
  assert.deepEqual(h.executed, [])
  assert.notEqual(signatureOf(h.ctx, h.agent, { only }), signatureOf(h.ctx, h.agent, { only: new Set([HISTORY, SKILL]) }))
  const wrongPath = wire(h.backchannel, h.record, attachment, `${h.backchannel.url}/other-session`)
  assert.equal((await wrongPath('call', { name: HISTORY })).status, 401)
})

function omp(t) {
  const h = ompWorld(t)
  let tools = true
  let role = true
  let skills = false
  h.adapter.dshTools = () => tools
  h.service.botIdentity(() => ({ name: 'Bot', needsDshTools: role }))
  h.services.tools = { definitions: () => definitions }
  h.services.omniTeam = { skillCalls: { available: () => skills, catalog: () => undefined, project: options => options, admit() {} } }
  return { ...h, tools: value => { tools = value }, role: value => { role = value }, skills: value => { skills = value } }
}

test('C2 only the eligible omp Session gets one restricted dsh bridge', async t => {
  const h = omp(t)
  for (const [label, expected] of [
    ['history', [HISTORY]], ['both', [HISTORY, SKILL]], ['disabled', []], ['no-role', []],
  ]) {
    h.skills(label === 'both')
    h.tools(label !== 'disabled')
    h.role(label !== 'no-role')
    const before = h.events('mcp-list').length
    const chat = h.chat(label)
    const chunks = await chat.turn(`plain ${label}`)
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.deepEqual(h.conversation(`plain ${label}`).servers, expected.length ? ['dsh'] : [])
    assert.deepEqual(h.events('mcp-list').slice(before).map(row => row.tools), expected.length ? [expected] : [])
  }
  h.role(true)
  for (const provider of ['acp-hermes', 'acp-antigravity']) {
    assert.equal(h.adapter.historyWanted({ bridge: false }, 'no-role', provider), false)
  }
})

test('C3 omp OFF admits its verified history call and rejects conflicting first or later claims', async t => {
  for (const kind of ['tool_call', 'tool_call_update', 'rename', 'raw-conflict']) {
    const forbidden = []
    const p = probe(t, { provider: OMP, refuseTools: true, skillBridge: true, skillTools: new Set([HISTORY, SKILL]),
      onForbiddenTool: update => forbidden.push(update) })
    const end = p.begin()
    const send = (sessionUpdate, details) => p.run.onUpdate({ sessionUpdate, toolCallId: 'lookup', ...details }, 'current')
    await send('tool_call', { name: 'mcp__dsh_read_own_chat', status: 'in_progress' })
    await send('tool_call_update', { status: 'completed' })
    const verified = p.run.tools.get('lookup')
    assert.equal(verified?.skillBridge, true, 'the adapter skips mirroring this bridge call')
    assert.equal(verified?.status, 'completed')
    assert.deepEqual(forbidden, [])
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      await p.run.onUpdate({ sessionUpdate: kind, toolCallId: 'unrelated', name: 'mcp__dsh_bash' }, 'current')
    } else if (kind === 'rename') {
      await send('tool_call_update', { name: 'mcp__dsh_load_skill', status: 'failed' })
    } else {
      await send('tool_call_update', { rawInput: { server: 'dsh', tool: 'read_group_chat' } })
    }
    assert.equal(forbidden.length, 1)
    assert.equal(verified.status, 'completed')
    await end()
  }
})

test('C4 Manual rejects, asks once per fresh call, and spends each grant at most once', async t => {
  const h = world(t)
  h.controls.ask = () => 'rejected'
  assert.equal((await h.call('rejected')).error.code, 'REJECTED')
  h.controls.ask = () => 'allowed-once'
  assert.equal((await h.call('granted')).isError, false)
  assert.equal((await h.call('granted')).error?.code, 'BRIDGE_CANCELLED')
  assert.deepEqual(h.requests.map(request => [request.callId, request.toolName]), [['rejected', HISTORY], ['granted', HISTORY]])
  assert.equal(h.executed.length, 1)
})

test('C4 Stop during an approval never executes the tool', async t => {
  const h = world(t)
  const requested = Promise.withResolvers()
  const answer = Promise.withResolvers()
  h.controls.ask = request => { requested.resolve(request); return answer.promise }
  const pending = h.call('stopped')
  const request = await soon(requested.promise)
  h.stop()
  answer.resolve('allowed-once')
  assert.equal(request.signal.aborted, true)
  assert.equal((await pending).error?.code, 'BRIDGE_CANCELLED')
  assert.deepEqual(h.executed, [])
  assert.doesNotMatch(JSON.stringify(h.session.snapshotEvents()), /private history/)
})

test('C4 an open DSH step confers no authority after its ACP prompt ends', async t => {
  const h = world(t)
  h.stop()
  assert.equal((await h.call('out-of-prompt')).error?.code, 'BRIDGE_CANCELLED')
  assert.deepEqual(h.requests, [])
  assert.deepEqual(h.executed, [])
})

test('C4 a same-ID Session replacement cannot inherit the bridge grant', async t => {
  const h = world(t)
  const gate = Promise.withResolvers()
  const allowed = Promise.withResolvers()
  h.controls.ask = () => { gate.resolve(); return allowed.promise }
  const pending = h.call('before-session-replacement')
  await soon(gate.promise)
  h.agent.session = Session.create(h.session.id)
  allowed.resolve('allowed-once')
  assert.equal((await pending).error?.code, 'BRIDGE_CANCELLED')
  assert.equal((await h.call('after-session-replacement')).error?.code, 'BRIDGE_CANCELLED')
  assert.equal(h.requests.length, 1)
  assert.deepEqual(h.executed, [])
})

test('C4 a turn waiting for its next step cannot use a replacement prompt', async t => {
  const h = world(t)
  h.session.append('step/end', { turn: 1, step: 1 })
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  t.mock.method(h.backchannel, 'waitForStep', () => { entered.resolve(); return release.promise })
  const pending = h.call('between-steps')
  await soon(entered.promise)
  h.replacePrompt()
  h.session.append('step/start', { turn: 1, step: 2 })
  release.resolve('ready')
  assert.equal((await pending).error?.code, 'BRIDGE_CANCELLED')
  assert.deepEqual(h.requests, [])
  assert.deepEqual(h.executed, [])
})

for (const level of ['auto', 'full']) {
  test(`C4 ${level} retains its approval policy and suppresses a result after prompt replacement`, async t => {
    const h = world(t, { level })
    assert.equal((await h.call('legitimate')).isError, false)
    assert.deepEqual(h.requests, [], 'the bridge does not put up a second dialog')
    const dispatched = Promise.withResolvers()
    const result = Promise.withResolvers()
    h.controls.body = () => { dispatched.resolve(); return result.promise }
    const pending = h.call('late-result')
    await soon(dispatched.promise)
    h.replacePrompt()
    result.resolve('late confidential result')
    const answer = await pending
    assert.equal(answer.error?.code, 'BRIDGE_CANCELLED')
    assert.deepEqual(answer.content, [])
    const terminal = h.session.snapshotEvents().findLast(row => row.type === 'tool/result')
    assert.equal(terminal.data.error.code, 'BRIDGE_CANCELLED')
    assert.doesNotMatch(JSON.stringify(terminal), /late confidential result/)
  })
}

test('C4 Auto rechecks the originating prompt at dispatch after its policy wait', async t => {
  const h = world(t, { level: 'auto' })
  const reviewing = Promise.withResolvers()
  const allowed = Promise.withResolvers()
  h.controls.beforeBody = () => { reviewing.resolve(); return allowed.promise }
  const pending = h.call('auto-review')
  await soon(reviewing.promise)
  h.replacePrompt()
  allowed.resolve()
  assert.equal((await pending).error?.code, 'BRIDGE_CANCELLED')
  assert.deepEqual(h.executed, [])
  assert.deepEqual(h.requests, [])
})

test('C4 revocation while history runs keeps status without delivering content', async t => {
  const h = world(t)
  await h.backchannel.listen()
  const post = wire(h.backchannel, h.record)
  await post('list')
  const dispatched = Promise.withResolvers()
  const result = Promise.withResolvers()
  h.controls.body = () => { dispatched.resolve(); return result.promise }
  const pending = post('call', { name: HISTORY, callId: 'revoked' })
  await soon(dispatched.promise)
  h.backchannel.revoke(h.record)
  result.resolve('late confidential result')
  assert.equal((await pending).status, 401)
  assert.equal((await post('list')).status, 401)
  const terminal = h.session.snapshotEvents().findLast(row => row.type === 'tool/result')
  assert.equal(terminal.data.error.code, 'BRIDGE_REVOKED')
  assert.doesNotMatch(JSON.stringify(terminal), /late confidential result/)
})

test('C5 crossing retires the live history bridge and rejects its bearer', async t => {
  const h = omp(t)
  const chat = h.chat('crossing')
  await chat.turn('plain before crossing')
  const record = h.adapter.live.get('crossing')?.bridge
  assert.ok(record, 'the history run owns a bridge before the crossing')
  assert.equal(record.closed, false)
  chat.policyEvent('model/selection', { provider: 'deepseek', model: 'fixture' })
  assert.equal(h.adapter.live.has('crossing'), false)
  assert.equal((await wire(h.adapter.backchannel, record)('list')).status, 401)
})

for (const changed of ['provider crossing', 'provider replacement', 'role withdrawal']) {
  test(`C5 refuses to mint or launch after ${changed} during history bridge setup`, async t => {
    const h = omp(t)
    const binding = Promise.withResolvers()
    const release = Promise.withResolvers()
    const backchannel = h.adapter.backchannel
    const listen = backchannel.listen.bind(backchannel)
    t.mock.method(backchannel, 'listen', async () => {
      binding.resolve(true)
      await release.promise
      return listen()
    })
    const mint = t.mock.method(backchannel, 'mint')
    const chat = h.chat('launch')
    const turn = chat.turn('plain pending launch')
    assert.equal(await soon(Promise.race([binding.promise, turn.then(() => false)])), true, 'the history bridge reached its setup wait')
    try {
      if (changed === 'provider crossing') chat.policyEvent('model/selection', { provider: 'deepseek', model: 'fixture' })
      if (changed === 'provider replacement') h.adapter.agents.set(OMP, { ...h.adapter.agents.get(OMP) })
      if (changed === 'role withdrawal') h.role(false)
    } finally { release.resolve() }
    await turn
    assert.equal(mint.mock.callCount(), 0)
    assert.equal(h.adapter.live.has('launch'), false)
    assert.deepEqual(h.events('prompt'), [])
  })
}

test('C5 rechecks eligibility after launch and before the first prompt', async t => {
  const h = omp(t)
  const reached = Promise.withResolvers()
  const release = Promise.withResolvers()
  let gates = 0
  h.adapter.holds = () => [() => {
    if (++gates !== 2) return
    reached.resolve()
    return release.promise
  }]
  const chat = h.chat('first-prompt')
  const turn = chat.turn('plain withheld prompt')
  await soon(reached.promise)
  const record = h.adapter.live.get('first-prompt')?.bridge
  h.role(false)
  release.resolve()
  await turn
  assert.ok(record, 'the child already attached its history bridge')
  assert.equal(record.closed, true)
  assert.deepEqual(h.events('prompt'), [])
  assert.equal(h.adapter.live.has('first-prompt'), false)
})

test('C5 disposal revokes the exact history record and preserves a same-ID replacement and its image grant', async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'history-disposal-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const h = world(t)
  const listeners = new Map()
  const ctx = { ...h.ctx, on: (event, listener) => { listeners.set(event, listener); return () => {} } }
  const adapter = new AcpAdapter(ctx, new Map(), { backchannel: h.backchannel })
  t.after(() => adapter.dispose())
  const old = { session: h.session, dshAgent: h.agent, bridge: h.record, run: { dispose() {} }, provider: OMP }
  adapter.live.set(h.session.id, old)
  const replacement = { session: Session.create(h.session.id, undefined, { id: h.session.id, cwd, version: 4, createdAt: 0, isSeeded: false }) }
  const owner = adapter.sessionFiles.owner(replacement, 'acp-codex')
  const grant = { files: [], staged: true }
  owner.grant = grant
  const pending = { session: h.session, dshAgent: h.agent, provider: OMP, startup: old }
  adapter.starting.set(h.session.id, pending)
  listeners.get('session/disposed')(h.session)
  assert.equal(pending.invalidated, true)
  assert.equal(h.record.closed, true)
  assert.equal(adapter.live.has(h.session.id), false)
  assert.equal(adapter.sessionFiles.owners.get(h.session.id), owner)
  assert.equal(owner.grant, grant)
  assert.equal(owner.lifetime.signal.aborted, false)

  const next = { session: replacement.session, dshAgent: replacement, bridge: h.backchannel.mint({
    sessionId: h.session.id, agent: replacement, only: new Set([HISTORY]),
  }), run: { dispose() {} }, fileOwner: owner, provider: OMP }
  adapter.live.set(h.session.id, next)
  adapter.starting.delete(h.session.id)
  listeners.get('session/disposed')(h.session)
  assert.equal(adapter.live.get(h.session.id), next)
  assert.equal(owner.grant, grant)
  listeners.get('session/disposed')(replacement.session)
  assert.equal(next.bridge.closed, true, 'a live record with no pending start is also retired')
})

function mcp(t, backchannel, record) {
  const child = spawn(process.execPath, [BRIDGE_PATH], {
    env: { ...process.env, DSH_BRIDGE_URL: backchannel.urlFor(record), DSH_BRIDGE_CREDENTIAL: record.credential },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  const closed = once(child, 'close')
  t.after(() => { if (child.exitCode === null) child.kill() })
  let id = 0
  return {
    async ask(method, params = {}) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n')
      return JSON.parse((await soon(lines.next())).value)
    },
    async close() { child.stdin.end(); return (await soon(closed))[0] },
  }
}

test('C6 discovery leaves readiness pending until the real list and normal close detaches', async t => {
  const h = world(t)
  await h.backchannel.listen()
  const adapter = new AcpAdapter(h.ctx, new Map(), { backchannel: h.backchannel })
  t.after(() => adapter.dispose())
  let result = 'pending'
  const ready = adapter.ready({ bridgeReadyMs: 1000 }, { bridge: h.record }).then(() => { result = 'ready' }, error => { result = error.code })
  const first = mcp(t, h.backchannel, h.record)
  assert.equal((await first.ask('server/discover')).error.code, -32601)
  assert.ok((await first.ask('initialize')).result)
  assert.equal(await first.close(), 0)
  assert.equal(h.record.disconnected, false)
  assert.equal(h.record.listed, false)
  assert.equal(result, 'pending')
  const real = mcp(t, h.backchannel, h.record)
  assert.ok((await real.ask('initialize')).result)
  assert.deepEqual((await real.ask('tools/list')).result.tools.map(tool => tool.name), [HISTORY])
  await soon(ready)
  assert.equal(result, 'ready')
  assert.equal(await real.close(), 0)
  assert.equal(h.record.disconnected, true)
  assert.equal(h.record.attachment, undefined)
})

test('C7 loss of the role revokes a history-only bridge on the next step', async t => {
  const h = omp(t)
  const chat = h.chat('role')
  await chat.turn('plain eligible')
  const live = h.adapter.live.get('role')
  assert.ok(live.bridge)
  h.role(false)
  await chat.turn('plain role removed')
  assert.equal(live.bridge.closed, true)
  assert.notEqual(h.adapter.live.get('role'), live)
  assert.deepEqual(h.conversation('plain role removed').servers, [])
})

test('AD-4 the verified operation survives updates, permissions and retirement for every Skills bridge shape', async t => {
  for (const [provider, only, op, initial] of [
    ['acp-claude', undefined, SKILL, { name: 'mcp__dsh__load_skill' }],
    ['acp-codex', new Set([SKILL]), SKILL, { rawInput: { server: 'dsh', tool: SKILL }, _meta: { is_mcp_tool_call: true } }],
    [OMP, new Set([HISTORY]), HISTORY, { name: 'mcp__dsh_read_own_chat' }],
    [OMP, new Set([HISTORY, SKILL]), SKILL, { name: 'mcp__dsh_load_skill' }],
    [OMP, new Set([HISTORY, SKILL]), HISTORY, { name: 'mcp__dsh_read_own_chat' }],
  ]) {
    const p = probe(t, { provider, skillBridge: true, skillTools: only })
    const end = p.begin()
    await p.run.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 'verified', ...initial }, 'current')
    await p.run.onUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'verified', status: 'in_progress' }, 'current')
    const seen = p.run.tools.get('verified')
    assert.equal(seen.skillOperation, op)
    assert.equal(seen.status, 'in_progress')
    assert.deepEqual(await soon(p.ask('verified', { sessionId: 'current' })), picked('yes'))
    await end()
    const endNext = p.begin()
    const retired = p.run.tools.get('verified')
    assert.equal(retired.skillOperation, op)
    assert.equal(retired.retired, true)
    if (op === HISTORY) assert.deepEqual(await soon(p.ask('verified')), CANCELLED)
    await p.run.onUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'verified', status: 'completed' }, 'current')
    assert.equal(retired.status, 'completed')
    const contradictory = op === HISTORY ? SKILL : HISTORY
    await p.run.onUpdate({
      sessionUpdate: 'tool_call_update', toolCallId: 'verified', status: 'failed', name: `mcp__dsh__${contradictory}`,
    }, 'current')
    assert.equal(retired.skillOperation, op)
    assert.equal(retired.status, 'completed')
    assert.equal(retired.skillBridge, false)
    assert.equal(retired.skillConflict, true)
    assert.deepEqual(await soon(p.ask('verified', { toolCall: { toolCallId: 'verified', name: `mcp__dsh__${contradictory}` } })), CANCELLED)
    await endNext()
  }
})

test('AD-4 reuse recomputes both operations and replaces a disconnected history-only bridge', async t => {
  const h = omp(t)
  const chat = h.chat('reuse')
  await chat.turn('plain history only')
  const original = h.adapter.live.get('reuse').bridge
  assert.deepEqual([...original?.only ?? []], [HISTORY])
  h.adapter.backchannel.detach(original)
  await chat.turn('plain after detach')
  const recovered = h.adapter.live.get('reuse').bridge
  assert.notEqual(recovered, original)
  assert.equal(original.closed, true)
  h.skills(true)
  await chat.turn('plain both')
  const both = h.adapter.live.get('reuse').bridge
  assert.equal(recovered.closed, true)
  assert.deepEqual([...both.only].sort(), [SKILL, HISTORY])
  h.role(false)
  await chat.turn('plain skill only')
  assert.equal(both.closed, true)
  assert.deepEqual([...h.adapter.live.get('reuse').bridge.only], [SKILL])
})

test('AD-4 a verified first update keeps its existing status and terminal metadata', async t => {
  const p = probe(t, { provider: 'acp-claude', skillBridge: true })
  const end = p.begin()
  await p.run.onUpdate({
    sessionUpdate: 'tool_call_update', toolCallId: 'first-update', name: 'mcp__dsh__load_skill',
    status: 'in_progress', _meta: { terminal_output: { data: 'tool status' } },
  }, 'current')
  const call = p.run.tools.get('first-update')
  assert.equal(call.output, 'tool status')
  assert.equal(call.status, 'in_progress')
  assert.equal(call.skillOperation, SKILL)
  await end()
})

test('AD-4 fork recomputes eligibility, revokes the source, and verifies the fork against its new set', async t => {
  const h = omp(t)
  const chat = h.chat('fork')
  await chat.turn('plain source')
  const live = h.adapter.live.get('fork')
  const previous = live.bridge
  assert.ok(previous)
  h.skills(true)
  h.role(false)
  const row = h.adapter.agents.get(OMP)
  const next = await h.adapter.refork(row, live, live.dshAgent)
  assert.equal((await wire(h.adapter.backchannel, previous)('list')).status, 401)
  assert.deepEqual([...next.only], [SKILL])
  assert.equal(live.run.spec.skillTools, next.only)
  assert.deepEqual(h.events('fork').at(-1).servers, ['dsh'])
  assert.deepEqual(h.events('mcp-list').at(-1).tools, [SKILL])
})

test('round 2: revocation during the pinned spill policy leaves only ordinary spill data', async t => {
  const h = world(t, { level: 'full' })
  const dir = mkdtempSync(join(tmpdir(), 'history-spill-'))
  const harness = new Context()
  t.after(async () => {
    await harness.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  const root = join(dir, 'spill')
  await harness.plugin(SystemPrompt)
  await harness.plugin(ToolRuntime)
  await harness.plugin({ apply: applyExecutor, inject: executorInject })
  await harness.plugin(LocalSpillStore, { root, cleanupPeriodDays: 0 })
  await harness.plugin({ apply: applySpill, inject: spillInject }, { maxInlineTokens: 256 })
  await harness.inject(['tools'], ctx => { h.agent.ctx = createScope(ctx, h.agent).ctx })
  h.services.tools = harness.tools
  const attach = h.ctx.on
  h.ctx.on = (event, listener, options) => event.startsWith('tools/')
    ? harness.on(event, listener, options) : attach(event, listener, options)

  const ordinary = 'ordinary-spill-marker '.repeat(2048)
  const history = 'revoked-history-marker '.repeat(2048)
  const allowedHistory = 'authorized-history-marker '.repeat(2048)
  const replies = new Map([['ordinary-spill', ordinary], ['spill-revoked', history], ['spill-authorized', allowedHistory]])
  h.agent.ctx.tools.register({
    name: HISTORY,
    description: 'Return oversized fixture text.',
    parameters: { type: 'object' },
    output: { schema: { type: 'string' }, render: (_, text) => [{ type: 'text', text }] },
    execute: (_, exec) => replies.get(exec.callId),
  })
  await h.backchannel.listen()
  const full = h.backchannel.mint({ sessionId: h.session.id, agent: h.agent })
  const fullPost = wire(h.backchannel, full)
  await fullPost('list')
  const ordinaryResult = await fullPost('call', { name: HISTORY, callId: 'ordinary-spill' })
  assert.equal(ordinaryResult.body.isError, false)
  assert.match(JSON.stringify(ordinaryResult.body), /Use read with offset\/limit/)
  function spills() {
    return readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
      .map(entry => readFileSync(join(entry.parentPath, entry.name), 'utf8'))
  }
  assert.deepEqual(spills(), [ordinary])

  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  harness.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (exec.callId !== 'spill-revoked') return decision
    entered.resolve(result.content[0]?.text === history)
    await release.promise
    return decision
  })

  const post = wire(h.backchannel, h.record)
  await post('list')
  const pending = post('call', { name: HISTORY, callId: 'spill-revoked' })
  try {
    assert.equal(await soon(entered.promise), true, 'the actual oversized result reached post-processing')
    h.backchannel.revoke(h.record)
  } finally {
    release.resolve()
  }
  const reply = await pending
  assert.equal(reply.status, 401)
  const rows = h.session.snapshotEvents()
  const result = rows.findLast(row => row.type === 'tool/result')
  assert.equal(result?.data.error.code, 'BRIDGE_REVOKED')
  assert.doesNotMatch(JSON.stringify({ rows, reply }), /revoked-history-marker/)
  const saved = spills()
  t.diagnostic(JSON.stringify({ ordinarySpills: saved.filter(text => text === ordinary).length, withdrawnSpills: saved.filter(text => text === history).length }))
  assert.equal(saved.length, 1, 'the restricted call must leave no second, durable copy')

  const authorized = h.backchannel.mint({
    sessionId: h.session.id, agent: h.agent, only: new Set([HISTORY]),
    historyPrompt: h.record.historyPrompt, restrictedCall: h.record.restrictedCall,
  })
  const authorizedPost = wire(h.backchannel, authorized, 'b'.repeat(32))
  await authorizedPost('list')
  const allowed = await authorizedPost('call', { name: HISTORY, callId: 'spill-authorized' })
  assert.equal(allowed.body.isError, false)
  assert.match(JSON.stringify(allowed.body), /authorized-history-marker/)
  assert.deepEqual(spills(), [ordinary], 'authorized history stays inline while ordinary spill remains recoverable')
})

for (const provider of [CLAUDE, 'acp-codex']) {
  test(`round 2: ${provider} full-bridge history keeps one approval and the same agent Session`, async t => {
    const w = provider === CLAUDE ? nativeWorld(t) : codexWorld(t, { identity: () => ({ name: 'Fake Bot' }), dshTools: true })
    w.services.tools.definitions = () => definitions
    w.services.tools.executable = name => definitions.find(tool => tool.name === name)
    const ask = t.mock.method(w.services.approval, 'request')
    const chat = w.chat('full-history')
    const send = text => provider === CLAUDE ? chat.turn(person(text), provider) : turnOn(w, chat, scheduled(text))
    const chunks = await send(provider === CLAUDE ? 'bridge-permit read_own_chat' : 'codex-bridge read_own_chat {"query":"fixture"}')
    t.diagnostic(JSON.stringify({ finish: chunks.at(-1)?.reason, executions: w.executed, asks: ask.mock.callCount() }))
    assert.equal(chunks.at(-1)?.reason.kind, 'stop')
    const answer = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
    assert.match(answer, /ran read_own_chat/)
    if (provider === CLAUDE) assert.match(answer, /permit yes/)
    const live = w.adapter.live.get(chat.session.id)
    assert.ok(live?.bridge)
    assert.equal(live.bridge.only, undefined)
    if (provider !== CLAUDE) assert.equal(live.nativeOff, true)
    assert.deepEqual(w.executed, [HISTORY])
    assert.deepEqual(ask.mock.calls.map(({ arguments: [request] }) => request.toolName), [HISTORY])
    assert.deepEqual(chat.history.flatMap(row => row.content ?? []).filter(block => block.type === 'tool-call'), [])
    assert.deepEqual(chat.session.snapshotEvents().filter(row => row.type === 'tool/call').map(row => row.data.name), [HISTORY])
    assert.equal((await send('plain next prompt')).at(-1)?.reason.kind, 'stop')
    assert.equal(w.adapter.live.get(chat.session.id), live)
    assert.equal(w.events('new-session').length, 1)
  })
}

async function combined(t, { off = false } = {}) {
  const only = new Set([HISTORY, SKILL])
  const h = world(t, { level: 'full', only })
  h.backchannel.revoke(h.record)
  const providerRow = { bridge: false }
  const adapter = new AcpAdapter(h.ctx, new Map([[OMP, providerRow]]), {
    backchannel: h.backchannel, botIdentity: () => ({ needsDshTools: true }), dshTools: () => true,
  })
  t.after(() => adapter.dispose())
  h.ctx.sessions = new Map([[h.session.id, h.session]])
  const p = probe(t, { provider: OMP, skillBridge: true, skillTools: only, refuseTools: off })
  const live = { provider: OMP, providerRow, dshAgent: h.agent, session: h.session, run: p.run, open: true }
  adapter.live.set(h.session.id, live)
  live.bridge = adapter.mintBridge(live, h.agent, only)
  await h.backchannel.listen()
  const child = mcp(t, h.backchannel, live.bridge)
  assert.deepEqual((await child.ask('tools/list')).result.tools.map(tool => tool.name), [HISTORY, SKILL])
  const send = (id, update = {}, session = 'current') => p.run.onUpdate({
    sessionUpdate: 'tool_call', toolCallId: id, ...update,
  }, session)
  const seen = (id, name, session) => send(id, { name: `mcp__dsh_${name}` }, session)
  const call = async (id, name = HISTORY) => (await child.ask('tools/call', {
    name, arguments: { name: 'marker', query: 'marker' },
    ...(id === undefined ? {} : { _meta: { callId: id } }),
  })).result
  const skill = { type: 'text', text: 'checked fixture skill', automagikSkill: { kind: 'automagik-skill', use: 'load',
    name: 'marker', hash: 'fixture', botId: 'fixture' } }
  h.services.omniTeam = { skillCalls: { load: () => skill, unavailable: 'The fixture skill is unavailable.', admit() {} } }
  h.controls.body = ({ name }) => name === SKILL ? [skill] : 'private history'
  return { ...h, p, live, seen, send, call }
}

for (const [failure, id] of [['missing', undefined], ['unknown', 'unknown'], ['unverified', 'unverified'], ['foreign-session', 'foreign']]) {
  test(`round 2: combined bridge rejects ${failure} ACP bindings before execution`, async t => {
    const h = await combined(t)
    const end = h.p.begin()
    try {
      await h.send('unverified', { title: 'Ordinary metadata' })
      await h.seen('foreign', HISTORY, 'wrong-acp-session')
      const refused = [await h.call(id), await h.call(id, SKILL)]
      assert.deepEqual(refused.map(result => result.isError), [true, true])
      assert.doesNotMatch(JSON.stringify(refused), /private history|checked fixture skill/)
      assert.deepEqual(h.executed, [])
      assert.equal(h.p.run.tools.get('unverified').title, 'Ordinary metadata')
    } finally { await end() }
  })
}

test('round 2: combined bridge binds each operation across both protocols and consumes it once', async t => {
  const h = await combined(t)
  const end = h.p.begin()
  try {
    await h.seen('wrong-skill', HISTORY)
    await h.seen('wrong-history', SKILL)
    const wrongSkill = await h.call('wrong-skill', SKILL)
    const wrongHistory = await h.call('wrong-history', HISTORY)
    const claimedAgain = await h.call('wrong-skill')
    t.diagnostic(JSON.stringify({ wrongSkill: wrongSkill.isError, wrongHistory: wrongHistory.isError, claimedAgain: claimedAgain.isError }))
    assert.equal(wrongSkill.isError, true, 'a history identity cannot dispatch a Skill')
    assert.equal(wrongHistory.isError, true, 'a Skills identity cannot dispatch history')
    assert.equal(claimedAgain.isError, true, 'the first MCP conflict is sticky')
    assert.deepEqual(h.executed, [])

    for (const name of [HISTORY, SKILL]) {
      await h.seen(name, name)
      assert.deepEqual(await h.p.ask(name, { sessionId: 'current' }), picked('yes'))
      assert.equal((await h.call(name, name)).isError, false)
      assert.equal((await h.call(name, name)).isError, true, 'another MCP request cannot reuse the ACP identity')
    }
    assert.deepEqual(h.executed.map(row => row.name), [HISTORY, SKILL])
  } finally { await end() }

  const next = h.p.begin()
  try {
    assert.equal((await h.call(HISTORY)).isError, true)
    assert.equal((await h.call(SKILL, SKILL)).isError, true)
  } finally { await next() }
})

test('round 2: combined bridge rechecks a known call after the originating Session changes', async t => {
  const h = await combined(t)
  const end = h.p.begin()
  try {
    await h.seen('old-skills', SKILL)
    h.ctx.sessions.set(h.session.id, Session.create(h.session.id))
    assert.equal((await h.call('old-skills', SKILL)).isError, true)
    assert.deepEqual(h.executed, [])
  } finally { await end() }
})

test('round 2: omp OFF remembers a permission-first conflict and accepts status metadata', async t => {
  const h = await combined(t, { off: true })
  const end = h.p.begin()
  const status = (id, details) => h.p.run.onUpdate({ sessionUpdate: 'tool_call_update', toolCallId: id, ...details }, 'current')
  try {
    const ask = (id, toolCall = { toolCallId: id }) => h.p.ask(id, { sessionId: 'current', toolCall })
    assert.deepEqual(await ask('conflict', { toolCallId: 'conflict', name: 'mcp__dsh_read_own_chat',
      rawInput: { server: 'dsh', tool: SKILL } }), picked('no'))
    await h.seen('conflict', HISTORY)
    const conflict = h.p.run.tools.get('conflict')
    assert.equal(conflict?.skillConflict, true)
    assert.deepEqual(await ask('conflict'), picked('no'))
    assert.equal((await h.call('conflict')).isError, true)

    await h.seen('verified-status', HISTORY)
    await status('verified-status', { status: 'in_progress', _meta: { terminal_output: { data: 'started normally' } } })
    await status('verified-status', { name: 'mcp__dsh_load_skill', status: 'failed' })
    assert.equal((await h.call('verified-status')).isError, true)
    await status('verified-status', { status: 'completed', _meta: { terminal_output: { data: ' and settled' } } })
    const verified = h.p.run.tools.get('verified-status')
    assert.equal(verified.skillOperation, HISTORY)
    assert.equal(verified.status, 'completed')
    assert.equal(verified.output, 'started normally and settled')
    assert.equal(verified.skillConflict, true)
    assert.deepEqual(h.executed, [])
  } finally { await end() }
})

test('a refused explicit ACP operation leaves a retired restricted identity', async t => {
  const p = probe(t, { provider: OMP, skillBridge: true, skillTools: new Set([HISTORY]), refuseTools: true })
  const id = 'fixture-acp-refusal'
  const end = p.begin()
  const permission = await p.ask(id, { sessionId: 'current', toolCall: { toolCallId: id, name: 'mcp__dsh_fixture_unoffered' } })
  await end()

  const next = p.begin()
  try {
    const tool = p.run.tools.get(id)
    assert.deepEqual({ permission, retired: tool?.retired, restricted: tool?.restrictedIdentity, conflict: tool?.skillConflict },
      { permission: picked('no'), retired: true, restricted: true, conflict: true })
  } finally { await next() }
})

test('an MCP allowlist refusal revokes the exact restricted identity', async t => {
  const h = await combined(t, { off: true })
  h.controls.body = () => []
  const id = 'fixture-bridge-refusal'
  const otherId = 'fixture-other-call'
  const end = h.p.begin()
  try {
    await h.seen(id, HISTORY)
    await h.seen(otherId, HISTORY)
    const tool = h.p.run.tools.get(id)
    const other = h.p.run.tools.get(otherId)
    const record = h.live.bridge
    const post = wire(h.backchannel, record, record.attachment)
    const refused = await post('call', { name: 'fixture_unoffered', callId: id })
    assert.deepEqual({ refused, conflict: tool.skillConflict, revoked: tool.skillAbort.signal.aborted,
      otherRevoked: other.skillAbort.signal.aborted, executed: h.executed },
    { refused: { status: 403, body: { error: 'refused', isError: true } }, conflict: true,
      revoked: true, otherRevoked: false, executed: [] })
  } finally { await end() }
})

for (const change of ['provider row', 'DSH Agent', 'Session']) {
  test(`round 2: replacing the exact ${change} after a completed prompt replaces the history credential`, async t => {
    const h = omp(t)
    const id = 'history-reuse-owner'
    const chat = h.chat(id)
    h.services.tools.execute = async ({ calls: [call] }) => ({
      results: [{ result: { content: [{ type: 'text', text: `history for ${JSON.parse(call.arguments).query}` }] } }],
    })
    assert.equal((await chat.turn('history-lookup omp warm')).at(-1)?.reason.kind, 'stop')
    assert.match(JSON.stringify(h.events('mcp-history-result').at(-1)?.answer.content), /history for warm/)
    const before = h.adapter.live.get(id)
    assert.equal(before.run.promptEnded, true)
    if (change === 'provider row') h.adapter.agents.set(OMP, { ...h.adapter.agents.get(OMP) })
    if (change === 'DSH Agent') {
      const get = h.adapter.ctx.agents.get
      const agent = { ...get(id) }
      h.adapter.ctx.agents.get = key => key === id ? agent : get(key)
    }
    if (change === 'Session') {
      const replacement = Session.create(id, undefined, chat.session.header)
      replacement.append('turn/start', { turn: 1 })
      replacement.append('step/start', { turn: 1, step: 1 })
      before.dshAgent.session = replacement
    }

    const chunks = await chat.turn('history-lookup omp fixture')
    const after = h.adapter.live.get(id)
    const result = h.events('mcp-history-result').at(-1)?.answer
    t.diagnostic(JSON.stringify({ replaced: after !== before, originalClosed: before.bridge.closed, readSucceeded: result?.isError === false }))
    assert.equal(chunks.at(-1)?.reason.kind, 'stop')
    assert.notEqual(after, before)
    assert.notEqual(after.bridge.credential, before.bridge.credential)
    assert.equal(before.bridge.closed, true)
    assert.equal((await wire(h.adapter.backchannel, before.bridge)('list')).status, 401)
    assert.equal(result?.isError, false)
    assert.match(JSON.stringify(result.content), /history for fixture/)
    assert.deepEqual(h.conversation('history-lookup omp fixture').servers, ['dsh'])
  })
}

test('fresh fork after withdrawal of the last Automatic skill', async t => {
  const h = ompWorld(t)
  const name = 'load_skill'
  let automatic = true
  const unavailable = 'This fake Automatic skill was withdrawn.'
  h.adapter.dshTools = () => true
  h.service.botIdentity(() => ({ name: 'Fake Bot', needsDshTools: false }))
  h.services.omniTeam = { skillCalls: {
    available: () => automatic, unavailable, catalog: () => undefined, project: options => options,
    load: () => undefined, admit() {},
  } }
  h.services.tools = {
    definitions: () => [{ name, description: 'Load a skill', parameters: { type: 'object' } }],
    execute: () => assert.fail('a withdrawn skill must never execute'),
  }
  const id = 'withdraw-last-automatic'
  const chat = h.chat(id)
  assert.equal((await chat.turn('plain warm-up')).at(-1).reason.kind, 'stop')
  const live = h.adapter.live.get(id)
  const previous = live.bridge
  assert.equal(previous.skillOnly, true)
  assert.deepEqual(h.events('mcp-list').at(-1).tools, [name])
  const row = h.adapter.agents.get(OMP)
  automatic = false
  const old = await h.adapter.backchannel.call(previous, { name, arguments: { name: 'fake' } })
  assert.equal(old.isError, true)
  assert.match(JSON.stringify(old), /fake Automatic skill was withdrawn/)
  const next = await h.adapter.refork(row, live, live.dshAgent)
  const fork = h.events('fork').at(-1)
  const listed = h.events('mcp-list').filter(event => event.sessionId === fork.sessionId)
  t.diagnostic(JSON.stringify({
    accountChanged: false, sameProviderRow: h.adapter.agents.get(OMP) === row, oldRefused: old.isError,
    oldClosed: previous.closed, minted: next !== undefined, skillOnly: next?.skillOnly,
    servers: fork.servers, listed: listed.map(event => event.tools),
  }))
  assert.equal(previous.closed, true)
  assert.deepEqual(fork.servers, ['dsh'])
  assert.deepEqual(listed.map(event => event.tools), [[]], 'the fresh fork must not advertise the withdrawn Skill')
  const refusal = await wire(h.adapter.backchannel, next, next.attachment)('call', { name, arguments: { name: 'fake' } })
  assert.equal(refusal.status, 200)
  assert.deepEqual(refusal.body, old, 'a stale request still gets the checked refusal')
})
