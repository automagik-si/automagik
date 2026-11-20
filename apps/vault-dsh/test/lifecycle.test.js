import assert from 'node:assert/strict'
import { test } from 'node:test'
import { equalPrivate, fakeClock, fakeVault } from './fixtures/harness.mjs'

const locked = { ok: false, code: 'locked' }
const refused = { ok: false, code: 'refused' }

for (const [boundary, count] of [['--version', 2], ['status', 1], ['sync', 1], ['get', 1], ['list', 1]]) {
  test(`lock invalidates a command at the ${boundary} boundary`, async t => {
    const h = fakeVault(t)
    equalPrivate(await h.unlock(), { ok: true })
    h.configure({ pause: boundary })
    const pending = boundary === 'list' ? h.service.listItems({ connection: h.connection }) : h.service.read(h.ref)
    await h.waitFor(boundary, count)
    await h.service.lock()
    equalPrivate(await pending, locked)
    assert.equal(h.commands().at(-1), 'lock')
  })
}

for (const stop of ['lock', 'dispose', 'prepareQuit']) test(`${stop} cancels a partially created session`, async t => {
  const h = fakeVault(t, { pause: 'unlock' })
  const unlock = h.unlock()
  await h.waitFor('unlock')
  const stopped = h.service[stop]()
  equalPrivate(await h.service.read(h.ref), locked)
  equalPrivate(await unlock, locked)
  await stopped
  assert.deepEqual(h.commands(), ['--version', 'unlock', 'lock'])
  equalPrivate(await h.service.listItems({ connection: h.connection }), locked)
})

test('two reads serialize through get and see the rotation in order', async t => {
  const h = fakeVault(t, { pause: 'get' })
  equalPrivate(await h.unlock(), { ok: true })
  const first = h.service.read(h.ref)
  await h.waitFor('get')
  const second = h.service.read(h.ref)
  h.configure({ rotate: 'new' })
  assert.deepEqual(h.commands().slice(-4), ['--version', 'status', 'sync', 'get'])
  h.release()
  const a = await first
  const b = await second
  assert.equal(a.ok && a.value === h.value('old'), true)
  assert.equal(b.ok && b.value === h.value('new'), true)
  assert.deepEqual(h.commands().slice(-8), ['--version', 'status', 'sync', 'get', '--version', 'status', 'sync', 'get'])
})

test('a queued abort sends no child and an active abort sends no value or idle renewal', async t => {
  const timers = fakeClock()
  const h = fakeVault(t, { timers, idleLockMinutes: 1, pause: 'get' })
  equalPrivate(await h.unlock(), { ok: true })
  const active = new AbortController()
  const first = h.service.read(h.ref, { signal: active.signal })
  await h.waitFor('get')
  const queued = new AbortController()
  const second = h.service.read(h.ref, { signal: queued.signal })
  queued.abort()
  equalPrivate(await second, refused)
  timers.tick(59_000)
  active.abort()
  equalPrivate(await first, refused)
  timers.tick(1000)
  await h.waitFor('lock')
  assert.deepEqual(h.commands(), ['--version', 'unlock', '--version', 'status', 'sync', 'get', 'lock'])
})

test('only a successful field read extends the idle deadline', async t => {
  const timers = fakeClock()
  const h = fakeVault(t, { timers, idleLockMinutes: 1 })
  equalPrivate(await h.unlock(), { ok: true })
  timers.tick(59_000)
  const read = await h.service.read(h.ref)
  assert.equal(read.ok && read.value === h.value('old'), true)
  timers.tick(1000)
  assert.equal(h.commands().includes('lock'), false)
  assert.equal((await h.service.listItems({ connection: h.connection })).ok, true)
  timers.tick(59_000)
  await h.waitFor('lock')
  equalPrivate(await h.service.read(h.ref), locked)
})

test('a pending CLI lock blocks the next unlock and quit waits for close', async t => {
  const h = fakeVault(t)
  equalPrivate(await h.unlock(), { ok: true })
  h.configure({ pause: 'lock' })
  const locking = h.service.lock()
  await h.waitFor('lock')
  const next = h.unlock()
  let finished = false
  const quit = h.service.prepareQuit().then(result => { finished = true; return result })
  assert.deepEqual(h.commands(), ['--version', 'unlock', 'lock'])
  assert.equal(finished, false)
  h.release()
  await locking
  equalPrivate(await next, locked)
  equalPrivate(await quit, { ok: true })
  assert.deepEqual(h.commands(), ['--version', 'unlock', 'lock'])
})
