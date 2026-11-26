import { Readable } from 'node:stream'
import zlib from 'node:zlib'
import { LIMITS } from './skill-library-rules.js'
import { archiveShape, RAW_MEMBERS, SKILL_MD, skippedPath, treeError, treeRegistry, treeText, validateSkillTree } from './skill-tree.js'

export const ARCHIVE_INPUT_MAX = 6 * 1024 * 1024
export const ARCHIVE_BASE64_MAX = ARCHIVE_INPUT_MAX / 3 * 4
export const skillArchiveKind = name => /\.zip$/i.test(name) ? 'zip' : /\.(?:tar\.gz|tgz)$/i.test(name) ? 'tar.gz' : undefined
const TAR_BYTES = 8 * 1024 * 1024
const TAR_BLOCK = 512
const TAR_INPUT_CHUNK = 64 * 1024
const ZIP_LOCAL = 0x04034b50
const ZIP_CENTRAL = 0x02014b50
const ZIP_END = 0x06054b50
const ZIP_DESCRIPTOR = 0x08074b50
const ZIP_ENCRYPTED = 0x2041
const ZIP_FLAGS = 0x080e

const names = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const corrupt = () => { throw treeError('The skill archive is damaged or has invalid framing.') }
const format = () => { throw treeError('Choose a supported .zip or .tar.gz skill archive.') }
const encrypted = () => { throw treeError('Encrypted skill archives are unavailable.') }
const invalidType = path => { throw treeError(`Only regular skill files and directories are allowed: ${path}`) }
const zero = bytes => bytes.every(byte => byte === 0)
const signature = (bytes, offset, magic) => bytes.length >= offset + 4 && bytes.readUInt32LE(offset) === magic

function rawName(bytes) {
  if (bytes.includes(0)) corrupt()
  try { return names.decode(bytes) } catch { corrupt() }
}

function membersOf() {
  const registry = treeRegistry()
  let wrapper
  let wrapped = true
  let rootSkill = false
  let wrappedSkill = false
  let directCount = 0
  let wrappedCount = 0

  function register(raw, directory, size) {
    let path = directory && (raw === '.' || raw === './') ? '' : raw.startsWith('./') ? raw.slice(2) : raw
    if (directory && path.endsWith('/')) path = path.slice(0, -1)
    if (!path && raw !== '.' && raw !== './') throw treeError(`Unsafe skill path: ${raw}`)
    registry.register(path, directory, size)
    if (!directory && !skippedPath(path)) {
      directCount++
      rootSkill ||= path === SKILL_MD
      const split = path.indexOf('/')
      const top = split < 0 ? path : path.slice(0, split)
      wrapper ??= top
      wrapped &&= split >= 0 && top === wrapper
      if (wrapped) {
        const relative = path.slice(split + 1)
        if (!skippedPath(relative)) wrappedCount++
        wrappedSkill ||= relative === SKILL_MD
      }
      // Tar encounters each header before its payload. Until a wrapper is
      // established, either interpretation may still have a valid file count.
      if (directCount > LIMITS.files && (rootSkill || !wrapped || wrappedCount > LIMITS.files)) {
        throw treeError('A skill may contain at most 256 files.')
      }
    }
    return path
  }

  function canonical(path) {
    if (rootSkill) return skippedPath(path) ? undefined : path
    if (!wrapped || !wrappedSkill) throw archiveShape()
    if (skippedPath(path)) return
    const relative = path.slice(wrapper.length + 1)
    if (!skippedPath(relative)) return relative
  }

  function finish(files, format) {
    const entries = []
    let skipped = 0
    for (const { path, bytes } of files) {
      const relative = canonical(path)
      if (relative === undefined) skipped++
      else entries.push({ path: relative, bytes })
    }
    return { format, entries: validateSkillTree(entries), skipped }
  }
  return { register, canonical, finish }
}

function extendedTimestamp(data, central) {
  const flags = data[0]
  if (flags === undefined || flags & ~7) return false
  const count = (flags & 1) + (central ? 0 : ((flags >> 1) & 1) + ((flags >> 2) & 1))
  return data.length === 1 + 4 * count
}

function unixIds(data) {
  if (data[0] !== 1) return false
  const uid = data[1]
  if (uid === undefined || uid < 1 || uid > 8) return false
  const gid = data[2 + uid]
  return gid !== undefined && gid >= 1 && gid <= 8 && data.length === 3 + uid + gid
}

function ntfsTimes(data) {
  return data.length === 32 && data.readUInt32LE(0) === 0
    && data.readUInt16LE(4) === 1 && data.readUInt16LE(6) === 24
}

