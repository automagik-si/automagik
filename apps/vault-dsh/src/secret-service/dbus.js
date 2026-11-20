import { url as inspectorUrl } from 'node:inspector'
import { createConnection } from 'node:net'
import { debuglog } from 'node:util'

export const bus = 'org.freedesktop.DBus'
export const busPath = '/org/freedesktop/DBus'
export const serviceName = 'org.freedesktop.secrets'
export const MAX_FRAME = 1024 * 1024
const MAX_BUFFER = 2 * MAX_FRAME
const MAX_AUTH = 4096
const MAX_BYTES = 65536
const MAX_ELEMENTS = 4096
const NO_AUTO_START = 0x02
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const guidPattern = /^[0-9a-f]{32}$/i
const namePart = '[A-Za-z_][A-Za-z_0-9]*'
const interfacePattern = new RegExp('^' + namePart + '(?:\\.' + namePart + ')+$')
const memberPattern = new RegExp('^' + namePart + '$')
const busNamePattern = /^(?::[A-Za-z_0-9-]+(?:\.[A-Za-z_0-9-]+)+|[A-Za-z_-][A-Za-z_0-9-]*(?:\.[A-Za-z_-][A-Za-z_0-9-]*)+)$/
export const objectPath = value => typeof value === 'string' && /^\/(?:[A-Za-z_0-9]+(?:\/[A-Za-z_0-9]+)*)?$/.test(value)
export const uniqueName = value => typeof value === 'string' && value.startsWith(':') && named(busNamePattern, value)
const named = (pattern, value) => value.length <= 255 && pattern.test(value)
const align = (offset, alignment) => Math.ceil(offset / alignment) * alignment

export class BusFailure extends Error {
  constructor(code = 'refused', remote) {
    super('Secret Service request failed.')
    this.code = code
    this.remote = remote
  }
}

function requireWire(condition) {
  if (!condition) throw new BusFailure()
}

const basic = { y: 1, b: 4, n: 2, q: 2, i: 4, u: 4, x: 8, t: 8, d: 8, s: 4, o: 4, g: 1 }
function signatureTypes(signature) {
  requireWire(typeof signature === 'string' && signature.length <= 255)
  let cursor = 0
  function type(depth, entry = false) {
    requireWire(depth <= 32)
    const kind = signature[cursor++]
    if (kind === 'a') return { kind, alignment: 4, child: type(depth + 1, true) }
    if (kind === '(' || (entry && kind === '{')) {
      const end = kind === '(' ? ')' : '}'
      const children = []
      while (cursor < signature.length && signature[cursor] !== end) children.push(type(depth + 1))
      requireWire(signature[cursor++] === end && children.length > 0)
      if (kind === '{') requireWire(children.length === 2 && Object.hasOwn(basic, children[0].kind))
      return { kind, alignment: 8, children }
    }
    requireWire(kind === 'v' || Object.hasOwn(basic, kind))
    return { kind, alignment: kind === 'v' ? 1 : basic[kind] }
  }
  const types = []
  while (cursor < signature.length) types.push(type(1))
  return types
}

const integer = {
  y: ['readUInt8', 'writeUInt8', 1],
  n: ['readInt16', 'writeInt16', 2],
  q: ['readUInt16', 'writeUInt16', 2],
  i: ['readInt32', 'writeInt32', 4],
  u: ['readUInt32', 'writeUInt32', 4],
  x: ['readBigInt64', 'writeBigInt64', 8],
  t: ['readBigUInt64', 'writeBigUInt64', 8],
  d: ['readDouble', 'writeDouble', 8],
}
function scalar(kind, order) {
  const [read, write, size] = integer[kind]
  const suffix = size === 1 ? '' : order
  return [read + suffix, write + suffix, size]
}

