// The person signed in to Automagik Cloud or a remote self-hosted instance, in the desktop's main
// process only. The access token lives here, in memory, and never crosses the IPC bridge or
// reaches a page; the refresh token goes to C1.1's secure store (secure-tokens.js) and nothing
// else is written. The page sees this module's `status()` and nothing more: whether the setting
// is on, whether someone is signed in, the display name and email the ID token carries (display
// only, never a key), why not, and whether the desktop has a secure store.
//
// Signing in is off unless <home>/signin.json turns it on (sign-in.js readSignInSettings), and
// this module does nothing at all when it is off: no listener, no browser, no store, no network.
// A saved refresh token is used at the next launch; it rotates on each use and a rotated one
// presented again revokes the family on the server, so only the newest is stored. On a desktop
// with no secure store (Linux without a Secret Service) the token stays in memory, the person
// signs in again each launch, and the status carries the store's own reason.
import { SIGNED_OUT_REASON, TRY_LATER_REASON } from './secure-tokens.js'

/** Why there is no sign-in: the setting is off, or it is on but incomplete. */
export const DISABLED_REASON = 'Signing in with Automagik ID is switched off in this copy of the app.'
export const NOT_CONFIGURED_REASON = 'Signing in with Automagik ID is not set up in this copy of the app.'

/** Why a sign-in did not finish, in the words the page may show. Never a token, code or verifier. */
export const REFUSED_REASON = 'Automagik ID refused the sign-in. Try again.'
export const UNREACHABLE_REASON = "Automagik couldn't reach Automagik ID. Try again."
export const TIMEOUT_REASON = 'The sign-in timed out. Try again.'
export const BROWSER_REASON = "Automagik couldn't open your browser. Try again."
export const CALLBACK_REASON = "The sign-in didn't come back to Automagik. Try again."
export const FAILED_REASON = "The sign-in didn't finish. Try again."
export const BUSY_REASON = 'A sign-in is already open in your browser.'
export const EXPIRED_REASON = 'Your saved sign-in expired. Sign in again.'
export const NO_REFRESH_REASON = "Automagik ID returned no refresh token, so this sign-in ends with this launch. Sign in again next time."

/** How long before expiry the account refreshes the access token by itself. */
export const REFRESH_EARLY_MS = 30 * 1000

const text = value => (typeof value === 'string' ? value : null)

/** The sign-in status the page may see. It never carries a token, a code or a verifier. */
const statusOf = ({ enabled, claims, reason, store }) => ({
  enabled,
  signedIn: Boolean(claims),
  name: text(claims?.name),
  email: text(claims?.email),
  reason: reason ?? null,
  secureStore: store ? { secure: store.secure === true, backend: text(store.backend), reason: text(store.reason) } : null,
})

const reasonFor = (error) => {
  switch (error?.code) {
    case 'state':
    case 'nonce':
    case 'issuer':
    case 'audience':
    case 'expired':
    case 'issued':
    case 'subject':
    case 'alg':
    case 'token':
    case 'discovery':
      return REFUSED_REASON
    case 'network':
      return UNREACHABLE_REASON
    case 'timeout':
      return TIMEOUT_REASON
    case 'browser':
      return BROWSER_REASON
    case 'callback':
      return CALLBACK_REASON
    case 'busy':
      return BUSY_REASON
    case 'disabled':
      return DISABLED_REASON
    case 'cancelled':
      return null
    default:
      return FAILED_REASON
  }
}

/**
 * One account for one issuer: `settings` is sign-in.js readSignInSettings' answer, `flow` a
 * createSignInFlow for it (null when the app must not sign in), and `store` a secure-tokens.js
 * store (null when the setting is off). `now`, `log` and `onDirty` (called after any change a
 * page may show) are injectable. Methods: start (once, after app ready), signIn, signOut,
 * accessToken (main-process only), status, close.
 */
