// RFC 0033 document negotiation and admission through the framed phone route and NDJSON socket.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { setImmediate as tick } from 'node:timers/promises'
import { test } from 'node:test'
import { ChatConnection, DATA, frame } from './chat.mjs'
import { DshSource, withDsh } from './dsh-source.mjs'

const terminal = 'dsh:example'
const txt = 'text/plain'
const pdf = 'application/pdf'
const png = 'image/png'
const chunkBytes = 24_576
const MiB = 1024 * 1024
const optIn = { attachments: 1, documents: 1 }
const documents = { mediaTypes: [txt, pdf], limits: { fileBytes: 8 * MiB } }
const socketMethods = ['upload-begin', 'upload-chunk', 'upload-finish', 'upload-cancel', 'attachment-read']
const vectors = JSON.parse(readFileSync(new URL('../../../../docs/rfcs/fixtures/0033-document-names.json', import.meta.url))).cases
const privateText = 'private-fixture-sentinel'
const refused = (reason, extra) => ({ ok: false, state: 'refused', reason, ...extra })
const unknown = { ok: false, state: 'unknown', reason: 'offline' }
const image = { mediaType: png, width: 1, height: 1, bytes: 1, stored: 2 }
const reply = (result) => ({ result })

function clock() {
  const timers = new Set()
  let now = 0
  return {
    now: () => now,
    timers: {
      setTimeout(run, ms) { const timer = { run, at: now + ms }; timers.add(timer); return timer },
      clearTimeout(timer) { timers.delete(timer) },
    },
    async advance(ms) {
      const end = now + ms
      for (;;) {
        const next = [...timers].filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!next) break
        now = next.at
        timers.delete(next)
        next.run()
        await tick()
      }
      now = end
    },
  }
}

class Wire extends EventEmitter {
  constructor(host) {
    super()
    this.host = host
    this.destroyed = false
    this.requests = []
    this.callbacks = []
    this.watches = new Map()
    queueMicrotask(() => this.emit('connect'))
  }

  setEncoding(encoding) { assert.equal(encoding, 'utf8') }

  write(line, callback) {
    const request = JSON.parse(line)
    this.requests.push({ ...request, line })
    if (this.host.stall?.(request)) this.callbacks.push(callback)
    else queueMicrotask(callback)
    const { method, params } = request
    if (method === 'subscribe') this.watches.set(params.channel, params)
    if (method === 'unsubscribe') this.watches.delete(params.channel)
    const answer = this.host.answer?.(request, this)
    if (answer !== null) this.respond(request, answer ?? reply(this.result(method, params)))
  }

  result(method, params) {
    switch (method) {
      case 'hello':
        return {
          protocol: 1, readOnly: false, write: 1, methods: ['send', ...socketMethods],
          attachments: {
            version: 1, mediaTypes: [png], methods: socketMethods, documents: this.host.documents,
            limits: { fileBytes: 8 * MiB, files: 4, messageBytes: 16 * MiB, deviceOutstanding: 32 * MiB,
              deviceDailyBytes: 256 * MiB, deviceDailyCount: 128, chunkBytes, maxPixels: 40_000_000,
              maxDimension: 65_535, thumbnail: { edge: 512, bytes: 131_072 } },
          },
        }
      case 'subscribe': return { channel: params.channel }
      case 'upload-begin': return { ok: true, state: 'open', upload: params.upload, chunkBytes }
      case 'upload-chunk': return { ok: true, received: params.offset + Buffer.from(params.data, 'base64').length }
      case 'upload-finish': return { ok: true, state: 'admitted', upload: params.upload, image }
      case 'upload-cancel': return { ok: true }
      case 'attachment-read': return refused('not-found')
      case 'send': return { ok: true, state: 'sent', id: params.id }
      default: return {}
    }
  }

  respond(request, answer) { this.receive({ id: request.id, ...answer }) }
  receive(message) { queueMicrotask(() => this.emit('data', JSON.stringify(message) + '\n')) }
  calls(method) { return this.requests.filter((request) => request.method === method) }
  drain() { for (const callback of this.callbacks.splice(0)) callback() }
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    queueMicrotask(() => this.emit('close'))
  }
}

