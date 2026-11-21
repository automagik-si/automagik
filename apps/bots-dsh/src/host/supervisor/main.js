import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { hostname } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { compareVersions } from '../lane-verify.js'
import { LISTENER_UNKNOWN, startChild } from './child.js'
import { checkHealth, healthListener, listenerOf, verifyListener } from './health.js'
import { copyVersion, installCopy, refreshCopy, reinstallCopies, runningCopy, SELF_CHECK_OK, supervisorVersion } from './copy.js'
import { checkRelinkConfig, installRegistry } from './pnpm.js'
import { currentOf, isId, isVersion, REINSTALL_REFUSAL, reinstallRefusalReason, RUNNING, runOf, TERMINAL } from './records.js'
import { inspectRelease, releaseSource } from './release.js'
import { takeRequest } from './request.js'
import { baseline, finishRolledBack, liveTeamLineage, rollbackLocation, runRollback, teamSnapshot, unpinnedPlugins, updateContract } from './rollback.js'
import { assertRelinked, discardArchives, downloadPath, laneEntries, relink, stageInstall, stagePaths, takeProfileLock } from './stage.js'
import { identity, prepareStore, readJson, regularBytes, syncDirectory, takeLifetimeLock, UPDATE_RECORD_LIMIT, usableStore, writeJsonAtomic } from './store.js'
import { candidateMatches, completeSwitch, didSwitch, planSwitch, sweepReinstallTrash, trashReinstall, UndoPreflightError, undoSwitch, validJournal, validTerminalJournal } from './switch.js'

const IDLE_POLL_MS = 1000
// Leave room in state.json for the journal and rollback fields alongside this snapshot.
const MAX_CURRENT_SNAPSHOT_BYTES = 4096
const stamp = () => new Date().toISOString()
const warn = message => console.error(`automagik supervisor: ${message}`)

export const IMAGE_HOST = 1

function configure(home, profile, command, env) {
  if (!isAbsolute(home ?? '') || !/^[A-Za-z0-9._-]+$/.test(profile ?? '') || ['.', '..'].includes(profile)) {
    throw new Error('An absolute DSH home and a profile name are required')
  }
  home = resolve(home)
  const profileDir = join(home, 'profiles', profile)
  if (command && (!command[0] || !isAbsolute(command[1] ?? '')
    || !resolve(command[1]).endsWith('/@deepseek-ai/dsh/lib/bin.js'))) {
    throw new Error('The DSH command must start with Node and the absolute installed DSH entrypoint')
  }
  return { home, profile, profileDir, command, env, store: prepareStore(profileDir) }
}

function dshVersion(command) {
  return JSON.parse(regularBytes(join(dirname(command[1]), '../package.json'))).version
}

function storeLock(store) {
  const lock = takeLifetimeLock(join(store, 'update.lock'), { pid: process.pid, host: hostname(), startedAt: Date.now() })
  if (!lock) throw new Error('The update store already has a supervisor')
  return lock
}

