// Plugins the lane staged (lane.js) go in by themselves: once they wait, the app looks every
// minute for a safe moment (no agent at work, as dsh's welcome counts them in busy.json, and no
// one typing in the window) and then restarts DSH alone, inside the same window: DSH stops, the
// staged plugins go in (lane.js beforeStart), DSH starts again on the same port and the page
// loads again. That start is the same trial as an app start's: the page must draw the Bot team
// within TRIAL_MS, or DSH restarts once more with the previous plugins, and that version is
// marked bad (bad.json, as beforeStart keeps it). The setting "Apply plugin updates
// automatically" (<home>/updates.json, on unless switched off) turns the in-app restart off; the
// next start of the app still puts staged plugins in, as before. Pure: main.js passes what it
// read and the steps that touch DSH and the window.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { liveBusy } from './quit-guard.js'

// The person stopped typing or clicking this long ago, when the window is in front.
export const APPLY_IDLE_MS = 60 * 1000

/** Where the app keeps its update settings. */
export const settingsFileOf = home => join(home, 'updates.json')

/** Whether staged plugins go in by themselves: on, unless the person switched it off. */
export function readAutoApply(file, read = readFileSync) {
  try { return JSON.parse(read(file, 'utf8'))?.autoApplyPlugins !== false } catch { return true }
}

