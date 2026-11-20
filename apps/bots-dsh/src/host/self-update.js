import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { inDesktopApp } from './constants.js'
import { cleanVersion } from './update.js'

const { constants } = fs
const RUNNING = new Set(['checking', 'downloading', 'verifying', 'staging', 'switching', 'restarting', 'health', 'rollingBack'])
const TERMINAL = new Set(['healthy', 'rolledBack', 'notUpdated', 'manualRecovery'])
const ID = /^[A-Za-z0-9_-]{8,64}$/
export const REASON_CODES = Object.freeze([
  'download-failed', 'signature-invalid', 'hash-mismatch', 'not-newer', 'sequence-lower',
  'engines-dsh', 'registry-unreachable', 'stage-failed', 'switch-refused', 'health-failed',
  'rollback-failed', 'supervisor-restarted', 'no-writable-home', 'health-check-finished',
  'desktop-app', 'no-store', 'store-invalid', 'profile-invalid', 'lane-invalid',
])
const FILE_LIMIT = 64 * 1024
const ISO_TIMESTAMP = /^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/
const isId = value => typeof value === 'string' && ID.test(value)
const isVersion = value => typeof value === 'string' && value.trim() === value && cleanVersion(value) !== null
const isSequence = value => Number.isSafeInteger(value) && value >= 0

const hasBootId = (value, bootIds) => bootIds.some(id => value.includes(id))
const publicVersion = (value, bootIds) => isVersion(value) && !hasBootId(value, bootIds)
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
function projectedRealpath(path) {
  try {
    return fs.realpathSync(path)
  } catch (error) {
    const parent = dirname(path)
    if (error.code !== 'ENOENT' || parent === path) throw error
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

export function writeJsonAtomic(path, value, { profileDir, readMountInfo } = {}) {
  const json = JSON.stringify(value)
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
    } finally {
      fs.closeSync(fd)
    }
    if (!sameFile(checkedStore(), directory)) throw invalidStore()
    // Same-user processes can still race this rename. RFC 0041 trusts them in the owner-private tree.
    fs.renameSync(temp, target)
  } catch (error) {
    try { if (sameFile(checkedStore(), directory)) fs.rmSync(temp, { force: true }) } catch {}
    throw error
  }
}

function isTimestamp(value) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) return false
  const [date] = value.split('T')
  const midnight = new Date(`${date}T00:00:00Z`)
  return Number.isFinite(midnight.getTime()) && midnight.toISOString().startsWith(`${date}T`)
}

function currentOf(value, bootIds) {
  if (value?.version !== 1) return null
  const { live, kept, lastSequence } = value
  if (kept !== null && !publicVersion(kept?.version, bootIds)) return null
  const firstUse = live === null && kept === null && lastSequence === null
  if (!firstUse && !isSequence(lastSequence)) return null
  if (live !== null && (!publicVersion(live?.version, bootIds) || !isSequence(live.sequence)
    || lastSequence < live.sequence)) return null
  return {
    version: 1,
    live: live === null ? null : { version: live.version, sequence: live.sequence },
    kept: kept === null ? null : { version: kept.version },
    lastSequence,
  }
}

function supervisorStateOf(value, bootIds) {
  if (value?.version !== 1) return null
  const { bootId, runId } = value
  if (!isId(bootId) || (runId !== null && (!isId(runId) || hasBootId(runId, bootIds)))) return null
  return { bootId, runId }
}

function runOf(value, bootIds) {
  if (value?.version !== 1) return null
  const { runId, bootId, phase, from, to, reason, startedAt, updatedAt } = value
  if (!isId(bootId) || !isId(runId) || hasBootId(runId, bootIds)
    || (!RUNNING.has(phase) && !TERMINAL.has(phase))
    || (from !== null && !publicVersion(from, bootIds)) || (to !== null && !publicVersion(to, bootIds))
    || (reason !== null && (!REASON_CODES.includes(reason) || hasBootId(reason, bootIds)))
    || !isTimestamp(startedAt) || hasBootId(startedAt, bootIds)
    || !isTimestamp(updatedAt) || hasBootId(updatedAt, bootIds)) return null
  return { version: 1, runId, bootId, phase, from, to, reason, startedAt, updatedAt }
}

