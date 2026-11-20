import { randomUUID } from 'node:crypto'
import {
  accessSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { inDesktopApp } from './constants.js'
import { cleanVersion } from './update.js'

const RUNNING = new Set(['checking', 'downloading', 'verifying', 'staging', 'switching', 'restarting', 'health', 'rollingBack'])
const TERMINAL = new Set(['healthy', 'rolledBack', 'notUpdated', 'manualRecovery'])
const ID = /^[A-Za-z0-9_-]{8,64}$/
const REASON = /^[a-z][a-z0-9-]{0,63}$/
const FILE_LIMIT = 64 * 1024
const ISO_TIMESTAMP = /^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/
const isLabel = value => typeof value === 'string' && !/[/\\]/.test(value)
const isId = value => typeof value === 'string' && ID.test(value)
const isVersion = value => typeof value === 'string' && value.trim() === value && cleanVersion(value) !== null

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
  const storeDir = storeDirOf(profileDir)
  if (storeDir === undefined) return undefined
  const updateDir = dirname(storeDir)
  const home = dirname(updateDir)
  try {
    let nearest = home
    let stat = lstatSync(home)
    if (!stat.isDirectory()) return undefined
    const realHome = realpathSync(home)
    const realProfile = realpathSync(profileDir)
    const profile = statSync(realProfile)
    if (!profile.isDirectory() || contains(realProfile, realHome)) return undefined
    for (const dir of [updateDir, storeDir]) {
      const entry = lstatSync(dir, { throwIfNoEntry: false })
      if (entry === undefined) break
      if (!entry.isDirectory()) return undefined
      const realDir = realpathSync(dir)
      if (realDir === realHome || !contains(realHome, realDir) || contains(realProfile, realDir)) return undefined
      nearest = dir
      stat = entry
    }
    if (stat.dev !== profile.dev) return undefined
    accessSync(nearest, constants.W_OK)
    return storeDir
  } catch {
    return undefined
  }
}

// The supervisor resolves the store with usableStore before writing. A unique temp
// in the destination directory lets polling see either complete version of the file.
export function writeJsonAtomic(path, value) {
  const json = JSON.stringify(value)
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!lstatSync(dir).isDirectory()) throw new Error('Invalid update store directory')
  const temp = join(dir, `.self-update-${randomUUID()}.tmp`)
  const fd = openSync(temp, 'wx', 0o600)
  try {
    try {
      writeFileSync(fd, json, 'utf8')
    } finally {
      closeSync(fd)
    }
    renameSync(temp, path)
  } catch (error) {
    try { rmSync(temp, { force: true }) } catch {}
    throw error
  }
}

function isTimestamp(value) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) return false
  const [date] = value.split('T')
  const midnight = new Date(`${date}T00:00:00Z`)
  return Number.isFinite(midnight.getTime()) && midnight.toISOString().startsWith(`${date}T`)
}

function currentOf(value) {
  if (value?.version !== 1) return null
  const { live, kept, lastSequence } = value
  if (live !== null && (!isLabel(live?.version) || !Number.isInteger(live.sequence))) return null
  if (kept !== null && !isLabel(kept?.version)) return null
  if (lastSequence !== null && !Number.isInteger(lastSequence)) return null
  return {
    version: 1,
    live: live === null ? null : { version: live.version, sequence: live.sequence },
    kept: kept === null ? null : { version: kept.version },
    lastSequence,
  }
}

function supervisorStateOf(value, liveBootId) {
  if (value?.version !== 1) return null
  const { bootId, runId } = value
  if (!isId(bootId) || (runId !== null && (!isId(runId) || runId === bootId || runId === liveBootId))) return null
  return { bootId, runId }
}

function runOf(value, liveBootId, supervisorBootId) {
  if (value?.version !== 1) return null
  const { runId, bootId, phase, from, to, reason, startedAt, updatedAt } = value
  const bootIds = [bootId, liveBootId, supervisorBootId]
  if (!isId(bootId) || !isId(runId) || bootIds.includes(runId)
    || (!RUNNING.has(phase) && !TERMINAL.has(phase)) || !(from === null || isVersion(from)) || !(to === null || isVersion(to))
    || (reason !== null && (typeof reason !== 'string' || !REASON.test(reason)
      || bootIds.some(id => id && reason.includes(id))))
    || !isTimestamp(startedAt) || !isTimestamp(updatedAt)) return null
  return { version: 1, runId, bootId, phase, from, to, reason, startedAt, updatedAt }
}

function readJson(storeDir, file, parse) {
  try {
    if (storeDir === undefined) return { value: null, problem: null }
    const path = join(storeDir, file)
    const entry = lstatSync(path, { throwIfNoEntry: false })
    if (entry === undefined) return { value: null, problem: null }
    if (!entry.isFile()) return { value: null, problem: `Invalid ${file}` }

    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const value = readRecord(fd, parse)
    if (value !== null) return { value, problem: null }
  } catch {}
  return { value: null, problem: `Invalid ${file}` }
}

function readRecord(fd, parse) {
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > FILE_LIMIT) return null
    const buffer = Buffer.alloc(FILE_LIMIT + 1)
    let length = 0
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null)
      if (count === 0) break
      length += count
    }
    if (length > FILE_LIMIT) return null
    return parse(JSON.parse(buffer.toString('utf8', 0, length)))
  } finally {
    closeSync(fd)
  }
}

export function readSelfUpdate({ storeDir, bootId }) {
  const { value: current, problem: currentProblem } = readJson(storeDir, 'current.json', currentOf)
  const { value: supervisor, problem: supervisorProblem } = readJson(storeDir, 'supervisor.json',
    value => supervisorStateOf(value, bootId))
  const { value: run, problem: runProblem } = readJson(storeDir, 'state.json',
    value => runOf(value, bootId, supervisor?.bootId))
  const live = run !== null && supervisor !== null && supervisor.bootId === bootId
    && run.bootId === bootId && run.runId === supervisor.runId
  return {
    current,
    run: live ? run : null,
    staleRun: run !== null && !live ? { runId: run.runId, phase: run.phase } : null,
    problem: [currentProblem, runProblem, supervisorProblem].filter(Boolean).join('. ') || null,
  }
}

export function supervisorOf(env = process.env) {
  const bootId = env?.AUTOMAGIK_SUPERVISOR_BOOT
  const version = env?.AUTOMAGIK_SUPERVISOR_VERSION
  if (!isId(bootId) || !isVersion(version)) return null
  return { bootId, version }
}

function runView(run) {
  if (run === null) return null
  const { bootId, ...view } = run
  return view
}

function statusOf(profileDir, env, inDesktop) {
  const supervisor = supervisorOf(env)
  const bootId = env?.AUTOMAGIK_SUPERVISOR_BOOT
  const storeDir = usableStore(profileDir)
  const reason = inDesktop ? 'desktop-app' : supervisor === null ? 'no-supervisor' : storeDir === undefined ? 'no-store' : null
  const status = readSelfUpdate({ storeDir, bootId: isId(bootId) ? bootId : undefined })
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