export function createAccount({ settings, flow = null, store = null, now = Date.now, log = () => {}, onDirty = () => {} } = {}) {
  const enabled = settings?.enabled === true && !settings.problem && flow?.enabled === true
  const issuer = enabled ? settings.issuer : null
  let access = null // { token, expiresAt }
  let refreshToken = null
  let claims = null
  let reason = enabled ? null : (settings?.problem ?? (settings?.enabled === true ? NOT_CONFIGURED_REASON : DISABLED_REASON))
  let started = false
  let signingIn = null
  let refreshing = null

  const status = () => statusOf({ enabled, claims, reason, store })
  const dirty = () => { try { onDirty(status()) } catch (error) { log(`account: a status listener failed (${error?.code ?? 'error'})`) } }

  /** The tokens just issued become this session; the refresh token alone is persisted. */
  function adopt(tokens) {
    if (typeof tokens?.accessToken !== 'string' || tokens.accessToken === '') throw Object.assign(new Error('no access token'), { code: 'token' })
    access = { token: tokens.accessToken, expiresAt: Number.isFinite(tokens.expiresAt) ? tokens.expiresAt : now() + 3600 * 1000 }
    // A refresh may carry no ID token; the claims of the sign-in that started the session stay.
    if (tokens.claims !== null && typeof tokens.claims === 'object') claims = tokens.claims
    if (typeof tokens.refreshToken === 'string' && tokens.refreshToken !== '') refreshToken = tokens.refreshToken
  }

  /** Save the new refresh token; a store that cannot keep it must not fail the session. */
  async function persist() {
    if (!store || !refreshToken) return
    try {
      const saved = await store.rotate(issuer, refreshToken)
      if (saved.status === 'retry' || saved.status === 'failed') log(`account: refresh token not saved (${saved.status})`)
    } catch {
      log('account: refresh token not saved (error)')
    }
  }

  /** Forget the session locally, and the stored token if there is a store. */
  async function forget() {
    access = null
    refreshToken = null
    claims = null
    if (store && issuer) {
      try {
        const cleared = await store.clear(issuer)
        if (cleared.status === 'failed') reason = cleared.reason ?? null
      } catch {
        // The session is gone from this process either way; the stored token is retried later.
      }
    }
  }

  async function start() {
    if (started) return status()
    started = true
    if (!enabled || !store) return status()
    let loaded
    try {
      loaded = await store.load(issuer)
    } catch {
      reason = SIGNED_OUT_REASON
      log('account: saved sign-in not readable (error)')
      dirty()
      return status()
    }
    if (loaded.status === 'retry') {
      reason = loaded.reason ?? TRY_LATER_REASON
      dirty()
      return status()
    }
    if (loaded.status === 'signed-out') {
      reason = loaded.reason ?? SIGNED_OUT_REASON
      dirty()
      return status()
    }
    if (loaded.status !== 'ok') {
      dirty()
      return status()
    }
    refreshToken = loaded.token
    try {
      adopt(await flow.refresh(refreshToken))
      reason = null
      // The server rotated the refresh token: the new one replaces the old in one write.
      await persist()
      log('account: signed in from the saved refresh token')
    } catch (error) {
      if (error?.code === 'token' && error.oauthError === 'invalid_grant') {
        await forget()
        reason = EXPIRED_REASON
        log('account: saved refresh token refused (invalid_grant)')
      } else {
        // Keep the token: a server that is down is not a sign-out.
        reason = reasonFor(error)
        log(`account: saved refresh token not used (${error?.code ?? 'error'})`)
      }
    }
    dirty()
    return status()
  }

  async function signIn() {
    if (!enabled) return { ok: false, reason: settings?.problem ?? DISABLED_REASON, status: status() }
    if (signingIn) return { ok: false, reason: BUSY_REASON, status: status() }
    const run = (async () => {
      try {
        const tokens = await flow.signIn()
        adopt(tokens)
        reason = tokens.refreshToken ? null : NO_REFRESH_REASON
        if (tokens.refreshToken) await persist()
        dirty()
        log('account: signed in')
        return { ok: true, status: status() }
      } catch (error) {
        if (error?.code === 'cancelled') {
          dirty()
          return { ok: false, cancelled: true, reason: null, status: status() }
        }
        reason = reasonFor(error)
        log(`account: sign-in did not finish (${error?.code ?? 'error'})`)
        dirty()
        return { ok: false, reason, status: status() }
      }
    })()
    signingIn = run
    try {
      return await run
    } finally {
      signingIn = null
    }
  }

  async function signOut() {
    if (signingIn) flow?.cancel?.()
    await forget()
    // A disabled account keeps saying so after a sign-out; a signed-in one is simply signed out.
    if (enabled) reason = null
    dirty()
    log('account: signed out')
    return { ok: true, status: status() }
  }

  /**
   * The access token for a call the app itself makes (never the page): the current one, or a
   * refreshed one while it is still valid, or null. The token never leaves the main process.
   */
  async function accessToken() {
    if (!access || typeof access.token !== 'string') return null
    if (access.expiresAt - REFRESH_EARLY_MS > now()) return access.token
    if (!refreshToken) return null
    if (refreshing) return refreshing
    const run = (async () => {
      try {
        adopt(await flow.refresh(refreshToken))
        reason = null
        await persist()
        dirty()
        return access?.token ?? null
      } catch (error) {
        if (error?.code === 'token' && error.oauthError === 'invalid_grant') {
          await forget()
          reason = EXPIRED_REASON
          dirty()
        } else {
          reason = reasonFor(error)
          log(`account: access token not refreshed (${error?.code ?? 'error'})`)
        }
        return null
      }
    })()
    refreshing = run
    try {
      return await run
    } finally {
      refreshing = null
    }
  }

  return Object.freeze({
    enabled,
    start,
    signIn,
    signOut,
    accessToken,
    status,
    /** Stop the flow's listener for good (the app is quitting). */
    close() {
      flow?.close?.()
    },
  })
}
