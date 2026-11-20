// Temp dirs, made-up keys and fake endpoints. No bridge packages are needed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ask, forget, listen, startedAt, store, withLock, FILE, SOCKET, STATUS } from './devices.mjs'
import { keeper, resetKey, wipe } from './reset.mjs'
import { KEY } from './state.mjs'

const oldKey = Buffer.alloc(32, 1)
const newKey = Buffer.alloc(32, 2)
const generate = () => newKey
const stateFiles = [KEY, FILE, 'pairing.json']
const snapshot = dir => stateFiles.map(name => readFileSync(join(dir, name)))
const turnOff = {
  message: "This bridge can't change its key while it runs. Turn off Pocket Link, then press Reset key again.",
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pl-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, KEY), oldKey, { mode: 0o600 })
  writeFileSync(join(dir, 'pairing.json'), JSON.stringify({ code: 'old-code' }))
  const phones = store(join(dir, FILE))
  phones.add({ id: 'phone-a' })
  phones.add({ id: 'phone-b' })
  return dir
}

function wiped(dir) {
  assert.deepEqual(readFileSync(join(dir, KEY)), newKey)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, FILE))), [])
  for (const name of [KEY, FILE]) assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600)
  assert.deepEqual(readdirSync(dir).filter(name => name !== STATUS && name !== SOCKET).sort(), [FILE, KEY].sort())
}

function running(dir) {
  const pidStart = startedAt(process.pid)
  assert.ok(pidStart)
  writeFileSync(join(dir, STATUS), JSON.stringify({ pid: process.pid, pidStart }))
}

async function control(t, dir, handlers = {}) {
  const server = await listen(join(dir, SOCKET), handlers)
  t.after(() => new Promise(resolve => server.close(resolve)))
  running(dir)
}

test('wipe durably replaces the key, ends the code and clears the phone list', async (t) => {
  const dir = fixture(t)
  writeFileSync(join(dir, 'secret.key.123.tmp'), oldKey)
  assert.deepEqual(await wipe({ dir, generate }), { unpaired: 2 })
  wiped(dir)
  assert.deepEqual(await wipe({ dir, generate }), { unpaired: 0 })
  wiped(dir)
})

test('key generation failure leaves the key, phones and pairing code byte-equal', async (t) => {
  const dir = fixture(t)
  const before = snapshot(dir)
  await assert.rejects(wipe({ dir, generate: () => { throw new Error('generation failed') } }), /generation failed/)
  assert.deepEqual(snapshot(dir), before)
  assert.equal(existsSync(join(dir, 'devices.lock')), false)
})

test('reset with the bridge off changes the files', async (t) => {
  const dir = fixture(t)
  assert.deepEqual(await resetKey({ dir, generate }), { ok: true, via: 'file', unpaired: 2 })
  wiped(dir)
})

test('a stale bridge pid does not block a file reset', async (t) => {
  const dir = fixture(t)
  writeFileSync(join(dir, STATUS), JSON.stringify({ pid: process.pid, pidStart: 'old start time' }))
  assert.deepEqual(await resetKey({ dir, generate, started: () => 'new start time' }), { ok: true, via: 'file', unpaired: 2 })
  wiped(dir)
})

test('reset asks the running bridge once and leaves the files to it', async (t) => {
  const dir = fixture(t)
  const before = snapshot(dir)
  let calls = 0
  await control(t, dir, { reset: () => { calls++; return { unpaired: 2, id: 'new-address' } } })
  assert.deepEqual(await resetKey({ dir, generate }), { ok: true, via: 'bridge', unpaired: 2, id: 'new-address' })
  assert.equal(calls, 1)
  assert.deepEqual(snapshot(dir), before)
})

test('a running older bridge must be turned off before resetting', async (t) => {
  const dir = fixture(t)
  const before = snapshot(dir)
  await control(t, dir, { forget: () => false })
  await assert.rejects(resetKey({ dir, generate }), turnOff)
  assert.deepEqual(snapshot(dir), before)
})

test('a bridge running without a socket must be turned off before resetting', async (t) => {
  const dir = fixture(t)
  const before = snapshot(dir)
  running(dir)
  await assert.rejects(resetKey({ dir, generate }), turnOff)
  assert.deepEqual(snapshot(dir), before)
})

