import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { sha256 } from '../src/host/pocket-attach.js'
import { rowIdOf } from '../src/host/pocket-chat.js'
import { startPocketSocket } from '../src/host/pocket-socket.js'
import { connectWire, deferred, fixturePng, memoryWire, realAdmission, uploadWire, watchWire } from './support/pocket-upload-admission.js'

const phone = 'phone-a'
const upload = 'upload'
const binding = { channel: 1, phone, upload }
const png = fixturePng()
const tick = () => new Promise(resolve => setImmediate(resolve))

async function harness(t) {
  const home = mkdtempSync(join(tmpdir(), 'pocket-image-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return { home, ...await realAdmission(home) }
}

function messages(session) {
  return session.snapshotEvents().filter(event => event.type === 'user/message')
}

async function authenticate(c) {
  assert.deepEqual(await watchWire(c), { channel: 1 })
}

async function imageRoundTrip(h, c, reopen) {
  await authenticate(c)
  const admitted = await uploadWire(c, png)
  const [receiptId] = h.receiptIds
  const a = h.agents.get('a')
  const b = h.agents.get('b')
  const staged = h.uploads.resolve(a, receiptId)
  assert.equal(staged?.type, 'image')
  assert.equal(staged.encodedBytes, png.length)
  const ref = staged.attachment
  assert.deepEqual(admitted, { ok: true, state: 'admitted', upload,
    image: { mediaType: ref.mediaType, width: 32, height: 24, bytes: png.length, stored: ref.bytes } })
  assert.ok(['image/png', 'image/jpeg', 'image/webp'].includes(ref.mediaType))
  assert.equal(ref.name, undefined)
  assert.equal(h.uploads.resolve(b, receiptId), undefined)
  await assert.rejects(h.commands.prompt({
    sessionId: b.id, requestId: 'foreign-session', mode: 'queue', content: [{ type: 'file', receiptId }],
  }, { kind: 'user', rpcId: 'foreign-session' }), error => error.details?.reason === 'FILE_NOT_STAGED')
  assert.equal(messages(b.session).length, 0)
  assert.equal((await c.request('send', { channel: 1, phone: 'other-device', id: 'm', uploads: [upload] })).reason, 'expired')
  assert.equal(h.prompts.length, 0)
  assert.equal(h.uploads.resolve(a, receiptId), staged)

  const packet = { channel: 1, phone, id: 'm', uploads: [upload] }
  h.hooks.accepted = () => c.stop()
  assert.deepEqual(await c.request('send', packet), { disconnected: true })
  delete h.hooks.accepted
  assert.equal(h.uploads.resolve(a, receiptId), undefined)
  const [event] = messages(a.session)
  assert.deepEqual(event.data.content, [{ type: 'image', attachment: ref }])
  const next = await reopen()
  await authenticate(next)
  assert.deepEqual(await next.request('send', packet), { ok: true, state: 'sent', id: 'm', repeat: true })
  assert.equal(messages(a.session).length, 1)
  assert.deepEqual(h.prompts[0], h.prompts[1])
  assert.equal(h.prompts[0].requestId, event.data.source.rpcId)
  const row = rowIdOf(a.id, event.seq)
  assert.deepEqual(next.events.find(({ event }) => event.type === 'snapshot').event.rows[0].blocks,
    [{ type: 'image', block: 0, mediaType: ref.mediaType, width: 32, height: 24 }])
  const thumb = await next.request('attachment-read', { channel: 1, phone, row, block: 0 })
  assert.equal(thumb.ok, true)
  assert.ok(thumb.width <= 512 && thumb.height <= 512 && Buffer.from(thumb.data, 'base64').length <= 131072)
  assert.ok(!JSON.stringify(next.events).includes('attachmentId'))
}

test('real DSH through Unix socket: Session and phone ownership, receipt retirement, image-only send, reconnect and thumbnail', { timeout: 20_000 }, async t => {
  const h = await harness(t)
  const source = h.source()
  const host = await startPocketSocket({ home: h.home, source })
  t.after(async () => { source.close(); await host.close() })
  const connect = async () => {
    const client = await connectWire(host.path)
    t.after(client.stop)
    return client
  }
  await imageRoundTrip(h, await connect(), connect)
})

test('real DSH through socket protocol: a durable manifest retries a committed image after a dropped reply and host restart', { timeout: 20_000 }, async t => {
  const h = await harness(t)
  const connect = () => {
    const source = h.source()
    const client = memoryWire(source, h.registry())
    t.after(() => { client.stop(); source.close() })
    return client
  }
  await imageRoundTrip(h, connect(), connect)
})

test('real DSH cancels before storage and while publishing an image without staging a receipt', { timeout: 20_000 }, async t => {
  const h = await harness(t)
  const source = h.source()
  const registry = h.registry()
  const c = memoryWire(source, registry)
  t.after(() => { c.stop(); source.close() })
  await authenticate(c)
  await uploadWire(c, png, { finish: false })
  assert.equal((await c.request('upload-cancel', binding)).ok, true)
  await tick()
  assert.equal(existsSync(h.store.root), false)
  assert.equal(h.receiptIds.length, 0)

  const saved = deferred()
  const release = deferred()
  const saveImages = h.store.saveImages.bind(h.store)
  h.store.saveImages = async (...args) => {
    const result = await saveImages(...args)
    saved.resolve(result)
    await release.promise
    return result
  }
  assert.equal((await uploadWire(c, png, { finish: false })).ok, true)
  const finish = c.request('upload-finish', binding)
  try {
    const raced = await Promise.race([saved.promise, finish])
    assert.ok(Array.isArray(raced))
    assert.equal((await c.request('upload-cancel', binding)).ok, true)
    assert.equal((await finish).reason, 'expired')
    assert.equal((await c.request('upload-begin', { ...binding, bytes: png.length, mediaType: 'image/png' })).reason, 'busy')
  } finally { release.resolve() }
  await tick()
  assert.equal(existsSync(h.store.root), true)
  assert.equal(h.uploads.stagedFiles.has(h.agents.get('a').session), false)
  assert.equal(h.receiptIds.length, 0)
  assert.equal(registry.records.size, 0)
  const ledger = JSON.parse(readFileSync(join(h.home, 'pocket', 'uploads.json'), 'utf8'))
  assert.deepEqual(ledger.phones[sha256(phone)].charges.map(charge => charge.bytes), [png.length, png.length])
})

test('real DSH five finish/close cycles keep daily charges and release every plugin record on one long-lived Session', { timeout: 20_000 }, async t => {
  const h = await harness(t)
  const source = h.source()
  const registry = h.registry()
  t.after(() => source.close())
  const agent = h.agents.get('a')
  for (let i = 0; i < 5; i++) {
    const c = memoryWire(source, registry)
    await authenticate(c)
    assert.equal((await uploadWire(c, png)).state, 'admitted')
    c.stop()
    assert.equal(registry.records.size, 0)
    assert.equal(source.entries.size, 0)
    assert.equal(h.agents.get('a').session, agent.session)
  }
  const ledger = JSON.parse(readFileSync(join(h.home, 'pocket', 'uploads.json'), 'utf8'))
  assert.deepEqual(ledger.phones[sha256(phone)].charges.map(charge => charge.bytes), Array(5).fill(png.length))
  assert.equal(h.uploads.stagedFiles.get(agent.session).size, 5)
  assert.equal(messages(agent.session).length, 0)
})
