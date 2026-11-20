import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createAdapter } from '../src/host/pocket-chat-adapter.js'
import {
  ADMISSION_MS, ATTACH_METHODS, CHUNK_BYTES, DAY_MS, IDLE_MS, PocketUploads, READ_LINE_BYTES, READ_MS,
  TOTAL_MS, UNSENT_MS, UploadLedger, effectiveAttachments, sanitizeAttachmentName, sha256,
} from '../src/host/pocket-attach.js'
import { DshChatSource, PAGE_BYTES, TEXT_MAX, rowIdOf, rowsOf } from '../src/host/pocket-chat.js'
import { METHODS, WRITE_METHODS, writeLimits } from '../src/host/pocket-socket.js'
import { deferred, feed, fixturePng, memoryWire, uploadWire, watchWire } from './support/pocket-upload-admission.js'

const MiB = 1024 * 1024
const phone = 'phone-a'
const bind = { phone, channel: 1, upload: 'upload' }
const sample = fixturePng()
const text = text => ({ type: 'text', text })
const image = { type: 'image', attachment: { attachmentId: 'opaque-image', mediaType: 'image/png', width: 32, height: 24 } }
const event = (seq, content, source = 'user') => ({ type: 'user/message', seq, time: seq, data: { role: 'user', source: { kind: source }, content } })
const tick = () => new Promise(resolve => setImmediate(resolve))
const reason = async (promise, expected) => assert.equal((await promise).reason, expected)
const currentLimits = () => ({ mediaTypes: ['image/gif', 'image/png', 'image/jpeg', 'image/webp'],
  maxImageBytes: 50 * MiB, maxImagesPerMessage: 20, maxMessageImageBytes: 100 * MiB, maxImagePixels: 64e6, maxImageDimension: 65535 })
const fakeClock = () => {
  let now = 1
  let id = 0
  const timers = new Map()
  return {
    now: () => now,
    setTimeout(run, ms) { timers.set(++id, { at: now + ms, run }); return id },
    clearTimeout(id) { timers.delete(id) },
    advance(ms) {
      const until = now + ms
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        const [id, { at, run }] = next
        now = at
        timers.delete(id)
        run()
      }
      now = until
    },
  }
}

function scratch(t) {
  const home = mkdtempSync(join(tmpdir(), 'pocket-attach-'))
  mkdirSync(join(home, 'pocket'), { mode: 0o700 })
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return home
}

function fake(t, options = {}) {
  const home = options.home ?? scratch(t)
  const logs = []
  const log = (...args) => logs.push(args)
  const clock = fakeClock()
  const registry = new PocketUploads({ home, log, now: clock.now, clock, statfs: options.statfs ?? (() => ({ bavail: 8n * 1024n, bsize: BigInt(MiB) })) })
  const bots = [{ id: 'a', sessionId: 'a' }, { id: 'b', sessionId: 'b' }]
  const sessions = { a: [], b: [] }
  const followers = new Map()
  const calls = { uploads: [], prompts: [], insertions: [], reads: [], events: [] }
  const faults = {}
  const runtime = { shown: true, services: true }
  const seen = new Set()
  const controller = {
    follow({ address: { sessionId } }, signal) {
      const stream = feed(signal)
      followers.set(sessionId, stream)
      const events = sessions[sessionId]
      stream.push({ type: 'snapshot', cursor: events.at(-1)?.seq ?? -1, records: events.map(event => ({ event })) })
      return stream
    },
    async events({ address: { sessionId }, beforeSeq, maxMessages }) {
      calls.events.push({ sessionId, beforeSeq, maxMessages })
      if (faults.events) return faults.events()
      const page = sessions[sessionId].filter(event => event.seq < beforeSeq)
      return { records: page.slice(-maxMessages).map(event => ({ event })) }
    },
    async state() { await faults.state?.(); return { running: false } },
    observeState(_request, signal) { return feed(signal) },
    async prompt(request, signal) {
      calls.prompts.push(request)
      if (faults.prompt) return faults.prompt(request, signal)
      if (!seen.has(request.requestId)) {
        seen.add(request.requestId)
        calls.insertions.push(request)
      }
      return { accepted: true }
    },
    cancel() {},
  }
  const store = { imageLimits: currentLimits(), async readImageRequest(ref, target, signal) {
    calls.reads.push({ ref, target, signal })
    if (faults.read) return faults.read(ref, target, signal)
    return { data: sample, mediaType: 'image/png', width: 32, height: 24 }
  } }
  const fileUploads = { async uploadImageStream(request) {
    calls.uploads.push(request)
    if (faults.upload) return faults.upload(request)
    for await (const chunk of request.data) assert.ok(chunk.length > 0)
    return { receiptId: `receipt-${calls.uploads.indexOf(request)}`, image: { mediaType: 'image/png', width: 32, height: 24, bytes: sample.length } }
  } }
  const source = new DshChatSource({
    adapter: createAdapter(controller), writable: true, bots: async () => { await faults.bots?.(); return bots },
    shown: () => runtime.shown, log, fileUploads: () => runtime.services ? fileUploads : undefined,
    attachmentStore: () => store, management: { enabled: () => true },
    carriesSignInCode: value => value.includes('sign-in-token'),
  })
  t.after(() => source.close())
  const limits = writeLimits(clock.now)
  const client = (host = registry) => {
    const client = memoryWire(source, host, log, limits)
    t.after(client.stop)
    return client
  }
  const append = (ev, id = 'a') => {
    sessions[id].push(ev)
    followers.get(id)?.push({ type: 'event', event: ev })
  }
  return { bots, calls, client, clock, faults, home, log, logs, registry, runtime, source, store, sessions, append }
}

