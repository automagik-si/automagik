import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { sha256 } from '../src/host/pocket-attach.js'
import { rowIdOf } from '../src/host/pocket-chat.js'
import { deferred, memoryWire, realAdmission } from './support/pocket-upload-admission.js'
import { binding, cancel, finish, hello, nameCases, pdf, phone, scratch, send, subscribe, tick, uploadDocument } from './support/pocket-document-admission.js'

const messages = session => session.snapshotEvents().filter(event => event.type === 'user/message')
const text = Buffer.from('\ufeffExact text with café and <svg>\n')
const fileNotStaged = error => error.details?.reason === 'FILE_NOT_STAGED'

async function harness(t) {
  const home = scratch(t)
  const h = await realAdmission(home)
  const admissions = []
  const uploadStream = h.uploads.uploadStream.bind(h.uploads)
  h.uploads.uploadStream = async request => {
    const admission = { request, settled: deferred() }
    admissions.push(admission)
    try {
      const result = await uploadStream(request)
      admission.result = result
      return result
    } finally { admission.settled.resolve() }
  }
  const connect = async (registry = h.registry(), options) => {
    const source = h.source()
    const c = memoryWire(source, registry)
    t.after(() => { c.stop(); source.close() })
    assert.ok((await hello(c)).attachments.documents)
    assert.deepEqual(await subscribe(c, options), { channel: 1 })
    return c
  }
  return { ...h, home, admissions, connect }
}

test('real DSH document-name vectors agree with stored aliases, finish, canonical replay and rich rows', { timeout: 20_000 }, async t => {
  const h = await harness(t)
  const a = h.agents.get('a')
  const registry = h.registry()
  const c = await h.connect(registry)
  const projected = []
  for (const [i, vector] of nameCases.entries()) {
    const data = vector.type === 'text/plain' ? text : pdf
    const params = { mediaType: vector.type, phone: `phone-${i}`, upload: `vector-${i}` }
    const named = vector.absent ? params : { ...params, name: vector.name }
    const before = h.admissions.length
    const result = await uploadDocument(c, data, named)
    if (vector.invalid) {
      assert.deepEqual(result, { ok: false, state: 'refused', reason: 'invalid', upload: params.upload }, vector.note)
      assert.equal(h.admissions.length, before, vector.note)
      continue
    }
    const { receiptId, file } = h.admissions.at(-1).result
    const alias = h.store.fileHostPath(file)
    assert.equal(file.name, vector.leaf, vector.note)
    assert.equal(basename(alias), vector.leaf, vector.note)
    assert.deepEqual(readFileSync(alias), data, vector.note)
    assert.deepEqual(result, { ok: true, state: 'admitted', upload: params.upload,
      file: { mediaType: vector.type, bytes: data.length, name: vector.leaf } }, vector.note)
    assert.deepEqual(h.uploads.resolve(a, receiptId), { type: 'file', attachment: file })
    const replay = { ...params, upload: `replay-${i}`, name: vector.leaf }
    assert.deepEqual(await uploadDocument(c, data, replay), { ...result, upload: replay.upload }, vector.note)
    assert.equal(h.admissions.at(-1).result.file.name, vector.leaf, vector.note)
    assert.equal((await cancel(c, { phone: params.phone, upload: replay.upload })).ok, true)
    assert.equal((await send(c, { phone: params.phone, id: params.upload, uploads: [params.upload] })).ok, true, vector.note)
    const message = messages(a.session).at(-1)
    assert.deepEqual(message.data.content, [{ type: 'file', attachment: file }], vector.note)
    projected.push({ id: rowIdOf(a.id, message.seq), blocks: [{ type: 'file', block: 0, name: vector.leaf, bytes: data.length }] })
  }
  const reader = await h.connect(registry, { documents: 0 })
  const rows = reader.events.find(({ event }) => event.type === 'snapshot').event.rows
  assert.deepEqual(rows.map(({ id, blocks }) => ({ id, blocks })), projected)
  assert.ok(!JSON.stringify(rows).includes('attachmentId'))
})

test('real DSH refuses incomplete final UTF-8 before either the digest object or named alias is published', { timeout: 20_000 }, async t => {
  const h = await harness(t)
  const c = await h.connect()
  const data = Buffer.from([0x61, 0xe2, 0x82])
  const name = 'incomplete.txt'
  assert.equal((await uploadDocument(c, data, { mediaType: 'text/plain', name }, false)).ok, true)
  const admission = h.admissions.at(-1)
  const expected = { ok: false, state: 'refused', reason: 'unsupported', upload: binding.upload }
  assert.deepEqual(await finish(c), expected)
  await admission.settled.promise
  assert.equal(admission.request.signal.aborted, true)
  assert.equal(admission.result, undefined)
  const digest = sha256(data)
  assert.equal(existsSync(join(h.store.root, 'file-objects', digest.slice(0, 2), digest)), false)
  assert.equal(existsSync(h.store.fileHostPath({ attachmentId: `sha256:${digest}`, name, bytes: data.length })), false)
  assert.deepEqual(await finish(c), expected)
})