class Reader {
  constructor(buffer, offset, end, order) {
    Object.assign(this, { buffer, offset, end, order })
  }
  take(length) {
    const start = this.offset
    requireWire(length <= this.end - start)
    this.offset += length
    return start
  }
  padding(alignment) {
    const length = align(this.offset, alignment) - this.offset
    const start = this.take(length)
    for (let i = start; i < this.offset; i++) requireWire(this.buffer[i] === 0)
  }
  number(kind) {
    const [read, , size] = scalar(kind, this.order)
    return this.buffer[read](this.take(size))
  }
  value(type, depth = 1) {
    requireWire(depth <= 32)
    const { kind } = type
    this.padding(type.alignment)
    if (Object.hasOwn(integer, kind)) return this.number(kind)
    if (kind === 'b') {
      const val = this.number('u')
      requireWire(val === 0 || val === 1)
      return val === 1
    }
    if (kind === 's' || kind === 'o' || kind === 'g') {
      const length = this.number(kind === 'g' ? 'y' : 'u')
      const start = this.take(length + 1)
      const bytes = this.buffer.subarray(start, start + length)
      requireWire(this.buffer[start + length] === 0 && !bytes.includes(0))
      let value
      try { value = utf8.decode(bytes) } catch { throw new BusFailure() }
      if (kind === 'o') requireWire(objectPath(value))
      if (kind === 'g') signatureTypes(value)
      return value
    }
    if (kind === 'v') {
      const signature = this.value(signatureType, depth + 1)
      const types = signatureTypes(signature)
      requireWire(types.length === 1)
      return { signature, value: this.value(types[0], depth + 1) }
    }
    if (kind !== 'a') return type.children.map(child => this.value(child, depth + 1))
    const length = this.number('u')
    this.padding(type.child.alignment)
    if (type.child.kind === 'y') {
      requireWire(length <= MAX_BYTES)
      const start = this.take(length)
      return this.buffer.subarray(start, start + length)
    }
    const end = this.offset + length
    requireWire(end <= this.end)
    const previous = this.end
    this.end = end
    const elements = []
    while (this.offset < end) {
      requireWire(elements.length < MAX_ELEMENTS)
      elements.push(this.value(type.child, depth + 1))
    }
    this.end = previous
    return elements
  }
}
const signatureType = { kind: 'g', alignment: 1 }

class Writer {
  // Outgoing frames are small. Grow only as bytes are actually marshalled.
  buffer = Buffer.alloc(256)
  offset = 16

  reserve(length) {
    const start = this.offset
    const end = start + length
    requireWire(end <= MAX_FRAME)
    if (end > this.buffer.length) {
      const next = Buffer.alloc(Math.max(end, this.buffer.length * 2))
      this.buffer.copy(next)
      this.buffer = next
    }
    this.offset = end
    return start
  }
  padding(alignment) {
    this.reserve(align(this.offset, alignment) - this.offset)
  }
  number(kind, value) {
    const [, write, size] = scalar(kind, 'LE')
    const start = this.reserve(size)
    this.buffer[write](value, start)
  }
  bytes(bytes) {
    const start = this.reserve(bytes.length)
    bytes.copy(this.buffer, start)
  }
  value(type, value, depth = 1) {
    requireWire(depth <= 32)
    const { kind } = type
    this.padding(type.alignment)
    if (Object.hasOwn(integer, kind)) this.number(kind, value)
    else if (kind === 'b') this.number('u', value ? 1 : 0)
    else if (kind === 's' || kind === 'o' || kind === 'g') {
      requireWire(typeof value === 'string' && value.isWellFormed() && !value.includes('\0'))
      if (kind === 'o') requireWire(objectPath(value))
      if (kind === 'g') signatureTypes(value)
      const bytes = Buffer.from(value)
      this.number(kind === 'g' ? 'y' : 'u', bytes.length)
      this.bytes(bytes)
      this.reserve(1)
    } else if (kind === 'v') {
      const types = signatureTypes(value.signature)
      requireWire(types.length === 1)
      this.value(signatureType, value.signature, depth + 1)
      this.value(types[0], value.value, depth + 1)
    } else if (kind === 'a') {
      const lengthOffset = this.reserve(4)
      this.padding(type.child.alignment)
      const start = this.offset
      if (type.child.kind === 'y') {
        requireWire(Buffer.isBuffer(value) && value.length <= MAX_BYTES)
        this.bytes(value)
      } else {
        requireWire(Array.isArray(value) && value.length <= MAX_ELEMENTS)
        for (const entry of value) this.value(type.child, entry, depth + 1)
      }
      this.buffer.writeUInt32LE(this.offset - start, lengthOffset)
    } else {
      requireWire(Array.isArray(value) && type.children.length === value.length)
      type.children.forEach((child, i) => this.value(child, value[i], depth + 1))
    }
  }
}

const headerFields = {
  path: [1, 'o'], interface: [2, 's'], member: [3, 's'], error: [4, 's'], reply: [5, 'u'],
  destination: [6, 's'], sender: [7, 's'], signature: [8, 'g'],
}
const byCode = new Map(Object.entries(headerFields).map(([key, [code, sig]]) => [code, [key, sig]]))
const headerEntry = signatureTypes('(yv)')[0]
const required = {
  1: ['path', 'member'], 2: ['reply'], 3: ['error', 'reply'], 4: ['path', 'interface', 'member'],
}

