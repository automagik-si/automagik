import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { prepareRestart } from '../src/prepare-restart.js'
import { stopDsh } from '../src/dsh.js'

function childOf() {
  const child = new EventEmitter()
  Object.assign(child, { connected: true, pid: 1234, exitCode: null, signalCode: null, sent: [] })
  child.send = message => child.sent.push(message)
  return child
}
const reply = (child, result = { agents: 2, acp: 'done' }) => child.emit('message', {
  type: 'automagik:prepared-restart', id: child.sent[0].id, protocol: 1, result,
})
const clean = child => { for (const name of ['message', 'exit', 'disconnect']) assert.equal(child.listenerCount(name), 0, name) }

test('matching reply resolves, concurrent requests join, and foreign and late replies do nothing', async () => {
  const child = childOf()
  const first = prepareRestart(child, { reason: 'force' })
  assert.equal(prepareRestart(child, { reason: 'quit' }), first)
  assert.equal(child.sent.length, 1)
  assert.deepEqual(child.sent[0], { type: 'automagik:prepare-restart', id: child.sent[0].id, protocol: 1, reason: 'force' })
  let settled = false
  first.then(() => { settled = true })
  child.emit('message', { type: 'automagik:prepared-restart', id: 'another', result: 'foreign' })
  child.emit('message', { type: 'other', id: child.sent[0].id })
  await Promise.resolve()
  assert.equal(settled, false)
  reply(child)
  assert.deepEqual(await first, { ok: true, result: { agents: 2, acp: 'done' } })
  clean(child)
  reply(child, 'late')
  assert.deepEqual(await first, { ok: true, result: { agents: 2, acp: 'done' } })
})

test('timeout removes every listener and a later request has its own id', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const child = childOf()
  const first = prepareRestart(child, { reason: 'force' })
  t.mock.timers.tick(5999)
  assert.equal(child.listenerCount('message'), 1)
  t.mock.timers.tick(1)
  assert.deepEqual(await first, { ok: false, why: 'timeout' })
  clean(child)
  const next = prepareRestart(child, { reason: 'invalid' })
  assert.notEqual(child.sent[1].id, child.sent[0].id)
  assert.equal(child.sent[1].reason, 'restart')
  reply(child)
  child.emit('exit')
  assert.deepEqual(await next, { ok: false, why: 'exit' })
  clean(child)
})

test('missing child, missing IPC, exit, disconnect and failed send resolve without rejecting', async () => {
  assert.deepEqual(await prepareRestart(null), { ok: false, why: 'no-child' })
  for (const child of [{ connected: false }, { connected: true }]) {
    assert.deepEqual(await prepareRestart(child), { ok: false, why: 'no-ipc' })
  }
  for (const event of ['exit', 'disconnect']) {
    const child = childOf()
    const pending = prepareRestart(child)
    child.emit(event)
    assert.deepEqual(await pending, { ok: false, why: event === 'exit' ? 'exit' : 'no-ipc' })
    clean(child)
  }
  for (const send of [() => { throw Error('closed') }, (_, cb) => cb(Error('closed'))]) {
    const child = childOf()
    child.send = send
    assert.deepEqual(await prepareRestart(child), { ok: false, why: 'no-ipc' })
    clean(child)
  }
})

test('win32 preparation settles before the existing stop invokes taskkill', async () => {
  const child = childOf()
  const events = []
  const send = child.send
  child.send = message => { events.push('request'); send(message) }
  const stopping = (async () => {
    assert.equal((await prepareRestart(child, { reason: 'force' })).ok, true)
    events.push('prepared')
    await stopDsh(child, 6000, { platform: 'win32', run(file, args, options, cb) {
      assert.match(file, /taskkill\.exe$/)
      assert.deepEqual(args, ['/pid', '1234', '/T', '/F'])
      events.push('stop')
      child.emit('exit')
      cb(null)
    } })
  })()
  assert.deepEqual(events, ['request'])
  reply(child)
  await stopping
  assert.deepEqual(events, ['request', 'prepared', 'stop'])
  clean(child)
})