const begin = (c, extra = {}) => c.request('upload-begin', { ...bind, mediaType: 'image/png', bytes: sample.length, ...extra })
const chunk = (c, data = sample, extra = {}) => c.request('upload-chunk', { ...bind, offset: 0, data: data.toString('base64'), ...extra })
const finish = (c, extra = {}) => c.request('upload-finish', { ...bind, ...extra })
const cancel = (c, extra = {}) => c.request('upload-cancel', { ...bind, ...extra })
const send = (c, extra = {}) => c.request('send', { phone, channel: 1, id: 'message', uploads: [bind.upload], ...extra })
const read = (c, extra = {}) => c.request('attachment-read', { phone, channel: 1, row: 'dsh:a:1', block: 0, ...extra })

test('hello preserves legacy bytes, intersects limits, and keeps the watch across a matching manage hello', async t => {
  const h = fake(t)
  const c = h.client()
  const readOnly = { protocol: 1, readOnly: true, methods: METHODS }
  const write = { protocol: 1, readOnly: false, write: 1, methods: [...METHODS, ...WRITE_METHODS], dedupe: 'log' }
  assert.deepEqual(await c.request('hello', { attachments: 1 }), readOnly)
  assert.deepEqual(await c.request('hello', { write: 1 }), write)
  assert.equal(c.lines.at(-1), JSON.stringify({ id: 2, result: write }))
  assert.equal((await begin(c)).kind, 'read-only')
  await reason(send(c, { text: 'never sent alone' }), 'invalid')
  assert.equal(h.calls.prompts.length, 0)
  h.runtime.services = false
  assert.deepEqual(await c.request('hello', { write: 1, attachments: 1 }), write)
  h.runtime.services = true
  h.store.imageLimits.maxMessageImageBytes = 96
  h.store.imageLimits.maxImagesPerMessage = 2
  h.store.imageLimits.maxImagePixels = 8888
  h.store.imageLimits.maxImageDimension = 200
  h.store.imageLimits.mediaTypes = ['image/gif', 'image/png']
  const hello = await c.request('hello', { write: 1, attachments: 1 })
  assert.deepEqual(hello, { ...write, methods: [...write.methods, ...ATTACH_METHODS], attachments: {
    version: 1, methods: ATTACH_METHODS, mediaTypes: ['image/png'], limits: { fileBytes: 96, files: 2, messageBytes: 96,
      deviceOutstanding: 32 * MiB, deviceDailyBytes: 256 * MiB, deviceDailyCount: 128, chunkBytes: CHUNK_BYTES,
      maxPixels: 8888, maxDimension: 200, thumbnail: { edge: 512, bytes: 128 * 1024 } },
  } })
  await c.request('subscribe', { terminal: 'dsh:a', channel: 1, attachments: 1 })
  assert.equal((await begin(c)).state, 'open')
  const manage = await c.request('hello', { write: 1, attachments: 1, manage: 1 })
  assert.deepEqual(manage.attachments, hello.attachments)
  assert.equal(manage.manage, 1)
  assert.equal((await chunk(c)).received, sample.length)
  assert.equal((await finish(c)).state, 'admitted')
  h.store.imageLimits.mediaTypes = ['image/gif']
  assert.deepEqual(await c.request('hello', { write: 1, attachments: 1 }), write)
  assert.equal((await begin(c)).kind, 'read-only')
  assert.equal(effectiveAttachments({ ...currentLimits(), maxImagesPerMessage: 0 }), undefined)
})

test('begin validates name, id, MIME and bytes, then reserves phone and host before awaiting authority', async t => {
  const h = fake(t)
  const a = h.client()
  const b = h.client()
  await watchWire(a)
  await watchWire(b)
  await reason(begin(a, { channel: 7 }), 'not-watching')
  await reason(begin(a, { phone: 'name with spaces' }), 'read-only')
  await reason(begin(a, { name: null }), 'invalid')
  await reason(begin(a, { upload: 'invalid/id' }), 'invalid')
  await reason(begin(a, { mediaType: 'image/gif' }), 'unsupported')
  for (const bytes of [0, 1.1, 8 * MiB + 1]) await reason(begin(a, { bytes }), 'too-large')
  const gate = deferred()
  h.faults.bots = () => gate.promise
  const pending = begin(a)
  await reason(begin(b, { upload: 'same-phone' }), 'busy')
  await reason(begin(b, { phone: 'another-phone', upload: 'another-phone' }), 'busy')
  assert.equal(h.calls.uploads.length, 0)
  gate.resolve()
  assert.equal((await pending).state, 'open')
  await reason(begin(a), 'invalid')
  assert.ok(!Object.hasOwn(h.calls.uploads[0], 'name'))
  assert.equal(h.calls.uploads[0].sessionId, 'a')
  assert.equal((await cancel(a)).ok, true)
  await tick()
  const records = new Map(Array.from({ length: 4 }, (_, i) => [`u${i}`, { state: 'admitted', bytes: 8 * MiB }]))
  h.registry.records.set(sha256(phone), records)
  await reason(begin(a), 'quota')
})

test('ledger charges encoded bytes and counts before DSH, persists, prunes and evicts only stale phones', async t => {
  const h = fake(t)
  const c = h.client()
  await watchWire(c)
  const path = join(h.home, 'pocket', 'uploads.json')
  h.faults.upload = async ({ data }) => {
    const recorded = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(recorded.phones[sha256(phone)].charges, [{ at: 1, bytes: sample.length }])
    for await (const chunk of data) assert.ok(chunk.length > 0)
  }
  assert.equal((await begin(c)).ok, true)
  await cancel(c)
  await tick()
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.ok(!readFileSync(path, 'utf8').includes(phone))
  const ledger = new UploadLedger(path, h.clock.now, h.log)
  for (let i = 1; i < 128; i++) assert.equal(ledger.charge(sha256(phone), 1), undefined)
  const next = new UploadLedger(path, h.clock.now, h.log)
  assert.equal(next.charge(sha256(phone), 1), 'quota')
  const other = sha256('other')
  for (let i = 0; i < 32; i++) assert.equal(next.charge(other, 8 * MiB), undefined)
  assert.equal(next.charge(other, 1), 'quota')
  for (let i = 0; i < 62; i++) next.charge(sha256(`other-${i}`), 1)
  assert.equal(next.charge(sha256('65th'), 1), 'quota')
  h.clock.advance(DAY_MS)
  assert.equal(next.charge(sha256('65th'), 1), undefined)
  assert.equal(Object.keys(next.load().phones).length, 64)
  assert.equal(Object.values(next.load().phones).flatMap(p => p.charges).length, 1)
})

