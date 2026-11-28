import fs from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { teamHomeOf } from './folders.js'
import { ACTIVATION_COMPARE } from './state-format.js'
import { LISTENER_UNKNOWN } from './supervisor/child.js'
import { inDesktopApp } from './constants.js'
import { currentOf, hasBootId, isId, publicVersion, REINSTALL_REFUSAL, reinstallRefusalReason, runOf, supervisorStateOf } from './supervisor/records.js'
import { PLUGINS } from './supervisor/release.js'
import { comparesActivations, liveTeamLineage, teamSnapshot } from './supervisor/rollback.js'
import { readJson, usableStore } from './supervisor/store.js'
import { validJournal } from './supervisor/switch.js'

export { REASON_CODES } from './supervisor/records.js'
export { prepareStore, storeDirOf, usableStore, writeJsonAtomic } from './supervisor/store.js'

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

// Used before host hooks, including by import. Re-read the executing supervisor's
// records at publication. The copied code on disk may belong to a later version.
export function stateWriteProof(rt, env = { ...process.env }) {
  const supervisor = supervisorOf(env)
  const announced = env.AUTOMAGIK_SUPERVISOR_RUN
  let bootRun = announced
  let steady = false
  return ({ compare = false } = {}) => {
    if (supervisor === null) return announced ? 'held' : 'steady'
    const profileDir = rt.ctx.get?.('profileContext')?.dir
    const records = readStore(profileDir)
    if (!records.storeDir) return 'held'
    const { bootId } = supervisor
    const bootIds = bootIdsOf(records, bootId)
    const announcement = supervisorStateOf(records.supervisorRecord, bootIds)
    if (announcement?.bootId !== bootId) return 'held'
    const { current, run, problem } = stateOf(records, bootId, bootIds)
    if (problem) return 'held'
    if (announcement.runId === null && bootRun === undefined) {
      steady = true
      return 'steady'
    }
    if (run === null) return 'held'
    // Delivery 5b supplied a live record but no RUN in the child's environment.
    if (!steady && bootRun === undefined) bootRun = run.runId
    // An early refusal leaves the original child in place with its team unchanged.
    if (steady && ['checking', 'downloading', 'verifying', 'staging', 'notUpdated'].includes(run.phase)) return 'steady'
    if (run.runId !== bootRun || rt.statePath !== join(teamHomeOf(env), 'state.json')) return 'held'
    if (run.phase === 'healthy' && run.reason === 'health-check-finished' && current?.live?.version === run.to
      && current.live.sequence === records.runRecord.sequence) return 'steady'
    if (run.phase === 'rolledBack' || run.phase === 'notUpdated') return 'returned'
    if (!compare || !['restarting', 'health'].includes(run.phase)
      || env[ACTIVATION_COMPARE] !== `${bootId}:${bootRun}` || announced !== bootRun) return 'held'
    try {
      const { journal } = records.runRecord
      if (!validJournal(records.runRecord) || journal.undo || journal.pending !== null
        || journal.done.length !== journal.steps.length) return 'held'
      const config = { store: records.storeDir, env }
      return comparesActivations(config, records.runRecord)
        && liveTeamLineage(teamSnapshot(config, records.runRecord)) === 'descended' ? 'compare' : 'held'
    } catch {
      return 'held'
    }
  }
}

function runView(run) {
  if (run === null) return null
  const { bootId, ...view } = run
  return view
}

function reinstallRefusal(run, store, profileDir, readMountInfo) {
  if (run?.phase !== 'notUpdated') return run
  const refusal = readJson(() => usableStore(profileDir, readMountInfo), store, REINSTALL_REFUSAL)
  if (refusal?.version !== 1 || refusal.runId !== run.runId || reinstallRefusalReason(refusal.detail) !== run.reason) {
    return run
  }
  const { detail } = refusal
  return { ...run, reinstall: true, detail, reason: detail === 'release-changed' ? detail : run.reason }
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
    run: runView(reinstallRefusal(status.run, records.storeDir, profileDir, readMountInfo)),
  }
}

