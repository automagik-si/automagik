import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { isDeepStrictEqual } from 'node:util'
import { isId } from './records.js'
import { isLaneVersion, PLUGINS } from './release.js'
import { ARCHIVE, equalFile, laneEntries, lockPins, PROFILE_INPUTS, sourceMatches, VENDOR, withLaneEntries } from './stage.js'
import { directory, identity, regularBytes, syncDirectory, syncFile, writeBytesAtomic } from './store.js'

const MOVE_MODULES = 'install-modules'
const STEPS = ['keep-lockfile', 'install-lockfile', 'install-entries', MOVE_MODULES]
const MANIFEST = 'package.json'
const LOCKFILE = 'pnpm-lock.yaml'
const MODULES = 'node_modules'
const VENDOR_STEP = 'keep-archive:'
const HARMLESS_KEYS = ['dsh']
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n')
export const digest = bytes => createHash('sha256').update(bytes).digest('hex')

function homePath(value, fallback) {
  const path = value?.trim() || fallback
  return resolve(path === '~' ? homedir() : /^~[\\/]/.test(path) ? join(homedir(), path.slice(2)) : path)
}

export const DATA_FILES = Object.freeze([Object.freeze({
  path: env => join(homePath(env.AUTOMAGIK_BOTS_HOME, join(homePath(env.AUTOMAGIK_HOME, join(homedir(), '.automagik')), 'bots')), 'state.json'),
  snapshot: 'bots-state.json',
})])

function snapshot(kept, env, reads) {
  const data = directory(join(kept, 'data'))
  const files = []
  for (const { path, snapshot } of DATA_FILES) {
    const source = path(env)
    const bytes = regularBytes(source, { optional: true })
    if (bytes === undefined) continue
    const document = JSON.parse(bytes)
    const format = document?.version === undefined ? 0 : document.version
    if (!document || typeof document !== 'object' || Array.isArray(document)
      || !Number.isSafeInteger(format) || format < 0) throw new Error('Invalid Bots state format')
    writeBytesAtomic(join(data, snapshot), bytes, { durable: true })
    files.push({ path: source, snapshot, format, ...(reads ? { reads } : {}) })
  }
  writeBytesAtomic(join(kept, 'data.json'), jsonBytes({ version: 1, files }), { durable: true })
}

export function planSwitch(config, staging, run) {
  const { store, profileDir, env } = config
  // A disappeared input counts as a change even when it was mandatory during staging.
  try {
    if (!sourceMatches(profileDir, staging.source)) return null
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ELOOP') return null
    throw error
  }

  const keep = keepPath(run)
  const parent = directory(join(store, dirname(keep)))
  const kept = join(store, keep)
  // A cut before publishing a journal can leave preparation metadata, but never a moved lock or module tree.
  if (identity(join(kept, LOCKFILE)) || identity(join(kept, MODULES))) throw new Error('Previous version already kept')
  directory(kept)
  directory(join(kept, 'vendor'))

  const sourceLock = regularBytes(join(staging.source, LOCKFILE)).toString()
  const candidateLock = regularBytes(join(staging.profileDir, LOCKFILE))
  const oldPins = lockPins(sourceLock)
  const newPins = lockPins(candidateLock.toString())
  const vendor = fs.readdirSync(join(profileDir, VENDOR), { withFileTypes: true })
    .filter(entry => entry.isFile() && ARCHIVE.test(entry.name))
    .map(entry => entry.name).sort()
    .filter(name => oldPins.has(`${VENDOR}/${name}`) && !newPins.has(`${VENDOR}/${name}`))

  const sourceManifest = regularBytes(join(staging.source, MANIFEST))
  const before = JSON.parse(sourceManifest)
  const after = JSON.parse(regularBytes(join(staging.profileDir, MANIFEST)))
  const { names } = run
  const entries = laneEntries(before, names)
  writeBytesAtomic(join(kept, 'entries.json'), jsonBytes({ version: 1, dependencies: entries }), { durable: true })
  const candidateManifest = jsonBytes(withLaneEntries(before, laneEntries(after, names)))
  writeBytesAtomic(join(staging.source, 'candidate.json'), candidateManifest, { durable: true })
  snapshot(kept, env, config.stateFormats)
  for (const file of [MANIFEST, LOCKFILE]) {
    syncFile(join(staging.source, file))
    syncFile(join(profileDir, file))
  }
  syncFile(join(staging.profileDir, LOCKFILE))
  for (const dir of [join(profileDir, VENDOR), profileDir, join(kept, 'vendor'), kept, parent,
    staging.source, staging.profileDir, dirname(staging.profileDir), staging.root, store]) syncDirectory(dir)

  const journal = {
    op: 'switch', from: run.from, to: run.to, keep, lockHash: digest(candidateLock),
    ...(run.reinstall === true ? { reinstall: true } : {}),
    sourceHash: digest(sourceManifest), candidateHash: digest(candidateManifest),
    steps: ['keep-modules', ...vendor.map(name => `${VENDOR_STEP}${name}`), ...STEPS],
    done: [], pending: null,
  }
  verifyRecoveryInputs(staging, journal)
  if (!sourceMatches(profileDir, staging.source)
    || digest(regularBytes(join(staging.profileDir, LOCKFILE))) !== journal.lockHash) {
    throw new Error('Switch inputs changed during preparation')
  }
  return journal
}

