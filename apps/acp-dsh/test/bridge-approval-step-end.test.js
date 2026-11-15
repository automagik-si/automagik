// The own tool finishes while its step still has a bridge approval. DSH ends the step only
// after the real mirror returns. All Sessions and calls here are synthetic.
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import test from 'node:test'
import { apply as applyAutoReview } from '@deepseek-ai/dsh-experimental-auto-review'
import { createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { AcpAdapter } from '../src/host/adapter.js'
import { callArguments, TOOL_NAME } from '../src/host/tool.js'
import { assertLoadable, bridgeHost, eventsOf, resultsOf, ticks } from './support/bridge-host.js'

function world(t, { level = 'manual', id = 'approval-step', endStep = true } = {}) {
  const h = bridgeHost({ level, id })
  const ctx = h.backchannel.ctx
  const get = ctx.get
  const approval = get('approval')
  ctx.get = name => name === 'approval' ? {
    ...approval,
    request: request => {
      const pending = approval.request(request)
      const ask = h.asks.at(-1)
      const abort = () => {
        ask.withdrawn = true
        ask.done = true
        ask.resolve('cancelled')
      }
      request.signal.addEventListener('abort', abort, { once: true })
      if (request.signal.aborted) abort()
      return pending.finally(() => request.signal.removeEventListener('abort', abort))
    },
  } : get(name)
  h.mint()
  h.running = true
  h.record.promptRunning = () => h.running
  h.startTurn()
  h.startStep()
  const adapter = new AcpAdapter(ctx, new Map(), { backchannel: h.backchannel })
  const own = {
    id: 'own', title: 'Own tool', kind: 'execute', status: 'in_progress',
    rawInput: { command: 'echo own' }, listeners: new Set(),
  }
  const live = {
    name: 'Probe agent',
    run: {
      tools: new Map([[own.id, own]]), busy: true,
      cancel: async () => {
        h.cancelled += 1
        h.running = false
        h.backchannel.cancel(h.record)
      },
    },
  }
  adapter.live.set(h.session.id, live)
  h.cancelled = 0
  h.reaped = 0
  adapter.reap = (sessionId, current) => {
    assert.equal(sessionId, h.session.id)
    assert.equal(current, live)
    h.reaped += 1
  }
  h.stop = new AbortController()
  h.live = live
  h.own = own
  h.adapter = adapter
  h.mirrorSettled = false
  h.startMirror = () => {
    const args = callArguments(own)
    const call = { id: 'acp_own', name: TOOL_NAME, arguments: JSON.stringify(args) }
    const position = { turn: h.turn, step: h.step }
    h.session.append('assistant/message', {
      ...position, stream: [],
      message: createAssistantMessage({
        content: [{ type: 'tool-call', ...call }],
        source: { kind: 'model', provider: 'acp-probe', model: 'probe-model' },
      }),
    }, { surfaceOp: 'append' })
    const seq = h.session.append('tool/call', {
      ...position, callId: call.id, name: call.name, arguments: call.arguments,
    }).seq
    const pending = adapter.tool.execute(args, {
      agent: h.agent, callId: call.id, signal: h.stop.signal,
    })
    h.mirror = pending.then(value => {
      h.atReturn = h.session.snapshotEvents()
      h.mirrorSettled = true
      h.session.append('tool/result', {
        ...position,
        message: createToolResultMessage({
          callId: call.id, content: adapter.tool.output.render(args, value), isError: false,
        }),
      }, { surfaceOp: 'append', sourceEventSeqs: [seq] })
      if (endStep) h.endStep()
      return value
    })
    assertLoadable(h.session, ' with the own tool running')
  }
  h.finishOwn = async () => {
    own.status = 'completed'
    own.output = 'own done'
    for (const wake of own.listeners) wake()
    await ticks()
    assertLoadable(h.session, ' after the own tool finished')
  }
  h.finishBridge = (index = 0) => {
    const body = h.bodies[index]
    body.done = true
    body.resolve({ results: [{ callId: body.call.id, result: {
      content: [{ type: 'text', text: 'y' }], isError: false,
    } }] })
  }
  h.assertHeld = () => {
    assert.equal(h.mirrorSettled, false)
    assert.equal(live.mirrorBodies, 1)
    assert.equal(eventsOf(h.session, 'step/end').length, 0)
    assert.equal(eventsOf(h.session, 'tool/result').length, 0)
    assertLoadable(h.session, ' while approval holds the mirror')
  }
  h.assertClean = () => {
    assert.equal(h.record.approvalWaiters.size, 0)
    const guard = h.session[Symbol.for('@automagik/acp-dsh/write-guard')]
    assert.equal(guard?.listeners.size ?? 0, 0)
    assert.equal(getEventListeners(h.stop.signal, 'abort').length, 0)
    assert.equal(getEventListeners(h.record.abort.signal, 'abort').length, 0)
    assert.equal(live.mirrorBodies, 0)
    assertLoadable(h.session, ' after the mirror returned')
  }
  t.after(() => {
    h.stop.abort()
    h.backchannel.dispose()
    adapter.live.clear()
    adapter.dispose()
  })
  assertLoadable(h.session, ' before the calls')
  return h
}

function bridgeResult(h, id, code) {
  const rows = resultsOf(h.session, id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].data.turn, 1)
  assert.equal(rows[0].data.step, 1)
  assert.equal(rows[0].data.error?.code, code)
  assertLoadable(h.session, ' with the bridge result')
  return rows[0]
}

