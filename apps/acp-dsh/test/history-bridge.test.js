import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session } from '@deepseek-ai/dsh-session'
import LocalSpillStore from '@deepseek-ai/dsh-spill-local'
import { apply as applySpill, inject as spillInject } from '@deepseek-ai/dsh-spill-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { apply as applyExecutor, inject as executorInject } from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { AcpAdapter, BRIDGE_PATH } from '../src/host/adapter.js'
import { AGY_OFF_CHECKED, AGY_OFF_SKILLS_NAME, agyOffPaths } from '../src/host/agy-off.js'
import { Backchannel, signatureOf } from '../src/host/backchannel.js'
import { AGY, AGY_OFF_ARGS, agyWorld, approvalTeam, unixOnly } from './fixtures/agy-world.js'
import { answerGroup, groupApprovals } from '../../bots-dsh/src/client/approvals.js'
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
  assert.equal(h.adapter.historyWanted({ bridge: false }, 'no-role', 'acp-hermes'), false)
  assert.equal(h.adapter.historyWanted({ bridge: false }, 'no-role', AGY), true)
  assert.equal(h.adapter.historyWanted({ bridge: false }, 'no-role', AGY, true), false)
})

function agyHistory(t, nativeTools, options) {
  const h = agyWorld(t, options)
  const sessions = h.adapter.ctx.sessions = new Map()
  const chat = h.chat
  h.chat = id => {
    const opened = chat(id)
    sessions.set(opened.session.id, opened.session)
    return opened
  }
  h.service.botIdentity(() => ({ name: 'Fixture Bot', needsDshTools: true, nativeTools, nativeToolsAgent: AGY }))
  h.executed = []
  h.controls.body = () => 'synthetic marker [secret:fixture]'
  h.services.tools = {
    definitions: () => definitions,
    execute: t.mock.fn(async ({ calls: [call], agent, signal }) => {
      const exec = { agent, callId: call.id, name: call.name, signal }
      const body = () => h.execute(exec, async () => {
        h.executed.push(call)
        return { content: [{ type: 'text', text: await h.controls.body(call) }], isError: false }
      })
      const result = options?.team === undefined ? await body() : await fakeDshTool(h, exec, body)
      return { results: [{ result }] }
    }),
  }
  return h
}

