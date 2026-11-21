// A dead app does not prove its detached login tree has stopped. Persist before spawn;
// an interrupted/unknown launch stays blocked rather than guessing which processes to kill.
import { randomUUID } from 'node:crypto'
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { validBirth } from './process-identity.js'
import { WINDOWS_JOB_PROBE_TIMEOUT_MS, windowsLoginEnded } from './windows-job-probe.js'
import { WINDOWS_LOGIN_ID, validWindowsStart, windowsJobName } from './windows-login.js'

export const LOGIN_OWNER_ENV = 'AUTOMAGIK_BOT_CLI_OWNER'
export const LOGIN_RECORD_VERSION = 'login-trees-v1'
const blocked = () => Object.assign(new Error(
  'Cannot verify that a previous Bot sign-in stopped. Account changes remain blocked. '
  + 'Use Reset Bot sign-in in Bot settings to start fresh.',
), { code: 'acp-account/unverified-login' })

export function recordLogin(env, { id = randomUUID(), job, appBirth = null } = {}) {
  const home = env.AUTOMAGIK_BOT_CLI_HOME
  if (!home) return
  const directory = join(home, 'login-trees')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const file = join(directory, id)
  const record = { owner: env[LOGIN_OWNER_ENV], app: process.pid, appBirth, kind: 'starting',
    ...(job ? { job } : {}) }
  const update = identity => {
    const next = `${file}.next`
    writeFileSync(next, JSON.stringify({ ...record, ...identity }), { mode: 0o600 })
    renameSync(next, file)
  }
  update({})
  return { id, update, clear: () => {
    rmSync(file, { force: true })
    rmSync(`${file}.next`, { force: true })
  } }
}

export function verifyLoginRecords(home, owner) {
  const directory = join(home, 'login-trees')
  if (!existsSync(directory)) return
  for (const name of readdirSync(directory)) {
    const file = join(directory, name)
    let record
    try { record = JSON.parse(readFileSync(file, 'utf8')) } catch { throw blocked() }
    if (!record || typeof record !== 'object') throw blocked()
    // The current instance's in-memory controller is drained by sign-out/new login.
    if (record.owner === owner && record.app === process.pid) continue
    let proved = false
    if (record.kind === 'unix' && process.platform !== 'win32'
      && Number.isInteger(record.group) && record.group > 1) {
      try { process.kill(-record.group, 0) } catch (error) {
        proved = error.code === 'ESRCH'
      }
    }
    // Foreign Windows records can be removed only by reclaimWindowsLogins with Job proof.
    if (!proved) throw blocked()
    // A Unix PID/group that has been reused blocks recovery; never signal an uncertain PID.
    rmSync(file, { force: true })
  }
}

const validPid = pid => Number.isSafeInteger(pid) && pid > 1
const sameFile = ({ dev, ino }) => ({ dev, ino })

// A missing publication has meaning. Any other read error or malformed entry blocks proof.
function evidenceAt(path) {
  let stat
  try { stat = lstatSync(path) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  if (!stat.isFile() || stat.size > 4096) throw blocked()
  const bytes = readFileSync(path)
  if (bytes.length > 4096) throw blocked()
  const record = JSON.parse(bytes.toString('utf8'))
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw blocked()
  return { ...sameFile(stat), bytes, record }
}

function windowsEvidence(file, control, id, owner) {
  const base = evidenceAt(file)
  const next = evidenceAt(`${file}.next`)
  if (!base) return null
  const record = next?.record ?? base.record
  if (next && (base.record.kind !== 'starting' || Object.hasOwn(base.record, 'supervisor')
    || !isDeepStrictEqual(record, { ...base.record, kind: 'windows', supervisor: record.supervisor }))) return null
  const { app, appBirth, supervisor, job } = record
  if (record.kind !== 'windows' || job !== windowsJobName(id) || !validPid(app)
    || !validPid(supervisor) || typeof record.owner !== 'string'
    || !/^\d+-[a-f0-9-]+$/.test(record.owner) || Number(record.owner.split('-')[0]) !== app
    || record.owner === owner || (appBirth === null ? app === process.pid
      : !(validBirth(appBirth) && appBirth.platform === 'win32'))) return null

  const directory = lstatSync(control)
  if (!directory.isDirectory()) return null
  const identity = evidenceAt(join(control, 'supervisor'))
  if (identity && (identity.record.pid !== supervisor || identity.record.launch !== id
      || !validWindowsStart(identity.record.start))) return null
  const members = evidenceAt(join(control, 'members'))
  const entries = members ? members.record.processes : []
  if (members && (members.record.launch !== id || Object.hasOwn(members.record, 'overflow')
      || !Array.isArray(entries) || entries.length > 64
      || entries.some(entry => !validPid(entry?.pid)
        || (entry.start !== null && !validWindowsStart(entry.start))))) return null
  return { base, next, directory: sameFile(directory), identity, members }
}

function pidGone(pid) {
  try { process.kill(pid, 0) } catch (error) { return error.code === 'ESRCH' }
  return false
}

export async function reclaimWindowsLogins({ home, owner, controlRoot, probe, commit }) {
  const directory = join(home, 'login-trees')
  let names
  try { names = readdirSync(directory) } catch { return 0 }
  const ids = new Set(names.map(name => name.endsWith('.next') ? name.slice(0, -5) : name))
  const deadline = performance.now() + WINDOWS_JOB_PROBE_TIMEOUT_MS
  let removed = 0
  for (const id of ids) {
    if (!WINDOWS_LOGIN_ID.test(id)) continue
    const file = join(directory, id)
    const control = join(controlRoot, id)
    try {
      const evidence = windowsEvidence(file, control, id, owner)
      if (!evidence) continue
      const { app, appBirth, supervisor, job } = evidence.next?.record ?? evidence.base.record
      const supervisorStart = evidence.identity?.record.start ?? null
      if ((app !== process.pid && !pidGone(app) && appBirth === null)
        || (!pidGone(supervisor) && supervisorStart === null)) continue
      const processes = [{ pid: app, start: appBirth?.start ?? null },
        { pid: supervisor, start: supervisorStart }, ...(evidence.members?.record.processes ?? [])]
      const timeoutMs = Math.floor(deadline - performance.now())
      if (timeoutMs <= 0) break
      const result = await probe({ job, processes }, { timeoutMs })
      if (!windowsLoginEnded(result) || result.processes.length !== processes.length) continue
      if (commit(() => {
        if (!isDeepStrictEqual(evidence, windowsEvidence(file, control, id, owner))) return false
        rmSync(`${file}.next`, { force: true })
        rmSync(file, { force: true })
        for (const name of ['supervisor', 'supervisor.tmp', 'members', 'members.tmp', 'stop', 'done']) {
          try { rmSync(join(control, name), { force: true }) } catch {}
        }
        try { rmdirSync(control) } catch {}
        return true
      })) removed++
    } catch {}
  }
  return removed
}

export function unverifiedLogin() { return blocked() }
