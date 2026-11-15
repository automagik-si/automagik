import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { watchRestart } from '../src/host/restart.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture({ agents = [], acp } = {}) {
  const proc = new EventEmitter(), replies = [], cleanups = []
  proc.send = message => replies.push(message)
  const ctx = { get: name => name === 'agents' ? { list: () => agents } : acp,
    effect: setup => cleanups.push(setup()) }
  const send = (patch = {}) => proc.emit('message', { type: 'automagik:prepare-restart', id: 'one', protocol: 1, reason: 'force', ...patch })
  return { proc, ctx, replies, cleanups, send }
}

test('running agents are intentionally cancelled, ACP drains, and concurrent requests share preparation', async () => {
  const stopped = []
  let drains = 0
  const h = fixture({ agents: [
    { status: 'running', cancel: options => stopped.push(options) },
    { status: 'idle', cancel: () => assert.fail('idle') },
  ], acp: { prepareRestart: async () => { drains++; return { ok: true } } } })
  watchRestart(h.ctx, { proc: h.proc })
  h.send(); h.send({ id: 'two' })
  await tick()
  assert.deepEqual(stopped, [{ kind: 'hook', reason: 'ds-bot/stopped' }])
  assert.equal(drains, 1)
  assert.deepEqual(h.replies, ['one', 'two'].map(id => ({ type: 'automagik:prepared-restart', id, protocol: 1, result: { agents: 1, acp: 'done' } })))
  h.cleanups[0]()
  assert.equal(h.proc.listenerCount('message'), 0)
})

test('old ACP is absent, a failing drain is partial, and invalid requests are ignored', async () => {
  for (const [acp, expected] of [[undefined, 'absent'], [{}, 'absent'], [{ prepareRestart: async () => ({ ok: false }) }, 'partial'], [{ prepareRestart: () => { throw Error('stop') } }, 'partial']]) {
    const h = fixture({ acp })
    watchRestart(h.ctx, { proc: h.proc })
    for (const patch of [{ protocol: 2 }, { reason: 'unknown' }, { id: 42 }, { type: 'another' }]) h.send(patch)
    await tick()
    assert.equal(h.replies.length, 0)
    h.send()
    await tick()
    assert.deepEqual(h.replies[0].result, { agents: 0, acp: expected })
    h.cleanups[0]()
  }
})

test('the whole preparation has a five-second bound and sends no late reply after disposal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = fixture({ acp: { prepareRestart: () => new Promise(() => {}) } })
  watchRestart(h.ctx, { proc: h.proc })
  h.send()
  t.mock.timers.tick(4999)
  await tick()
  assert.equal(h.replies.length, 0)
  t.mock.timers.tick(1)
  await tick()
  assert.deepEqual(h.replies[0].result, { agents: 0, acp: 'timeout' })
  h.cleanups[0]()
  const other = fixture({ agents: [{ status: 'running', cancel: () => new Promise(() => {}) }] })
  watchRestart(other.ctx, { proc: other.proc })
  other.send()
  other.cleanups[0]()
  t.mock.timers.tick(5000)
  await tick()
  assert.equal(other.replies.length, 0)
})

test('without child IPC nothing is installed', () => {
  const h = fixture()
  delete h.proc.send
  watchRestart(h.ctx, { proc: h.proc })
  assert.equal(h.proc.listenerCount('message'), 0)
  assert.equal(h.cleanups.length, 0)
})