export function encodeMessage({ type = 1, flags = 0, serial, headers, signature = '', body = [] }) {
  const writer = new Writer()
  const types = signatureTypes(signature)
  requireWire(types.length === body.length)
  const fields = signature === '' ? headers : { ...headers, signature }
  for (const [key, value] of Object.entries(fields)) {
    const [code, sig] = headerFields[key]
    writer.value(headerEntry, [code, { signature: sig, value }])
  }
  const headerLength = writer.offset - 16
  writer.padding(8)
  const bodyStart = writer.offset
  types.forEach((type, i) => writer.value(type, body[i]))
  writer.buffer.set([0x6c, type, flags, 1])
  writer.buffer.writeUInt32LE(writer.offset - bodyStart, 4)
  writer.buffer.writeUInt32LE(serial, 8)
  writer.buffer.writeUInt32LE(headerLength, 12)
  return writer.buffer.subarray(0, writer.offset)
}

function frameInfo(fixed) {
  const order = fixed[0] === 0x6c ? 'LE' : fixed[0] === 0x42 ? 'BE' : undefined
  requireWire(order !== undefined && fixed[1] !== 0 && fixed[3] === 1)
  const uint = offset => fixed['readUInt32' + order](offset)
  const headerEnd = 16 + uint(12)
  const bodyStart = align(headerEnd, 8)
  const length = bodyStart + uint(4)
  const serial = uint(8)
  requireWire(serial !== 0 && length <= MAX_FRAME)
  return { order, headerEnd, bodyStart, length, serial }
}

export function decodeMessage(frame) {
  requireWire(frame.length >= 16)
  const { order, headerEnd, bodyStart, length, serial } = frameInfo(frame)
  requireWire(frame.length === length)
  const type = frame[1]
  const headers = {}
  const seen = new Set()
  const reader = new Reader(frame, 16, headerEnd, order)
  while (reader.offset < headerEnd) {
    const [code, variant] = reader.value(headerEntry)
    requireWire(code !== 0 && code !== 9 && !seen.has(code))
    seen.add(code)
    const known = byCode.get(code)
    if (known === undefined) continue
    const [key, sig] = known
    requireWire(variant.signature === sig)
    headers[key] = variant.value
  }
  requireWire((required[type] ?? []).every(key => Object.hasOwn(headers, key)))
  for (const key of ['sender', 'destination']) {
    if (Object.hasOwn(headers, key)) requireWire(named(busNamePattern, headers[key]))
  }
  for (const key of ['interface', 'error']) {
    if (Object.hasOwn(headers, key)) requireWire(named(interfacePattern, headers[key]))
  }
  if (headers.member !== undefined) requireWire(named(memberPattern, headers.member))
  requireWire(headers.reply !== 0)
  reader.end = length
  reader.padding(8)
  requireWire(reader.offset === bodyStart)
  const signature = headers.signature ?? ''
  const body = signatureTypes(signature).map(type => reader.value(type, 1))
  requireWire(reader.offset === length)
  return { type, flags: frame[2], serial, headers, signature, body }
}

// A fixed header is collected before allocating space for its checked frame.
export class Frames {
  #frame = Buffer.alloc(16)
  #offset = 0
  #sized = false