test('ledger enforces host byte/count caps, quarantines corruption and checks disk headroom', async t => {
  const home = scratch(t)
  const path = join(home, 'pocket', 'uploads.json')
  const clock = fakeClock()
  for (const [amount, count] of [[8 * MiB, 32], [1, 128]]) {
    rmSync(path, { force: true })
    const ledger = new UploadLedger(path, clock.now, () => {})
    for (let device = 0; device < 4; device++) {
      for (let i = 0; i < count; i++) assert.equal(ledger.charge(sha256(`device${device}`), amount), undefined)
    }
    assert.equal(ledger.charge(sha256('fifth'), 1), 'quota')
  }
  writeFileSync(path, 'corrupt-ledger')
  const checked = []
  const h = fake(t, { home, statfs: root => {
    checked.push(root)
    if (root !== home) throw new Error('missing')
    return { bavail: 2049n, bsize: BigInt(MiB) }
  } })
  h.store.root = '/missing-dsh-storage'
  const c = h.client()
  await watchWire(c)
  await reason(begin(c), 'quota')
  assert.deepEqual(checked, [h.store.root, home])
  assert.equal(readFileSync(`${path}.bad`, 'utf8'), 'corrupt-ledger')
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).brokenAt, 1)
  assert.equal(new UploadLedger(path, h.clock.now, h.log).charge(sha256(phone), 1), 'quota')
  assert.deepEqual(h.logs, [['pocket upload: ledger unreadable']])
  assert.equal((await c.request('send', { channel: 1, phone, id: 'text', text: 'still works' })).ok, true)
  h.clock.advance(DAY_MS)
  await reason(begin(c, { bytes: 8 * MiB }), 'quota')
  assert.equal((await begin(c)).ok, true)
})

test('failed ledger writes block both new admissions and prompts while text remains usable', async t => {
  const h = fake(t)
  const c = h.client()
  await watchWire(c)
  const save = h.registry.ledger.save.bind(h.registry.ledger)
  h.registry.ledger.save = () => { throw new Error('disk failure') }
  await reason(begin(c), 'unavailable')
  assert.equal(h.calls.uploads.length, 0)
  h.registry.ledger.save = save
  assert.equal((await uploadWire(c, sample)).state, 'admitted')
  h.registry.ledger.save = () => { throw new Error('disk failure') }
  await reason(send(c), 'unavailable')
  assert.equal(h.calls.prompts.length, 0)
  assert.ok(h.registry.find(sha256(phone), bind.upload))
  assert.equal((await c.request('send', { channel: 1, phone, id: 'legacy', text: 'hello' })).ok, true)
})

test('chunks enforce offsets, sizes, canonical base64, declared bytes and image headers', async t => {
  const h = fake(t)
  const c = h.client()
  await watchWire(c)
  const png = Buffer.from(sample)
  png.writeUInt32BE(6401, 16)
  png.writeUInt32BE(6250, 20)
  const jpeg = Buffer.from('ffd8ffc0000b081770000101011100', 'hex')
  const webp = Buffer.from('524946461600000057454250565038580a00000000000000401f00401f00', 'hex')
  const noSOF = Buffer.alloc(3 * CHUNK_BYTES)
  noSOF.set(Buffer.from('ffd8ffe0ffff', 'hex'))
  const cases = [
    [{}, sample, { offset: 1 }, 'invalid'],
    [{ bytes: CHUNK_BYTES + 1 }, sample, {}, 'invalid'],
    [{ bytes: sample.length - 1 }, sample, {}, 'invalid'],
    [{}, sample, { data: sample.toString('base64').replace(/=$/, '') + '\n' }, 'invalid'],
    [{ bytes: 33 }, Buffer.from('<svg onload="text"></svg>'.padEnd(33)), {}, 'unsupported'],
    [{ bytes: 33 }, Buffer.from('<html>not an image</html>'.padEnd(33)), {}, 'unsupported'],
    [{ bytes: png.length }, png, {}, 'too-large'],
    [{ mediaType: 'image/jpeg', bytes: jpeg.length }, jpeg, {}, 'too-large'],
    [{ mediaType: 'image/webp', bytes: webp.length }, webp, {}, 'too-large'],
    [{ mediaType: 'image/webp', bytes: 12 }, Buffer.from('RIFF0000WEBP'), {}, 'unsupported'],
  ]
  h.store.imageLimits.maxImageDimension = 5900
  for (const [options, data, params, why] of cases) {
    assert.equal((await begin(c, options)).state, 'open')
    await reason(chunk(c, data, params), why)
    await tick()
    await reason(finish(c), why)
  }
  assert.equal((await begin(c, { mediaType: 'image/jpeg', bytes: noSOF.length })).ok, true)
  for (let offset = 0; offset < 2 * CHUNK_BYTES; offset += CHUNK_BYTES) {
    assert.equal((await chunk(c, noSOF.subarray(offset, offset + CHUNK_BYTES), { offset })).ok, true)
  }
  await reason(chunk(c, noSOF.subarray(2 * CHUNK_BYTES), { offset: 2 * CHUNK_BYTES }), 'unsupported')
})

