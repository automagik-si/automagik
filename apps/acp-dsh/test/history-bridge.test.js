import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { Session } from '@deepseek-ai/dsh-session'
import { AcpAdapter, BRIDGE_PATH } from '../src/host/adapter.js'
import { Backchannel, signatureOf } from '../src/host/backchannel.js'
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
          return { content: [{ type: 'text', text: await controls.body() }], isError: false }
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
  const record = backchannel.mint({
    sessionId: session.id, agent, only, promptRunning: () => !prompt.signal.aborted,
    historyPrompt: () => prompt.signal,
  })
  return {
    ctx, backchannel, record, requests, executed, session, agent, controls,
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
    async ask(method) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: {} }) + '\n')
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
    await p.see('verified', initial)
    await p.run.onUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'verified', status: 'in_progress' }, 'current')
    const seen = p.run.tools.get('verified')
    assert.equal(seen.skillOperation, op)
    assert.equal(seen.status, 'in_progress')
    assert.deepEqual(await soon(p.ask('verified')), picked('yes'))
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
