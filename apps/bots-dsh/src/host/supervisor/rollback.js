import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { homeLock } from '../home-lock.js'
import { installedPlugins, PLUGINS } from './release.js'
import { assertRelinked, discardArchives, equalFile, PROFILE_INPUTS, takeProfileLock, VENDOR, withLaneEntries } from './stage.js'
import { directory, identity, regularBytes, syncDirectory, writeBytesAtomic } from './store.js'
import { DATA_FILES, digest, sameInstallerManifest, trashReinstall, UndoIOError, UndoPreflightError, undoSwitch } from './switch.js'

const BOTS = '@automagik/bots-dsh'
const CONTRACT = ['node_modules', BOTS, 'src/host/update-contract.json']
const HASH = /^[0-9a-f]{64}$/
const stamp = () => new Date().toISOString()
const json = bytes => JSON.parse(bytes)
const read = path => json(regularBytes(path))
const format = version => Number.isSafeInteger(version) && version >= 0
const formats = reads => Array.isArray(reads) && reads.length > 0 && reads.every(format)

export function updateContract(profileDir) {
  try {
    const value = read(join(profileDir, ...CONTRACT))
    if (value?.version === 1 && value.holdRun === true && formats(value.stateFormats)) return value
  } catch {}
  return null
}

export function baseline(profileDir) {
  try { return Object.fromEntries(installedPlugins(profileDir)) } catch { return null }
}

export function unpinnedPlugins(profileDir) {
  const versions = baseline(profileDir)
  const names = versions && Object.keys(versions).length ? Object.keys(versions) : PLUGINS
  return Object.fromEntries(names.map(name => [name, null]))
}

export function rollbackManifest(config, staging, run) {
  const { store, profileDir } = config
  const source = read(join(staging.source, 'package.json'))
  const live = read(join(profileDir, 'package.json'))
  const { dependencies } = read(join(store, run.journal.keep, 'entries.json'))
  const merged = withLaneEntries(live, dependencies)
  if (!sameInstallerManifest(merged, source)
    || !PROFILE_INPUTS.slice(2).every(file => equalFile(profileDir, staging.source, file))) {
    throw new Error('Profile installer inputs changed during the trial')
  }
  const bytes = Buffer.from(JSON.stringify(merged, null, 2) + '\n')
  writeBytesAtomic(join(staging.source, 'rollback.json'), bytes, { durable: true })
  return digest(bytes)
}

