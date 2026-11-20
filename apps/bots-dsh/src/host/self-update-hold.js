// The web self-update's click, on the plugin's side (RFC 0041 delivery 5b, "Stopping and resuming work").
//
// The owner's start (`self-update-start`, channel.js) closes admission, notes and stops the team's running turns,
// and only then asks the supervisor for the update through request.json. While the hold is closed every step of
// every agent waits at agent/pre-step (input it already took is noted, resume.js rt.noteHeldInput), and the
// composer says an update is running. The hold follows the supervisor's state.json (self-update.js): a healthy,
// rolled-back or not-updated verdict opens it; manual recovery keeps it closed. A start that DSH sees with a
// live update still running (the trial of a new version, or the unchanged one given back) begins closed, and the
// resume pass waits for the verdict through rt.updateGate.
import { randomUUID } from 'node:crypto'
import { CHECK_FRESH_MS } from '../shared/self-update.js'
import { join, resolve } from 'node:path'
import { UPDATE_CUT } from './constants.js'
import { teamHomeOf } from './folders.js'
import { savedResult } from './self-update-check.js'
import { supervisorOf, usableStore, writeJsonAtomic } from './self-update.js'
import { isId, RUNNING } from './supervisor/records.js'
import { readJson } from './supervisor/store.js'

export { CHECK_FRESH_MS }
export const POLL_MS = 1000
// How long the click waits for the running turns it stopped to end before it asks for the update.
export const STOP_WAIT_MS = 10_000
// The supervisor removes request.json on its next poll, whether it takes the request or not.
export const GONE_WAIT_MS = 5000
// A request is accepted while it is younger than 60 s (supervisor/request.js), plus two of its polls.
export const UNANSWERED_MS = 65_000
// 5a's slowest steps (a 120 s lock wait, 120 s per DSH/pnpm command, 60 s of health) write no phase while they run.
export const STALL_MS = 20 * 60_000
// A supervised start waits this long for its first readable status.
export const PROFILE_WAIT_MS = 60_000
const VERDICTS = new Set(['healthy', 'rolledBack', 'notUpdated'])

/**
 * The hold's state machine, with its inputs injected so it can be driven by a test clock.
 * - readStatus(): { supervised, profileKnown, readable, run } where run is the live run of this supervisor boot or null.
 * - requestPresent(requestId): whether request.json still holds our request.
 * - onResume(): picks up, in this run, the work this process stopped (an update that did not happen).
 */
