// Document wire calls and a host fixture for admission ordering and controlled races.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PocketUploads, sha256 } from '../../src/host/pocket-attach.js'
import { DshChatSource } from '../../src/host/pocket-chat.js'
import { createAdapter } from '../../src/host/pocket-chat-adapter.js'
import { writeLimits } from '../../src/host/pocket-socket.js'
import { feed, fixturePng, memoryWire } from './pocket-upload-admission.js'

export const phone = 'phone-a'
export const binding = { phone, channel: 1, upload: 'upload' }
export const png = fixturePng()
export const pdf = Buffer.from('%PDF-1.7\nexample')
export const tick = () => new Promise(resolve => setImmediate(resolve))
export const nameCases = JSON.parse(readFileSync(new URL('../../../../docs/rfcs/fixtures/0033-document-names.json', import.meta.url))).cases

export const hello = (c, extra) => c.request('hello', { write: 1, attachments: 1, documents: 1, ...extra })
export const subscribe = (c, extra, id) => c.request('subscribe', { terminal: 'dsh:a', channel: 1, attachments: 1, documents: 1, ...extra }, id)
export const begin = (c, bytes, extra) => c.request('upload-begin', { ...binding, mediaType: 'application/pdf', bytes, ...extra })
export const chunk = (c, data, extra) => c.request('upload-chunk', { ...binding, offset: 0, data: data.toString('base64'), ...extra })
export const finish = (c, extra) => c.request('upload-finish', { ...binding, ...extra })
export const cancel = (c, extra) => c.request('upload-cancel', { ...binding, ...extra })
export const send = (c, extra) => c.request('send', { channel: 1, phone, id: 'message', uploads: [binding.upload], ...extra })
export const event = (seq, content) => ({ type: 'user/message', seq, time: seq, data: { role: 'user', source: { kind: 'user' }, content } })

export async function uploadDocument(c, data, options = {}, end = true) {
  const open = await begin(c, data.length, options)
  if (!open.ok) return open
  const { phone, channel, upload } = { ...binding, ...options }
  const scope = { phone, channel, upload }
  for (let offset = 0; offset < data.length; offset += open.chunkBytes) {
    const ack = await chunk(c, data.subarray(offset, offset + open.chunkBytes), { ...scope, offset })
    if (!ack.ok) return ack
  }
  return end ? finish(c, scope) : open
}

export function scratch(t) {
  const home = mkdtempSync(join(tmpdir(), 'pocket-doc-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return home
}

export function fakeClock() {
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

export function fakeHost(t, { carriesSignInCode } = {}) {
  const home = scratch(t)
  const pocket = join(home, 'pocket')
  mkdirSync(pocket, { mode: 0o700 })
  const clock = fakeClock()
  const calls = { files: [], images: [], prompts: [], bytes: [] }
  const faults = {}
  const logs = []
  const log = (...args) => logs.push(args)
  const sessions = { a: [], b: [] }
  const store = {
    imageLimits: { mediaTypes: ['image/png'], maxImageBytes: 8 * 1024 ** 2, maxImagesPerMessage: 4, maxMessageImageBytes: 16 * 1024 ** 2,
      maxImagePixels: 40e6, maxImageDimension: 65535 },
    readImageRequest() { assert.fail('a file block cannot reach the image reader') },
  }
  const controller = {
    follow({ address: { sessionId } }, signal) {
      const stream = feed(signal)
      const events = sessions[sessionId]
      stream.push({ type: 'snapshot', cursor: events.at(-1)?.seq ?? -1, records: events.map(event => ({ event })) })
      return stream
    },
    async events({ address: { sessionId }, beforeSeq, maxMessages }) {
      return { records: sessions[sessionId].filter(event => event.seq < beforeSeq).slice(-maxMessages).map(event => ({ event })) }
    },
    async state() { await faults.state?.(); return { running: false } },
    observeState(_request, signal) { return feed(signal) },
    async prompt(request) { calls.prompts.push(request); return { accepted: true } },
    cancel() {},
  }
  const uploads = {
    async uploadStream(request) {
      calls.files.push(request)
      if (faults.file) return faults.file(request)
      const chunks = []
      for await (const part of request.data) chunks.push(part)
      const data = Buffer.concat(chunks)
      calls.bytes.push(data)
      return { receiptId: `file-receipt-${calls.bytes.length}`, file: { attachmentId: `sha256:${sha256(data)}`, name: request.name, bytes: data.length } }
    },
    async uploadImageStream(request) {
      const receiptId = `image-receipt-${calls.images.push(request)}`
      for await (const part of request.data) assert.ok(part.length)
      return { receiptId, image: { mediaType: 'image/png', width: 32, height: 24, bytes: png.length } }
    },
  }
  const source = new DshChatSource({
    adapter: createAdapter(controller), writable: true, bots: async () => [{ id: 'a', sessionId: 'a' }, { id: 'b', sessionId: 'b' }],
    log, attachmentStore: () => store, fileUploads: () => uploads, carriesSignInCode, management: { enabled: () => true },
  })
  t.after(() => source.close())
  const registry = () => new PocketUploads({ home, clock, now: clock.now, log, statfs: () => ({ bavail: 10n ** 10n, bsize: 1n }) })
  const host = registry()
  const limits = writeLimits(clock.now)
  const client = (active = host) => {
    const c = memoryWire(source, active, log, limits)
    t.after(c.stop)
    return c
  }
  return { host, registry, client, source, clock, calls, faults, logs, store, uploads, sessions,
    ledgerPath: join(pocket, 'uploads.json'), documentsPath: join(pocket, 'document-manifests.json') }
}