function noDropped(h) {
  assert.doesNotMatch(h.logs.join('\n'), /call-closed|result-dropped/)
}

test('late approval writes y in the original step before the mirror returns', async t => {
  const h = world(t)
  h.startMirror()
  const bridge = h.call({ callId: 'bridge_late' })
  assert.equal(h.record.approvalCalls.size, 1, 'tracked before the first await')
  assertLoadable(h.session, ' with the approval open')
  await h.finishOwn()
  h.assertHeld()
  h.answer()
  await ticks()
  h.assertHeld()
  assert.equal(h.bodies.length, 1)
  h.finishBridge()
  assert.equal((await bridge).content[0].text, 'y')
  assert.equal((await h.mirror).text, 'own done')
  const result = bridgeResult(h, 'bridge_late')
  assert.equal(result.data.message.content[0].text, 'y')
  assert.ok(h.atReturn.some(event => event.seq === result.seq))
  assert.ok(result.seq < eventsOf(h.session, 'step/end')[0].seq)
  assert.equal(h.record.approvalCalls.size, 0)
  noDropped(h)
  h.assertClean()
})

test('late rejection writes REJECTED before the mirror returns; the body never runs', async t => {
  const h = world(t)
  h.startMirror()
  const bridge = h.call({ callId: 'bridge_rejected' })
  await h.finishOwn()
  h.assertHeld()
  h.answer('rejected')
  assert.equal((await bridge).error.code, 'REJECTED')
  await h.mirror
  const result = bridgeResult(h, 'bridge_rejected', 'REJECTED')
  assert.ok(h.atReturn.some(event => event.seq === result.seq))
  assert.equal(h.bodies.length, 0)
  noDropped(h)
  h.assertClean()
})

test('an unanswered approval has no 30 second bound and Stop cancels the mirror', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const h = world(t)
  h.startMirror()
  const bridge = h.call({ callId: 'bridge_stopped' })
  await h.finishOwn()
  h.assertHeld()
  t.mock.timers.tick(31_000)
  await ticks()
  h.assertHeld()
  assert.equal(h.asks[0].withdrawn, undefined)
  const answers = []
  h.own.permission = { answer: answer => { answers.push(answer); delete h.own.permission } }
  h.stop.abort()
  await h.mirror
  assert.equal((await bridge).error.code, 'BRIDGE_CANCELLED')
  assert.equal(h.cancelled, 1)
  assert.equal(h.reaped, 1)
  assert.deepEqual(answers, [{ outcome: { outcome: 'cancelled' } }])
  assert.equal(h.asks[0].withdrawn, true)
  assert.equal(h.bodies.length, 0)
  assert.equal(h.record.approvalCalls.size, 0)
  h.assertClean()
})

