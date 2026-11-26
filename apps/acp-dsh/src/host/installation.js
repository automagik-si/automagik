import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, ftruncateSync, linkSync, lstatSync, mkdirSync, openSync,
  readSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

const CLAIM_LIMIT = 4096
const retryWait = new Int32Array(new SharedArrayBuffer(4))
const regularClaim = stat => stat.isFile() && stat.size <= CLAIM_LIMIT

export function installationIdentity(dshHome = process.env.DSH_HOME) {
  const home = dshHome?.trim() ? dshHome : '~/.dsh'
  const path = home === '~' ? homedir()
    : /^~[\\/]/.test(home) ? `${homedir()}${sep}${home.slice(2)}` : home
  // A home that cannot be resolved physically still names an installation: never stop the plugin.
  try { return realpathSync.native(path) } catch { return resolve(path) }
}

export const installationDigest = identity => createHash('sha256').update(identity).digest('hex').slice(0, 32)

function readClaim(path) {
  if (!regularClaim(lstatSync(path))) return null
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0))
  try {
    if (!regularClaim(fstatSync(fd))) return null
    // Bound the read even if the file grows after the size check.
    const bytes = Buffer.alloc(CLAIM_LIMIT + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null)
      if (count === 0) break
      length += count
    }
    if (length > CLAIM_LIMIT) return null
    let claim
    try { claim = JSON.parse(bytes.toString('utf8', 0, length)) } catch { return null }
    return claim?.version === 1 && typeof claim.identity === 'string'
      && isAbsolute(claim.identity) && !claim.identity.includes('\0') ? claim.identity : null
  } finally { closeSync(fd) }
}

function readWithRetry(path) {
  for (let retry = 0; ; retry++) {
    try { return readClaim(path) } catch (error) {
      if (error.code === 'ENOENT') return undefined
      if (retry === 3) throw error
      Atomics.wait(retryWait, 0, 0, 10)
    }
  }
}

function syncDirectory(path) {
  if (process.platform === 'win32') return
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(error.code)) throw error
  } finally { closeSync(fd) }
}

function publishClaim(path, identity) {
  const bytes = JSON.stringify({ version: 1, identity })
  if (Buffer.byteLength(bytes) > CLAIM_LIMIT) throw new Error('Installation claim is too large')
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}`
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    try {
      writeFileSync(fd, bytes)
      fsyncSync(fd)
    } finally { closeSync(fd) }
    // Linking publishes the complete claim without replacing a concurrent winner.
    try { linkSync(temporary, path) } catch (error) {
      if (error.code === 'EEXIST') return false
      throw error
    }
    syncDirectory(directory)
    return true
  } finally { rmSync(temporary, { force: true }) }
}

export function publishSelectedRoot(directory, path, record) {
  for (const dir of [dirname(directory), directory, dirname(path)]) {
    try { mkdirSync(dir, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    const stat = lstatSync(dir)
    if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o022)) {
      throw new Error('Untrusted selection directory')
    }
  }
  // Hold the inode open so disposal can revoke the bytes even if its directory starts
  // refusing unlink. Never follow or overwrite an existing selection.
  let fd, stat, linked
  const temporary = `${path}.${randomUUID()}`
  const unlink = () => {
    const current = lstatSync(path, { throwIfNoEntry: false })
    if (current && current.dev === stat.dev && current.ino === stat.ino) rmSync(path)
  }
  try {
    fd = openSync(temporary, 'wx+', 0o600)
    fchmodSync(fd, 0o600)
    stat = fstatSync(fd)
    const bytes = JSON.stringify({ ...record, descriptor: fd })
    if (Buffer.byteLength(bytes) > CLAIM_LIMIT) throw new Error('Installation record is too large')
    writeFileSync(fd, bytes)
    fsyncSync(fd)
    linkSync(temporary, path)
    linked = true
    syncDirectory(dirname(path))
  } catch (error) {
    if (fd !== undefined) {
      try {
        if (linked) {
          try { unlink() } catch { ftruncateSync(fd, 0) }
        }
      } finally { closeSync(fd) }
    }
    throw error
  } finally {
    try { rmSync(temporary, { force: true }) } catch {}
  }
  return {
    unlink,
    revoke: () => { ftruncateSync(fd, 0); fsyncSync(fd) },
    close: () => closeSync(fd),
  }
}

export function installationCliHome(acpHome, dshHome, { warn, identity = installationIdentity(dshHome) } = {}) {
  const legacy = join(acpHome, 'cli-homes')
  const digest = installationDigest(identity)
  const own = { root: join(acpHome, 'installations', digest, 'cli-homes'), owner: false }
  const path = join(legacy, 'installation.json')
  let claimed
  try {
    claimed = readWithRetry(path)
    if (claimed === undefined) {
      claimed = publishClaim(path, identity) ? identity : readWithRetry(path)
    }
  } catch {}
  if (!claimed) warn?.('Bot sign-ins: the existing Bot sign-in home could not be claimed or verified')
  return claimed === identity ? { root: legacy, owner: true } : own
}
