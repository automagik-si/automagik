import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { request } from 'node:http'
import test from 'node:test'
import { Backchannel, betweenSteps } from '../src/host/backchannel.js'
import { assertLoadable, bridgeHost, eventsOf, ticks } from './support/bridge-host.js'

// Keep the shared host unchanged: only these tests need a short wait bound.
function waitingHost(t, { level = 'full', stepWaitMs = 2_000, promptRunning = () => true, guard = true } = {}) {
  const h = bridgeHost({ level })
  h.backchannel = new Backchannel({ ctx: h.backchannel.ctx, log: message => h.logs.push(message), stepWaitMs })
  h.record = h.backchannel.mint({ sessionId: h.session.id, agent: h.agent, name: 'Step probe' })
  h.record.promptRunning = promptRunning
  h.call = () => h.backchannel.call(h.record, { name: 'bash', arguments: { command: 'echo probe' } })
  if (!guard) {
    h.record.guard.release()
    h.record.guard = undefined
  }
  let listeners = 0
  if (h.record.guard !== undefined) {
    const subscribe = h.record.guard.subscribe
    h.record.guard.subscribe = listener => {
      listeners += 1
      const off = subscribe(listener)
      return () => { listeners -= 1; off() }
    }
  }
  h.assertClean = () => {
    assert.equal(listeners, 0)
    assert.equal(h.record.controllers.size, 0)
    assert.equal(getEventListeners(h.record.abort.signal, 'abort').length, 0)
  }
  t.after(() => h.backchannel.dispose())
  h.startTurn()
  h.startStep()
  h.endStep()
  assert.equal(betweenSteps(h.session), true)
  return h
}

for (const level of ['full', 'manual']) {
  test(`${level}: a bridge call between steps runs in the next step`, async t => {
    const h = waitingHost(t, { level })
    const before = h.session.snapshotEvents()
    const pending = h.call()
    await ticks()
    assert.deepEqual(h.session.snapshotEvents(), before)
    assert.equal(h.record.controllers.size, 1)
    h.startStep()
    await ticks()
    if (level === 'manual') {
      assert.equal(h.asks.length, 1)
      assert.equal(h.bodies.length, 0)
      h.answer()
      await ticks()
    }
    assert.equal(h.bodies.length, 1)
    h.finish()
    assert.equal((await pending).isError, false)
    for (const type of ['assistant/message', 'tool/call', 'tool/result']) {
      assert.equal(eventsOf(h.session, type).length, 1)
      assert.equal(eventsOf(h.session, type)[0].data.step, 2)
      assert.equal(eventsOf(h.session, type)[0].data.turn, 1)
    }
    h.endStep()
    h.endTurn()
    h.assertClean()
    assertLoadable(h.session)
  })
}

// bridgeHost only supplies Full and Manual: Auto is in bridge-step-wait-auto.test.js.

for (const action of ['turn-end', 'timeout', 'not-running', 'no-callback', 'revoke', 'cancel']) {
  test(`a step wait ends without rows: ${action}`, async t => {
    const h = waitingHost(t, {
      stepWaitMs: action === 'timeout' ? 40 : 2_000,
      promptRunning: action === 'not-running' ? () => false : () => true,
    })
    if (action === 'no-callback') h.record.promptRunning = undefined
    const start = Date.now()
    const pending = h.call()
    if (action === 'turn-end') h.endTurn()
    if (action === 'revoke') h.backchannel.revoke(h.record)
    if (action === 'cancel') h.backchannel.cancel(h.record)
    const before = h.session.snapshotEvents()
    const answer = await pending
    if (action === 'revoke') assert.deepEqual(answer, { revoked: true })
    else assert.equal(answer.error.code, action === 'cancel' ? 'BRIDGE_CANCELLED' : 'BRIDGE_NO_STEP')
    if (action === 'timeout') assert.ok(Date.now() - start >= 30)
    else assert.ok(Date.now() - start < 1_000, 'the call does not wait for the bound')
    assert.deepEqual(h.session.snapshotEvents(), before)
    assert.equal(h.bodies.length, 0)
    h.assertClean()
    assertLoadable(h.session)
  })
}

test('without a guard, a step wait polls for the next step', async t => {
  const h = waitingHost(t, { guard: false })
  const pending = h.call()
  h.startStep()
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(h.bodies.length, 1)
  h.finish()
  assert.equal((await pending).isError, false)
  h.endStep()
  h.endTurn()
  h.assertClean()
  assertLoadable(h.session)
})

test('a committed batch wakes the call in its new step', async t => {
  const h = waitingHost(t)
  const pending = h.call()
  h.session.append([['step/start', { turn: 1, step: 2 }]])
  await ticks()
  assert.equal(h.bodies.length, 1)
  h.finish()
  assert.equal((await pending).isError, false)
  assert.equal(eventsOf(h.session, 'tool/call')[0].data.step, 2)
  h.assertClean()
  assertLoadable(h.session)
})

test('a batch ending the turn cannot move a waiting call to another turn', async t => {
  const h = waitingHost(t)
  const pending = h.call()
  h.session.append([
    ['turn/end', { turn: 1, reason: 'stop' }],
    ['turn/start', { turn: 2 }],
    ['step/start', { turn: 2, step: 1 }],
  ])
  const before = h.session.snapshotEvents()
  assert.equal((await pending).error.code, 'BRIDGE_NO_STEP')
  assert.deepEqual(h.session.snapshotEvents(), before)
  h.assertClean()
  assertLoadable(h.session)
})

test('an HTTP caller disconnecting during the step wait leaves no rows or waiter', async t => {
  const h = waitingHost(t)
  await h.backchannel.listen()
  const before = h.session.snapshotEvents()
  const req = request(h.backchannel.urlFor(h.record), {
    method: 'POST',
    headers: { authorization: `Bearer ${h.record.credential}`, 'content-type': 'application/json' },
  })
  req.on('error', () => {})
  t.after(() => req.destroy())
  req.end(JSON.stringify({ op: 'call', name: 'bash', arguments: {} }))
  const deadline = Date.now() + 1_000
  while (h.record.controllers.size === 0 && Date.now() < deadline) await ticks()
  assert.equal(h.record.calls, 1)
  assert.equal(h.record.controllers.size, 1)
  const drained = new Promise(resolve => { h.record.drained = resolve })
  req.destroy()
  await drained
  assert.equal(h.record.calls, 0)
  assert.deepEqual(h.session.snapshotEvents(), before)
  h.assertClean()
  assertLoadable(h.session)
})

test('cancel after step/start but before the waiting call resumes writes no rows', async t => {
  const h = waitingHost(t)
  const pending = h.call()
  h.startStep()
  h.backchannel.cancel(h.record)
  const before = h.session.snapshotEvents()
  assert.equal((await pending).error.code, 'BRIDGE_CANCELLED')
  assert.deepEqual(h.session.snapshotEvents(), before)
  h.assertClean()
  assertLoadable(h.session)
})