export function writeAutoApply(file, on) {
  let settings = {}
  try { settings = JSON.parse(readFileSync(file, 'utf8')) ?? {} } catch {}
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ ...settings, autoApplyPlugins: on === true }, null, 2)}\n`)
  renameSync(`${file}.tmp`, file)
  return on === true
}

/**
 * 'apply' when staged plugins may go in now, else what they wait for. `busy` is idle.js
 * readBusy's answer (null: the welcome does not say, so nothing is restarted under it); `trial`
 * is this start's lane trial; `appUpdate` is an app update that is downloaded or going in (it
 * brings its own plugins, and wins).
 */
export function applyNow({ staged, auto, busy, trial, fetching, appUpdate, applying, idleMs, focused }) {
  if (!staged) return 'nothing staged'
  if (!auto) return 'switched off'
  if (applying) return 'applying'
  if (appUpdate) return 'app update'
  if (trial === 'applied' || trial === 'trial') return 'trial running'
  if (fetching) return 'downloading'
  if (busy === null || busy === undefined) return 'busy unknown'
  if (!stillIdle(busy)) return 'agents at work'
  if (focused && !(idleMs >= APPLY_IDLE_MS)) return 'person here'
  return 'apply'
}

/**
 * Whether no agent is at work by the busy file now: checked again just before DSH stops on the
 * automatic path, since an agent may have started since the minute's look.
 */
export const stillIdle = busy => Boolean(busy) && busy.running === 0

export const CONFIRMATION_MS = 90_000
// Publication timestamps and object allocation are not update identity. The signed lane's
// publisher/sequence and the staged bytes (integrity) are stable across repeated readings.
export function stagedIdentity(staged) {
  if (!staged) return null
  return JSON.stringify([staged.version,
    Object.entries(staged.lanes ?? {}).map(([publisher, lane]) => [publisher, lane.version, lane.sequence])
      .sort(([a], [b]) => a.localeCompare(b)),
    (staged.plugins ?? []).map(({ publisher, name, version, integrity }) => [publisher, name, version, integrity])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))])
}

export function confirmationBudget({ now = () => performance.now(), wall = Date.now,
  timers = globalThis, wake = () => {} } = {}) {
  let child, since, target, until, timer
  const cancel = () => { timers.clearTimeout(timer); timer = undefined }
  const sync = (run) => {
    const next = stagedIdentity(run.staged)
    if (child !== run.child || since !== run.since || target !== next) {
      cancel()
      child = run.child; since = run.since; target = next; until = undefined
    }
  }
  const schedule = () => {
    cancel()
    if (until <= now()) return
    timer = timers.setTimeout(() => {
      timer = undefined
      if (until > now()) schedule()
      else wake()
    }, Math.max(0, until - now()))
    timer.unref?.()
  }
  return {
    sync,
    reset() { cancel(); child = since = target = until = undefined },
    read(busy, run) {
      sync(run)
      const current = liveBusy(busy, run)
      if (!current || !target) return null
      const modern = Object.hasOwn(current, 'logins') || Object.hasOwn(current, 'confirming')
      if (!modern || current.confirming === 0) return current
      // Missing/malformed confirmation metadata can hold only this same bounded budget.
      // Never synthesize an idle base reading or erase a positive actual-agent count.
      const clock = now()
      let next = until ?? clock + CONFIRMATION_MS
      const remaining = current.confirmingUntil - wall()
      if (Number.isFinite(current.confirmingUntil) && Number.isFinite(current.at)
        && current.confirmingUntil >= current.at && current.confirmingUntil - current.at <= CONFIRMATION_MS) {
        next = Math.min(next, clock + Math.max(0, remaining))
      }
      if (next !== until) { until = next; schedule() }
      return until > clock ? { ...current, running: Math.max(1, current.running) } : current
    },
  }
}

/**
 * Each plugin that changes: { name, from, to }. `plugins` are the lane's (staged, or being
 * downloaded), `installed` what the profile has now (lane.js installedVersions).
 */
export function changesOf(plugins, installed) {
  return (plugins ?? [])
    .filter(plugin => typeof plugin?.name === 'string' && typeof plugin.version === 'string')
    .map(plugin => ({ name: plugin.name, ...(typeof installed?.[plugin.name] === 'string' ? { from: installed[plugin.name] } : {}), to: plugin.version }))
}

/** An error that is the app's own doing (a quit, a window that went), not the plugins'. */
export const appStopped = message => Object.assign(new Error(message), { code: 'app' })
const byApp = error => error?.code === 'app'

/**
 * What a failed restart step was: the app's own doing when the app is quitting, or DSH was stopped
 * by something other than the restart (a quit stops it before the app says it is quitting, while
 * no DSH process runs yet); else the plugins'. Answers the error to throw.
 */
export function causeOf(error, { quitting, stopped }) {
  if (byApp(error) || !(quitting || stopped)) return error
  return appStopped(`the app is quitting (${error?.message ?? error})`)
}

/**
 * Puts staged plugins in with DSH restarted alone, and judges the result. `cycle(prepare)` stops
 * DSH, runs `prepare` while it is down (beforeStart: it answers 'applied', 'restored', 'trial' or
 * null), starts DSH again and loads the page; it rejects when DSH does not come up. `judge()`
 * answers whether the page drew the Bot team. A failed trial (no drawing, or no DSH) is told to
 * the lane (`trialFailed`) and DSH is cycled once more, which brings the previous plugins back
 * and marks the version bad. A step that fails by the app's own doing (`appStopped`: a quit
 * under way) is no verdict on the plugins: the trial stays as it was, for the next start of the
 * app to run. Answers 'good', 'restored', 'unchanged' (nothing went in), or 'down' (DSH is not
 * back; the caller restarts the app, unless it is quitting).
 */
export async function applyStaged({ cycle, beforeStart, confirm, trialFailed, judge, log = () => {} }) {
  let prepared = null
  let state
  try {
    state = await cycle(() => (prepared = beforeStart()))
  } catch (error) {
    // DSH did not come up: a trial that failed when the plugins went in, else DSH is down with
    // nothing changed, and only a start of the app brings it back.
    log(`lane: DSH did not come back after the restart for the plugins (${error?.message ?? error})`)
    if (prepared !== 'applied' || byApp(error)) return 'down'
    state = 'failed'
  }
  if (state !== 'applied' && state !== 'failed') return 'unchanged'
  let drawn = false
  if (state === 'applied') {
    try {
      drawn = await judge()
    } catch (error) {
      if (byApp(error)) return 'down'
      throw error
    }
  }
  if (drawn) {
    confirm()
    log('lane: the trial passed; the Bot team is drawn')
    return 'good'
  }
  if (state === 'applied') log('lane: the Bot team never drew; DSH starts again with the previous plugins')
  trialFailed()
  try {
    const back = await cycle(beforeStart)
    return back === 'restored' ? 'restored' : 'down'
  } catch (error) {
    log(`lane: DSH did not come back with the previous plugins either (${error?.message ?? error})`)
    return 'down'
  }
}
