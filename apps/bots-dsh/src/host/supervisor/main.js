import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { hostname } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { compareVersions } from '../lane-verify.js'
import { answers, startChild } from './child.js'
import { copyVersion, installCopy, refreshCopy, runningCopy, SELF_CHECK_OK, supervisorVersion } from './copy.js'
import { installRegistry } from './pnpm.js'
import { currentOf, isId, isVersion, RUNNING, runOf } from './records.js'
import { inspectRelease, installedPlugins, releaseSource } from './release.js'
import { takeRequest } from './request.js'
import { assertRelinked, discardArchives, downloadPath, relink, stageInstall, stagePaths, takeProfileLock } from './stage.js'
import { identity, prepareStore, readJson, regularBytes, takeLifetimeLock, usableStore, writeJsonAtomic } from './store.js'
import { candidateMatches, completeSwitch, didSwitch, planSwitch, undoSwitch, validJournal } from './switch.js'

const IDLE_POLL_MS = 1000
const stamp = () => new Date().toISOString()
const warn = message => console.error(`automagik supervisor: ${message}`)

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
  healthTimeout,
}) {
  if (!isVersion(version)) throw new Error('Invalid supervisor copy version')
  const source = releaseSource(laneUrl, keys)
  if (!source) throw new Error('Invalid supervisor release source')
  const config = configure(home, profile, command, env)
  const { store, profileDir } = config
  const lock = storeLock(store)
  const bootId = `sup_${randomUUID()}`
  const controller = new AbortController()
  const { signal } = controller
  const bootEnv = { ...env, DSH_HOME: config.home, AUTOMAGIK_SUPERVISOR_BOOT: bootId, AUTOMAGIK_SUPERVISOR_VERSION: version }
  const seen = new Set()
  let child, run, active, exitCode, recoveredAt
  let trial = false
  let executingCopy

  function requireLock() {
    if (!lock.owns()) throw new Error('The update store lock changed')
  }
  const checkedStore = () => {
    const checked = usableStore(profileDir)
    return checked && fs.realpathSync(checked) === store ? store : undefined
  }
  const read = file => readJson(checkedStore, store, file)
  const write = (file, value) => {
    requireLock()
    writeJsonAtomic(join(store, file), value, { profileDir, durable: true })
  }
  const announce = () => write('supervisor.json', { version: 1, bootId, runId: run?.runId ?? null })
  const save = (changes = {}) => {
    Object.assign(run, changes, { updatedAt: stamp() })
    write('state.json', run)
  }
  const phase = (next, reason = null) => save({ phase: next, reason })

  function shutdown(code) {
    exitCode ??= code
    controller.abort()
  }
  function start() {
    signal.throwIfAborted()
    child = startChild(command, bootEnv, ended => {
      if (!ended.expectedExit && !trial) shutdown(ended.result.code)
    })
    return child
  }
  const stop = async (sig) => {
    if (child) await child.stop(sig)
  }
  // The signal the service sent goes to DSH first; the shutdown that follows never sends a second one.
  const forward = Object.fromEntries(['SIGTERM', 'SIGINT', 'SIGHUP'].map(sig => [sig, () => {
    void stop(sig)
    shutdown(0)
  }]))

  function discard(staging) {
    fs.rmSync(staging.root, { recursive: true, force: true })
  }

  function finishNotUpdated(staging, prior = run) {
    discard(staging)
    if (validJournal(prior) && prior.journal.undo && prior.journal.pending === null && prior.journal.done.length === 0) {
      fs.rmSync(join(store, prior.journal.keep), { recursive: true, force: true })
    }
  }

  const serving = target => answers(target, { signal, timeout: healthTimeout })

  async function giveBack(staging, reason, restart) {
    signal.throwIfAborted()
    // A child exiting during the health check belongs to this verdict.
    trial = true
    const unchanged = restart ? start() : child
    if (!await serving(unchanged)) {
      signal.throwIfAborted()
      return manualRecovery(unchanged.result?.code)
    }
    // Clean up first: whoever reads the verdict finds no staging left behind.
    finishNotUpdated(staging)
    phase('notUpdated', reason)
    trial = false
  }

  async function manualRecovery(code = 1, reason = 'health-failed') {
    phase('manualRecovery', reason)
    warn('manual recovery is required; see state.json in the update store')
    shutdown(code || 1)
    await stop()
  }

  async function relinkAndRestart(staging, releaseLock) {
    let released = false
    try {
      if (!candidateMatches(config, staging, run)) throw new Error('The switched inputs changed before relink')
      run.journal.relinking = true
      save()
      releaseLock()
      released = true
      await relink(config, signal)
      if (!candidateMatches(config, staging, run)) throw new Error('The relink changed the switched inputs')
      assertRelinked(profileDir, staging)
    } catch {
      const release = released ? await takeProfileLock(profileDir, signal) : releaseLock
      try {
        signal.throwIfAborted()
        undoSwitch(config, staging, run, save, 'stage-failed')
        discardArchives(profileDir, staging)
      } finally {
        release()
      }
      return giveBack(staging, 'stage-failed', true)
    }
    await restartCandidate(staging)
  }

  const nextCurrent = () => ({
    version: 1, live: { version: run.to, sequence: run.sequence },
    kept: { version: run.from }, lastSequence: run.sequence,
  })

  async function restartCandidate(staging) {
    phase('restarting')
    trial = true
    const candidate = start()
    phase('health')
    const answering = await serving(candidate)
    signal.throwIfAborted()
    let versionsMatch = false
    if (answering) {
      try {
        versionsMatch = isDeepStrictEqual(installedPlugins(profileDir), new Map(run.names.map(name => [name, run.to])))
      } catch {}
    }
    if (!versionsMatch || candidate.result) return manualRecovery(candidate.result?.code)
    run.journal.commitCurrent = true
    save()
    write('current.json', nextCurrent())
    phase('healthy', 'health-check-finished')
    trial = false
    await finishHealthy(staging)
  }

  async function finishHealthy(staging, { priorKept, to, from, names } = run) {
    if (isVersion(priorKept) && priorKept !== to && priorKept !== from) {
      try { fs.rmSync(join(store, 'versions', priorKept), { recursive: true, force: true }) } catch {
        warn('the older kept version could not be removed')
      }
    }
    discard(staging)
    if (!Array.isArray(names) || !names.includes('@automagik/bots-dsh')) return
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
      return giveBack(staging, 'supervisor-restarted', true)
    }
    if (!validJournal(run) || !Number.isSafeInteger(run.sequence) || run.sequence < 0) {
      return manualRecovery(1, 'rollback-failed')
    }

    let release = await takeProfileLock(profileDir, signal)
    try {
      // A durable commit intent means this profile already passed relink and health.
      // Also recognize a version record published by the preceding journal format.
      const legacyCommit = !run.journal.undo && run.journal.pending === null
        && run.journal.done.length === run.journal.steps.length && isDeepStrictEqual(read('current.json'), nextCurrent())
      if (run.journal.commitCurrent || legacyCommit) {
        if (!candidateMatches(config, staging, run)) throw new Error('The committed inputs changed')
        assertRelinked(profileDir, staging)
        run.journal.commitCurrent = true
        save()
        write('current.json', nextCurrent())
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

  async function update() {
    const staging = stagePaths(store, run.runId, profile)
    let release, restart = false
    try {
      const raw = read('current.json')
      const current = currentOf(raw, [bootId])
      if (raw !== undefined && !current) return await giveBack(staging, 'store-invalid', false)
      fs.mkdirSync(staging.root, { mode: 0o700 })
      const view = {}
      const result = await inspectRelease({
        profileDir, current, view, source, fetch, signal, requireAccess: requireLock,
        registry: dir => installRegistry(dir, bootEnv, signal), getDshVersion: () => dshVersion(command),
        saveTarball: (plugin, bytes) => fs.writeFileSync(downloadPath(staging, plugin), bytes, { flag: 'wx', mode: 0o600 }),
        onPhase: next => {
          const previous = view.plugins.map(plugin => plugin.from).sort(compareVersions)[0]
          save({ phase: next, from: previous, to: view.laneVersion })
        },
      })
      signal.throwIfAborted()
      if (result.state !== 'available') return await giveBack(staging, result.reason, false)
      const names = view.plugins.map(plugin => plugin.name)
      const versions = new Map(view.plugins.map(plugin => [plugin.name, plugin.from]))
      save({ phase: 'staging', sequence: view.sequence, names, priorKept: current?.kept?.version ?? null })
      release = await takeProfileLock(profileDir, signal)
      await stageInstall(config, staging, result, versions, signal)
      signal.throwIfAborted()
      restart = true
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
    } catch {
      if (signal.aborted) return
      if (run.phase === 'healthy' || run.phase === 'notUpdated') {
        warn('update cleanup did not finish')
        return
      }
      try {
        if (trial) return await manualRecovery(child?.result?.code)
        if (run.journal || release) {
          release ??= await takeProfileLock(profileDir, signal)
          if (run.journal) undoSwitch(config, staging, run, save, 'stage-failed')
          discardArchives(profileDir, staging)
        }
        release?.()
        release = null
        await giveBack(staging, 'stage-failed', restart)
      } catch {
        if (!signal.aborted) await manualRecovery(1, 'rollback-failed')
      }
    } finally {
      release?.()
    }
  }

  try {
    executingCopy = runningCopy(store)
    executingCopy.prune()
    for (const [sig, handler] of Object.entries(forward)) process.on(sig, handler)
    const raw = read('state.json')
    const prior = runOf(raw, [raw?.bootId].filter(isId))
    if (raw !== undefined && prior === null) throw new Error('Invalid state.json in the update store')
    announce()
    if (prior && (RUNNING.has(prior.phase) || prior.phase === 'manualRecovery')) {
      try { await recover(raw) } catch {
        if (!signal.aborted) await manualRecovery(1, 'rollback-failed')
      } finally {
        recoveredAt = Date.now()
        takeRequest(store, read, bootId, true, seen)
      }
    } else {
      if (raw?.journal != null && (!validJournal(raw) || raw.journal.pending !== null
        || raw.journal.done.length !== (raw.journal.undo ? 0 : raw.journal.steps.length))) {
        throw new Error('Invalid terminal journal in the update store')
      }
      start()
      if (prior?.phase === 'healthy' && read('current.json')?.live?.version === prior.to) {
        const staging = stagePaths(store, prior.runId, profile)
        try { await finishHealthy(staging, raw) } catch { warn('update cleanup did not finish') }
      } else if (prior?.phase === 'notUpdated') {
        try { finishNotUpdated(stagePaths(store, prior.runId, profile), raw) } catch { warn('update cleanup did not finish') }
      }
    }
    while (!signal.aborted) {
      const request = takeRequest(store, read, bootId, !!active, seen)
      if (request && (recoveredAt === undefined || Date.parse(request.requestedAt) > recoveredAt)) {
        run = {
          version: 1, runId: randomUUID(), requestId: request.requestId, bootId,
          phase: 'checking', from: null, to: null, reason: null, startedAt: stamp(), startedBy: 'owner-route',
        }
        save()
        announce()
        active = update().finally(() => {
          try { takeRequest(store, read, bootId, true, seen) } finally { active = null }
        }).catch(() => shutdown(1))
      }
      await wait(IDLE_POLL_MS, undefined, { signal }).catch(() => {})
    }
  } finally {
    controller.abort()
    try {
      await stop()
      await active
    } finally {
      for (const [sig, handler] of Object.entries(forward)) process.off(sig, handler)
      try { executingCopy?.release() } finally { lock.release() }
    }
  }
  return exitCode ?? 0
}

async function main(args) {
  if (args.length === 1 && args[0] === '--self-check') {
    supervisorVersion()
    console.log(SELF_CHECK_OK)
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