test('a bridge starting during the file reset adopts the same key', async (t) => {
  const dir = fixture(t)
  let adopted = 0, generated = 0
  const result = await resetKey({
    dir,
    generate: () => { generated++; return newKey },
    between: () => control(t, dir, {
      reset: () => assert.fail('late hand-off must use adopt'),
      adopt: () => { adopted++; wiped(dir); return { unpaired: 0, id: 'new-address' } },
    }),
  })
  assert.deepEqual(result, { ok: true, via: 'file', unpaired: 2 })
  assert.equal(adopted, 1)
  assert.equal(generated, 1)
  wiped(dir)
})

test('a failed late hand-off reports that the files changed', async (t) => {
  const dir = fixture(t)
  await assert.rejects(resetKey({
    dir, generate, between: () => control(t, dir, { adopt: () => { throw new Error('bind failed') } }),
  }), {
    message: 'Every phone was unpaired and the key changed, but a bridge that started meanwhile did not take the new key. Turn off Pocket Link and Turn on.',
  })
  wiped(dir)
})

test('a late bridge without a control socket also reports that the files changed', async (t) => {
  const dir = fixture(t)
  await assert.rejects(resetKey({ dir, generate, between: () => running(dir) }), /a bridge that started meanwhile did not take the new key/)
  wiped(dir)
})

test('control awaits the reset handler and sends its result', async (t) => {
  const dir = fixture(t)
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  await control(t, dir, { reset: async () => { entered.resolve(); return await release.promise } })
  const answer = ask(join(dir, SOCKET), { reset: true })
  await entered.promise
  release.resolve({ unpaired: 2, id: 'new-address' })
  assert.deepEqual(await answer, { ok: true, unpaired: 2, id: 'new-address' })
})

test('control reports a reset handler error', async (t) => {
  const dir = fixture(t)
  const before = snapshot(dir)
  await control(t, dir, { reset: async () => { throw new Error('bind failed') } })
  assert.deepEqual(await ask(join(dir, SOCKET), { reset: true }), { ok: false, error: 'bind failed' })
  await assert.rejects(resetKey({ dir, generate }), { message: 'bind failed' })
  assert.deepEqual(snapshot(dir), before)
})

test('a bridge that takes reset but gives no answer leaves the files untouched', async (t) => {
  const dir = fixture(t)
  const before = snapshot(dir)
  await control(t, dir, { reset: () => new Promise(() => {}) })
  await assert.rejects(resetKey({ dir, generate, timeout: 50 }), {
    message: 'The bridge did not answer, so the key may not have changed. Press Reset key again.',
  })
  assert.deepEqual(snapshot(dir), before)
})

test('control without a reset handler replies unknown request', async (t) => {
  const dir = fixture(t)
  await control(t, dir)
  assert.deepEqual(await ask(join(dir, SOCKET), { reset: true }), { ok: false, error: 'unknown request' })
})

test('the devices lock serializes changes and replaces an expired lock', async (t) => {
  const dir = fixture(t)
  const path = join(dir, 'devices.lock')
  writeFileSync(path, JSON.stringify({ pid: process.pid }))
  const expired = new Date(Date.now() - 31_000)
  utimesSync(path, expired, expired)
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const events = []
  const first = withLock(dir, async () => {
    events.push('first')
    entered.resolve()
    await release.promise
    events.push('release')
  })
  await entered.promise
  const second = withLock(dir, () => events.push('second'))
  try {
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.deepEqual(events, ['first'])
  } finally { release.resolve() }
  await Promise.all([first, second])
  assert.deepEqual(events, ['first', 'release', 'second'])
  assert.equal(existsSync(path), false)
})

test('file-based forget waits for the same lock used by reset', async (t) => {
  const dir = fixture(t)
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const holding = withLock(dir, async () => { entered.resolve(); await release.promise })
  await entered.promise
  const removal = forget({ dir, id: 'phone-a' })
  try {
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.deepEqual(store(join(dir, FILE)).list().map(phone => phone.id), ['phone-a', 'phone-b'])
  } finally { release.resolve() }
  await holding
  assert.deepEqual(await removal, { ok: true, removed: true, via: 'file' })
  assert.deepEqual(store(join(dir, FILE)).list().map(phone => phone.id), ['phone-b'])
})

