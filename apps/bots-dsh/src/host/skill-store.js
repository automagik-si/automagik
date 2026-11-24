import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import { isWindowsReservedName } from '../shared/roles.js'
import { skillRefusal } from './skill-keys.js'

export const LIMITS = Object.freeze({
  skillMd: 65536, files: 256, file: 1048576, total: 5242880, pathBytes: 200, depth: 8, description: 1024,
})
const META_LIMIT = 4 * 1024 * 1024
const MANIFEST_LIMIT = 128 * 1024
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0
const unchanged = (a, b) => a.dev === b.dev && a.ino === b.ino
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const order = (a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))
const pathError = rule => skillRefusal('path', { rule })
export const skillName = value => typeof value === 'string' && value.length <= 32 && /^[a-z](?:[a-z0-9]|-(?=[a-z0-9]))*$/.test(value) && value.trim() === value
export const skillHashId = value => typeof value === 'string' && value.length === 64 && /^[0-9a-f]+$/.test(value)
export const skillToken = value => typeof value === 'string' && value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
export const portableKey = value => value.normalize('NFC').toLowerCase()

export function isPortableDeviceName(segment) {
  const base = portableKey(segment).split('.')[0].replace(/[ .]+$/, '')
  return isWindowsReservedName(base) || /^(?:com|lpt)[¹²³]$/.test(base) || ['conin$', 'conout$', 'clock$'].includes(base)
}

export const skillPath = value => typeof value === 'string' && Buffer.byteLength(value) <= LIMITS.pathBytes
  && Buffer.from(value).toString() === value && value.split('/').length <= LIMITS.depth
  && !/[\\<>:"|?*\x00-\x1f\x7f-\x9f]/u.test(value)
  && value.split('/').every(segment => segment && !/[ .]$/.test(segment) && !isPortableDeviceName(segment))

export function folderOf(name) {
  if (!skillName(name)) throw skillRefusal('name-format')
  return isPortableDeviceName(name) ? `${name}_` : name
}

function manifestBounds(entries, legacy) {
  if (!Array.isArray(entries) || entries.length > LIMITS.files) throw skillRefusal('too-many-files')
  const exceptional = legacy && entries.length === 1 && entries[0]?.path === 'SKILL.md'
    && entries[0].size === legacy.size && entries[0].sha256 === legacy.sha256
  const paths = new Map()
  let total = 0
  for (const entry of entries) {
    if (!skillPath(entry?.path)) throw pathError('path')
    if (entry.type !== undefined && entry.type !== 'file') throw pathError('type')
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !skillHashId(entry.sha256)) throw pathError('manifest')
    const components = entry.path.split('/')
    for (let count = 1; count <= components.length; count++) {
      const spelling = components.slice(0, count).join('/')
      const key = portableKey(spelling)
      const file = count === components.length
      const previous = paths.get(key)
      if (previous && (file || previous.file || previous.spelling !== spelling)) throw pathError('collision')
      paths.set(key, { spelling, file })
    }
    if (!exceptional) {
      if (entry.path === 'SKILL.md' && entry.size > LIMITS.skillMd) throw skillRefusal('too-large-md')
      if (entry.size > LIMITS.file) throw skillRefusal('too-large-file')
    }
    total += entry.size
    if (!exceptional && total > LIMITS.total) throw skillRefusal('too-large-total')
  }
  if (!paths.get('skill.md')?.file || paths.get('skill.md').spelling !== 'SKILL.md') throw pathError('missing SKILL.md')
  return total
}

export function skillPreflight(entries, { legacyBody = false } = {}) {
  if (!Array.isArray(entries) || entries.length > LIMITS.files) throw skillRefusal('too-many-files')
  const declared = entries.map(entry => {
    if (!skillPath(entry?.path)) throw pathError('path')
    if (!(entry.bytes instanceof Uint8Array) || (entry.type !== undefined && entry.type !== 'file')) throw pathError('type')
    return { path: entry.path, size: entry.bytes.byteLength, sha256: legacyBody?.sha256 ?? '0'.repeat(64) }
  })
  manifestBounds(declared, legacyBody === true ? declared[0] : legacyBody)
  const files = entries.map(({ path, bytes }) => ({ path, bytes: Buffer.from(bytes) }))
  if (legacyBody && legacyBody !== true) manifestBounds(fileEntries(files), legacyBody)
  return { entries: files.sort(order) }
}

