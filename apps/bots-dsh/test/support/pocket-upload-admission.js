// Drive Pocket's wire and DSH's packaged admission code without starting a DSH profile.
import { EventEmitter, once } from 'node:events'
import { mkdirSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { createAdapter } from '../../src/host/pocket-chat-adapter.js'
import { PocketUploads } from '../../src/host/pocket-attach.js'
import { DshChatSource } from '../../src/host/pocket-chat.js'
import { servePocketConnection, writeLimits } from '../../src/host/pocket-socket.js'

export const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

export function feed(signal) {
  const queue = []
  let wake
  const stop = () => wake?.()
  signal?.addEventListener('abort', stop, { once: true })
  return {
    push(frame) { queue.push(frame); wake?.() },
    async *[Symbol.asyncIterator]() {
      try {
        while (!signal?.aborted) {
          if (queue.length) yield queue.shift()
          else await new Promise(resolve => { wake = resolve })
        }
      } finally { signal?.removeEventListener('abort', stop) }
    },
  }
}

function wire(send, stop) {
  const pending = new Map()
  const events = []
  const lines = []
  let seq = 0
  let buffer = ''
  const incoming = (chunk) => {
    buffer += chunk
    let at
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      const message = JSON.parse(line)
      lines.push(line)
      if (Object.hasOwn(message, 'channel')) events.push(message)
      else {
        pending.get(message.id)?.(message.result ?? message.error)
        pending.delete(message.id)
      }
    }
  }
  const disconnected = () => {
    for (const resolve of pending.values()) resolve({ disconnected: true })
    pending.clear()
  }
  const request = (method, params, id = ++seq) => {
    const promise = new Promise(resolve => { pending.set(id, resolve) })
    send(`${JSON.stringify({ id, method, params })}\n`)
    return promise
  }
  return { incoming, request, disconnected, stop, events, lines }
}

export async function connectWire(path) {
  const socket = createConnection(path)
  const client = wire(data => socket.write(data), () => socket.destroy())
  socket.setEncoding('utf8')
  socket.on('data', client.incoming)
  socket.on('close', client.disconnected)
  await once(socket, 'connect')
  return client
}

export function memoryWire(source, registry, log = () => {}, limits = writeLimits()) {
  const socket = new EventEmitter()
  const stop = () => {
    socket.destroyed = true
    socket.emit('end')
    connection.close()
    client.disconnected()
  }
  const client = wire(data => socket.emit('data', data), stop)
  Object.assign(socket, { setEncoding() {}, write: client.incoming, writableLength: 0, destroy: stop, end: stop })
  const connection = servePocketConnection(socket, source, log, limits, registry)
  return { ...client, halfClose: () => socket.emit('end') }
}

export async function watchWire(client, channel = 1, terminal = 'dsh:a') {
  await client.request('hello', { write: 1, attachments: 1 })
  return client.request('subscribe', { terminal, channel, attachments: 1 })
}

export async function uploadWire(client, data, { phone = 'phone-a', channel = 1, upload = 'upload', finish = true } = {}) {
  const binding = { phone, channel, upload }
  const open = await client.request('upload-begin', { ...binding, mediaType: 'image/png', bytes: data.length })
  if (!open.ok) return open
  for (let offset = 0; offset < data.length; offset += open.chunkBytes) {
    const ack = await client.request('upload-chunk', { ...binding, offset, data: data.subarray(offset, offset + open.chunkBytes).toString('base64') })
    if (!ack.ok) return ack
  }
  return finish ? client.request('upload-finish', binding) : open
}

function pngChunk(type, bytes) {
  const data = Buffer.concat([Buffer.from(type), bytes])
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  const length = Buffer.alloc(4)
  length.writeUInt32BE(bytes.length)
  const sum = Buffer.alloc(4)
  sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([length, data, sum])
}

export function fixturePng(width = 32, height = 24, shade = 0, encodedBytes) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  const pixels = Buffer.alloc((width + 1) * height, shade)
  for (let y = 0; y < height; y++) pixels[y * (width + 1)] = 0
  const chunks = [Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(pixels))]
  if (encodedBytes) {
    const remaining = encodedBytes - chunks.reduce((size, chunk) => size + chunk.length, 0) - 24
    chunks.push(pngChunk('paDd', Buffer.alloc(remaining)))
  }
  chunks.push(pngChunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(chunks)
}

