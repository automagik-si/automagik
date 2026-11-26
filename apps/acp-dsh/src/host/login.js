// Human sign-in to the exact CLI the ACP adapter uses (plan v3, 2.3). No model, transcript,
// tool or credential-store API is involved: the CLI owns OAuth and persists its own
// credentials, and this module only relays its link, its code prompt and its answer.
//
// The attempt lives here, in the host; a page is only a view of it. There is one attempt per
// agent, Claude Code and Codex independently, and any view of the DSH owner may read it: a
// second window, a reloaded page or another Bot gets the live attempt back (`current`, and
// `start` while one runs), and reading it never cancels it. The owner is the only principal
// that reaches these calls (the Bot team's route is an owner-only DSH Fetch route), so the
// `label` a caller passes (the Bot that opened it) is a name for the cancel confirmation, not a
// capability. Only an explicit cancel, the expiry, a failure or the plugin's disposal end it.
//
// Expiry: the provider's own when its answer reports one; otherwise the app's limit, counted
// from the moment the link is shown (LINK_TTL_MS). Before the link, the CLI has STARTUP_MS to
// print it. After a Claude code is sent, the CLI has ANSWER_TIMEOUT_MS to confirm it.
//
// Secrets: the Claude `state` (the part after # in the pasted code) is kept only while the
// attempt waits. A keyed hash of every state shown is kept in memory for STATE_TTL_MS, so the
// Bot team can refuse a message that carries one (`textMatches`) without ever holding it. The
// same holds for the state of an Antigravity sign-in link (#2048, `rememberCallbackState`): a
// message carrying the address the browser ends on (`…state=<s>…`) is refused the same way.
/* eslint-disable no-control-regex -- Reject control characters in input and strip terminal decoration. */
import { spawn as spawnProcess } from 'node:child_process'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { LoginProcess } from './login-process.js'
import { recordLogin } from './login-ownership.js'
import { launchWindowsLogin, windowsJobName } from './windows-login.js'
import { processBirth } from './process-identity.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { AGENTS, signedInOf } from './agents.js'
import { batchSafe } from './batch-spawn.js'

// The app's own limit when the provider reports none, from the link shown.
export const LINK_TTL_MS = 10 * 60 * 1000
// A provider's reported expiry is honoured up to this long.
export const PROVIDER_TTL_MAX_MS = 60 * 60 * 1000
// How long the CLI has to print its link.
export const STARTUP_MS = 45_000
// How long the CLI has to confirm a pasted Claude code (H4).
export const ANSWER_TIMEOUT_MS = 90_000
// How long an ended attempt can still be read by its id.
export const RETAIN_MS = 60_000
// How long a shown Claude state is still recognised in a message.
export const STATE_TTL_MS = 24 * 60 * 60 * 1000
const OUTPUT_LIMIT = 64 * 1024
const ACTIVE = new Set(['starting', 'waiting'])
const STATE = /^[A-Za-z0-9_-]{8,512}$/
// The Antigravity guard (#2048, paste-back), the same words as the Bot team's client copy
// (bots-dsh cli-login-model.js): at most this many `state=` / `state%3d` occurrences per
// reading, and the text after each one, cut at a 512-character state fully percent-encoded.
const CALLBACK_OCCURRENCES = 64
const CALLBACK_TOKEN = 3 * 512
const CALLBACK_STATE = /^[^\p{Cc}\s]{8,512}$/u

// The authority after the last literal `://` before `at`, up to the first `/`, `?`, `#`, `\`,
// whitespace or the end of the reading, lowercased. Nothing is decoded first, so a Google
// link's percent-encoded `redirect_uri` holds no `://` of its own.
function authorityBefore(reading, at) {
  const scheme = reading.lastIndexOf('://', at - 3)
  if (scheme < 0) return undefined
  const rest = reading.slice(scheme + 3, scheme + 3 + 64)
  const end = rest.search(/[/?#\\\s]/u)
  return (end < 0 ? rest : rest.slice(0, end)).toLowerCase()
}

// One decode of a token, run by run: a malformed escape stays as it is and never throws.
const decodeRuns = token => token.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
  try { return decodeURIComponent(run) } catch { return run }
})

/**
 * The texts that may start with an Antigravity state in one reading: for each `state=` or
 * `state%3d` (any case, at most CALLBACK_OCCURRENCES), the text after it and its decoded copy,
 * unless the occurrence belongs to Google's own sign-in link (the authority after the last
 * literal `://` before it is `accounts.google.com`). No URL is parsed.
 * @param {string} reading
 * @returns {string[]}
 */
export function callbackTokens(reading) {
  const tokens = []
  let count = 0
  for (const match of reading.matchAll(/state(?:=|%3d)/giu)) {
    if (++count > CALLBACK_OCCURRENCES) break
    if (authorityBefore(reading, match.index) === 'accounts.google.com') continue
    const start = match.index + match[0].length
    const token = reading.slice(start, start + CALLBACK_TOKEN)
    tokens.push(token, decodeRuns(token))
  }
  return tokens
}
const URL_PATHS = {
  'acp-codex': new Set(['auth.openai.com/codex/device']),
  'acp-claude': new Set(['claude.com/cai/oauth/authorize', 'claude.ai/oauth/authorize', 'platform.claude.com/oauth/authorize', 'console.anthropic.com/oauth/authorize']),
}
const failure = (code, message) => Object.assign(new Error(message), { code: `acp-login/${code}` })
const failedMessage = 'Sign-in did not finish. Try again.'
const unavailableMessage = 'Install the CLI before signing in.'
const unsupportedLinkMessage = 'The CLI returned an unsupported sign-in link. Update it and try again.'
const shortLinkMessage = 'The CLI returned a short sign-in link this app cannot use yet. Update Automagik and try again.'
const deviceAccessMessage = 'Codex device sign-in is unavailable. Enable device-code login in ChatGPT security settings or workspace permissions, then try again.'
const deviceStartMessage = 'Codex could not start device sign-in. Check your connection and device-code login permissions in ChatGPT, then try again.'
const expiredMessage = 'Sign-in expired. Try again.'
const cancelledMessage = 'Sign-in cancelled.'
// A Switch account whose CLI ended before showing its link while it is still signed in (#2064).
const unchangedMessage = 'The account did not change. Try again.'