// The pinned pipeline services an ask emitted by pre-execute, then runs post-execute for
// dispatch, deny and cancel. Its native request has no bridge fields.
async function fakeDshTool(h, exec, body) {
  const { agent, name, callId, signal } = exec
  const abort = { kind: 'deny', reason: 'tool call aborted before dispatch', info: { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' } }
  const deny = (reason, code) => ({ kind: 'deny', reason, info: { name: 'ApprovalError', code } })
  let decision = await h.preExecute(exec)
  if (decision.kind === 'ask') {
    const outcome = await h.services.approval.request({ agent, toolName: name, callId,
      reason: decision.reason, displayReason: decision.displayReason, signal })
    if (outcome === 'allowed-once') decision = { kind: 'allow' }
    else if (outcome === 'rejected') decision = deny(`the user rejected tool "${name}"`, 'APPROVAL_REJECTED')
    else if (outcome === 'cancelled') decision = signal.aborted ? abort : deny(`approval for tool "${name}" was cancelled`, 'APPROVAL_CANCELLED')
    else decision = deny(`tool "${name}" requires approval, but no approval channel is available`, 'APPROVAL_UNAVAILABLE')
  }
  if (decision.kind === 'cancel' || (decision.kind === 'allow' && signal.aborted)) decision = abort
  const result = decision.kind === 'allow' ? await body() : {
    content: [{ type: 'text', text: `Error: ${decision.reason}` }], isError: true, error: { info: decision.info },
  }
  const post = await h.postExecute(exec, result)
  return post.kind === 'block' ? { content: post.feedback, isError: true, error: { info: post.info } }
    : { ...result, content: post.content ?? result.content }
}

function agySkills(h, available = () => true) {
  h.services.omniTeam = { skillCalls: { available, catalog: () => undefined, project: options => options, admit() {} } }
}

const textOf = chunks => chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
const toolBlocks = chunks => chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')

test('D1 Antigravity ON lists history on dsh and keeps the exact-pair control', { ...unixOnly, timeout: 15_000 }, async t => {
  const h = agyHistory(t, true)
  agySkills(h, id => id === 'with-skills')
  const chat = h.chat()
  const row = h.adapter.agents.get(AGY)
  const order = []
  const spawn = row.spawn
  t.mock.method(row, 'spawn', options => {
    const launch = spawn(options)
    const agyReady = launch.agyReady
    return { ...launch, agyReady: async run => { await agyReady(run); order.push('agyReady') } }
  })
  const ready = h.adapter.ready
  t.mock.method(h.adapter, 'ready', async (agent, live) => {
    order.push('ready')
    await ready.call(h.adapter, agent, live)
  })

  const masked = { type: 'text', text: 'synthetic marker [secret:fixture]' }
  h.services.tools.execute.mock.mockImplementation(async () => ({
    results: [{ result: { content: [masked], isError: false } }],
  }))
  const bridge = h.adapter.backchannel
  const call = bridge.call
  const duplicates = []
  t.mock.method(bridge, 'call', async (record, request) => {
    const result = await call.call(bridge, record, request)
    if (request.arguments.query === 'correlated' && result.isError === false) {
      duplicates.push(await call.call(bridge, record, request))
    }
    return result
  })

  const chunks = await chat.turn('agy-bridge read_own_chat {"query":"correlated"}')
  const { args, pid } = h.conversation('"correlated"')
  assert.deepEqual(h.events('new-session').filter(event => event.pid === pid).map(event => event.servers), [['dsh']])
  assert.deepEqual(h.events('mcp-list').map(({ server, tools }) => [server, tools]), [['dsh', [HISTORY]]])
  assert.deepEqual(args, ['acp'])
  assert.deepEqual(order, ['agyReady', 'ready'])
  assert.equal(chunks.at(-1)?.reason.kind, 'stop')
  const [read] = h.events('mcp-history-result')
  assert.deepEqual(read.answer, { content: [masked], isError: false })
  assert.match(textOf(chunks), /synthetic marker \[secret:fixture\]/)
  assert.deepEqual(h.events('permission-answer').map(event => event.answer), [{ outcome: 'selected', optionId: 'agy-allow' }])
  assert.deepEqual(h.approvals.map(({ toolName, callId }) => [toolName, callId]), [[HISTORY, read.toolCallId]])
  assert.deepEqual(toolBlocks(chunks), [])
  assert.deepEqual(duplicates.map(result => result.error?.code), ['BRIDGE_CANCELLED'])
  assert.equal(h.services.tools.execute.mock.callCount(), 1)

  const live = h.adapter.live.get(chat.session.id)
  const verified = live.run.tools.get(read.toolCallId)
  assert.equal(verified.structuredName, 'mcp_dsh_read_own_chat')
  assert.equal(verified.skillOperation, HISTORY)
  assert.equal(verified.skillPrompt.aborted, true)

  const onUpdate = live.run.onUpdate
  const bindings = []
  t.mock.method(live.run, 'onUpdate', async (update, sessionId) => {
    if (update.sessionUpdate === 'tool_call') bindings.push(live.run.restrictedCall(read.toolCallId, HISTORY, live.run.historySignal))
    return onUpdate.call(live.run, update, sessionId)
  })
  const missing = await chat.turn('agy-bridge-without-id read_own_chat {"query":"missing"}')
  assert.deepEqual(bindings, [undefined])
  assert.equal(h.events('permission-answer').at(-1)?.answer.optionId, 'agy-allow')
  assert.deepEqual(h.events('mcp-history-result').at(-1)?.answer, { content: [masked], isError: false })
  assert.match(textOf(missing), /synthetic marker \[secret:fixture\]/)
  assert.equal(h.services.tools.execute.mock.callCount(), 2)
  assert.deepEqual(h.approvals.map(request => request.toolName), [HISTORY, HISTORY])

  const native = await chat.turn('native-read')
  assert.deepEqual(h.events('native-tool-ran').map(event => event.name), ['Read'])
  assert.deepEqual(toolBlocks(native).map(chunk => chunk.block.name), ['acp_tool'])
  assert.equal(h.adapter.live.get(chat.session.id), live)

  const withSkills = await h.chat('with-skills').turn('plain with automatic skills')
  assert.equal(withSkills.at(-1)?.reason.kind, 'stop')
  const skillPid = h.conversation('plain with automatic skills').pid
  assert.deepEqual(h.events('new-session').filter(event => event.pid === skillPid).map(event => event.servers), [['dsh']])
  assert.deepEqual(h.events('mcp-list').map(event => event.tools), [[HISTORY], [HISTORY, SKILL]])
})

test('D1b Antigravity ON stops before its first prompt if the bridge never lists', { ...unixOnly, timeout: 15_000 }, async t => {
  const h = agyHistory(t, true, { env: { FAKE_ACP_SKIP_MCP: '1' } })
  h.adapter.agents.get(AGY).bridgeReadyMs = 50
  const chunks = await h.chat().turn('plain readiness control')
  assert.equal(chunks.at(-1)?.reason.failure?.code, 'acp_bridge_missing')
  assert.deepEqual(h.events('new-session').at(-1)?.servers, ['dsh'])
  assert.deepEqual(h.events('mcp-list'), [])
  assert.deepEqual(h.events('prompt'), [])
  assert.equal(h.services.tools.execute.mock.callCount(), 0)
})

test('D1 Stop discards a pending Antigravity history result', { ...unixOnly, timeout: 15_000 }, async t => {
  const h = agyHistory(t, true)
  const chat = h.chat()
  const entered = Promise.withResolvers()
  const finished = Promise.withResolvers()
  const stop = new AbortController()
  const bridge = h.adapter.backchannel
  const call = bridge.call
  const stoppedLine = 'synthetic stopped history'
  t.mock.method(bridge, 'call', async (record, request) => {
    const result = await call.call(bridge, record, request)
    finished.resolve(result)
    return result
  })
  h.services.tools.execute.mock.mockImplementation(async ({ signal }) => {
    entered.resolve(signal)
    if (!signal.aborted) await once(signal, 'abort')
    return { results: [{ result: { content: [{ type: 'text', text: stoppedLine }], isError: false } }] }
  })
  const launch = await chat.turn('plain stop control')
  assert.equal(launch.at(-1)?.reason.kind, 'stop')
  assert.deepEqual(h.events('mcp-list').map(event => event.tools), [[HISTORY]])
  const pending = chat.turn('agy-bridge read_own_chat {"query":"stop"}', [], stop.signal)
  try {
    const signal = await soon(entered.promise)
    stop.abort()
    const result = await soon(finished.promise)
    assert.equal(signal.aborted, true)
    assert.doesNotMatch(JSON.stringify(result), /synthetic stopped history/)
  } finally {
    stop.abort()
    await pending
  }
  const chunks = await pending
  assert.equal(chunks.at(-1)?.reason.kind, 'aborted')
  assert.doesNotMatch(JSON.stringify([chunks, chat.session.snapshotEvents(), h.events('mcp-history-result')]), /synthetic stopped history/)
  assert.equal(h.approvals.length, 1)
  assert.equal(h.requests.length, 1)
  assert.equal(h.services.tools.execute.mock.callCount(), 1)
})

for (const verified of [true, false]) {
  test(`D2 eligible Antigravity OFF stays silent with ${verified ? 'verified' : 'unverified'} Skills`, { ...unixOnly, timeout: 15_000 }, async t => {
    const agySkillsVersions = []
    const h = agyHistory(t, false, { registry: 'eager', version: AGY_OFF_CHECKED, deps: { agySkillsVersions } })
    if (verified) agySkillsVersions.push({ version: AGY_OFF_CHECKED, sha256: createHash('sha256').update(readFileSync(h.agy)).digest('hex') })
    agySkills(h)
    const chat = h.chat()
    const chunks = await chat.turn('plain eligible OFF control')
    assert.equal(chunks.at(-1)?.reason.kind, 'stop')
    assert.doesNotMatch(textOf(chunks), /history|read_own_chat|tried to use a tool/i)
    const { args, pid } = h.conversation('plain eligible OFF control')
    assert.deepEqual(h.events('new-session').filter(event => event.pid === pid).map(event => event.servers), [verified ? ['dsh'] : []])
    const record = h.adapter.live.get(chat.session.id).bridge
    if (verified) {
      assert.deepEqual(args, ['acp', '--agent', AGY_OFF_SKILLS_NAME, '--cli_dir_name', AGY_OFF_SKILLS_NAME])
      assert.deepEqual(h.events('mcp-list').map(event => event.tools), [[SKILL]])
      assert.deepEqual(h.events('registry').map(event => event.registry), [['mcp_dsh_load_skill']])
      const paths = agyOffPaths(h.home(), AGY_OFF_SKILLS_NAME)
      assert.match(readFileSync(paths.agentFile, 'utf8'), /^tools: \["mcp_dsh_load_skill"\]$/m)
      assert.deepEqual(JSON.parse(readFileSync(paths.settingsFile, 'utf8')).permissions.allow, ['mcp(dsh/load_skill)'])
      assert.equal((await h.adapter.backchannel.call(record, { name: HISTORY })).isError, true)
    } else {
      assert.deepEqual(args, AGY_OFF_ARGS)
      assert.deepEqual(h.events('mcp-list'), [])
      assert.equal(record, undefined)
    }
    assert.deepEqual(h.logs.filter(line => /history|read_own_chat|tried to use a tool/i.test(line)), [])
    assert.equal(h.services.tools.execute.mock.callCount(), 0)
    assert.deepEqual(h.approvals, [])
  })
}

const agyTest = { ...unixOnly, timeout: 15_000 }
const agyRequest = (...steps) => `agy-real ${JSON.stringify(steps)}`
const agyAllow = { outcome: 'selected', optionId: 'agy-allow' }
const maskedLine = 'synthetic marker [secret:fixture]'

function openAgyHistory(h) {
  const chat = h.chat()
  chat.session.append('request/header', { header: { config: { provider: AGY, model: 'default' }, tools: definitions }, reason: 'initial' })
  return chat
}

function observeAgyBridge(t, h, beforeCall) {
  const calls = []
  const bridge = h.adapter.backchannel
  const call = bridge.call
  t.mock.method(bridge, 'call', async (record, request) => {
    beforeCall?.(record, request)
    const observation = { request, pending: h.approvals.length, permission: h.events('permission-answer').at(-1)?.answer,
      claim: h.adapter.live.get(record.sessionId)?.run.restrictedClaim?.(request.callId) }
    calls.push(observation)
    const result = await call.call(bridge, record, request)
    observation.result = result
    return result
  })
  return calls
}

const callRows = session => session.snapshotEvents().filter(row => row.type === 'tool/call' && row.data.name === HISTORY)
const resultRows = session => session.snapshotEvents().filter(row => row.type === 'tool/result' &&
  callRows(session).some(call => call.data.callId === row.data.message.toolCallId))

function assertAgyRead(chunks, h, approvals) {
  assert.deepEqual(toolBlocks(chunks), [], 'the ACP request must raise no mirror')
  assert.equal(chunks.at(-1)?.reason.kind, 'stop')
  assert.deepEqual(h.approvals.map(request => request.toolName), Array(approvals).fill(HISTORY))
  assert.equal(textOf(chunks).split(maskedLine).length - 1, 1)
  assert.equal(h.executed.length, 1)
}

for (const level of ['workspace', 'manual']) {
  for (const [label, meta] of [['T1 matching', 'matching'], ['T2 absent', undefined], ['T3 rejection', undefined]]) {
    test(`D2d ${label} at ${level}`, agyTest, async t => {
      const h = agyHistory(t, true, { level })
      const chat = openAgyHistory(h)
      const observed = observeAgyBridge(t, h)
      const rejected = label.startsWith('T3')
      if (rejected) h.controls.ask = () => 'rejected'
      const chunks = await chat.turn(agyRequest({ query: label, meta, includeQuery: meta !== undefined }))
      assert.deepEqual(toolBlocks(chunks), [], 'the ACP request must raise no mirror')
      assert.equal(chunks.at(-1)?.reason.kind, 'stop')
      assert.deepEqual(observed.map(({ pending, permission }) => [pending, permission]), [[0, agyAllow]])
      assert.deepEqual(h.approvals.map(request => request.toolName), [HISTORY])
      const [result] = resultRows(chat.session)
      assert.equal(resultRows(chat.session).length, 1)
      if (rejected) {
        assert.deepEqual(result.data.error, { name: 'ApprovalDeniedError', code: 'REJECTED' })
        assert.deepEqual(observed[0].result.error, result.data.error)
        assert.equal(h.executed.length, 0)
        const [wire] = h.events('agy-real-result')
        assert.equal(wire.answer.isError, true)
        assert.deepEqual(wire.answer.content, observed[0].result.content)
        assert.doesNotMatch(JSON.stringify([wire, result, chunks]), /synthetic marker/)
      } else {
        assertAgyRead(chunks, h, 1)
        assert.deepEqual(h.events('agy-real-result').map(row => row.answer), [{ content: [{ type: 'text', text: maskedLine }], isError: false }])
        assert.equal(result.data.error, undefined)
        assert.equal(h.adapter.live.get(chat.session.id).bridge.approvalCalls.size, 0)
      }
    })
  }

  test(`D2d T1 duplicate MCP requests ask separately at ${level}`, agyTest, async t => {
    const h = agyHistory(t, true, { level })
    const chat = openAgyHistory(h)
    const calls = observeAgyBridge(t, h)
    const chunks = await chat.turn(agyRequest({ query: 'duplicate', meta: 'matching', retry: true }))
    assert.deepEqual(toolBlocks(chunks), [])
    assert.equal(h.events('permission-answer').length, 1)
    assert.equal(calls.length, 2)
    assert.equal(calls[0].request.callId, calls[1].request.callId)
    assert.deepEqual(h.approvals.map(request => request.toolName), [HISTORY, HISTORY])
    assert.deepEqual(h.events('agy-real-result').map(({ answer }) => answer.content[0].text), [maskedLine, maskedLine])
    assert.equal(h.executed.length, 2)
    assert.equal(resultRows(chat.session).length, 2)
  })
}

test('D2d T4a an unseen MCP id keeps its own card and row', agyTest, async t => {
  const h = agyHistory(t, true)
  const chat = openAgyHistory(h)
  const observed = observeAgyBridge(t, h)
  const chunks = await chat.turn(agyRequest({ query: 'unseen', meta: 'mcp-unseen-1', permission: false }))
  assertAgyRead(chunks, h, 1)
  assert.equal(observed[0].claim, 'unknown')
  assert.equal(h.approvals[0].callId, 'mcp-unseen-1')
  assert.equal(resultRows(chat.session)[0].data.message.toolCallId, 'mcp-unseen-1')
})

const cancelledHistory = { content: [], isError: true,
  error: { name: 'BridgeCancelledError', code: 'BRIDGE_CANCELLED' } }
const emptyMcpReply = { content: [{ type: 'text', text: '' }], isError: true }

test('AD2T-1 verified unbound operation conflict leaves an unknown id independent', agyTest, async t => {
  const h = agyHistory(t, true)
  agySkills(h)
  const chat = openAgyHistory(h)
  const mismatch = 'synthetic-skill-id'
  const unknown = 'synthetic-unseen-id'
  let seeded
  const observed = observeAgyBridge(t, h, (record, request) => {
    if (request.callId !== mismatch) return
    const { run } = h.adapter.live.get(record.sessionId)
    // Seed only the verified identity. No ACP prompt owned this synthetic Skills claim.
    const tool = { id: mismatch }
    run.markCall(tool, { name: 'mcp__dsh__load_skill' }, run.sessionId)
    run.tools.set(mismatch, tool)
    seeded = { operation: tool.skillOperation, prompt: tool.skillPrompt, bridge: tool.skillBridge }
  })
  const chunks = await chat.turn(agyRequest(
    { query: 'wrong operation', meta: mismatch, permission: false },
    { query: 'independent history', meta: unknown, permission: false }))
  const { run } = h.adapter.live.get(chat.session.id)
  const wire = h.events('agy-real-result').map(({ answer }) => answer)
  const allowed = { content: [{ type: 'text', text: maskedLine }], isError: false }
  assert.deepEqual(seeded, { operation: SKILL, prompt: undefined, bridge: true })
  assert.deepEqual(observed.map(({ claim }) => claim), ['live', 'unknown'])
  assert.deepEqual({
    mismatchClaim: run.restrictedClaim(mismatch),
    approvals: h.approvals.map(({ callId }) => callId),
    bodies: h.executed.map(({ id }) => id),
    replies: observed.map(({ result }) => result),
    wire,
    rows: callRows(chat.session).map(({ data }) => data.callId),
  }, {
    mismatchClaim: 'conflict',
    approvals: [unknown],
    bodies: [unknown],
    replies: [cancelledHistory, allowed],
    wire: [emptyMcpReply, allowed],
    rows: [unknown],
  })
  assertAgyRead(chunks, h, 1)
})

test('AD2T-1 verifies registered Session identity before approval and release', agyTest, async t => {
  for (const loss of ['unavailable lookup', 'missing Session', 'mismatched Session']) {
    for (const beforeRelease of [false, true]) {
      await t.test(`${loss} before ${beforeRelease ? 'release' : 'approval'}`, async t => {
        const h = agyHistory(t, true)
        const chat = openAgyHistory(h)
        const { ctx } = h.adapter
        const callId = 'synthetic-session-check'
        const loseRegistration = () => {
          if (loss === 'unavailable lookup') ctx.sessions = undefined
          else if (loss === 'missing Session') ctx.sessions.delete(chat.session.id)
          else ctx.sessions.set(chat.session.id, Session.create(chat.session.id))
        }
        let registered
        const observed = observeAgyBridge(t, h, (record, request) => {
          if (request.callId !== callId) return
          registered = ctx.sessions.get(record.sessionId)
          if (!beforeRelease) loseRegistration()
        })
        h.controls.body = () => {
          if (beforeRelease) loseRegistration()
          return maskedLine
        }
        const chunks = await chat.turn(agyRequest({ query: 'Session check', meta: callId, permission: false }))
        assert.equal(registered, chat.session)
        assert.equal(h.adapter.live.get(chat.session.id).dshAgent.session, chat.session)
        const expectedCalls = beforeRelease ? [callId] : []
        assert.deepEqual({
          approvals: h.approvals.map(request => request.callId),
          bodies: h.executed.map(call => call.id),
          replies: observed.map(({ result }) => result),
          wire: h.events('agy-real-result').map(({ answer }) => answer),
          rowErrors: resultRows(chat.session).map(({ data }) => data.error),
        }, {
          approvals: expectedCalls,
          bodies: expectedCalls,
          replies: [cancelledHistory],
          wire: [emptyMcpReply],
          rowErrors: beforeRelease ? [cancelledHistory.error] : [],
        })
        assert.doesNotMatch(JSON.stringify([chunks, chat.session.snapshotEvents()]), /synthetic marker/)
      })
    }
  }
})

for (const [label, claim] of [['T4b', 'retired'], ['T4c', 'conflict']]) {
  test(`D2d ${label} refuses a ${claim} id before the card`, agyTest, async t => {
    const h = agyHistory(t, true)
    const chat = openAgyHistory(h)
    const observed = observeAgyBridge(t, h)
    let request = { query: 'conflicting', meta: 'matching', conflicting: true }
    if (claim === 'retired') {
      await chat.turn('agy-bridge read_own_chat {"query":"seed"}')
      request = { query: 'retired', meta: h.events('mcp-history-result')[0].toolCallId, permission: false }
      h.executed.length = h.approvals.length = h.requests.length = 0
    }
    const chunks = await chat.turn(agyRequest(request))
    const last = observed.at(-1)
    assert.deepEqual(toolBlocks(chunks), [])
    assert.equal(h.adapter.live.get(chat.session.id).run.spec.refuseTools, undefined)
    if (request.conflicting) assert.notEqual(last?.permission?.optionId, 'agy-allow')
    assert.deepEqual(last?.result, { content: [], isError: true,
      error: { name: 'BridgeCancelledError', code: 'BRIDGE_CANCELLED' } })
    assert.deepEqual(h.approvals, [])
    assert.deepEqual(h.executed, [])
    assert.equal(last.claim, claim)
    assert.equal(h.adapter.live.get(chat.session.id).run.restrictedClaim(last.request.callId), claim)
  })
}

for (const conflicting of [true, false]) {
  test(`D2d T4d ${conflicting ? 'conflicting' : 'rejected'} X leaves Y independently approvable`, agyTest, async t => {
    const h = agyHistory(t, true)
    const chat = openAgyHistory(h)
    const observed = observeAgyBridge(t, h)
    if (!conflicting) h.controls.ask = () => h.approvals.length === 1 ? 'rejected' : 'allowed-once'
    const chunks = await chat.turn(agyRequest({ query: 'X', meta: 'matching', conflicting }, { query: 'Y' }))
    assert.deepEqual(toolBlocks(chunks), [])
    assert.deepEqual(observed.map(({ result }) => result.error?.code), [conflicting ? 'BRIDGE_CANCELLED' : 'REJECTED', undefined])
    assert.deepEqual(h.approvals.map(request => request.toolName), conflicting ? [HISTORY] : [HISTORY, HISTORY])
    assert.deepEqual(h.executed.map(call => JSON.parse(call.arguments).query), ['Y'])
    assert.equal(textOf(chunks).split(maskedLine).length, 2)
  })
}

test('D2d T4e a history grant leaves unbound Skills refused on the same bridge', agyTest, async t => {
  const h = agyHistory(t, true)
  agySkills(h)
  const chat = openAgyHistory(h)
  const observed = observeAgyBridge(t, h)
  await chat.turn('agy-bridge read_own_chat {"query":"seed"}')
  assert.deepEqual(h.events('mcp-list').map(row => row.tools), [[HISTORY, SKILL]])
  assert.equal(observed[0].result.isError, false)
  const record = h.adapter.live.get(chat.session.id).bridge
  const chunks = await chat.turn(agyRequest(
    { operation: SKILL, query: 'missing', permission: false },
    { operation: SKILL, query: 'unknown', meta: 'mcp-unseen-skill', permission: false }))
  assert.equal(h.adapter.live.get(chat.session.id).bridge, record)
  assert.deepEqual(observed.slice(1).map(({ result }) => [result.error?.code, result.content]), [
    ['BRIDGE_CANCELLED', []], ['BRIDGE_CANCELLED', []],
  ])
  assert.deepEqual(h.executed.map(call => call.name), [HISTORY])
  assert.deepEqual(h.approvals.map(request => request.toolName), [HISTORY])
  assert.doesNotMatch(textOf(chunks), /synthetic marker/)
})

for (const changed of ['Session', 'provider row']) {
  test(`D2d T4f replacing the ${changed} with a result pending withholds history`, agyTest, async t => {
    const h = agyHistory(t, true)
    const chat = openAgyHistory(h)
    const observed = observeAgyBridge(t, h)
    h.controls.body = () => {
      const live = h.adapter.live.get(chat.session.id)
      if (changed === 'Session') live.dshAgent.session = Session.create(chat.session.id)
      else h.adapter.agents.set(AGY, { ...live.providerRow })
      return maskedLine
    }
    const chunks = await chat.turn('agy-bridge read_own_chat {"query":"replace"}')
    assert.deepEqual(h.approvals.map(request => request.toolName), [HISTORY])
    assert.equal(h.executed.length, 1)
    assert.deepEqual(observed.map(({ result }) => [result.error?.code, result.content]), [['BRIDGE_CANCELLED', []]])
    assert.doesNotMatch(JSON.stringify([chunks, chat.session.snapshotEvents(), h.events('mcp-history-result')]), /synthetic marker/)
  })
}

test('D2d T4f omp still refuses an unknown id', async t => {
  const h = await combined(t)
  const end = h.p.begin()
  try {
    assert.equal((await h.call('mcp-unseen-omp')).isError, true)
    assert.deepEqual(h.executed, [])
    assert.deepEqual(h.requests, [])
  } finally { await end() }
})

for (const started of [false, true]) {
  test(`D2d ${started ? 'T5b Stop while the body waits' : 'T5a Stop while the card waits'}`, agyTest, async t => {
    const h = agyHistory(t, true)
    const chat = openAgyHistory(h)
    const observed = observeAgyBridge(t, h)
    const waiting = Promise.withResolvers()
    const held = Promise.withResolvers()
    if (started) h.controls.body = () => { waiting.resolve(); return held.promise }
    else h.controls.ask = () => {
      waiting.resolve()
      return held.promise
    }
    assert.equal((await chat.turn('plain Stop setup')).at(-1)?.reason.kind, 'stop')
    const stop = new AbortController()
    const pending = chat.turn(agyRequest({ query: 'stop' }), [], stop.signal)
    try {
      const reached = await soon(Promise.race([waiting.promise.then(() => true), pending.then(() => false)]))
      assert.equal(reached, true, 'the bridge card or its approved body must be reached')
      assert.deepEqual(observed.map(({ pending, permission }) => [pending, permission]), [[0, agyAllow]])
      assert.deepEqual(h.approvals.map(request => request.toolName), [HISTORY])
      stop.abort()
      assert.equal(h.approvals[0].signal.aborted, true)
      for (let tries = 0; tries < 100 && h.events('mcp-call-cancelled').length === 0; tries++) await delay(10)
      assert.equal(h.events('mcp-call-cancelled').length, 1)
      // Let the real MCP cancellation close the HTTP request before the held layer settles.
      const { signal } = observed[0].request
      if (!signal.aborted) await soon(once(signal, 'abort'))
    } finally {
      stop.abort()
      held.resolve(started ? maskedLine : 'cancelled')
      await pending
    }
    for (let tries = 0; tries < 100 && observed[0]?.result === undefined; tries++) await delay(10)
    assert.equal(h.approvals[0].signal.aborted, true)
    assert.equal(h.executed.length, started ? 1 : 0)
    const [result] = resultRows(chat.session)
    const cancelled = { name: 'BridgeCancelledError', code: 'BRIDGE_CANCELLED' }
    assert.deepEqual(observed[0].result, { content: [], isError: true, error: cancelled })
    assert.deepEqual(result?.data.error, cancelled)
    assert.equal((await pending).at(-1)?.reason.kind, 'aborted')
    assert.deepEqual(h.events('agy-real-result'), [])
    assert.deepEqual(h.events('mcp-cancelled-reply'), [])
    assert.doesNotMatch(JSON.stringify([chat.session.snapshotEvents(), h.events()]), /synthetic marker/)
  })
}

for (const level of ['auto', 'full']) {
  test(`D2d ${level} allows one Antigravity ON read without a personal card`, agyTest, async t => {
    const h = agyHistory(t, true, { level })
    const chat = openAgyHistory(h)
    const reviewed = []
    if (level === 'auto') h.onExecute((call, next) => { reviewed.push(call.name); return next() })
    const chunks = await chat.turn(agyRequest({ query: level }))
    assertAgyRead(chunks, h, 0)
    assert.deepEqual(reviewed, level === 'auto' ? [HISTORY] : [])
    assert.equal(resultRows(chat.session).length, 1)
  })
}

test('D2d Auto refusal reaches the reviewer and never invokes the history body', agyTest, async t => {
  const h = agyHistory(t, true, { level: 'auto' })
  const chat = openAgyHistory(h)
  const reviewed = []
  h.onExecute(call => {
    reviewed.push(call.name)
    return { content: [{ type: 'text', text: 'Fixture reviewer refused.' }], isError: true }
  })
  const chunks = await chat.turn('agy-bridge read_own_chat {"query":"review reject"}')
  assert.deepEqual(reviewed, [HISTORY])
  assert.deepEqual(h.executed, [])
  assert.deepEqual(h.approvals, [])
  assert.equal(h.events('mcp-history-result')[0].answer.isError, true)
  assert.match(textOf(chunks), /Fixture reviewer refused/)
  assert.doesNotMatch(JSON.stringify(chat.session.snapshotEvents()), /synthetic marker/)
})

const noCardCase = 'D2d no-card amendment'
const productionOrder = ['review-guard', 'auto-judge', 'grants', 'pocket-chat', 'approvals']
// dsh-experimental-auto-review's askUser result and localized presentation.
const askOnDenial = {
  kind: 'ask', reason: 'Auto review denied tool "read_own_chat": fixture decision',
  displayReason: {
    en: 'Auto review denied this call: fixture decision',
    zh: 'Auto review 拒绝了此调用：fixture decision',
    ja: '自動認可レビューがこの呼び出しを拒否しました：fixture decision',
    es: 'Auto review ha denegado esta llamada: fixture decision',
    fr: 'Auto review a refusé cet appel : fixture decision',
    de: 'Auto review hat diesen Aufruf abgelehnt: fixture decision',
    ru: 'Auto review отклонила этот вызов: fixture decision',
    pt: 'Auto review negou esta chamada: fixture decision',
  },
}

async function ownedAgyHistory(t, options) {
  const team = await approvalTeam(t, options)
  const h = agyHistory(t, true, { team })
  const chat = openAgyHistory(h)
  return { h, team, chat }
}

function approvalRows(session, callId) {
  const rows = session.snapshotEvents()
  const asks = rows.filter(row => row.type === 'approval/asked' && row.data.callId === callId)
  assert.equal(asks.length, 1, `one ask for ${callId}`)
  const [ask] = asks
  const decisions = rows.filter(row => row.type === 'approval/decided' && row.data.id === ask.data.id)
  assert.equal(decisions.length, 1, `one decision for ${callId}`)
  const results = rows.filter(row => row.type === 'tool/result' && row.data.message.toolCallId === callId)
  assert.equal(results.length, 1, `one result for ${callId}`)
  return { outcome: decisions[0].data.outcome, result: results[0].data }
}

function assertCard(h, team, session, entry, outcome, decidedBy, bodies) {
  assert.equal(entry.sessionId, session.id)
  assert.equal(entry.tool, HISTORY)
  assert.equal(entry.answerable, true)
  const matches = team.settled.filter(settlement => settlement.id === entry.id)
  assert.deepEqual(matches.map(row => [row.outcome, row.decidedBy]), [[outcome, decidedBy]])
  assert.equal(h.executed.filter(call => call.id === entry.callId).length, bodies)
  const rows = approvalRows(session, entry.callId)
  assert.equal(rows.outcome, outcome)
  return rows.result
}

test(`${noCardCase} N1/R2: the owned Workspace read reaches a real card in production order`, agyTest, async t => {
  const { h, team, chat } = await ownedAgyHistory(t)
  const chunks = await chat.turn(agyRequest({ query: 'N1' }))
  t.diagnostic(`requests=${h.requests.length} cards=${h.approvals.length} answerer=${team.terminal.length} bodies=${h.executed.length}`)
  assert.equal(h.requests.length, 1)
  const [request] = h.requests
  assert.deepEqual(team.order.get(request.callId), productionOrder)
  assert.equal(h.approvals.length, 1, 'the real team card opens')
  assert.deepEqual(team.terminal, [request.callId], 'the DSH card decides')
  const result = assertCard(h, team, chat.session, h.approvals[0], 'allowed-once', 'dsh', 1)
  assert.match(JSON.stringify(result.message), /synthetic marker \[secret:fixture\]/)
  assert.equal(textOf(chunks).split(maskedLine).length - 1, 1)
  assert.deepEqual(toolBlocks(chunks), [], 'the ACP mirror does not ask again')
  assert.deepEqual(team.rt.approvalsView(), [])
})

test(`${noCardCase} N2: the Manual card refuses before the body`, agyTest, async t => {
  const { h, team, chat } = await ownedAgyHistory(t, { level: 'manual' })
  h.controls.ask = () => 'rejected'
  const chunks = await chat.turn(agyRequest({ query: 'N2' }))
  const [result] = resultRows(chat.session)
  assert.deepEqual(result?.data.error, { name: 'ApprovalDeniedError', code: 'REJECTED' })
  assert.equal(h.approvals.length, 1)
  assertCard(h, team, chat.session, h.approvals[0], 'rejected', 'dsh', 0)
  assert.doesNotMatch(JSON.stringify([chunks, chat.session.snapshotEvents()]), /synthetic marker/)
  assert.equal(chunks.at(-1)?.reason.kind, 'stop')
})

test(`${noCardCase} N3: only the Antigravity ON history request carries the marker`, agyTest, async t => {
  const { h, chat } = await ownedAgyHistory(t)
  agySkills(h)
  await chat.turn(agyRequest({ query: 'N3' }, { operation: SKILL, query: 'fixture skill', meta: 'matching' }))
  assert.deepEqual(h.requests.map(request => [request.toolName, request.bridgeCall?.personDecides]), [
    [HISTORY, true], [SKILL, undefined],
  ])
  assert.deepEqual(h.approvals.map(entry => entry.tool), [HISTORY, SKILL])
})

test(`${noCardCase} ANC-1: identical simultaneous reads have independently answerable cards`, agyTest, async t => {
  const { h, team, chat } = await ownedAgyHistory(t)
  const ready = Promise.withResolvers()
  const hold = Promise.withResolvers()
  h.controls.ask = () => {
    if (team.terminal.length === 2) ready.resolve(true)
    return hold.promise
  }
  const turn = chat.turn('agy-real-parallel [{"query":"x"},{"query":"x"}]')
  try {
    const bothOpen = await soon(Promise.race([ready.promise, turn.then(() => false)]))
    t.diagnostic(`requests=${h.requests.length} cards=${h.approvals.length} bodies before answering=${h.executed.length}`)
    assert.equal(bothOpen, true, 'two visible reads wait together')
    assert.deepEqual(callRows(chat.session).map(row => JSON.parse(row.data.arguments)), [{ query: 'x' }, { query: 'x' }])
    for (const entry of h.approvals) assert.ok(team.rt.callCapability(chat.session.id, entry.callId, HISTORY))
    assert.ok(h.approvals.every(entry => entry.capabilityKey === undefined))
    const groups = groupApprovals(h.approvals)
    assert.equal(groups.length, 2)
    const [first, second] = h.approvals
    const answer = (group, choice) => answerGroup(group.entries, choice, {
      actions: { answerApproval: (id, value) => team.rt.answerApproval(id, value) }, statusMap: new Map(),
    })
    assert.deepEqual(await answer(groups[0], 'allow'), { answered: 1, skipped: 0 })
    assert.deepEqual(team.rt.approvalsView().map(entry => entry.id), [second.id])
    assert.deepEqual(team.settled.map(entry => entry.id), [first.id])
    assert.deepEqual(await answer(groups[1], 'reject'), { answered: 1, skipped: 0 })
    const chunks = await turn
    assert.equal(textOf(chunks).split(maskedLine).length - 1, 1)
    assertCard(h, team, chat.session, first, 'allowed-once', 'web', 1)
    const refused = assertCard(h, team, chat.session, second, 'rejected', 'web', 0)
    assert.deepEqual(refused.error, { name: 'ApprovalDeniedError', code: 'REJECTED' })
    assert.doesNotMatch(JSON.stringify(refused.message), /synthetic marker/)
  } finally {
    hold.resolve('cancelled')
    await turn
  }
})

for (const reviewer of ['allow', 'deny', 'failure']) {
  test(`${noCardCase} Bot Auto ${reviewer}`, agyTest, async t => {
    const { h, team, chat } = await ownedAgyHistory(t, { botAuto: true, reviewer })
    h.controls.ask = () => 'rejected'
    const chunks = await chat.turn(agyRequest({ query: 'Bot Auto' }))
    assert.equal(team.reviewers.length, 1, 'the Bot Auto reviewer receives the bridge read')
    assert.equal(h.requests.length, 1)
    const [request] = h.requests
    const { outcome, result } = approvalRows(chat.session, request.callId)
    assert.equal(outcome, reviewer === 'allow' ? 'allowed-once' : 'rejected')
    assert.equal(h.executed.length, reviewer === 'allow' ? 1 : 0)
    assert.equal(h.approvals.length, reviewer === 'failure' ? 1 : 0)
    assert.equal(team.terminal.length, reviewer === 'failure' ? 1 : 0)
    if (reviewer === 'failure') assertCard(h, team, chat.session, h.approvals[0], 'rejected', 'dsh', 0)
    if (reviewer === 'deny') {
      assert.deepEqual(result.error, { name: 'ApprovalDeniedError', code: 'REJECTED' })
      assert.match(JSON.stringify(result.message), /Auto's judge refused.*fixture decision/)
    }
    assert.equal(textOf(chunks).includes(maskedLine), reviewer === 'allow')
  })
}

for (const answer of ['allow', 'reject', 'cancel live caller', 'cancel aborted caller']) {
  test(`${noCardCase} DSH Auto escalation: ${answer}`, agyTest, async t => {
    const { h, team, chat } = await ownedAgyHistory(t, { level: 'auto' })
    const dispose = h.adapter.ctx.on('tools/pre-execute', async (_exec, next) => {
      const policy = await next()
      return policy.kind === 'allow' ? askOnDenial : policy
    }, { prepend: true })
    t.after(dispose)
    const outcome = answer === 'allow' ? 'allowed-once' : answer === 'reject' ? 'rejected' : 'cancelled'
    h.controls.ask = () => {
      if (answer === 'cancel aborted caller') h.adapter.backchannel.cancel(h.adapter.live.get(chat.session.id).bridge)
      return outcome
    }
    const chunks = await chat.turn(agyRequest({ query: answer }))
    assert.equal(h.requests.length, 1)
    const [request] = h.requests
    const { result } = approvalRows(chat.session, request.callId)
    const error = {
      reject: { name: 'ApprovalError', code: 'APPROVAL_REJECTED' },
      'cancel live caller': { name: 'ApprovalError', code: 'APPROVAL_CANCELLED' },
      'cancel aborted caller': { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' },
    }[answer]
    assert.deepEqual(result.error, error, 'the bridge keeps the pinned pre-dispatch outcome')
    assert.equal(request.bridgeCall?.escalated, true, 'DSH did not mint an unmarked ask')
    assert.equal(request.bridgeCall.personDecides, true)
    assert.equal(request.reason, askOnDenial.reason)
    assert.deepEqual(request.displayReason, askOnDenial.displayReason)
    assert.equal(h.approvals.length, 1)
    assertCard(h, team, chat.session, h.approvals[0], outcome, 'dsh', answer === 'allow' ? 1 : 0)
    assert.equal(textOf(chunks).includes(maskedLine), answer === 'allow')
    assert.equal(team.reviewers.length, 0)
  })
}

for (const downstream of ['ask', 'deny']) {
  test(`${noCardCase} R1 Workspace keeps one decision with downstream ${downstream}`, agyTest, async t => {
    const { h, team, chat } = await ownedAgyHistory(t)
    const refusal = { name: 'FixturePolicyError', code: 'FIXTURE_DENIED' }
    const dispose = h.adapter.ctx.on('tools/pre-execute', () => downstream === 'ask' ? askOnDenial
      : { kind: 'deny', reason: 'Fixture policy refused.', info: refusal })
    t.after(dispose)
    await chat.turn(agyRequest({ query: downstream }))
    assert.equal(h.requests.length, 1)
    assert.equal(h.approvals.length, 1)
    const result = assertCard(h, team, chat.session, h.approvals[0], 'allowed-once', 'dsh', downstream === 'ask' ? 1 : 0)
    assert.deepEqual(result.error, downstream === 'deny' ? refusal : undefined)
  })
}

test(`${noCardCase} restack: restricted Antigravity ON replacement does not list after withdrawal`, agyTest, async t => {
  const h = agyHistory(t, true)
  const chat = openAgyHistory(h)
  await chat.turn('plain warm restricted Antigravity')
  const live = h.adapter.live.get(chat.session.id)
  const previous = live.bridge
  assert.deepEqual([...previous.only], [HISTORY])
  assert.equal(typeof previous.restrictedRequest, 'function')
  const announce = t.mock.method(h.adapter.backchannel, 'announce')
  let withdrew = false
  const newSession = live.run.conn.newSession.bind(live.run.conn)
  t.mock.method(live.run.conn, 'newSession', options => {
    withdrew = true
    return newSession(options)
  })
  const next = await h.adapter.refork(h.adapter.agents.get(AGY), live, live.dshAgent, undefined,
    { renew: true, checkAccount: () => !withdrew })
  assert.deepEqual([...next.only], [HISTORY])
  assert.deepEqual(h.events('mcp-list').map(row => row.tools), [[HISTORY], []])
  assert.equal(announce.mock.callCount(), 0)
  assert.equal(previous.closed, true)
  assert.equal(next.closed, true)
  assert.equal(next.listed, false)
  assert.equal(next.canList, undefined)
  assert.equal(live.checkReforkAccount, undefined)
  assert.deepEqual(h.executed, [])
})

for (const provider of [CLAUDE, 'acp-codex', OMP]) {
  test(`${noCardCase} card-free control: ${provider}`, agyTest, async t => {
    const team = await approvalTeam(t, { provider, level: 'manual' })
    const w = provider === CLAUDE ? nativeWorld(t) : provider === OMP ? omp(t)
      : codexWorld(t, { identity: () => ({ name: 'Fixture Bot' }), dshTools: true })
    if (provider === OMP) w.skills(true)
    w.services.approval.request = team.approval.request
    w.services.tools.definitions = () => definitions
    w.services.tools.executable = name => definitions.find(tool => tool.name === name)
    w.services.tools.execute = async () => {
      bodies++
      return { results: [{ result: { isError: false, content: [{ type: 'text', text: maskedLine }] } }] }
    }
    let bodies = 0
    const chat = w.chat(team.id)
    team.attach(chat.session)
    const chunks = await (provider === CLAUDE ? chat.turn(person('bridge-permit read_own_chat'), provider)
      : provider === OMP ? chat.turn('history-lookup omp fixture')
      : turnOn(w, chat, scheduled('codex-bridge read_own_chat {"query":"fixture"}')))
    assert.equal(chunks.at(-1)?.reason.kind, 'stop')
    const { bridge } = w.adapter.live.get(team.id)
    assert.equal(bridge.restrictedRequest, undefined)
    assert.deepEqual(bridge.only === undefined ? undefined : [...bridge.only], provider === OMP ? [SKILL, HISTORY] : undefined)
    assert.equal(team.requests.length, 1)
    const [request] = team.requests
    assert.equal(request.toolName, HISTORY)
    assert.deepEqual(request.bridgeCall, { agentAsked: bridge.agentAsked === true })
    assert.equal(approvalRows(chat.session, request.callId).outcome, 'allowed-once')
    assert.deepEqual(team.order.get(request.callId), productionOrder)
    assert.deepEqual(team.approvals, [])
    assert.deepEqual(team.terminal, [])
    assert.equal(bodies, 1)
  })
}

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

async function combined(t, { off = false, provider = OMP } = {}) {
  const only = new Set([HISTORY, SKILL])
  const h = world(t, { level: 'full', only })
  h.backchannel.revoke(h.record)
  const providerRow = { bridge: false }
  const adapter = new AcpAdapter(h.ctx, new Map([[provider, providerRow]]), {
    backchannel: h.backchannel, botIdentity: () => ({ needsDshTools: true }), dshTools: () => true,
  })
  t.after(() => adapter.dispose())
  h.ctx.sessions = new Map([[h.session.id, h.session]])
  const p = probe(t, { provider, skillBridge: true, skillTools: only, refuseTools: off })
  const live = { provider, providerRow, dshAgent: h.agent, session: h.session, run: p.run, open: true }
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

test('D1 the restricted ACP permission boundary retires a conflicting Antigravity operation', async t => {
  const p = probe(t, { provider: AGY, skillBridge: true, skillTools: new Set([HISTORY]), refuseTools: true })
  const id = 'fixture-acp-conflict'
  const end = p.begin()
  try {
    const permission = await p.ask(id, { sessionId: 'current', toolCall: {
      toolCallId: id, name: 'mcp_dsh_read_own_chat', rawInput: { server: 'dsh', tool: SKILL },
    } })
    assert.deepEqual(permission, picked('no'))
  } finally {
    await end()
  }
  const next = p.begin()
  try {
    const tool = p.run.tools.get(id)
    assert.equal(tool.restrictedIdentity, true)
    assert.equal(tool.skillConflict, true)
    assert.equal(tool.retired, true)
  } finally {
    await next()
  }
})

test('D1 Antigravity ON refuses a conflicting permission and keeps its history identity unavailable', { ...unixOnly, timeout: 15_000 }, async t => {
  const h = agyHistory(t, true)
  const chat = h.chat()
  const marker = 'synthetic conflict history result'
  h.services.tools.execute.mock.mockImplementation(async () => ({
    results: [{ result: { content: [{ type: 'text', text: marker }], isError: false } }],
  }))
  assert.equal((await chat.turn('plain conflict control')).at(-1)?.reason.kind, 'stop')
  assert.deepEqual(h.events('mcp-list').map(event => event.tools), [[HISTORY]])
  const live = h.adapter.live.get(chat.session.id)
  const { run, bridge } = live
  assert.notEqual(run.spec.refuseTools, true)

  const onUpdate = run.onUpdate
  const onPermission = run.onPermission
  const post = wire(h.adapter.backchannel, bridge, bridge.attachment)
  let historyPermission
  const replies = []
  const assertRefused = outcome => assert.ok(outcome?.outcome === 'cancelled' ||
    (outcome?.outcome === 'selected' && outcome.optionId === 'agy-reject'), 'ACP must refuse the history identity')
  const reofferHistory = async signal => {
    const { toolCall, sessionId } = historyPermission
    const callId = toolCall.toolCallId
    assert.equal(run.historySignal?.aborted, false)
    await onUpdate.call(run, { sessionUpdate: 'tool_call', ...toolCall }, sessionId)
    assertRefused((await onPermission.call(run, historyPermission, signal)).outcome)
    assert.equal(run.restrictedCall(callId, HISTORY, run.historySignal), undefined)
    replies.push(await post('call', { name: HISTORY, callId, arguments: toolCall.rawInput.arguments }))
  }

  // Defer the fake peer's matching announcement until after its conflicting permission arrives.
  t.mock.method(run, 'onUpdate', (update, sessionId) => {
    if (update.sessionUpdate === 'tool_call' && update.rawInput?.arguments?.query === 'conflict') return
    return onUpdate.call(run, update, sessionId)
  })
  t.mock.method(run, 'onPermission', async (params, signal) => {
    const { toolCall } = params
    if (toolCall.rawInput?.arguments?.query === 'conflict') {
      assert.equal(run.tools.has(toolCall.toolCallId), false)
      historyPermission = params
      const outcome = await onPermission.call(run, {
        ...params, toolCall: { ...toolCall, rawInput: { ...toolCall.rawInput, tool: SKILL } },
      }, signal)
      assertRefused(outcome.outcome)
      assert.equal(run.tools.get(toolCall.toolCallId)?.skillConflict, true)
      await reofferHistory(signal)
      return outcome
    }
    assert.equal(run.tools.get(historyPermission.toolCall.toolCallId)?.retired, true)
    await reofferHistory(signal)
    return onPermission.call(run, params, signal)
  })

  const refused = await chat.turn('agy-bridge read_own_chat {"query":"conflict"}')
  assert.equal(refused.at(-1)?.reason.kind, 'stop')
  assert.deepEqual(toolBlocks(refused), [])
  const [permission] = h.events('permission-answer')
  assertRefused(permission?.answer)
  assert.deepEqual(h.events('mcp-history-result'), [])
  assert.deepEqual(h.approvals, [])

  const native = await chat.turn('native-bash')
  const [mirror] = toolBlocks(native).map(chunk => chunk.block)
  assert.equal(mirror?.name, 'acp_tool')
  const result = await h.adapter.tool.execute(JSON.parse(mirror.arguments), {
    agent: live.dshAgent, callId: mirror.id, signal: t.signal,
  })
  assert.equal(result.status, 'completed')
  assert.deepEqual(h.approvals.map(request => request.toolName), ['acp_tool'])
  assert.deepEqual(h.events('native-tool-ran').map(event => event.name), ['Bash'])
  assert.equal(h.adapter.live.get(chat.session.id), live)

  assert.deepEqual(replies.map(({ status, body }) => [status, body.isError, body.content]), [[200, true, []], [200, true, []]])
  assert.equal(h.services.tools.execute.mock.callCount(), 0)
  assert.doesNotMatch(JSON.stringify([refused, native, chat.session.snapshotEvents()]), new RegExp(marker))
})

test('D1 the MCP allowlist boundary retires only the refused Antigravity identity', async t => {
  const h = await combined(t, { provider: AGY })
  const id = 'fixture-mcp-refusal'
  const other = 'fixture-other-identity'
  const end = h.p.begin()
  try {
    for (const callId of [id, other]) {
      await h.send(callId, { name: 'mcp_dsh_read_own_chat', rawInput: { server: 'dsh', tool: HISTORY } })
      assert.equal(h.p.run.tools.get(callId).skillOperation, HISTORY)
    }
    const post = wire(h.backchannel, h.live.bridge, h.live.bridge.attachment)
    const refused = await post('call', { name: 'fixture_unoffered', callId: id })
    assert.deepEqual(refused, { status: 403, body: { error: 'refused', isError: true } })
    assert.equal(h.p.run.tools.get(id).skillConflict, true)
    assert.equal(h.p.run.tools.get(id).skillAbort.signal.aborted, true)
    assert.equal(h.p.run.tools.get(other).skillAbort.signal.aborted, false)
    assert.deepEqual(h.executed, [])
  } finally {
    await end()
  }
  const next = h.p.begin()
  try {
    assert.equal(h.p.run.tools.get(id).retired, true)
  } finally {
    await next()
  }
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
