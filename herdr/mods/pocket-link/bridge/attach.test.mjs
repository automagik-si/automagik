// RFC 0033 on the phone wire, through the bridge and its DSH source, with in-memory sockets.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setImmediate as tick } from 'node:timers/promises'
import { test } from 'node:test'
import { ATTACH_METHODS, ChatConnection, chatWriter, CLOSE, DATA, frame, MAX_IN_FLIGHT, METHODS } from './chat.mjs'
import { DshSource, withDsh } from './dsh-source.mjs'
import { endRemoved } from './guard.mjs'

const terminal = 'dsh:worker'
const other = 'dsh:helper'
const mediaType = 'image/png'
const chunkBytes = 24576
const thumbnail = { ok: true, mediaType: 'image/jpeg', width: 512, height: 512, data: Buffer.alloc(131072, 1).toString('base64') }
const secret = 'attachment-content-name-and-error-sentinel'
const socketMethods = ['upload-begin', 'upload-chunk', 'upload-finish', 'upload-cancel', 'attachment-read']
const limits = {
  fileBytes: 8 * 1024 * 1024, files: 4, messageBytes: 16 * 1024 * 1024, deviceOutstanding: 32 * 1024 * 1024,
  deviceDailyBytes: 256 * 1024 * 1024, deviceDailyCount: 128, chunkBytes, maxPixels: 40_000_000,
  maxDimension: 8192, thumbnail: { edge: 512, bytes: 131072 },
}
const offer = () => structuredClone({ version: 1, mediaTypes: [mediaType], methods: socketMethods, limits })
const refuse = (reason) => ({ ok: false, state: 'refused', reason })
const reply = (result) => ({ result })
const row = { id: 'dsh:s1:5', kind: 'text', role: 'user', text: '', blocks: [{ type: 'image', block: 0, mediaType, width: 1, height: 1 }] }
const legacyRow = { id: row.id, kind: row.kind, role: row.role, text: row.text }
const b64 = (size = 1) => Buffer.alloc(size, 1).toString('base64')
const image = { mediaType, width: 1, height: 1, bytes: 1, stored: 2 }
const admitted = (upload) => ({ ok: true, state: 'admitted', upload, image })
const rpc = (id, method, params) => Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function fakeClock() {
  let now = 0
  const jobs = new Map()
  return {
    now: () => now,
    timers: {
      setTimeout(fn, ms) { const job = { fn, at: now + ms }; jobs.set(job, job); return job },
      clearTimeout(job) { jobs.delete(job) },
    },
    async advance(ms) {
      const end = now + ms
      for (;;) {
        const next = [...jobs.values()].filter((job) => job.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!next) break
        now = next.at
        jobs.delete(next)
        next.fn()
        await tick()
      }
      now = end
      await tick()
    },
  }
}

class FakeSocket extends EventEmitter {
  constructor(host) {
    super()
    this.host = host
    this.requests = []
    this.callbacks = []
    this.watches = new Map()
    this.destroyed = false
    queueMicrotask(() => this.emit('connect'))
  }

  setEncoding(encoding) { assert.equal(encoding, 'utf8') }

  write(line, callback) {
    assert.equal(this.destroyed, false)
    const m = JSON.parse(line)
    if (this.host.throwWrite?.(m)) throw new Error(secret)
    this.requests.push(m)
    if (this.host.stall?.(m)) this.callbacks.push(callback)
    else queueMicrotask(() => callback())
    // Like D1, apply the channel change independently of its acknowledgement.
    if (m.method === 'subscribe') this.watches.set(m.params.channel, m.params)
    if (m.method === 'unsubscribe') this.watches.delete(m.params.channel)
    const answer = this.host.answer?.(m, this)
    if (answer !== null) this.answer(m, answer ?? this.defaultAnswer(m))
  }

  defaultAnswer({ method, params }) {
    switch (method) {
      case 'hello': {
        const attachments = params.attachments === 1 ? this.host.offer() : undefined
        return reply({
          protocol: 1, readOnly: false, write: 1, methods: ['send', 'interrupt', 'answer', ...(attachments ? socketMethods : [])],
          ...(attachments ? { attachments } : {}),
          ...(params.manage === 1 ? { manage: 1, manageMethods: ['memory-read'] } : {}),
        })
      }
      case 'subscribe': return reply({ channel: params.channel })
      case 'manage-open': return reply({ grant: params.grant })
      case 'memory-read': return reply({ ok: true, state: 'read' })
      case 'backfill': return reply({ rows: [row] })
      case 'upload-begin': return reply({ ok: true, state: 'open', upload: params.upload, chunkBytes })
      case 'upload-chunk': return reply({ ok: true, received: params.offset + Buffer.from(params.data, 'base64').length })
      case 'upload-finish': return reply(admitted(params.upload))
      case 'upload-cancel': return reply({ ok: true })
      case 'attachment-read': return reply(thumbnail)
      case 'send': return reply({ ok: true, state: 'sent', id: params.id })
      default: return reply({})
    }
  }

  answer(m, answer = this.defaultAnswer(m)) { this.emitLater({ id: m.id, ...answer }) }
  event(channel, event) { this.emitLater({ channel, event }) }
  emitLater(m) { queueMicrotask(() => this.emit('data', JSON.stringify(m) + '\n')) }
  calls(method) { return this.requests.filter((m) => m.method === method) }
  drain() { for (const callback of this.callbacks.splice(0)) callback() }
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.watches.clear()
    queueMicrotask(() => this.emit('close'))
  }
}

async function world(t, { host = {}, options = {}, base = {} } = {}) {
  const sockets = []
  const logs = []
  const clock = fakeClock()
  const dsh = new DshSource({
    ...clock, path: '/test/pocket/chat.sock', realpath: (path) => path, check: () => true,
    attachments: true, log: (line) => logs.push(line),
    connect: () => {
      const socket = new FakeSocket({ offer, ...host })
      sockets.push(socket)
      return socket
    },
    ...options,
  })
  const engine = withDsh({ ready: async () => {}, list: () => [], ...base }, dsh, { by: 'Test phone' })
  const phones = []
  t.after(async () => {
    for (const phone of phones) phone.conn.close()
    dsh.close()
    await tick()
  })
  await dsh.open()
  return {
    dsh, sockets, logs, clock, engine,
    get socket() { return sockets.at(-1) },
    phone({ device = 'paired-key', send, maxUnsent, overrides } = {}) {
      const writes = []
      const ended = []
      let revoked = false
      const writer = chatWriter({
        send: (bytes) => {
          writes.push(bytes)
          return send?.(bytes)
        },
        isClosed: () => conn.closed, isRevoked: () => revoked, onFail: () => conn.close('write failed'),
      })
      const conn = new ChatConnection({ engine: { ...engine, ...overrides }, device, write: writer, end: (reason) => ended.push(reason), log: (line) => logs.push(line), maxUnsent })
      let next = 1
      const p = {
        conn, writes, ended,
        peer: { phone: device, end: () => { revoked = true; conn.close('not paired') } },
        greet(params = { attachments: 1 }) {
          conn.feed(Buffer.concat([rpc(0, 'hello', { generation: 1, framed: true, ...params }), Buffer.from('\n')]))
        },
        async hello(params) {
          p.greet(params)
          await tick()
          assert.ok(writes[0], 'phone hello answered')
          return JSON.parse(writes[0]).result
        },
        feed(method, params, id = next++) { conn.feed(frame(0, DATA, rpc(id, method, params))); return id },
        answers(id) {
          return writes.slice(1).filter((bytes) => bytes.readUInt32LE(0) === 0).map((bytes) => JSON.parse(bytes.subarray(9)))
            .filter((m) => m.id === id)
        },
        answer(id) {
          const answers = p.answers(id)
          assert.equal(answers.length, 1, `exactly one reply for RPC ${id}`)
          return answers[0]
        },
        async call(method, params, id) {
          const token = p.feed(method, params, id)
          await tick()
          return p.answer(token).result
        },
        watch: (term = terminal) => p.call('chat.subscribe', { terminal: term }),
        closeWatch: (channel) => conn.feed(frame(channel, CLOSE)),
        events: (channel) => writes.slice(1).filter((bytes) => bytes.readUInt32LE(0) === channel && bytes[4] === DATA)
          .map((bytes) => JSON.parse(bytes.subarray(9))),
        begin: (upload = 'u1', bytes = 1, term = terminal) => p.call('chat.attach', { terminal: term, upload, mediaType, bytes }),
        chunk: (upload = 'u1', data = b64(), offset = 0) => p.call('chat.attachChunk', { terminal, upload, offset, data }),
        read: () => p.call('chat.attachmentRead', { terminal, row: row.id, block: 0 }),
      }
      phones.push(p)
      return p
    },
  }
}

