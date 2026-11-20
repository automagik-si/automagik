import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { isDeepStrictEqual } from 'node:util'
import { isLaneVersion, PLUGINS } from './release.js'
import { ARCHIVE, laneEntries, lockPins, sourceMatches, VENDOR, withLaneEntries } from './stage.js'
import { directory, identity, regularBytes, syncDirectory, writeBytesAtomic } from './store.js'

const MOVE_MODULES = 'install-modules'
const STEPS = ['keep-lockfile', 'install-lockfile', 'install-entries', MOVE_MODULES]
const MANIFEST = 'package.json'
const LOCKFILE = 'pnpm-lock.yaml'
const MODULES = 'node_modules'
const VENDOR_STEP = 'keep-archive:'
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

function homePath(value, fallback) {
  const path = value?.trim() || fallback
  return resolve(path === '~' ? homedir() : /^~[\\/]/.test(path) ? join(homedir(), path.slice(2)) : path)
}

export const DATA_FILES = Object.freeze([Object.freeze({
  path: env => join(homePath(env.AUTOMAGIK_BOTS_HOME, join(homePath(env.AUTOMAGIK_HOME, join(homedir(), '.automagik')), 'bots')), 'state.json'),
  snapshot: 'bots-state.json',
})])

function snapshot(kept, env) {
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
    files.push({ path: source, snapshot, format })
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

  const keep = `versions/${run.from}`
  const kept = join(directory(join(store, 'versions')), run.from)
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

  const before = JSON.parse(regularBytes(join(staging.source, MANIFEST)))
  const after = JSON.parse(regularBytes(join(staging.profileDir, MANIFEST)))
  const { names } = run
  const entries = laneEntries(before, names)
  writeBytesAtomic(join(kept, 'entries.json'), jsonBytes({ version: 1, dependencies: entries }), { durable: true })
  writeBytesAtomic(join(staging.source, 'candidate.json'), jsonBytes(withLaneEntries(before, laneEntries(after, names))), { durable: true })
  snapshot(kept, env)
  syncDirectory(join(store, 'versions'))
  syncDirectory(staging.root)
  syncDirectory(store)
  return {
    op: 'switch', from: run.from, to: run.to, keep, lockHash: digest(candidateLock),
    steps: ['keep-modules', ...vendor.map(name => `${VENDOR_STEP}${name}`), ...STEPS],
    done: [], pending: null,
  }
}

export function validJournal(run) {
  const { journal: j } = run
  if (j?.op !== 'switch' || !isLaneVersion(j.from) || !isLaneVersion(j.to) || j.from === j.to
    || j.from !== run.from || j.to !== run.to || j.keep !== `versions/${j.from}`
    || typeof j.lockHash !== 'string' || !/^[0-9a-f]{64}$/.test(j.lockHash)
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
    && (j.undoReason === undefined || ['stage-failed', 'supervisor-restarted'].includes(j.undoReason))
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

function rename(from, to, allowMissing) {
  const source = identity(from)
  const target = identity(to)
  if (source && !target) fs.renameSync(from, to)
  else if (source || (!target && !allowMissing)) throw new Error('Inconsistent switch rename')
  for (const parent of new Set([dirname(from), dirname(to)])) syncDirectory(parent)
}

function apply(config, staging, journal, paths, step, undo) {
  if (step === 'install-entries') {
    const old = regularBytes(join(staging.source, MANIFEST))
    const candidate = regularBytes(join(staging.source, 'candidate.json'))
    const live = join(config.profileDir, MANIFEST)
    const bytes = regularBytes(live, { optional: true })
    if (bytes?.equals(undo ? old : candidate)) return
    if (!bytes?.equals(undo ? candidate : old)) {
      // A failed DSH relink may have reconciled the manifest before reporting failure.
      if (!undo || !journal.relinking || !bytes) throw new Error('Profile entries changed during the switch')
      const { dependencies } = JSON.parse(regularBytes(join(config.store, journal.keep, 'entries.json')))
      const restored = withLaneEntries(JSON.parse(bytes), dependencies)
      if (!isDeepStrictEqual(restored, JSON.parse(old))) throw new Error('Unrelated profile entries changed during relink')
    }
    writeBytesAtomic(live, undo ? old : candidate, { durable: true })
    return
  }
  const [from, to] = paths[step]
  if (!undo) rename(from, to, false)
  else rename(to, from, journal.relinking && [MOVE_MODULES, 'install-lockfile'].includes(step))
}

export function completeSwitch(config, staging, run, save, afterRename = () => {}) {
  if (!validJournal(run) || run.journal.undo) throw new Error('Invalid forward journal')
  const j = run.journal
  const paths = pathsFor(config, staging, j)
  for (const step of j.steps.slice(j.done.length)) {
    j.pending = step
    save()
    apply(config, staging, j, paths, step, false)
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

export function undoSwitch(config, staging, run, save, reason) {
  if (!validJournal(run)) throw new Error('Invalid undo journal')
  const j = run.journal
  j.undo = true
  j.undoReason ??= reason
  save()
  const paths = pathsFor(config, staging, j)
  for (const step of [j.pending, ...j.done.toReversed()].filter(Boolean)) {
    apply(config, staging, j, paths, step, true)
    if (j.pending === step) j.pending = null
    else j.done.pop()
    save()
  }
}

export function candidateMatches(config, staging, run) {
  const manifest = regularBytes(join(config.profileDir, MANIFEST))
  const lock = regularBytes(join(config.profileDir, LOCKFILE))
  return manifest.equals(regularBytes(join(staging.source, 'candidate.json'))) && digest(lock) === run.journal.lockHash
}