export function teamSnapshot(config, run) {
  const kept = join(config.store, run.journal.keep)
  const data = read(join(kept, 'data.json'))
  const allowed = DATA_FILES[0]
  if (data?.version !== 1 || !Array.isArray(data.files) || data.files.length > 1) throw new Error('Invalid team snapshot')
  const team = data.files[0]
  if (!team) return null
  if (team.snapshot !== allowed.snapshot || team.path !== allowed.path(config.env)
    || !format(team.format) || (team.reads !== undefined && !formats(team.reads))) throw new Error('Invalid team snapshot')
  const saved = join(kept, 'data', team.snapshot)
  const bytes = regularBytes(saved)
  const snapshot = teamDocument(bytes)
  const revision = snapshot?.revision ?? 0
  if (!snapshot || !Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid team snapshot revision')
  return { ...team, saved, revision, revisionless: snapshot.revision === undefined, snapshotHash: digest(bytes) }
}

function backupDir(store, run) {
  const root = directory(join(store, 'rollback-data'))
  const dir = directory(join(root, run.runId))
  for (const path of [store, root, dir]) syncDirectory(path)
  return dir
}

function archiveTeam(config, run, team) {
  const dir = backupDir(config.store, run)
  if (team) {
    const path = join(dir, team.snapshot)
    const snapshotHash = run.journal.restore?.snapshotHash ?? team.snapshotHash
    if (!sameHash(regularBytes(path, { optional: true }), snapshotHash)) {
      const snapshot = regularBytes(team.saved)
      if (!sameHash(snapshot, snapshotHash)) throw new Error('The saved team snapshot changed')
      writeBytesAtomic(path, snapshot, { durable: true })
    }
  }
  writeBytesAtomic(join(dir, 'data.json'), regularBytes(join(config.store, run.journal.keep, 'data.json')), { durable: true })
}

const sameHash = (bytes, hash) => (bytes === undefined ? null : digest(bytes)) === hash
const tried = (run, action) => [...new Set([...(run.rollback.tried ?? []), action])]
function teamDocument(bytes) {
  try {
    const value = json(bytes)
    if (value && typeof value === 'object' && !Array.isArray(value)) return value
  } catch {}
  return null
}

function teamLineage(team, bytes, document) {
  if (bytes === undefined) return 'lost'
  if (!document) return 'unknown'
  const revision = team.revisionless && document.revision === undefined ? 0 : document.revision
  return Number.isSafeInteger(revision) && revision >= team.revision ? 'descended' : 'lost'
}

export function liveTeamLineage(team) {
  try {
    const bytes = regularBytes(team.path, { optional: true })
    return teamLineage(team, bytes, teamDocument(bytes))
  } catch {
    return 'unknown'
  }
}
const dataOutcome = (run, save, data, journal = run.journal) => save({ journal, rollback: { ...run.rollback, data } })

export function restoreData(config, run, save, team = teamSnapshot(config, run)) {
  if (run.journal.restored || run.rollback.data !== undefined) return
  if (!team) return dataOutcome(run, save, null)
  const skip = why => dataOutcome(run, save, { restored: false, why, trialKept: false })
  const home = dirname(team.path)
  const created = fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  if (created) {
    for (let path = home; path !== created; path = dirname(path)) syncDirectory(dirname(path))
    syncDirectory(dirname(created))
  }
  const lock = homeLock(join(home, 'state.lock'))
  try {
    if (lock.claim() !== undefined || !lock.owns()) return skip('team-in-use')
    let trial
    try { trial = regularBytes(team.path, { optional: true }) } catch { return skip('unknown') }
    let intent = run.journal.restore
    if (intent === undefined) {
      const snapshot = regularBytes(team.saved)
      if (!sameHash(snapshot, team.snapshotHash)) return skip('snapshot-changed')
      const live = trial === undefined ? null : teamDocument(trial)
      const lineage = teamLineage(team, trial, live)
      const lost = lineage === 'lost' || run.rollback.teamMissing
      if (!lost) {
        const version = live && (live.version === undefined ? 0 : live.version)
        if (!format(version) || !team.reads) return skip('unknown')
        if (team.reads.includes(version)) return skip('same-format')
      }
      intent = { path: team.path, snapshot: team.snapshot, trialHash: trial === undefined ? null : digest(trial),
        snapshotHash: team.snapshotHash, ...(lost ? { why: 'team-lost' } : {}) }
      save({ journal: { ...run.journal, restore: intent }, rollback: { ...run.rollback, tried: tried(run, 'data-restore') } })
    }
    const { trialHash, snapshotHash, why } = intent
    if (intent.path !== team.path || intent.snapshot !== team.snapshot
      || (trialHash !== null && !HASH.test(trialHash)) || !HASH.test(snapshotHash)
      || (why !== undefined && why !== 'team-lost')) throw new Error('Invalid data restore journal')
    let trialKept = false
    const trialCopy = dir => join(dir, 'trial-' + team.snapshot)
    if (!sameHash(trial, snapshotHash)) {
      if (!sameHash(trial, trialHash)) return skip('superseded')
      const snapshot = regularBytes(team.saved)
      if (!sameHash(snapshot, snapshotHash)) return skip('snapshot-changed')
      if (trial !== undefined) {
        const path = trialCopy(backupDir(config.store, run))
        writeBytesAtomic(path, trial, { durable: true })
        if (!sameHash(regularBytes(path), trialHash)) throw new Error('The saved trial team did not match')
        trialKept = true
      }
      if (!lock.owns()) return skip('team-in-use')
      writeBytesAtomic(team.path, snapshot, { durable: true })
    } else if (trialHash !== null && trialHash !== snapshotHash) {
      trialKept = sameHash(regularBytes(trialCopy(join(config.store, 'rollback-data', run.runId)), { optional: true }), trialHash)
    }
    dataOutcome(run, save, { restored: true, trialKept, ...(why ? { why } : {}) }, { ...run.journal, restored: true })
  } finally {
    lock.release()
  }
}

export function rollbackLocation(config, staging, run) {
  const kept = join(config.store, run.journal.keep)
  const exists = (dir, file) => {
    try { return !!identity(join(dir, file)) } catch { return false }
  }
  const place = file => {
    const keptHere = exists(kept, file)
    const staged = exists(staging.profileDir, file)
    return {
      previous: keptHere ? 'kept' : exists(config.profileDir, file) ? 'live' : 'missing',
      candidate: staged ? 'staging' : keptHere && exists(config.profileDir, file) ? 'live' : 'missing',
    }
  }
  return { modules: place('node_modules'), lockfile: place('pnpm-lock.yaml') }
}

export function finishRolledBack(config, staging, run) {
  const kept = join(config.store, run.journal.keep)
  if (identity(join(kept, 'node_modules')) || identity(join(kept, 'pnpm-lock.yaml'))) {
    throw new Error('The previous profile has not been restored')
  }
  if (run.reinstall === true) trashReinstall(config.store, run)
  fs.rmSync(staging.root, { recursive: true, force: true })
  if (run.reinstall !== true) fs.rmSync(kept, { recursive: true, force: true })
}

export async function runRollback({ config, staging, run, save, signal, stop, restoreCurrent, start, health,
  manualRecovery, retry, afterRename, beforeVerdict = () => {} }) {
  const set = changes => save({ rollback: { ...run.rollback, ...changes } })
  const advance = (step, changes) => {
    signal.throwIfAborted()
    if (run.rollback.step !== step || changes) set({ step, ...changes })
  }
  const { profileDir } = config
  let inputHashes, verifyingVerdict = false
  const hashInput = (dir, file) => {
    const bytes = regularBytes(join(dir, file), { optional: file !== 'pnpm-lock.yaml' })
    return bytes === undefined ? null : digest(bytes)
  }
  const verifyInputs = () => {
    const chosen = regularBytes(join(staging.source, 'rollback.json'))
    if (!sameHash(chosen, run.rollback.manifestHash)
      || !sameInstallerManifest(read(join(profileDir, 'package.json')), json(chosen))
      || !inputHashes.every(([file, hash]) => hashInput(profileDir, file) === hash)) {
      throw new Error('The renamed-back profile could not be verified')
    }
  }
  const fail = (reason, fields) => {
    const location = rollbackLocation(config, staging, run)
    return manualRecovery(1, reason, { rollback: { ...run.rollback, ...fields, location } })
  }
  try {
    signal.throwIfAborted()
    if (run.rollback.failures >= 1) return fail('health-failed')
    if (run.rollback.ioFailures >= 2) return fail('rollback-failed')
    if (run.rollback.starts >= 3) return fail('rollback-failed', { why: 'restart-budget' })
    if (!run.rollback.trialTo) {
      await stop()
      advance('manifest', { trialTo: stamp() })
    }

    const release = await takeProfileLock(profileDir, signal)
    try {
      if (!run.rollback.manifestHash) {
        advance('manifest')
        const manifestHash = rollbackManifest(config, staging, run)
        save({ rollback: { ...run.rollback, manifestHash }, journal: { ...run.journal, rollbackManifestHash: manifestHash } })
      }
      const putBackCurrent = () => {
        if (!run.rollback.restoreCurrent) return
        advance('current')
        restoreCurrent()
        set({ restoreCurrent: false })
      }
      if (run.journal.pending !== null || run.journal.done.length > 0) {
        undoSwitch(config, staging, run, save, 'health-failed', afterRename, () => {
          putBackCurrent()
          advance('rename', { tried: tried(run, 'rename-back') })
        })
      } else putBackCurrent()
      advance('data')
      const team = teamSnapshot(config, run)
      // Keep the snapshot through the verdict, even when the previous team can read the trial format.
      archiveTeam(config, run, team)
      restoreData(config, run, save, team)
      discardArchives(profileDir, staging)
      syncDirectory(join(profileDir, VENDOR))
      advance('verify')
      inputHashes = PROFILE_INPUTS.slice(1).map(file => [file, hashInput(staging.source, file)])
      verifyInputs()
      if (!updateContract(profileDir) || (run.fromVersions && !isDeepStrictEqual(baseline(profileDir), run.fromVersions))) {
        throw new Error('The renamed-back profile could not be verified')
      }
      assertRelinked(profileDir, staging)
    } finally {
      release()
    }

    const expect = run.fromVersions ?? unpinnedPlugins(config.profileDir)
    advance('restart', { starts: (run.rollback.starts ?? 0) + 1, tried: tried(run, 'restart'),
      ...(run.fromVersions ? {} : { unpinned: true }) })
    const previous = start()
    advance('health', { tried: tried(run, 'health') })
    const result = await health(previous, expect, { team: teamSnapshot(config, run) })
    signal.throwIfAborted()
    const previousFailed = () => {
      set({ failures: (run.rollback.failures ?? 0) + 1, previousFailed: previous.result ? 'exited' : result.failed })
      return fail('health-failed')
    }
    if (!result.ok || previous.result) return previousFailed()
    beforeVerdict()
    verifyingVerdict = true
    const releaseVerdict = await takeProfileLock(profileDir, signal)
    try {
      signal.throwIfAborted()
      if (previous.result) return previousFailed()
      verifyInputs()
      const { undoReason: _reason, ...journal } = run.journal
      save({ phase: 'rolledBack', reason: 'health-failed', journal })
    } finally {
      releaseVerdict()
    }
  } catch (error) {
    if (signal.aborted) return
    if (error instanceof UndoIOError) {
      const ioFailures = (run.rollback.ioFailures ?? 0) + 1
      // If persisting the retry count also fails, leave the last replayable record in place.
      try { set({ ioFailures }) } catch { return retry() }
      return ioFailures >= 2 ? fail('rollback-failed') : retry()
    }
    return fail('rollback-failed', verifyingVerdict ? { step: 'verify' }
      : error instanceof UndoPreflightError ? { step: 'manifest' } : undefined)
  }
}
