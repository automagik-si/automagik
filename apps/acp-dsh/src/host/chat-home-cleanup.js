// Fresh chat sign-in replaces a home only after a confirmed login. Keep the exact
// old directory and the evidence needed to remove it outside either vendor home.
import { randomUUID } from 'node:crypto'
import {
  closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { unverifiedLogin } from './login-ownership.js'
import { processState, validBirth } from './process-identity.js'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const number = /^\d{1,24}$/
const pid = value => Number.isSafeInteger(value) && value > 1
const directoryId = value => typeof value?.dev === 'string' && number.test(value.dev)
  && typeof value?.ino === 'string' && number.test(value.ino)
const validRun = run => pid(run?.group) && Array.isArray(run.detached)
  && run.detached.every(child => pid(child?.pid) && validBirth(child.birth))
const recordLimit = 256 * 1024

const cleanupPath = (root, vendor) => join(root, 'current', `${vendor}.chat-cleanup.json`)

function syncDirectory(path) {
  if (process.platform === 'win32') return
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function checkParent(root, path) {
  const parent = dirname(path)
  if (realpathSync(parent) !== join(realpathSync(root), relative(root, parent))) throw unverifiedLogin()
}

export function ownedDirectory(root, path) {
  checkParent(root, path)
  const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false })
  if (!stat) return undefined
  if (!stat.isDirectory()) throw unverifiedLogin()
  return { dev: String(stat.dev), ino: String(stat.ino) }
}

export function checkDirectory(root, path, expected, { missing = false } = {}) {
  const actual = ownedDirectory(root, path)
  if (!actual && missing) return false
  if (!actual || actual.dev !== expected.dev || actual.ino !== expected.ino) throw unverifiedLogin()
  return true
}

export function readChatCleanup(root, vendor) {
  const path = cleanupPath(root, vendor)
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat) return undefined
  checkParent(root, path)
  if (!stat.isFile() || stat.size > recordLimit) throw unverifiedLogin()
  const data = readFileSync(path, 'utf8')
  if (Buffer.byteLength(data) > recordLimit) throw unverifiedLogin()
  let entry
  try { entry = JSON.parse(data) } catch { throw unverifiedLogin() }
  if (entry?.version !== 1 || entry.vendor !== vendor || typeof entry.replacement !== 'string' || !uuid.test(entry.replacement)
    || typeof entry.previous !== 'string' || (entry.previous !== 'legacy' && !uuid.test(entry.previous))
    || entry.previous === entry.replacement || !directoryId(entry.old) || !directoryId(entry.adopted)
    || !pid(entry.owner?.pid) || !(entry.owner.birth === null || validBirth(entry.owner.birth))
    || typeof entry.stopped !== 'boolean' || !(entry.runs === null || (Array.isArray(entry.runs) && entry.runs.every(validRun)))) {
    throw unverifiedLogin()
  }
  return entry
}

export function writeChatCleanup(root, vendor, entry) {
  const path = cleanupPath(root, vendor)
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  checkParent(root, path)
  syncDirectory(root)
  const bytes = JSON.stringify(entry)
  if (Buffer.byteLength(bytes) > recordLimit) throw unverifiedLogin()
  const next = `${path}.${randomUUID()}`
  const fd = openSync(next, 'wx', 0o600)
  try {
    try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(next, path)
    syncDirectory(directory)
  } finally { rmSync(next, { force: true }) }
}

export function completeChatCleanup(root, vendor) {
  const path = cleanupPath(root, vendor)
  checkParent(root, path)
  rmSync(path, { force: true })
  syncDirectory(dirname(path))
}

export function removeChatHome(root, home, expected, marker, verify) {
  if (checkDirectory(root, home, expected, { missing: true })) {
    verify()
    checkDirectory(root, home, expected)
    rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
  syncDirectory(dirname(home))
  checkParent(root, marker)
  rmSync(marker, { force: true })
  syncDirectory(dirname(marker))
}

// An exited app is not proof that its detached processes exited. A completed stop
// is recorded before the first removal. Otherwise Unix recovery checks each owned
// process group and each detached descendant captured at teardown, without signalling it.
export function oldChatRunsExited(entry, birth) {
  if (entry.stopped) return true
  const before = entry.owner.birth
  if (before?.platform === 'linux' && birth?.platform === 'linux' && before.boot !== birth.boot) return true
  return entry.runs?.every(run => {
    try { process.kill(-run.group, 0); return false } catch (error) { if (error.code !== 'ESRCH') return false }
    return run.detached.every(child => processState(child.pid, child.birth) === 'dead')
  }) === true
}