for (const subscribe of [true, false]) {
  test(`prompt end releases the mirror; a forced step/end still closes the call (${subscribe})`,
    async t => {
      t.mock.timers.enable({ apis: ['setInterval'] })
      const h = world(t, { endStep: false })
      if (!subscribe) h.record.guard.subscribe = undefined
      h.startMirror()
      const bridge = h.call({ callId: 'bridge_ended' })
      await h.finishOwn()
      h.assertHeld()
      h.running = false
      t.mock.timers.tick(25)
      await h.mirror
      assert.equal(resultsOf(h.session, 'bridge_ended').length, 0)
      h.assertClean()
      h.endStep()
      bridgeResult(h, 'bridge_ended', 'BRIDGE_CALL_SUPERSEDED')
      h.backchannel.cancel(h.record)
      await bridge
      assert.equal(h.bodies.length, 0)
      assertLoadable(h.session, ' after the pending approval is withdrawn')
    })
}

test('two approvals hold their mirror until both finish, independently of another Session',
  async t => {
    const h = world(t)
    const other = world(t, { id: 'another-session' })
    // Both Sessions use the same Backchannel, as they do in the adapter.
    other.backchannel.revoke(other.record)
    other.record = h.backchannel.mint({
      sessionId: other.session.id, agent: other.agent, promptRunning: () => true,
    })
    const elsewhere = h.backchannel.call(other.record, { name: 'bash', arguments: {} })
    h.startMirror()
    const first = h.call({ callId: 'bridge_first' })
    const second = h.call({ callId: 'bridge_second' })
    await h.finishOwn()
    h.assertHeld()
    h.asks[1].resolve('allowed-once')
    await ticks()
    h.finishBridge()
    await first
    bridgeResult(h, 'bridge_first')
    assert.equal(h.mirrorSettled, false)
    assert.equal(eventsOf(h.session, 'step/end').length, 0)
    assert.equal(h.record.approvalCalls.size, 1)
    h.asks[2].resolve('allowed-once')
    await ticks()
    h.finishBridge(1)
    await second
    await h.mirror
    bridgeResult(h, 'bridge_second')
    assert.equal(other.record.approvalCalls.size, 1)
    assert.equal(h.asks[0].done, false)
    assertLoadable(other.session, ' with the other Session still waiting')
    noDropped(h)
    h.assertClean()
    h.backchannel.cancel(other.record)
    await elsewhere
    assertLoadable(other.session, ' after its own cancellation')
  })

test('an approval left by a forced boundary cannot hold the next step', async t => {
  const h = world(t)
  const bridge = h.call({ callId: 'bridge_previous' })
  assertLoadable(h.session, ' with the previous approval pending')
  h.endStep()
  bridgeResult(h, 'bridge_previous', 'BRIDGE_CALL_SUPERSEDED')
  h.startStep()
  h.startMirror()
  await h.finishOwn()
  await h.mirror
  assert.equal(h.record.approvalCalls.size, 1)
  assert.equal(h.asks[0].done, false)
  assert.equal(h.bodies.length, 0)
  h.assertClean()
  h.backchannel.cancel(h.record)
  await bridge
  assert.equal(h.record.approvalCalls.size, 0)
  assertLoadable(h.session, ' after the previous approval is withdrawn')
})

test('Full access keeps returning the mirror while the bridge body runs', async t => {
  const h = world(t, { level: 'full' })
  h.startMirror()
  const bridge = h.call({ callId: 'bridge_full' })
  assertLoadable(h.session, ' with the Full access body running')
  assert.equal(h.record.approvalCalls.size, 0)
  await h.finishOwn()
  await h.mirror
  assert.equal(h.asks.length, 0)
  assert.equal(h.bodies[0].done, false)
  bridgeResult(h, 'bridge_full', 'BRIDGE_CALL_SUPERSEDED')
  h.finishBridge()
  assert.equal((await bridge).content[0].text, 'y')
  bridgeResult(h, 'bridge_full', 'BRIDGE_CALL_SUPERSEDED')
  h.assertClean()
})