test('one chunk credit requires the next iterator pull, including before finish, and rejects pipelining', async t => {
  const h = fake(t)
  const c = h.client()
  await watchWire(c)
  const work = deferred()
  h.faults.upload = () => work.promise
  await begin(c)
  const first = chunk(c)
  await reason(chunk(c, sample, { offset: sample.length }), 'invalid')
  await reason(first, 'invalid')
  assert.equal(h.calls.uploads[0].signal.aborted, true)
  await reason(begin(c), 'busy')
  work.resolve()
  await tick()
  const admission = deferred()
  h.faults.upload = () => admission.promise
  await begin(c)
  const reader = h.calls.uploads.at(-1).data
  let acknowledged = false
  const ack = chunk(c).then(reply => { acknowledged = true; return reply })
  assert.deepEqual((await reader.next()).value, sample)
  assert.equal(acknowledged, false)
  await reason(finish(c), 'invalid')
  const eof = reader.next()
  assert.equal((await ack).received, sample.length)
  const firstFinish = finish(c)
  const secondFinish = finish(c)
  assert.equal((await eof).done, true)
  await cancel(c)
  await reason(firstFinish, 'expired')
  await reason(secondFinish, 'expired')
  admission.resolve()
})

test('foreign phones, watches and channels cannot alter an upload, and reused channels have new ownership', async t => {
  const h = fake(t)
  const a = h.client()
  const b = h.client()
  await watchWire(a)
  await watchWire(b)
  await a.request('subscribe', { terminal: 'dsh:b', channel: 2, attachments: 1 })
  assert.equal((await begin(a)).ok, true)
  await reason(chunk(b), 'invalid')
  await reason(chunk(a, sample, { channel: 2 }), 'invalid')
  await reason(chunk(a, sample, { phone: 'stranger' }), 'invalid')
  await reason(finish(b), 'invalid')
  await reason(finish(a, { phone: 'stranger' }), 'invalid')
  await reason(cancel(b), 'invalid')
  assert.equal((await cancel(a, { phone: 'stranger' })).ok, true)
  await a.request('unsubscribe', { channel: 2 })
  assert.equal((await chunk(a)).received, sample.length)
  assert.equal((await finish(a)).state, 'admitted')
  await reason(send(b), 'invalid')
  await reason(send(a, { phone: 'stranger' }), 'expired')
  await a.request('unsubscribe', { channel: 1 })
  await a.request('subscribe', { terminal: 'dsh:a', channel: 1, attachments: 1 })
  await reason(send(a), 'expired')
  await reason(finish(a), 'invalid')
  await begin(a)
  a.halfClose()
  assert.equal(h.calls.uploads.at(-1).signal.aborted, true)
  assert.equal(h.registry.records.size, 0)
})

test('another subscribed channel cannot finish, cancel or send the owners upload', async t => {
  const h = fake(t)
  const c = h.client()
  await watchWire(c)
  await c.request('subscribe', { terminal: 'dsh:b', channel: 2, attachments: 1 })
  assert.equal((await begin(c)).state, 'open')
  await reason(finish(c, { channel: 2 }), 'invalid')
  await reason(cancel(c, { channel: 2 }), 'invalid')
  assert.equal((await chunk(c)).received, sample.length)
  assert.equal((await finish(c)).state, 'admitted')
  await reason(send(c, { channel: 2 }), 'invalid')
  assert.equal(h.calls.prompts.length, 0)
  assert.equal((await send(c)).ok, true)
})

test('idle, total, admission and unsent timers release records while DSH retains its slot until settlement', async t => {
  const h = fake(t)
  const c = h.client()
  await watchWire(c)
  const dsh = deferred()
  h.faults.upload = () => dsh.promise
  await begin(c)
  const ack = chunk(c)
  h.clock.advance(IDLE_MS)
  assert.equal((await ack).code, 'timeout')
  assert.equal(h.calls.uploads[0].signal.aborted, true)
  await reason(begin(c), 'busy')
  dsh.resolve()
  await tick()

  delete h.faults.upload
  const large = Buffer.alloc(10 * CHUNK_BYTES)
  sample.copy(large)
  await begin(c, { bytes: large.length })
  for (let offset = 0; h.clock.now() < IDLE_MS + TOTAL_MS - 1; offset += CHUNK_BYTES) {
    h.clock.advance(25_000)
    if (h.clock.now() >= IDLE_MS + TOTAL_MS) break
    assert.equal((await chunk(c, large.subarray(offset, offset + CHUNK_BYTES), { offset })).ok, true)
  }
  assert.equal((await finish(c)).code, 'timeout')
  await tick()

  const stalled = deferred()
  h.faults.upload = async ({ data }) => {
    for await (const chunk of data) assert.ok(chunk.length > 0)
    return stalled.promise
  }
  await uploadWire(c, sample, { finish: false })
  const finishing = finish(c)
  await tick()
  h.clock.advance(ADMISSION_MS)
  assert.equal((await finishing).code, 'timeout')
  await reason(begin(c), 'busy')
  stalled.resolve()
  await tick()
  delete h.faults.upload
  assert.equal((await uploadWire(c, sample)).ok, true)
  h.clock.advance(UNSENT_MS)
  await reason(send(c), 'expired')
  assert.equal(h.registry.records.size, 0)
})

test('timeouts settle begin and finish while authority is still pending', async t => {
  const h = fake(t)
  const c = h.client()
  await watchWire(c)
  const gate = deferred()
  h.faults.bots = () => gate.promise
  const starting = begin(c)
  h.clock.advance(IDLE_MS)
  assert.equal((await starting).code, 'timeout')
  assert.equal(h.calls.uploads.length, 0)
  gate.resolve()
  delete h.faults.bots
  await uploadWire(c, sample, { finish: false })
  const finishGate = deferred()
  h.faults.bots = () => finishGate.promise
  const finishing = finish(c)
  h.clock.advance(TOTAL_MS)
  assert.equal((await finishing).code, 'timeout')
  assert.equal(h.calls.uploads[0].signal.aborted, true)
  assert.equal(h.registry.records.size, 0)
  finishGate.resolve()
})

