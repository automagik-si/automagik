import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { install as delivery } from '../src/host/delivery.js'
import { ADMISSION_MS, CHUNK_BYTES, DAY_MS, IDLE_MS, UNSENT_MS, sha256 } from '../src/host/pocket-attach.js'
import { rowsOf } from '../src/host/pocket-chat.js'
import { deferred, uploadWire } from './support/pocket-upload-admission.js'
import {
  begin, binding, cancel, chunk, event, fakeHost, finish, hello, pdf, phone, png, send, subscribe, tick, uploadDocument,
} from './support/pocket-document-admission.js'

const read = path => JSON.parse(readFileSync(path, 'utf8'))
const phoneHash = sha256(phone)
const refusal = (reason, extra) => ({ ok: false, state: 'refused', reason, ...extra })
const denied = async (reply, reason) => assert.equal((await reply).reason, reason)
const failure = reason => Object.assign(new Error('private storage detail'), { details: { reason } })
const imageBegin = (c, extra) => begin(c, png.length, { mediaType: 'image/png', ...extra })

async function connect(h, host) {
  const c = h.client(host)
  const offer = await hello(c)
  assert.deepEqual(offer.attachments.documents, { mediaTypes: ['text/plain', 'application/pdf'], limits: { fileBytes: 8 * 1024 ** 2 } })
  assert.deepEqual(offer.attachments.mediaTypes, ['image/png'])
  assert.deepEqual(await subscribe(c), { channel: 1 })
  return c
}

test('document negotiation requires the image offer and uploadStream; a matching management hello only revokes management grants', async t => {
  const h = fakeHost(t)
  const c = h.client()
  const uploadStream = h.uploads.uploadStream
  delete h.uploads.uploadStream
  assert.equal((await hello(c)).attachments.documents, undefined)
  h.uploads.uploadStream = uploadStream
  assert.equal((await hello(c, { attachments: 0 })).attachments, undefined)
  assert.equal((await hello(c, { write: 0 })).attachments, undefined)
  await hello(c)
  await subscribe(c, { attachments: 0 })
  await denied(begin(c, pdf.length), 'not-watching')
  await denied(send(c), 'invalid')
  await subscribe(c, { channel: 2, documents: 0 })
  await denied(begin(c, pdf.length, { channel: 2 }), 'unsupported')
  await subscribe(c, { channel: 3 })
  assert.equal((await hello(c, { manage: 1 })).manage, 1)
  const grant = 'example-grant'
  assert.deepEqual(await c.request('manage-open', { phone, grant }), { grant })
  assert.equal((await begin(c, pdf.length, { channel: 3 })).state, 'open')
  assert.equal((await hello(c, { manage: 1 })).manage, 1)
  assert.equal((await c.request('memory-read', { grant, terminal: 'dsh:a' })).reason, 'revoked')
  assert.equal((await chunk(c, pdf, { channel: 3 })).received, pdf.length)
  assert.equal((await finish(c, { channel: 3 })).state, 'admitted')
  await hello(c, { documents: 0 })
  await denied(imageBegin(c, { channel: 3 }), 'not-watching')
})

test('a documents-only hello switch closes a late rejected subscribe once and keeps the reused channel live', async t => {
  const h = fakeHost(t)
  const c = h.client()
  const ready = deferred()
  const watch = h.source.watch.bind(h.source)
  h.source.watch = async (terminal, ...args) => {
    if (terminal === 'dsh:b') { await ready.promise; throw new Error('private subscribe failure') }
    return watch(terminal, ...args)
  }
  await hello(c)
  const pending = subscribe(c, { terminal: 'dsh:b' }, 'old')
  const switched = await hello(c, { documents: 0 })
  assert.equal(switched.attachments.documents, undefined)
  assert.deepEqual(await subscribe(c), { channel: 1 })
  ready.resolve()
  const closed = { kind: 'closed', message: 'closed' }
  assert.deepEqual(await pending, closed)
  assert.deepEqual(c.lines.map(line => JSON.parse(line)).filter(reply => reply.id === 'old'), [{ id: 'old', error: closed }])
  assert.equal((await uploadWire(c, png)).state, 'admitted')
  assert.deepEqual(h.logs, [])
})