export function fileEntries(files) {
  return files.map(({ path, bytes }) => ({
    path, size: bytes.byteLength, sha256: digest(bytes),
    script: path.startsWith('scripts/') || (bytes[0] === 35 && bytes[1] === 33),
  })).sort(order)
}

export const manifestOf = entries => [...entries].sort(order).map(({ path, size, sha256 }) => JSON.stringify([path, size, sha256]) + '\n').join('')
export const skillHash = entries => digest(manifestOf(entries[0]?.bytes === undefined ? entries : fileEntries(entries)))
export const validManifest = (entries, hash, legacy) => {
  try {
    manifestBounds(entries, legacy)
    return entries.every(entry => typeof entry.script === 'boolean') && skillHash(entries) === hash
  } catch { return false }
}

export function textSkillMd({ name, description, content }) {
  const quoted = JSON.stringify(description ?? '').replace(/[\u2028\u2029\ufeff]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'))
  return Buffer.from(`---\nname: ${name}\ndescription: ${quoted}\n---\n\n${content ?? ''}\n`)
}

export function textSkillFields(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const match = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n\n([\s\S]*)\n$/.exec(text)
  if (!match || !skillName(match[1])) throw new SkillFilesChanged()
  const description = JSON.parse(match[2])
  if (typeof description !== 'string') throw new SkillFilesChanged()
  return { name: match[1], description, body: match[3] }
}

export const bodyOf = bytes => textSkillFields(bytes).body

export class SkillFilesChanged extends Error {
  constructor() {
    super('Its stored files are missing or changed; save the skill again.')
    this.code = 'files-changed'
  }
}

const stat = path => fs.lstatSync(path, { throwIfNoEntry: false })
const fileOkay = (info, device) => info?.isFile() && info.nlink === 1 && info.dev === device
const safeDir = (info, device) => info?.isDirectory() && info.dev === device && !(info.mode & 0o022)
  && (process.getuid === undefined || info.uid === process.getuid())
export const storeCode = error => error?.key === 'skill.store-failed' ? error.params.code : error?.code ?? 'io-error'
const storeError = code => skillRefusal('store-failed', { code })

export function createSkillStore(home, { mode = 'read' } = {}) {
  const pins = new Map()
  let root
  let binding
  try {
    const realHome = fs.realpathSync(home)
    const homeInfo = fs.lstatSync(realHome)
    const path = join(realHome, 'skills')
    let info = stat(path)
    if (!info && mode === 'write') {
      try { fs.mkdirSync(path, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
      info = stat(path)
    }
    if (!info) binding = { ok: false, code: 'root-absent' }
    else if (!safeDir(info, homeInfo.dev) || !unchanged(homeInfo, fs.lstatSync(realHome))) binding = { ok: false, code: 'root-refused' }
    else {
      root = { path, dev: info.dev }
      pins.set(realHome, homeInfo)
      pins.set(path, info)
      binding = { ok: true }
    }
  } catch (error) {
    binding = { ok: false, code: error.code === 'ENOENT' && mode === 'read' ? 'root-absent' : 'root-refused' }
  }

  function boundRoot(write = false) {
    if (!binding.ok) throw storeError(binding.code)
    if (write && mode !== 'write') throw storeError('read-only')
    return root.path
  }

  // The pins persist across operations. A clean removal or rename releases the old path.
  function directory(path) {
    const base = boundRoot()
    const parent = dirname(base)
    if (path !== parent) directory(dirname(path))
    const previous = pins.get(path)
    const info = stat(path)
    if (path === parent ? !info || !unchanged(previous, info) : !safeDir(info, root.dev) || (previous && !unchanged(previous, info))) {
      if (!previous && !info) throw new SkillFilesChanged()
      throw storeError('identity-changed')
    }
    pins.set(path, info)
    return info
  }

  function mkdir(path, permissions = 0o700) {
    const parent = dirname(path)
    directory(parent)
    if (!stat(path)) {
      if (pins.has(path)) throw storeError('identity-changed')
      try { fs.mkdirSync(path, { mode: permissions }) } finally { directory(parent) }
    }
    directory(path)
  }

  function readFile(path, limit, { expected, expectedSize, optional = false, capture = true, owned = false, verifyFirst = false } = {}) {
    const parent = dirname(path)
    directory(parent)
    const before = stat(path)
    if (!before && optional) {
      directory(parent)
      return undefined
    }
    if (!fileOkay(before, root.dev)) throw new SkillFilesChanged()
    const fd = fs.openSync(path, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK)
    try {
      directory(parent)
      const info = fs.fstatSync(fd)
      if (!fileOkay(info, root.dev) || !unchanged(before, info) || info.size > limit
        || (expectedSize !== undefined && info.size !== expectedSize)) throw new SkillFilesChanged()
      const chunks = []
      const hash = createHash('sha256')
      const buffer = Buffer.allocUnsafe(65536)
      let size = 0
      while (size <= limit) {
        const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, limit + 1 - size), null)
        if (count === 0) break
        size += count
        hash.update(buffer.subarray(0, count))
        if (capture && !verifyFirst) chunks.push(Buffer.from(buffer.subarray(0, count)))
      }
      const after = stat(path)
      if (!fileOkay(after, root.dev) || !unchanged(info, after) || size !== info.size || size > limit
        || (expected !== undefined && hash.digest('hex') !== expected)) throw new SkillFilesChanged()
      if (capture && verifyFirst) {
        // The first pass authenticated this size without allocating from the manifest or stat.
        const bytes = Buffer.allocUnsafe(size)
        let offset = 0
        while (offset < size) {
          const count = fs.readSync(fd, bytes, offset, Math.min(buffer.length, size - offset), offset)
          if (count === 0) throw new SkillFilesChanged()
          offset += count
        }
        if (fs.readSync(fd, buffer, 0, 1, size) !== 0 || digest(bytes) !== expected) throw new SkillFilesChanged()
        const current = stat(path)
        if (!fileOkay(current, root.dev) || !unchanged(info, current) || current.size !== size) throw new SkillFilesChanged()
        return bytes
      }
      return owned ? info : capture ? Buffer.concat(chunks, size) : undefined
    } finally {
      fs.closeSync(fd)
      directory(parent)
    }
  }

  function writeFile(path, bytes, permissions) {
    const parent = dirname(path)
    directory(parent)
    const fd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600)
    try {
      directory(parent)
      if (!fileOkay(fs.fstatSync(fd), root.dev)) throw new SkillFilesChanged()
      fs.writeFileSync(fd, bytes)
      directory(parent)
      fs.fchmodSync(fd, permissions)
      directory(parent)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
      directory(parent)
    }
  }

  function syncDirectory(path) {
    if (process.platform === 'win32') return
    const expected = directory(path)
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | NOFOLLOW)
    try {
      if (!unchanged(expected, fs.fstatSync(fd))) throw storeError('identity-changed')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
      directory(path)
    }
  }

  function rename(from, to) {
    const fromParent = dirname(from)
    const toParent = dirname(to)
    directory(fromParent)
    directory(toParent)
    try { fs.renameSync(from, to) } finally {
      directory(fromParent)
      directory(toParent)
    }
    for (const [path, pin] of pins) {
      if (path === from || path.startsWith(from + sep)) {
        pins.delete(path)
        pins.set(to + path.slice(from.length), pin)
      }
    }
    if (pins.has(to)) directory(to)
    syncDirectory(toParent)
    if (fromParent !== toParent) syncDirectory(fromParent)
  }

  function names(path, limit = LIMITS.files) {
    directory(path)
    const result = []
    const dir = fs.opendirSync(path)
    try {
      for (let entry; (entry = dir.readSync()) !== null;) {
        if (result.length === limit) throw new SkillFilesChanged()
        result.push(entry.name)
      }
    } finally {
      dir.closeSync()
      directory(path)
    }
    return result
  }

  function tree(entries) {
    const dirs = new Map([['', new Set()]])
    for (const entry of entries) {
      let prefix = ''
      const parts = entry.path.split('/')
      for (const [index, part] of parts.entries()) {
        dirs.get(prefix).add(part)
        prefix = prefix ? `${prefix}/${part}` : part
        if (index < parts.length - 1 && !dirs.has(prefix)) dirs.set(prefix, new Set())
      }
    }
    return dirs
  }

  function readTree(path, entries, hash, legacy, capture = true) {
    manifestBounds(entries, legacy)
    if (skillHash(entries) !== hash) throw new SkillFilesChanged()
    const dirs = tree(entries)
    for (const [relative, expected] of dirs) {
      const found = names(join(path, relative))
      if (found.length !== expected.size || found.some(name => !expected.has(name))) throw new SkillFilesChanged()
    }
    const result = entries.map(({ path: relative, size, sha256, script }) => {
      const bytes = readFile(join(path, relative), size, {
        expected: sha256, expectedSize: size, capture,
        verifyFirst: relative === 'SKILL.md' && size > LIMITS.skillMd,
      })
      if (capture && script !== undefined && script !== (relative.startsWith('scripts/') || (bytes[0] === 35 && bytes[1] === 33))) {
        throw new SkillFilesChanged()
      }
      return { path: relative, size, sha256, ...(capture ? { bytes } : {}) }
    })
    for (const relative of dirs.keys()) directory(join(path, relative))
    return result
  }

  function unlink(path, expected) {
    const parent = dirname(path)
    directory(parent)
    const info = stat(path)
    if (!info) return
    if (!fileOkay(info, root.dev) || (expected && !unchanged(info, expected))) throw new SkillFilesChanged()
    if (process.platform === 'win32') {
      const fd = fs.openSync(path, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK)
      try {
        directory(parent)
        const opened = fs.fstatSync(fd)
        if (!fileOkay(opened, root.dev) || !unchanged(opened, info)) throw new SkillFilesChanged()
        fs.fchmodSync(fd, 0o600)
        directory(parent)
      } finally { fs.closeSync(fd) }
    }
    try { fs.unlinkSync(path) } finally { directory(parent) }
  }

  function rmdir(path) {
    directory(path)
    try {
      fs.rmdirSync(path)
      pins.delete(path)
      return true
    } catch (error) {
      if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error
      return false
    } finally { directory(dirname(path)) }
  }

  function chmodDir(path, permissions) {
    directory(path)
    try { fs.chmodSync(path, permissions) } finally { directory(path) }
  }

  function removeTree(path, entries) {
    if (!stat(path)) {
      directory(dirname(path))
      if (pins.has(path)) throw storeError('identity-changed')
      return true
    }
    const dirs = [...tree(entries).keys()].reverse().map(relative => join(path, relative))
    for (const entry of entries) {
      const file = join(path, entry.path)
      if (!stat(file)) continue
      let owner
      try {
        owner = readFile(file, entry.size, { expected: entry.sha256, expectedSize: entry.size, capture: false, owned: true })
      } catch (error) {
        if (error instanceof SkillFilesChanged) continue
        throw error
      }
      chmodDir(dirname(file), 0o755)
      unlink(file, owner)
    }
    for (const dir of dirs) {
      if (!stat(dir)) continue
      if (dir !== path) chmodDir(dirname(dir), 0o755)
      if (!rmdir(dir)) chmodDir(dir, 0o555)
    }
    return !stat(path)
  }

  function hashPath(hash) {
    if (!skillHashId(hash)) throw skillRefusal('hash-format')
    return hash
  }

  function stagedPath(token) {
    if (!skillToken(token)) throw skillRefusal('preview-expired')
    return join(boundRoot(), '.staging', token)
  }

  function pathOf(name, hash) {
    const folder = folderOf(name)
    hashPath(hash)
    return join(boundRoot(), folder, hash)
  }

  function manifestPath(name, hash) {
    const folder = folderOf(name)
    hashPath(hash)
    return join(boundRoot(), '.manifests', folder, hash)
  }

  function tempRoot() {
    const path = join(boundRoot(true), '.tmp')
    mkdir(path)
    return path
  }

  function atomic(path, bytes) {
    directory(dirname(path))
    const temp = join(tempRoot(), randomUUID())
    const journal = temp + '.json'
    const file = basename(path)
    writeFile(journal, JSON.stringify({ v: 1, file }), 0o600)
    mkdir(temp)
    const source = join(temp, file)
    writeFile(source, bytes, 0o600)
    const target = stat(path)
    if (target && !fileOkay(target, root.dev)) throw storeError('ledger-unreadable')
    rename(source, path)
    rmdir(temp)
    unlink(journal)
  }

  function decodeManifest(bytes, hash, legacy) {
    if (!bytes || digest(bytes) !== hash) throw new SkillFilesChanged()
    const text = bytes.toString()
    const lines = text.slice(0, -1).split('\n')
    if (lines.length > LIMITS.files) throw new SkillFilesChanged()
    const entries = lines.map(line => {
      let row
      try { row = JSON.parse(line) } catch { throw new SkillFilesChanged() }
      if (!Array.isArray(row) || row.length !== 3) throw new SkillFilesChanged()
      const [path, size, sha256] = row
      return { path, size, sha256 }
    })
    try { manifestBounds(entries, legacy) } catch { throw new SkillFilesChanged() }
    if (manifestOf(entries) !== text) throw new SkillFilesChanged()
    return entries
  }

  function readManifest(name, hash, legacy) {
    return decodeManifest(readFile(manifestPath(name, hash), MANIFEST_LIMIT, { expected: hash }), hash, legacy)
  }

  function writeManifest(name, hash, text, legacy) {
    const path = manifestPath(name, hash)
    boundRoot(true)
    const bytes = Buffer.from(text)
    if (bytes.length > MANIFEST_LIMIT) throw new SkillFilesChanged()
    decodeManifest(bytes, hash, legacy)
    mkdir(dirname(dirname(path)))
    mkdir(dirname(path))
    if (!readFile(path, MANIFEST_LIMIT, { expected: hash, optional: true })) atomic(path, bytes)
  }

  function putTree(path, files, staged = false) {
    mkdir(path)
    const dirs = [...tree(files).keys()]
    for (const relative of dirs.slice(1)) mkdir(join(path, relative))
    for (const file of files) writeFile(join(path, file.path), file.bytes, staged ? 0o600 : 0o444)
    for (const relative of dirs.reverse()) {
      const dir = join(path, relative)
      if (!staged && relative) chmodDir(dir, 0o555)
      syncDirectory(dir)
    }
  }

  function putGeneration(name, entries, legacyBody) {
    folderOf(name)
    const { entries: files } = skillPreflight(entries, { legacyBody })
    const manifest = fileEntries(files)
    const hash = skillHash(manifest)
    const path = pathOf(name, hash)
    boundRoot(true)
    mkdir(dirname(path), 0o755)
    if (stat(path)) {
      readTree(path, manifest, hash, legacyBody, false)
      return hash
    }
    const temp = join(tempRoot(), randomUUID())
    putTree(temp, files)
    if (stat(path)) throw new SkillFilesChanged()
    rename(temp, path)
    chmodDir(path, 0o555)
    return hash
  }

  function checkRepair(name, hash, legacyBody) {
    const path = pathOf(name, hash)
    const parent = dirname(path)
    if (!stat(parent)) return false
    directory(parent)
    if (!stat(path)) return false
    // An unexpected tree stays in place, including any changed bytes.
    readTree(path, readManifest(name, hash, legacyBody), hash, legacyBody, false)
    return true
  }

  function repair(name, hash, entries, { legacyBody } = {}) {
    checkRepair(name, hash, legacyBody)
    const candidate = skillPreflight(entries, { legacyBody })
    if (skillHash(candidate.entries) !== hash) throw new SkillFilesChanged()
    return putGeneration(name, candidate.entries, legacyBody)
  }

  function remove(name, generations, { retire = false } = {}) {
    const folder = folderOf(name)
    for (const { hash } of generations) hashPath(hash)
    const parent = join(boundRoot(true), folder)
    if (!stat(parent) && pins.has(parent)) throw storeError('identity-changed')
    const removed = []
    for (const { hash, legacy } of generations) {
      let manifest
      try { manifest = readManifest(name, hash, legacy) } catch (error) {
        if (error instanceof SkillFilesChanged) continue
        throw error
      }
      if (stat(parent) && !removeTree(pathOf(name, hash), manifest)) continue
      unlink(manifestPath(name, hash))
      removed.push(hash)
    }
    return { removed, retired: retire && (!stat(parent) || rmdir(parent)) }
  }

  function readMetadata(path, limit = META_LIMIT, empty) {
    try {
      const bytes = readFile(path, limit, { optional: true })
      if (bytes === undefined) return empty
      const value = JSON.parse(bytes.toString())
      if (value?.version !== 1) throw new SkillFilesChanged()
      return value
    } catch (error) {
      if (error.key === 'skill.store-failed') throw error
      throw storeError('ledger-unreadable')
    }
  }

  const metadata = (name, empty, validate, fullCode) => ({
    read() {
      const value = readMetadata(join(boundRoot(), name), META_LIMIT, empty())
      if (!validate(value)) throw storeError('ledger-unreadable')
      return value
    },
    write(value) {
      const path = join(boundRoot(true), name)
      this.read()
      if (!validate(value)) throw storeError('ledger-unreadable')
      const bytes = Buffer.from(JSON.stringify(value))
      if (bytes.length > META_LIMIT) throw storeError(fullCode)
      atomic(path, bytes)
    },
  })
  const ledger = metadata('.ledger.json', () => ({ version: 1, names: {} }), validLedger, 'ledger-full')
  const reviews = metadata('.reviews.json', () => ({ version: 1, hashes: {} }),
    value => keysOf(value, ['version', 'hashes']) && record(value.hashes) && Object.keys(value.hashes).every(skillHashId), 'reviews-full')
  const importHolds = metadata('.import-holds.json', () => ({ version: 1, items: {} }),
    value => keysOf(value, ['version', 'items']) && record(value.items) && Object.values(value.items).every(skillHashId), 'import-holds-full')

  function stage(entries) {
    const { entries: files } = skillPreflight(entries)
    const token = randomUUID()
    const path = stagedPath(token)
    boundRoot(true)
    mkdir(dirname(path))
    writeFile(path + '.manifest', manifestOf(fileEntries(files)), 0o600)
    syncDirectory(dirname(path))
    putTree(path, files, true)
    return token
  }

  function staged(token, hash) {
    if (!skillHashId(hash)) throw skillRefusal('hash-format')
    const path = stagedPath(token)
    return readTree(path, decodeManifest(readFile(path + '.manifest', MANIFEST_LIMIT, { expected: hash }), hash), hash)
  }

  function unstage(token, hash) {
    const path = stagedPath(token)
    if (hash !== undefined) hashPath(hash)
    boundRoot(true)
    const bytes = readFile(path + '.manifest', MANIFEST_LIMIT, { expected: hash })
    const entries = decodeManifest(bytes, hash ?? digest(bytes))
    if (removeTree(path, entries)) unlink(path + '.manifest')
  }

  function sweepStaging({ olderThanMs, live = new Set() }) {
    const base = join(boundRoot(true), '.staging')
    if (!stat(base)) return
    for (const token of names(base, 4096)) {
      if (!skillToken(token) || live.has(token)) continue
      if (Date.now() - stat(join(base, token)).mtimeMs >= olderThanMs) {
        try { unstage(token) } catch (error) { if (!(error instanceof SkillFilesChanged)) throw error }
      }
    }
  }

  function sweepTemps(olderThanMs) {
    const base = join(boundRoot(true), '.tmp')
    if (!stat(base)) return
    for (const id of names(base, 4096)) {
      if (!skillToken(id)) continue
      const path = join(base, id)
      if (Date.now() - stat(path).mtimeMs < olderThanMs) continue
      try {
        const bytes = readFile(path + '.json', 1024, { optional: true })
        if (!bytes) continue
        const journal = JSON.parse(bytes.toString())
        if (!keysOf(journal, ['v', 'file']) || journal.v !== 1 || !/^\.?[a-z0-9][a-z0-9.-]*$/.test(journal.file)) continue
        if (names(path, 2).some(file => file !== journal.file)) continue
        unlink(join(path, journal.file))
        if (rmdir(path)) unlink(path + '.json')
      } catch (error) {
        if (!(error instanceof SkillFilesChanged || error instanceof SyntaxError)) throw error
      }
    }
  }

  function read(name, hash, entries, { legacyBody, capture = true } = {}) {
    const path = pathOf(name, hash)
    return readTree(path, entries, hash, legacyBody, capture)
  }

  return {
    bound: () => ({ ...binding }), pathOf, checkRepair, repair, read, remove, writeManifest, readManifest,
    publish(name, entries, { legacyBody } = {}) {
      if (legacyBody === true) throw pathError('legacy proof required')
      return putGeneration(name, entries, legacyBody)
    },
    verify(...args) {
      try { read(...args); return true } catch (error) {
        if (error instanceof SkillFilesChanged) return false
        throw error
      }
    },
    collect: ({ name, generations, retire }) => remove(name, generations, { retire }),
    stage, staged, unstage, sweepStaging, sweepTemps,
    readLedger: ledger.read.bind(ledger), writeLedger: ledger.write.bind(ledger),
    readReviews: reviews.read.bind(reviews), writeReviews: reviews.write.bind(reviews),
    readImportHolds: importHolds.read.bind(importHolds), writeImportHolds: importHolds.write.bind(importHolds),
  }
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const keysOf = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key))
const timestamp = value => Number.isSafeInteger(value) && value >= 0
const viaOkay = value => ['move', 'settings-form', 'learning-card', 'preview', 'bot', 'restore', 'older-edit', 'import'].includes(value)