function phone(t, engine, device, log) {
  const answers = new Map()
  const events = []
  let next = 0
  const conn = new ChatConnection({
    engine, device, log, end() {},
    write(bytes) {
      if (bytes[0] === 0x7b) {
        const message = JSON.parse(bytes)
        answers.get(message.id)(message.result)
      } else if (bytes[4] === DATA) {
        const message = JSON.parse(bytes.subarray(9))
        const channel = bytes.readUInt32LE(0)
        if (channel === 0) answers.get(message.id)(message.result)
        else events.push({ channel, ...message })
      }
    },
  })
  t.after(() => conn.close())
  const request = (method, params, hello = false) => {
    const id = next++
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    return new Promise((resolve) => {
      answers.set(id, (result) => { answers.delete(id); resolve(result) })
      conn.feed(hello ? Buffer.concat([payload, Buffer.from('\n')]) : frame(0, DATA, payload))
    })
  }
  const call = async (method, params) => {
    const result = await request(method, { terminal, ...params })
    await tick()
    return result
  }
  return {
    conn, events, call,
    hello: (opts) => request('hello', { generation: 1, framed: true, ...opts }, true),
    watch: () => call('chat.subscribe'),
    begin: (upload, mediaType = pdf, fields) => call('chat.attach', { upload, mediaType, bytes: 1, ...fields }),
    chunk: (upload) => call('chat.attachChunk', { upload, offset: 0, data: 'YQ==' }),
    finish: (upload) => call('chat.attachFinish', { upload }),
    cancel: (upload) => call('chat.attachCancel', { upload }),
    send: (uploads, id = 'message') => call('chat.send', { id, uploads }),
  }
}

async function setup(t, { host = {}, options = {} } = {}) {
  const time = clock()
  const logs = []
  const log = (line) => logs.push(line)
  const dsh = new DshSource({
    ...time, path: '/fixture/pocket/chat.sock', realpath: (path) => path, check: () => true,
    log, attachments: true, documents: true, connect: () => new Wire({ documents, ...host }), ...options,
  })
  const engine = withDsh({}, dsh)
  t.after(() => dsh.close())
  await dsh.open()
  return {
    dsh, time, logs,
    get socket() { return dsh.socket },
    async phone(opts = optIn, key = 'paired-key', watch = true) {
      const p = phone(t, engine, key, log)
      p.offer = await p.hello(opts)
      if (watch) p.channel = (await p.watch()).channel
      return p
    },
  }
}

const fileAdmitted = (upload, mediaType, name, bytes = 1) => ({
  ok: true, state: 'admitted', upload, file: { mediaType, name, bytes },
})

async function admit(p, upload, mediaType = png) {
  assert.equal((await p.begin(upload, mediaType)).state, 'open')
  assert.deepEqual(await p.chunk(upload), { ok: true, received: 1 })
  assert.equal((await p.finish(upload)).state, 'admitted')
}

test('document negotiation uses strict flags and keeps rich rows on images-only watches', async (t) => {
  const file = { type: 'file', block: 1, name: 'report.pdf', bytes: 12 }
  const caption = { id: 'caption', kind: 'text', role: 'user', text: 'caption', blocks: [file] }
  const fileOnly = { ...caption, id: 'file', text: '' }
  const rows = [caption, fileOnly]
  const w = await setup(t, { host: { answer: (m) => m.method === 'backfill' ? reply({ rows }) : undefined } })
  assert.deepEqual(w.socket.calls('hello').map((m) => m.params), [
    { write: 1, ...optIn }, { write: 1, ...optIn, manage: 1 },
  ])
  const rich = await w.phone()
  const images = await w.phone({ attachments: 1, documents: true })
  const legacy = await w.phone({ attachments: true, documents: 1 })
  assert.deepEqual(rich.offer.attachments.documents, documents)
  assert.equal(Object.hasOwn(images.offer.attachments, 'documents'), false)
  assert.equal(Object.hasOwn(legacy.offer, 'attachments'), false)
  assert.deepEqual(w.socket.calls('subscribe').map((m) => m.params), [
    { terminal, channel: 1, ...optIn }, { terminal, channel: 2, attachments: 1 }, { terminal, channel: 3 },
  ])
  for (const p of [images, legacy]) {
    assert.deepEqual(await p.begin('without-grant', pdf, { name: 'report.pdf' }), refused('unsupported'))
  }
  assert.equal(w.socket.calls('upload-begin').length, 0)
  for (const [channel] of w.socket.watches) w.socket.receive({ channel, event: { type: 'snapshot', rows } })
  await tick()
  const { blocks, ...legacyCaption } = caption
  assert.deepEqual(legacy.events.map((e) => e.rows), [[legacyCaption]])
  assert.deepEqual(await legacy.call('chat.backfill', { before: 'file' }), { rows: [legacyCaption] })
  assert.deepEqual(images.events.map((e) => e.rows), [rows])
  assert.deepEqual(await images.call('chat.attachmentRead', { row: caption.id, block: file.block }), refused('not-found'))
  assert.equal(w.socket.calls('attachment-read').length, 1)
  await admit(images, 'image')
})