test('authority is checked before DSH starts, before EOF, after admission, and immediately before send', async t => {
  const h = fake(t)
  const c = h.client()
  await watchWire(c)
  h.runtime.shown = false
  await reason(begin(c), 'not-shown')
  assert.equal(h.calls.uploads.length, 0)
  assert.deepEqual(h.registry.ledger.load(), { phones: {} })
  h.runtime.shown = true
  await uploadWire(c, sample, { finish: false })
  h.runtime.shown = false
  await reason(finish(c), 'not-shown')
  await tick()
  h.runtime.shown = true
  const admission = deferred()
  const storage = deferred()
  h.faults.upload = async ({ data }) => {
    for await (const chunk of data) assert.ok(chunk.length > 0)
    storage.resolve()
    return admission.promise
  }
  await uploadWire(c, sample, { finish: false })
  const pending = finish(c)
  await storage.promise
  h.runtime.shown = false
  admission.resolve({ receiptId: 'unused', image: { ...image.attachment, bytes: 1 } })
  await reason(pending, 'not-shown')
  assert.equal(h.registry.records.size, 0)
  h.runtime.shown = true
  delete h.faults.upload
  assert.equal((await uploadWire(c, sample)).ok, true)
  h.faults.state = async () => { h.runtime.shown = false }
  await reason(send(c), 'not-shown')
  assert.equal(h.calls.prompts.length, 0)
  assert.equal(h.registry.records.size, 0)
})

test('durable manifests dedupe after reconnect and restart, reject edits and keep attachment IDs out of the text cache', async t => {
  const h = fake(t)
  const c = h.client()
  await watchWire(c)
  const id = 'm'.repeat(128)
  assert.equal((await uploadWire(c, sample)).ok, true)
  assert.equal((await uploadWire(c, sample, { upload: 'second' })).ok, true)
  const message = { id, text: '\u001b[200~caption\u001b[201~', uploads: ['upload', 'second'] }
  h.faults.prompt = async (request) => {
    const durable = JSON.parse(readFileSync(join(h.home, 'pocket', 'uploads.json'), 'utf8')).phones[sha256(phone)].manifests[0]
    assert.equal(durable.requestId, request.requestId)
    h.calls.insertions.push(request)
    c.stop()
    return { accepted: true }
  }
  assert.deepEqual(await send(c, message), { disconnected: true })
  delete h.faults.prompt
  await tick()
  h.faults.prompt = async () => ({ accepted: true })
  const host = new PocketUploads({ home: h.home, now: h.clock.now, clock: h.clock })
  const reconnect = h.client(host)
  await watchWire(reconnect)
  h.store.imageLimits.maxImageBytes = 1
  assert.deepEqual(await send(reconnect, message), { ok: true, state: 'sent', id, repeat: true })
  const [original, retry] = h.calls.prompts
  assert.deepEqual(original, retry)
  assert.equal(original.requestId, 'pocket-a/' + sha256([phone, 'a', id, sha256('caption'), 'receipt-0', 'receipt-1'].join('\0')).slice(0, 40))
  assert.deepEqual(original.content, [text('caption'), { type: 'file', receiptId: 'receipt-0' }, { type: 'file', receiptId: 'receipt-1' }])
  assert.equal(h.calls.insertions.length, 1)
  await reason(send(reconnect, { ...message, text: 'changed' }), 'changed')
  await reason(send(reconnect, { ...message, uploads: ['second', 'upload'] }), 'changed')
  await reason(begin(reconnect), 'invalid')
  await reason(reconnect.request('send', { phone, channel: 1, id: original.requestId, text: 'collision' }), 'invalid')
  h.append({ ...event(1, [image]), data: { ...event(1, [image]).data, source: { kind: 'user', rpcId: original.requestId } } })
  await tick()
  assert.equal(h.source.sent.get('a'), undefined)
  delete h.faults.prompt
  assert.equal((await reconnect.request('send', { phone, channel: 1, id, text: 'legacy namespace' })).ok, true)
  assert.equal(h.calls.prompts.at(-1).requestId, `pocket-${id}`)
  h.bots[0].sessionId = 'b'
  await reconnect.request('unsubscribe', { channel: 1 })
  await reconnect.request('subscribe', { terminal: 'dsh:a', channel: 1, attachments: 1 })
  await reason(send(reconnect, message), 'session-changed')
})

test('expired and evicted manifests cannot acknowledge a different prompt under an old message id', async t => {
  const h = fake(t)
  const c = h.client()
  await watchWire(c)
  for (let i = 0; i <= 64; i++) {
    const id = `message-${i}`
    assert.equal((await uploadWire(c, sample, { upload: id })).ok, true)
    assert.equal((await send(c, { id, uploads: [id] })).ok, true)
    h.clock.advance(60_000)
  }
  const key = sha256(phone)
  assert.equal(h.registry.ledger.manifests(key).length, 64)
  await reason(send(c, { id: 'message-0', uploads: ['message-0'] }), 'expired')
  assert.equal((await uploadWire(c, sample, { upload: 'new-upload' })).ok, true)
  assert.equal((await send(c, { id: 'message-0', uploads: ['new-upload'] })).ok, true)
  assert.notEqual(h.calls.prompts[0].requestId, h.calls.prompts.at(-1).requestId)
  assert.equal(h.calls.insertions.length, 66)
  h.clock.advance(DAY_MS)
  assert.equal(h.registry.ledger.manifests(key).length, 0)
  await reason(send(c, { id: 'message-0', uploads: ['new-upload'] }), 'expired')
})

test('fresh sends recheck original dimensions, type, file/count/aggregate limits and clean optional text', async t => {
  const h = fake(t)
  const c = h.client()
  await watchWire(c)
  await uploadWire(c, sample)
  await uploadWire(c, sample, { upload: 'second' })
  const limits = h.store.imageLimits
  limits.maxImageDimension = 31
  await reason(send(c), 'too-large')
  limits.maxImageDimension = 65535
  limits.maxImageBytes = sample.length - 1
  await reason(send(c), 'too-large')
  limits.maxImageBytes = sample.length
  limits.mediaTypes = ['image/jpeg']
  await reason(send(c), 'unsupported')
  limits.mediaTypes.push('image/png')
  limits.maxImagesPerMessage = 1
  await reason(send(c, { uploads: ['upload', 'second'] }), 'too-large')
  limits.maxImagesPerMessage = 2
  limits.maxMessageImageBytes = sample.length
  await reason(send(c, { uploads: ['upload', 'second'] }), 'too-large')
  await reason(send(c, { uploads: ['upload', 'upload'] }), 'invalid')
  await reason(send(c, { text: 'sign-in-token' }), 'invalid')
  await reason(send(c, { text: ' '.repeat(40_000) }), 'too-long')
  assert.equal((await send(c, { text: '' })).ok, true)
  assert.deepEqual(h.calls.prompts[0].content, [{ type: 'file', receiptId: 'receipt-0' }])
})