function validLedger(ledger) {
  return keysOf(ledger, ['version', 'names']) && ledger.version === 1 && record(ledger.names) && Object.entries(ledger.names).every(([name, row]) =>
    skillName(name) && keysOf(row, ['committed', 'pending', 'generations', 'deleting', 'deleted'])
    && record(row.generations)
    && (row.committed === undefined || (skillHashId(row.committed) && row.generations[row.committed]?.state === 'committed'))
    && (row.deleted === undefined || timestamp(row.deleted))
    && (row.deleting === undefined || (keysOf(row.deleting, ['at', 'hash', 'preserve']) && timestamp(row.deleting.at)
      && (row.deleting.preserve === undefined || row.deleting.preserve === true)
      && (row.deleting.hash === null || skillHashId(row.deleting.hash))))
    && (row.pending === undefined || (keysOf(row.pending, ['hash', 'mirror', 'via', 'at', 'op'])
      && skillHashId(row.pending.hash) && Object.hasOwn(row.generations, row.pending.hash)
      && skillHashId(row.pending.mirror) && viaOkay(row.pending.via) && timestamp(row.pending.at)
      && ['create', 'edit', 'migrate', 'restore', 'repair', 'reconcile'].includes(row.pending.op)))
    && Object.entries(row.generations).every(([hash, gen]) => skillHashId(hash)
      && keysOf(gen, ['mirror', 'via', 'state', 'firstCheck', 'files', 'at', 'legacy', 'reviewDue'])
      && skillHashId(gen.mirror) && viaOkay(gen.via) && ['prepared', 'committed'].includes(gen.state)
      && ['pending', 'done'].includes(gen.firstCheck) && timestamp(gen.at)
      && Number.isInteger(gen.files) && gen.files >= 1 && gen.files <= LIMITS.files
      && (gen.reviewDue === undefined || (keysOf(gen.reviewDue, ['priority', 'writer'])
        && ['person', 'bot', 'move'].includes(gen.reviewDue.priority)
        && (keysOf(gen.reviewDue.writer, ['botId']) && typeof gen.reviewDue.writer.botId === 'string'
          || keysOf(gen.reviewDue.writer, ['person']) && gen.reviewDue.writer.person === true
          || keysOf(gen.reviewDue.writer, ['host']) && gen.reviewDue.writer.host === true)))
      && (gen.legacy === undefined || (gen.via === 'move' && gen.files === 1 && keysOf(gen.legacy, ['size', 'sha256'])
        && timestamp(gen.legacy.size) && skillHashId(gen.legacy.sha256)))))
}
