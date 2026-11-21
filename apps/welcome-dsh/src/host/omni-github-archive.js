// GitHub's git-archive stream is untrusted until both its commit and Git tree match.
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { parentPort, workerData } from 'node:worker_threads'
import { createGunzip } from 'node:zlib'

const BLOCK = 512
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const zero = bytes => bytes.every(byte => byte === 0)
const bad = message => { throw new Error(message) }
const hash = (type, bytes) => createHash('sha1').update(type + ' ' + bytes.length + '\0').update(bytes).digest()

async function* capped(source, limit, kind) {
  let size = 0
  for await (const part of source) {
    size += part.byteLength
    if (size > limit) bad('The Omni archive exceeds its ' + kind + ' size limit.')
    yield part
  }
}

// Read only the current header/body. Backpressure reaches gunzip and the HTTP stream.
function reader(source, limit) {
  const input = source[Symbol.asyncIterator]()
  let chunk = Buffer.alloc(0)
  let offset = 0
  async function ready() {
    while (offset === chunk.length) {
      const { done, value } = await input.next()
      if (done) return false
      chunk = value
      offset = 0
    }
    return true
  }
  return {
    async take(size) {
      if (size > limit) bad('The Omni archive exceeds its expanded size limit.')
      limit -= size
      const bytes = Buffer.alloc(size)
      let written = 0
      while (written < size) {
        if (!await ready()) bad('The Omni archive is truncated.')
        const count = Math.min(size - written, chunk.length - offset)
        chunk.copy(bytes, written, offset, offset + count)
        offset += count
        written += count
      }
      return bytes
    },
    async end() {
      while (await ready()) {
        if (!zero(chunk.subarray(offset))) bad('The Omni archive has data after its end.')
        offset = chunk.length
      }
    },
  }
}

const field = (header, start, size) => {
  const bytes = header.subarray(start, start + size)
  const end = bytes.indexOf(0)
  return utf8.decode(end === -1 ? bytes : bytes.subarray(0, end))
}
function octal(header, start, size) {
  const value = field(header, start, size).trim()
  if (!/^[0-7]+$/.test(value)) bad('The Omni archive has an invalid number in a header.')
  return Number.parseInt(value, 8)
}
function headerOf(header) {
  const expected = octal(header, 148, 8)
  let sum = 0
  for (let at = 0; at < BLOCK; at++) sum += at >= 148 && at < 156 ? 32 : header[at]
  if (sum !== expected) bad('The Omni archive has a bad header checksum.')
  const type = field(header, 156, 1) || '0'
  if (!['0', '5', '2', 'x', 'g'].includes(type)) bad('The Omni archive has an unsupported entry type.')
  const prefix = field(header, 345, 155)
  return {
    type, mode: octal(header, 100, 8), size: octal(header, 124, 12),
    name: (prefix ? prefix + '/' : '') + field(header, 0, 100),
    target: field(header, 157, 100),
  }
}

function paxOf(bytes) {
  const records = Object.create(null)
  let at = 0
  while (at < bytes.length) {
    const space = bytes.indexOf(32, at)
    if (space === -1 || space - at > 10) bad('The Omni archive has a malformed PAX record.')
    const digits = bytes.toString('latin1', at, space)
    const length = /^[0-9]+$/.test(digits) ? Number(digits) : 0
    const end = at + length
    if (end <= space + 2 || end > bytes.length || bytes[end - 1] !== 10) bad('The Omni archive has a malformed PAX record.')
    const record = utf8.decode(bytes.subarray(space + 1, end - 1))
    const equals = record.indexOf('=')
    if (equals < 1 || record.includes('\0')) bad('The Omni archive has a malformed PAX record.')
    const key = record.slice(0, equals)
    if (['path', 'linkpath', 'comment', 'size'].includes(key)) records[key] = record.slice(equals + 1)
    at = end
  }
  return records
}

const unusualPath = path => path.includes('\\') || path.includes('\0')

function partsOf(path, directory) {
  const text = directory && path.endsWith('/') ? path.slice(0, -1) : path
  const parts = text.split('/')
  if (Buffer.byteLength(path) > 4096 || parts.length > 64 || unusualPath(path)
    || parts.some(part => part === '' || part === '.' || part === '..')) {
    bad('The Omni archive has an unsafe path.')
  }
  return parts
}

function add(root, parts, entry) {
  let children = root
  for (const part of parts.slice(0, -1)) {
    if (!children.has(part)) children.set(part, { children: new Map() })
    const node = children.get(part)
    if (!node.children) bad('An Omni archive entry is under a file or symlink.')
    children = node.children
  }
  const name = parts.at(-1)
  const previous = children.get(name)
  if (previous && (previous.type || entry.type !== '5')) bad('The Omni archive has a duplicate path or an entry under a file or symlink.')
  children.set(name, entry.type === '5' ? { type: '5', children: previous?.children ?? new Map() } : entry)
}