test('real DSH may publish after EOF while cancellation preserves the charge and discards the late receipt', { timeout: 20_000 }, async t => {
  const h = await harness(t)
  const registry = h.registry()
  const c = await h.connect(registry)
  const published = deferred()
  const release = deferred()
  const save = h.store.saveFileStream.bind(h.store)
  h.store.saveFileStream = async input => {
    const file = await save(input)
    published.resolve(file)
    await release.promise
    return file
  }
  assert.equal((await uploadDocument(c, pdf, { name: 'Report.PDF' }, false)).ok, true)
  const admission = h.admissions.at(-1)
  const pending = finish(c)
  const expired = { ok: false, state: 'refused', reason: 'expired', upload: binding.upload }
  try {
    const result = await Promise.race([published.promise, pending])
    assert.equal(result.name, 'Report.pdf')
    assert.deepEqual(readFileSync(h.store.fileHostPath(result)), pdf)
    assert.equal((await cancel(c)).ok, true)
    assert.deepEqual(await pending, expired)
  } finally { release.resolve() }
  await admission.settled.promise
  await tick()
  assert.ok(admission.result.receiptId)
  assert.equal(registry.records.size, 0)
  assert.deepEqual(await finish(c), expired)
  assert.equal((await send(c)).reason, 'expired')
  assert.equal(h.prompts.length, 0)
  assert.ok(!c.lines.some(line => line.includes(admission.result.receiptId)))
  assert.equal(existsSync(join(h.home, 'pocket', 'document-manifests.json')), false)
  const charges = JSON.parse(readFileSync(join(h.home, 'pocket', 'uploads.json'), 'utf8')).phones[sha256(phone)].charges
  assert.deepEqual(charges.map(charge => charge.bytes), [pdf.length])
})

test('real DSH isolates staged documents by Session and recovers a lost send acknowledgement after receipt retirement', { timeout: 20_000 }, async t => {
  const h = await harness(t)
  const c = await h.connect()
  const a = h.agents.get('a')
  const b = h.agents.get('b')
  assert.equal((await uploadDocument(c, pdf)).ok, true)
  const { receiptId, file } = h.admissions.at(-1).result
  assert.equal(h.uploads.resolve(b, receiptId), undefined)
  await assert.rejects(h.commands.prompt({
    sessionId: b.id, requestId: 'other-session', mode: 'queue', content: [{ type: 'file', receiptId }],
  }, { kind: 'user', rpcId: 'other-session' }), fileNotStaged)
  assert.deepEqual(h.uploads.resolve(a, receiptId), { type: 'file', attachment: file })
  assert.equal(messages(b.session).length, 0)

  h.hooks.accepted = () => c.stop()
  assert.deepEqual(await send(c), { disconnected: true })
  delete h.hooks.accepted
  assert.equal(h.uploads.resolve(a, receiptId), undefined)
  const ledger = join(h.home, 'pocket', 'document-manifests.json')
  const saved = readFileSync(ledger, 'utf8')
  const next = await h.connect()
  assert.deepEqual(await send(next), { ok: true, state: 'sent', id: 'message', repeat: true })
  assert.deepEqual(h.prompts[0], h.prompts[1])
  assert.equal(messages(a.session).length, 1)
  assert.equal(readFileSync(ledger, 'utf8'), saved)
})

test('real DSH FILE_NOT_STAGED is fixed on both resolution and bind before insertion', { timeout: 20_000 }, async t => {
  const h = await harness(t)
  const a = h.agents.get('a')
  const c = await h.connect()
  const expected = id => ({ ok: false, state: 'refused', reason: 'expired', id, code: 'FILE_NOT_STAGED' })
  assert.equal((await uploadDocument(c, pdf)).ok, true)
  assert.equal(h.uploads.stagedFiles.get(a.session).delete(h.admissions.at(-1).result.receiptId), true)
  assert.deepEqual(await send(c), expected('message'))

  assert.equal((await uploadDocument(c, text, { upload: 'bind', mediaType: 'text/plain' })).ok, true)
  const { receiptId } = h.admissions.at(-1).result
  const bind = h.uploads.bindPrompt.bind(h.uploads)
  h.uploads.bindPrompt = (agent, ids, id) => {
    assert.deepEqual(ids, [receiptId])
    assert.equal(h.uploads.stagedFiles.get(agent.session).delete(receiptId), true)
    return bind(agent, ids, id)
  }
  assert.deepEqual(await send(c, { id: 'bind', uploads: ['bind'] }), expected('bind'))
  assert.equal(messages(a.session).length, 0)
  assert.equal(h.prompts.length, 2)
})