test('a mixed send records ordered kinds separately from the shared charge ledger and retries without refreshing at', async t => {
  const h = fakeHost(t)
  const c = await connect(h)
  assert.equal((await uploadDocument(c, pdf)).state, 'admitted')
  assert.equal((await uploadWire(c, png, { upload: 'picture' })).state, 'admitted')
  const mixed = { uploads: ['picture', binding.upload], text: 'Review these.' }
  assert.deepEqual(await send(c, mixed), { ok: true, state: 'sent', id: 'message' })
  assert.deepEqual(h.calls.prompts[0].content, [
    { type: 'text', text: mixed.text }, { type: 'file', receiptId: 'image-receipt-1' }, { type: 'file', receiptId: 'file-receipt-1' },
  ])
  assert.equal((await uploadDocument(c, pdf, { upload: 'second' })).state, 'admitted')
  assert.equal((await send(c, { id: 'document-only', uploads: ['second'] })).ok, true)
  const ledger = read(h.ledgerPath).phones[phoneHash]
  assert.deepEqual(ledger.charges, [pdf, png, pdf].map(data => ({ at: 1, bytes: data.length })))
  assert.deepEqual(ledger.manifests, [])
  const manifests = read(h.documentsPath).phones[phoneHash]
  assert.equal(statSync(h.documentsPath).mode & 0o777, 0o600)
  assert.deepEqual(manifests, [
    { phoneHash, id: 'message', sessionId: 'a', requestId: h.calls.prompts[0].requestId, textHash: sha256(mixed.text),
      uploadIds: mixed.uploads, receiptIds: ['image-receipt-1', 'file-receipt-1'], at: 1, kinds: ['image', 'document'] },
    { phoneHash, id: 'document-only', sessionId: 'a', requestId: h.calls.prompts[1].requestId, textHash: sha256(''),
      uploadIds: ['second'], receiptIds: ['file-receipt-2'], at: 1, kinds: ['document'] },
  ])
  h.clock.advance(10)
  c.stop()
  const restarted = h.registry()
  const next = await connect(h, restarted)
  await denied(imageBegin(next), 'invalid')
  assert.deepEqual(read(h.ledgerPath).phones[phoneHash], ledger)
  assert.equal(h.calls.images.length, 1)
  assert.deepEqual(await send(next, mixed), { ok: true, state: 'sent', id: 'message', repeat: true })
  assert.deepEqual(h.calls.prompts[0], h.calls.prompts[2])
  assert.deepEqual(read(h.documentsPath).phones[phoneHash], manifests)
  h.clock.advance(DAY_MS - 10)
  assert.equal((await imageBegin(next)).state, 'open')
})

test('a document begin cannot reuse an image manifest upload id, and evicted document ids are available', async t => {
  const h = fakeHost(t)
  const c = await connect(h)
  assert.equal((await uploadWire(c, png, { upload: 'picture' })).state, 'admitted')
  assert.equal((await send(c, { id: 'image', uploads: ['picture'] })).ok, true)
  assert.equal((await uploadDocument(c, pdf)).state, 'admitted')
  assert.equal((await send(c)).ok, true)
  const [old] = read(h.documentsPath).phones[phoneHash]
  const active = Array.from({ length: 63 }, (_, i) => ({ ...old, id: `message-${i}`, uploadIds: [`upload-${i}`] }))
  writeFileSync(h.documentsPath, JSON.stringify({ phones: { [phoneHash]: [old, ...active] } }))
  const next = await connect(h, h.registry())
  await denied(begin(next, pdf.length, { upload: 'picture' }), 'invalid')
  await denied(imageBegin(next), 'invalid')
  assert.equal((await uploadDocument(next, pdf, { upload: 'latest' })).state, 'admitted')
  assert.equal((await send(next, { id: 'latest', uploads: ['latest'] })).ok, true)
  assert.deepEqual(read(h.documentsPath).phones[phoneHash].map(manifest => manifest.id), [...active.map(manifest => manifest.id), 'latest'])
  assert.equal((await imageBegin(next)).state, 'open')
})