async function rich(w, options) {
  const p = w.phone(options)
  assert.deepEqual((await p.hello()).attachments.methods, ATTACH_METHODS)
  await p.watch()
  return p
}

test('both socket hellos opt in; defaults and legacy phone hello stay identical', async (t) => {
  const w = await world(t)
  assert.deepEqual(w.socket.calls('hello').map((m) => m.params), [{ write: 1, attachments: 1 }, { write: 1, attachments: 1, manage: 1 }])
  const old = await world(t, { options: { attachments: false } })
  assert.deepEqual(old.socket.calls('hello').map((m) => m.params), [{ write: 1 }, { write: 1, manage: 1 }])
  const a = await w.phone().hello({})
  const b = await old.phone().hello({})
  assert.deepEqual(a, b)
  assert.deepEqual(a.methods, METHODS)
  const modern = await w.phone().hello()
  assert.deepEqual(modern.methods, [...METHODS, ...ATTACH_METHODS])
  assert.deepEqual(modern.attachments, { version: 1, methods: ATTACH_METHODS, mediaTypes: [mediaType], limits })
  assert.deepEqual(METHODS, a.methods)
  assert.deepEqual((await old.phone().hello()).attachments, { version: 1, unavailable: 'app' })
})

test('usable socket without a valid offer says app; absent, invalid or closed socket says none', async (t) => {
  const badOffers = [
    (a) => { a.version = '1' }, (a) => { a.methods.pop() }, (a) => { a.mediaTypes = ['image/svg+xml'] },
    (a) => { a.limits.deviceOutstanding = 0 }, (a) => { a.limits.thumbnail.edge = 1.5 },
    (a) => { a.limits.fileBytes = Number.MAX_SAFE_INTEGER + 1 }, (a) => { a.limits.chunkBytes = 50000 },
    (a) => { a.limits.chunkBytes = Number.MAX_SAFE_INTEGER },
  ]
  for (const damage of badOffers) {
    const w = await world(t, { host: { offer: () => { const a = offer(); damage(a); return a } } })
    const p = w.phone()
    assert.deepEqual((await p.hello()).attachments, { version: 1, unavailable: 'app' })
    assert.deepEqual(await p.begin(), refuse('read-only'))
    assert.equal(w.socket.calls('upload-begin').length, 0)
  }
  for (const hello of [
    { protocol: 1, readOnly: true, attachments: offer(), methods: socketMethods },
    { protocol: 1, readOnly: false, write: 1, attachments: offer(), methods: socketMethods.slice(1) },
    { protocol: 2, readOnly: true },
  ]) {
    const w = await world(t, { host: { answer: (m) => m.method === 'hello' ? reply(hello) : undefined } })
    assert.deepEqual((await w.phone().hello()).attachments, { version: 1, unavailable: hello.protocol === 1 ? 'app' : 'none' })
  }
  const absent = await world(t, { options: { check: () => false } })
  assert.deepEqual((await absent.phone().hello()).attachments, { version: 1, unavailable: 'none' })
  const closed = await world(t)
  closed.socket.destroy()
  assert.deepEqual((await closed.phone().hello()).attachments, { version: 1, unavailable: 'none' })
})

test('old writable bots-dsh hello without attachments is app unavailable and cannot upload', async (t) => {
  const w = await world(t, { host: { answer: (m) => m.method === 'hello'
    ? reply({ protocol: 1, readOnly: false, write: 1, methods: ['send', 'interrupt', 'answer'] })
    : undefined } })
  const p = w.phone()
  const hello = await p.hello()
  assert.deepEqual(hello.attachments, { version: 1, unavailable: 'app' })
  assert.deepEqual(hello.methods, METHODS)
  await p.watch()
  assert.deepEqual(await p.begin(), refuse('read-only'))
  assert.equal(w.socket.calls('upload-begin').length, 0)
})

test('offer intersects just the bridge caps and supported types, keeping the socket’s chunk size', async (t) => {
  const w = await world(t, { host: { offer: () => ({
    ...offer(), mediaTypes: ['image/webp', 'image/gif', 'image/webp'], limits: {
      ...limits, fileBytes: limits.fileBytes * 2, files: 10, messageBytes: limits.messageBytes * 2,
      deviceDailyCount: 6, chunkBytes: 40960, thumbnail: { edge: 5000, bytes: 200000 },
    },
  }) } })
  const a = (await w.phone().hello()).attachments
  assert.deepEqual(a.mediaTypes, ['image/webp'])
  assert.deepEqual(a.limits, { ...limits, deviceDailyCount: 6, chunkBytes: 40960 })
})

test('same socket carries legacy and rich watches, strips stray blocks and gates attachment traffic', async (t) => {
  const w = await world(t)
  const old = w.phone({ device: 'old-key' })
  await old.hello({})
  const modern = w.phone({ device: 'new-key' })
  await modern.hello()
  const a = await old.watch()
  const b = await modern.watch()
  const [legacy, richWatch] = w.socket.calls('subscribe')
  assert.deepEqual(legacy.params, { terminal, channel: 1 })
  assert.deepEqual(richWatch.params, { terminal, channel: 2, attachments: 1 })
  for (const ch of [1, 2]) {
    w.socket.event(ch, { type: 'snapshot', rows: [row], screen: [] })
    w.socket.event(ch, { type: 'rows', rows: [row] })
  }
  await tick()
  assert.equal(JSON.stringify(old.events(a.channel)), JSON.stringify([{ type: 'snapshot', rows: [legacyRow], screen: [] }, { type: 'rows', rows: [legacyRow] }]))
  assert.deepEqual(modern.events(b.channel).map((e) => e.rows), [[row], [row]])
  assert.equal(JSON.stringify(await old.call('chat.backfill', { terminal, before: 'r' })), JSON.stringify({ rows: [legacyRow] }))
  assert.deepEqual(await modern.call('chat.backfill', { terminal, before: 'r' }), { rows: [row] })
  assert.deepEqual(await old.read(), refuse('read-only'))
  assert.deepEqual(await old.begin(), refuse('read-only'))
  assert.deepEqual(await modern.read(), thumbnail)
  assert.equal((await modern.begin()).state, 'open')
  old.closeWatch(a.channel)
  await tick()
  assert.deepEqual(w.socket.calls('unsubscribe').map((m) => m.params), [{ channel: 1 }])
})

test('hello grants attachments at answer time after manage, and a reconnect requires a fresh hello', async (t) => {
  const w = await world(t, { host: { answer: (m) => m.method === 'manage-open' ? null : undefined } })
  const old = await rich(w, { device: 'other-key' })
  const p = w.phone()
  p.greet({ attachments: 1, manage: ['memory.read'] })
  await tick()
  assert.equal(p.writes.length, 0)
  assert.equal(w.dsh.offerFor(p.conn.client), null)
  w.socket.destroy()
  await tick()
  assert.deepEqual(JSON.parse(p.writes[0]).result.attachments, { version: 1, unavailable: 'none' })
  await w.dsh.open()
  assert.deepEqual(await p.begin(), refuse('read-only'))
  assert.deepEqual(await old.begin(), refuse('read-only'))
  const fresh = w.phone()
  fresh.greet({ attachments: 1, manage: ['memory.read'] })
  await tick()
  w.socket.answer(w.socket.calls('manage-open')[0])
  await tick()
  const grant = JSON.parse(fresh.writes[0]).result
  assert.deepEqual(grant.manage, ['memory.read'])
  assert.deepEqual(grant.attachments.methods, ATTACH_METHODS)
})