function zipExtras(extra, central) {
  const seen = new Set()
  for (let offset = 0; offset < extra.length;) {
    if (offset + 4 > extra.length) corrupt()
    const id = extra.readUInt16LE(offset)
    const end = offset + 4 + extra.readUInt16LE(offset + 2)
    if (end > extra.length || seen.has(id)) corrupt()
    seen.add(id)
    const data = extra.subarray(offset + 4, end)
    if (id === 0x0017 || id === 0x9901) encrypted()
    if (id === 0x5455 ? !extendedTimestamp(data, central) : id === 0x7875 ? !unixIds(data) : id === 0x000a ? !ntfsTimes(data) : true) format()
    offset = end
  }
}

function zipEnd(bytes) {
  for (let end = bytes.length - 22, first = Math.max(0, bytes.length - 65_557); end >= first; end--) {
    if (signature(bytes, end, ZIP_END) && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length) {
      const disk = bytes.readUInt16LE(end + 4)
      const centralDisk = bytes.readUInt16LE(end + 6)
      const onDisk = bytes.readUInt16LE(end + 8)
      const count = bytes.readUInt16LE(end + 10)
      const size = bytes.readUInt32LE(end + 12)
      const offset = bytes.readUInt32LE(end + 16)
      if ([disk, centralDisk, onDisk, count].includes(0xffff) || size === 0xffffffff || offset === 0xffffffff
        || (end >= 20 && signature(bytes, end - 20, 0x07064b50))) format()
      if (disk !== 0 || centralDisk !== 0 || count !== onDisk || count > RAW_MEMBERS || offset + size !== end) corrupt()
      return { offset, end, count }
    }
  }
  corrupt()
}

function zipType(host, attr, name, method, crc, compressed, size) {
  const dosDirectory = Boolean(attr & 16)
  const unixMode = attr >>> 16
  const type = unixMode & 0o170000
  if (host === 0 && unixMode !== 0) format()
  if (host === 3 && type !== 0 && type !== 0o100000 && type !== 0o040000) invalidType(name)
  const directory = host === 3 ? type === 0o040000 : dosDirectory
  if (directory !== name.endsWith('/') || (!directory && dosDirectory)
    || (directory && (method !== 0 || compressed !== 0 || size !== 0 || crc !== 0))) corrupt()
  return directory
}

function zipLocal(bytes, record, centralStart) {
  const { offset, flags, method, crc, size, compressed, name } = record
  if (offset + 30 > centralStart || !signature(bytes, offset, ZIP_LOCAL)) corrupt()
  const localFlags = bytes.readUInt16LE(offset + 6)
  const localMethod = bytes.readUInt16LE(offset + 8)
  if ((localFlags & ZIP_ENCRYPTED) || localMethod === 99) encrypted()
  if (localFlags !== flags || localMethod !== method) corrupt()
  const localCrc = bytes.readUInt32LE(offset + 14)
  const localCompressed = bytes.readUInt32LE(offset + 18)
  const localSize = bytes.readUInt32LE(offset + 22)
  if ([localCompressed, localSize].includes(0xffffffff)) format()
  const descriptor = Boolean(flags & 8)
  if ([[localCrc, crc], [localCompressed, compressed], [localSize, size]]
    .some(([local, expected]) => local !== expected && !(descriptor && local === 0))) corrupt()

  const nameEnd = offset + 30 + bytes.readUInt16LE(offset + 26)
  const dataStart = nameEnd + bytes.readUInt16LE(offset + 28)
  const dataEnd = dataStart + compressed
  if (dataEnd > centralStart || !bytes.subarray(offset + 30, nameEnd).equals(name)) corrupt()
  zipExtras(bytes.subarray(nameEnd, dataStart), false)
  let end = dataEnd
  if (descriptor) {
    // The CRC can equal the optional signature. Consider the unsigned form too.
    const matches = at => at + 12 <= centralStart && bytes.readUInt32LE(at) === crc
      && bytes.readUInt32LE(at + 4) === compressed && bytes.readUInt32LE(at + 8) === size
    if (signature(bytes, end, ZIP_DESCRIPTOR) && matches(end + 4)) end += 4
    else if (!matches(end)) corrupt()
    end += 12
  }
  return { dataStart, dataEnd, end }
}