for (const broken of ['document manifests', 'charge ledger', 'quarantine file alone']) {
  test(`${broken} refuse all attachment sends and begins before lookup while text still sends`, async t => {
    const h = fakeHost(t)
    const c = await connect(h)
    const image = broken !== 'charge ledger'
    assert.equal((await (image ? uploadWire(c, png) : uploadDocument(c, pdf))).state, 'admitted')
    assert.equal((await send(c)).ok, true)
    c.stop()
    h.calls.prompts.length = 0
    const path = image ? h.documentsPath : h.ledgerPath
    writeFileSync(broken === 'quarantine file alone' ? `${path}.bad` : path, 'malformed store')
    const other = image ? h.ledgerPath : h.documentsPath
    const saved = readFileSync(other, 'utf8')
    const retry = await connect(h, h.registry())
    await denied(send(retry), 'quota')
    const next = await connect(h, h.registry())
    await denied(imageBegin(next), 'quota')
    assert.equal(h.calls.prompts.length, 0)
    assert.equal(h.calls.images.length + h.calls.files.length, 1)
    assert.equal(readFileSync(other, 'utf8'), saved)
    assert.equal(readFileSync(`${path}.bad`, 'utf8'), 'malformed store')
    assert.equal(read(path).brokenAt, 1)
    assert.equal((await next.request('send', { channel: 1, phone, id: 'text-only', text: 'still works' })).ok, true)
    h.clock.advance(DAY_MS)
    assert.equal((await imageBegin(next)).state, 'open')
  })
}

test('a match in both stores refuses the send after rollback and upgrade', async t => {
  const h = fakeHost(t)
  const c = await connect(h)
  assert.equal((await uploadDocument(c, pdf)).state, 'admitted')
  assert.equal((await send(c)).ok, true)
  assert.equal((await uploadWire(c, png, { upload: 'picture' })).state, 'admitted')
  assert.equal((await send(c, { id: 'picture', uploads: ['picture'] })).ok, true)
  c.stop()
  const data = read(h.ledgerPath)
  data.phones[phoneHash].manifests[0].id = 'message'
  writeFileSync(h.ledgerPath, JSON.stringify(data))
  const next = await connect(h, h.registry())
  await denied(send(next), 'invalid')
  await denied(send(next, { uploads: ['picture'] }), 'invalid')
  assert.equal(h.calls.prompts.length, 2)
})

test('fresh send validates competing failures in protocol order', async t => {
  const h = fakeHost(t)
  const c = await connect(h)
  await subscribe(c, { channel: 2, documents: 0 })
  await subscribe(c, { channel: 3, terminal: 'dsh:b' })
  const limits = h.store.imageLimits
  const pair = { uploads: ['missing', binding.upload], channel: 2 }
  limits.maxImagesPerMessage = 1
  await denied(send(c, pair), 'too-large')
  limits.maxImagesPerMessage = 4
  await denied(send(c, pair), 'expired')
  assert.equal((await begin(c, pdf.length)).ok, true)
  await denied(send(c, { channel: 2 }), 'expired')
  assert.equal((await chunk(c, pdf)).ok, true)
  assert.equal((await finish(c)).ok, true)
  await denied(send(c, { channel: 2 }), 'unsupported')
  await denied(send(c, { channel: 3 }), 'invalid')
  await denied(send(c, pair), 'expired')
  await denied(send(c, { ...pair, uploads: [...pair.uploads].reverse() }), 'unsupported')

  const document = h.host.find(phoneHash, binding.upload)
  document.sessionId = 'b'
  const uploadStream = h.uploads.uploadStream
  delete h.uploads.uploadStream
  await denied(send(c, { channel: 3 }), 'invalid')
  await denied(send(c), 'session-changed')
  document.sessionId = 'a'
  limits.maxMessageImageBytes = pdf.length - 1
  await denied(send(c), 'unsupported')
  h.uploads.uploadStream = uploadStream
  assert.equal((await uploadWire(c, png, { upload: 'picture' })).reason, 'too-large')
  await denied(send(c), 'too-large')
  limits.maxMessageImageBytes = 16 * 1024 ** 2
  assert.equal((await uploadWire(c, png, { upload: 'picture' })).state, 'admitted')
  limits.maxImageDimension = 31
  await denied(send(c, { uploads: ['picture', 'missing'] }), 'too-large')
  limits.maxMessageImageBytes = png.length + pdf.length - 1
  await denied(send(c, { uploads: ['picture', binding.upload] }), 'too-large')
  limits.maxImageDimension = 32
  await denied(send(c, { uploads: ['picture', binding.upload] }), 'too-large')
  h.clock.advance(UNSENT_MS)
  await denied(send(c, { channel: 2 }), 'expired')
  assert.equal(h.calls.prompts.length, 0)
})