// Why an attempt failed, as a class for the host log (#970): every failure reads much the same
// to the person, and what the CLI printed is never kept. The class comes from the fixed message
// the attempt ends with. The general message covers several ends this cannot tell apart: it is
// "the CLI exited" when the CLI had, and "unknown" otherwise.
const FAILURE_CAUSES = new Map([
  [unavailableMessage, 'no CLI found'],
  ['The CLI did not start sign-in. Try again.', 'no sign-in link in time'],
  ['The CLI could not start sign-in. Try again.', 'the CLI could not be started'],
  [unsupportedLinkMessage, 'unsupported sign-in link'],
  [shortLinkMessage, 'short sign-in link unsupported'],
  ['The CLI did not confirm sign-in. Try again.', 'the CLI did not confirm the sign-in'],
  [deviceAccessMessage, 'device-code login is not enabled'],
  [deviceStartMessage, 'device sign-in did not start'],
  [unchangedMessage, 'the account did not change'],
])

/**
 * What `onFail` is told of an attempt that ends as failed: { id, cause, phase, exit? }. `phase`
 * is where it stood (`starting`, `waiting` for the person, or `answering` once a code was
 * given); `exit` is how the CLI ended when it had (`exit 1`, `SIGTERM`). Fixed words and a
 * number only.
 */
function exitOf(exited) {
  const code = Number.isInteger(exited?.code) ? `exit ${exited.code}` : undefined
  const signal = typeof exited?.signal === 'string' && /^SIG[A-Z0-9]{2,12}$/.test(exited.signal) ? exited.signal : undefined
  return code ?? signal
}

function failureOf(flow, message) {
  const exited = flow.exit
  const exit = exitOf(exited)
  return {
    id: flow.id,
    cause: FAILURE_CAUSES.get(message) ?? (exited === undefined ? 'unknown' : 'the CLI exited'),
    phase: flow.answering ? 'answering' : flow.status === 'waiting' ? 'waiting' : 'starting',
    ...(exit === undefined ? {} : { exit }),
  }
}

/**
 * Only the official OAuth entry points, never an arbitrary URL printed by a process. A Claude
 * link must ask for the manual code (`code=true`, H5): without it the page sends the code to a
 * local callback this chat cannot reach from another device.
 */
export function isLoginUrl(id, value) {
  if (typeof value !== 'string' || value.length > 16_384 || /[\u0000- \u007f]/.test(value)) return false
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false
    if (URL_PATHS[id]?.has(`${url.hostname}${url.pathname}`) !== true) return false
    if (id === 'acp-codex') return !url.search
    return url.searchParams.get('code') === 'true' && STATE.test(url.searchParams.get('state') ?? '')
  } catch { return false }
}

function isShortClaudeLoginUrl(value) {
  // Match the printed authority and exclude even an empty fragment or an explicit default port.
  if (!/^https:\/\/claude\.ai\//i.test(value) || value.includes('#')) return false
  try {
    const url = new URL(value)
    if (url.pathname !== '/oauth/authorize' || url.searchParams.has('state')) return false
    // The first raw query component packs scope bits and a 43-character PKCE challenge.
    return /^[A-Za-z0-9_-]{44,64}$/.test(url.search.slice(1).split('&', 1)[0])
  } catch { return false }
}

// Only an agent this module has a sign-in for (its official entry points above). Any other
// agent of the table signs in in a terminal with its own command (`signInHint`, agents.js).
const known = id => Object.hasOwn(AGENTS, id) && Object.hasOwn(URL_PATHS, id)
const CHOOSE = `Choose ${Object.keys(URL_PATHS).map(id => AGENTS[id]?.defaultName).filter(Boolean).sort().join(' or ')}.`
const terminalOnly = (id, hint = AGENTS[id]?.signInHint) => (Object.hasOwn(AGENTS, id) && typeof hint === 'string' ? failure('terminal', `Sign in to ${AGENTS[id].defaultName} in a terminal: run ${hint}, then check again.`) : undefined)
// A name for the view that opened the attempt; never an access check.
const labelOf = value => (typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) ? value : undefined)

// A provider's own expiry, when its answer says one: epoch seconds or milliseconds, an ISO
// date, or a number of seconds from now. Anything else, or a past date, is no report.
export function providerExpiry(result, now) {
  const cap = now + PROVIDER_TTL_MAX_MS
  const at = (value) => {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value
    if (typeof value === 'string' && value.length <= 64) {
      const parsed = Date.parse(value)
      return Number.isFinite(parsed) ? parsed : undefined
    }
    return undefined
  }
  let value = at(result?.expiresAt)
  if (value === undefined && typeof result?.expiresIn === 'number' && Number.isFinite(result.expiresIn) && result.expiresIn > 0) value = now + result.expiresIn * 1000
  if (value === undefined || value <= now) return undefined
  return Math.min(value, cap)
}