function zipRecord(bytes, at, central) {
  if (at + 46 > central.end || !signature(bytes, at, ZIP_CENTRAL)) corrupt()
  const host = bytes[at + 5]
  if (host !== 0 && host !== 3) format()
  const flags = bytes.readUInt16LE(at + 8)
  const method = bytes.readUInt16LE(at + 10)
  if ((flags & ZIP_ENCRYPTED) || method === 99) encrypted()
  if ((flags & ~ZIP_FLAGS) || (method !== 0 && method !== 8)) format()
  const disk = bytes.readUInt16LE(at + 34)
  const crc = bytes.readUInt32LE(at + 16)
  const compressed = bytes.readUInt32LE(at + 20)
  const size = bytes.readUInt32LE(at + 24)
  const offset = bytes.readUInt32LE(at + 42)
  if (disk === 0xffff || [compressed, size, offset].includes(0xffffffff)) format()
  if (disk !== 0) corrupt()
  const nameEnd = at + 46 + bytes.readUInt16LE(at + 28)
  const extraEnd = nameEnd + bytes.readUInt16LE(at + 30)
  const next = extraEnd + bytes.readUInt16LE(at + 32)
  if (next > central.end) corrupt()
  const name = bytes.subarray(at + 46, nameEnd)
  if (!(flags & 0x800) && name.some(byte => byte >= 128)) format()
  const decoded = rawName(name)
  zipExtras(bytes.subarray(nameEnd, extraEnd), true)
  const directory = zipType(host, bytes.readUInt32LE(at + 38), decoded, method, crc, compressed, size)
  const local = zipLocal(bytes, { offset, flags, method, crc, compressed, size, name }, central.offset)
  return { ...local, offset, next, size, compressed, method, crc, decoded, directory }
}

function inflateMember(bytes, record) {
  const { dataStart, dataEnd, size, compressed, method, crc } = record
  const raw = bytes.subarray(dataStart, dataEnd)
  let data = raw
  if (method === 0) {
    if (compressed !== size) corrupt()
  } else {
    let result
    try { result = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(size, 1), info: true }) } catch { corrupt() }
    if (result.engine.bytesWritten !== compressed) corrupt()
    data = result.buffer
  }
  if (data.length !== size || zlib.crc32(data) !== crc) corrupt()
  return data
}

function readZip(bytes) {
  if (signature(bytes, 0, ZIP_END)) throw archiveShape()
  if (!signature(bytes, 0, ZIP_LOCAL)) corrupt()
  const central = zipEnd(bytes)
  const registry = membersOf()
  const records = []
  let at = central.offset
  for (let i = 0; i < central.count; i++) {
    const record = zipRecord(bytes, at, central)
    at = record.next
    records.push(record)
  }
  if (at !== central.end) corrupt()
  let end = 0
  for (const record of [...records].sort((a, b) => a.offset - b.offset)) {
    if (record.offset !== end) corrupt()
    end = record.end
  }
  if (end !== central.offset) corrupt()
  for (const record of records) {
    record.path = registry.register(record.decoded, record.directory, record.size)
  }
  const entries = []
  for (const record of records) {
    if (record.directory) continue
    const canonical = registry.canonical(record.path)
    if (canonical === SKILL_MD && record.size > LIMITS.skillMd) {
      throw treeError(`A skill file exceeds its size limit: ${record.path}`)
    }
  }
  for (const record of records) {
    if (record.directory) continue
    const data = inflateMember(bytes, record)
    treeText(data, record.path)
    entries.push({ path: record.path, bytes: Buffer.from(data) })
  }
  return registry.finish(entries, 'zip')
}

function tarField(bytes) {
  const end = bytes.indexOf(0)
  if (end < 0 || !zero(bytes.subarray(end))) corrupt()
  return rawName(bytes.subarray(0, end))
}

function octal(bytes, digits) {
  if (bytes[0] & 0x80) format()
  const field = bytes.toString('latin1')
  const number = /^ *([0-7]+)[\0 ]+$/.exec(field)?.[1]
  if (!number || number.length > digits) corrupt()
  const value = Number.parseInt(number, 8)
  if (!Number.isSafeInteger(value)) corrupt()
  return value
}

function tarHeader(block) {
  const magic = block.toString('latin1', 257, 265)
  if (magic !== 'ustar\x0000' && magic !== 'ustar  \0') format()
  let sum = 0
  for (let i = 0; i < block.length; i++) sum += i >= 148 && i < 156 ? 32 : block[i]
  if (octal(block.subarray(148, 156), 7) !== sum) corrupt()
  const size = octal(block.subarray(124, 136), 11)
  const name = tarField(block.subarray(0, 100))
  const prefix = magic === 'ustar\x0000' ? tarField(block.subarray(345, 500)) : ''
  return { raw: prefix ? `${prefix}/${name}` : name, size, type: block[156] === 0 ? '0' : String.fromCharCode(block[156]) }
}

