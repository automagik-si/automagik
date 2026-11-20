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
])
const FILE_LIMIT = 64 * 1024
const ISO_TIMESTAMP = /^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/
const isId = value => typeof value === 'string' && ID.test(value)
const isVersion = value => typeof value === 'string' && value.trim() === value && cleanVersion(value) !== null

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

export function usableStore(profileDir) {
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
    const profile = fs.statSync(realProfile)
    if (!profile.isDirectory() || contains(realProfile, realHome)) return undefined
    for (const dir of [updateDir, storeDir]) {
      const entry = fs.lstatSync(dir, { throwIfNoEntry: false })
      if (entry === undefined) break
      if (!entry.isDirectory()) return undefined
      const realDir = fs.realpathSync(dir)
      if (realDir === realHome || !contains(realHome, realDir) || contains(realProfile, realDir)) return undefined
      nearest = dir
      stat = entry
    }
    if (stat.dev !== profile.dev) return undefined
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

export function writeJsonAtomic(path, value, { profileDir } = {}) {
  const json = JSON.stringify(value)
  const storeDir = usableStore(profileDir)
  const dir = dirname(path)
  const invalidStore = () => new Error('Invalid update store directory')
  if (storeDir === undefined) throw invalidStore()
  const realDir = projectedRealpath(storeDir)
  const target = join(realDir, basename(path))
  if (dirname(target) !== realDir || projectedRealpath(dir) !== realDir) throw invalidStore()

  for (const folder of [dirname(storeDir), storeDir]) {
    if (fs.lstatSync(folder, { throwIfNoEntry: false }) === undefined) {
      try { fs.mkdirSync(folder, { mode: 0o700 }) } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
    }
    if (!fs.lstatSync(folder).isDirectory() || usableStore(profileDir) !== storeDir) throw invalidStore()
  }

  const checkedStore = () => {
    if (usableStore(profileDir) !== storeDir || fs.realpathSync(storeDir) !== realDir
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
  if (live !== null && (!publicVersion(live?.version, bootIds) || !Number.isInteger(live.sequence))) return null
  if (kept !== null && !publicVersion(kept?.version, bootIds)) return null
  if (lastSequence !== null && !Number.isInteger(lastSequence)) return null
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
    || !isTimestamp(startedAt) || !isTimestamp(updatedAt)) return null
  return { version: 1, runId, bootId, phase, from, to, reason, startedAt, updatedAt }
}

function readJson(profileDir, storeDir, file, io) {
  if (storeDir === undefined) return undefined
  try {
    if (usableStore(profileDir) !== storeDir) return null
    const path = join(storeDir, file)
    const entry = io.lstatSync(path, { throwIfNoEntry: false, bigint: true })
    if (entry === undefined) return usableStore(profileDir) === storeDir ? undefined : null
    if (!entry.isFile()) return null

    const fd = io.openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = io.fstatSync(fd, { bigint: true })
      if (!stat.isFile() || !sameFile(entry, stat) || stat.size > FILE_LIMIT
        || usableStore(profileDir) !== storeDir) return null

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
  } catch {
    return null
  }
}

function readStore(profileDir, io = fs) {
  const storeDir = usableStore(profileDir)
  return {
    storeAvailable: storeDir !== undefined,
    currentRecord: readJson(profileDir, storeDir, 'current.json', io),
    supervisorRecord: readJson(profileDir, storeDir, 'supervisor.json', io),
    runRecord: readJson(profileDir, storeDir, 'state.json', io),
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

function statusOf(profileDir, env, inDesktop) {
  const records = readStore(profileDir)
  const bootIds = bootIdsOf(records, env?.AUTOMAGIK_SUPERVISOR_BOOT)
  const announced = supervisorOf(env)
  const supervisor = announced !== null && !hasBootId(announced.version, bootIds) ? announced : null
  const status = stateOf(records, supervisor?.bootId, bootIds)
  const currentInvalid = records.currentRecord !== undefined && status.current === null
  const reason = inDesktop ? 'desktop-app' : supervisor === null ? 'no-supervisor'
    : !records.storeAvailable ? 'no-store' : currentInvalid ? 'store-invalid' : null
  return {
    available: reason === null,
    reason,
    supervisor: supervisor === null ? null : { version: supervisor.version },
    ...status,
    run: runView(status.run),
  }
}

export function selfUpdateStatus({ profileDir, env = process.env, inDesktop = inDesktopApp() }) {
  return statusOf(profileDir, env, inDesktop)
}

export function install(rt) {
  const env = {
    AUTOMAGIK_SUPERVISOR_BOOT: process.env.AUTOMAGIK_SUPERVISOR_BOOT,
    AUTOMAGIK_SUPERVISOR_VERSION: process.env.AUTOMAGIK_SUPERVISOR_VERSION,
  }
  const inDesktop = inDesktopApp()
  rt.selfUpdateStatus = () => statusOf(rt.ctx.get?.('profileContext')?.dir, env, inDesktop)
}