test('fresh send repeats the ordered checks after the awaited state and authority reads', async t => {
  const h = fakeHost(t)
  const c = await connect(h)
  const limits = h.store.imageLimits
  assert.equal((await uploadDocument(c, pdf)).state, 'admitted')
  assert.equal((await uploadWire(c, png, { upload: 'picture' })).state, 'admitted')
  const ids = { uploads: ['picture', binding.upload] }
  const document = h.host.find(phoneHash, binding.upload)
  const picture = h.host.find(phoneHash, 'picture')
  const check = async (mutate, restore, reason, extra) => {
    h.faults.state = mutate
    await denied(send(c, extra), reason)
    delete h.faults.state
    restore()
  }
  await check(() => { limits.maxImagesPerMessage = 1; picture.expiresAt = 0 },
    () => { limits.maxImagesPerMessage = 4; picture.expiresAt = 1 + UNSENT_MS }, 'too-large', ids)
  const uploadStream = h.uploads.uploadStream
  await check(() => { delete h.uploads.uploadStream; document.expiresAt = 0 },
    () => { h.uploads.uploadStream = uploadStream; document.expiresAt = 1 + UNSENT_MS }, 'expired')
  await check(() => { delete h.uploads.uploadStream; document.sessionId = 'b' },
    () => { h.uploads.uploadStream = uploadStream; document.sessionId = 'a' }, 'session-changed')
  await check(() => { limits.maxMessageImageBytes = pdf.length - 1; delete h.uploads.uploadStream },
    () => { limits.maxMessageImageBytes = 16 * 1024 ** 2; h.uploads.uploadStream = uploadStream }, 'unsupported')
  await check(() => { limits.maxMessageImageBytes = pdf.length - 1 },
    () => { limits.maxMessageImageBytes = 16 * 1024 ** 2 }, 'too-large')
  assert.equal(h.calls.prompts.length, 0)
  assert.equal((await send(c, ids)).ok, true)
})

test('document Retry checks Session, changes and grant or withdrawal before prompting', async t => {
  const h = fakeHost(t)
  const c = await connect(h)
  assert.equal((await uploadDocument(c, pdf)).state, 'admitted')
  assert.equal((await send(c)).ok, true)
  await subscribe(c, { channel: 2, terminal: 'dsh:b', documents: 0 })
  await subscribe(c, { channel: 3, documents: 0 })
  await denied(send(c, { channel: 2, text: 'changed' }), 'session-changed')
  await denied(send(c, { channel: 3, text: 'changed' }), 'changed')
  await denied(send(c, { channel: 3, uploads: ['different'] }), 'changed')
  await denied(send(c, { channel: 3 }), 'unsupported')
  const uploadStream = h.uploads.uploadStream
  delete h.uploads.uploadStream
  await denied(send(c), 'unsupported')
  h.uploads.uploadStream = uploadStream
  h.faults.state = () => { h.host.filesUnsupported = true }
  await denied(send(c), 'unsupported')
  assert.equal(h.calls.prompts.length, 1)
})

test('a failed document-manifest replacement refuses before prompt and can be retried', async t => {
  const h = fakeHost(t)
  const c = await connect(h)
  assert.equal((await uploadDocument(c, pdf)).state, 'admitted')
  const save = h.host.documents.save
  h.host.documents.save = () => { throw new Error('private disk detail') }
  await denied(send(c), 'unavailable')
  assert.equal(h.calls.prompts.length, 0)
  assert.equal(existsSync(h.documentsPath), false)
  assert.deepEqual(h.logs, [['pocket upload: refused']])
  h.host.documents.save = save
  assert.equal((await send(c)).ok, true)
})