test('blank upload captions match omitted captions and by stays at the watch handle', async t => {
  const h = fake(t)
  const messages = []
  const sendMessage = h.source.send_.bind(h.source)
  h.source.send_ = (entry, live, signal, message, uploads, scope) => {
    messages.push(message)
    return sendMessage(entry, live, signal, message, uploads, scope)
  }
  const c = h.client()
  await watchWire(c)
  assert.equal((await uploadWire(c, sample)).ok, true)
  const blank = '\u001b[200~ \t\r\n\u001b[201~'
  assert.deepEqual(await send(c, { text: blank, by: 'Pixel' }), { ok: true, state: 'sent', id: 'message' })
  assert.equal(messages[0].by, 'Pixel')
  const [prompt] = h.calls.prompts
  assert.equal(prompt.requestId, 'pocket-a/' + sha256([phone, 'a', 'message', sha256(''), 'receipt-0'].join('\0')).slice(0, 40))
  assert.deepEqual(prompt.content, [{ type: 'file', receiptId: 'receipt-0' }])
  assert.deepEqual(await send(c, { by: 'Renamed' }), { ok: true, state: 'sent', id: 'message', repeat: true })
  assert.deepEqual(h.calls.prompts[1], prompt)
  await reason(c.request('send', { phone, channel: 1, id: 'text-only', text: blank }), 'empty')
})

test('one negotiated socket projects each subscription separately and refuses uploads on the legacy channel', async t => {
  const h = fake(t)
  h.append(event(1, [text('prior'), image]))
  const c = h.client()
  const baseline = h.client()
  await watchWire(c)
  const legacy = { terminal: 'dsh:a', channel: 2 }
  await c.request('subscribe', legacy)
  await baseline.request('hello', { write: 1 })
  await baseline.request('subscribe', { ...legacy, attachments: 1 })
  const legacyLines = client => client.lines.filter(line => JSON.parse(line).channel === legacy.channel)
  assert.equal(legacyLines(c).length, 1)
  assert.deepEqual(legacyLines(c), legacyLines(baseline))
  assert.equal(JSON.parse(legacyLines(c)[0]).event.rows[0].blocks, undefined)

  const channel = { channel: legacy.channel }
  assert.equal((await uploadWire(c, sample)).ok, true)
  await reason(begin(c, { ...channel, upload: 'legacy-upload' }), 'not-watching')
  await reason(read(c, channel), 'not-watching')
  await reason(chunk(c, sample, channel), 'invalid')
  await reason(finish(c, channel), 'invalid')
  await reason(cancel(c, channel), 'invalid')
  await reason(send(c, channel), 'invalid')
  assert.equal(h.calls.uploads.length, 1)
  assert.equal(h.calls.reads.length, 0)
  assert.equal(h.calls.prompts.length, 0)

  h.faults.prompt = async () => {
    h.append(event(2, [image]))
    return { accepted: true }
  }
  assert.equal((await send(c)).ok, true)
  await tick()
  assert.equal(c.events.at(-1).channel, 1)
  const [row] = c.events.at(-1).event.rows
  assert.equal(row.id, 'dsh:a:2')
  assert.equal(row.text, '')
  assert.deepEqual(row.blocks, [{ type: 'image', block: 0, mediaType: 'image/png', width: 32, height: 24 }])
  assert.equal(legacyLines(c).length, 1)
  assert.deepEqual(legacyLines(c), legacyLines(baseline))
  const before = { ...channel, before: 'dsh:a:3' }
  await c.request('backfill', before, 'legacy-page')
  await baseline.request('backfill', before, 'legacy-page')
  assert.equal(c.lines.at(-1), baseline.lines.at(-1))
})

test('legacy snapshots, reconnects, live and backfill serialize like the original projection after 500-row eviction', async t => {
  const mixed = fake(t)
  const plain = fake(t)
  for (let seq = 1; seq <= 1150; seq++) {
    if (seq >= 540) {
      mixed.append(event(seq, [text('   '), image]))
      // Media-only events still occupy log positions in the legacy single-page fetch.
      plain.append(event(seq, [text('   ')]))
    } else {
      mixed.append(event(seq, [text(`text ${seq}`), image]))
      plain.append(event(seq, [text(`text ${seq}`)]))
    }
  }
  const [legacy, baseline, rich] = [mixed.client(), plain.client(), mixed.client()]
  const sub = { terminal: 'dsh:a', channel: 1 }
  for (const c of [legacy, baseline]) {
    await c.request('hello', { write: 1 })
    await c.request('subscribe', sub)
  }
  await watchWire(rich)
  assert.equal(legacy.lines[1], baseline.lines[1])
  assert.equal(legacy.events[0].event.rows.length, 200)
  assert.equal(legacy.events[0].event.rows[0].id, 'dsh:a:340')
  assert.equal(rich.events[0].event.rows.at(-1).text, '')
  assert.equal(mixed.source.entries.get('a').rows.length, 1000)
  for (const seq of [35, 40, 530, 1000]) {
    for (const c of [legacy, baseline]) {
      await c.request('unsubscribe', { channel: 1 })
      await c.request('subscribe', { ...sub, after: rowIdOf('a', seq) })
    }
    assert.equal(JSON.stringify(legacy.events.at(-1)), JSON.stringify(baseline.events.at(-1)))
  }
  const before = { channel: 1, before: 'dsh:a:550', limit: 200 }
  assert.equal(JSON.stringify(await legacy.request('backfill', before)), JSON.stringify(await baseline.request('backfill', before)))
  mixed.append(event(1151, [image]))
  plain.append(event(1151, []))
  const count = legacy.events.length
  await tick()
  assert.equal(legacy.events.length, count)
  assert.equal(rich.events.at(-1).event.rows[0].id, 'dsh:a:1151')
  mixed.append(event(1152, [text('live'), image]))
  plain.append(event(1152, [text('live')]))
  await tick()
  assert.equal(JSON.stringify(legacy.events.at(-1)), JSON.stringify(baseline.events.at(-1)))
  assert.ok(!JSON.stringify(rich.events).includes('attachmentId'))
})

