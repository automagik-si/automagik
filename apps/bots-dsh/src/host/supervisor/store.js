import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'

const { constants } = fs
const FILE_LIMIT = 64 * 1024
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino

export function storeDirOf(profileDir) {
  if (typeof profileDir !== 'string') return undefined
  const profile = normalize(profileDir)
  const profiles = dirname(profile)
  if (basename(profiles) !== 'profiles') return undefined
  return join(dirname(profiles), 'update', basename(profile))
}

function contains(dir, path) {
  const part = relative(dir, path)
  return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)
}

function readLinuxMountInfo() {
  return fs.readFileSync('/proc/self/mountinfo', 'utf8')
}

function sameMount(profile, store, mountInfo) {
  const mounts = new Map()
  const mountPath = /^\/(?:[^ \t\\]|\\(?:040|011|012|134))*$/
  for (const line of mountInfo.replace(/\n$/, '').split('\n')) {
    const fields = line.split(' ')
    const [id, parent, device, root, point] = fields
    const separator = fields.indexOf('-', 6)
    if (separator < 6 || fields.length !== separator + 4 || fields.includes('')
      || !/^\d+$/.test(id) || !/^\d+$/.test(parent) || !/^\d+:\d+$/.test(device)
      || !/^\S+$/.test(root) || !mountPath.test(point) || mounts.has(id)) return false
    const path = point.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)))
    mounts.set(id, { id, parent, path })
  }

  // A mount stacked at the same path covers its parent at that path.
  const covered = new Set()
  for (const mount of mounts.values()) {
    if (mount.parent !== mount.id && mounts.get(mount.parent)?.path === mount.path) covered.add(mount.parent)
  }
  const mountIdOf = path => {
    let length = 0
    let id
    for (const mount of mounts.values()) {
      if (covered.has(mount.id) || mount.path.length < length) continue
      const prefix = mount.path === '/' ? '/' : mount.path + '/'
      if (path !== mount.path && !path.startsWith(prefix)) continue
      id = mount.path.length === length ? undefined : mount.id
      length = mount.path.length
    }
    return id
  }
  const profileMount = mountIdOf(profile)
  return profileMount !== undefined && profileMount === mountIdOf(store)
}

export function usableStore(profileDir, readMountInfo = readLinuxMountInfo) {
  // RFC 0041 supports Linux units and Linux images, where O_NOFOLLOW is available.
  if (constants.O_NOFOLLOW === undefined) return undefined
  const storeDir = storeDirOf(profileDir)
  if (storeDir === undefined) return undefined
  const updateDir = dirname(storeDir)
  const home = dirname(updateDir)
  try {
    let nearest = home
    let stat = fs.lstatSync(home)
    if (!stat.isDirectory()) return undefined
    const realHome = fs.realpathSync(home)
    const realProfile = fs.realpathSync(profileDir)
    let realNearest = realHome
    const profile = fs.statSync(realProfile)
    if (!profile.isDirectory() || contains(realProfile, realHome)) return undefined
    for (const dir of [updateDir, storeDir]) {
      const entry = fs.lstatSync(dir, { throwIfNoEntry: false })
      if (entry === undefined) break
      if (!entry.isDirectory()) return undefined
      const realDir = fs.realpathSync(dir)
      if (realDir === realHome || !contains(realHome, realDir) || contains(realProfile, realDir)) return undefined
      nearest = dir
      realNearest = realDir
      stat = entry
    }
    if (stat.dev !== profile.dev) return undefined
    if (process.platform === 'linux' && !sameMount(realProfile, realNearest, readMountInfo())) return undefined
    fs.accessSync(nearest, constants.W_OK | constants.X_OK)
    return storeDir
  } catch {
    return undefined
  }
}

// Resolve existing ancestors when comparing paths to a store that has yet to be created.
export function projectedRealpath(path) {
  try {
    return fs.realpathSync(path)
  } catch (error) {
    const parent = dirname(path)
    if (error.code !== 'ENOENT' || parent === path || fs.lstatSync(path, { throwIfNoEntry: false })) throw error
    return join(projectedRealpath(parent), basename(path))
  }
}

const invalidStore = () => new Error('Invalid update store directory')