test('saved document refusals stay scoped and only a store refusal withdraws the host offer', async t => {
  const h = fakeHost(t)
  const a = await connect(h)
  const b = await connect(h)
  await subscribe(a, { channel: 2 })
  const result = (reason, code) => refusal(reason, { upload: binding.upload, ...(code === undefined ? {} : { code }) })
  const rejectsAfterEOF = code => async ({ data }) => {
    for await (const part of data) assert.ok(part.length)
    throw failure(code)
  }
  for (const [code, reason, returned] of [
    ['unknown-store-code', 'unavailable', undefined],
    ['timeout', 'rejected', 'timeout'],
    ['SUBAGENT_FILE_UNSUPPORTED', 'unsupported', 'SUBAGENT_FILE_UNSUPPORTED'],
  ]) {
    h.faults.file = rejectsAfterEOF(code)
    assert.deepEqual(await uploadDocument(a, pdf), result(reason, returned))
    assert.deepEqual(await chunk(a, pdf), result(reason, returned))
    assert.deepEqual(await finish(a), result(reason, returned))
    assert.ok((await hello(a)).attachments.documents)
  }

  h.faults.file = rejectsAfterEOF('SUBAGENT_FILE_UNSUPPORTED')
  assert.equal((await uploadDocument(b, pdf, {}, false)).ok, true)
  assert.deepEqual(await chunk(a, pdf), result('unsupported', 'SUBAGENT_FILE_UNSUPPORTED'))
  assert.deepEqual(await finish(a), result('unsupported', 'SUBAGENT_FILE_UNSUPPORTED'))
  assert.deepEqual(await finish(b), result('unsupported', 'SUBAGENT_FILE_UNSUPPORTED'))

  const work = deferred()
  h.faults.file = () => work.promise
  assert.equal((await begin(a, pdf.length, { channel: 2 })).ok, true)
  const waiting = chunk(a, pdf, { channel: 2 })
  work.resolve(Promise.reject(failure('ATTACHMENT_FILES_UNSUPPORTED')))
  const withdrawn = result('unsupported', 'ATTACHMENT_FILES_UNSUPPORTED')
  assert.deepEqual(await waiting, withdrawn)
  assert.deepEqual(await chunk(a, pdf, { channel: 2 }), withdrawn)
  assert.deepEqual(await finish(a, { channel: 2 }), withdrawn)
  assert.deepEqual(await chunk(a, pdf, { channel: 2, phone: 'other-phone' }), result('invalid'))
  assert.deepEqual(await finish(b), result('unsupported', 'SUBAGENT_FILE_UNSUPPORTED'))
  const charges = read(h.ledgerPath)
  assert.deepEqual(await begin(b, 0), withdrawn)
  assert.deepEqual(read(h.ledgerPath), charges)
  assert.equal((await hello(b)).attachments.documents, undefined)
  await subscribe(b)
  assert.deepEqual(await begin(b, pdf.length), withdrawn)
  assert.equal((await uploadWire(b, png)).state, 'admitted')
  await denied(begin(b, pdf.length), 'invalid')
  assert.equal((await send(b)).ok, true)
  await denied(begin(b, pdf.length), 'invalid')
  assert.ok(h.logs.every(args => args.length === 1 && args[0] === 'pocket upload: admission failed'))
})

for (const ending of ['cancel', 'timeout']) {
  test(`a ${ending} keeps the cross-kind admission slot and a late DSH refusal still withdraws files`, async t => {
    const h = fakeHost(t)
    const a = await connect(h)
    const b = await connect(h)
    const work = deferred()
    h.faults.file = () => work.promise
    assert.equal((await begin(a, pdf.length)).ok, true)
    const ack = chunk(a, pdf)
    if (ending === 'cancel') assert.equal((await cancel(a)).ok, true)
    else h.clock.advance(IDLE_MS)
    const expected = ending === 'cancel' ? refusal('expired', { upload: binding.upload })
      : refusal('rejected', { upload: binding.upload, code: 'timeout' })
    assert.deepEqual(await ack, expected)
    assert.equal(h.calls.files[0].signal.aborted, true)
    await denied(imageBegin(b, { phone: 'other-phone' }), 'busy')
    work.resolve(Promise.reject(failure('ATTACHMENT_FILES_UNSUPPORTED')))
    await tick()
    assert.deepEqual(await finish(a), expected)
    assert.deepEqual(await begin(b, pdf.length), refusal('unsupported', { upload: binding.upload, code: 'ATTACHMENT_FILES_UNSUPPORTED' }))
    assert.equal((await hello(b)).attachments.documents, undefined)
    await subscribe(b)
    assert.equal((await uploadWire(b, png)).state, 'admitted')
  })
}

