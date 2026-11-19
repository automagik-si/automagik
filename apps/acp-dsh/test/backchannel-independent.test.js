// Independent bridge rows for issue #842: the real Backchannel and Session, the real auto-review
// listener, and the real pinned v4 loader. The bridge path here is the one PR #851 describes: a
// Manual or Full bridge call writes a marked synthetic assistant/message carrying its tool-call
// block at the open step before the tool/call row, replaces it with an empty developer/message
// once the call settles (so it never derives into provider history), and the finished Session
// loads. Auto keeps using the same block for its reviewer. A tool that throws an Error with no
// .code must leave a JSON tool/result row, not an unresolved call. No real session, id or text
// is read or copied: every Session, call id and message here is synthetic.
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply as applyAutoReview } from '@deepseek-ai/dsh-experimental-auto-review'
import { KNOWN_SESSION_EVENT_TYPES, Session } from '@deepseek-ai/dsh-session'
import { restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { Backchannel } from '../src/host/backchannel.js'
import { SYNTHETIC_KIND } from '../src/host/names.js'

const TOOLS = [
  { name: 'bash', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
  { name: 'write', description: 'Write a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } },
]
const DEFAULT_ARGS = { command: 'echo probe' }
const RAW_ARGS = JSON.stringify(DEFAULT_ARGS)

const artifactOf = session => ({
  header: { version: 4, id: session.id, createdAt: 0, isSeeded: false, delegationDepth: 0 },
  events: session.snapshotEvents(),
  inheritedEventCount: 0,
})

// The same real v4 loader a desktop reload runs, with the installed (unpatched) 0.2.2-rc.2
// bytes: a Session the bridge writes must load on its own, without the carried recovery patch.
const assertLoadable = session => {
  const artifact = artifactOf(session)
  assert.equal(restoreReleasedV4Artifact(artifact, KNOWN_SESSION_EVENT_TYPES), artifact)
}

const advertisementsOf = (events, callId) => events.filter(event => event.type === 'assistant/message'
  && Array.isArray(event.data?.message?.content)
  && event.data.message.content.some(block => block?.type === 'tool-call' && block.id === callId))
const callOf = (events, callId) => events.filter(event => event.type === 'tool/call' && event.data.callId === callId)
const resultOf = (events, callId) => events.filter(event => event.type === 'tool/result' && event.data.message?.toolCallId === callId)
const replacementOf = (events, adSeq) => events.filter(event => event.type === 'developer/message'
  && Array.isArray(event.sourceEventSeqs) && event.sourceEventSeqs.includes(adSeq))

const derivedToolCalls = (session, callId) => session.deriveMessages()
  .flatMap(message => (Array.isArray(message.content) ? message.content : []))
  .filter(block => block?.type === 'tool-call' && block.id === callId)

// The step a bridge row would be recorded in: open when the log has a step/start with no
// turn/start, turn/end or step/end after it.
function openStepAt(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'turn/start' || event.type === 'turn/end' || event.type === 'step/end') return undefined
    if (event.type === 'step/start') return { turn: event.data.turn, step: event.data.step }
  }
  return undefined
}

// One synthetic Session held at turn 1, step 1, with the route Auto review needs. The tools
// service records what it can see when a call reaches execution: at that point the bridge must
// already have written the advertisement and the tool/call row.
function bridgeHost({ level = 'manual', fail } = {}) {
  const policy = level === 'full' ? 'never' : 'ask'
  const sandbox = level === 'full' ? 'danger-full-access' : 'workspace-write'
  const session = Session.create(`probe-842-${level}`)
  let turn = 1
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('request/header', { header: { config: { provider: 'acp-probe', model: 'probe-model' }, tools: TOOLS }, reason: 'initial' })
  const agent = { session }
  const executed = []
  const asked = []
  const observations = []
  const ctx = {
    get: (name) => {
      if (name === 'tools') {
        return {
          definitions: () => TOOLS,
          executable: toolName => TOOLS.find(tool => tool.name === toolName),
          execute: async ({ calls }) => {
            const call = calls[0]
            observations.push({ callId: call.id, events: session.snapshotEvents(), surface: [...session.surface.nodes] })
            executed.push({ name: call.name, arguments: call.arguments })
            if (fail !== undefined) throw fail
            return { results: [{ callId: call.id, result: { content: [{ type: 'text', text: `probe ran ${call.name}` }], isError: false } }] }
          },
        }
      }
      if (name === 'approval') {
        return {
          effectivePolicy: () => policy,
          request: async (request) => {
            asked.push(request)
            return 'allowed-once'
          },
        }
      }
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: sandbox }) }
      if (name === 'agentPresets') return { presetForSession: () => 'standard' }
      if (name === 'agents') return { turnBoundaryOf: () => ({ lastTurn: turn }) }
      return undefined
    },
  }
  const closeTurn = () => {
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: 'stop' })
  }
  const nextTurn = () => {
    closeTurn()
    turn += 1
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    return turn
  }
  return { session, agent, ctx, backchannel: new Backchannel({ ctx }), executed, asked, observations, closeTurn, nextTurn, get turn() { return turn } }
}