// Claude Code honors BROWSER before its system opener. An unavailable BROWSER does not fall
// back to another opener, and OAuth keeps waiting for its own manual code. Use an empty private
// directory so no executable can occupy that path; this changes only the login process's
// environment. No browser is launched on this computer: the link is opened on any device.
function blockBrowser() {
  const directory = mkdtempSync(join(tmpdir(), 'automagik-cli-sign-in-'))
  return { path: join(directory, 'browser-handled-by-chat'), dispose: () => rmSync(directory, { recursive: true, force: true }) }
}

/**
 * resolve(id) snapshots { cli, env }; the same snapshot runs login and its confirmation.
 * Nothing is spawned until start(), and ordinary agent status never exposes these flows.
 * onChange() is told whenever the number of attempts at work changes (the busy signal).
 * onReady(id, selected, { existing, fresh, compare, valid, same }) is told a confirmed sign-in;
 * `existing` says the CLI was already signed in when the attempt started (no one signed in
 * through it); `fresh` says the attempt was a Switch account (#2064), and `compare` that its
 * account may be compared with the one signed out; `same()` marks that it ended on that account.
 * onSettled({ id, attemptId, signedIn, valid }) is told how a Switch attempt that did not sign in
 * left the CLI (#2064): `signedIn` is the status read after its CLI tree ended, or undefined.
 * onSwitch({ id, step, ... }) is told a Switch attempt's start and end, in fixed words only.
 * onFail({ id, cause, phase, exit? }) is told an attempt that failed, as a class for the log.
 * record lets tests exercise ownership proof with a fake process.
 */
export class CliLogins {
  constructor({ resolve, hintOf = id => AGENTS[id]?.signInHint, signedIn = signedInOf, onReady = () => {}, onSettled = () => {}, onSwitch = () => {}, onChange = () => {}, onActivity = () => {}, onFail = () => {}, spawn = spawnProcess, record = spawn === spawnProcess ? recordLogin : () => undefined, now = Date.now, linkTtlMs = LINK_TTL_MS, startupMs = STARTUP_MS, answerMs = ANSWER_TIMEOUT_MS, retainMs = RETAIN_MS, stateTtlMs = STATE_TTL_MS, timers = globalThis } = {}) {
    this.resolve = resolve
    // The terminal command a CLI with no sign-in here names (a managed copy's by its path).
    this.hintOf = hintOf
    this.signedIn = signedIn
    this.onReady = onReady
    this.onSettled = onSettled
    this.onSwitch = onSwitch
    this.onChange = onChange
    this.onActivity = onActivity
    this.onFail = onFail
    this.spawn = spawn
    this.record = record
    this.now = now
    this.monotonic = now === Date.now ? () => performance.now() : now
    this.linkTtlMs = linkTtlMs
    this.startupMs = startupMs
    this.answerMs = answerMs
    this.retainMs = retainMs
    this.stateTtlMs = stateTtlMs
    this.timers = timers
    this.flows = new Map()
    // Keyed hashes of the Claude states shown, and when each stops counting. The key lives
    // only in this process, so a hash outside it says nothing.
    this.stateKey = randomBytes(32)
    this.states = new Map()
    this.stateLengths = new Set()
    // The same for the states of Antigravity sign-in links (#2048): hash -> { until, length },
    // and how many remembered states have each length.
    this.callbackStates = new Map()
    this.callbackLengths = new Map()
    this.disposed = false
    this.activeCount = 0
  }

  timer(fn, ms) {
    const timer = this.timers.setTimeout(fn, ms)
    timer.unref?.()
    return timer
  }

  // The expiry or startup limit: a timer may fire a little before this.now() reaches the
  // deadline (Node counts from its cached loop time), so an early call sets itself again for
  // what is left instead of leaving the attempt at work until some view reads it.
  armDeadline(flow) {
    this.timers.clearTimeout(flow.timeout)
    const fire = () => {
      if (!this.active(flow) || flow.answering || flow.deadline === undefined) return
      const left = flow.deadline - this.now()
      if (left > 0) flow.timeout = this.timer(fire, left)
      else this.lapse(flow)
    }
    flow.timeout = this.timer(fire, Math.max(0, flow.deadline - this.now()))
  }

  active(flow) { return !this.disposed && this.flows.get(flow.id) === flow && ACTIVE.has(flow.status) }

  valid(flow) {
    if (this.active(flow) && flow.confirmingUntil !== undefined
      && (this.now() >= flow.confirmingUntil || this.monotonic() >= flow.confirmationEnd)) {
      this.finish(flow, 'failed', 'The CLI did not confirm sign-in. Try again.')
    }
    return this.active(flow) && (flow.selected?.valid?.() ?? true)
  }

  confirmationDeadline(flow) {
    if (flow.confirmingUntil !== undefined) return
    flow.confirmingUntil = this.now() + Math.min(this.answerMs, ANSWER_TIMEOUT_MS)
    flow.confirmationEnd = this.monotonic() + Math.min(this.answerMs, ANSWER_TIMEOUT_MS)
    this.timers.clearTimeout(flow.timeout)
    const expire = () => {
      if (!this.active(flow)) return
      if (this.now() >= flow.confirmingUntil || this.monotonic() >= flow.confirmationEnd) {
        this.finish(flow, 'failed', 'The CLI did not confirm sign-in. Try again.')
        return
      }
      flow.timeout = this.timer(expire, Math.max(0, Math.min(flow.confirmingUntil - this.now(), flow.confirmationEnd - this.monotonic())))
    }
    flow.timeout = this.timer(expire, Math.max(0, flow.confirmingUntil - this.now()))
    this.changed()
  }

