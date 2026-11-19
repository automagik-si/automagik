// Sign-in to a remote Automagik authorization server, the only way the app does it (RFC 0024,
// (d); RFC 8252): the system browser, the authorization code flow with PKCE (S256), `state` and
// `nonce`, and an exact loopback redirect on a port bound before the browser opens. The app
// never shows the sign-in page in its own window and never embeds a browser for it, and the
// `automagik://` scheme stays open-only: no code or token ever travels on a deep link.
//
// The setting is <home>/signin.json, off by default and shipped with no issuer, client id or
// host of its own (RFC 0024, Contracts: placeholders, never a default config). Delivery 1
// ships the flow behind that switch with no Cloud switched on; delivery 5 turns it on per OS.
//
// This module is the protocol only. It stores nothing: main.js passes its fetch, the system
// browser's opener and the clock, and account.js keeps what a sign-in returned. Nothing here
// writes a token, a code or a verifier anywhere, and a refusal never carries one in its text.
import {
  constants as cryptoConstants, createHash, createPublicKey, randomBytes, timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

/** The app's sign-in setting, under the app's own home. */
export const SETTINGS_FILE = 'signin.json'
export const settingsFileOf = home => join(home, SETTINGS_FILE)

/** The exact loopback redirect (RFC 8252): the IP literal, never a name, and one path. */
export const CALLBACK_HOST = '127.0.0.1'
export const CALLBACK_PATH = '/callback'
export const callbackUrlOf = port => `http://${CALLBACK_HOST}:${port}${CALLBACK_PATH}`

/** The authorization request's scope. Refresh-token retention is the server's business. */
export const SCOPE = 'openid'

/** How long the browser has to come back: one request, or a few minutes. */
export const SIGN_IN_TIMEOUT_MS = 3 * 60 * 1000

/** One HTTP call's limit, discovery and token exchange alike. */
export const REQUEST_TIMEOUT_MS = 20 * 1000

/** The accepted slack on the ID token's `exp` and `iat`, in seconds. */
export const CLOCK_SKEW_SECONDS = 60

/** The largest discovery document, JWKS or token response this module will read. */
export const MAX_DOCUMENT_BYTES = 1024 * 1024

/** The JWK key each JWS algorithm must use: an RSA key, a named EC curve, or an EdDSA OKP key. */
const KEY_SHAPES = Object.freeze({
  RS256: { kty: 'RSA' }, RS384: { kty: 'RSA' }, RS512: { kty: 'RSA' },
  PS256: { kty: 'RSA' }, PS384: { kty: 'RSA' }, PS512: { kty: 'RSA' },
  ES256: { kty: 'EC', crv: 'P-256' }, ES384: { kty: 'EC', crv: 'P-384' }, ES512: { kty: 'EC', crv: 'P-521' },
  EdDSA: { kty: 'OKP' },
})

/** Whether `jwk` is a key of the shape `alg` names (kty, and the curve for EC and EdDSA). */
function keyShapeMatches(jwk, alg) {
  const shape = KEY_SHAPES[alg]
  if (!shape || jwk?.kty !== shape.kty) return false
  if (shape.crv && jwk?.crv !== shape.crv) return false
  if (alg === 'EdDSA' && jwk.crv !== 'Ed25519' && jwk.crv !== 'Ed448') return false
  return true
}

/** A JWS signature algorithm this flow verifies, by its JWT name. Only own keys are algorithms. */
export const ALGORITHMS = Object.freeze({
  RS256: { hash: 'sha256', padding: cryptoConstants.RSA_PKCS1_PADDING },
  RS384: { hash: 'sha384', padding: cryptoConstants.RSA_PKCS1_PADDING },
  RS512: { hash: 'sha512', padding: cryptoConstants.RSA_PKCS1_PADDING },
  PS256: { hash: 'sha256', padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, salt: cryptoConstants.RSA_PSS_SALTLEN_DIGEST },
  PS384: { hash: 'sha384', padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, salt: cryptoConstants.RSA_PSS_SALTLEN_DIGEST },
  PS512: { hash: 'sha512', padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, salt: cryptoConstants.RSA_PSS_SALTLEN_DIGEST },
  ES256: { hash: 'sha256', ecdsa: true },
  ES384: { hash: 'sha384', ecdsa: true },
  ES512: { hash: 'sha512', ecdsa: true },
  EdDSA: { eddsa: true },
})

/** A refusal from this module. `code` is the stable reason tests and account.js branch on. */
export class SignInError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'SignInError'
    this.code = code
    Object.assign(this, extra)
  }
}