const endpoint = (id, events) => ({ id, close: async () => { events.push(`close ${id}`) } })

test('keeper skips an unchanged key and shares a check for a changed one', async () => {
  let disk = oldKey
  const events = []
  const keys = keeper({
    read: () => disk,
    bind: bytes => { events.push(`bind ${bytes[0]}`); return endpoint(bytes[0], events) },
    swapped: (ep, old) => events.push(`swap ${old.id} to ${ep.id}`),
  })
  const initial = await keys.start()
  assert.equal(await keys.ensure(), initial)
  assert.deepEqual(events, ['bind 1'])
  disk = newKey
  const check = keys.ensure()
  assert.equal(keys.ensure(), check)
  assert.equal((await check).id, 2)
  assert.deepEqual(events, ['bind 1', 'bind 2', 'swap 1 to 2', 'close 1'])
  assert.equal(keys.current().id, 2)
  assert.equal(keys.rotating, false)
})

test('keeper uses the bytes it read before the initial bind completed', async () => {
  let disk = oldKey
  const events = []
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const keys = keeper({
    read: () => disk,
    bind: async bytes => {
      if (bytes[0] === 1) { entered.resolve(); await release.promise }
      return endpoint(bytes[0], events)
    },
    swapped: () => {},
  })
  const starting = keys.start()
  await entered.promise
  disk = newKey
  release.resolve()
  assert.equal((await starting).id, 1)
  assert.equal((await keys.ensure()).id, 2)
  assert.deepEqual(events, ['close 1'])
})

test('rotate wipes before binding and closes the old endpoint after swapping', async () => {
  let disk = oldKey
  const events = []
  const keys = keeper({
    read: () => disk,
    bind: bytes => { events.push(`bind ${bytes[0]}`); return endpoint(bytes[0], events) },
    swapped: ep => { assert.equal(keys.current(), ep); events.push('swap') },
  })
  await keys.start()
  const result = await keys.rotate(() => {
    assert.equal(keys.rotating, true)
    events.push('wipe')
    disk = newKey
    return { unpaired: 2 }
  })
  assert.deepEqual(result, { unpaired: 2 })
  assert.deepEqual(events, ['bind 1', 'wipe', 'bind 2', 'swap', 'close 1'])
})

test('a failed bind leaves pairing blocked and ensure retries', async () => {
  let disk = oldKey, fail = true
  const events = []
  const keys = keeper({
    read: () => disk,
    bind: bytes => {
      if (bytes[0] === 2 && fail) throw new Error('bind failed')
      return endpoint(bytes[0], events)
    },
    swapped: () => {},
  })
  const initial = await keys.start()
  await assert.rejects(keys.rotate(() => { disk = newKey }), /bind failed/)
  assert.equal(keys.current(), initial)
  assert.equal(keys.rotating, true)
  assert.deepEqual(events, [])
  fail = false
  assert.equal((await keys.ensure()).id, 2)
  assert.equal(keys.rotating, false)
  assert.deepEqual(events, ['close 1'])
})

test('a failed swap hook still closes the retired endpoint', async () => {
  let disk = oldKey
  const events = []
  const keys = keeper({
    read: () => disk,
    bind: bytes => { events.push(`bind ${bytes[0]}`); return endpoint(bytes[0], events) },
    swapped: () => { throw new Error('publish failed') },
  })
  await keys.start()
  await assert.rejects(keys.rotate(() => { disk = newKey }), /publish failed/)
  assert.equal(keys.current().id, 2)
  await keys.ensure()
  assert.deepEqual(events, ['bind 1', 'bind 2', 'close 1'])
})

test('accept continues on the new endpoint when closing the old one returns null', async () => {
  let disk = oldKey
  const waiting = Promise.withResolvers()
  const incoming = {}
  const replies = [incoming, null]
  const keys = keeper({
    read: () => disk,
    bind: bytes => bytes[0] === 1
      ? { acceptNext: () => waiting.promise, close: () => waiting.resolve(null) }
      : { acceptNext: async () => replies.shift() },
    swapped: () => {},
  })
  await keys.start()
  const accepting = keys.accept()
  await keys.rotate(() => { disk = newKey })
  assert.equal(await accepting, incoming)
  assert.equal(await keys.accept(), null)
})