export async function runSupervisor({
  home, profile, command, version, env = process.env, laneUrl, keys, fetch = globalThis.fetch,
  healthTimeout, healthProbe, onChildStart, onLaunchUrl, onLine, onSave, signal: externalSignal, refreshCopy: refresh = true,
}) {
  if (externalSignal?.aborted) return 1
  if (!isVersion(version)) throw new Error('Invalid supervisor copy version')
  const source = releaseSource(laneUrl, keys)
  if (!source) throw new Error('Invalid supervisor release source')
  const config = configure(home, profile, command, env)
  const { store, profileDir } = config
  const lock = storeLock(store)
  const bootId = `sup_${randomUUID()}`
  const controller = new AbortController()
  const { signal } = controller
  const bootEnv = { ...env, DSH_HOME: config.home, AUTOMAGIK_SUPERVISOR_BOOT: bootId, AUTOMAGIK_SUPERVISOR_VERSION: version,
    AUTOMAGIK_SUPERVISOR_ROLLBACK: bootId }
  const args = command.slice(2)
  const listener = healthListener(args)
  bootEnv[LISTENER_UNKNOWN] = listener ? '0' : '1'
  delete bootEnv.AUTOMAGIK_SUPERVISOR_RUN
  delete bootEnv.AUTOMAGIK_SUPERVISOR_REINSTALL
  let checkedListener, listenerCheck
  const seen = new Set()
  let child, run, active, exitCode, recoveredAt
  let trial = false
  let recovering = false
  let verdictFailed = false
  let executingCopy

  function requireLock() {
    if (!lock.owns()) throw new Error('The update store lock changed')
  }
  const checkedStore = () => {
    const checked = usableStore(profileDir)
    return checked && fs.realpathSync(checked) === store ? store : undefined
  }
  const read = file => readJson(checkedStore, store, file)
  const readCurrent = () => {
    const raw = read('current.json')
    if (raw === undefined) return undefined
    const current = currentOf(raw, [bootId])
    return current && Buffer.byteLength(JSON.stringify(current)) <= MAX_CURRENT_SNAPSHOT_BYTES ? current : null
  }
  const write = (file, value) => {
    requireLock()
    writeJsonAtomic(join(store, file), value, { profileDir, durable: true })
  }
  const announce = () => write('supervisor.json', { version: 1, bootId, runId: run?.runId ?? null })
  const announceListener = listener => write('listener.json', { version: 1, bootId, listener })
  async function checked(target, probeSignal = signal) {
    if (target !== child || !target?.launchUrl || target.result || probeSignal.aborted) return null
    if (checkedListener) return checkedListener
    if (!listenerCheck) {
      listenerCheck = verifyListener(target, args, { signal: probeSignal, probe: healthProbe }).then(found => {
        if (!found || target !== child || target.result || signal.aborted) return null
        announceListener(found.status)
        checkedListener = found
        return found
      }).finally(() => {
        if (target === child) listenerCheck = undefined
      })
    }
    return listenerCheck
  }
  const save = (changes = {}, updatedAt = stamp()) => {
    const proposed = { ...run, ...changes, updatedAt }
    try {
      write('state.json', proposed)
    } catch (error) {
      if (TERMINAL.has(proposed.phase)) {
        verdictFailed = true
        exitCode = 1
        shutdown(1)
        child?.detach()
        warn('could not record the update verdict; recovery is required, see state.json')
      }
      throw error
    }
    Object.assign(run, proposed)
    // A request posted while this run was live is discarded only once its verdict is visible, and only when it is
    // older than the verdict: the admitted owner can already ask for another update.
    if ((active || recovering) && TERMINAL.has(proposed.phase)) {
      try {
        const pending = read('request.json')
        if (pending !== undefined && !(Date.parse(pending?.requestedAt) > Date.parse(proposed.updatedAt))) {
          takeRequest(store, read, bootId, true, seen)
        }
      } catch {
        warn('a request posted during the update could not be discarded')
      }
    }
    try { onSave?.(run) } catch { warn('could not notify the host of the saved update state') }
  }
  const phase = (next, reason = null) => save({ phase: next, reason })

  function shutdown(code) {
    exitCode ??= code
    controller.abort()
  }
  function start(forRun = false) {
    signal.throwIfAborted()
    try { onChildStart?.() } catch { warn('could not notify the host before starting DSH') }
    signal.throwIfAborted()
    checkedListener = undefined
    listenerCheck = undefined
    announceListener('unknown')
    const env = forRun ? { ...bootEnv, AUTOMAGIK_SUPERVISOR_RUN: run.runId } : bootEnv
    const startedAt = Date.now()
    const started = startChild(command, env, ended => {
      if (!ended.expectedExit && !trial) shutdown(ended.result.code)
    }, {
      onLaunchUrl: url => { if (child === started) onLaunchUrl?.(url) },
      onLine,
    })
    child = started
    const target = child
    target.onLaunchUrl = () => {
      if (target !== child || target.result || signal.aborted) return
      const found = listenerOf(target, args)
      if (!found) return
      if (found.isPublic) return checked(target)
      announceListener('verified')
      checkedListener = { ...found, status: 'verified' }
    }
    child.startedAt = startedAt
    return child
  }
  const stop = async (sig) => {
    if (child) await child.stop(sig)
  }
  const abort = () => {
    void stop()
    shutdown(1)
  }
  // The signal the service sent goes to DSH first; the shutdown that follows never sends a second one.
  const forward = Object.fromEntries(['SIGTERM', 'SIGINT', 'SIGHUP'].map(sig => [sig, () => {
    if (verdictFailed) return
    void stop(sig)
    shutdown(0)
  }]))

  function discard(staging) {
    fs.rmSync(staging.root, { recursive: true, force: true })
  }

  function cleanNotUpdatedBackup(prior = run) {
    if (prior.reinstall === true) {
      if (prior.journal) trashReinstall(store, prior)
    } else if (validTerminalJournal(prior)) {
      fs.rmSync(join(store, prior.journal.keep), { recursive: true, force: true })
    }
    cleanReinstallTrash()
  }

  function cleanReinstallTrash() {
    try { sweepReinstallTrash(store) } catch { warn('reinstall trash could not be removed') }
  }

  const health = (target, expect, options) => checkHealth(target, {
    args, expect, runId: run.runId, signal, probe: healthProbe, since: target.startedAt,
    verifiedListener: deadline => checked(target, deadline),
    windows: typeof healthTimeout === 'number' ? { first: healthTimeout, second: healthTimeout } : healthTimeout,
    ...options,
  })

  async function giveBack(staging, reason, restart, { legacy = false } = {}) {
    signal.throwIfAborted()
    trial = true
    if (restart && !legacy && !updateContract(profileDir)) return manualRecovery(1, 'rollback-failed')
    const unchanged = restart ? start(true) : child
    const expect = run.fromVersions ?? unpinnedPlugins(profileDir)
    const team = run.journal && (run.reinstall === true || identity(join(store, run.journal.keep, 'data.json')))
      ? teamSnapshot(config, run) : null
    const result = await health(unchanged, expect, { team, legacy, ...(!restart ? { since: Date.now() } : {}) })
    const versionsMatch = !legacy || !run.fromVersions || isDeepStrictEqual(baseline(profileDir), run.fromVersions)
    signal.throwIfAborted()
    if (!result.ok || unchanged.result || !versionsMatch) return manualRecovery(unchanged.result?.code)
    // Undo has finished and the candidate never served. Staging can go before the verdict is visible.
    try {
      discard(staging)
      if (run.reinstall !== true) cleanNotUpdatedBackup()
    } catch {
      // The next start's cleanup of a notUpdated run removes what is left.
      warn('update cleanup did not finish')
    }
    save({ phase: 'notUpdated', reason, ...(legacy ? { detail: 'previous-unsupported' } : {}) })
    trial = false
    // An interrupted reinstall give-back needs its snapshot to check team lineage again on replay.
    if (run.reinstall === true) {
      try { cleanNotUpdatedBackup() } catch { warn('update cleanup did not finish') }
    }
  }

  function refuseReinstall(staging, detail) {
    // An older launcher slot must be able to read this verdict. The existing child releases its own hold.
    try {
      write(REINSTALL_REFUSAL, { version: 1, runId: run.runId, detail })
    } catch {
      warn('could not record the reinstall refusal detail')
    }
    try { discard(staging) } catch { warn('update cleanup did not finish') }
    phase('notUpdated', reinstallRefusalReason(detail))
  }

  async function manualRecovery(code = 1, reason = 'health-failed', fields = {}) {
    save({ phase: 'manualRecovery', reason, ...fields })
    const rollback = fields.rollback
    if (rollback?.location) {
      const describe = item => `previous=${item.previous}, candidate=${item.candidate}`
      warn(`rollback step ${rollback.step} requires recovery; node_modules ${describe(rollback.location.modules)}; pnpm-lock.yaml ${describe(rollback.location.lockfile)}. See "Rename back after manualRecovery" in docs/upgrade.md and state.json in the update store`)
    } else {
      warn('manual recovery is required; see state.json in the update store')
    }
    shutdown(code || 1)
    await stop()
  }

  function undoFailure(staging) {
    return manualRecovery(1, 'rollback-failed', {
      rollback: { trialFrom: run.trialStartedAt ?? run.startedAt, tried: [], step: 'manifest',
        location: rollbackLocation(config, staging, run) },
    })
  }

  async function rollBack(staging, failed, teamMissing = false) {
    signal.throwIfAborted()
    trial = true
    if (run.phase !== 'rollingBack') {
      const { commitCurrent, ...journal } = run.journal
      const published = read('current.json')
      // This run's own record, in either shape: with its committed pins, or the version-only form.
      const restoreCurrent = commitCurrent === true || (run.reinstall !== true
        && (isDeepStrictEqual(published, nextCurrent()) || isDeepStrictEqual(published, versionRecord())))
      save({
        phase: 'rollingBack', reason: 'health-failed', journal: { ...journal, undo: true, undoReason: 'health-failed' },
        rollback: { failed, step: 'stop', tried: [], trialFrom: run.trialStartedAt ?? stamp(), restoreCurrent,
          ...(teamMissing ? { teamMissing: true } : {}) },
      })
    }
    await runRollback({
      config, staging, run, save, signal, stop, start: () => start(true), health, manualRecovery, retry: () => shutdown(1),
      restoreCurrent: () => {
        if (!Object.hasOwn(run, 'priorCurrent')) throw new Error('The prior version record was not saved')
        if (run.priorCurrent === null) {
          requireLock()
          fs.rmSync(join(store, 'current.json'), { force: true })
          syncDirectory(store)
        } else {
          if (!currentOf(run.priorCurrent, [bootId])) throw new Error('The prior version record is invalid')
          write('current.json', run.priorCurrent)
        }
      },
    })
    if (run.phase === 'rolledBack') {
      trial = false
      finishRolledBack(config, staging, run)
      cleanReinstallTrash()
    }
  }

  async function undoBeforeTrial(staging, release) {
    try {
      signal.throwIfAborted()
      undoSwitch(config, staging, run, save, 'stage-failed')
      discardArchives(profileDir, staging)
    } finally {
      release()
    }
    await giveBack(staging, 'stage-failed', true)
  }

  async function relinkAndRestart(staging, releaseLock) {
    let released = false
    try {
      if (!candidateMatches(config, staging, run)) throw new Error('The switched inputs changed before relink')
      checkRelinkConfig(config, staging)
      save({ journal: { ...run.journal, relinking: true } })
      releaseLock()
      released = true
      await relink(config, signal)
      assertRelinked(profileDir, staging)
      if (run.reinstall === true) save({ journal: { ...run.journal, relinked: true } })
    } catch {
      const release = released ? await takeProfileLock(profileDir, signal) : releaseLock
      return undoBeforeTrial(staging, release)
    }
    await restartCandidate(staging)
  }

  const versionRecord = () => ({
    version: 1, live: { version: run.to, sequence: run.sequence },
    kept: run.reinstall === true ? run.priorCurrent?.kept ?? null : { version: run.from },
    lastSequence: run.sequence,
  })
  function nextCurrent() {
    const record = versionRecord()
    const prior = currentOf(read('current.json'), [bootId])
    const committed = prior?.live?.version === run.to && prior.live.sequence === run.sequence && prior.entries
      ? prior : null
    try {
      const staging = stagePaths(store, run.runId, profile)
      const entries = laneEntries(JSON.parse(regularBytes(join(staging.source, 'candidate.json'))), run.names)
      if (committed && isDeepStrictEqual(committed.entries, entries)) return committed
      const pre = read(join('versions', run.from, 'entries.json'))?.dependencies
      if (!pre || !run.names.every(name => typeof pre[name] === 'string')) return record
      const base = Object.fromEntries(run.names.map(name => [
        name, prior?.entries?.[name] === pre[name] && prior?.base?.[name] !== undefined ? prior.base[name] : pre[name],
      ]))
      return currentOf({ ...record, entries, base }, [bootId]) ?? record
    } catch {
      return committed ?? record
    }
  }

  async function restartCandidate(staging, { recheckRelink = false } = {}) {
    const team = teamSnapshot(config, run)
    let candidate, failure, teamMissing
    const beforeSpawn = await takeProfileLock(profileDir, signal)
    try {
      signal.throwIfAborted()
      let relinked = true
      if (recheckRelink) {
        try { assertRelinked(profileDir, staging) } catch { relinked = false }
      }
      const lineage = team ? liveTeamLineage(team) : 'descended'
      if (lineage !== 'descended') {
        failure = 'roster'
        teamMissing = lineage === 'lost'
      } else if (!relinked || !candidateMatches(config, staging, run)) {
        failure = 'plugins'
      } else {
        save({ phase: 'restarting', reason: null, trialStartedAt: run.trialStartedAt ?? stamp() })
        trial = true
        candidate = start(true)
        phase('health')
      }
    } finally {
      beforeSpawn()
    }
    if (failure) return rollBack(staging, failure, teamMissing)
    const expect = Object.fromEntries(run.names.map(name => [name, run.to]))
    const result = await health(candidate, expect, { team })
    signal.throwIfAborted()
    if (!result.ok || candidate.result) return rollBack(staging, candidate.result ? 'exited' : result.failed, result.teamMissing)

    const beforeCommit = await takeProfileLock(profileDir, signal)
    try {
      signal.throwIfAborted()
      failure = candidate.result ? 'exited' : !candidateMatches(config, staging, run) ? 'plugins' : null
      if (!failure) {
        save({ journal: { ...run.journal, commitCurrent: true } })
        write('current.json', nextCurrent())
        phase('healthy', 'health-check-finished')
        trial = false
      }
    } finally {
      beforeCommit()
    }
    if (failure) return rollBack(staging, failure)
    await finishHealthy(staging)
  }

  async function finishHealthy(staging, completed = run) {
    const { priorKept, to, from, names } = completed
    if (completed.reinstall === true) trashReinstall(store, completed)
    else if (isVersion(priorKept) && priorKept !== to && priorKept !== from) {
      try { fs.rmSync(join(store, 'versions', priorKept), { recursive: true, force: true }) } catch {
        warn('the older kept version could not be removed')
      }
    }
    discard(staging)
    cleanReinstallTrash()
    if (!refresh || !Array.isArray(names) || !names.includes('@automagik/bots-dsh')) return
    try { await refreshCopy(store, profileDir, to, signal, executingCopy) } catch {
      if (!signal.aborted) warn('the new supervisor copy did not pass its self-check')
    }
  }

  async function recover(prior) {
    run = prior
    save({ bootId })
    announce()
    const staging = stagePaths(store, run.runId, profile)
    if (run.phase === 'manualRecovery') {
      warn('manual recovery is required; see state.json in the update store')
      shutdown(1)
      return
    }
    if (!run.journal) {
      if (identity(staging.root)) {
        const release = await takeProfileLock(profileDir, signal)
        try { discardArchives(profileDir, staging) } finally { release() }
      }
      if (!updateContract(profileDir)) return giveBack(staging, 'profile-invalid', true, { legacy: true })
      return giveBack(staging, 'supervisor-restarted', true)
    }
    if (!validJournal(run) || !Number.isSafeInteger(run.sequence) || run.sequence < 0) {
      return manualRecovery(1, 'rollback-failed')
    }

    if (run.phase === 'rollingBack') {
      if (!run.rollback || run.journal.undo !== true || run.journal.undoReason !== 'health-failed') {
        return manualRecovery(1, 'rollback-failed')
      }
      return rollBack(staging, run.rollback.failed)
    }

    const relinked = run.reinstall !== true || run.journal.relinked === true
    // Relink finished before this trial started. Boot the candidate without touching its installer inputs.
    if (['restarting', 'health'].includes(run.phase) && !run.rollback && run.trialStartedAt
      && relinked && didSwitch(config, staging, run)) {
      return restartCandidate(staging, { recheckRelink: run.reinstall === true })
    }

    let release = await takeProfileLock(profileDir, signal)
    try {
      // A durable commit intent means this profile already passed relink and health.
      // Also recognize a version record published by the preceding journal format.
      const legacyCommit = run.from !== run.to && !run.journal.undo && run.journal.pending === null
        && run.journal.done.length === run.journal.steps.length
        && [nextCurrent(), versionRecord()].some(record => isDeepStrictEqual(read('current.json'), record))
      if (relinked && (run.journal.commitCurrent || legacyCommit
        || (run.journal.relinked === true && didSwitch(config, staging, run)))) {
        try {
          assertRelinked(profileDir, staging)
        } catch (error) {
          if (run.phase !== 'switching' || run.journal.relinked !== true || run.journal.commitCurrent) throw error
          const held = release
          release = null
          return await undoBeforeTrial(staging, held)
        }
        release()
        release = null
        await restartCandidate(staging)
        return
      }
      if (didSwitch(config, staging, run)) {
        completeSwitch(config, staging, run, save)
        const held = release
        release = null
        await relinkAndRestart(staging, held)
        return
      }
      undoSwitch(config, staging, run, save, 'supervisor-restarted')
      discardArchives(profileDir, staging)
    } finally {
      release?.()
    }
    await giveBack(staging, run.journal.undoReason, true)
  }

  async function update(expectedReinstall) {
    const staging = stagePaths(store, run.runId, profile)
    let release, restart = false, liveChangesStarted = false
    // A reinstall crosses the early-refusal boundary at the first live installer write or child stop.
    const beginLiveChanges = () => { liveChangesStarted = true }
    try {
      if (!listener || !await checked(child)) {
        return expectedReinstall ? refuseReinstall(staging, 'listener-unknown') : phase('notUpdated', 'listener-unknown')
      }
      if (expectedReinstall && (bootEnv.AUTOMAGIK_SUPERVISOR_REINSTALL !== bootId || !reinstallCopies(store))) {
        return refuseReinstall(staging, 'reinstall-unsupported')
      }
      const contract = updateContract(profileDir)
      if (!contract) {
        if (expectedReinstall) return refuseReinstall(staging, 'previous-unsupported')
        return await giveBack(staging, 'profile-invalid', false, { legacy: true })
      }
      config.stateFormats = contract.stateFormats
      const current = readCurrent()
      if (current === null) {
        if (expectedReinstall) return refuseReinstall(staging, 'store-invalid')
        return await giveBack(staging, 'store-invalid', false)
      }
      fs.mkdirSync(staging.root, { mode: 0o700 })
      const view = {}
      const result = await inspectRelease({
        profileDir, current, view, source, fetch, signal, requireAccess: requireLock,
        allowEqual: !!expectedReinstall, expectedReinstall,
        registry: () => installRegistry(config, staging.root, { signal }), getDshVersion: () => dshVersion(command),
        saveTarball: (plugin, bytes) => fs.writeFileSync(downloadPath(staging, plugin), bytes, { flag: 'wx', mode: 0o600 }),
        onPhase: next => {
          const previous = view.plugins.map(plugin => plugin.from).sort(compareVersions)[0]
          save({ phase: next, from: previous, to: view.laneVersion })
        },
      })
      signal.throwIfAborted()
      if (result.state !== 'available') {
        if (expectedReinstall) return refuseReinstall(staging, result.reason)
        return await giveBack(staging, result.reason, false)
      }
      const names = view.plugins.map(plugin => plugin.name)
      const versions = new Map(view.plugins.map(plugin => [plugin.name, plugin.from]))
      save({ phase: 'staging', sequence: view.sequence, names, priorKept: current?.kept?.version ?? null,
        priorCurrent: current ?? null, ...(result.reinstall === true ? { reinstall: true } : {}) })
      release = await takeProfileLock(profileDir, signal)
      await stageInstall(config, staging, result, versions, signal, beginLiveChanges)
      signal.throwIfAborted()
      restart = true
      beginLiveChanges()
      await stop()
      signal.throwIfAborted()
      const journal = planSwitch(config, staging, run)
      if (!journal) {
        discardArchives(profileDir, staging)
        release()
        release = null
        return await giveBack(staging, 'switch-refused', true)
      }
      save({ journal, phase: 'switching' })
      completeSwitch(config, staging, run, save)
      const held = release
      release = null
      await relinkAndRestart(staging, held)
    } catch (error) {
      if (signal.aborted) return
      if (error.code === 'DSH_PROFILE_LOCK_TIMEOUT') warn(error.message)
      if (TERMINAL.has(run.phase)) {
        warn('update cleanup did not finish')
        return
      }
      if (expectedReinstall && !liveChangesStarted) return refuseReinstall(staging, 'stage-failed')
      try {
        if (error instanceof UndoPreflightError) return await undoFailure(staging)
        if (['restarting', 'health'].includes(run.phase) && validJournal(run)) {
          return await rollBack(staging, child?.result ? 'exited' : 'port')
        }
        if (trial) return await manualRecovery(child?.result?.code)
        if (run.journal || release) {
          release ??= await takeProfileLock(profileDir, signal)
          if (run.journal) undoSwitch(config, staging, run, save, 'stage-failed')
          discardArchives(profileDir, staging)
        }
        release?.()
        release = null
        await giveBack(staging, 'stage-failed', restart)
      } catch (error) {
        if (error.code === 'DSH_PROFILE_LOCK_TIMEOUT') warn(error.message)
        if (!signal.aborted) {
          if (error instanceof UndoPreflightError) await undoFailure(staging)
          else await manualRecovery(1, 'rollback-failed')
        }
      }
    } finally {
      release?.()
    }
  }

  try {
    executingCopy = runningCopy(store)
    executingCopy.prune()
    // Only a supervisor that runs the store's own copy announces same-version reinstall: the image host
    // (refreshCopy false) never does until it handles a reinstall at the image's version (RFC 0041, R9).
    if (refresh && reinstallCopies(store)) bootEnv.AUTOMAGIK_SUPERVISOR_REINSTALL = bootId
    if (externalSignal) externalSignal.addEventListener('abort', abort, { once: true })
    else for (const [sig, handler] of Object.entries(forward)) process.on(sig, handler)
    const raw = read('state.json')
    const prior = runOf(raw, [raw?.bootId].filter(isId))
    if (raw !== undefined && prior === null) throw new Error('Invalid state.json in the update store')
    announceListener('unknown')
    announce()
    if (prior && (RUNNING.has(prior.phase) || prior.phase === 'manualRecovery')) {
      recovering = true
      try { await recover(raw) } catch (error) {
        if (error.code === 'DSH_PROFILE_LOCK_TIMEOUT') warn(error.message)
        if (!signal.aborted && error instanceof UndoPreflightError) {
          await undoFailure(stagePaths(store, run.runId, profile))
        } else if (!signal.aborted && ['restarting', 'health'].includes(run.phase) && validJournal(run)) {
          await rollBack(stagePaths(store, run.runId, profile), child?.result ? 'exited' : 'port')
        } else if (!signal.aborted && !TERMINAL.has(run.phase)) {
          await manualRecovery(1, 'rollback-failed')
        }
      } finally {
        recovering = false
        const completed = TERMINAL.has(run.phase)
        recoveredAt = completed ? Date.parse(run.updatedAt) : Date.now()
        if (!verdictFailed && !completed) takeRequest(store, read, bootId, true, seen)
      }
    } else {
      if (raw?.journal != null && !validTerminalJournal(raw)) {
        throw new Error('Invalid terminal journal in the update store')
      }
      start()
      if (prior?.phase === 'healthy' && read('current.json')?.live?.version === prior.to) {
        const staging = stagePaths(store, prior.runId, profile)
        try { await finishHealthy(staging, raw) } catch { warn('update cleanup did not finish') }
      } else if (prior?.phase === 'rolledBack' && raw.journal) {
        try { finishRolledBack(config, stagePaths(store, prior.runId, profile), raw) } catch { warn('update cleanup did not finish') }
      } else if (prior?.phase === 'notUpdated') {
        try {
          discard(stagePaths(store, prior.runId, profile))
          cleanNotUpdatedBackup(raw)
        } catch { warn('update cleanup did not finish') }
      }
      cleanReinstallTrash()
    }
    while (!signal.aborted) {
      if (!active) await checked(child)
      if (signal.aborted) break
      const request = active && TERMINAL.has(run.phase) ? null : takeRequest(store, read, bootId, !!active, seen)
      if (request && (recoveredAt === undefined || Date.parse(request.requestedAt) > recoveredAt)) {
        run = {
          version: 1, runId: randomUUID(), requestId: request.requestId, bootId,
          phase: 'checking', from: null, to: null, reason: null, startedAt: stamp(), startedBy: 'owner-route',
          priorCurrent: readCurrent() ?? null,
        }
        const fromVersions = baseline(profileDir)
        const updatedAt = stamp()
        if (Buffer.byteLength(JSON.stringify({ ...run, fromVersions, updatedAt })) > UPDATE_RECORD_LIMIT) {
          if (request.reinstall) refuseReinstall(stagePaths(store, run.runId, profile), 'profile-invalid')
          else phase('notUpdated', 'profile-invalid')
          announce()
          continue
        }
        save({ fromVersions }, updatedAt)
        announce()
        active = update(request.reinstall).finally(() => {
          try {
            if (!verdictFailed && !TERMINAL.has(run.phase)) takeRequest(store, read, bootId, true, seen)
          } finally { active = null }
        }).catch(() => shutdown(1))
      }
      await wait(IDLE_POLL_MS, undefined, { signal }).catch(() => {})
    }
  } finally {
    controller.abort()
    try {
      if (!verdictFailed) await stop()
      await active
    } finally {
      externalSignal?.removeEventListener('abort', abort)
      for (const [sig, handler] of Object.entries(forward)) process.off(sig, handler)
      try { executingCopy?.release() } finally { lock.release() }
    }
  }
  return exitCode ?? 0
}

async function main(args) {
  if (args.length === 1 && args[0] === '--self-check') {
    supervisorVersion()
    fs.writeSync(1, SELF_CHECK_OK + '\n')
    return 0
  }
  const [verb, homeFlag, home, profileFlag, profile, separator, ...command] = args
  if (homeFlag !== '--dsh-home' || profileFlag !== '--profile') throw new Error('Expected --dsh-home and --profile')
  if (verb === 'run' && separator === '--') return runSupervisor({ home, profile, command, version: copyVersion() })
  if (verb === 'install-copy' && args.length === 5) {
    const { store } = configure(home, profile)
    const lock = storeLock(store)
    try { console.log(await installCopy(store)) } finally { lock.release() }
    return 0
  }
  throw new Error('Expected run, --self-check, or install-copy')
}

let invoked = false
if (process.argv[1]) {
  try { invoked = fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) } catch {}
}
if (invoked) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }, error => {
    warn(error.message)
    process.exitCode = 1
  })
}