test('early attach waits for subscribe, including failure and its own deadline', async (t) => {
  for (const outcome of ['ready', 'failed', 'timeout']) {
    const w = await world(t, { options: { requestMs: 10000 }, host: { answer: (m) => m.method === 'subscribe' ? null : undefined } })
    const p = w.phone()
    await p.hello()
    p.feed('chat.subscribe', { terminal })
    const call = p.feed('chat.attach', { terminal, upload: 'quick', mediaType, bytes: 1 })
    await tick()
    assert.equal(w.socket.calls('upload-begin').length, 0)
    const sub = w.socket.calls('subscribe')[0]
    if (outcome === 'timeout') await w.clock.advance(5000)
    else {
      w.socket.answer(sub, outcome === 'ready' ? undefined : { error: { kind: 'not-found', message: secret } })
      await tick()
    }
    if (outcome === 'ready') assert.equal(p.answer(call).result.state, 'open')
    else {
      assert.deepEqual(p.answer(call).result, refuse(outcome === 'failed' ? 'not-watching' : 'offline'))
      assert.equal(w.socket.calls('upload-begin').length, 0)
      assert.equal(w.socket.calls('upload-cancel').length, 0)
      assert.equal(w.dsh.uploads.size, 0)
    }
  }
})

test('upload wire takes explicit fields; early finish leaves the record and valid credit permits admission', async (t) => {
  const w = await world(t, { host: { answer(m) {
    if (m.method === 'upload-finish') return reply({ ...admitted(m.params.upload), receipt: secret, image: { ...image, name: secret } })
  } } })
  const p = await rich(w)
  const spoof = { phone: 'wrong', channel: 999, receipt: secret }
  assert.deepEqual(await p.call('chat.attach', { terminal, upload: 'u1', bytes: chunkBytes + 1, mediaType, ...spoof }),
    { ok: true, state: 'open', upload: 'u1', chunkBytes })
  assert.deepEqual(w.socket.calls('upload-begin')[0].params, { channel: 1, phone: 'paired-key', upload: 'u1', bytes: chunkBytes + 1, mediaType })
  assert.deepEqual(await p.call('chat.attachFinish', { terminal, upload: 'u1' }), refuse('invalid'))
  assert.equal(w.socket.calls('upload-finish').length, 0)
  assert.deepEqual(await p.call('chat.attachChunk', { terminal, upload: 'u1', offset: 0, data: b64(chunkBytes), ...spoof }), { ok: true, received: chunkBytes })
  assert.deepEqual(await p.chunk('u1', b64(), chunkBytes), { ok: true, received: chunkBytes + 1 })
  assert.deepEqual(await p.call('chat.attachFinish', { terminal, upload: 'u1', ...spoof }), admitted('u1'))
  assert.deepEqual(w.socket.calls('upload-finish')[0].params, { channel: 1, phone: 'paired-key', upload: 'u1' })
  assert.deepEqual(await p.call('chat.send', { terminal, id: 'message:1', uploads: ['u1'], ...spoof }), { ok: true, state: 'sent', id: 'message:1' })
  assert.deepEqual(w.socket.calls('send')[0].params, { channel: 1, phone: 'paired-key', by: 'Test phone', id: 'message:1', text: '', uploads: ['u1'] })
  assert.equal(w.dsh.uploads.size, 0)
})

test('foreign phone, connection, terminal and upload cannot mutate the owner record', async (t) => {
  const w = await world(t, { host: { answer(m) {
    if (m.method === 'send') return reply(refuse('expired'))
    if (m.method === 'upload-begin' && m.params.phone === 'other-key') return reply(refuse('busy'))
  } } })
  const a = await rich(w)
  const same = await rich(w)
  const b = await rich(w, { device: 'other-key' })
  const { channel } = await a.watch(other)
  await a.begin()
  const record = w.dsh.uploads.get('paired-key')
  assert.deepEqual(await same.begin('u2'), refuse('busy'))
  assert.deepEqual(await b.begin('u2'), refuse('busy'))
  assert.equal(w.socket.calls('upload-begin').length, 2, 'a different phone passed the bridge check')
  for (const [p, term, upload] of [[b, terminal, 'u1'], [same, terminal, 'u1'], [a, other, 'u1'], [a, terminal, 'u3']]) {
    assert.deepEqual(await p.call('chat.attachChunk', { terminal: term, upload, offset: 0, data: b64() }), refuse('invalid'))
    assert.deepEqual(await p.call('chat.attachFinish', { terminal: term, upload }), refuse('invalid'))
    assert.deepEqual(await p.call('chat.attachCancel', { terminal: term, upload }), { ok: true })
    assert.equal(w.dsh.uploads.get('paired-key'), record)
  }
  assert.deepEqual(await b.call('chat.send', { terminal, id: 'foreign', uploads: ['u1'], phone: 'paired-key' }), { ...refuse('expired'), id: 'foreign' })
  assert.equal(w.socket.calls('send')[0].params.phone, 'other-key')
  a.closeWatch(channel)
  await tick()
  assert.equal(w.dsh.uploads.get('paired-key'), record)
  assert.equal(w.socket.calls('upload-cancel').length, 0)
  assert.equal(w.socket.calls('upload-chunk').length, 0)
  assert.equal(w.socket.calls('upload-finish').length, 0)
  assert.deepEqual(await a.chunk(), { ok: true, received: 1 })
})

test('chunk gap, noncanonical content, incorrect short length and declared-byte overrun cancel locally', async (t) => {
  const w = await world(t)
  const p = await rich(w)
  const cases = [
    { offset: 1, data: b64(), bytes: 1 }, { offset: 0, data: 'AR==', bytes: 1 },
    { offset: 0, data: b64(), bytes: 2 }, { offset: 0, data: b64(chunkBytes), bytes: 1 },
  ]
  for (const [i, fields] of cases.entries()) {
    const upload = `bad-${i}`
    await p.begin(upload, fields.bytes)
    assert.deepEqual(await p.chunk(upload, fields.data, fields.offset), refuse('invalid'))
    assert.equal(w.dsh.uploads.size, 0)
  }
  assert.equal(w.socket.calls('upload-chunk').length, 0)
  assert.equal(w.socket.calls('upload-cancel').length, cases.length)
})

test('a duplicate chunk cancels once, replies once per call and reserves the phone slot until cleanup', async (t) => {
  const w = await world(t, { host: { answer: (m) => ['upload-chunk', 'upload-cancel'].includes(m.method) ? null : undefined } })
  const p = await rich(w)
  await p.begin()
  const fields = { terminal, upload: 'u1', offset: 0, data: b64() }
  const first = p.feed('chat.attachChunk', fields)
  await tick()
  assert.deepEqual(await p.call('chat.attachChunk', fields), refuse('invalid'))
  assert.deepEqual(p.answer(first).result, refuse('invalid'))
  assert.deepEqual(await p.begin('u2'), refuse('busy'))
  const cancel = p.feed('chat.attachCancel', fields)
  await tick()
  assert.equal(w.socket.calls('upload-cancel').length, 1)
  assert.equal(p.answers(cancel).length, 0)
  await w.clock.advance(4999)
  assert.equal(p.answers(cancel).length, 0)
  await w.clock.advance(1)
  assert.deepEqual(p.answer(cancel).result, { ok: true })
  assert.equal(w.socket.destroyed, false)
  assert.equal((await p.begin('u2')).state, 'open')
  w.socket.answer(w.socket.calls('upload-chunk')[0])
  await tick()
  assert.equal(w.dsh.uploads.get('paired-key').upload, 'u2')
  assert.deepEqual(p.answer(first).result, refuse('invalid'))
})

test('begin timeout compensates on the original socket, rejects id reuse and ignores the old reply', async (t) => {
  const w = await world(t, { host: { answer: (m) => m.method === 'upload-begin' && m.params.upload === 'lost' ? null : undefined } })
  const p = await rich(w)
  const id = p.feed('chat.attach', { terminal, upload: 'lost', mediaType, bytes: 1 })
  await tick()
  const old = w.socket.calls('upload-begin')[0]
  await w.clock.advance(4999)
  assert.equal(p.answers(id).length, 0)
  await w.clock.advance(1)
  assert.deepEqual(p.answer(id).result, refuse('offline'))
  assert.deepEqual(w.socket.calls('upload-cancel')[0].params, { channel: 1, phone: 'paired-key', upload: 'lost' })
  assert.deepEqual(await p.begin('lost'), refuse('invalid'))
  assert.equal((await p.begin('fresh')).state, 'open')
  w.socket.answer(old)
  await tick()
  assert.equal(w.dsh.uploads.get('paired-key').upload, 'fresh')
  assert.equal(w.socket.calls('upload-begin').length, 2)
  assert.deepEqual(p.answer(id).result, refuse('offline'))
})