test('one TXT decoder spans chunk boundaries and credit waits for a second reader pull', async t => {
  const h = fakeHost(t)
  const c = await connect(h)
  const first = Buffer.concat([Buffer.from('\ufeff'), Buffer.alloc(CHUNK_BYTES - 4, 0x61), Buffer.from([0xe2])])
  const last = Buffer.from([0x82, 0xac])
  const work = deferred()
  h.faults.file = () => work.promise
  const data = Buffer.concat([first, last])
  assert.equal((await begin(c, data.length, { mediaType: 'text/plain' })).ok, true)
  const [request] = h.calls.files
  let acknowledged = false
  const firstAck = chunk(c, first).then(reply => { acknowledged = true; return reply })
  assert.deepEqual((await request.data.next()).value, first)
  assert.equal(acknowledged, false)
  await denied(finish(c), 'invalid')
  const next = request.data.next()
  assert.equal((await firstAck).received, CHUNK_BYTES)
  await denied(finish(c), 'invalid')
  const lastAck = chunk(c, last, { offset: CHUNK_BYTES })
  assert.deepEqual((await next).value, last)
  await denied(finish(c), 'invalid')
  const eof = request.data.next()
  assert.equal((await lastAck).received, data.length)
  const done = finish(c)
  const joined = finish(c)
  assert.deepEqual(await eof, { done: true })
  work.resolve({ receiptId: 'private receipt', file: { attachmentId: `sha256:${sha256(data)}`, bytes: data.length, name: 'document.txt' } })
  const admitted = { ok: true, state: 'admitted', upload: binding.upload, file: { mediaType: 'text/plain', bytes: data.length, name: 'document.txt' } }
  assert.deepEqual(await done, admitted)
  assert.deepEqual(await joined, admitted)
})

test('an incomplete final TXT sequence aborts the DSH reader without yielding EOF', async t => {
  const h = fakeHost(t)
  const c = await connect(h)
  const observed = deferred()
  h.faults.file = async ({ data }) => {
    assert.deepEqual((await data.next()).value, Buffer.from([0x61, 0xe2, 0x82]))
    try {
      await data.next()
      observed.resolve('eof')
    } catch {
      observed.resolve('aborted')
    }
    throw new Error('private DSH stream failure')
  }
  assert.equal((await uploadDocument(c, Buffer.from([0x61, 0xe2, 0x82]), { mediaType: 'text/plain' }, false)).ok, true)
  assert.deepEqual(await finish(c), refusal('unsupported', { upload: binding.upload }))
  assert.equal(await observed.promise, 'aborted')
  assert.equal(h.calls.files[0].signal.aborted, true)
  assert.deepEqual(await finish(c), refusal('unsupported', { upload: binding.upload }))
})

test('document validation rejects invalid credit, bytes, types, PDF magic and UTF-8 with fixed results', async t => {
  const h = fakeHost(t)
  const c = await connect(h)
  for (const bytes of [0, 0.5, 8 * 1024 ** 2 + 1]) await denied(begin(c, bytes), 'too-large')
  for (const mediaType of ['text/html', 'image/svg+xml']) await denied(begin(c, pdf.length, { mediaType }), 'unsupported')
  for (const [mediaType, data] of [
    ['text/plain', Buffer.from([0x61, 0x00])], ['text/plain', Buffer.from([0xc0, 0xaf])],
    ['application/pdf', Buffer.from('%PDF')], ['application/pdf', Buffer.from(' %PDF-')],
    ['application/pdf', Buffer.from([0xa5, 0x50, 0x44, 0x46, 0x2d])],
  ]) {
    assert.equal((await begin(c, data.length, { mediaType })).ok, true)
    await denied(chunk(c, data), 'unsupported')
    await denied(finish(c), 'unsupported')
    await tick()
  }
  for (const [bytes, extra] of [[1, { offset: 1 }], [CHUNK_BYTES + 1, {}]]) {
    assert.equal((await begin(c, bytes, { mediaType: 'text/plain' })).ok, true)
    await denied(chunk(c, Buffer.from([0xff]), extra), 'invalid')
    await tick()
  }
  assert.equal((await uploadDocument(c, Buffer.from('<svg>Hello</svg>'), { mediaType: 'text/plain' })).ok, true)
})

test('document finish validates receipts and stored file references and exposes only wire metadata', async t => {
  const h = fakeHost(t)
  const c = await connect(h)
  for (const [receiptId, extra] of [
    ['', {}], ['bad\0receipt', {}], [null, {}], ['private receipt', { bytes: pdf.length + 1 }],
    ['private receipt', { name: 'different.pdf' }], ['private receipt', { attachmentId: `sha256:${'A'.repeat(64)}` }],
    ['private receipt', { attachmentId: 'opaque' }],
  ]) {
    h.faults.file = async ({ data, name }) => {
      for await (const part of data) assert.ok(part.length)
      return { receiptId, file: { name, bytes: pdf.length, attachmentId: `sha256:${sha256(pdf)}`, ...extra } }
    }
    assert.deepEqual(await uploadDocument(c, pdf), refusal('rejected', { upload: binding.upload }))
  }
  delete h.faults.file
  assert.deepEqual(await uploadDocument(c, pdf), {
    ok: true, state: 'admitted', upload: binding.upload, file: { mediaType: 'application/pdf', bytes: pdf.length, name: 'document.pdf' },
  })
})