export function createUpdateHold({ readStatus, expectedRun, requestPresent = () => false, onResume = () => {}, bootPlan = () => {}, warn = () => {}, now = Date.now, schedule = (fn, ms) => setTimeout(fn, ms) }) {
  let state = 'unknown'
  let ours = null
  let firstAt
  let disposed = false
  let manualWarned = false
  let timer
  let observedRun
  let stalledWarned = false
  const waiters = new Set()
  let gate = Promise.withResolvers()

  const awaitingVerdict = () => state === 'closed' || state === 'manual'
  const closed = () => awaitingVerdict() || state === 'releasing'
  function poll() {
    if (timer !== undefined || !awaitingVerdict()) return
    if (disposed && waiters.size === 0) return
    timer = schedule(() => {
      timer = undefined
      tick()
      poll()
    }, POLL_MS)
    timer?.unref?.()
  }
  function open(reason) {
    const request = ours
    const bootHeld = request === null && awaitingVerdict()
    state = 'releasing'
    ours = null
    gate.resolve(reason)
    if (reason === 'request-unanswered' || reason === 'profile-unknown') {
      warn('ds-bot: the web self-update hold opened: %s', reason)
    }
    const releaseWaiters = () => {
      state = 'open'
      for (const waiter of waiters) waiter.resolve()
      waiters.clear()
    }
    // The boot pass can now reserve its recovery destinations before admitting held steps.
    const plan = disposed ? undefined : bootHeld ? bootPlan()
      : request?.ownsTeam() ? onResume(reason, request.ownsTeam) : undefined
    if (plan === undefined) releaseWaiters()
    else void Promise.resolve(plan).then(releaseWaiters, error => {
      warn('ds-bot: picking up the work an update stopped failed: %s', error?.message ?? error)
      releaseWaiters()
    })
  }
  function decide(run) {
    if (VERDICTS.has(run.phase)) {
      if (expectedRun === run.runId) expectedRun = undefined
      return open(run.phase)
    }
    if (run.phase === 'manualRecovery') {
      observedRun = run.runId
      state = 'manual'
      if (!manualWarned) warn('ds-bot: the web self-update needs manual recovery; new work stays held')
      manualWarned = true
      return
    }
    if (!RUNNING.has(run.phase)) return
    observedRun = run.runId
    state = 'closed'
    const moved = Date.parse(run.updatedAt)
    if (!stalledWarned && Number.isFinite(moved) && now() - moved > STALL_MS) {
      stalledWarned = true
      warn('ds-bot: the web self-update has stopped making progress; new work stays held')
    }
    return run.runId
  }
  function tick() {
    if (state !== 'unknown' && !awaitingVerdict()) return
    if (ours !== null && ours.writtenAt === undefined) return
    let status
    try { status = readStatus() } catch { status = { supervised: true, profileKnown: false, run: null } }
    firstAt ??= now()
    const known = status.profileKnown && status.readable !== false
    const run = status.supervised && !known ? null : status.run
    if (ours !== null) {
      // A verdict from an earlier run cannot answer this click.
      if (run?.requestId === ours.requestId) return decide(run)
      if (observedRun !== undefined) return
      const time = now()
      if (requestPresent(ours.requestId)) {
        ours.goneAt = undefined
        if (time - ours.writtenAt > UNANSWERED_MS) open('request-unanswered')
        return
      }
      // After the supervisor takes the file, only readable status can rule out acceptance.
      if (!known) {
        ours.goneAt = undefined
        return
      }
      ours.goneAt ??= time
      if (time - ours.goneAt > GONE_WAIT_MS) open('request-unanswered')
      return
    }
    if (expectedRun !== undefined) {
      if (run?.runId === expectedRun) return decide(run)
      if (state === 'unknown') state = 'closed'
      return
    }
    if (observedRun !== undefined) {
      if (run?.runId === observedRun) return decide(run)
      return
    }
    if (status.supervised && !known) {
      if (now() - firstAt < PROFILE_WAIT_MS) {
        state = 'closed'
        return
      }
      if (!status.profileKnown) return open('profile-unknown')
      warn('ds-bot: the web self-update status could not be read; new work can go on')
      return open('no-update')
    }
    if (run && (RUNNING.has(run.phase) || run.phase === 'manualRecovery')) return decide(run)
    open('no-update')
  }
  function firstUse() {
    if (state !== 'unknown') return
    tick()
    poll()
  }

  return {
    get closed() { firstUse(); return closed() },
    get state() { return state },
    get awaitingVerdict() { return awaitingVerdict() },
    get awaitingBootVerdict() { firstUse(); return expectedRun !== undefined },
    firstUse,
    proof() {
      firstUse()
      const liveRun = tick()
      return { state, run: state === 'closed' ? liveRun ?? null : null }
    },
    tick,
    /** Close admission for our own request (the owner's click). */
    close(requestId, ownsTeam = () => true) {
      firstUse()
      ours = { requestId, ownsTeam, writtenAt: undefined, goneAt: undefined }
      observedRun = undefined
      stalledWarned = false
      manualWarned = false
      state = 'closed'
      gate = Promise.withResolvers()
      poll()
    },
    owns(requestId) { return !disposed && state === 'closed' && ours?.requestId === requestId },
    /** request.json is written: the unanswered clock starts. */
    wrote() { if (ours) ours.writtenAt = now() },
    /** The click failed before the request: reopen and give the stopped work back. */
    release(requestId, reason) { if (ours?.requestId === requestId && awaitingVerdict()) open(reason) },
    /** Resolves once the hold opens on a verdict (never on manual recovery); rejects on abort. */
    gate(signal) {
      firstUse()
      if (signal?.aborted) return Promise.reject(signal.reason)
      if (!awaitingVerdict()) return Promise.resolve()
      const wait = gate.promise
      if (!signal) return wait.then(() => {})
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
        wait.then(() => { signal.removeEventListener('abort', onAbort); resolve() })
      })
    },
    /** A held step waits here: resolves when the hold opens, rejects when the step is aborted. */
    wait(signal) {
      firstUse()
      if (!closed()) return Promise.resolve()
      return new Promise((resolve, reject) => {
        const waiter = { resolve: () => { signal?.removeEventListener?.('abort', onAbort); resolve() } }
        const onAbort = () => { waiters.delete(waiter); reject(signal.reason) }
        if (signal?.aborted) return reject(signal.reason)
        signal?.addEventListener?.('abort', onAbort, { once: true })
        waiters.add(waiter)
        poll()
      })
    },
    /** After dispose the poll only lets held steps go on a verdict; it never resumes. */
    dispose() {
      disposed = true
    },
  }
}