test('malformed begin echo compensates, and begin history evicts the oldest of 256 ids per phone', async (t) => {
  let bad = true
  const w = await world(t, { host: { answer(m) {
    if (m.method === 'upload-begin' && bad) return reply({ ok: true, state: 'open', upload: 'foreign', chunkBytes })
  } } })
  const p = await rich(w)
  assert.deepEqual(await p.begin('old'), refuse('failed'))
  assert.deepEqual(w.socket.calls('upload-cancel')[0].params, { channel: 1, phone: 'paired-key', upload: 'old' })
  bad = false
  assert.deepEqual(await p.begin('old'), refuse('invalid'))
  for (let i = 0; i < 256; i++) {
    const upload = `id-${i}`
    assert.equal((await p.begin(upload)).state, 'open')
    assert.deepEqual(await p.call('chat.attachCancel', { terminal, upload }), { ok: true })
  }
  assert.equal(w.dsh.uploadIds.get('paired-key').size, 256)
  assert.equal((await p.begin('old')).state, 'open')
})

test('idle restarts on credit, total expires during upload, and a timed-out chunk cancels at 25 seconds', async (t) => {
  const w = await world(t)
  const p = await rich(w)
  await p.begin('idle', chunkBytes + 1)
  await w.clock.advance(34000)
  await p.chunk('idle', b64(chunkBytes))
  await w.clock.advance(34999)
  assert.equal(w.dsh.uploads.get('paired-key').acked, chunkBytes)
  await w.clock.advance(1)
  assert.equal(w.dsh.uploads.size, 0)
  assert.equal((await p.begin('total', 8 * chunkBytes)).state, 'open')
  for (let i = 0; i < 6; i++) {
    await w.clock.advance(30000)
    await p.chunk('total', b64(chunkBytes), i * chunkBytes)
  }
  await w.clock.advance(4999)
  assert.equal(w.dsh.uploads.get('paired-key').upload, 'total')
  await w.clock.advance(1)
  assert.equal(w.dsh.uploads.size, 0)
  assert.deepEqual(w.socket.calls('upload-cancel').map((m) => m.params.upload), ['idle', 'total'])

  const slow = await world(t, { host: { answer: (m) => m.method === 'upload-chunk' ? null : undefined } })
  const q = await rich(slow)
  await q.begin()
  await slow.clock.advance(34000)
  const id = q.feed('chat.attachChunk', { terminal, upload: 'u1', offset: 0, data: b64() })
  await tick()
  await slow.clock.advance(24999)
  assert.equal(q.answers(id).length, 0)
  assert.equal(slow.socket.calls('upload-cancel').length, 0)
  await slow.clock.advance(1)
  assert.deepEqual(q.answer(id).result, refuse('offline'))
  assert.equal(slow.socket.calls('upload-cancel').length, 1)
})

test('finish started at 179 seconds survives a 40-second admission; duplicate finish is local', async (t) => {
  const w = await world(t, { host: { answer: (m) => m.method === 'upload-finish' ? null : undefined } })
  const p = await rich(w)
  await p.begin('u1', 5 * chunkBytes + 1)
  for (let i = 0; i < 5; i++) {
    await w.clock.advance(30000)
    await p.chunk('u1', b64(chunkBytes), i * chunkBytes)
  }
  await w.clock.advance(29000)
  await p.chunk('u1', b64(), 5 * chunkBytes)
  const params = { terminal, upload: 'u1' }
  const id = p.feed('chat.attachFinish', params)
  await tick()
  assert.deepEqual(await p.call('chat.attachFinish', params), refuse('invalid'))
  await w.clock.advance(40000)
  assert.equal(p.answers(id).length, 0)
  assert.equal(w.socket.calls('upload-cancel').length, 0)
  assert.equal(w.socket.calls('upload-finish').length, 1)
  w.socket.answer(w.socket.calls('upload-finish')[0])
  await tick()
  assert.deepEqual(p.answer(id).result, admitted('u1'))
  assert.equal(w.dsh.uploads.size, 0)
})

test('cancel during finish wins; a lost written finish is unknown and is never replayed', async (t) => {
  for (const outcome of ['cancel', 'timeout', 'disconnect']) {
    const w = await world(t, { host: { answer: (m) => m.method === 'upload-finish' ? null : undefined } })
    const p = await rich(w)
    await p.begin()
    await p.chunk()
    const params = { terminal, upload: 'u1' }
    const id = p.feed('chat.attachFinish', params)
    await tick()
    const pending = w.socket.calls('upload-finish')[0]
    if (outcome === 'cancel') assert.deepEqual(await p.call('chat.attachCancel', params), { ok: true })
    else if (outcome === 'disconnect') {
      w.socket.destroy()
      await tick()
    } else {
      await w.clock.advance(64999)
      assert.equal(p.answers(id).length, 0)
      await w.clock.advance(1)
    }
    const result = outcome === 'cancel' ? refuse('invalid') : { ok: false, state: 'unknown', reason: 'offline', upload: 'u1' }
    assert.deepEqual(p.answer(id).result, result)
    assert.equal(w.socket.calls('upload-cancel').length, outcome === 'disconnect' ? 0 : 1)
    assert.equal(w.socket.calls('upload-finish').length, 1)
    w.socket.answer(pending)
    await tick()
    assert.deepEqual(p.answer(id).result, result)
    assert.equal(w.dsh.uploads.size, 0)
  }
})

async function admitUpload(p, upload) {
  assert.equal((await p.begin(upload)).state, 'open')
  assert.deepEqual(await p.chunk(upload), { ok: true, received: 1 })
  assert.deepEqual(await p.call('chat.attachFinish', { terminal, upload }), admitted(upload))
}

test('two admitted uploads cancel once each on their watch', async (t) => {
  const w = await world(t)
  const p = await rich(w)
  const sub = w.dsh.subs.get(1)
  for (const upload of ['first', 'second']) await admitUpload(p, upload)
  assert.deepEqual([...w.dsh.admitted.get(sub).keys()], ['first', 'second'])
  for (const upload of ['first', 'second', 'first']) {
    assert.deepEqual(await p.call('chat.attachCancel', { terminal, upload }), { ok: true })
  }
  assert.deepEqual(w.socket.calls('upload-cancel').map((m) => m.params), [
    { channel: sub.channel, phone: 'paired-key', upload: 'first' },
    { channel: sub.channel, phone: 'paired-key', upload: 'second' },
  ])
  assert.equal(w.dsh.admitted.get(sub)?.size ?? 0, 0)
})

test('a refused send from another watch preserves the owner’s cancel', async (t) => {
  const w = await world(t, { host: { answer: (m) => m.method === 'send' ? reply(refuse('invalid')) : undefined } })
  const a = await rich(w)
  const b = await rich(w)
  await admitUpload(a, 'u1')
  const fields = { terminal, id: 'message', uploads: ['u1'] }
  assert.deepEqual(await b.call('chat.send', fields), { ...refuse('invalid'), id: fields.id })
  assert.deepEqual(w.socket.calls('send').map((m) => m.params), [
    { channel: 2, phone: 'paired-key', text: '', id: fields.id, uploads: fields.uploads, by: 'Test phone' },
  ])
  assert.deepEqual(await a.call('chat.attachCancel', { terminal, upload: 'u1' }), { ok: true })
  assert.deepEqual(w.socket.calls('upload-cancel').map((m) => m.params), [{ channel: 1, phone: 'paired-key', upload: 'u1' }])
})

