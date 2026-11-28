import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { homeLock } from '../home-lock.js'
import { activationIds, protectedStateFormat, STATE_ACTIVATIONS } from '../state-format.js'
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
const documentFormat = document => document ? (document.version === undefined ? 0 : document.version) : null
const RETRY_MS = 250
const LOCK_BUDGET_MS = 65_000
const pause = (ms, signal) => setTimeout(ms, undefined, { signal })

class RollbackBlocked extends Error {}

export function captureContract(profileDir) {
  try {
    const bytes = regularBytes(join(profileDir, ...CONTRACT))
    const contract = json(bytes)
    if (contract?.version !== 1 || contract.holdRun !== true || !formats(contract.stateFormats)) return null
    if (contract.activations === undefined ? contract.stateFormats.some(protectedStateFormat)
      : activationIds(contract.activations) === null) return null
    return { contract, hash: digest(bytes) }
  } catch {}
  return null
}

export const updateContract = profileDir => captureContract(profileDir)?.contract ?? null

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

function readSnapshot(config, run) {
  const kept = join(config.store, run.journal.keep)
  let index, data
  try {
    index = regularBytes(join(kept, 'data.json'))
    data = json(index)
  } catch {
    throw new RollbackBlocked('unknown')
  }
  const allowed = DATA_FILES[0]
  const path = allowed.path(config.env)
  if (data?.version !== 1 || !Array.isArray(data.files) || data.files.length > 1) throw new RollbackBlocked('unknown')
  const team = data.files[0]
  if (data.files.length === 0) return { path, index, team: null }
  if (team?.snapshot !== allowed.snapshot || team.path !== path || !format(team.format)) throw new RollbackBlocked('unknown')
  const saved = join(kept, 'data', team.snapshot)
  const bytes = regularBytes(saved, { optional: true })
  if (!bytes || (team.sha256 !== undefined && !sameHash(bytes, team.sha256))) throw new RollbackBlocked('snapshot-changed')
  const snapshot = teamDocument(bytes)
  const revision = snapshot?.revision ?? 0
  if (documentFormat(snapshot) !== team.format || !Number.isSafeInteger(revision) || revision < 0) {
    throw new RollbackBlocked('snapshot-changed')
  }
  return { path, index, bytes, team: { ...team, saved, revision, revisionless: snapshot.revision === undefined, snapshotHash: digest(bytes) } }
}

export const teamSnapshot = (config, run) => readSnapshot(config, run).team

function compatible(team, document) {
  const version = documentFormat(document)
  if (!formats(team.reads) || !team.reads.includes(version)) return false
  if (version <= 3) return !Object.hasOwn(document, STATE_ACTIVATIONS)
  if (!protectedStateFormat(version) || team.sha256 === undefined) return false
  const allowed = activationIds(team.activations)
  const active = activationIds(document[STATE_ACTIVATIONS], { required: true })
  return !!allowed && !!active && active.every(id => allowed.includes(id))
}

export function comparesActivations(config, run) {
  const { bytes, team } = readSnapshot(config, run)
  return !!team && team.sha256 !== undefined && (team.activations === undefined || activationIds(team.activations) !== null)
    && compatible(team, teamDocument(bytes))
}

function backupDir(store, run) {
  const root = directory(join(store, 'rollback-data'))
  const dir = directory(join(root, run.runId))
  for (const path of [store, root, dir]) syncDirectory(path)
  return dir
}