test('revoking a bridge releases the mirror and withdraws its approval', async t => {
  const h = world(t)
  h.startMirror()
  const bridge = h.call({ callId: 'bridge_revoked' })
  await h.finishOwn()
  h.assertHeld()
  h.backchannel.revoke(h.record)
  await h.mirror
  assert.deepEqual(await bridge, { revoked: true })
  assert.equal(h.asks[0].withdrawn, true)
  assert.equal(h.bodies.length, 0)
  h.assertClean()
})

function holdAutoReview(h) {
  const ctx = h.backchannel.ctx
  const get = ctx.get
  const tools = get('tools')
  const review = Promise.withResolvers()
  const reviewing = Promise.withResolvers()
  const listeners = new Map()
  ctx.on = (name, listener) => {
    const entries = listeners.get(name) ?? new Set()
    listeners.set(name, entries)
    entries.add(listener)
    return () => entries.delete(listener)
  }
  ctx.effect = fn => {
    const iterator = fn()
    while (!iterator.next().done) {}
  }
  ctx.permissionPresets = { current: () => 'auto', registerAuto: () => () => {} }
  ctx.workingDirectory = { ensure: async () => '/tmp' }
  ctx.llm = { stream: () => (async function* () {
    reviewing.resolve()
    await review.promise
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: {
      type: 'text', text: '{"risk":"low","decision":"allow"}',
    } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })() }
  // The same gate and dispatch stages as bridge-step-wait-auto.test.js, with held review/body.
  ctx.get = name => {
    if (name === 'permissionPresets') return ctx.permissionPresets
    if (name !== 'tools') return get(name)
    return { ...tools, execute: async options => {
      const call = options.calls[0]
      const exec = {
        callId: call.id, rootCallId: call.id, name: call.name,
        arguments: JSON.parse(call.arguments), agent: options.agent, signal: options.signal,
      }
      const gate = [...listeners.get('tools/pre-execute')][0]
      assert.deepEqual(await gate(exec, () => ({ kind: 'allow' })), { kind: 'allow' })
      const dispatch = [...listeners.get('tools/execute')][0]
      return dispatch(exec, () => tools.execute(options))
    } }
  }
  applyAutoReview(ctx)
  return { review, reviewing, listeners }
}

test('Auto review holds the mirror through the review and its approved body', async t => {
  const h = world(t)
  const { review, reviewing } = holdAutoReview(h)
  h.startMirror()
  const bridge = h.call({ callId: 'bridge_auto' })
  await reviewing.promise
  await h.finishOwn()
  h.assertHeld()
  assert.equal(h.bodies.length, 0)
  assert.equal(h.asks.length, 0)
  review.resolve()
  await ticks()
  h.assertHeld()
  assert.equal(h.bodies.length, 1)
  h.finishBridge()
  await bridge
  await h.mirror
  const result = bridgeResult(h, 'bridge_auto')
  assert.ok(h.atReturn.some(event => event.seq === result.seq))
  noDropped(h)
  h.assertClean()
})

test('a caller going away releases the mirror while its body ignores the abort', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const h = world(t)
  const caller = new AbortController()
  h.startMirror()
  const bridge = h.backchannel.call(h.record, {
    name: 'bash', arguments: {}, callId: 'bridge_gone', signal: caller.signal,
  })
  h.answer()
  await ticks()
  assert.equal(h.bodies.length, 1)
  await h.finishOwn()
  h.assertHeld()
  const [entry] = h.record.approvalCalls
  caller.abort()
  await ticks()
  assert.equal(h.mirrorSettled, true)
  await h.mirror
  assert.equal(h.bodies[0].done, false)
  assert.equal(h.record.approvalCalls.size, 0, 'released before the body settles')
  assert.equal(entry.stopped.aborted, true)
  assert.equal(getEventListeners(entry.stopped, 'abort').length, 0)
  bridgeResult(h, 'bridge_gone', 'BRIDGE_CALL_SUPERSEDED')
  h.assertClean()
  h.finishBridge()
  assert.equal((await bridge).error.code, 'BRIDGE_CANCELLED')
  assert.equal(h.record.approvalCalls.size, 0)
  assert.equal(getEventListeners(caller.signal, 'abort').length, 0)
  bridgeResult(h, 'bridge_gone', 'BRIDGE_CALL_SUPERSEDED')
  h.assertClean()
})

