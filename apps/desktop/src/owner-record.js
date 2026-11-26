// The desktop keeps one owner record per Automagik home (RFC 0024 amendment (l)).
import { randomBytes, randomUUID } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { join } from 'node:path'

export const OWNER_FILE = 'owner.json'
export const ownerFileOf = home => join(home, OWNER_FILE)

const windows = process.platform === 'win32'
const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = nodeFs.constants
const readFlags = windows ? O_RDONLY : O_RDONLY | O_NOFOLLOW | O_NONBLOCK
const noHardLinks = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'])
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function readOnce(file, fs) {
  let fd
  try {
    fd = fs.openSync(file, readFlags)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    // A symlink refused by open, a directory on Windows, or a Unix socket.
    if (['ELOOP', 'EISDIR', 'ENXIO'].includes(error.code)) return { error: 'not-a-file' }
    return { error: 'unreadable' }
  }
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) return { error: 'not-a-file' }
    const text = fs.readFileSync(fd, 'utf8')
    let record
    try { record = JSON.parse(text) } catch { return { error: 'invalid', mtime: stat.mtimeMs } }
    if (!record || !Number.isInteger(record.version) || record.version < 1) return { error: 'invalid' }
    if (record.version === 1 && (typeof record.local_id !== 'string' || !record.local_id)) return { error: 'invalid' }
    const instanceId = record.instance_id
    // 4096 UTF-16 units is a sanity bound for an environment value.
    if (typeof instanceId !== 'string' || !instanceId || instanceId.length > 4096 || instanceId.includes('\0') || !instanceId.isWellFormed()) return { error: 'invalid' }
    return { instanceId }
  } finally {
    fs.closeSync(fd)
  }
}

/** Read the id, or return null when there is no record yet. */
export function readOwnerRecord(home, deps = {}) {
  try {
    const { fs = nodeFs, now = Date.now, wait = sleep } = deps
    const file = ownerFileOf(home)
    let result = readOnce(file, fs)
    // The exclusive-write fallback can leave a young file while another start is writing it.
    for (let tries = 0; tries < 10 && result?.mtime !== undefined && now() - result.mtime < 5000; tries += 1) {
      wait(50)
      result = readOnce(file, fs)
    }
    return result?.error ? { error: result.error } : result
  } catch {
    return { error: 'unreadable' }
  }
}

function writeRecord(fs, fd, text) {
  try {
    // The mode is exact on POSIX. On Windows the file inherits the ACL of the folder the home is in.
    if (!windows) fs.fchmodSync(fd, 0o600)
    fs.writeFileSync(fd, text)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function publishRecord(fs, temporary, file, text) {
  try {
    fs.linkSync(temporary, file)
  } catch (error) {
    if (error.code === 'EEXIST') return false
    if (!noHardLinks.has(error.code)) throw error
    // Some filesystems cannot link. Keep the same exclusive create on those too.
    let fd
    try { fd = fs.openSync(file, 'wx', 0o600) } catch (error) {
      if (error.code === 'EEXIST') return false
      throw error
    }
    writeRecord(fs, fd, text)
  }
  return true
}

export function ensureOwnerRecord(home, deps = {}) {
  const existing = readOwnerRecord(home, deps)
  if (existing) return existing
  try {
    const { fs = nodeFs, random = randomUUID } = deps
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    const localId = random()
    const instanceId = random()
    const text = `${JSON.stringify({ version: 1, local_id: localId, instance_id: instanceId })}\n`
    const file = ownerFileOf(home)
    const temporary = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    const fd = fs.openSync(temporary, 'wx', 0o600)
    try {
      writeRecord(fs, fd, text)
      // The record is whole before any other start can see it at owner.json.
      if (publishRecord(fs, temporary, file, text)) return { instanceId }
    } finally {
      // A temporary file left behind is harmless; it never turns a published record into a failure.
      try { fs.unlinkSync(temporary) } catch {}
    }
    return readOwnerRecord(home, deps) ?? { error: 'create-failed' }
  } catch {
    return { error: 'create-failed' }
  }
}

const launches = new WeakMap()

/** Resolve once for this launch, including when reservations are off. */
export function launchInstance(options) {
  if (launches.has(options)) return launches.get(options)
  const { home, log, ensure = ensureOwnerRecord } = options
  const { instanceId, error } = ensure(home)
  const instance = error ? {} : { instanceId }
  launches.set(options, instance)
  if (error) log?.(`owner record ${error}; reservations are off`)
  return instance
}