const refusal = (code, message, extra) => new SignInError(code, message, extra)

const text = value => (typeof value === 'string' ? value.trim() : '')

/** A loopback host, the only place this module accepts plain http (a throwaway provider). */
export const isLoopbackHost = host => host === '127.0.0.1' || host === '[::1]' || host === '::1' || host === 'localhost'

/**
 * Whether `address` is an issuer this flow will talk to: an http(s) origin or path with no
 * query, fragment or credentials, https everywhere but loopback. A trailing slash is refused,
 * not trimmed: the issuer is compared exactly and discovery is built from it as written.
 */
export function issuerProblem(address) {
  const value = text(address)
  if (value === '' || value.endsWith('/')) return 'the issuer must be an address without a trailing slash'
  let url
  try {
    url = new URL(value)
  } catch {
    return 'the issuer is not an address'
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'the issuer must use https'
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) return 'the issuer must use https, unless it is a loopback test provider'
  if (url.username || url.password || url.search || url.hash) return 'the issuer must be a plain address'
  if (value !== url.origin && value !== url.origin + url.pathname) return 'the issuer must be a plain address'
  return null
}

/**
 * The person's sign-in setting from `file`, `{ enabled, issuer, clientId }`. A missing or
 * unreadable file means off. Off is the default: an absent `enabled` is off, and switching it
 * on without both an issuer and a client id is a problem, never a silent default.
 */