test('Auto timeout releases the mirror while its reviewer ignores the abort', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const h = world(t)
  h.backchannel.reviewTimeoutMs = 10
  const { review, reviewing, listeners } = holdAutoReview(h)
  h.startMirror()
  const bridge = h.call({ callId: 'bridge_timeout' })
  await reviewing.promise
  await h.finishOwn()
  h.assertHeld()
  const [entry] = h.record.approvalCalls
  t.mock.timers.tick(10)
  await ticks()
  assert.equal(h.mirrorSettled, true)
  await h.mirror
  assert.equal(h.record.approvalCalls.size, 0, 'released before the reviewer settles')
  assert.equal(h.record.approvalWaiters.size, 0)
  assert.equal(getEventListeners(entry.stopped, 'abort').length, 0)
  assert.equal(h.bodies.length, 0)
  bridgeResult(h, 'bridge_timeout', 'BRIDGE_CALL_SUPERSEDED')
  h.assertClean()
  review.resolve()
  await ticks()
  // Let any late dispatch settle too; the guard must keep its forced result.
  if (h.bodies.length > 0) h.finishBridge()
  assert.equal((await bridge).error.code, 'AUTO_REVIEW_TIMEOUT')
  assert.equal(h.record.approvalCalls.size, 0)
  assert.equal(getEventListeners(entry.stopped, 'abort').length, 0)
  assert.equal(listeners.get('session/event').size, 0)
  bridgeResult(h, 'bridge_timeout', 'BRIDGE_CALL_SUPERSEDED')
  h.assertClean()
})

test('an idle first record cannot release the second record\'s pending approval', async t => {
  const h = world(t)
  const second = h.backchannel.mint({
    sessionId: h.session.id, agent: h.agent, promptRunning: () => h.running,
  })
  h.startMirror()
  const bridge = h.backchannel.call(second, {
    name: 'bash', arguments: {}, callId: 'bridge_second_record',
  })
  await h.finishOwn()
  h.assertHeld()
  assert.equal(h.record.approvalCalls.size, 0)
  assert.equal(h.record.approvalWaiters.size, 1)
  assert.equal(second.approvalWaiters.size, 1)
  h.answer()
  await ticks()
  h.assertHeld()
  h.finishBridge()
  await bridge
  await h.mirror
  const result = bridgeResult(h, 'bridge_second_record')
  assert.ok(h.atReturn.some(event => event.seq === result.seq))
  assert.equal(second.approvalCalls.size, 0)
  assert.equal(second.approvalWaiters.size, 0)
  assert.equal(getEventListeners(second.abort.signal, 'abort').length, 0)
  noDropped(h)
  h.assertClean()
})

