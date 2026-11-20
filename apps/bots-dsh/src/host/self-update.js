import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, normalize } from 'node:path'
import { inDesktopApp } from './constants.js'
import { cleanVersion } from './update.js'

const RUNNING = new Set(['checking', 'downloading', 'verifying', 'staging', 'switching', 'restarting', 'health', 'rollingBack'])
const TERMINAL = new Set(['healthy', 'rolledBack', 'notUpdated', 'manualRecovery'])
const BOOT_ID = /^[A-Za-z0-9_-]{8,64}$/
const ISO_TIMESTAMP = /^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/
const hasPathSeparator = value => /[/\\]/.test(value)
const isLabel = value => typeof value === 'string' && !hasPathSeparator(value)
const isNullableLabel = value => value === null || isLabel(value)
const isNullableString = value => value === null || typeof value === 'string'

export function storeDirOf(profileDir) {
  if (typeof profileDir !== 'string') return undefined
  const profile = normalize(profileDir)
  const profiles = dirname(profile)
  if (basename(profiles) !== 'profiles') return undefined
  return join(dirname(profiles), 'update', basename(profile))
}

// The supervisor owns these writes. Use a unique temp in the destination directory
// so polling sees either the previous file or the complete replacement.
export function writeJsonAtomic(path, value) {
  const json = JSON.stringify(value)
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
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

function runOf(value) {
  if (value?.version !== 1) return null
  const { runId, bootId, phase, from, to, reason, startedAt, updatedAt } = value
  if (!isLabel(runId) || !isLabel(bootId) || (!RUNNING.has(phase) && !TERMINAL.has(phase))
    || !isNullableLabel(from) || !isNullableLabel(to) || !isNullableString(reason)
    || !isTimestamp(startedAt) || !isTimestamp(updatedAt)) return null
  // A supervisor diagnostic can carry a local path in its free-form reason.
  return { version: 1, runId, bootId, phase, from, to,
    reason: reason !== null && hasPathSeparator(reason) ? null : reason, startedAt, updatedAt }
}

function readJson(storeDir, file, parse) {
  if (storeDir === undefined) return { value: null, problem: null }
  let source
  try {
    source = readFileSync(join(storeDir, file), 'utf8')
  } catch (error) {
    return { value: null, problem: error.code === 'ENOENT' ? null : `Could not read ${file}` }
  }
  try {
    const value = parse(JSON.parse(source))
    if (value !== null) return { value, problem: null }
  } catch {}
  return { value: null, problem: `Invalid ${file}` }
}

export function readSelfUpdate({ storeDir, bootId }) {
  const { value: current, problem: currentProblem } = readJson(storeDir, 'current.json', currentOf)
  const { value: run, problem: runProblem } = readJson(storeDir, 'state.json', runOf)
  const stale = run !== null && RUNNING.has(run.phase) && run.bootId !== bootId
  return {
    current,
    run: stale ? null : run,
    staleRun: stale ? { runId: run.runId, phase: run.phase } : null,
    problem: [currentProblem, runProblem].filter(Boolean).join('. ') || null,
  }
}

export function supervisorOf(env = process.env) {
  const bootId = env?.AUTOMAGIK_SUPERVISOR_BOOT
  const version = env?.AUTOMAGIK_SUPERVISOR_VERSION
  if (typeof bootId !== 'string' || !BOOT_ID.test(bootId)
    || typeof version !== 'string' || version.trim() !== version || cleanVersion(version) === null) return null
  return { bootId, version }
}

function runView(run, liveBootId) {
  if (run === null) return null
  const { bootId, ...view } = run
  if (view.reason !== null && [bootId, liveBootId].some(id => id && view.reason.includes(id))) view.reason = null
  return view
}

function statusOf(profileDir, supervisor, inDesktop) {
  const storeDir = storeDirOf(profileDir)
  const reason = inDesktop ? 'desktop-app' : supervisor === null ? 'no-supervisor' : storeDir === undefined ? 'no-store' : null
  const status = readSelfUpdate({ storeDir, bootId: supervisor?.bootId })
  return {
    available: reason === null,
    reason,
    supervisor: supervisor === null ? null : { version: supervisor.version },
    ...status,
    run: runView(status.run, supervisor?.bootId),
  }
}

export function selfUpdateStatus({ profileDir, env, inDesktop = inDesktopApp() }) {
  return statusOf(profileDir, supervisorOf(env), inDesktop)
}

export function install(rt) {
  const supervisor = supervisorOf()
  const inDesktop = inDesktopApp()
  rt.selfUpdateStatus = () => statusOf(rt.ctx.get?.('profileContext')?.dir, supervisor, inDesktop)
}