export function readSignInSettings(file, read = readFileSync) {
  const off = problem => ({ enabled: false, issuer: null, clientId: null, problem: problem ?? null })
  let saved
  try {
    saved = JSON.parse(read(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return off()
    return off('The sign-in setting could not be read.')
  }
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) return off('The sign-in setting is not an object.')
  if (saved.enabled !== true) return off()
  const issuer = text(saved.issuer)
  const clientId = text(saved.clientId)
  if (issuer === '' || clientId === '') return { enabled: true, issuer: issuer || null, clientId: clientId || null, problem: 'Sign-in is switched on, but the setting names no issuer and client id.' }
  const problem = issuerProblem(issuer)
  if (problem) return { enabled: true, issuer, clientId, problem: `Sign-in is switched on, but ${problem}.` }
  return { enabled: true, issuer, clientId, problem: null }
}

/**
 * A discovery or token endpoint from the metadata: an absolute address, https unless the issuer
 * itself is a loopback test provider. A production issuer may not send the code to plain http,
 * and may not send it to another loopback port either.
 */
function endpointProblem(address, field, loopbackIssuer) {
  let url
  try {
    url = new URL(String(address))
  } catch {
    return `the discovery document's ${field} is not an address`
  }
  const plainHttp = url.protocol === 'http:' && loopbackIssuer === true && isLoopbackHost(url.hostname)
  if (url.protocol !== 'https:' && !plainHttp) {
    return `the discovery document's ${field} must use https`
  }
  if (url.username || url.password || url.hash) return `the discovery document's ${field} is not a plain address`
  return null
}

const requiredArray = (document, field, value) => {
  const list = document[field]
  if (!Array.isArray(list) || !list.includes(value)) throw refusal('discovery', `the discovery document does not offer ${value}`)
}

const digestOf = value => createHash('sha256').update(String(value)).digest()
const sameText = (left, right) => typeof left === 'string' && typeof right === 'string' && timingSafeEqual(digestOf(left), digestOf(right))
const base64url = buffer => Buffer.from(buffer).toString('base64url')

function decodePart(part, what) {
  let decoded
  try {
    decoded = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
  } catch {
    throw refusal('token', `the ID token's ${what} is not readable`)
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) throw refusal('token', `the ID token's ${what} is not an object`)
  return decoded
}

function signatureOk(jwk, alg, signed, signature) {
  if (!Object.hasOwn(ALGORITHMS, alg) || !keyShapeMatches(jwk, alg)) return false
  const algorithm = ALGORITHMS[alg]
  let key
  try {
    key = createPublicKey({ key: jwk, format: 'jwk' })
  } catch {
    return false
  }
  try {
    if (algorithm.eddsa) return verifySignature(null, signed, key, signature)
    if (algorithm.ecdsa) return verifySignature(algorithm.hash, signed, { key, dsaEncoding: 'ieee-p1363' }, signature)
    return verifySignature(algorithm.hash, signed, { key, padding: algorithm.padding, ...(algorithm.salt ? { saltLength: algorithm.salt } : {}) }, signature)
  } catch {
    return false
  }
}

/**
 * One sign-in flow for `settings` (readSignInSettings' answer). Injected: `fetch`, `openExternal`
 * (the system browser), `now` (ms), `random`, `timeoutMs`, `requestTimeoutMs`, `log` (a line, no
 * secrets), and a `setTimeout`/`clearTimeout` pair for tests. `signIn()` resolves with the tokens
 * and the verified ID token's claims; it never waits on the app's window.
 */
export function createSignInFlow({
  settings, fetch = globalThis.fetch, openExternal, now = Date.now, random = randomBytes,
  timeoutMs = SIGN_IN_TIMEOUT_MS, requestTimeoutMs = REQUEST_TIMEOUT_MS, log = () => {},
} = {}) {
  if (typeof fetch !== 'function') throw new TypeError('createSignInFlow needs fetch')
  if (typeof openExternal !== 'function') throw new TypeError('createSignInFlow needs openExternal')
  const enabled = settings?.enabled === true && !settings.problem && typeof settings.issuer === 'string' && settings.issuer !== '' &&
    typeof settings.clientId === 'string' && settings.clientId !== ''
  const issuer = enabled ? settings.issuer : null
  const clientId = enabled ? settings.clientId : null
  let metadata = null
  let keys = null
  let active = null
  let running = null
  let stopped = false

  const abortable = () => (typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(requestTimeoutMs) : undefined)

  async function getDocument(address, what) {
    let response
    try {
      response = await fetch(address, {
        method: 'GET', redirect: 'error', signal: abortable(),
        headers: { accept: 'application/json' },
      })
    } catch {
      throw refusal('network', `the ${what} could not be reached`)
    }
    let body
    try {
      body = await response.text()
    } catch {
      throw refusal('network', `the ${what} could not be read`)
    }
    if (Buffer.byteLength(body) > MAX_DOCUMENT_BYTES) throw refusal('network', `the ${what} is too large`)
    if (!response.ok) throw refusal('network', `the ${what} answered ${response.status}`)
    try {
      return JSON.parse(body)
    } catch {
      throw refusal('discovery', `the ${what} is not JSON`)
    }
  }

  async function discover() {
    if (metadata) return metadata
    const document = await getDocument(`${issuer}/.well-known/openid-configuration`, 'discovery document')
    if (document.issuer !== issuer) throw refusal('issuer', 'the discovery document is for another issuer')
    const loopbackIssuer = isLoopbackHost(new URL(issuer).hostname)
    for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      const problem = endpointProblem(document[field], field, loopbackIssuer)
      if (problem) throw refusal('discovery', problem)
    }
    requiredArray(document, 'response_types_supported', 'code')
    requiredArray(document, 'grant_types_supported', 'authorization_code')
    requiredArray(document, 'code_challenge_methods_supported', 'S256')
    requiredArray(document, 'token_endpoint_auth_methods_supported', 'none')
    requiredArray(document, 'scopes_supported', 'openid')
    metadata = document
    return metadata
  }

  async function fetchKeys() {
    const document = await getDocument(metadata.jwks_uri, 'key set')
    if (!Array.isArray(document.keys) || document.keys.length === 0) throw refusal('token', 'the sign-in key set is empty')
    if (document.keys.length > 100) throw refusal('token', 'the sign-in key set is too large')
    keys = document.keys
    return keys
  }

  async function verifyIdToken(idToken, nonce) {
    if (typeof idToken !== 'string') throw refusal('token', 'the sign-in returned no ID token')
    const parts = idToken.split('.')
    if (parts.length !== 3 || parts.some(part => part === '')) throw refusal('token', 'the ID token is not a signed JWT')
    const header = decodePart(parts[0], 'header')
    const payload = decodePart(parts[1], 'payload')
    if (typeof header.alg !== 'string' || !Object.hasOwn(ALGORITHMS, header.alg)) throw refusal('alg', 'the ID token uses an algorithm this app does not accept')
    if (header.crit !== undefined) throw refusal('token', 'the ID token names a critical header')
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8')
    let signature
    try {
      signature = Buffer.from(parts[2], 'base64url')
    } catch {
      throw refusal('token', 'the ID token signature is not readable')
    }
    const candidates = (keys ?? await fetchKeys()).filter(key => key !== null && typeof key === 'object' &&
      (key.use === undefined || key.use === 'sig') && (key.alg === undefined || key.alg === header.alg) &&
      (header.kid === undefined || key.kid === header.kid))
    let accepted = candidates.some(key => signatureOk(key, header.alg, signed, signature))
    if (!accepted && candidates.length === 0) {
      // The server may have rotated its keys since this launch: look once more, never in a loop.
      accepted = (await fetchKeys()).filter(key => key !== null && typeof key === 'object' &&
        (key.use === undefined || key.use === 'sig') && (key.alg === undefined || key.alg === header.alg) &&
        (header.kid === undefined || key.kid === header.kid)).some(key => signatureOk(key, header.alg, signed, signature))
    }
    if (!accepted) throw refusal('token', 'the ID token signature is not valid')

    if (payload.iss !== issuer) throw refusal('issuer', 'the ID token is for another issuer')
    const audience = payload.aud
    const audienceOk = audience === clientId || (Array.isArray(audience) && audience.length === 1 && audience[0] === clientId)
    if (!audienceOk) throw refusal('audience', 'the ID token is for another client')
    const at = Math.floor(now() / 1000)
    if (!Number.isFinite(payload.exp) || payload.exp <= at - CLOCK_SKEW_SECONDS) throw refusal('expired', 'the ID token has expired')
    if (!Number.isFinite(payload.iat) || payload.iat > at + CLOCK_SKEW_SECONDS) throw refusal('issued', 'the ID token is not valid yet')
    if (nonce !== null && !sameText(payload.nonce, nonce)) throw refusal('nonce', 'the ID token is for another request')
    if (typeof payload.sub !== 'string' || payload.sub === '') throw refusal('subject', 'the ID token names no person')
    return payload
  }

  async function tokenRequest(body) {
    let response
    try {
      response = await fetch(metadata.token_endpoint, {
        method: 'POST', redirect: 'error', signal: abortable(),
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
      })
    } catch {
      throw refusal('network', 'the token endpoint could not be reached')
    }
    let raw
    try {
      raw = await response.text()
    } catch {
      throw refusal('network', 'the token response could not be read')
    }
    if (Buffer.byteLength(raw) > MAX_DOCUMENT_BYTES) throw refusal('token', 'the token response is too large')
    let json
    try {
      json = JSON.parse(raw)
    } catch {
      json = null
    }
    if (!response.ok) {
      const oauthError = typeof json?.error === 'string' && /^[a-z_]{1,64}$/.test(json.error) ? json.error : null
      throw refusal('token', 'the authorization server refused the sign-in', { status: response.status, oauthError })
    }
    if (json === null || typeof json !== 'object' || Array.isArray(json)) throw refusal('token', 'the token response is not an object')
    return json
  }

  function tokensOf(json, nonce) {
    if (typeof json.access_token !== 'string' || json.access_token === '') throw refusal('token', 'the sign-in returned no access token')
    if (json.token_type !== undefined && String(json.token_type).toLowerCase() !== 'bearer') throw refusal('token', 'the sign-in returned another token type')
    const expiresIn = Number.isFinite(json.expires_in) && json.expires_in > 0 ? json.expires_in : 3600
    const refreshToken = typeof json.refresh_token === 'string' && json.refresh_token !== '' ? json.refresh_token : null
    return {
      accessToken: json.access_token,
      expiresAt: Math.floor(now() / 1000) * 1000 + Math.max(0, Math.min(expiresIn, 24 * 3600)) * 1000,
      refreshToken,
      idToken: typeof json.id_token === 'string' ? json.id_token : null,
      nonce,
    }
  }

  async function complete(json, nonce) {
    const tokens = tokensOf(json, nonce)
    // A refresh may answer without an ID token; the sign-in that started the session always
    // carries one, and its claims are what the page shows.
    let claims = null
    if (tokens.idToken !== null) claims = await verifyIdToken(tokens.idToken, nonce)
    else if (nonce !== null) throw refusal('token', 'the sign-in returned no ID token')
    return { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt, refreshToken: tokens.refreshToken, claims }
  }

  async function signIn() {
    if (!enabled) throw refusal('disabled', 'sign-in is switched off')
    if (stopped) throw refusal('cancelled', 'the sign-in was stopped')
    if (running) throw refusal('busy', 'a sign-in is already running')
    // A cancel is honoured at every step before the browser opens, not only once the callback
    // listener exists: a sign-out during discovery must not open a browser afterwards.
    const run = { cancelled: false }
    running = run
    const promise = (async () => {
      await discover()
      if (run.cancelled) throw refusal('cancelled', 'the sign-in was stopped')
      const state = base64url(random(32))
      const nonce = base64url(random(32))
      const verifier = base64url(random(32))
      const challenge = base64url(createHash('sha256').update(verifier).digest())
      const callback = await openCallback(state)
      try {
        if (run.cancelled) throw refusal('cancelled', 'the sign-in was stopped')
        const url = new URL(metadata.authorization_endpoint)
        url.search = new URLSearchParams({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: callback.url,
          scope: SCOPE,
          state,
          nonce,
          code_challenge: challenge,
          code_challenge_method: 'S256',
        }).toString()
        log(`sign-in: browser opened at the configured issuer`)
        let timer
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(refusal('timeout', 'the sign-in did not come back')), timeoutMs)
          timer.unref?.()
        })
        // The browser opener resolving is not the sign-in coming back: only the callback is.
        const opening = Promise.resolve().then(() => openExternal(url.toString())).catch((error) => {
          throw error instanceof SignInError ? error : refusal('browser', 'the system browser could not be opened')
        })
        opening.catch(() => {})
        try {
          await Promise.race([callback.answer, opening.then(() => callback.answer), timeout])
        } finally {
          clearTimeout(timer)
        }
        const code = await callback.answer
        const json = await tokenRequest({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          redirect_uri: callback.url,
          code_verifier: verifier,
        })
        return await complete(json, nonce)
      } finally {
        callback.close()
      }
    })()
    try {
      return await promise
    } finally {
      running = null
    }
  }

  async function refresh(refreshToken) {
    if (!enabled) throw refusal('disabled', 'sign-in is switched off')
    if (typeof refreshToken !== 'string' || refreshToken === '') throw refusal('invalid_grant', 'no refresh token')
    await discover()
    const json = await tokenRequest({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken })
    return await complete(json, null)
  }

  /**
   * A loopback listener on this flow's one redirect, bound before the browser opens and closed
   * after its first request. The promise settles on that request; a request for another host or
   * path is refused and ends the sign-in too.
   */
  async function openCallback(state) {
    if (active) throw refusal('busy', 'a sign-in is already running')
    let resolveAnswer
    let rejectAnswer
    const answer = new Promise((resolve, reject) => { resolveAnswer = resolve; rejectAnswer = reject })
    // The browser may give up before the callback request is answered: nobody must see an
    // unhandled rejection for a refusal the flow reports itself.
    answer.catch(() => {})
    let currentPort = 0
    let answered = false
    let closed = false
    let server
    // The listener goes after its first request, answered or refused: a second request finds
    // no port. A hard stop (a quit) also drops a connection still open on it.
    const shutdown = (hard) => {
      if (closed) return
      closed = true
      if (active?.server === server) active = null
      try { server.close() } catch {}
      if (hard) { try { server.closeAllConnections?.() } catch {} }
    }
    server = createServer((request, response) => {
      const finish = (status, code, error) => {
        if (answered) return
        answered = true
        try {
          response.writeHead(status, {
            connection: 'close',
            'cache-control': 'no-store',
            'content-type': 'text/plain; charset=utf-8',
            'referrer-policy': 'no-referrer',
            'x-content-type-options': 'nosniff',
          })
          response.end('')
        } catch {
          // The browser went away first; the sign-in is refused all the same.
        }
        shutdown(false)
        if (error) rejectAnswer(error)
        else resolveAnswer(code)
      }
      const host = String(request.headers.host ?? '')
      const expected = `${CALLBACK_HOST}:${currentPort}`
      try {
        const url = new URL(String(request.url ?? '/'), `http://${expected}`)
        if (request.method !== 'GET') return finish(405, null, refusal('callback', 'the sign-in callback is not a GET'))
        if (host !== expected) return finish(400, null, refusal('callback', 'the sign-in callback is for another host'))
        if (url.pathname !== CALLBACK_PATH) return finish(404, null, refusal('callback', 'the sign-in callback is for another path'))
        if (url.searchParams.has('error')) return finish(400, null, refusal('callback', 'the authorization server refused the sign-in'))
        if (!sameText(url.searchParams.get('state'), state)) return finish(400, null, refusal('state', 'the sign-in callback is for another request'))
        const code = url.searchParams.get('code')
        if (typeof code !== 'string' || code === '') return finish(400, null, refusal('callback', 'the sign-in callback carries no code'))
        return finish(204, code)
      } catch {
        return finish(400, null, refusal('callback', 'the sign-in callback is not readable'))
      }
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host: CALLBACK_HOST, port: 0, exclusive: true }, resolve)
    })
    const address = server.address()
    if (address === null || typeof address !== 'object' || address.address !== CALLBACK_HOST) {
      closed = true
      try { server.close() } catch {}
      throw refusal('callback', 'the loopback redirect did not bind')
    }
    currentPort = address.port
    active = {
      server,
      close() {
        if (!answered) {
          answered = true
          rejectAnswer(refusal('cancelled', 'the sign-in was stopped'))
        }
        shutdown(true)
      },
    }
    if (stopped) {
      active.close()
      throw refusal('cancelled', 'the sign-in was stopped')
    }
    return {
      url: callbackUrlOf(currentPort),
      answer,
      close() {
        if (!answered) {
          answered = true
          rejectAnswer(refusal('cancelled', 'the sign-in was stopped'))
        }
        shutdown(false)
      },
    }
  }

  return Object.freeze({
    enabled,
    issuer,
    clientId,
    signIn,
    refresh,
    /** Stop this sign-in only (a Sign out, or a page that started another): the flow stays usable. */
    cancel() {
      if (running) running.cancelled = true
      active?.close()
    },
    /** Stop watching for the callback for good (the app is quitting). */
    close() {
      stopped = true
      if (running) running.cancelled = true
      active?.close()
    },
  })
}