async function commandClass() {
  // Expose the installed command class in memory. Admission and receipt code runs as shipped.
  const url = import.meta.resolve('@deepseek-ai/dsh-api-session-controller')
  const hook = registerHooks({
    load(specifier, context, next) {
      if (specifier !== url) return next(specifier, context)
      return { format: 'module', shortCircuit: true, source: `${readFileSync(new URL(url), 'utf8')}\nexport { SessionCommandController };\n` }
    },
  })
  try { return (await import(url)).SessionCommandController } finally { hook.deregister() }
}

export async function realAdmission(home) {
  const [{ Context }, { LocalAttachmentStore }, { FileUploads }, { Session }, SessionCommandController] = await Promise.all([
    import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-attachment-local'),
    import('@deepseek-ai/dsh-client-file-upload'), import('@deepseek-ai/dsh-session'), commandClass(),
  ])
  const store = new LocalAttachmentStore(new Context(), { dshHome: join(home, 'dsh') })
  const agents = new Map()
  const followers = new Map()
  const hooks = {}
  const uploads = Object.assign(Object.create(FileUploads.prototype), {
    ctx: { agents, attachments: store }, stagedFiles: new WeakMap(),
  })
  const append = (session, type, data, opts) => {
    const event = session.append(type, data, opts)
    uploads.observeSessionEvent(session, event)
    for (const stream of followers.get(session.id) ?? []) stream.push({ type: 'event', event })
    return event
  }
  for (const id of ['a', 'b']) {
    const session = Session.create(id)
    agents.set(id, {
      id, session, model: { current: () => ({ provider: 'test', model: 'image' }) },
      followup(message) { append(session, 'user/message', message, { surfaceOp: 'append' }) },
    })
  }
  const commands = new SessionCommandController({
    agents, attachments: store, fileUploads: uploads, llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) },
  }, {
    resolveAgent: async id => ({ agent: agents.get(id) }),
    serializeImageAdmission: async (_, admit) => admit(),
  }, home)
  const receiptIds = []
  const prompts = []
  const admit = uploads.uploadImageStream.bind(uploads)
  uploads.uploadImageStream = async (request) => {
    const result = await admit(request)
    receiptIds.push(result.receiptId)
    return result
  }
  const controller = {
    async prompt(request, signal) {
      signal.throwIfAborted()
      prompts.push(request)
      const result = await commands.prompt(request, { kind: 'user', rpcId: request.requestId })
      hooks.accepted?.()
      return result
    },
    cancel() {},
    follow({ address: { sessionId } }, signal) {
      const session = agents.get(sessionId).session
      const stream = feed(signal)
      const streams = followers.get(sessionId) ?? new Set()
      followers.set(sessionId, streams)
      streams.add(stream)
      signal.addEventListener('abort', () => streams.delete(stream), { once: true })
      stream.push({ type: 'snapshot', cursor: session.seq - 1, records: session.snapshotEvents().map(event => ({ event })) })
      return stream
    },
    async events({ address: { sessionId }, beforeSeq, maxMessages }) {
      const events = agents.get(sessionId).session.snapshotEvents().filter(event => beforeSeq === undefined || event.seq < beforeSeq)
      return { records: events.slice(-(maxMessages ?? events.length)).map(event => ({ event })) }
    },
    async state() { return { running: false } },
    observeState(_params, signal) { return feed(signal) },
  }
  const source = () => new DshChatSource({
    adapter: createAdapter(controller), writable: true, fileUploads: () => uploads, attachmentStore: () => store,
    bots: async () => [...agents.keys()].map(id => ({ id, sessionId: id })),
  })
  mkdirSync(join(home, 'pocket'), { recursive: true, mode: 0o700 })
  return { agents, append, commands, hooks, prompts, receiptIds, source, store, uploads, registry: () => new PocketUploads({ home }) }
}