const isHash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

function verifyRecoveryInputs(staging, journal) {
  const source = regularBytes(join(staging.source, MANIFEST))
  const candidate = regularBytes(join(staging.source, 'candidate.json'))
  // Older journals carry no manifest digests.
  if (journal.sourceHash !== undefined && (digest(source) !== journal.sourceHash || digest(candidate) !== journal.candidateHash)) {
    throw new Error('Switch recovery inputs changed')
  }
}

function keepPath(run) {
  if (run.reinstall !== true) return `versions/${run.from}`
  if (!isId(run.runId) || run.from !== run.to) throw new Error('Invalid reinstall run')
  return `reinstall/${run.runId}`
}

export function validJournal(run) {
  const { journal: j } = run
  const reinstall = run.reinstall === true
  if (j?.op !== 'switch' || !isLaneVersion(j.from) || !isLaneVersion(j.to) || (j.from === j.to) !== reinstall
    || (reinstall ? j.reinstall !== true || !isId(run.runId) : j.reinstall !== undefined)
    || j.from !== run.from || j.to !== run.to || j.keep !== keepPath(run)
    || !isHash(j.lockHash) || (j.rollbackManifestHash !== undefined && !isHash(j.rollbackManifestHash))
    || ((j.sourceHash !== undefined || j.candidateHash !== undefined) && (!isHash(j.sourceHash) || !isHash(j.candidateHash)))
    || !Array.isArray(run.names) || run.names.length === 0 || new Set(run.names).size !== run.names.length
    || !run.names.every(name => PLUGINS.includes(name))
    || !Array.isArray(j.steps) || !Array.isArray(j.done)
    || j.steps[0] !== 'keep-modules' || new Set(j.steps).size !== j.steps.length
    || !STEPS.every((step, index) => j.steps.at(j.steps.length - STEPS.length + index) === step)
    || !j.steps.slice(1, -STEPS.length).every(step => typeof step === 'string' && step.startsWith(VENDOR_STEP)
      && ARCHIVE.test(step.slice(VENDOR_STEP.length)))
    || j.done.length > j.steps.length || !j.done.every((step, index) => step === j.steps[index])
    || (j.pending !== null && (typeof j.pending !== 'string' || j.pending !== j.steps[j.done.length]))) return false
  return (j.undo === undefined || j.undo === true)
    && (j.relinking === undefined || j.relinking === true)
    && (j.relinked === undefined || (reinstall && j.relinked === true && j.relinking === true))
    && (j.commitCurrent === undefined || (j.commitCurrent === true && !j.undo && j.pending === null && j.done.length === j.steps.length))
    && (j.undoReason === undefined || ['stage-failed', 'supervisor-restarted', 'health-failed'].includes(j.undoReason))
}

export function validTerminalJournal(run) {
  if (!validJournal(run) || run.journal.pending !== null) return false
  const { undo, done, steps } = run.journal
  return run.phase === 'healthy'
    ? !undo && done.length === steps.length && (run.reinstall !== true || run.journal.relinked === true)
    : undo === true && done.length === 0
}