export function listenerUnknown(profileDir, env = process.env, readMountInfo) {
  const store = () => usableStore(profileDir, readMountInfo)
  const record = readJson(store, store(), 'listener.json')
  if (record?.version === 1 && isId(record.bootId) && record.bootId === env?.AUTOMAGIK_SUPERVISOR_BOOT) {
    if (record.listener === 'unknown') return true
    if (record.listener === 'verified' || record.listener === 'verified-argv') return false
  }
  return env?.[LISTENER_UNKNOWN] === '1'
}

export function pluginHealth(ctx, versions = new WeakMap()) {
  const active = new Map()
  for (const entry of ctx.get?.('loader')?.entries?.() ?? []) {
    const name = entry.options?.name
    if (!PLUGINS.includes(name) || entry.fiber?.state !== 2) continue
    if (active.has(name)) active.set(name, null)
    else active.set(name, entry)
  }
  return PLUGINS.map(name => {
    const entry = active.get(name)
    if (!entry) return { name, version: null, loaded: false }
    if (!versions.has(entry)) {
      let version = null
      try {
        const manifest = createRequire(entry.parent.tree.ctx.baseUrl).resolve(name + '/package.json')
        const { version: found } = JSON.parse(fs.readFileSync(manifest))
        if (typeof found === 'string') version = found
      } catch {}
      versions.set(entry, version)
    }
    return { name, version: versions.get(entry), loaded: true }
  })
}

// A supervisor that runs health and rollback names its own boot here. A pre-d6 supervisor copies the service's
// environment to DSH, so an inherited value is trusted only when it names this boot, which is new on every start.
export const rollbackCapable = env => typeof env?.AUTOMAGIK_SUPERVISOR_ROLLBACK === 'string' && env.AUTOMAGIK_SUPERVISOR_ROLLBACK !== ''
  && env.AUTOMAGIK_SUPERVISOR_ROLLBACK === env.AUTOMAGIK_SUPERVISOR_BOOT

export const reinstallCapable = (env = process.env) => rollbackCapable(env)
  && env.AUTOMAGIK_SUPERVISOR_REINSTALL === env.AUTOMAGIK_SUPERVISOR_BOOT

function statusOf(profileDir, env, inDesktop, readMountInfo) {
  const { storeDir, currentInvalid, current, ...status } = selfUpdateDetails(profileDir, env, readMountInfo)
  const reason = inDesktop ? 'desktop-app' : status.supervisor === null ? 'no-supervisor'
    : listenerUnknown(profileDir, env, readMountInfo) ? 'listener-unknown'
    : storeDir === undefined ? 'no-store' : currentInvalid ? 'store-invalid' : null
  const publicCurrent = current === null ? null : {
    version: current.version, live: current.live, kept: current.kept, lastSequence: current.lastSequence,
  }
  return { available: reason === null, reason, ...status, current: publicCurrent,
    ...(rollbackCapable(env) ? { rollback: true } : {}),
    ...(reinstallCapable(env) ? { reinstall: true } : {}) }
}

export function selfUpdateStatus({ profileDir, env = process.env, inDesktop = inDesktopApp(), readMountInfo }) {
  return statusOf(profileDir, env, inDesktop, readMountInfo)
}

export function install(rt) {
  const env = {
    [LISTENER_UNKNOWN]: process.env[LISTENER_UNKNOWN],
    AUTOMAGIK_SUPERVISOR_BOOT: process.env.AUTOMAGIK_SUPERVISOR_BOOT,
    AUTOMAGIK_SUPERVISOR_VERSION: process.env.AUTOMAGIK_SUPERVISOR_VERSION,
    AUTOMAGIK_SUPERVISOR_ROLLBACK: process.env.AUTOMAGIK_SUPERVISOR_ROLLBACK,
    AUTOMAGIK_SUPERVISOR_REINSTALL: process.env.AUTOMAGIK_SUPERVISOR_REINSTALL,
  }
  const inDesktop = inDesktopApp()
  rt.selfUpdateStatus = () => statusOf(rt.ctx.get?.('profileContext')?.dir, env, inDesktop)
  const versions = new WeakMap()
  rt.selfUpdateHealth = () => ({ plugins: pluginHealth(rt.ctx, versions), hold: rt.updateHold?.proof() ?? { state: 'unknown', run: null } })
}
