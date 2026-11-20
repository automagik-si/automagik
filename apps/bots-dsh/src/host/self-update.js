import fs from 'node:fs'
import { inDesktopApp } from './constants.js'
import { currentOf, hasBootId, isId, publicVersion, runOf, supervisorStateOf } from './supervisor/records.js'
import { readJson, usableStore } from './supervisor/store.js'

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

function runView(run) {
  if (run === null) return null
  const { bootId, ...view } = run
  return view
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
    run: runView(status.run),
  }
}

function statusOf(profileDir, env, inDesktop, readMountInfo) {
  const { storeDir, currentInvalid, ...status } = selfUpdateDetails(profileDir, env, readMountInfo)
  const reason = inDesktop ? 'desktop-app' : status.supervisor === null ? 'no-supervisor'
    : storeDir === undefined ? 'no-store' : currentInvalid ? 'store-invalid' : null
  return { available: reason === null, reason, ...status }
}

export function selfUpdateStatus({ profileDir, env = process.env, inDesktop = inDesktopApp(), readMountInfo }) {
  return statusOf(profileDir, env, inDesktop, readMountInfo)
}

export function install(rt) {
  const env = {
    AUTOMAGIK_SUPERVISOR_BOOT: process.env.AUTOMAGIK_SUPERVISOR_BOOT,
    AUTOMAGIK_SUPERVISOR_VERSION: process.env.AUTOMAGIK_SUPERVISOR_VERSION,
  }
  const inDesktop = inDesktopApp()
  rt.selfUpdateStatus = () => statusOf(rt.ctx.get?.('profileContext')?.dir, env, inDesktop)
}