  // A Switch that ended without a sign-in counts while it settles (#2064), in `confirming` too
  // with its own bound: the app holds its restarts only for a confirming attempt, and a restart
  // mid-settle would leave the vendor paused although its CLI is still signed in.
  activity() {
    const settling = flow => flow.settling === true && !this.disposed && this.flows.get(flow.id) === flow
    const until = flow => (this.active(flow) ? flow.confirmingUntil : settling(flow) ? flow.settlingUntil : undefined)
    const active = [...this.flows.values()].filter(flow => this.active(flow) || settling(flow))
    const confirming = active.filter(flow => until(flow) !== undefined)
    return { active: active.length, confirming: confirming.length,
      ...(confirming.length ? { confirmingUntil: Math.min(...confirming.map(until)) } : {}) }
  }

  /**
   * How many attempts are starting, waiting or settling: the Automagik app does not restart DSH
   * under one.
   */
  activeAttempts() {
    let count = 0
    if (!this.disposed) for (const flow of this.flows.values()) if (ACTIVE.has(flow.status) || flow.settling === true) count++
    return count
  }

  changed() {
    const activity = this.activity()
    const signature = JSON.stringify(activity)
    if (signature === this.activitySignature) return
    this.activitySignature = signature
    if (this.activeCount !== activity.active) {
      this.activeCount = activity.active
      try { this.onChange(activity.active) } catch {}
    }
    try { this.onActivity(activity) } catch {}
  }

  view(flow) {
    return {
      id: flow.id, attemptId: flow.attemptId, status: flow.status,
      ...(flow.expiresAt === undefined ? {} : { expiresAt: flow.expiresAt, expiresBy: flow.expiresBy }),
      ...(flow.label ? { openedBy: flow.label } : {}),
      ...(flow.url ? { url: flow.url } : {}),
      ...(flow.userCode ? { userCode: flow.userCode } : {}),
      ...(flow.prompt ? { prompt: { ...flow.prompt } } : {}),
      ...(flow.answering && this.active(flow) ? { checking: true } : {}),
      ...(flow.message ? { message: flow.message } : {}),
      ...(flow.status === 'failed' && typeof flow.cause === 'string' ? { cause: flow.cause } : {}),
      // A Switch account attempt (#2064), in every status: its row offers the switch again.
      ...(flow.fresh === true ? { fresh: true } : {}),
      ...(flow.status === 'ready' && flow.sameAccount === true ? { sameAccount: true } : {}),
      ...(flow.fresh === true && flow.settling === true ? { settling: true } : {}),
      ...(flow.fresh === true && !this.active(flow) && typeof flow.signedInAfter === 'boolean' ? { signedInAfter: flow.signedInAfter } : {}),
    }
  }

  // An attempt by its id, the only thing a view must know; a lapsed one ends as expired.
  flow(id, attemptId) {
    const flow = known(id) ? this.flows.get(id) : undefined
    if (!flow || typeof attemptId !== 'string' || flow.attemptId !== attemptId) throw failure('not-found', 'This sign-in has ended. Start again.')
    this.lapse(flow)
    return flow
  }

  lapse(flow) {
    if (!this.valid(flow) || flow.confirmingUntil !== undefined) return
    if (this.active(flow) && !flow.answering && flow.deadline !== undefined && this.now() >= flow.deadline) {
      this.finish(flow, flow.status === 'starting' ? 'failed' : 'expired', flow.status === 'starting' ? 'The CLI did not start sign-in. Try again.' : expiredMessage)
    }
  }

  /**
   * Starts an attempt, or returns the one at work for this agent, whoever opened it.
   * A Switch account (`fresh`, #2064) never joins one: its sign-in always runs and shows its link.
   * @param {string} id
   * @param {{ label?: string, fresh?: boolean, compare?: boolean, keep?: boolean }} [options] the view that opens
   *   it (a Bot id), shown on cancel; `fresh` for a Switch account, and `compare` when the account
   *   it signed out of may be compared with the new one.
   */
  start(id, { label, fresh = false, compare = false, keep = false } = {}) {
    if (this.disposed) throw failure('disposed', 'Sign-in is unavailable while Automagik restarts.')
    if (!known(id)) throw terminalOnly(id, this.hintOf(id)) ?? failure('invalid', CHOOSE)
    const previous = this.flows.get(id)
    if (previous) this.lapse(previous)
    if (previous && this.active(previous)) {
      if (fresh === true) throw failure('busy', 'The Bot account is changing.')
      return this.view(previous)
    }
    if (previous) this.timers.clearTimeout(previous.retained)
    const flow = { id, label: labelOf(label), attemptId: randomUUID(), status: 'starting', deadline: this.now() + this.startupMs,
      ...(fresh === true ? { fresh: true, compare: compare === true, keep: keep === true } : {}) }
    this.flows.set(id, flow)
    this.armDeadline(flow)
    this.changed()
    void this.begin(flow).catch(() => this.finish(flow, 'failed', failedMessage))
    return this.view(flow)
  }

  /** The attempt at work for this agent (`loginCurrent`), or undefined. Never starts one. */
  current(id) {
    if (!known(id)) throw failure('invalid', CHOOSE)
    const flow = this.flows.get(id)
    if (!flow) return undefined
    this.lapse(flow)
    return this.active(flow) ? this.view(flow) : undefined
  }

  status(id, attemptId) { return this.view(this.flow(id, attemptId)) }