const paxIgnored = new Set(['mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname', 'comment', 'SCHILY.fflags'])
function paxFields(bytes, global) {
  const result = new Map()
  for (let start = 0; start < bytes.length;) {
    const space = bytes.indexOf(32, start)
    if (space < 0 || space - start > 5) corrupt()
    const digits = bytes.toString('latin1', start, space)
    if (!/^[1-9][0-9]*$/.test(digits)) corrupt()
    const end = start + Number(digits)
    if (end > bytes.length || end <= space + 3 || bytes[end - 1] !== 10) corrupt()
    const record = rawName(bytes.subarray(space + 1, end - 1))
    const equal = record.indexOf('=')
    if (equal < 1) corrupt()
    const key = record.slice(0, equal)
    if (result.has(key)) corrupt()
    if (global ? key !== 'comment' : key !== 'path' && key !== 'size' && !paxIgnored.has(key)
      && !/^(?:SCHILY|LIBARCHIVE)\.xattr\..+$/.test(key)) format()
    const value = record.slice(equal + 1)
    if (key === 'size' && !/^\d+$/.test(value)) corrupt()
    result.set(key, value)
    start = end
  }
  return result
}

// One output chunk and one current member are needed beyond the retained files.
function tarStream(gzip) {
  const iterator = gzip[Symbol.asyncIterator]()
  let chunk = Buffer.alloc(0)
  let at = 0
  let fetched = 0
  let spent = 0
  async function next() {
    const part = await iterator.next()
    if (part.done) return false
    chunk = part.value
    at = 0
    fetched += chunk.length
    if (fetched > TAR_BYTES) corrupt()
    return true
  }
  async function take(size) {
    const data = Buffer.allocUnsafe(size)
    for (let filled = 0; filled < size;) {
      if (at === chunk.length && !await next()) corrupt()
      const count = Math.min(size - filled, chunk.length - at)
      chunk.copy(data, filled, at, at + count)
      at += count
      filled += count
    }
    spent += size
    return data
  }
  async function finish() {
    do {
      if (!zero(chunk.subarray(at))) corrupt()
    } while (await next())
  }
  return { take, finish, remaining: () => TAR_BYTES - spent }
}

async function unpackTar(gzip) {
  const stream = tarStream(gzip)
  const registry = membersOf()
  const entries = []
  let count = 0
  let pax
  let longName
  for (;;) {
    const block = await stream.take(TAR_BLOCK)
    if (zero(block)) {
      if (pax || longName !== undefined || !zero(await stream.take(TAR_BLOCK))) corrupt()
      await stream.finish()
      return registry.finish(entries, 'tar.gz')
    }
    const { raw, size, type } = tarHeader(block)
    if (++count > RAW_MEMBERS) corrupt()
    const padded = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
    if (padded > stream.remaining()) corrupt()
    const extension = ['x', 'g', 'L'].includes(type)
    if (extension) {
      if (size > LIMITS.skillMd) format()
      if ((type === 'g' && (pax || longName !== undefined)) || (type === 'x' && pax)
        || (type === 'L' && longName !== undefined)) corrupt()
      const data = await stream.take(size)
      if (type === 'L') longName = tarField(data)
      else {
        const fields = paxFields(data, type === 'g')
        if (type === 'x') pax = fields
      }
    } else {
      const path = pax?.get('path') ?? longName ?? raw
      if (['1', '2', '3', '4', '6', 'K'].includes(type)) invalidType(path)
      if (type !== '0' && type !== '5') format()
      if (type === '5' && size !== 0) corrupt()
      const paxPath = pax?.get('path')
      if ((longName !== undefined && paxPath !== undefined && longName !== paxPath)
        || (pax?.has('size') && Number(pax.get('size')) !== size)) corrupt()
      const member = registry.register(path, type === '5', size)
      pax = longName = undefined
      if (type === '0') {
        const bytes = await stream.take(size)
        treeText(bytes, member)
        entries.push({ path: member, bytes })
      }
    }
    if (!zero(await stream.take(padded - size))) corrupt()
  }
}

async function readTar(bytes) {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) corrupt()
  function* chunks() {
    for (let at = 0; at < bytes.length; at += TAR_INPUT_CHUNK) yield bytes.subarray(at, at + TAR_INPUT_CHUNK)
  }
  const source = Readable.from(chunks())
  const gzip = source.pipe(zlib.createGunzip({ chunkSize: TAR_INPUT_CHUNK }))
  try {
    return await unpackTar(gzip)
  } catch (error) {
    if (error.code === 'bot/invalid') throw error
    corrupt()
  } finally {
    source.destroy()
    gzip.destroy()
  }
}

export async function readSkillArchive(bytes, { kind }) {
  if (!(bytes instanceof Uint8Array)) corrupt()
  if (bytes.byteLength > ARCHIVE_INPUT_MAX) throw treeError('The skill archive is over 6 MiB.')
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (kind === 'zip') return readZip(buffer)
  if (kind === 'tar.gz' || kind === 'tgz') return readTar(buffer)
  format()
}
