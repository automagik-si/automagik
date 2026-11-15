import assert from 'node:assert/strict'
import test from 'node:test'
import { assertLoadable, bridgeHost, eventsOf, ticks } from './support/bridge-host.js'

for (const [label, callId, kept] of [
  ['ordinary', 'caller.A_1:-ok', true],
  ['too long', 'x'.repeat(129), false],
  ['space', 'caller with space', false],
  ['newline', 'caller\nnewline', false],
  ['non-string', { caller: 'non-string-caller' }, false],
  ['mirror namespace', 'acp_caller', false],
]) {
  test(`bridge call identity: ${label}`, async t => {
    const h = bridgeHost()
    t.after(() => h.backchannel.dispose())
    h.mint()
    h.startTurn()
    h.startStep()
    const answer = h.call({ callId })
    await ticks()
    assert.equal(h.bodies.length, 1)
    const id = h.bodies[0].call.id
    if (kept) assert.equal(id, callId)
    else assert.match(id, /^bridge_[0-9a-f]{16}$/)
    h.finish()
    assert.equal((await answer).isError, false)
    const adverts = eventsOf(h.session, 'assistant/message')
      .flatMap(event => event.data.message.content).filter(block => block.type === 'tool-call')
    assert.deepEqual(adverts.map(block => block.id), [id])
    assert.deepEqual(eventsOf(h.session, 'tool/call').map(event => event.data.callId), [id])
    assert.deepEqual(eventsOf(h.session, 'tool/result').map(event => event.data.message.toolCallId), [id])
    h.endStep()
    h.endTurn()
    assertLoadable(h.session)
    if (!kept) {
      assert.equal(JSON.stringify(h.session.snapshotEvents()).includes(JSON.stringify(callId)), false)
      assert.equal(h.logs.length, 1)
      assert.ok(h.logs[0].includes(JSON.stringify(callId)))
      assert.ok(h.logs[0].includes(id))
    } else assert.deepEqual(h.logs, [])
  })
}