const refuse = reason => ({ started: false, reason })

export function install(rt) {
  const { ctx } = rt
  const env = process.env
  const profileOf = () => ctx.get?.('profileContext')?.dir
  const supervised = () => supervisorOf(env) !== null
  const requestPresent = (requestId, profileDir = profileOf()) => {
    const check = () => usableStore(profileDir)
    return readJson(check, check(), 'request.json')?.requestId === requestId
  }
  const expected = env.AUTOMAGIK_SUPERVISOR_RUN
  const hold = createUpdateHold({
    expectedRun: supervised() && isId(expected) ? expected : undefined,
    readStatus: () => {
      const profileDir = profileOf()
      if (typeof profileDir !== 'string') return { supervised: supervised(), profileKnown: false, run: null }
      const status = rt.selfUpdateStatus()
      const readable = !status.problem && status.reason !== 'no-supervisor' && status.reason !== 'no-store'
        && (status.available || usableStore(profileDir) !== undefined)
      return { supervised: supervised(), profileKnown: true, readable, run: status.run }
    },
    requestPresent,
    onResume: (_reason, ownsTeam) => rt.resumeUpdateStopped?.(ownsTeam),
    bootPlan: () => rt.resumeDestinationsPlanned,
    warn: (...args) => rt.warn?.(...args),
  })
  rt.updateHoldView = () => hold.closed
  rt.updateGate = signal => hold.gate(signal)

  rt.updateHold = hold

  const ended = new Map()
  rt.updateTurnEnded = (id) => {
    const done = ended.get(id)
    if (done) { ended.delete(id); done() }
  }
  // Register before cancel: a turn can end while its note is still being written.
  async function waitStopped(ids) {
    if (ids.length === 0) return 0
    const pending = ids.map(id => new Promise(resolve => ended.set(id, resolve)))
    const timeout = Promise.withResolvers()
    const timer = setTimeout(() => timeout.resolve(ids.filter(id => ended.has(id)).length), STOP_WAIT_MS)
    timer.unref()
    try {
      return await Promise.race([Promise.all(pending).then(() => 0), timeout.promise])
    } finally {
      clearTimeout(timer)
      for (const id of ids) ended.delete(id)
    }
  }

  function startEligibility({ ownsTeam, status, force } = {}) {
    if (rt.config?.selfUpdate !== true) return { reason: 'self-update-off' }
    if (force) {
      // A supervisor can inherit this variable from its service. Only this boot's value counts.
      const rollback = env.AUTOMAGIK_SUPERVISOR_ROLLBACK
      if (typeof rollback !== 'string' || rollback === '' || rollback !== env.AUTOMAGIK_SUPERVISOR_BOOT) {
        return { reason: 'rollback-missing' }
      }
    }
    status ??= rt.selfUpdateStatus()
    if (force && status.problem) return { reason: 'store-invalid' }
    if (hold.closed || (status.run && (RUNNING.has(status.run.phase) || status.run.phase === 'manualRecovery'))) {
      return { reason: 'update-running' }
    }
    if (!status.available) return { reason: status.reason }
    const profileDir = profileOf()
    const saved = savedResult(profileDir)
    const checkedAt = Date.parse(saved?.checkedAt)
    const now = Date.now()
    if (saved?.state !== 'available' || !Number.isFinite(checkedAt) || now - checkedAt >= CHECK_FRESH_MS || now < checkedAt) {
      return { reason: 'check-stale' }
    }
    // The startup pass owns the predecessor's notes until it finishes.
    if (rt.resumeBootPending?.()) return { reason: 'starting-up' }
    // The supervisor snapshots the team file at the home the service's environment names.
    if (resolve(rt.statePath) !== join(teamHomeOf(env), 'state.json')) return { reason: 'team-home-custom' }
    if (ownsTeam && (!ownsTeam() || rt.readOnly?.() !== undefined)) return { reason: 'bot/read-only' }
    const supervisor = supervisorOf(env)
    const store = usableStore(profileDir)
    if (supervisor === null || store === undefined) return { reason: 'no-store' }
    return { reason: null, profileDir, supervisor, path: join(store, 'request.json') }
  }
  rt.selfUpdateStartRefusal = status => startEligibility({ status }).reason

  rt.selfUpdateStart = async (ownsTeam = () => rt.holdsLock?.() === true, { force } = {}) => {
    const { reason, profileDir, supervisor, path } = startEligibility({ ownsTeam, force })
    if (reason !== null) return refuse(reason)

    const requestId = randomUUID()
    const stillOwnsTeam = () => !rt.updateShuttingDown() && ownsTeam() && rt.readOnly?.() === undefined
    hold.close(requestId, stillOwnsTeam)
    const giveBack = (reason) => {
      hold.release(requestId, reason)
      return refuse(reason)
    }

    const sessionId = agent => agent.session?.id ?? agent.id
    try {
      const agents = ctx.get?.('agents')?.list?.() ?? []
      const inboxNotes = rt.noteUpdateInboxes?.(agents)
      const cut = agents.filter(agent => agent.status === 'running'
        && agent.session?.header?.origin !== 'subagent' && agent.session?.header?.isSeeded !== true
        && rt.updateHealable?.(sessionId(agent)) === true)
      const ids = cut.map(sessionId)
      const stopped = waitStopped(ids)
      // Mark and cut in the same tick so a turn cannot finish normally between the two.
      const written = rt.markUpdateStop?.(ids)
      for (const agent of cut) {
        try { agent.cancel({ kind: 'hook', reason: UPDATE_CUT }, { keepInbox: true }) } catch (error) {
          rt.warn?.('ds-bot: stopping %s for the update failed: %s', agent.id, error?.message ?? error)
        }
      }
      const [stillRunning, noted, inboxesNoted] = await Promise.all([stopped, written, inboxNotes])
      if (!stillOwnsTeam()) return giveBack('bot/read-only')
      // A turn can give back joined requests while ending. Save those and the latest inbox notes too.
      if (noted !== true || inboxesNoted === false) return giveBack('notes-unwritable')
      const result = await rt.flushUpdateNotes(() => {
        if (!stillOwnsTeam()) return giveBack('bot/read-only')
        if (!hold.owns(requestId)) return giveBack('update-running')
        try {
          writeJsonAtomic(path, { version: 1, requestId, bootId: supervisor.bootId, requestedAt: new Date().toISOString() },
            { profileDir, durable: true })
        } catch (error) {
          // A directory sync can fail after rename. The supervisor can already see that request.
          if (!error?.renamed && !requestPresent(requestId, profileDir)) throw error
        }
        hold.wrote()
        return { started: true, requestId, stopped: ids.length, stillRunning }
      })
      return result === false ? giveBack(stillOwnsTeam() ? 'notes-unwritable' : 'bot/read-only') : result
    } catch (error) {
      rt.warn?.('ds-bot: the web self-update could not be asked for: %s', error?.message ?? error)
      return giveBack('no-store')
    }
  }

  // DSH tears down its agents on these signals. Their discards must not acknowledge held input.
  let shuttingDown = false
  const shutdown = () => { shuttingDown = true }
  rt.updateShuttingDown = () => shuttingDown
  if (supervised()) {
    process.prependListener('SIGTERM', shutdown)
    process.prependListener('SIGINT', shutdown)
  }
  return () => {
    shuttingDown = true
    process.removeListener('SIGTERM', shutdown)
    process.removeListener('SIGINT', shutdown)
    hold.dispose()
  }
}