for (const mintedLater of [false, true]) {
  for (const revoke of [false, true]) {
    test(`a late call on another record holds the mirror (${mintedLater}, ${revoke})`, async t => {
      t.mock.timers.enable({ apis: ['setInterval'] })
      const h = world(t)
      const mint = () => h.backchannel.mint({
        sessionId: h.session.id, agent: h.agent, promptRunning: () => h.running,
      })
      let second = mintedLater ? undefined : mint()
      h.startMirror()
      const first = h.call({ callId: 'bridge_first_record' })
      await h.finishOwn()
      h.assertHeld()
      if (mintedLater) {
        second = mint()
        t.mock.timers.tick(25)
      }
      assert.equal(second.approvalWaiters.size, 1)
      const late = h.backchannel.call(second, {
        name: 'bash', arguments: {}, callId: 'bridge_late_record',
      })
      t.mock.timers.tick(25)
      assert.equal(second.approvalWaiters.size, 1)
      assertLoadable(h.session, ' with the late record waiting')
      if (revoke) {
        h.backchannel.revoke(h.record)
        assert.deepEqual(await first, { revoked: true })
      } else {
        h.answer()
        await ticks()
        h.finishBridge()
        await first
        bridgeResult(h, 'bridge_first_record')
      }
      await ticks()
      assert.equal(h.mirrorSettled, false)
      assert.equal(eventsOf(h.session, 'step/end').length, 0)
      assert.equal(resultsOf(h.session, 'bridge_late_record').length, 0)
      assertLoadable(h.session, ' after the first record finishes')
      h.answer()
      await ticks()
      h.finishBridge(revoke ? 0 : 1)
      assert.equal((await late).content[0].text, 'y')
      await h.mirror
      const result = bridgeResult(h, 'bridge_late_record')
      assert.equal(result.data.message.content[0].text, 'y')
      assert.ok(h.atReturn.some(event => event.seq === result.seq))
      assert.ok(result.seq < eventsOf(h.session, 'step/end')[0].seq)
      assert.equal(second.approvalCalls.size, 0)
      assert.equal(second.approvalWaiters.size, 0)
      assert.equal(getEventListeners(second.abort.signal, 'abort').length, 0)
      noDropped(h)
      h.assertClean()
    })
  }
}

for (const reason of ['level change', 'revoke']) {
  test(`${reason} releases the mirror while Auto review ignores the abort`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const h = world(t)
    const { reviewing, listeners } = holdAutoReview(h)
    h.startMirror()
    let returned = false
    void h.call({ callId: 'bridge_auto_stopped' }).then(() => { returned = true })
    await reviewing.promise
    await h.finishOwn()
    h.assertHeld()
    const [entry] = h.record.approvalCalls
    if (reason === 'revoke') h.backchannel.revoke(h.record)
    else {
      h.backchannel.ctx.permissionPresets.current = () => 'manual'
      for (const listener of listeners.get('session/event')) {
        listener(h.session, { type: 'permission/preset', data: { preset: 'manual' } })
      }
    }
    await ticks()
    assert.equal(h.mirrorSettled, true)
    await h.mirror
    assert.equal(returned, false, 'the reviewer is still stuck')
    assert.equal(h.record.approvalCalls.size, 0)
    assert.equal(h.record.approvalWaiters.size, 0)
    assert.equal(getEventListeners(entry.stopped, 'abort').length, 0)
    assert.equal(h.bodies.length, 0)
    bridgeResult(h, 'bridge_auto_stopped', 'BRIDGE_CALL_SUPERSEDED')
    h.assertClean()
  })
}

test('a running record with no calls cannot hold an ended record\'s approval', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const h = world(t, { endStep: false })
  let running = true
  const second = h.backchannel.mint({
    sessionId: h.session.id, agent: h.agent, promptRunning: () => running,
  })
  h.startMirror()
  const bridge = h.backchannel.call(second, {
    name: 'bash', arguments: {}, callId: 'bridge_ended_record',
  })
  await h.finishOwn()
  h.assertHeld()
  assert.equal(h.record.approvalCalls.size, 0)
  running = false
  t.mock.timers.tick(25)
  await ticks()
  assert.equal(h.mirrorSettled, true)
  await h.mirror
  assert.equal(h.record.promptRunning(), true)
  assert.equal(second.approvalCalls.size, 1)
  assert.equal(h.asks[0].done, false)
  assert.equal(second.approvalWaiters.size, 0)
  assert.equal(getEventListeners(second.abort.signal, 'abort').length, 0)
  h.assertClean()
  h.endStep()
  bridgeResult(h, 'bridge_ended_record', 'BRIDGE_CALL_SUPERSEDED')
  h.backchannel.cancel(second)
  await bridge
  assert.equal(second.approvalCalls.size, 0)
  assertLoadable(h.session, ' after the ended record is cancelled')
})