test('document admission timeout runs from EOF while a retry gets the saved refusal', async t => {
  const h = fakeHost(t)
  const c = await connect(h)
  const eof = deferred()
  const work = deferred()
  h.faults.file = async ({ data }) => {
    for await (const part of data) assert.ok(part.length)
    eof.resolve()
    return work.promise
  }
  assert.equal((await uploadDocument(c, pdf, {}, false)).ok, true)
  const pending = finish(c)
  await eof.promise
  h.clock.advance(ADMISSION_MS)
  const timedOut = refusal('rejected', { upload: binding.upload, code: 'timeout' })
  assert.deepEqual(await pending, timedOut)
  assert.deepEqual(await finish(c), timedOut)
  work.resolve()
})

test('sign-in checks see only the reduced leaf and file diagnostics omit both name and error', async t => {
  const seen = []
  const h = fakeHost(t, { carriesSignInCode: value => { seen.push(value); return value.includes('sign-in-marker') } })
  const c = await connect(h)
  assert.deepEqual(await begin(c, 1, { name: 'discard-me/si\u200bgn-in-marker.PDF' }),
    refusal('invalid', { upload: binding.upload, message: 'sign-in-code' }))
  assert.deepEqual(seen, ['sign-in-marker.pdf'])
  assert.equal(existsSync(h.ledgerPath), false)
  assert.equal(h.calls.files.length, 0)
  const data = Buffer.from('sign-in-marker in the body')
  assert.equal((await uploadDocument(c, data, { mediaType: 'text/plain', name: 'sign-in-marker-directory/Report.TXT' })).ok, true)
  assert.deepEqual(h.calls.bytes, [data])
  assert.deepEqual(seen, ['sign-in-marker.pdf', 'Report.txt'])
  assert.deepEqual(h.logs, [['pocket upload: a name carried a sign-in code and was refused']])

  const warnings = []
  const rt = { ctx: { on() {}, get: () => ({ async* readFileStream() {
    yield Buffer.from('private-content-sentinel')
    throw new Error('private-error-sentinel')
  } }) },
    ledger: { importer() {} }, warn: (...args) => warnings.push(args) }
  delivery(rt)
  assert.equal(await rt.fileText({ name: 'private-name-sentinel.txt' }), undefined)
  assert.deepEqual(warnings, [['omni-ui: a file was not read']])
})

test('desktop file rows drop format controls and images-only rich watches see file metadata without file reads', async t => {
  const h = fakeHost(t)
  const parts = [{ type: 'file', attachment: { attachmentId: 'private-id', name: 'C:\\path\\re\u202epo\u200brt.txt', bytes: 7 } }]
  const raw = event(1, parts)
  h.sessions.a.push(raw)
  const blocks = [{ type: 'file', block: 0, bytes: 7, name: 'report.txt' }]
  assert.deepEqual(rowsOf(raw, { sessionId: 'a', turn: 0, calls: new Map() })[0].blocks, blocks)
  const c = h.client()
  await hello(c, { documents: 0 })
  await subscribe(c)
  assert.deepEqual(c.events[0].event.rows[0].blocks, blocks)
  const readParams = { phone, channel: 1, row: 'dsh:a:1', block: 0 }
  assert.deepEqual(await c.request('attachment-read', readParams), refusal('not-found'))
  assert.deepEqual(await c.request('attachment-read', { ...readParams, name: null }), refusal('invalid'))
  await denied(imageBegin(c, { name: null }), 'invalid')
  await denied(chunk(c, pdf, { name: null }), 'invalid')
  await denied(finish(c, { name: null }), 'invalid')
  await denied(cancel(c, { name: null }), 'invalid')
  await denied(send(c, { name: null }), 'invalid')
  await subscribe(c, { channel: 2, attachments: 0 })
  assert.deepEqual(c.events.find(({ channel }) => channel === 2).event.rows, [])
})