function ensureStoreDirectories(storeDir, checkStore) {
  for (const folder of [dirname(storeDir), storeDir]) {
    if (fs.lstatSync(folder, { throwIfNoEntry: false }) === undefined) {
      try { fs.mkdirSync(folder, { mode: 0o700 }) } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
    }
    if (!fs.lstatSync(folder).isDirectory() || checkStore() !== storeDir) throw invalidStore()
  }
}

export function prepareStore(profileDir, readMountInfo) {
  const checkStore = () => usableStore(profileDir, readMountInfo)
  const storeDir = checkStore()
  if (storeDir === undefined) throw invalidStore()
  const realDir = projectedRealpath(storeDir)
  ensureStoreDirectories(storeDir, checkStore)
  if (fs.realpathSync(storeDir) !== realDir) throw invalidStore()
  return realDir
}

export function writeJsonAtomic(path, value, { profileDir, readMountInfo, durable = false } = {}) {
  const json = JSON.stringify(value)
  if (durable && Buffer.byteLength(json) > FILE_LIMIT) throw new Error('Update record exceeds its size limit')
  const checkStore = () => usableStore(profileDir, readMountInfo)
  const storeDir = checkStore()
  const dir = dirname(path)
  if (storeDir === undefined) throw invalidStore()
  const realDir = projectedRealpath(storeDir)
  const target = join(realDir, basename(path))
  if (dirname(target) !== realDir || projectedRealpath(dir) !== realDir) throw invalidStore()
  ensureStoreDirectories(storeDir, checkStore)

  const checkedStore = () => {
    if (checkStore() !== storeDir || fs.realpathSync(storeDir) !== realDir
      || fs.realpathSync(dir) !== realDir) throw invalidStore()
    const entry = fs.lstatSync(realDir, { bigint: true })
    if (!entry.isDirectory()) throw invalidStore()
    return entry
  }

  const directory = checkedStore()
  const temp = join(realDir, `.self-update-${randomUUID()}.tmp`)
  const fd = fs.openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    try {
      fs.writeFileSync(fd, json, 'utf8')
      if (durable) fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    if (!sameFile(checkedStore(), directory)) throw invalidStore()
    // Same-user processes can still race this rename. RFC 0041 trusts them in the owner-private tree.
    fs.renameSync(temp, target)
    if (durable) {
      try { syncDirectory(realDir) } catch (error) {
        error.renamed = true
        throw error
      }
    }
  } catch (error) {
    try { if (sameFile(checkedStore(), directory)) fs.rmSync(temp, { force: true }) } catch {}
    throw error
  }
}

export function readJson(checkStore, storeDir, file, io = fs) {
  if (storeDir === undefined) return undefined
  const path = join(storeDir, file)
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (checkStore() !== storeDir) return null
      const entry = io.lstatSync(path, { throwIfNoEntry: false, bigint: true })
      if (entry === undefined) return checkStore() === storeDir ? undefined : null
      if (!entry.isFile()) return null

      const fd = io.openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const stat = io.fstatSync(fd, { bigint: true })
        if (!sameFile(entry, stat)) continue
        if (!stat.isFile() || stat.size > FILE_LIMIT || checkStore() !== storeDir) return null

        const buffer = Buffer.alloc(FILE_LIMIT + 1)
        let length = 0
        while (length < buffer.length) {
          const count = io.readSync(fd, buffer, length, buffer.length - length, null)
          if (count === 0) break
          length += count
        }
        if (length > FILE_LIMIT) return null
        return JSON.parse(buffer.toString('utf8', 0, length))
      } finally {
        io.closeSync(fd)
      }
    }
  } catch {
    return null
  }
  return null
}


export const identity = path => fs.lstatSync(path, { bigint: true, throwIfNoEntry: false })
export const sameEntry = (a, b) => a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino

export function readOwner(path, entry) {
  if (!entry?.isFile()) return null
  try {
    const fd = fs.openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      if (!sameEntry(fs.fstatSync(fd, { bigint: true }), entry)) return null
      const bytes = Buffer.alloc(1025)
      const length = fs.readSync(fd, bytes, 0, bytes.length, null)
      if (length === bytes.length) return null
      return JSON.parse(bytes.toString('utf8', 0, length))
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

export function ownerIsDead(owner, host) {
  if (owner?.host !== host || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false
  try {
    process.kill(owner.pid, 0)
    return false
  } catch (error) {
    return error.code === 'ESRCH'
  }
}

// Unlike the bounded dry check, a serving supervisor's lock never expires by age.
export function takeLifetimeLock(path, owner) {
  const bytes = JSON.stringify(owner)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeBytesAtomic(path, bytes, { exclusive: true })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const entry = identity(path)
      if (!entry) continue
      if (!ownerIsDead(readOwner(path, entry), owner.host)) return null

      // Each dead claim gives the next contender a different name. Contenders
      // never unlink a claim while another process could be acquiring it.
      const base = `${path}.takeover-${entry.ino}-${entry.ctimeNs}`
      const claims = []
      for (let index = 0; ; index++) {
        const claim = `${base}-${index}`
        try { writeBytesAtomic(claim, bytes, { exclusive: true }) } catch (error) {
          if (error.code !== 'EEXIST') throw error
          if (!ownerIsDead(readOwner(claim, identity(claim)), owner.host)) return null
          claims.push(claim)
          continue
        }
        try {
          const current = identity(path)
          if (sameEntry(current, entry) && current.ctimeNs === entry.ctimeNs) fs.rmSync(path)
        } finally {
          for (const stale of [...claims, claim]) fs.rmSync(stale, { force: true })
        }
        break
      }
      continue
    }
    const entry = identity(path)
    const owns = () => sameEntry(identity(path), entry)
    return { owns, release: () => { if (owns()) fs.rmSync(path, { force: true }) } }
  }
  return null
}

export function takeOwnerLock(path, owner, ttl) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd
    try {
      fd = fs.openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const entry = identity(path)
      if (entry === undefined) continue
      if (!entry.isFile()) throw new Error('Invalid update lock')
      const holder = readOwner(path, entry)
      const startedAt = typeof holder?.startedAt === 'number' ? holder.startedAt : Date.parse(holder?.startedAt)
      // A contender can see the file before its owner has finished writing it.
      const age = Date.now() - (Number.isFinite(startedAt) ? startedAt : Number(entry.mtimeNs / 1_000_000n))
      if (age <= ttl && !ownerIsDead(holder, owner.host)) return null
      // Two stale-lock contenders can both pass this check before either unlinks.
      // The later unlink can remove the new lock, within RFC 0041's same-user trust boundary.
      const current = identity(path)
      if (sameEntry(current, entry) && current.ctimeNs === entry.ctimeNs) fs.rmSync(path, { force: true })
      continue
    }

    const created = fs.fstatSync(fd, { bigint: true })
    const owns = () => sameEntry(identity(path), created)
    const release = () => {
      try {
        if (owns()) fs.rmSync(path, { force: true })
      } finally {
        fs.closeSync(fd)
      }
    }
    try {
      fs.writeFileSync(fd, JSON.stringify(owner))
    } catch (error) {
      release()
      throw error
    }
    return { owns, release }
  }
  return null
}

export function syncFile(path) {
  const fd = fs.openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('Expected a regular file')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

export function syncDirectory(path) {
  const fd = fs.openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

export function writeBytesAtomic(path, bytes, { durable = false, exclusive = false } = {}) {
  const dir = dirname(path)
  const temp = join(dir, `.write-${randomUUID()}.tmp`)
  const fd = fs.openSync(temp, 'wx', 0o600)
  try {
    try {
      fs.writeFileSync(fd, bytes)
      if (durable) fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    // link publishes with the same atomic visibility as rename, without replacing an existing archive.
    if (exclusive) fs.linkSync(temp, path)
    else fs.renameSync(temp, path)
    if (durable) syncDirectory(dir)
  } finally {
    fs.rmSync(temp, { force: true })
  }
}

export function directory(path) {
  try { fs.mkdirSync(path, { mode: 0o700 }) } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  if (!identity(path)?.isDirectory()) throw new Error('Expected a directory')
  return path
}

export function regularBytes(path, { optional = false } = {}) {
  let fd
  try { fd = fs.openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch (error) {
    if (optional && error.code === 'ENOENT') return undefined
    throw error
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('Expected a regular file')
    return fs.readFileSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}