test('media blocks share a bounded text budget, cap media, sanitize file names and omit attachment IDs', () => {
  const scope = { sessionId: 'a', turn: 0, calls: new Map() }
  const filename = 'C:\\private/folder\\\u0001' + 'é'.repeat(100)
  const file = { type: 'file', attachment: { attachmentId: 'opaque', name: filename, bytes: 2 } }
  const parts = [text('界'.repeat(TEXT_MAX - 10)), file, text('界'.repeat(100)), ...Array.from({ length: 17 }, () => image)]
  const [row] = rowsOf(event(1, parts), scope)
  assert.equal(row.blocks.filter(b => b.type === 'text').reduce((sum, b) => sum + b.text.length, 0), TEXT_MAX)
  assert.deepEqual(row.blocks[1], { type: 'file', block: 1, name: 'é'.repeat(64), bytes: 2 })
  assert.deepEqual(row.blocks.at(-1), { type: 'more', count: 2 })
  assert.equal(row.blocks.filter(b => b.type === 'image').length, 15)
  assert.equal(sanitizeAttachmentName('x/..'), undefined)
  assert.equal(sanitizeAttachmentName('x\\.'), undefined)
  const [many] = rowsOf(event(2, [...Array.from({ length: TEXT_MAX }, () => text('界')), image]), scope)
  assert.ok(Buffer.byteLength(JSON.stringify(many)) < PAGE_BYTES)
  assert.ok(!JSON.stringify(row).includes('attachmentId'))
})

test('thumbnail reads require canonical exact visible image blocks and cap both attempts and the reply line', async t => {
  const h = fake(t)
  h.append(event(1, [image]))
  h.append(event(2, [image], 'tool'))
  h.append(event(3, Array.from({ length: 17 }, () => image)))
  const c = h.client()
  await watchWire(c)
  h.faults.events = async () => ({ records: h.sessions.a.map(event => ({ event })) })
  h.faults.read = async (_ref, target) => target.width === 512
    ? { mediaType: 'image/png', width: 513, height: 500, data: Buffer.alloc(10) }
    : { mediaType: 'image/png', width: 256, height: 256, data: Buffer.alloc(65536) }
  const result = await read(c)
  assert.equal(result.ok, true)
  assert.equal(Buffer.from(result.data, 'base64').length, 65536)
  assert.ok(Buffer.byteLength(c.lines.at(-1)) + 1 <= READ_LINE_BYTES)
  assert.deepEqual(h.calls.reads.map(({ target }) => target), [
    { width: 512, height: 512, maxBytes: 131072 }, { width: 256, height: 256, maxBytes: 65536 },
  ])
  assert.deepEqual(h.calls.events[0], { sessionId: 'a', beforeSeq: 2, maxMessages: 1 })
  await reason(read(c, { row: 'dsh:a:1#image' }), 'invalid')
  await reason(read(c, { row: 'dsh:a:01' }), 'invalid')
  await reason(read(c, { row: 'dsh:b:1' }), 'not-watching')
  await reason(read(c, { row: 'dsh:a:999' }), 'not-found')
  await reason(read(c, { row: 'dsh:a:2' }), 'not-found')
  await reason(read(c, { row: 'dsh:a:3', block: 16 }), 'not-found')
  await reason(read(c, { block: -1 }), 'invalid')
  h.faults.events = () => ({ records: [{ event: h.sessions.a.at(-1) }] })
  await reason(read(c), 'not-found')
  delete h.faults.events
  h.faults.read = async (_ref, { width, maxBytes }) => ({ width, height: width, mediaType: 'image/png', data: Buffer.alloc(maxBytes + 1) })
  await reason(read(c), 'too-large')
})

test('thumbnail deadline is shared across attempts, concurrency is host-wide, and revocation prevents a reply with bytes', async t => {
  const h = fake(t)
  h.append(event(1, [image]))
  const a = h.client()
  const b = h.client()
  await watchWire(a)
  await watchWire(b)
  const second = deferred()
  h.faults.read = async (_ref, { width }) => width === 512
    ? { width: 513, height: 1, mediaType: 'image/png', data: sample }
    : second.promise
  const one = read(a)
  const two = read(b)
  await tick()
  await reason(read(b), 'busy')
  h.clock.advance(READ_MS)
  await reason(one, 'unavailable')
  await reason(two, 'unavailable')
  assert.equal(h.calls.reads.length, 4)
  assert.ok(h.calls.reads.every(({ signal }) => signal.aborted))
  second.resolve({ width: 1, height: 1, mediaType: 'image/png', data: sample })
  await tick()

  const bitmap = deferred()
  h.faults.read = () => bitmap.promise
  const revoked = read(a)
  await tick()
  h.runtime.shown = false
  bitmap.resolve({ width: 1, height: 1, mediaType: 'image/png', data: sample })
  await reason(revoked, 'not-shown')
  const count = h.calls.reads.length
  for (let i = 0; i < 56; i++) await reason(read(a, { row: 'bad' }), 'invalid')
  await reason(read(a), 'rate')
  assert.equal(h.calls.reads.length, count)
})