// Only a durable, disposable verdict may move a backup into the cleanup directory.
export function trashReinstall(store, run) {
  if (run.reinstall !== true || !['healthy', 'rolledBack', 'notUpdated'].includes(run.phase)
    || !validTerminalJournal(run)) throw new Error('Invalid reinstall cleanup verdict')
  const source = join(store, keepPath(run))
  const parent = dirname(source)
  if (!identity(parent)) return
  directory(parent)
  if (!identity(source)) return
  directory(source)
  const trash = directory(join(store, 'reinstall-trash'))
  const destination = join(trash, run.runId)
  if (identity(destination)) throw new Error('Reinstall trash already exists')
  syncDirectory(store)
  fs.renameSync(source, destination)
  syncDirectory(trash)
  syncDirectory(parent)
}

export function sweepReinstallTrash(store) {
  const trash = join(store, 'reinstall-trash')
  if (!identity(trash)) return
  directory(trash)
  const parent = join(store, 'reinstall')
  syncDirectory(store)
  syncDirectory(trash)
  if (identity(parent)) syncDirectory(directory(parent))
  // Sync before unlinking so even a previous interruption immediately after rename is safe.
  for (const entry of fs.readdirSync(trash)) fs.rmSync(join(trash, entry), { recursive: true, force: true })
}

function pathsFor(config, staging, journal) {
  const kept = join(config.store, journal.keep)
  const live = config.profileDir
  const next = staging.profileDir
  return {
    'keep-modules': [join(live, MODULES), join(kept, MODULES)],
    'keep-lockfile': [join(live, LOCKFILE), join(kept, LOCKFILE)],
    'install-lockfile': [join(next, LOCKFILE), join(live, LOCKFILE)],
    [MOVE_MODULES]: [join(next, MODULES), join(live, MODULES)],
    ...Object.fromEntries(journal.steps.filter(step => step.startsWith(VENDOR_STEP)).map(step => {
      const archive = step.slice(VENDOR_STEP.length)
      return [step, [join(live, VENDOR, archive), join(kept, 'vendor', archive)]]
    })),
  }
}

function needsRename(source, target, allowMissing) {
  if (source && !target) return true
  if (source || (!target && !allowMissing)) throw new Error('Inconsistent switch rename')
  return false
}

function rename(from, to, allowMissing) {
  if (needsRename(identity(from), identity(to), allowMissing)) fs.renameSync(from, to)
  for (const parent of new Set([dirname(from), dirname(to)])) syncDirectory(parent)
}

function manifestWrite(config, staging, journal, undo) {
  const old = regularBytes(join(staging.source, MANIFEST))
  const candidate = regularBytes(join(staging.source, 'candidate.json'))
  const live = join(config.profileDir, MANIFEST)
  const bytes = regularBytes(live, { optional: true })
  const previousEntries = () => JSON.parse(regularBytes(join(config.store, journal.keep, 'entries.json'))).dependencies
  if (undo && journal.undoReason === 'health-failed') {
    const restored = regularBytes(join(staging.source, 'rollback.json'))
    if (digest(restored) !== journal.rollbackManifestHash) throw new Error('Rollback manifest changed')
    if (bytes?.equals(restored)) return
    if (!bytes || !isDeepStrictEqual(withLaneEntries(JSON.parse(bytes), previousEntries()), JSON.parse(restored))) {
      throw new Error('Profile entries changed after rollback was prepared')
    }
    return restored
  }
  if (bytes?.equals(undo ? old : candidate)) return
  if (!bytes?.equals(undo ? candidate : old)) {
    // A failed DSH relink may have reconciled the manifest before reporting failure.
    if (!undo || !journal.relinking || !bytes) throw new Error('Profile entries changed during the switch')
    const restored = withLaneEntries(JSON.parse(bytes), previousEntries())
    if (!isDeepStrictEqual(restored, JSON.parse(old))) throw new Error('Unrelated profile entries changed during relink')
  }
  return undo ? old : candidate
}

const allowAbsent = (journal, step) => journal.relinking && [MOVE_MODULES, 'install-lockfile'].includes(step)

function apply(config, staging, journal, paths, step) {
  if (step === 'install-entries') {
    const bytes = manifestWrite(config, staging, journal, false)
    if (bytes) writeBytesAtomic(join(config.profileDir, MANIFEST), bytes, { durable: true })
    return
  }
  const [from, to] = paths[step]
  rename(from, to, false)
}