test('a pending send leaves every named admission owned until its reply', async (t) => {
  const w = await world(t, { host: { answer: (m) => m.method === 'send' ? null : undefined } })
  const p = await rich(w)
  const sub = w.dsh.subs.get(1)
  for (const upload of ['first', 'second', 'kept']) await admitUpload(p, upload)
  const id = p.feed('chat.send', { terminal, id: 'message', uploads: ['first', 'second'] })
  await tick()
  const [send] = w.socket.calls('send')
  assert.ok(send)
  assert.equal(p.answers(id).length, 0)
  assert.deepEqual([...w.dsh.admitted.get(sub).keys()], ['first', 'second', 'kept'])
  for (const upload of ['first', 'second']) {
    assert.deepEqual(await p.call('chat.attachCancel', { terminal, upload }), { ok: true })
  }
  assert.equal(w.socket.calls('upload-cancel').length, 2)
  w.socket.answer(send)
  await tick()
  assert.deepEqual(p.answer(id).result, { ok: true, state: 'sent', id: 'message' })
})

test('an oversized or thrown send preserves the admitted cancel', async (t) => {
  for (const reason of ['too-long', 'offline']) {
    const w = await world(t, { host: { throwWrite: (m) => m.method === 'send' && reason === 'offline' } })
    const p = await rich(w)
    await admitUpload(p, 'u1')
    const text = reason === 'too-long' ? '\0'.repeat(16000) : ''
    assert.deepEqual(await p.call('chat.send', { terminal, id: 'message', uploads: ['u1'], text }), { ...refuse(reason), id: 'message' })
    assert.equal(w.socket.calls('send').length, 0)
    assert.deepEqual(await p.call('chat.attachCancel', { terminal, upload: 'u1' }), { ok: true })
    assert.deepEqual(w.socket.calls('upload-cancel').map((m) => m.params), [{ channel: 1, phone: 'paired-key', upload: 'u1' }])
  }
})

test('a fresh send is forwarded unchanged after cancel forgets its upload', async (t) => {
  const w = await world(t, { host: { answer: (m) => m.method === 'send' ? reply(refuse('expired')) : undefined } })
  const p = await rich(w)
  await admitUpload(p, 'u1')
  assert.deepEqual(await p.call('chat.attachCancel', { terminal, upload: 'u1' }), { ok: true })
  const fields = { id: 'message', uploads: ['u1'], text: 'caption' }
  assert.deepEqual(await p.call('chat.send', { terminal, ...fields }), { ...refuse('expired'), id: fields.id })
  assert.deepEqual(w.socket.requests.slice(-2).map(({ method, params }) => [method, params]), [
    ['upload-cancel', { channel: 1, phone: 'paired-key', upload: 'u1' }],
    ['send', { channel: 1, phone: 'paired-key', ...fields, by: 'Test phone' }],
  ])
})

test('a send written during finish makes both cancels local and leaves finish to settle', async (t) => {
  const w = await world(t, { host: { answer: (m) => m.method === 'upload-finish' ? null : undefined } })
  const p = await rich(w)
  await p.begin()
  await p.chunk()
  const params = { terminal, upload: 'u1' }
  const finish = p.feed('chat.attachFinish', params)
  await tick()
  const [pending] = w.socket.calls('upload-finish')
  assert.ok(pending)
  assert.deepEqual(await p.call('chat.send', { terminal, id: 'message', uploads: ['u1'] }), { ok: true, state: 'sent', id: 'message' })
  assert.equal(w.socket.calls('send').length, 1)
  assert.deepEqual(await p.call('chat.attachCancel', params), { ok: true })
  assert.equal(w.socket.calls('upload-cancel').length, 0)
  assert.equal(p.answers(finish).length, 0)
  w.socket.answer(pending)
  await tick()
  assert.deepEqual(await p.call('chat.attachCancel', params), { ok: true })
  assert.deepEqual(p.answer(finish).result, admitted('u1'))
  assert.equal(w.socket.calls('upload-cancel').length, 0)
  assert.equal(w.dsh.admitted.get(w.dsh.subs.get(1))?.has('u1') ?? false, false)
})

test('a refused send of an open upload leaves a later admission cancellable', async (t) => {
  const w = await world(t, { host: { answer: (m) => m.method === 'send' ? reply(refuse('expired')) : undefined } })
  const p = await rich(w)
  assert.equal((await p.begin()).state, 'open')
  assert.deepEqual(await p.call('chat.send', { terminal, id: 'message', uploads: ['u1'] }), { ...refuse('expired'), id: 'message' })
  assert.equal(w.socket.calls('send').length, 1)
  assert.deepEqual(await p.chunk(), { ok: true, received: 1 })
  const params = { terminal, upload: 'u1' }
  assert.deepEqual(await p.call('chat.attachFinish', params), admitted('u1'))
  assert.deepEqual(await p.call('chat.attachCancel', params), { ok: true })
  assert.deepEqual(w.socket.calls('upload-cancel').map((m) => m.params), [{ channel: 1, phone: 'paired-key', upload: 'u1' }])
})

test('foreign and unknown admitted cancels stay local', async (t) => {
  const w = await world(t)
  const owner = await rich(w)
  const samePhone = await rich(w)
  const otherPhone = await rich(w, { device: 'other-key' })
  await admitUpload(owner, 'u1')
  for (const p of [samePhone, otherPhone]) {
    assert.deepEqual(await p.call('chat.attachCancel', { terminal, upload: 'u1' }), { ok: true })
  }
  assert.deepEqual(await owner.call('chat.attachCancel', { terminal, upload: 'unknown' }), { ok: true })
  assert.equal(w.socket.calls('upload-cancel').length, 0)
  assert.equal(w.dsh.admitted.get(w.dsh.subs.get(1)).has('u1'), true)
})

test('gone, watch close, revocation and shutdown clear their admitted entries', async (t) => {
  const w = await world(t)
  const gone = await rich(w)
  const closed = await rich(w)
  const revoked = await rich(w)
  const kept = await rich(w, { device: 'kept-key' })
  const subs = [...w.dsh.subs.values()]
  for (const [i, p] of [gone, closed, revoked, kept].entries()) await admitUpload(p, `u${i}`)
  assert.deepEqual([...w.dsh.admitted.keys()], subs)
  w.socket.event(subs[0].channel, { type: 'gone' })
  await tick()
  assert.deepEqual([...w.dsh.admitted.keys()], subs.slice(1))
  closed.closeWatch(1)
  await tick()
  assert.deepEqual([...w.dsh.admitted.keys()], subs.slice(2))
  assert.equal(endRemoved(new Set([revoked.peer, kept.peer]), new Set(['kept-key'])), 1)
  assert.deepEqual([...w.dsh.admitted.keys()], subs.slice(3))
  w.dsh.close()
  assert.equal(w.dsh.admitted.size, 0)
})

test('a delayed socket close clears old admissions and spares the replacement watch', async (t) => {
  for (const changedHome of [false, true]) {
    let home = '/test/team'
    const w = await world(t, { options: { realpath: () => home } })
    const stale = await rich(w)
    await admitUpload(stale, 'old')
    const oldSub = w.dsh.subs.get(1)
    const oldSocket = w.socket
    // Hold the close event until the replacement has admitted an upload.
    oldSocket.destroy = () => {
      oldSocket.destroyed = true
      oldSocket.watches.clear()
    }
    oldSocket.destroy()
    if (changedHome) home = '/test/other-team'
    const replacement = await w.dsh.open()
    assert.notEqual(replacement, oldSocket)
    const params = { terminal, upload: 'old' }
    assert.deepEqual(await stale.call('chat.attachCancel', params), refuse('read-only'))
    const fresh = await rich(w)
    const newSub = w.dsh.subs.get(2)
    await admitUpload(fresh, 'new')
    assert.equal(w.dsh.admitted.get(oldSub).has('old'), true)
    assert.equal(w.dsh.admitted.get(newSub).has('new'), true)
    oldSocket.emit('close')
    assert.equal(w.dsh.admitted.has(oldSub), false)
    assert.equal(w.dsh.admitted.get(newSub).has('new'), true)
    assert.deepEqual(await fresh.call('chat.attachCancel', params), { ok: true })
    assert.equal(oldSocket.calls('upload-cancel').length, 0)
    assert.equal(replacement.calls('upload-cancel').length, 0)
  }
})

test('admitted entries expire at 15 minutes on lookup and insertion', async (t) => {
  const w = await world(t)
  const p = await rich(w)
  const sub = w.dsh.subs.get(1)
  for (const upload of ['lookup', 'insert']) await admitUpload(p, upload)
  await w.clock.advance(15 * 60_000)
  assert.deepEqual(await p.call('chat.attachCancel', { terminal, upload: 'lookup' }), { ok: true })
  assert.equal(w.socket.calls('upload-cancel').length, 0)
  assert.equal(w.dsh.admitted.get(sub)?.has('lookup') ?? false, false)
  await admitUpload(p, 'fresh')
  assert.deepEqual([...w.dsh.admitted.get(sub).keys()], ['fresh'])
})