test('pending subscribe identity, downgraded thumbnails and closed backfill cannot cross channel reuse', async t => {
  const h = fake(t)
  h.append(event(1, [image]))
  const slow = deferred()
  let watch
  const source = Object.create(h.source)
  source.watch = async (terminal, emit, options) => {
    if (!watch) {
      watch = emit
      await slow.promise
    }
    return h.source.watch(terminal, emit, options)
  }
  const c = memoryWire(source, h.registry, h.log)
  t.after(c.stop)
  await c.request('hello', { write: 1, attachments: 1 })
  const pending = c.request('subscribe', { terminal: 'dsh:b', channel: 1, attachments: 1 })
  await c.request('unsubscribe', { channel: 1 })
  await c.request('subscribe', { terminal: 'dsh:a', channel: 1, attachments: 1 })
  watch({ type: 'rows', rows: [{ sentinel: 'old-listener' }] })
  slow.resolve()
  assert.equal((await pending).kind, 'closed')
  assert.equal(c.events.length, 1)

  const bitmap = deferred()
  const page = deferred()
  h.faults.read = () => bitmap.promise
  const reading = c.request('attachment-read', { phone, channel: 1, row: 'dsh:a:1', block: 0 }, 'lost-read')
  await tick()
  assert.equal(h.calls.reads.length, 1)
  h.faults.events = () => page.promise
  const backfill = c.request('backfill', { channel: 1, before: 'dsh:a:2' }, 'lost-page')
  await tick()
  assert.equal(h.calls.events.length, 2)
  assert.ok(c.lines.every(line => !/lost-read|lost-page|old-listener/.test(line)))
  await c.request('hello', { write: 1, manage: 1 })
  await c.request('subscribe', { terminal: 'dsh:a', channel: 1 })
  bitmap.resolve({ width: 1, height: 1, mediaType: 'image/png', data: sample })
  page.resolve({ records: [{ event: h.sessions.a[0] }] })
  const readRefusal = { ok: false, state: 'refused', reason: 'not-watching' }
  const backfillError = { kind: 'closed', message: 'closed' }
  await tick()
  assert.deepEqual(c.lines.filter(line => line.includes('"lost-read"')),
    [JSON.stringify({ id: 'lost-read', result: readRefusal })])
  assert.deepEqual(c.lines.filter(line => line.includes('"lost-page"')),
    [JSON.stringify({ id: 'lost-page', error: backfillError })])
  assert.deepEqual(await reading, readRefusal)
  assert.deepEqual(await backfill, backfillError)
  assert.deepEqual(c.events.at(-1).event.rows, [])
})

test('a capability-changing hello closes a pending subscribe before channel reuse', async t => {
  const h = fake(t)
  const gate = deferred()
  const source = Object.create(h.source)
  const originalWatch = h.source.watch.bind(h.source)
  let first = true
  source.watch = async (...args) => {
    if (first) { first = false; await gate.promise }
    return originalWatch(...args)
  }
  const c = memoryWire(source, h.registry, h.log)
  t.after(c.stop)
  await c.request('hello', { write: 1, attachments: 1 })
  const pending = c.request('subscribe', { terminal: 'dsh:b', channel: 1, attachments: 1 })
  await c.request('hello', { write: 1 })
  assert.deepEqual(await c.request('subscribe', { terminal: 'dsh:a', channel: 1 }), { channel: 1 })
  gate.resolve()
  assert.equal((await pending).kind, 'closed')
  assert.equal(c.events.length, 1)
  assert.equal(c.events[0].event.rows.length, 0)
})

test('a legacy backfill returns its original rows after its channel is reused', async t => {
  const h = fake(t)
  const previous = event(1, [text('original page'), image])
  h.append(previous)
  const c = h.client()
  await c.request('hello', { write: 1 })
  await c.request('subscribe', { terminal: 'dsh:a', channel: 1 })
  const expected = c.events[0].event.rows
  const page = deferred()
  h.faults.events = () => page.promise
  const backfill = c.request('backfill', { channel: 1, before: 'dsh:a:2' }, 'legacy-backfill')
  assert.equal(h.calls.events.length, 1)
  await c.request('unsubscribe', { channel: 1 })
  await c.request('subscribe', { terminal: 'dsh:b', channel: 1 })
  page.resolve({ records: [{ event: previous }] })
  await tick()
  assert.equal(c.lines.at(-1), JSON.stringify({ id: 'legacy-backfill', result: { rows: expected } }))
  assert.deepEqual(await backfill, { rows: expected })
})

test('attachment errors expose only fixed log strings, allowlisted codes and the generic outer failure', async t => {
  const h = fake(t)
  const c = h.client()
  h.append(event(1, [image]))
  await watchWire(c)
  const sentinel = 'SECRET-CONTENT-and-DESKTOP-NAME'
  const error = code => Object.assign(new Error(sentinel), { details: { reason: code } })
  const stalled = deferred()
  h.faults.upload = () => stalled.promise
  assert.equal((await begin(c)).ok, true)
  const waiting = chunk(c)
  stalled.resolve(Promise.reject(error('INVALID_IMAGE')))
  assert.equal((await waiting).code, 'INVALID_IMAGE')
  assert.equal(h.calls.uploads[0].name, undefined)
  delete h.faults.upload
  assert.equal((await uploadWire(c, sample)).ok, true)
  h.faults.prompt = async () => { throw error('MODEL_DOES_NOT_SUPPORT_IMAGES') }
  assert.equal((await send(c)).code, 'MODEL_DOES_NOT_SUPPORT_IMAGES')
  h.faults.prompt = async () => { throw error('FILE_NOT_STAGED') }
  await reason(send(c), 'expired')
  h.faults.read = async () => { throw error(sentinel) }
  await reason(read(c), 'unavailable')
  const attach = h.source.attach_
  h.source.attach_ = () => { throw error(sentinel) }
  assert.deepEqual(await read(c), { kind: 'failed', message: 'failed' })
  h.source.attach_ = attach
  assert.deepEqual(h.logs, [
    ['pocket upload: admission failed'], ['pocket chat: a send was not accepted'],
    ['pocket chat: a send was not accepted'], ['pocket attachment read failed'], ['pocket attachment: failed'],
  ])
  assert.ok(!JSON.stringify([...h.logs, ...c.lines]).includes(sentinel))
})