  push(chunk, receive) {
    requireWire(chunk.length + this.#offset <= MAX_BUFFER)
    while (chunk.length > 0) {
      const count = Math.min(chunk.length, this.#frame.length - this.#offset)
      chunk.copy(this.#frame, this.#offset, 0, count)
      this.#offset += count
      chunk = chunk.subarray(count)
      if (this.#offset !== this.#frame.length) continue
      if (!this.#sized) {
        const { length } = frameInfo(this.#frame)
        this.#sized = true
        if (length > 16) {
          const frame = Buffer.allocUnsafe(length)
          this.#frame.copy(frame)
          this.#frame = frame
          continue
        }
      }
      const frame = this.#frame
      this.#frame = Buffer.alloc(16)
      this.#offset = 0
      this.#sized = false
      receive(decodeMessage(frame))
    }
  }
}

const traceCategories = ['net', 'stream', 'tls', 'http']
const debug = traceCategories.map(category => debuglog(category))
export function tracing(env = process.env) {
  return inspectorUrl() !== undefined || debug.some(category => category.enabled)
    || (env.NODE_DEBUG ?? '').split(/[\s,]+/).some(category => {
      const pattern = category.toLowerCase().split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
      return traceCategories.some(name => new RegExp('^' + pattern + '$').test(name))
    })
}

function unescapeAddress(value) {
  // D-Bus percent escapes bytes, including non-UTF-8 Unix pathname bytes.
  requireWire(/^(?:[A-Za-z0-9_./*\\-]|%[0-9a-fA-F]{2})+$/.test(value))
  return Buffer.from(value.replace(/%([0-9a-f]{2})/ig, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1')
}

export function parseAddress(address) {
  if (address === undefined || address === '') throw new BusFailure('unavailable')
  requireWire(typeof address === 'string' && address.startsWith('unix:') && !address.includes(';') && address.length < MAX_AUTH)
  const entries = new Map()
  for (const part of address.slice(5).split(',')) {
    const match = /^(path|abstract|guid)=(.+)$/.exec(part)
    requireWire(match !== null && !entries.has(match[1]))
    entries.set(match[1], unescapeAddress(match[2]))
  }
  requireWire(entries.has('path') !== entries.has('abstract'))
  const abstract = entries.has('abstract')
  const bytes = entries.get(abstract ? 'abstract' : 'path')
  requireWire(!bytes.includes(0) && bytes.length <= 107 && (abstract || bytes[0] === 47))
  const guid = entries.get('guid')?.toString('latin1').toLowerCase()
  requireWire(guid === undefined || guidPattern.test(guid))
  // Node exposes Unix socket names as strings. Reject bytes it cannot round-trip.
  let path
  try { path = utf8.decode(bytes) } catch { throw new BusFailure() }
  return { path: abstract ? '\0' + path : path, guid }
}

export async function connectBus(address, { signal, lifetime = signal, onSignal, onClose, env = process.env } = {}) {
  if (tracing(env)) throw new BusFailure()
  const endpoint = parseAddress(address)
  if (signal?.aborted || lifetime?.aborted) throw new BusFailure('locked')
  const socket = createConnection({ path: endpoint.path })
  const frames = new Frames()
  let auth = Buffer.alloc(0)
  let guid
  let pending
  let serial = 0
  let lastError
  const receivedAuth = Promise.withResolvers()
  const closed = Promise.withResolvers()
  const stop = (error = new BusFailure('unavailable')) => {
    lastError ??= error
    socket.destroy()
  }
  const abort = () => stop(new BusFailure('locked'))
  lifetime?.addEventListener('abort', abort, { once: true })
  socket.on('error', () => stop())
  socket.once('close', () => {
    lifetime?.removeEventListener('abort', abort)
    const error = lastError ?? new BusFailure('unavailable')
    receivedAuth.reject(error)
    pending?.reject(error)
    pending = undefined
    closed.resolve()
    onClose?.()
  })

  function receive(message) {
    if (message.type === 4) {
      onSignal?.(message)
      return
    }
    const { sender, reply, error } = message.headers
    if (pending === undefined || reply !== pending.serial || (message.type !== 2 && message.type !== 3)) return
    const call = pending
    pending = undefined
    if (sender !== call.destination && !(message.type === 3 && sender === bus)) call.reject(new BusFailure())
    else if (message.type === 3) call.reject(new BusFailure('refused', error))
    else call.resolve(message)
  }

  socket.on('connect', () => {
    socket.write('\0AUTH EXTERNAL ' + Buffer.from(String(process.getuid())).toString('hex') + '\r\n')
  })
  socket.on('data', chunk => {
    try {
      if (guid === undefined) {
        const newline = chunk.indexOf(10)
        const count = newline === -1 ? chunk.length : newline + 1
        requireWire(auth.length + count <= MAX_AUTH)
        auth = Buffer.concat([auth, chunk.subarray(0, count)])
        if (newline === -1) return
        const match = /^OK ([0-9a-fA-F]{32})\r\n$/.exec(auth.toString('latin1'))
        requireWire(match !== null)
        guid = match[1].toLowerCase()
        requireWire(endpoint.guid === undefined || endpoint.guid === guid)
        auth = undefined
        socket.write('BEGIN\r\n')
        receivedAuth.resolve()
        chunk = chunk.subarray(count)
      }
      frames.push(chunk, receive)
    } catch { stop(new BusFailure()) }
  })

  async function call(destination, path, iface, member, signature, body, expected, control = lifetime) {
    if (control?.aborted) throw new BusFailure('locked')
    if (socket.destroyed) throw lastError ?? new BusFailure('unavailable')
    requireWire(pending === undefined)
    const message = encodeMessage({ serial: ++serial, flags: NO_AUTO_START, headers: { destination, path, interface: iface, member }, signature, body })
    const result = Promise.withResolvers()
    pending = { ...result, serial, destination }
    control?.addEventListener('abort', abort, { once: true })
    try {
      socket.write(message)
      const reply = await result.promise
      requireWire(reply.signature === expected)
      return reply.body
    } finally {
      // A call may share the socket's lifetime signal.
      if (control !== lifetime) control?.removeEventListener('abort', abort)
    }
  }

  signal?.addEventListener('abort', abort, { once: true })
  try {
    await receivedAuth.promise
    const [name] = await call(bus, busPath, bus, 'Hello', '', [], 's', signal)
    requireWire(uniqueName(name))
    return { guid, call, close: () => { stop(); return closed.promise }, closed: closed.promise }
  } catch (error) {
    stop()
    await closed.promise
    throw error
  } finally {
    if (signal !== lifetime) signal?.removeEventListener('abort', abort)
  }
}