test('invalid and unsolicited document offers leave image admission available', async (t) => {
  for (const input of [undefined, { mediaTypes: pdf, limits: { fileBytes: 1 } },
    { mediaTypes: [png], limits: { fileBytes: 1 } },
    ...[0, 1.5, Number.MAX_SAFE_INTEGER + 1].map((fileBytes) => ({ ...documents, limits: { fileBytes } }))]) {
    const w = await setup(t, { host: { documents: input } })
    const p = await w.phone()
    assert.equal(Object.hasOwn(p.offer.attachments, 'documents'), false)
    assert.deepEqual(await p.begin('document', pdf, { name: 'report.pdf' }), refused('unsupported'))
    assert.equal(w.socket.calls('upload-begin').length, 0)
    await admit(p, 'image')
  }
  const disabled = await setup(t, { options: { documents: false } })
  assert.deepEqual(disabled.socket.calls('hello').map((m) => m.params), [
    { write: 1, attachments: 1 }, { write: 1, attachments: 1, manage: 1 },
  ])
  assert.equal(Object.hasOwn((await disabled.phone()).offer.attachments, 'documents'), false)

  const larger = { mediaTypes: [png, pdf, pdf, txt], limits: { fileBytes: 16 * MiB } }
  const capped = await setup(t, { host: { documents: larger } })
  assert.deepEqual((await capped.phone()).offer.attachments.documents, documents)
})