function archiveTeam(config, run, { index, bytes, team }) {
  const dir = backupDir(config.store, run)
  if (team) {
    const path = join(dir, team.snapshot)
    const archived = regularBytes(path, { optional: true })
    if (archived === undefined) writeBytesAtomic(path, bytes, { durable: true })
    else if (!archived.equals(bytes)) throw new RollbackBlocked('snapshot-changed')
  }
  const path = join(dir, 'data.json')
  const archived = regularBytes(path, { optional: true })
  if (archived === undefined) writeBytesAtomic(path, index, { durable: true })
  else if (!archived.equals(index)) throw new RollbackBlocked('snapshot-changed')
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

async function claimTeam(lock, signal, now, wait) {
  const deadline = now() + LOCK_BUDGET_MS
  for (;;) {
    signal.throwIfAborted()
    if (lock.claim() === undefined) {
      if (lock.owns()) return
      break
    }
    const remaining = deadline - now()
    if (remaining <= 0) break
    await wait(Math.min(RETRY_MS, remaining), signal)
  }
  throw new RollbackBlocked('team-in-use')
}

function checkedLive(path) {
  try { return regularBytes(path, { optional: true }) } catch { throw new RollbackBlocked('unknown') }
}

export async function restoreData(config, run, save, {
  signal = new AbortController().signal, now = () => performance.now(), wait = pause, createLock = homeLock,
} = {}) {
  const prior = run.rollback.data
  if (prior?.restored === false && prior.why !== 'same-format') throw new RollbackBlocked(prior.why)
  signal.throwIfAborted()
  const before = readSnapshot(config, run)
  const home = dirname(before.path)
  const created = fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  if (created) {
    for (let path = home; path !== created; path = dirname(path)) syncDirectory(dirname(path))
    syncDirectory(dirname(created))
  }
  const lock = createLock(join(home, 'state.lock'))
  const requireOwnership = () => {
    signal.throwIfAborted()
    if (!lock.owns()) throw new RollbackBlocked('team-in-use')
  }
  try {
    await claimTeam(lock, signal, now, wait)
    let capture
    try { capture = readSnapshot(config, run) } catch { throw new RollbackBlocked('snapshot-changed') }
    const { team, path, index } = capture
    if (!index.equals(before.index) || team?.snapshotHash !== before.team?.snapshotHash) {
      throw new RollbackBlocked('snapshot-changed')
    }
    requireOwnership()
    archiveTeam(config, run, capture)
    const trial = checkedLive(path)
    const liveHash = trial === undefined ? null : digest(trial)
    const proof = { path, team, hash: liveHash }
    if (!team) {
      if (trial !== undefined) throw new RollbackBlocked('superseded')
      requireOwnership()
      if (prior === undefined) dataOutcome(run, save, null)
      return proof
    }

    const live = teamDocument(trial)
    const lineage = teamLineage(team, trial, live)
    const canKeep = lineage === 'descended' && compatible(team, live)
    let intent = run.journal.restore
    if (prior?.restored === false) {
      if (!canKeep || run.rollback.teamMissing) throw new RollbackBlocked('superseded')
      return proof
    }
    if (intent === undefined) {
      const lost = lineage === 'lost' || run.rollback.teamMissing
      if (!lost && canKeep) {
        requireOwnership()
        dataOutcome(run, save, { restored: false, why: 'same-format', trialKept: false })
        return proof
      }
      const version = documentFormat(live)
      if (!lost && (!format(version) || !formats(team.reads))) throw new RollbackBlocked('unknown')
      if (!compatible(team, teamDocument(capture.bytes))) throw new RollbackBlocked('unknown')
      intent = { path, snapshot: team.snapshot, trialHash: liveHash,
        snapshotHash: team.snapshotHash, ...(lost ? { why: 'team-lost' } : {}) }
      requireOwnership()
      save({ journal: { ...run.journal, restore: intent }, rollback: { ...run.rollback, tried: tried(run, 'data-restore') } })
    }
    const { trialHash, snapshotHash, why } = intent
    if (intent.path !== team.path || intent.snapshot !== team.snapshot
      || (trialHash !== null && !HASH.test(trialHash)) || !HASH.test(snapshotHash)
      || (why !== undefined && why !== 'team-lost')) throw new Error('Invalid data restore journal')
    if (snapshotHash !== team.snapshotHash) throw new RollbackBlocked('snapshot-changed')
    if (prior?.restored === true) {
      // A previously admitted child can have saved a compatible descendant before the supervisor stopped.
      if (liveHash !== snapshotHash && !(run.rollback.starts > 0 && canKeep)) throw new RollbackBlocked('superseded')
      return proof
    }
    let trialKept = false
    const trialCopy = dir => join(dir, 'trial-' + team.snapshot)
    if (!sameHash(trial, snapshotHash)) {
      if (liveHash !== trialHash) throw new RollbackBlocked('superseded')
      if (trial !== undefined) {
        const path = trialCopy(backupDir(config.store, run))
        requireOwnership()
        writeBytesAtomic(path, trial, { durable: true })
        if (!sameHash(regularBytes(path), trialHash)) throw new Error('The saved trial team did not match')
        trialKept = true
      }
      const snapshot = regularBytes(team.saved, { optional: true })
      if (!sameHash(snapshot, snapshotHash)) throw new RollbackBlocked('snapshot-changed')
      if (!sameHash(checkedLive(path), liveHash)) throw new RollbackBlocked('superseded')
      requireOwnership()
      writeBytesAtomic(path, snapshot, { durable: true })
    } else if (trialHash !== null && trialHash !== snapshotHash) {
      trialKept = sameHash(regularBytes(trialCopy(join(config.store, 'rollback-data', run.runId)), { optional: true }), trialHash)
    }
    requireOwnership()
    dataOutcome(run, save, { restored: true, trialKept, ...(why ? { why } : {}) }, { ...run.journal, restored: true })
    return { ...proof, hash: snapshotHash }
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
  manualRecovery, retry, afterRename, beforeVerdict = () => {}, teamLock }) {
  const set = changes => save({ rollback: { ...run.rollback, ...changes } })
  const advance = (step, changes) => {
    signal.throwIfAborted()
    if (run.rollback.step !== step || changes) set({ step, ...changes })
  }
  const { profileDir } = config
  let inputHashes, proof, verifyingVerdict = false
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
    if (run.rollback.data?.restored === false && run.rollback.data.why !== 'same-format') {
      throw new RollbackBlocked(run.rollback.data.why)
    }
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
      proof = await restoreData(config, run, save, { ...teamLock, signal })
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
    const verifyHandoff = () => {
      if (!sameHash(checkedLive(proof.path), proof.hash)) throw new RollbackBlocked('superseded')
    }
    advance('restart', { starts: (run.rollback.starts ?? 0) + 1, tried: tried(run, 'restart'),
      ...(run.fromVersions ? {} : { unpinned: true }) })
    verifyHandoff()
    const previous = start(verifyHandoff)
    advance('health', { tried: tried(run, 'health') })
    const result = await health(previous, expect, { team: proof.team })
    signal.throwIfAborted()
    const previousFailed = (failed = result.failed) => {
      set({ failures: (run.rollback.failures ?? 0) + 1, previousFailed: previous.result ? 'exited' : failed })
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
      if (proof.team && liveTeamLineage(proof.team) !== 'descended') return previousFailed('roster')
      const { undoReason: _reason, ...journal } = run.journal
      save({ phase: 'rolledBack', reason: 'health-failed', journal })
    } finally {
      releaseVerdict()
    }
  } catch (error) {
    if (signal.aborted) return
    if (error instanceof RollbackBlocked) {
      return fail('rollback-failed', { data: { restored: false, why: error.message, trialKept: false } })
    }
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