test('the mirror keeps its starting step when its own tool finishes in the next step', async t => {
  const h = world(t, { endStep: false })
  h.startMirror()
  h.endStep()
  assertLoadable(h.session, ' after the mirror step is forced closed')
  h.startStep()
  const bridge = h.call({ callId: 'bridge_next_step' })
  assertLoadable(h.session, ' with the next step approval open')
  await h.finishOwn()
  assert.equal(h.mirrorSettled, true)
  await h.mirror
  assert.equal(h.record.approvalCalls.size, 1)
  assert.equal(h.asks[0].done, false)
  assert.equal(resultsOf(h.session, 'bridge_next_step').length, 0)
  assert.equal(eventsOf(h.session, 'step/end').length, 1)
  h.assertClean()
  h.answer()
  await ticks()
  h.finishBridge()
  await bridge
  const [result] = resultsOf(h.session, 'bridge_next_step')
  assert.equal(result.data.step, 2)
  assert.equal(result.data.message.content[0].text, 'y')
  h.endStep()
  assertLoadable(h.session, ' after the next step finishes')
})

test('a mirror started without an open step cannot wait on a later approval', async t => {
  const h = world(t, { endStep: false })
  h.endStep()
  const mirror = h.adapter.tool.execute(callArguments(h.own), {
    agent: h.agent, callId: 'acp_own', signal: h.stop.signal,
  }).then(value => { h.mirrorSettled = true; return value })
  assertLoadable(h.session, ' with no step at mirror entry')
  h.startStep()
  const bridge = h.call({ callId: 'bridge_after_entry' })
  await h.finishOwn()
  assert.equal(h.mirrorSettled, true)
  assert.equal((await mirror).text, 'own done')
  assert.equal(h.asks[0].done, false)
  assert.equal(resultsOf(h.session, 'bridge_after_entry').length, 0)
  h.assertClean()
  h.backchannel.cancel(h.record)
  await bridge
  h.endStep()
  assertLoadable(h.session, ' after the later approval is cancelled')
})

for (const retirement of ['revoke', 'closed', 'removed']) {
  test(`a ${retirement} record is unsubscribed while a live record holds the mirror`, async t => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    const h = world(t)
    const retired = h.record
    const second = h.backchannel.mint({
      sessionId: h.session.id, agent: h.agent, promptRunning: () => true,
    })
    t.after(() => {
      retired.closed = false
      h.backchannel.revoke(retired)
    })
    h.startMirror()
    const bridge = h.backchannel.call(second, {
      name: 'bash', arguments: {}, callId: 'bridge_live_record',
    })
    await h.finishOwn()
    h.assertHeld()
    assert.equal(retired.approvalWaiters.size, 1)
    assert.equal(second.approvalWaiters.size, 1)
    const guard = h.session[Symbol.for('@automagik/acp-dsh/write-guard')]
    assert.equal(guard.listeners.size, 2)
    if (retirement === 'revoke') h.backchannel.revoke(retired)
    else if (retirement === 'closed') retired.closed = true
    else h.backchannel.records.delete(retired.credential)
    t.mock.timers.tick(25)
    await ticks()
    h.assertHeld()
    assert.equal(retired.approvalWaiters.size, 0)
    assert.equal(getEventListeners(retired.abort.signal, 'abort').length, 0)
    assert.equal(second.approvalWaiters.size, 1)
    assert.equal(guard.listeners.size, 1, 'the live record keeps its guard subscription')
    h.answer()
    await ticks()
    h.finishBridge()
    await bridge
    await h.mirror
    bridgeResult(h, 'bridge_live_record')
    assert.equal(second.approvalWaiters.size, 0)
    assert.equal(getEventListeners(second.abort.signal, 'abort').length, 0)
    noDropped(h)
    h.assertClean()
  })
}