function readJson(checkStore, storeDir, file, io) {
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

export function readCheckRecord(profileDir) {
  const checkStore = () => usableStore(profileDir)
  return readJson(checkStore, checkStore(), 'check.json', fs)
}

function readStore(profileDir, io = fs, readMountInfo) {
  const checkStore = () => usableStore(profileDir, readMountInfo)
  const storeDir = checkStore()
  return {
    storeDir,
    currentRecord: readJson(checkStore, storeDir, 'current.json', io),
    supervisorRecord: readJson(checkStore, storeDir, 'supervisor.json', io),
    runRecord: readJson(checkStore, storeDir, 'state.json', io),
  }
}

function bootIdsOf({ supervisorRecord, runRecord }, announcedBootId) {
  return [announcedBootId, supervisorRecord?.bootId, runRecord?.bootId].filter(isId)
}

function stateOf({ currentRecord, supervisorRecord, runRecord }, bootId, bootIds) {
  const current = currentOf(currentRecord, bootIds)
  const supervisor = supervisorStateOf(supervisorRecord, bootIds)
  const run = runOf(runRecord, bootIds)
  const live = run !== null && supervisor !== null && supervisor.bootId === bootId
    && run.bootId === bootId && run.runId === supervisor.runId
  const problems = [
    currentRecord !== undefined && current === null && 'Invalid current.json',
    runRecord !== undefined && run === null && 'Invalid state.json',
    supervisorRecord !== undefined && supervisor === null && 'Invalid supervisor.json',
  ]
  return {
    current,
    run: live ? run : null,
    staleRun: run !== null && !live ? { runId: run.runId, phase: run.phase } : null,
    problem: problems.filter(Boolean).join('. ') || null,
  }
}

export function readSelfUpdate({ profileDir, bootId }, io) {
  const records = readStore(profileDir, io)
  return stateOf(records, bootId, bootIdsOf(records, bootId))
}

export function supervisorOf(env = process.env) {
  const bootId = env?.AUTOMAGIK_SUPERVISOR_BOOT
  const version = env?.AUTOMAGIK_SUPERVISOR_VERSION
  if (!isId(bootId) || !publicVersion(version, [bootId])) return null
  return { bootId, version }
}

function runView(run) {
  if (run === null) return null
  const { bootId, ...view } = run
  return view
}

export function selfUpdateDetails(profileDir, env, readMountInfo) {
  const records = readStore(profileDir, fs, readMountInfo)
  const bootIds = bootIdsOf(records, env?.AUTOMAGIK_SUPERVISOR_BOOT)
  const announced = supervisorOf(env)
  const supervisor = announced !== null && !hasBootId(announced.version, bootIds) ? announced : null
  const status = stateOf(records, supervisor?.bootId, bootIds)
  const currentInvalid = records.currentRecord !== undefined && status.current === null
  return {
    storeDir: records.storeDir,
    currentInvalid,
    supervisor: supervisor === null ? null : { version: supervisor.version },
    ...status,
    run: runView(status.run),
  }
}

function statusOf(profileDir, env, inDesktop, readMountInfo) {
  const { storeDir, currentInvalid, ...status } = selfUpdateDetails(profileDir, env, readMountInfo)
  const reason = inDesktop ? 'desktop-app' : status.supervisor === null ? 'no-supervisor'
    : storeDir === undefined ? 'no-store' : currentInvalid ? 'store-invalid' : null
  return { available: reason === null, reason, ...status }
}

export function selfUpdateStatus({ profileDir, env = process.env, inDesktop = inDesktopApp(), readMountInfo }) {
  return statusOf(profileDir, env, inDesktop, readMountInfo)
}

export function install(rt) {
  const env = {
    AUTOMAGIK_SUPERVISOR_BOOT: process.env.AUTOMAGIK_SUPERVISOR_BOOT,
    AUTOMAGIK_SUPERVISOR_VERSION: process.env.AUTOMAGIK_SUPERVISOR_VERSION,
  }
  const inDesktop = inDesktopApp()
  rt.selfUpdateStatus = () => statusOf(rt.ctx.get?.('profileContext')?.dir, env, inDesktop)
}