test('begin enforces the negotiated document type and byte limits before writing', async (t) => {
  const onlyPdf = { mediaTypes: [pdf], limits: { fileBytes: 5 } }
  const w = await setup(t, { host: { documents: onlyPdf } })
  const p = await w.phone()
  assert.deepEqual(p.offer.attachments.documents, onlyPdf)
  assert.deepEqual(await p.begin('text', txt, { name: 'report.txt' }), refused('unsupported'))
  for (const bytes of [0, 1.5, 6, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(await p.begin('oversize', pdf, { bytes }), refused('too-large'))
  }
  assert.equal(w.socket.calls('upload-begin').length, 0)
  assert.equal((await p.begin('valid', pdf, { bytes: 5 })).state, 'open')
})

test('the framed document begin shares the canonical leaf vectors and retains only the leaf', async (t) => {
  let expected
  const w = await setup(t, { host: { answer(m) {
    if (m.method === 'upload-finish') return reply(fileAdmitted(m.params.upload, expected.type, expected.leaf))
  } } })
  const p = await w.phone()
  for (const [i, vector] of vectors.entries()) {
    expected = vector
    const upload = `document-${i}`
    const writes = w.socket.calls('upload-begin').length
    const name = vector.absent ? {} : { name: vector.name }
    const result = await p.begin(upload, vector.type, name)
    if (vector.invalid) {
      assert.deepEqual(result, refused('invalid'), vector.note)
      assert.equal(w.socket.calls('upload-begin').length, writes)
      continue
    }
    assert.deepEqual(result, { ok: true, state: 'open', upload, chunkBytes }, vector.note)
    assert.deepEqual(w.socket.calls('upload-begin').at(-1).params, {
      channel: 1, phone: 'paired-key', upload, mediaType: vector.type, bytes: 1, ...name,
    })
    const record = w.dsh.uploads.get('paired-key')
    assert.equal(record.leaf, vector.leaf)
    assert.equal(Object.hasOwn(record, 'name'), false)
    if (vector.name === 'C:\\parent\\Draft.PDF') assert.equal(Object.values(record).includes(vector.name), false)
    assert.deepEqual(await p.chunk(upload), { ok: true, received: 1 })
    assert.deepEqual(await p.finish(upload), fileAdmitted(upload, vector.type, vector.leaf), vector.note)
  }
  for (const method of ['chat.attach', 'chat.attachChunk', 'chat.attachFinish', 'chat.attachCancel', 'chat.attachmentRead', 'chat.send']) {
    assert.deepEqual(await p.call(method, { upload: 'bad', mediaType: method === 'chat.attach' ? png : pdf,
      bytes: 1, id: 'message', uploads: ['bad'], name: null }), refused('invalid'))
  }
  assert.deepEqual(w.logs, [])
})

test('finish projects exactly the validated file or image arm and compensates for malformed successes', async (t) => {
  let result
  const w = await setup(t, { host: { answer(m) {
    if (m.method === 'upload-finish') return reply(result(m.params.upload))
  } } })
  const p = await w.phone()
  const file = { mediaType: pdf, name: 'document.pdf', bytes: 1 }
  for (const [i, [type, arms, expected]] of [
    [pdf, { file: { ...file, receipt: privateText }, image: null }, { file }],
    [png, { image: { ...image, name: privateText }, file: null }, { image }],
    [pdf, { file, image }],
    [png, { file, image }],
    [pdf, { image }],
    [png, { file }],
    [pdf, { file: { ...file, name: privateText } }],
    [pdf, { file: { ...file, bytes: 2 } }],
    [pdf, { file: { ...file, mediaType: txt } }],
    [pdf, { file, upload: 'wrong-id' }],
    [pdf, { file, image: false }],
    [pdf, { file: null, image: null }],
  ].entries()) {
    const upload = `finish-${i}`
    result = (id) => ({ ok: true, state: 'admitted', upload: id, receipt: privateText, ...arms })
    const cancels = w.socket.calls('upload-cancel').length
    assert.equal((await p.begin(upload, type)).state, 'open')
    assert.deepEqual(await p.chunk(upload), { ok: true, received: 1 })
    assert.deepEqual(await p.finish(upload), expected ? { ok: true, state: 'admitted', upload, ...expected } : refused('failed'))
    assert.equal(w.socket.calls('upload-cancel').length, cancels + (expected ? 0 : 1))
  }
  assert.deepEqual(w.logs, [])
})

test('a lost document finish acknowledgement is unknown and cannot be replayed', async (t) => {
  const w = await setup(t, { host: { answer: (m) => m.method === 'upload-finish' ? null : undefined } })
  const p = await w.phone()
  const upload = 'lost-finish'
  await p.begin(upload)
  await p.chunk(upload)
  const result = p.finish(upload)
  await tick()
  const [finish] = w.socket.calls('upload-finish')
  await w.time.advance(w.dsh.attachmentMs.finish)
  assert.deepEqual(await result, { ...unknown, upload })
  assert.equal(w.socket.calls('upload-cancel').length, 1)
  w.socket.respond(finish, reply(fileAdmitted(upload, pdf, 'document.pdf')))
  assert.deepEqual(await p.finish(upload), refused('invalid'))
  assert.equal(w.socket.calls('upload-finish').length, 1)
})

test('both refusal envelopes forward only fixed attachment messages and codes', async (t) => {
  let envelope
  let refusal
  const w = await setup(t, { host: { answer(m) {
    if (!['upload-begin', 'send'].includes(m.method)) return
    const { reason, ...fields } = refusal
    const upload = m.method === 'upload-begin' ? { upload: m.params.upload } : {}
    return envelope === 'result' ? reply(refused(reason, { ...fields, ...upload, extra: privateText }))
      : { error: { kind: reason, ...fields, ...upload, extra: privateText } }
  } } })
  const p = await w.phone()
  for (envelope of ['result', 'error']) {
    for (const [i, [incoming, outgoing]] of [
      [{ reason: 'invalid', message: 'sign-in-code' }, refused('invalid', { message: 'sign-in-code' })],
      [{ reason: 'invalid', message: privateText }, refused('invalid')],
      [{ reason: 'unsupported', message: 'sign-in-code' }, refused('unsupported')],
      [{ reason: 'unsupported', code: 'SUBAGENT_FILE_UNSUPPORTED' }, refused('unsupported', { code: 'SUBAGENT_FILE_UNSUPPORTED' })],
      [{ reason: 'unsupported', code: privateText }, refused('failed')],
    ].entries()) {
      refusal = incoming
      const upload = `${envelope}-${i}`
      assert.deepEqual(await p.begin(upload), { ...outgoing, upload })
      assert.deepEqual(await p.send([upload]), { ...outgoing, id: 'message' })
    }
    refusal = { reason: 'expired', code: 'FILE_NOT_STAGED', message: privateText }
    assert.deepEqual(await p.send(['used']), refused('expired', { id: 'message', code: 'FILE_NOT_STAGED' }))
  }
  assert.deepEqual(w.logs, [])
})

test('current-socket file refusals withdraw only later grants while subagent refusals stay local', async (t) => {
  const files = 'ATTACHMENT_FILES_UNSUPPORTED'
  const subagent = 'SUBAGENT_FILE_UNSUPPORTED'
  for (const step of ['begin', 'chunk', 'finish']) {
    let code = subagent
    const w = await setup(t, { host: { answer(m) {
      if (m.method === `upload-${step}` && ['subagent', 'files'].includes(m.params.upload)) {
        const fields = { code, upload: m.params.upload }
        return step === 'chunk' ? { error: { kind: 'unsupported', ...fields } } : reply(refused('unsupported', fields))
      }
      if (m.method === 'upload-begin' && m.params.upload === 'existing-after') {
        return reply(refused('unsupported', { code: files, upload: m.params.upload }))
      }
    } } })
    const p = await w.phone()
    const images = await w.phone({ attachments: 1 }, 'images-key')
    await images.begin('active-image', png)
    const run = async (upload) => {
      const began = await p.begin(upload)
      if (step === 'begin') return began
      assert.equal(began.state, 'open')
      const chunk = await p.chunk(upload)
      return step === 'chunk' ? chunk : p.finish(upload)
    }
    assert.deepEqual(await run('subagent'), refused('unsupported', { code: subagent, upload: 'subagent' }))
    assert.deepEqual((await w.phone(optIn, 'before-withdrawal', false)).offer.attachments.documents, documents)
    code = files
    assert.deepEqual(await run('files'), refused('unsupported', { code: files, upload: 'files' }))
    assert.deepEqual(await images.chunk('active-image'), { ok: true, received: 1 })
    assert.equal((await images.finish('active-image')).state, 'admitted')
    assert.equal(w.dsh.documentsFor(p.conn.client), true)
    const fresh = await w.phone()
    assert.equal(Object.hasOwn(fresh.offer.attachments, 'documents'), false)
    assert.deepEqual(await fresh.begin('fresh-after', pdf, { name: 'report.pdf' }), refused('unsupported'))
    assert.deepEqual(await p.begin('existing-after'), refused('unsupported', { code: files, upload: 'existing-after' }))
    assert.equal(w.socket.calls('upload-begin').at(-1).params.upload, 'existing-after')
  }
})

test('malformed and late old-socket refusals cannot withdraw a document offer', async (t) => {
  const code = 'ATTACHMENT_FILES_UNSUPPORTED'
  const host = { answer(m) {
    if (m.method !== 'upload-begin') return
    if (m.params.upload === 'wrong-echo') return reply(refused('unsupported', { code, upload: 'other' }))
    if (m.params.upload === 'late') return null
  } }
  const w = await setup(t, { host })
  const first = await w.phone()
  await first.begin('wrong-echo')
  assert.deepEqual((await w.phone(optIn, 'before', false)).offer.attachments.documents, documents)
  const pending = first.begin('late')
  await tick()
  const old = w.socket
  old.destroyed = true
  await w.dsh.open()
  old.respond(old.calls('upload-begin').at(-1), reply(refused('unsupported', { code, upload: 'late' })))
  await pending
  old.emit('close')
  assert.deepEqual((await w.phone()).offer.attachments.documents, documents)
  assert.equal(w.socket.calls('upload-cancel').length, 0)
})

test('the exact named begin line counts against the unflushed socket budget', async (t) => {
  const w = await setup(t, { host: { stall: (m) => ['upload-begin', 'send'].includes(m.method) } })
  const p = await w.phone()
  const name = '\u0000'.repeat(1020) + '.pdf'
  const upload = 'named'
  assert.equal(Buffer.byteLength(name), 1024)
  assert.equal((await p.begin(upload, pdf, { name })).state, 'open')
  const [begin] = w.socket.calls('upload-begin')
  const exact = JSON.stringify({ id: begin.id, method: 'upload-begin', params: {
    channel: 1, phone: 'paired-key', upload, mediaType: pdf, bytes: 1, name,
  } }) + '\n'
  assert.equal(begin.line, exact)
  assert.equal(w.dsh.attachmentWrites.get(w.socket).bytes, Buffer.byteLength(exact))
  await p.cancel(upload)
  w.socket.drain()
  assert.equal(w.dsh.attachmentWrites.has(w.socket), false)

  // Stall real serialized writes until only 512 bytes of the budget are free.
  let remaining = MiB - 512
  while (remaining > 0) {
    const method = 'send'
    const params = { channel: 1, phone: 'paired-key', id: 'filler', uploads: [upload], by: 'Phone', text: '' }
    const overhead = Buffer.byteLength(JSON.stringify({ id: w.dsh.nextId, method, params }) + '\n')
    const bytes = Math.ceil(remaining / Math.ceil(remaining / 60_000))
    params.text = 'a'.repeat(bytes - overhead)
    await w.dsh.ask(w.socket, method, params, { attachment: true })
    remaining -= bytes
  }
  assert.equal(w.dsh.attachmentWrites.get(w.socket).bytes, MiB - 512)
  assert.deepEqual(await p.begin('full', pdf, { name }), refused('busy'))
  assert.equal(w.socket.calls('upload-begin').length, 1)
  assert.equal((await p.begin('full')).state, 'open')
  assert.equal(w.socket.calls('upload-begin').length, 2)
  w.socket.drain()
  assert.equal(w.dsh.attachmentWrites.has(w.socket), false)
})

test('one paired-phone upload slot and chunk credit are shared by documents and images', async (t) => {
  const w = await setup(t, { host: { answer(m) {
    if (m.method === 'upload-finish' && m.params.upload === 'document') {
      return reply(fileAdmitted('document', txt, 'document.txt', chunkBytes + 1))
    }
  } } })
  const a = await w.phone()
  const b = await w.phone({ attachments: 1 })
  const c = await w.phone({ attachments: 1 }, 'other-phone')
  assert.equal((await a.begin('document', txt, { bytes: chunkBytes + 1 })).state, 'open')
  assert.deepEqual(await b.begin('blocked-image', png), refused('busy'))
  await admit(c, 'other-image')
  const first = { upload: 'document', offset: 0, data: Buffer.alloc(chunkBytes, 97).toString('base64') }
  assert.deepEqual(await a.call('chat.attachChunk', first), { ok: true, received: chunkBytes })
  assert.deepEqual(await a.call('chat.attachChunk', { ...first, offset: chunkBytes, data: 'YQ==' }), { ok: true, received: chunkBytes + 1 })
  assert.deepEqual(await a.finish('document'), fileAdmitted('document', txt, 'document.txt', chunkBytes + 1))
  await admit(b, 'blocked-image')
})

test('owned concurrent admitted cancels share one acknowledgement while foreign cancels stay local', async (t) => {
  const w = await setup(t, { host: { answer: (m) => m.method === 'upload-cancel' ? null : undefined } })
  const owner = await w.phone()
  const foreign = await w.phone()
  await admit(owner, 'owned')
  const a = owner.cancel('owned')
  const b = owner.cancel('owned')
  assert.deepEqual(await foreign.cancel('owned'), { ok: true })
  assert.equal(w.socket.calls('upload-cancel').length, 1)
  await w.time.advance(w.dsh.attachmentMs.cancel)
  assert.deepEqual(await Promise.all([a, b]), [unknown, unknown])
  const retry = owner.cancel('owned')
  await tick()
  assert.equal(w.socket.calls('upload-cancel').length, 2)
  w.socket.respond(w.socket.calls('upload-cancel').at(-1), reply({ ok: true }))
  assert.deepEqual(await retry, { ok: true })
  assert.deepEqual(await owner.cancel('owned'), { ok: true })
  assert.equal(w.socket.calls('upload-cancel').length, 2)
})

test('the paired-phone cap spans kinds and connections and does not evict a second phone’s admissions', async (t) => {
  const w = await setup(t, { host: { answer(m) {
    if (m.method === 'upload-finish' && m.params.upload.startsWith('document-')) {
      return reply(fileAdmitted(m.params.upload, pdf, 'document.pdf'))
    }
  } } })
  const a = await w.phone()
  const b = await w.phone()
  const other = await w.phone(optIn, 'unrelated-phone')
  await admit(other, 'document-other', pdf)
  await admit(b, 'document-old', pdf)
  for (let i = 0; i < 128; i++) await admit(a, `image-${i}`)
  assert.deepEqual(await b.cancel('document-old'), { ok: true })
  assert.equal(w.socket.calls('upload-cancel').length, 0)
  assert.deepEqual(await other.cancel('document-other'), { ok: true })
  assert.deepEqual(w.socket.calls('upload-cancel').map((m) => m.params), [
    { channel: 3, phone: 'unrelated-phone', upload: 'document-other' },
  ])
})

test('a refused or lost send preserves ownership and an ordered Retry on another watch clears it on success', async (t) => {
  let sends = 0
  const w = await setup(t, { host: { answer(m) {
    if (m.method === 'upload-finish' && m.params.upload === 'document') {
      return reply(fileAdmitted(m.params.upload, pdf, 'document.pdf'))
    }
    if (m.method === 'send') {
      if (++sends === 1) return null
      if (sends === 2) return reply(refused('invalid'))
      return reply({ ok: true, state: 'queued', id: m.params.id, repeat: true })
    }
  } } })
  const a = await w.phone()
  const b = await w.phone()
  const uploads = ['image', 'document']
  await admit(a, 'document', pdf)
  await admit(a, 'image')
  const first = a.send(uploads)
  await tick()
  await w.time.advance(w.dsh.requestMs)
  assert.deepEqual(await first, refused('offline', { id: 'message' }))
  const records = w.dsh.admitted.get(w.dsh.subs.get(1))
  assert.deepEqual([...records.keys()], ['document', 'image'])
  assert.deepEqual(await b.send(uploads), refused('invalid', { id: 'message' }))
  assert.deepEqual([...records.keys()], ['document', 'image'])
  assert.deepEqual(await b.send(uploads), { ok: true, state: 'queued', id: 'message', repeat: true })
  assert.deepEqual(w.socket.calls('send').map((m) => [m.params.channel, m.params.uploads]), [[1, uploads], [2, uploads], [2, uploads]])
  for (const upload of uploads) assert.deepEqual(await a.cancel(upload), { ok: true })
  assert.equal(records.size, 0)
  assert.equal(w.socket.calls('upload-cancel').length, 0)
})

test('only a validated send success clears admitted cancels on the same watch', async (t) => {
  let result
  const w = await setup(t, { host: { answer: (m) => m.method === 'send' ? reply(result) : undefined } })
  const p = await w.phone()
  const sub = w.dsh.subs.get(1)
  const upload = 'owned'
  await admit(p, upload)
  for (result of [
    { ok: true, state: 'sent', id: 'wrong' },
    { ok: true, state: 'refused', id: 'message' },
    { ok: true, state: 'queued', id: 'message', repeat: false },
  ]) {
    assert.deepEqual(await p.send([upload]), refused('failed', { id: 'message' }))
    assert.equal(w.dsh.admitted.get(sub).has(upload), true)
  }
  result = { ok: true, state: 'sent', id: 'message' }
  assert.deepEqual(await p.send([upload]), result)
  assert.deepEqual(await p.cancel(upload), { ok: true })
  assert.equal(w.socket.calls('upload-cancel').length, 0)
})

test('a send acknowledgement and an in-flight admitted cancel can settle in either order', async (t) => {
  for (const sendFirst of [true, false]) {
    const w = await setup(t, { host: { answer: (m) => ['send', 'upload-cancel'].includes(m.method) ? null : undefined } })
    const p = await w.phone()
    await admit(p, 'owned')
    const cancel = p.cancel('owned')
    const send = p.send(['owned'])
    await tick()
    const [cancelRequest] = w.socket.calls('upload-cancel')
    const [sendRequest] = w.socket.calls('send')
    const replies = [
      [cancelRequest, { ok: true }],
      [sendRequest, { ok: true, state: 'sent', id: 'message' }],
    ]
    if (sendFirst) replies.reverse()
    for (const [request, result] of replies) {
      w.socket.respond(request, reply(result))
      await tick()
    }
    assert.deepEqual(await cancel, { ok: true })
    assert.deepEqual(await send, { ok: true, state: 'sent', id: 'message' })
    assert.deepEqual(await p.cancel('owned'), { ok: true })
    assert.equal(w.socket.calls('upload-cancel').length, 1)
  }
})