  answer(id, attemptId, value) {
    const flow = this.flow(id, attemptId)
    if (!this.active(flow) || id !== 'acp-claude' || !flow.prompt || flow.answering) throw failure('invalid', 'This sign-in is not waiting for a code.')
    // Claude accepts authorizationCode#state, not an access token or terminal command.
    if (typeof value !== 'string' || value.length > 8192 || !/^[\x21-\x7e]+#[A-Za-z0-9_-]+$/.test(value) || value.split('#').length !== 2 || value.slice(value.indexOf('#') + 1) !== flow.state) throw failure('invalid-code', 'Paste the complete code shown by Claude, including the part after #.')
    flow.answering = true
    flow.prompt = undefined
    // The link expiry no longer applies: the CLI has ANSWER_TIMEOUT_MS to confirm the code.
    this.confirmationDeadline(flow)
    try {
      flow.child.stdin.write(`${value}\n`, error => { if (error) this.finish(flow, 'failed', failedMessage) })
    } catch { this.finish(flow, 'failed', failedMessage) }
    return this.view(flow)
  }

  /** Ends an attempt on an explicit request; reading or reconnecting never does. */
  cancel(id, attemptId) {
    const flow = this.flow(id, attemptId)
    this.finish(flow, 'cancelled', cancelledMessage)
    return this.view(flow)
  }

  /**
   * Whether a text carries a Claude state shown in the last STATE_TTL_MS (`#<state>`, spaces
   * and invisible characters ignored), or an Antigravity link's state after `state=` (#2048,
   * callbackTokens). Only a boolean: the states themselves are not kept.
   */
  textMatches(text) {
    if (typeof text !== 'string' || text === '' || (this.states.size === 0 && this.callbackStates.size === 0)) return false
    this.pruneStates()
    if (this.states.size === 0 && this.callbackStates.size === 0) return false
    const cleaned = text.slice(0, 1_000_000).replace(/[\p{Cf}]/gu, '')
    // The cost of one call (#871): a token's prefix is hashed once however often the text
    // repeats it, in either reading. So a call costs at most one HMAC per distinct prefix, and
    // never more than 2 x 1,000,000 / (length + 1) of them for each state length shown (the
    // lengths add up; Claude's states have one).
    const tried = new Set()
    const triedCallback = new Set()
    for (const candidate of new Set([cleaned, cleaned.replace(/\s+/gu, '')])) {
      for (const match of candidate.matchAll(/#([A-Za-z0-9_-]+)/g)) {
        const token = match[1]
        for (const length of this.stateLengths) {
          if (token.length < length) continue
          const prefix = token.slice(0, length)
          if (tried.has(prefix)) continue
          tried.add(prefix)
          if (this.states.has(this.hashState(prefix))) return true
        }
      }
      // An Antigravity state after `state=` (or `state%3d`), raw or decoded once (#2048).
      if (this.callbackStates.size > 0 && this.callbackIn(candidate, triedCallback)) return true
    }
    return false
  }

  callbackIn(reading, tried) {
    for (const token of callbackTokens(reading)) {
      for (const length of this.callbackLengths.keys()) {
        if (token.length < length) continue
        const prefix = token.slice(0, length)
        if (tried.has(prefix)) continue
        tried.add(prefix)
        if (this.callbackStates.has(this.hashState(prefix))) return true
      }
    }
    return false
  }

  /**
   * Remembers the state of an Antigravity sign-in link for STATE_TTL_MS (#2048): a message that
   * carries it after `state=` is refused (textMatches). Only its keyed hash and length are kept.
   * @param {string} state a printable state of 8-512 characters
   */
  rememberCallbackState(state) {
    if (typeof state !== 'string' || !CALLBACK_STATE.test(state)) return
    this.pruneStates()
    const hash = this.hashState(state)
    const known = this.callbackStates.get(hash)
    if (known === undefined) this.callbackLengths.set(state.length, (this.callbackLengths.get(state.length) ?? 0) + 1)
    this.callbackStates.set(hash, { until: this.now() + this.stateTtlMs, length: state.length })
  }

  hashState(state) { return createHmac('sha256', this.stateKey).update(state).digest('base64url') }

  rememberState(state) {
    this.pruneStates()
    this.states.set(this.hashState(state), this.now() + this.stateTtlMs)
    this.stateLengths.add(state.length)
  }

  pruneStates() {
    const now = this.now()
    for (const [hash, until] of this.states) if (until <= now) this.states.delete(hash)
    if (this.states.size === 0) this.stateLengths.clear()
    for (const [hash, { until, length }] of this.callbackStates) {
      if (until > now) continue
      this.callbackStates.delete(hash)
      const left = (this.callbackLengths.get(length) ?? 1) - 1
      if (left > 0) this.callbackLengths.set(length, left)
      else this.callbackLengths.delete(length)
    }
  }

  async begin(flow) {
    // An earlier wrapper may have exited while its credential-writing child is still alive.
    // Even a new login must wait for the previous whole group/tree, not only its parent.
    await this.drain(flow.id)
    if (!this.active(flow)) return
    const selected = await this.resolve(flow.id)
    if (!this.active(flow)) return
    if (typeof selected?.cli !== 'string' || selected.cli === '') { this.finish(flow, 'failed', unavailableMessage); return }
    flow.selected = { cli: selected.cli, env: { ...selected.env } }
    if (selected.valid) flow.selected.valid = selected.valid
    // `existing`: the CLI was signed in before this attempt, so nobody signed in here (#869). A
    // Switch account attempt (`fresh`) never takes that as its result (#2064): its sign-in always
    // runs and shows its link; the status at its start is only recorded. Decided after the read.
    const signedIn = await this.check(flow)
    if (!this.active(flow)) return
    if (flow.fresh) {
      flow.signedInAtStart = signedIn
      try { this.onSwitch({ id: flow.id, step: 'start', signedIn }) } catch {}
    } else if (signedIn) { flow.existing = true; await this.ready(flow); return }
    const args = flow.id === 'acp-codex' ? ['app-server', '--listen', 'stdio://'] : ['auth', 'login', '--claudeai']
    // DISABLE_UPDATES: a sign-in never updates the CLI on its own (clis.js asks --version the
    // same way); Automagik's own install keeps it current (CliStore).
    const env = { ...flow.selected.env, PATH: [dirname(selected.cli), flow.selected.env.PATH].filter(Boolean).join(delimiter), NO_COLOR: '1', FORCE_COLOR: '0', DISABLE_UPDATES: '1' }
    if (flow.id === 'acp-claude') {
      flow.browserBlock = blockBrowser()
      env.BROWSER = flow.browserBlock.path
      // Ask this CLI sign-in to print the full link. Short links omit state and code=true,
      // which isLoginUrl still requires for the manual code flow.
      env.CLAUDE_CODE_FULL_SIGN_IN_LINK = '1'
    }
    // Only fixed argument vectors are allowed. Even the manual authorization code goes
    // directly to stdin; it can never become a shell argument or an agent prompt.
    const options = {
      env, cwd: env.AUTOMAGIK_BOT_CLI_HOME,
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      detached: process.platform !== 'win32',
    }
    // Write the pending record before spawning: a crash before PID persistence cannot let
    // recovery assume that no vendor started. Only verified full-tree exit clears it.
    const windows = process.platform === 'win32' && this.spawn === spawnProcess
    const launch = windows ? randomUUID() : undefined
    const appBirth = windows ? processBirth(process.pid) : null
    const ownership = windows ? this.record(env, { id: launch, job: windowsJobName(launch), appBirth })
      : this.record(env)
    let owned
    try {
      owned = windows
        ? launchWindowsLogin(selected.cli, args, { ...options, launch,
          appStart: appBirth?.platform === 'win32' ? appBirth.start : null })
        : new LoginProcess(this.spawn(...batchSafe(selected.cli, args, options)), {
          grouped: process.platform !== 'win32' && this.spawn === spawnProcess,
          timers: this.timers,
        })
    } catch (error) {
      ownership?.clear() // synchronous spawn failure: no child exists
      throw error
    }
    owned.done.then(() => { ownership?.clear(); owned.dispose?.() }).catch(() => {})
    flow.process = owned
    owned.home = env.AUTOMAGIK_BOT_CLI_HOME
    flow.child = owned.child
    this.children ??= new Map()
    if (!this.children.has(flow.id)) this.children.set(flow.id, new Set())
    this.children.get(flow.id).add(owned)
    owned.done.then(() => this.children.get(flow.id)?.delete(owned)).catch(() => {})
    ownership?.update(owned.identity ?? { kind: 'unix', group: owned.child.pid })
    // First of its `close` listeners, so the failure it may end with knows how the CLI ended.
    flow.child.once('close', (code, signal) => { flow.exit = { code, signal } })
    flow.child.stdin.on('error', () => this.finish(flow, 'failed', failedMessage))
    flow.child.on('error', () => this.finish(flow, 'failed', 'The CLI could not start sign-in. Try again.'))
    flow.child.on('close', code => {
      if (!this.active(flow)) return
      // A Switch whose CLI ended before showing its link signed nobody in (#2064).
      if (flow.fresh && code === 0 && !flow.linkShown && !flow.confirming) { void this.unchanged(flow); return }
      if (flow.id === 'acp-claude' && code === 0) void this.confirm(flow)
      else if (!flow.confirming) this.finish(flow, 'failed', failedMessage)
    })
    flow.child.stdout.setEncoding('utf8')
    flow.child.stderr.setEncoding('utf8')
    if (flow.id === 'acp-codex') this.codex(flow)
    else this.claude(flow)
  }

  async check(flow) {
    return await this.signedIn(AGENTS[flow.id], flow.selected.cli, { env: flow.selected.env }).catch(() => undefined) === true
  }

  async ready(flow) {
    if (!this.valid(flow)) return
    this.confirmationDeadline(flow)
    // A notification or an exit alone is not proof: check() asked the same CLI and env. The
    // sign-in is recorded before any view can read `ready`.
    let same = false
    try {
      const accepted = await this.onReady(flow.id, flow.selected, { existing: flow.existing === true, fresh: flow.fresh === true,
        compare: flow.compare === true, ...(flow.keep ? { answered: flow.answering === true } : {}),
        valid: () => this.valid(flow), same: () => { same = true } })
      if (accepted === false) {
        this.finish(flow, 'failed', 'The CLI did not confirm sign-in. Try again.')
        return
      }
    } catch {
      if (flow.keep) {
        this.finish(flow, 'failed', 'The CLI did not confirm sign-in. Try again.')
        return
      }
    }
    if (this.valid(flow)) {
      if (same) flow.sameAccount = true
      this.finish(flow, 'ready')
    }
  }

  async confirm(flow) {
    if (!this.valid(flow) || flow.confirming) return
    flow.confirming = true
    this.confirmationDeadline(flow)
    flow.url = undefined
    flow.userCode = undefined
    flow.prompt = undefined
    if (await this.check(flow)) await this.ready(flow)
    else if (this.valid(flow)) this.finish(flow, 'failed', 'The CLI did not confirm sign-in. Try again.')
  }

  // A Switch whose CLI ended before its link (#2064): one status read says whether the account
  // stayed (still signed in) or the sign-in simply did not finish.
  async unchanged(flow) {
    if (!this.valid(flow) || flow.confirming) return
    flow.confirming = true
    this.confirmationDeadline(flow)
    const signedIn = await this.check(flow)
    flow.signedInAfter = signedIn
    if (this.valid(flow)) this.finish(flow, 'failed', signedIn ? unchangedMessage : failedMessage)
  }

  // The link is shown: the expiry starts now, the provider's own when reported.
  waiting(flow, url, { prompt, expiresAt } = {}) {
    if (!this.active(flow)) return
    if (!isLoginUrl(flow.id, url)) { this.finish(flow, 'failed', unsupportedLinkMessage); return }
    const now = this.now()
    flow.status = 'waiting'
    // `confirm` clears the URL: this is the record that the link was shown (#2064).
    flow.linkShown = true
    flow.url = url
    flow.prompt = prompt
    flow.expiresBy = expiresAt === undefined ? 'app' : 'provider'
    flow.expiresAt = expiresAt ?? now + this.linkTtlMs
    flow.deadline = flow.expiresAt
    this.armDeadline(flow)
  }

  codex(flow) {
    let buffer = ''
    let id = 0
    const pending = new Map()
    const request = (method, params) => new Promise((resolve, reject) => {
      const next = ++id
      pending.set(next, { resolve, reject, method })
      flow.child.stdin.write(`${JSON.stringify({ id: next, method, params })}\n`, error => { if (error) reject(error) })
    })
    flow.cancelProtocol = () => {
      if (flow.loginId) flow.child.stdin.write(`${JSON.stringify({ id: ++id, method: 'account/login/cancel', params: { loginId: flow.loginId } })}\n`)
      for (const waiter of pending.values()) waiter.reject(new Error('Sign-in ended'))
      pending.clear()
      buffer = ''
    }
    const completed = (event) => {
      if (event?.loginId !== flow.loginId || typeof event?.success !== 'boolean') return
      if (event.success) void this.confirm(flow)
      else this.finish(flow, 'failed', failedMessage)
    }
    let early
    flow.child.stdout.on('data', chunk => {
      if (!this.active(flow)) return
      buffer += chunk
      if (buffer.length > OUTPUT_LIMIT) { this.finish(flow, 'failed', failedMessage); return }
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!this.active(flow)) return
        let event
        try { event = JSON.parse(line) } catch { continue }
        if (event === null || typeof event !== 'object' || Array.isArray(event)) continue
        const waiter = pending.get(event.id)
        if (waiter) {
          pending.delete(event.id)
          if (event.error) {
            // Never reflect arbitrary CLI diagnostics. The pinned API's disabled-device
            // error is recognized only to give a fixed, actionable account instruction.
            const denied = waiter.method === 'account/login/start' && typeof event.error.message === 'string' && event.error.message.startsWith('device code login is not enabled')
            waiter.reject(new Error(denied ? deviceAccessMessage : waiter.method === 'account/login/start' ? deviceStartMessage : failedMessage))
          }
          else waiter.resolve(event.result)
        } else if (event.method === 'account/login/completed') {
          if (flow.loginId) completed(event.params)
          else early = { loginId: event.params?.loginId, success: event.params?.success }
        }
      }
    })
    // stderr can contain host paths or diagnostics; consume and discard, never forward.
    flow.child.stderr.on('data', () => {})
    void request('initialize', { clientInfo: { name: 'automagik-cli-sign-in', version: '1' }, capabilities: { experimentalApi: false } })
      .then(() => {
        if (!this.active(flow)) return undefined
        flow.child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
        return request('account/login/start', { type: 'chatgptDeviceCode' })
      }).then(result => {
        if (!this.active(flow)) return
        if (result?.type !== 'chatgptDeviceCode' || typeof result.loginId !== 'string' || result.loginId.length === 0 || result.loginId.length > 256 || typeof result.userCode !== 'string' || !/^[A-Za-z0-9-]{4,64}$/.test(result.userCode)) throw new Error(deviceStartMessage)
        flow.loginId = result.loginId
        // The device code's own validity, when this CLI version reports it [HIP].
        this.waiting(flow, result.verificationUrl, { expiresAt: providerExpiry(result, this.now()) })
        if (this.active(flow)) flow.userCode = result.userCode
        if (early) completed(early)
        early = undefined
      }).catch(error => this.finish(flow, 'failed', [deviceAccessMessage, deviceStartMessage].includes(error?.message) ? error.message : failedMessage))
  }