function treeOf(children) {
  const entries = [...children].map(([name, entry]) => {
    const sortKey = Buffer.from(entry.children ? name + '/' : name)
    if (entry.children) return { sortKey, name, mode: '40000', digest: treeOf(entry.children) }
    const mode = entry.type === '2' ? '120000' : entry.exec ? '100755' : '100644'
    const body = entry.type === '2' ? Buffer.from(entry.target) : entry.body
    return { sortKey, name, mode, digest: hash('blob', body) }
  })
  entries.sort((a, b) => Buffer.compare(a.sortKey, b.sortKey))
  return hash('tree', Buffer.concat(entries.flatMap(({ name, mode, digest }) => [Buffer.from(mode + ' ' + name + '\0'), digest])))
}

function verifyLinks(entries) {
  const links = new Map(entries.filter(entry => entry.type === '2').map(entry => [entry.path, entry.target]))
  for (const [path, target] of links) {
    const resolved = path.split('/').slice(0, -1)
    let remaining = target.split('/')
    let hops = 0
    while (remaining.length) {
      const part = remaining.shift()
      if (part === '' || part === '.') continue
      if (part === '..') {
        if (!resolved.length) bad('An Omni archive symlink leaves its source tree.')
        resolved.pop()
        continue
      }
      resolved.push(part)
      const link = links.get(resolved.join('/'))
      if (link !== undefined) {
        if (++hops > 40) bad('The Omni archive has a symlink loop or too many symlink hops.')
        resolved.pop()
        remaining = link.split('/').concat(remaining)
      }
    }
  }
}

async function parseArchive(source, { commit, tree, expanded, count }) {
  const read = reader(capped(source, expanded, 'expanded'), expanded)
  const root = new Map()
  const entries = []
  let top, local, global = Object.create(null)
  let headers = 0
  for (;;) {
    const header = await read.take(BLOCK)
    if (zero(header)) {
      if (!zero(await read.take(BLOCK)) || local) bad('The Omni archive has an invalid end.')
      await read.end()
      break
    }
    if (++headers > count) bad('The Omni archive contains too many entries.')
    const { type, mode, size, name, target } = headerOf(header)
    if (size > expanded || (['x', 'g'].includes(type) && size > 1024 * 1024)) bad('The Omni archive entry is too large.')
    const body = await read.take(size)
    await read.take((BLOCK - size % BLOCK) % BLOCK)
    if (type === 'g') {
      const records = paxOf(body)
      if (Object.hasOwn(records, 'comment') && records.comment !== commit) bad('The Omni archive does not name the pinned commit.')
      global = { ...global, ...records }
      continue
    }
    if (type === 'x') {
      if (local) bad('The Omni archive has consecutive local PAX headers.')
      local = paxOf(body)
      continue
    }
    const pax = { ...global, ...local }
    local = undefined
    if ((pax.size !== undefined && (!/^\d+$/.test(pax.size) || Number(pax.size) !== size))
      || (type !== '0' && size !== 0)) bad('The Omni archive has an invalid entry size.')
    const parts = partsOf(pax.path ?? name, type === '5')
    if (top === undefined) top = parts[0]
    if (parts.shift() !== top) bad('The Omni archive has more than one root folder.')
    if (parts.length === 0) {
      if (type !== '5' || entries.some(entry => entry.path === '')) bad('The Omni archive has an invalid root folder.')
      entries.push({ type, path: '' })
      continue
    }
    const entry = { type, path: parts.join('/') }
    if (type === '0') Object.assign(entry, { exec: (mode & 0o111) !== 0, body })
    if (type === '2') {
      entry.target = pax.linkpath ?? target
      if (!entry.target || entry.target.startsWith('/') || unusualPath(entry.target)
        || Buffer.byteLength(entry.target) > 4096 || entry.target.split('/').length > 64) {
        bad('The Omni archive has an unsafe symlink target.')
      }
    }
    add(root, parts, entry)
    entries.push(entry)
  }
  if (global.comment !== commit) bad('The Omni archive does not name the pinned commit.')
  verifyLinks(entries)
  if (treeOf(root).toString('hex') !== tree) bad('The Omni archive does not match the pinned Git tree.')
  return entries.filter(entry => entry.path)
}

async function verify({ stream, pin, limits }) {
  const compressed = limits?.compressed ?? 64 * 1024 * 1024
  const expanded = limits?.expanded ?? 512 * 1024 * 1024
  const count = limits?.count ?? 100_000
  let entries
  await pipeline(Readable.fromWeb(stream), input => capped(input, compressed, 'compressed'), createGunzip(), async input => {
    entries = await parseArchive(input, { ...pin, expanded, count })
  })
  const transfers = entries.filter(entry => entry.type === '0' && entry.body.length).map(entry => entry.body.buffer)
  parentPort.postMessage({ entries }, transfers)
}

try {
  await verify(workerData)
} catch (error) {
  parentPort.postMessage({ error: error.message })
}