test('admissions evict the oldest id across watches of the same paired phone', async (t) => {
  const w = await world(t)
  const a = await rich(w)
  const b = await rich(w)
  const [aSub, bSub] = w.dsh.subs.values()
  await admitUpload(b, 'kept')
  for (let i = 0; i < 129; i++) await admitUpload(a, `u${i}`)
  assert.deepEqual([...w.dsh.admitted.get(aSub).keys()], Array.from({ length: 128 }, (_, i) => `u${i + 1}`))
  assert.deepEqual([...w.dsh.admitted.get(bSub).keys()], [])
  assert.deepEqual(await a.call('chat.attachCancel', { terminal, upload: 'u0' }), { ok: true })
  assert.equal(w.socket.calls('upload-cancel').length, 0)
})

test('an unanswered admitted cancel remains owned and can be retried on the same watch', async (t) => {
  const w = await world(t, { host: { answer: (m, socket) => m.method === 'upload-cancel' && socket.calls('upload-cancel').length === 1 ? null : undefined } })
  const p = await rich(w)
  await admitUpload(p, 'u1')
  const params = { terminal, upload: 'u1' }
  const cancel = p.feed('chat.attachCancel', params)
  await tick()
  assert.equal(w.socket.calls('upload-cancel').length, 1)
  await w.clock.advance(w.dsh.attachmentMs.cancel - 1)
  assert.equal(p.answers(cancel).length, 0)
  await w.clock.advance(1)
  assert.deepEqual(p.answer(cancel).result, { ok: false, state: 'unknown', reason: 'offline' })
  assert.equal(w.socket.destroyed, false)
  assert.deepEqual(await p.call('chat.attachCancel', params), { ok: true })
  assert.equal(w.socket.calls('upload-cancel').length, 2)
  assert.deepEqual(await p.call('chat.attachCancel', params), { ok: true })
  assert.equal(w.socket.calls('upload-cancel').length, 2)
})

test('endRemoved waits for rich unsubscribe; an ack preserves the other phone and a missing ack drops the socket', async (t) => {
  for (const ack of [{}, null, { invalid: true }]) {
    let revoking = true
    const w = await world(t, { host: { answer(m) {
      if (m.method === 'upload-finish') return null
      if (m.method === 'unsubscribe' && m.params.channel <= 2 && revoking) return ack === null ? null : reply(ack)
    } } })
    const a = await rich(w, { device: 'removed' })
    const extra = await rich(w, { device: 'removed' })
    const survivor = await rich(w, { device: 'survivor' })
    await a.begin()
    await a.chunk()
    const finish = a.feed('chat.attachFinish', { terminal, upload: 'u1' })
    await tick()
    const oldSocket = w.socket
    const oldFinish = oldSocket.calls('upload-finish')[0]
    assert.equal((await survivor.begin('surviving')).state, 'open')
    const live = new Set([a.peer, extra.peer, survivor.peer])
    assert.equal(endRemoved(live, new Set(['survivor'])), 2)
    await tick()
    assert.deepEqual(a.ended, ['not paired'])
    assert.deepEqual(extra.ended, ['not paired'])
    assert.deepEqual(oldSocket.calls('unsubscribe').map((m) => m.params.channel), [1, 2])
    assert.equal(oldSocket.calls('upload-cancel').length, 0)
    oldSocket.answer(oldFinish)
    await tick()
    assert.equal(a.answers(finish).length, 0)
    assert.equal(oldSocket.destroyed, false)
    if (ack && !ack.invalid) {
      await w.clock.advance(1500)
      assert.equal(oldSocket.destroyed, false)
      assert.equal(w.dsh.uploads.get('survivor').upload, 'surviving')
      assert.deepEqual(await survivor.chunk('surviving'), { ok: true, received: 1 })
      assert.equal(survivor.events(1).some((e) => e.type === 'gone'), false)
    } else {
      await w.clock.advance(999)
      assert.equal(oldSocket.destroyed, false)
      await w.clock.advance(1)
      assert.equal(oldSocket.destroyed, true)
      assert.equal(w.dsh.uploads.size, 0)
      assert.deepEqual(survivor.events(1), [{ type: 'gone', reason: 'unavailable' }])
      assert.deepEqual(await survivor.watch(), { channel: 2 })
      assert.equal(w.socket.calls('subscribe')[0].params.attachments, undefined, 'the stale phone grant does not upgrade a new watch')
      revoking = false
      const fresh = await rich(w, { device: 'survivor' })
      assert.equal((await fresh.begin('again')).state, 'open')
    }
  }
})

test('queued thumbnails are replaced at write time after CLOSE, a replacement watch, or gone', async (t) => {
  for (const action of ['close', 'replace', 'gone']) {
    const w = await world(t)
    const gate = deferred()
    const p = await rich(w, { send: (bytes) => bytes.readUInt32LE(0) === 1 && bytes[4] === DATA ? gate.promise : undefined })
    w.socket.event(1, { type: 'snapshot', rows: [] })
    await tick()
    const id = p.feed('chat.attachmentRead', { terminal, row: row.id, block: 0 }, 'thumb')
    await tick()
    assert.equal(p.answers(id).length, 0)
    assert.equal(p.conn.attachmentInFlight, 1)
    if (action === 'gone') {
      w.socket.event(1, { type: 'gone', reason: 'not-shown' })
      await tick()
    } else {
      p.closeWatch(1)
      if (action === 'replace') p.feed('chat.subscribe', { terminal })
      await tick()
    }
    gate.resolve()
    await tick()
    assert.deepEqual(p.answer(id).result, refuse('not-watching'))
    assert.equal(p.conn.attachmentInFlight, 0)
    assert.equal(w.socket.calls('attachment-read').length, 1)
  }
})

test('a stalled phone writer bounds maximum thumbnails and releases attachment slots on drain or abort', async (t) => {
  const w = await world(t)
  for (const abort of [false, true]) {
    const gate = deferred()
    let blocked = true
    const p = await rich(w, { send: (bytes) => blocked && bytes.length > 130000 ? gate.promise : undefined })
    const ids = []
    for (let i = 0; i < 12; i++) {
      ids.push(p.feed('chat.attachmentRead', { terminal, row: row.id, block: 0 }))
      await tick()
    }
    assert.equal(p.conn.attachmentInFlight, 2)
    assert.equal(p.conn.inFlight, 0)
    assert.equal(w.socket.calls('attachment-read').length, abort ? 4 : 2)
    if (abort) {
      p.peer.end()
      assert.equal(p.conn.attachmentInFlight, 0)
    }
    blocked = false
    gate.resolve()
    await tick()
    assert.equal(p.conn.attachmentInFlight, 0)
    if (abort) assert.equal(p.writes.filter((bytes) => bytes.length > 130000).length, 1)
    else {
      for (const id of ids.slice(0, 2)) assert.deepEqual(p.answer(id).result, thumbnail)
      for (const id of ids.slice(2)) assert.deepEqual(p.answer(id).result, refuse('busy'))
    }
  }
})