  claude(flow) {
    let buffer = ''
    const consume = (chunk) => {
      if (!this.active(flow) || flow.answering) return
      buffer += chunk
      if (buffer.length > OUTPUT_LIMIT) { this.finish(flow, 'failed', failedMessage); return }
      // Strip CSI and OSC hyperlink decoration before parsing the CLI's printed URL.
      const text = buffer.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      if (!/Paste code here if prompted\s*>/.test(text)) return
      const urls = text.match(/https:\/\/[^\s<>\u0000-\u001f]+/g) ?? []
      const url = urls.find(value => isLoginUrl(flow.id, value))
      if (!url) {
        this.finish(flow, 'failed', urls.some(isShortClaudeLoginUrl) ? shortLinkMessage : unsupportedLinkMessage)
        return
      }
      const state = new URL(url).searchParams.get('state')
      flow.state = state
      this.rememberState(state)
      this.waiting(flow, url, { prompt: { id: 'claude-code', label: 'Paste the code from the Claude sign-in page', secret: true } })
      buffer = ''
    }
    flow.child.stdout.on('data', consume)
    // Errors are deliberately not reflected: a CLI may print account names or secrets.
    flow.child.stderr.on('data', () => {})
    flow.cancelProtocol = () => { buffer = '' }
  }

  // An ended attempt keeps only its status and a fixed message: the link, the code prompt and
  // the state go now (H22). Its view stays readable by id for RETAIN_MS.
  finish(flow, status, message) {
    if (!this.active(flow)) return
    // Read before the attempt's state is cleared below; told after it.
    const failed = status === 'failed' ? failureOf(flow, message) : undefined
    // A Switch that ended without a sign-in settles (#2064): its CLI tree, then one status read
    // that decides whether the vendor's home runs again. It counts as at work until then.
    const settle = flow.fresh === true && status !== 'ready'
    const selected = settle ? flow.selected : undefined
    if (flow.fresh === true) flow.switchExit = exitOf(flow.exit) ?? 'running'
    if (settle) {
      flow.settling = true
      flow.settlingUntil = this.now() + Math.min(this.answerMs, ANSWER_TIMEOUT_MS)
    }
    flow.status = status
    flow.message = message
    // The cause the host log gets, kept on the ended attempt too: a fixed class, never what the
    // CLI printed, so the surface above can say why it failed without moving CLI text.
    flow.cause = failed?.cause
    flow.url = undefined
    flow.userCode = undefined
    flow.prompt = undefined
    flow.state = undefined
    flow.deadline = undefined
    this.timers.clearTimeout(flow.timeout)
    if (flow.child) {
      try { flow.cancelProtocol?.() } catch {}
      const child = flow.child
      // The Windows supervisor needs its pipes open until it proves the job empty. Unix
      // ownership likewise survives an exited wrapper, so never discard it on raw close.
      void flow.process.stop().then(() => {
        try { child.stdin.end() } catch {}
      }).catch(() => {})
    }
    flow.selected = undefined
    try { flow.browserBlock?.dispose() } catch {}
    flow.browserBlock = undefined
    flow.child = undefined
    flow.process = undefined
    flow.cancelProtocol = undefined
    flow.retained = this.timer(() => { if (this.flows.get(flow.id) === flow) this.flows.delete(flow.id) }, this.retainMs)
    this.changed()
    if (failed !== undefined) try { this.onFail(failed) } catch {}
    if (settle) void this.settle(flow, selected)
    else if (flow.fresh === true) this.switchEnded(flow)
  }