export class UndoIOError extends Error {}

export class UndoPreflightError extends Error {
  constructor(cause) {
    super(cause.message, { cause })
  }
}

function prepareUndo(config, staging, journal, paths, steps) {
  let manifest
  // Simulate the reverse order. A later move can use a path vacated by an earlier one.
  const planned = new Map()
  const at = path => planned.has(path) ? planned.get(path) : identity(path)
  for (const step of steps) {
    if (step === 'install-entries') {
      manifest = manifestWrite(config, staging, journal, true)
      continue
    }
    const [to, from] = paths[step]
    const source = at(from)
    const fromDir = identity(dirname(from))
    const toDir = identity(dirname(to))
    if (!fromDir?.isDirectory() || !toDir?.isDirectory()) throw new Error('Missing switch rename directory')
    if (needsRename(source, at(to), allowAbsent(journal, step))) {
      if (source.dev !== toDir.dev) throw new Error('Switch rename crosses filesystems')
      planned.set(from, undefined)
      planned.set(to, source)
    }
  }
  return manifest
}

export function completeSwitch(config, staging, run, save, afterRename = () => {}) {
  if (!validJournal(run) || run.journal.undo) throw new Error('Invalid forward journal')
  const j = run.journal
  verifyRecoveryInputs(staging, j)
  const paths = pathsFor(config, staging, j)
  for (const step of j.steps.slice(j.done.length)) {
    j.pending = step
    save()
    apply(config, staging, j, paths, step)
    afterRename(step)
    j.done.push(step)
    j.pending = null
    save()
  }
}

export function didSwitch(config, staging, run) {
  if (!validJournal(run)) throw new Error('Invalid switch journal')
  const { journal } = run
  return !journal.undo && (journal.done.includes(MOVE_MODULES) || (journal.pending === MOVE_MODULES
    && !identity(join(staging.profileDir, MODULES)) && !!identity(join(config.profileDir, MODULES))))
}

export function undoSwitch(config, staging, run, save, reason, afterRename = () => {}, beforeUndo = () => {}) {
  if (!validJournal(run) || run.journal.commitCurrent) throw new Error('Invalid undo journal')
  const j = run.journal
  const steps = [j.pending, ...j.done.toReversed()].filter(Boolean)
  const paths = pathsFor(config, staging, j)
  const undoReason = j.undoReason ?? reason
  let manifest
  try {
    if (steps.length > 0) verifyRecoveryInputs(staging, j)
    manifest = prepareUndo(config, staging, { ...j, undoReason }, paths, steps)
  } catch (error) {
    throw new UndoPreflightError(error)
  }
  beforeUndo()
  if (!j.undo || j.undoReason === undefined) {
    j.undo = true
    j.undoReason = undoReason
    save()
  }
  for (const step of steps) {
    try {
      if (step === 'install-entries') {
        if (manifest) writeBytesAtomic(join(config.profileDir, MANIFEST), manifest, { durable: true })
        else syncDirectory(config.profileDir)
      } else {
        const [to, from] = paths[step]
        rename(from, to, allowAbsent(j, step))
      }
      afterRename(step)
      if (j.pending === step) j.pending = null
      else j.done.pop()
      save()
    } catch (cause) {
      throw new UndoIOError(cause.message, { cause })
    }
  }
}

export function sameInstallerManifest(a, b) {
  const installerEntries = manifest => Object.entries(manifest).filter(([key]) => !HARMLESS_KEYS.includes(key))
  return isDeepStrictEqual(Object.fromEntries(installerEntries(a)), Object.fromEntries(installerEntries(b)))
}

export function candidateMatches(config, staging, run) {
  try {
    verifyRecoveryInputs(staging, run.journal)
    const manifest = JSON.parse(regularBytes(join(config.profileDir, MANIFEST)))
    const candidate = JSON.parse(regularBytes(join(staging.source, 'candidate.json')))
    const lock = regularBytes(join(config.profileDir, LOCKFILE))
    return sameInstallerManifest(manifest, candidate) && digest(lock) === run.journal.lockHash
      && PROFILE_INPUTS.slice(2).every(file => equalFile(config.profileDir, staging.source, file))
  } catch {
    return false
  }
}