test('cancel bypasses both busy limits once; invalid RPC ids still return invalid_params with id null', async (t) => {
  const list = deferred()
  const w = await world(t, {
    base: { ready: () => list.promise },
    host: { answer: (m) => ['upload-chunk', 'attachment-read', 'upload-cancel'].includes(m.method) ? null : undefined },
  })
  const p = await rich(w)
  await p.begin()
  p.feed('chat.attachChunk', { terminal, upload: 'u1', offset: 0, data: b64() })
  p.feed('chat.attachmentRead', { terminal, row: row.id, block: 0 })
  for (let i = 2; i < MAX_IN_FLIGHT; i++) p.feed('chat.list', {})
  await tick()
  assert.equal(p.conn.inFlight, MAX_IN_FLIGHT)
  assert.equal(p.conn.attachmentInFlight, 2)
  assert.deepEqual(await p.begin('u2'), refuse('busy'))
  for (const id of [{ name: secret }, 'a'.repeat(65), 2.5]) {
    p.feed('chat.attachCancel', { terminal, upload: 'u1' }, id)
    await tick()
  }
  assert.equal(p.answers(null).length, 3)
  assert.ok(p.answers(null).every((m) => m.error?.data.kind === 'invalid_params'))
  assert.equal(w.socket.calls('upload-cancel').length, 0)
  const cancel = p.feed('chat.attachCancel', { terminal, upload: 'u1' })
  assert.equal(p.conn.inFlight, MAX_IN_FLIGHT + 1)
  await tick()
  assert.deepEqual(await p.call('chat.attachCancel', { terminal, upload: 'u1' }), refuse('busy'))
  assert.equal(w.socket.calls('upload-cancel').length, 1)
  w.socket.answer(w.socket.calls('upload-cancel')[0])
  await w.clock.advance(20000)
  assert.deepEqual(p.answer(cancel).result, { ok: true })
  list.resolve()
  await tick()
  assert.equal(p.conn.inFlight, 0)
  assert.equal(p.conn.attachmentInFlight, 0)
  assert.equal(p.conn.cancelInFlight, false)
})

test('DSH byte budget preserves a busy chunk, exempts cleanup and clears on drain, throw and reconnect', async (t) => {
  const w = await world(t, { host: {
    stall: (m) => m.method === 'upload-chunk',
    answer: (m) => m.method === 'upload-chunk' ? null : undefined,
    throwWrite: (m) => m.method === 'attachment-read' && m.params.row === 'throws',
  } })
  // The fake accepts enough subscriptions to exercise the bridge's independent byte budget.
  const phones = []
  for (let i = 0; i < 33; i++) {
    const p = await rich(w, { device: `phone-${i}` })
    phones.push(p)
    await p.begin('u1', chunkBytes)
  }
  const params = { terminal, upload: 'u1', offset: 0, data: b64(chunkBytes) }
  const socket = w.socket
  for (const p of phones.slice(0, 31)) p.feed('chat.attachChunk', params)
  await tick()
  assert.equal(socket.calls('upload-chunk').length, 31)
  const queued = w.dsh.attachmentWrites.get(socket).bytes
  assert.ok(queued > 1_000_000 && queued < 1024 * 1024)
  const p = phones[31]
  assert.deepEqual(await p.call('chat.attachChunk', params), refuse('busy'))
  assert.equal(w.dsh.uploads.get('phone-31').acked, 0)
  assert.equal(w.dsh.uploads.get('phone-31').op, null)
  assert.equal(socket.calls('upload-chunk').length, 31)
  assert.deepEqual(await phones[0].call('chat.attachCancel', params), { ok: true })
  phones[1].closeWatch(1)
  await tick()
  assert.equal(socket.calls('upload-cancel').length, 1)
  assert.equal(socket.calls('unsubscribe').length, 1)
  assert.equal(w.dsh.attachmentWrites.get(socket).bytes, queued)
  socket.drain()
  assert.equal(w.dsh.attachmentWrites.size, 0)

  const retry = p.feed('chat.attachChunk', params)
  await tick()
  const chunk = socket.calls('upload-chunk').at(-1)
  assert.equal(chunk.params.phone, 'phone-31')
  socket.answer(chunk)
  await tick()
  assert.deepEqual(p.answer(retry).result, { ok: true, received: chunkBytes })
  const held = w.dsh.attachmentWrites.get(socket).bytes
  assert.deepEqual(await p.call('chat.attachmentRead', { terminal, row: 'throws', block: 0 }), refuse('offline'))
  assert.equal(w.dsh.attachmentWrites.get(socket).bytes, held)
  await w.clock.advance(25000)
  assert.equal(w.dsh.pending.size, 0)
  assert.equal(w.dsh.attachmentWrites.get(socket).bytes, held, 'timeout does not imply a flush')
  socket.destroy()
  await tick()
  assert.equal(w.dsh.attachmentWrites.size, 0)
  assert.equal(w.dsh.uploads.size, 0)
  socket.drain()
  assert.equal(w.dsh.attachmentWrites.size, 0, 'late write callbacks release once')
  for (let i = 0; i < 2; i++) {
    await w.dsh.open()
    const next = await rich(w, { device: 'reconnecting' })
    await next.begin(`new-${i}`, chunkBytes)
    const call = next.feed('chat.attachChunk', { ...params, upload: `new-${i}` })
    await tick()
    assert.ok(w.dsh.attachmentWrites.get(w.socket).bytes > 0)
    await w.clock.advance(25000)
    assert.deepEqual(next.answer(call).result, refuse('offline'))
    assert.equal(w.dsh.pending.size, 0)
    w.socket.destroy()
    await tick()
    assert.equal(w.dsh.attachmentWrites.size, 0)
    assert.equal(next.conn.attachmentInFlight, 0)
  }
})

test('name, invalid ids, non-DSH sends and escaped overlong captions never reach the socket', async (t) => {
  const w = await world(t)
  const p = await rich(w)
  for (const method of [...ATTACH_METHODS, 'chat.send']) {
    assert.deepEqual(await p.call(method, { terminal: 'missing', name: secret, uploads: ['u1'] }), refuse('invalid'))
  }
  assert.deepEqual(await p.call('chat.send', { terminal: 'local', id: 'msg', uploads: ['u1'] }), refuse('unsupported'))
  for (const fields of [
    { id: 'bad/id', uploads: ['u1'] }, { id: 'msg', uploads: [] }, { id: 'msg', uploads: ['u1', 'u1'] },
    { id: 'msg', uploads: ['u1', 'u2', 'u3', 'u4', 'u5'] }, { id: 'msg', uploads: ['bad/id'] },
    { id: 'msg', uploads: ['u1'], text: null },
  ]) assert.deepEqual(await p.call('chat.send', { terminal, ...fields }), refuse('invalid'))
  assert.deepEqual(await p.call('chat.send', { terminal, id: 'msg', uploads: ['u1'], text: 'é'.repeat(16385) }), { ...refuse('too-long'), id: 'msg' })
  assert.deepEqual(await p.call('chat.send', { terminal, id: 'msg', uploads: ['u1'], text: '\0'.repeat(16000) }), { ...refuse('too-long'), id: 'msg' })
  assert.equal(w.socket.calls('send').length, 0)
  assert.equal(w.socket.requests.filter((m) => socketMethods.includes(m.method)).length, 0)
  assert.equal(w.logs.join('').includes(secret), false)
  assert.equal(Buffer.concat(p.writes).includes(secret), false)
})

test('attachment refusal envelopes, successes and engine failures expose only permitted fields', async (t) => {
  let answer
  const w = await world(t, { host: { answer: (m) => ['upload-begin', 'send', 'attachment-read'].includes(m.method) ? answer?.(m) : undefined } })
  const p = await rich(w)
  answer = () => ({ error: { kind: 'rejected', code: 'INVALID_IMAGE', upload: 'u1', message: secret, extra: secret } })
  assert.deepEqual(await p.begin(), { ...refuse('rejected'), code: 'INVALID_IMAGE', upload: 'u1' })
  answer = () => reply({ ...refuse('rejected'), code: 'INVALID_IMAGE', upload: 'u2', message: secret, extra: secret })
  assert.deepEqual(await p.begin('u2'), { ...refuse('rejected'), code: 'INVALID_IMAGE', upload: 'u2' })
  answer = () => reply({ ...refuse('rejected'), code: secret, upload: 'somebody-else', message: secret })
  assert.deepEqual(await p.begin('u3'), refuse('failed'))
  answer = () => reply({ ...refuse(secret), message: secret })
  assert.deepEqual(await p.read(), refuse('failed'))
  for (const [reason, code] of [['expired', 'FILE_NOT_STAGED'], ['rejected', 'MODEL_DOES_NOT_SUPPORT_IMAGES']]) {
    answer = () => reply({ ...refuse(reason), code, message: secret })
    assert.deepEqual(await p.call('chat.send', { terminal, id: 'msg', uploads: ['u1'] }), { ...refuse(reason), code, id: 'msg' })
  }
  answer = () => reply({ ok: true, state: 'queued', id: 'wrong', receipt: secret })
  assert.deepEqual(await p.call('chat.send', { terminal, id: 'msg', uploads: ['u1'] }), { ...refuse('failed'), id: 'msg' })
  answer = () => reply({ ok: true, state: 'queued', id: 'msg', repeat: true, receipt: secret })
  assert.deepEqual(await p.call('chat.send', { terminal, id: 'msg', uploads: ['u1'] }), { ok: true, state: 'queued', id: 'msg', repeat: true })
  const broken = await rich(w, { overrides: { uploadBegin() { throw new Error(secret) } } })
  assert.deepEqual(await broken.begin('thrown'), refuse('failed'))
  assert.deepEqual(w.logs, ['chat: attachment request failed'])
  assert.equal(Buffer.concat([...p.writes, ...broken.writes]).includes(secret), false)
})