  // A Switch that ended without a sign-in (#2064): its CLI tree first, then one status read, which
  // says whether the vendor's home runs again (still signed in) or stays paused (signed out).
  // `drain` is called before any await: it stops only the trees alive now, never a newer one's.
  async settle(flow, selected) {
    let signedIn = flow.signedInAfter
    try {
      if (signedIn === undefined || flow.keep) {
        signedIn = undefined
        await this.drain(flow.id)
        if (selected === undefined && !this.disposed) {
          selected = await Promise.resolve().then(() => this.resolve(flow.id)).catch(() => undefined)
        }
        if (!this.disposed && typeof selected?.cli === 'string' && selected.valid?.() !== false) {
          const read = await this.signedIn(AGENTS[flow.id], selected.cli, { env: selected.env }).catch(() => undefined)
          signedIn = read === true ? true : read === false ? false : undefined
        }
      }
    } finally {
      if (typeof signedIn === 'boolean') flow.signedInAfter = signedIn
      if (!this.disposed) {
        try {
          const resumed = await this.onSettled({ id: flow.id, attemptId: flow.attemptId, signedIn,
            ...(flow.keep ? { selected } : {}),
            valid: () => !this.disposed && selected?.valid?.() !== false })
          if (flow.keep && resumed === true && signedIn === true && flow.status === 'failed') {
            flow.message = unchangedMessage
            flow.cause = FAILURE_CAUSES.get(unchangedMessage)
          }
        } catch {}
      }
      // Only now: a count that dropped before `onSettled` would let `onChange` end the lock first.
      flow.settling = false
      flow.settlingUntil = undefined
      this.changed()
      this.switchEnded(flow)
    }
  }