async function serve(host) {
  await host.backchannel.listen()
  host.record = host.backchannel.mint({ sessionId: host.session.id, agent: host.agent, name: 'Probe agent' })
  host.backchannel.announce(host.record)
  return host
}

async function postCall(host, { callId, name = 'bash', args = DEFAULT_ARGS }) {
  const response = await fetch(host.backchannel.urlFor(host.record), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${host.record.credential}` },
    body: JSON.stringify({ op: 'call', name, arguments: args, callId }),
  })
  return { status: response.status, body: await response.json() }
}

// The synthetic advertisement and its replacement, checked from the log and the surface.
function assertAdvertisement(host, { callId, turn, step }) {
  const events = host.session.snapshotEvents()
  const [ad] = advertisementsOf(events, callId)
  assert.ok(ad, `${callId}: the marked assistant/message advertisement exists`)
  assert.equal(ad.data.turn, turn, `${callId}: the advertisement is at the call's turn`)
  assert.equal(ad.data.step, step, `${callId}: the advertisement is at the call's step`)
  assert.deepEqual(ad.data.stream, [], `${callId}: the advertisement is not a model stream`)
  assert.equal(ad.data.message.role, 'assistant')
  assert.equal(ad.data.message.source.synthetic, SYNTHETIC_KIND)
  assert.equal(ad.data.message.source.bridge, true)
  assert.deepEqual(ad.data.message.content, [{ type: 'tool-call', id: callId, name: 'bash', arguments: RAW_ARGS }], `${callId}: the block advertises exactly this call`)
  assert.equal(ad.surfaceOp, 'append')

  const [call] = callOf(events, callId)
  assert.ok(call, `${callId}: the tool/call row exists`)
  assert.deepEqual(call.data, { turn, step, callId, name: 'bash', arguments: RAW_ARGS }, `${callId}: the call row keeps its open-step coordinates`)

  // At execution time the advertisement was already there, before the call row, and on the
  // surface the reviewer reads.
  const observation = host.observations.at(-1)
  assert.equal(observation.callId, callId)
  assert.deepEqual(openStepAt(observation.events), { turn, step }, `${callId}: the rows were written in the open step`)
  const observedAd = advertisementsOf(observation.events, callId)[0]
  const observedCall = callOf(observation.events, callId)[0]
  assert.ok(observedAd, `${callId}: the advertisement exists when the tool runs`)
  assert.ok(observedCall, `${callId}: the call row exists when the tool runs`)
  assert.ok(observedAd.seq < observedCall.seq, `${callId}: the advertisement precedes its tool/call row`)
  assert.equal(observedAd.seq, ad.seq)
  assert.equal(observedCall.seq, call.seq)
  assert.ok(observation.surface.includes(observedAd.seq), `${callId}: the advertisement is on the surface before the call settles`)

  // Settled: the marked block is shadowed by an empty developer message and leaves the surface,
  // so no provider history derives the fake call.
  const settled = host.session.snapshotEvents()
  const [replacement] = replacementOf(settled, ad.seq)
  assert.ok(replacement, `${callId}: the advertisement is replaced when the call settles`)
  assert.deepEqual(replacement.surfaceOp, { op: 'replace', startSeq: ad.seq, endSeq: ad.seq })
  assert.deepEqual(replacement.sourceEventSeqs, [ad.seq])
  assert.equal(replacement.data.message.role, 'developer')
  assert.deepEqual(replacement.data.message.content, [])
  assert.equal(replacement.data.message.source.kind, SYNTHETIC_KIND)
  assert.equal(host.session.surface.nodes.includes(ad.seq), false, `${callId}: the marked block is not on the Session surface`)
  assert.equal(host.session.surface.nodes.includes(replacement.seq), true, `${callId}: its replacement is on the surface`)
  assert.deepEqual(derivedToolCalls(host.session, callId), [], `${callId}: the marked block never reaches provider history`)

  const [result] = resultOf(settled, callId)
  assert.ok(result, `${callId}: the tool/result row exists`)
  assert.equal(result.surfaceOp, 'append')
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  return { ad, call, result, replacement }
}

async function assertLevelAdvertises(level) {
  const host = await serve(bridgeHost({ level }))
  try {
    for (const turn of [1, 2]) {
      const callId = `probe-b4-${level}-${turn}`
      const { status, body } = await postCall(host, { callId })
      assert.equal(status, 200, level)
      assert.equal(body.isError, false, `${level} turn ${turn}: the call ran`)
      assert.deepEqual(body.content, [{ type: 'text', text: 'probe ran bash' }])
      assertAdvertisement(host, { callId, turn, step: 1 })
      if (turn === 1) host.nextTurn()
    }
    host.closeTurn()
    const events = host.session.snapshotEvents()
    assert.equal(events.filter(event => event.type === 'tool/call').length, 2, `${level}: two calls`)
    assert.equal(events.filter(event => event.type === 'tool/result').length, 2, `${level}: two results`)
    assert.equal(events.filter(event => event.type === 'assistant/message').length, 2, `${level}: one advertisement per call`)
    assert.equal(events.filter(event => event.type === 'developer/message').length, 2, `${level}: one replacement per advertisement`)
    assert.doesNotThrow(() => assertLoadable(host.session), `${level}: the finished two-turn session loads through the real v4 loader`)
  } finally {
    host.backchannel.dispose()
  }
}

test('B4 Manual: each bridge call is advertised at its open step before the tool/call, replaced when settled, and the two-turn session loads', () => assertLevelAdvertises('manual'))

test('B4 Full: each bridge call is advertised at its open step before the tool/call, replaced when settled, and the two-turn session loads', () => assertLevelAdvertises('full'))

test('B4 auto: the Auto review path still writes and uses the marked block for its reviewer', async () => {
  const ALLOW = '{"risk":"low","decision":"allow"}'
  const reviewer = text => (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
  const session = Session.create('probe-842-auto')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', { header: { config: { provider: 'acp-probe', model: 'probe-auto' }, tools: TOOLS }, reason: 'initial' })
  const agent = { session }
  const streams = []
  const executed = []
  const asked = []
  const preExecute = []
  const dispatchListeners = []
  const approval = {
    effectivePolicy: () => 'ask',
    overrideOf: () => 'never',
    request: async (request) => {
      asked.push(request)
      return 'rejected'
    },
  }
  const permissionPresets = { current: () => 'auto', registerAuto: () => () => {} }
  const sandboxPolicy = { resolve: () => ({ mode: 'danger-full-access' }) }
  const tools = {
    definitions: () => TOOLS,
    executable: toolName => TOOLS.find(tool => tool.name === toolName),
    execute: async ({ calls, agent: callAgent, signal }) => {
      const call = calls[0]
      const observation = { callId: call.id, events: session.snapshotEvents(), surface: [...session.surface.nodes] }
      const exec = { callId: call.id, rootCallId: call.id, name: call.name, arguments: JSON.parse(call.arguments), agent: callAgent, signal }
      const gate = async index => (index >= preExecute.length ? { kind: 'allow' } : preExecute[index].listener(exec, () => gate(index + 1)))
      const decision = await gate(0)
      if (decision.kind !== 'allow') {
        return { results: [{ callId: call.id, result: { content: [{ type: 'text', text: 'denied' }], isError: true, error: { message: decision.reason ?? 'denied' } } }] }
      }
      const body = async () => {
        executed.push({ name: call.name, observation })
        return { results: [{ callId: call.id, result: { content: [{ type: 'text', text: 'auto ran bash' }], isError: false } }] }
      }
      const dispatch = async index => (index >= dispatchListeners.length ? body() : dispatchListeners[index].listener(exec, () => dispatch(index + 1)))
      return dispatch(0)
    },
  }
  const ctx = {
    approval,
    permissionPresets,
    get: (name) => {
      if (name === 'tools') return tools
      if (name === 'approval') return approval
      if (name === 'sandboxPolicy') return sandboxPolicy
      if (name === 'permissionPresets') return permissionPresets
      if (name === 'agentPresets') return { presetForSession: () => 'standard' }
      if (name === 'workingDirectory') return { ensure: async () => process.cwd() }
      return undefined
    },
    on: (name, listener, options) => {
      if (name === 'tools/pre-execute' || name === 'tools/execute') {
        const entries = name === 'tools/pre-execute' ? preExecute : dispatchListeners
        const entry = { listener }
        if (options?.prepend) entries.unshift(entry)
        else entries.push(entry)
        return () => {
          const index = entries.indexOf(entry)
          if (index >= 0) entries.splice(index, 1)
        }
      }
      return () => {}
    },
    effect: (fn) => {
      const iterator = fn()
      let next = iterator.next()
      while (!next.done) next = iterator.next(next.value)
      return next.value
    },
    workingDirectory: { ensure: async () => process.cwd() },
    llm: {
      stream: (options) => {
        streams.push(options)
        return reviewer(ALLOW)
      },
    },
  }
  applyAutoReview(ctx)
  const backchannel = new Backchannel({ ctx })
  await backchannel.listen()
  const record = backchannel.mint({ sessionId: session.id, agent, name: 'Probe agent' })
  backchannel.announce(record)
  try {
    const response = await fetch(backchannel.urlFor(record), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${record.credential}` },
      body: JSON.stringify({ op: 'call', name: 'bash', arguments: DEFAULT_ARGS, callId: 'probe-b4-auto' }),
    })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.isError, false, 'Auto review allowed the call')
    assert.equal(asked.length, 0, 'Auto review raised no dialog')
    assert.equal(streams.length, 1, 'auto-review reached its reviewer')
    const reviewText = streams[0].messages.map(message => message.content.map(block => block.text ?? '').join('\n')).join('\n')
    assert.match(reviewText, /"name": "bash"/)
    assert.match(reviewText, /\\"command\\":\\"echo probe\\"/, 'the reviewer read the call from the marked block')
    assert.equal(executed.length, 1, 'the tool ran after the review')
    const callId = 'probe-b4-auto'
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: 'stop' })
    const advertisement = assertAdvertisement({ session, observations: [executed[0].observation] }, { callId, turn: 1, step: 1 })
    assert.equal(advertisement.ad.data.message.source.synthetic, SYNTHETIC_KIND)
    assert.doesNotThrow(() => assertLoadable(session))
  } finally {
    backchannel.dispose()
  }
})

test('B5: a Full bridge call whose tool throws an Error with no .code writes a JSON tool/result row and the session loads', async () => {
  const host = await serve(bridgeHost({ level: 'full', fail: new Error('boom') }))
  try {
    const callId = 'probe-b5-throws'
    const { status, body } = await postCall(host, { callId })
    assert.equal(status, 200)
    assert.equal(body.isError, true)
    assert.deepEqual(body.error, { name: 'Error' }, 'the response would not survive JSON with an undefined code')
    assert.equal(host.executed.length, 1, 'the tool body ran and threw')
    host.closeTurn()

    const events = host.session.snapshotEvents()
    const [call] = callOf(events, callId)
    const [result] = resultOf(events, callId)
    assert.ok(call, 'the call row exists')
    assert.ok(result, 'the throwing call has its tool/result row')
    assert.equal(result.data.message.isError, true)
    assert.match(JSON.stringify(result.data.message.content), /Error: boom/)
    assert.deepEqual(result.data.error, { name: 'Error' }, 'the result carries the error name and no undefined code')
    assert.equal(Object.hasOwn(result.data.error, 'code'), false)
    assert.deepEqual(JSON.parse(JSON.stringify(result.data)), result.data, 'the stored row is JSON-serializable with no undefined field')
    assert.equal(result.surfaceOp, 'append')
    assert.deepEqual(result.sourceEventSeqs, [call.seq])

    const [ad] = advertisementsOf(events, callId)
    assert.ok(ad, 'the failing call was advertised before it ran')
    assert.equal(replacementOf(events, ad.seq).length, 1, 'its advertisement was replaced when it settled')
    assert.doesNotThrow(() => assertLoadable(host.session), 'the finished session loads through the real v4 loader')
    assert.equal(host.session.surface.nodes.includes(ad.seq), false)
  } finally {
    host.backchannel.dispose()
  }
})

test('B6: no open step and an unwritable advertisement (Manual and Full) are refused without rows', async () => {
  const noStep = await serve(bridgeHost({ level: 'full' }))
  try {
    noStep.session.append('step/end', { turn: 1, step: 1 })
    const before = noStep.session.snapshotEvents()
    const { status, body } = await postCall(noStep, { callId: 'probe-b6-no-step' })
    assert.equal(status, 200)
    assert.equal(body.isError, true)
    assert.deepEqual(body.error, { name: 'BridgeRecordError', code: 'BRIDGE_NO_STEP' })
    assert.equal(noStep.executed.length, 0, 'a call with no open step does not run the tool')
    const events = noStep.session.snapshotEvents()
    assert.deepEqual(events, before, 'a refused call writes no row')
    assert.equal(events.filter(event => event.type === 'tool/call' || event.type === 'tool/result' || event.type === 'assistant/message').length, 0)
  } finally {
    noStep.backchannel.dispose()
  }

  for (const level of ['manual', 'full']) {
    const unwritable = await serve(bridgeHost({ level }))
    const append = unwritable.session.append.bind(unwritable.session)
    unwritable.session.append = (type, data, options) => {
      if (type === 'assistant/message') throw new Error('advertisement blocked')
      return append(type, data, options)
    }
    try {
      const before = unwritable.session.snapshotEvents()
      const { status, body } = await postCall(unwritable, { callId: `probe-b6-no-advertisement-${level}` })
      assert.equal(status, 200)
      assert.equal(body.isError, true)
      assert.deepEqual(body.error, { name: 'BridgeRecordError', code: 'BRIDGE_RECORD_FAILED' })
      assert.equal(unwritable.executed.length, 0, `${level}: an unadvertised call does not run the tool`)
      const events = unwritable.session.snapshotEvents()
      assert.deepEqual(events, before, `${level}: the refused call leaves no tool/call or tool/result row`)
      assert.equal(events.filter(event => event.type === 'tool/call' || event.type === 'tool/result' || event.type === 'assistant/message').length, 0, level)
    } finally {
      unwritable.backchannel.dispose()
    }
  }
})