test('read validates variant bytes, dimension and media, then shares rate and busy limits across connections', async (t) => {
  let answer
  const w = await world(t, { host: { answer: (m) => m.method === 'attachment-read' ? answer : undefined } })
  const a = await rich(w)
  const b = await rich(w)
  for (const patch of [{ mediaType: 'image/svg+xml' }, { height: 513 }, { width: 1.5 }, { data: 'AR==' }, { data: '' }, { data: b64(131073) }]) {
    answer = reply({ ...thumbnail, ...patch, name: secret })
    assert.deepEqual(await a.read(), refuse('failed'))
  }
  answer = reply({ ...thumbnail, name: secret })
  assert.deepEqual(await a.call('chat.attachmentRead', { terminal, row: row.id, block: 0, phone: 'wrong', channel: 2 }), thumbnail)
  assert.deepEqual(w.socket.calls('attachment-read').at(-1).params, { channel: 1, phone: 'paired-key', row: row.id, block: 0 })
  assert.deepEqual(await a.call('chat.attachmentRead', { terminal, row: 'r'.repeat(257), block: 0 }), refuse('invalid'))
  assert.deepEqual(await a.call('chat.attachmentRead', { terminal, row: row.id, block: -1 }), refuse('invalid'))
  answer = null
  const request = a.feed('chat.attachmentRead', { terminal, row: row.id, block: 0 })
  await tick()
  assert.deepEqual(await b.read(), refuse('busy'))
  await w.clock.advance(19999)
  assert.equal(a.answers(request).length, 0)
  await w.clock.advance(1)
  assert.deepEqual(a.answer(request).result, refuse('offline'))
  const manager = w.phone()
  await manager.hello({ attachments: 1, manage: ['memory.read'] })
  for (let i = 0; i < 50; i++) assert.equal((await manager.call('memory.read', { terminal })).state, 'read')
  assert.deepEqual(await b.read(), refuse('rate'))
  assert.equal(w.socket.calls('attachment-read').length, 8)
  await w.clock.advance(60000)
  answer = reply(thumbnail)
  assert.deepEqual(await b.read(), thumbnail)
})

test('GIF thumbnails pass through unchanged while the upload offer keeps PNG, JPEG and WebP', async (t) => {
  const uploadTypes = ['image/png', 'image/jpeg', 'image/webp']
  const gif = {
    ok: true, mediaType: 'image/gif', width: 1, height: 1,
    data: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  }
  const w = await world(t, { host: {
    offer: () => ({ ...offer(), mediaTypes: [...uploadTypes, 'image/gif'] }),
    answer: (m) => m.method === 'attachment-read' ? reply(gif) : undefined,
  } })
  const p = w.phone()
  assert.deepEqual((await p.hello()).attachments.mediaTypes, uploadTypes)
  await p.watch()
  assert.deepEqual(await p.read(), gif)
})

test('fake manifest Retry forwards both uploads after reconnect with a one-file offer', async (t) => {
  let files = 4
  const inserted = new Map()
  const w = await world(t, { host: {
    offer: () => ({ ...offer(), limits: { ...limits, files } }),
    answer(m) {
      if (m.method !== 'send') return
      const { id, uploads, text } = m.params
      const signature = JSON.stringify({ uploads, text })
      if (inserted.has(id)) {
        assert.equal(inserted.get(id), signature)
        return reply({ ok: true, state: 'sent', id, repeat: true })
      }
      if (uploads.length > files) return reply(refuse('too-large'))
      inserted.set(id, signature)
      return null
    },
  } })
  const a = await rich(w)
  const fields = { terminal, id: 'message', uploads: ['u1', 'u2'], text: 'caption' }
  const first = a.feed('chat.send', fields)
  await tick()
  await w.clock.advance(5000)
  assert.deepEqual(a.answer(first).result, { ...refuse('offline'), id: 'message' })
  assert.equal(w.socket.calls('send').length, 1)
  w.socket.destroy()
  await tick()
  files = 1
  await w.dsh.open()
  assert.deepEqual(await a.call('chat.send', fields), refuse('read-only'))
  const b = w.phone()
  assert.equal((await b.hello()).attachments.limits.files, 1)
  await b.watch()
  assert.deepEqual(await b.call('chat.send', fields), { ok: true, state: 'sent', id: 'message', repeat: true })
  assert.deepEqual(w.socket.calls('send')[0].params.uploads, ['u1', 'u2'])
  assert.deepEqual(await b.call('chat.send', { ...fields, id: 'fresh' }), { ...refuse('too-large'), id: 'fresh' })
  assert.equal(inserted.size, 1)
})

test('text-only send still forwards the socket refusal, and upload sends share the same write limits', async (t) => {
  const textRefusal = { ...refuse('changed'), message: 'text-send refusal', receipt: { row: 'r1' } }
  let hold = true
  const w = await world(t, { host: { answer(m) {
    if (m.method === 'send') {
      if (!Object.hasOwn(m.params, 'uploads')) return reply(textRefusal)
      if (hold) return null
    }
  } } })
  const a = await rich(w)
  const b = await rich(w)
  const fields = { terminal, id: 'message', uploads: ['u1'] }
  const first = a.feed('chat.send', fields)
  await tick()
  assert.deepEqual(await b.call('chat.send', { terminal, text: 'one', id: 'text' }), { ...refuse('busy'), id: 'text' })
  w.socket.answer(w.socket.calls('send')[0])
  await tick()
  assert.equal(a.answer(first).result.state, 'sent')
  assert.deepEqual(await b.call('chat.send', { terminal, text: 'two', id: 'text' }), { ...textRefusal, id: 'text' })
  assert.equal(Object.hasOwn(w.socket.calls('send')[1].params, 'uploads'), false)
  hold = false
  for (let i = 0; i < 18; i++) assert.equal((await b.call('chat.send', { ...fields, id: `send-${i}` })).state, 'sent')
  assert.deepEqual(await b.call('chat.send', fields), { ...refuse('rate'), id: 'message' })
  assert.equal(w.socket.calls('send').length, 20)
})

test('incorrect chunk credit and malformed finish replies release only their own upload through cancel', async (t) => {
  let change
  const w = await world(t, { host: { answer: (m) => change?.(m) } })
  const p = await rich(w)
  change = (m) => m.method === 'upload-chunk' ? reply({ ok: true, received: 0, message: secret }) : undefined
  await p.begin('wrong-credit')
  assert.deepEqual(await p.chunk('wrong-credit'), refuse('failed'))
  assert.equal(w.socket.calls('upload-cancel').at(-1).params.upload, 'wrong-credit')
  change = undefined
  const malformed = [
    { upload: 'different' },
    { image: { ...image, mediaType: 'image/svg+xml' } },
    { image: { ...image, stored: 0 } },
    { image: { ...image, height: Number.MAX_SAFE_INTEGER + 1 } },
  ]
  for (const [i, patch] of malformed.entries()) {
    const upload = `wrong-finish-${i}`
    await p.begin(upload)
    assert.deepEqual(await p.chunk(upload), { ok: true, received: 1 })
    change = (m) => m.method === 'upload-finish' ? reply({ ...admitted(upload), ...patch, name: secret }) : undefined
    assert.deepEqual(await p.call('chat.attachFinish', { terminal, upload }), refuse('failed'))
    assert.equal(w.socket.calls('upload-cancel').at(-1).params.upload, upload)
    assert.equal(w.dsh.uploads.size, 0)
  }
  assert.equal(Buffer.concat(p.writes).includes(secret), false)
})