  // How a Switch attempt ended, once per attempt (#2064): fixed words for the host log.
  switchEnded(flow) {
    try {
      this.onSwitch({ id: flow.id, step: 'end', status: flow.status, linkShown: flow.linkShown === true,
        exit: flow.switchExit ?? 'running', ...(flow.status === 'ready' ? { same: flow.sameAccount === true } : {}),
        ...(typeof flow.signedInAfter === 'boolean' ? { signedInAfter: flow.signedInAfter } : {}) })
    } catch {}
  }

  /** Whether this agent's last attempt is a Switch still settling (`onChange` keeps its lock). */
  settling(id) { return this.flows.get(id)?.settling === true }

  /** Whether this agent's last attempt is that one. */
  owns(id, attemptId) { return this.flows.get(id)?.attemptId === attemptId }

  async stop(id) {
    const flow = this.flows.get(id)
    if (flow) this.finish(flow, 'cancelled', cancelledMessage)
    await this.drain(id)
  }

  async drain(id) {
    await Promise.all([...(this.children?.get(id) ?? [])]
      .filter(owned => !owned.retired).map(owned => owned.stop()))
  }

  // Only after Reset published a different physical home: an unproved old controller can
  // keep trying to stop, but cannot prevent sign-in to the new generation. Its durable record
  // and old folder remain; done still clears them only after the original full-tree proof.
  retire(id, home) {
    if (home === undefined) return
    for (const owned of this.children?.get(id) ?? []) {
      if (owned.home === home) owned.retired = true
    }
  }

  // The plugin stops (a DSH restart or an app quit): the CLI cannot outlive it. The busy signal
  // (activeAttempts) is what keeps the app's own restarts from landing here mid-attempt.
  dispose() {
    for (const flow of this.flows.values()) {
      this.finish(flow, 'cancelled', cancelledMessage)
      this.timers.clearTimeout(flow.retained)
    }
    this.flows.clear()
    this.states.clear()
    this.stateLengths.clear()
    this.disposed = true
    this.changed()
  }
}
