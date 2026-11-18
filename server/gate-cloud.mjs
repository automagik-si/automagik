// Cloud mode (RFC 0024 (g); contracts v1, sections 4 and 5). Off unless every setting is set.
// The workspace holds no Cloud credential: on demand only, it fetches the Cloud service's
// published public keys and trades a single-use open code for a workspace token, server to
// server. The token never reaches a browser, a URL or a log. The gate never mints one.
import { createHash, createPublicKey, verify } from 'node:crypto'
import https from 'node:https'
import { decoded, object } from './gate-access.mjs'

const SETTINGS = {
  issuer: 'AUTOMAGIK_GATE_CLOUD_ISSUER',
  identity: 'AUTOMAGIK_GATE_CLOUD_IDENTITY_ISSUER',
  workspace: 'AUTOMAGIK_GATE_CLOUD_WORKSPACE',
  keys: 'AUTOMAGIK_GATE_CLOUD_KEYS_URL',
  exchange: 'AUTOMAGIK_GATE_CLOUD_EXCHANGE_URL',
  rail: 'AUTOMAGIK_GATE_CLOUD_RAIL_ORIGIN',
}
export const TOKEN_MAX_SECONDS = 300
export const KEYS_TTL_MS = 5 * 60 * 1000
export const REFRESH_INTERVAL_MS = 30 * 1000
export const CLOCK_SKEW_SECONDS = 30
// RFC 0011's rotation: the key that signs and the next (or previous) one, never more.
export const KEY_SLOTS = 2
export const MAX_EXCHANGES = 8
const CODE_MEMORY_MS = 15 * 60 * 1000
const MEMORY_LIMIT = 4096
const MAX_RESPONSE_BYTES = 64 * 1024
const CODE = /^[A-Za-z0-9_-]{16,512}$/
const ROLES = ['owner', 'admin', 'member', 'guest']
// RFC 0024 Decided 26: Cloud workspaces stay owner-only until (f)'s three safeguards hold.
// Organisation owners and admins are the owner-equivalent people; members and guests wait.
const ADMITTED = ['owner', 'admin']
const digest = value => createHash('sha256').update(value).digest('hex')
export class CloudConfigurationError extends Error {}
export class CloudOpenRefused extends Error {
  constructor(status = 401) { super('Workspace open refused'); this.status = status }
}
const refused = () => new CloudOpenRefused()

function httpsUrl(name, value) {
  let url
  try { url = new URL(value) } catch { throw new CloudConfigurationError(`${name} must be an HTTPS URL`) }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /\s/.test(value)) {
    throw new CloudConfigurationError(`${name} must be an HTTPS URL without credentials, query or fragment`)
  }
  return url
}

export function cloudConfig(env) {
  const names = Object.values(SETTINGS)
  const values = Object.fromEntries(Object.entries(SETTINGS).map(([key, name]) => [key, env[name]?.trim() || '']))
  if (Object.values(values).every(value => !value)) return undefined
  const missing = names.filter(name => !env[name]?.trim())
  if (missing.length) throw new CloudConfigurationError(`Missing Cloud settings: ${missing.join(', ')}`)
  httpsUrl(SETTINGS.issuer, values.issuer)
  httpsUrl(SETTINGS.identity, values.identity)
  if (!/^[\x21-\x7e]{1,256}$/.test(values.workspace)) throw new CloudConfigurationError(`Invalid ${SETTINGS.workspace}`)
  const rail = httpsUrl(SETTINGS.rail, values.rail)
  if (rail.origin !== values.rail) throw new CloudConfigurationError(`${SETTINGS.rail} must be an exact HTTPS origin`)
  return {
    issuer: values.issuer, identity: values.identity, workspace: values.workspace, rail: rail.origin,
    keys: httpsUrl(SETTINGS.keys, values.keys), exchange: httpsUrl(SETTINGS.exchange, values.exchange),
  }
}

// One bounded JSON call with an absolute deadline. No redirect is followed and no credential,
// cookie or identity header is sent: the workspace has none to send.
export function requestJson(url, { method = 'GET', body, request = https.request } = {}) {
  return new Promise((resolve, rejectPromise) => {
    let response
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    const headers = { accept: 'application/json',
      ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}) }
    const req = request(url, { method, headers }, incoming => {
      response = incoming
      incoming.on('error', () => rejectPromise(refused()))
      incoming.on('aborted', () => rejectPromise(refused()))
      if (incoming.statusCode !== 200) { req.destroy(refused()); return }
      const chunks = []
      let size = 0
      incoming.on('data', chunk => {
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) { req.destroy(refused()); return }
        chunks.push(chunk)
      })
      incoming.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch { rejectPromise(refused()) }
      })
    })
    const timer = setTimeout(() => req.destroy(refused()), 5000).unref()
    req.on('close', () => { clearTimeout(timer); response?.destroy() })
    req.on('error', () => { clearTimeout(timer); rejectPromise(refused()) })
    req.end(payload)
  })
}

function publicKeys(document) {
  if (!document || typeof document !== 'object' || !Array.isArray(document.keys) || document.keys.length > 16) throw refused()
  const keys = new Map()
  for (const jwk of document.keys) {
    if (!jwk || typeof jwk !== 'object') throw refused()
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || (jwk.alg !== undefined && jwk.alg !== 'EdDSA') ||
      (jwk.use !== undefined && jwk.use !== 'sig')) continue
    if (typeof jwk.kid !== 'string' || !jwk.kid || jwk.kid.length > 256 || keys.has(jwk.kid) || jwk.d !== undefined ||
      typeof jwk.x !== 'string') throw refused()
    if (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes('verify'))) throw refused()
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' })
    if (key.asymmetricKeyType !== 'ed25519') throw refused()
    keys.set(jwk.kid, key)
  }
  if (!keys.size || keys.size > KEY_SLOTS) throw refused()
  return keys
}

export const samePerson = (a, b) => a.issuer === b.issuer && a.subject === b.subject

export class CloudSignIn {
  constructor(config, { now = Date.now, request } = {}) {
    this.config = config
    this.now = now
    this.call = (url, body) => requestJson(url, { ...(body === undefined ? {} : { method: 'POST', body }), ...(request ? { request } : {}) })
    this.keys = new Map()
    this.expires = 0
    this.nextFetch = 0
    this.codes = new Map()
    this.inflight = 0
  }
  // The session store's admission check: only a Cloud principal for this one workspace.
  accepts = principal => Boolean(principal) && principal.issuer === this.config.identity &&
    typeof principal.subject === 'string' && principal.subject.length > 0 && principal.workspace === this.config.workspace &&
    Array.isArray(principal.roles) && principal.roles.length > 0 && principal.roles.every(role => ROLES.includes(role)) &&
    principal.roles.some(role => ADMITTED.includes(role)) &&
    Object.keys(principal).sort().join(',') === 'issuer,roles,subject,workspace'

  async key(kid) {
    if (this.now() < this.expires && this.keys.has(kid)) return this.keys.get(kid)
    if (!this.pending) {
      // An unknown key id refetches at most once per interval; a failed fetch keeps no key.
      if (this.now() < this.nextFetch) throw refused()
      this.nextFetch = this.now() + REFRESH_INTERVAL_MS
      this.pending = Promise.resolve().then(() => this.call(this.config.keys))
        .then(document => { this.keys = publicKeys(document); this.expires = this.now() + KEYS_TTL_MS })
        .catch(() => { this.keys.clear(); this.expires = 0; throw refused() })
        .finally(() => { this.pending = undefined })
    }
    await this.pending
    const key = this.now() < this.expires && this.keys.get(kid)
    if (!key) throw refused()
    return key
  }
  // Open codes are single use on this gate too, whatever the Cloud service answers.
  remember(memory, value, until) {
    const now = this.now()
    for (const [hash, end] of memory) if (end <= now) memory.delete(hash)
    const hash = digest(value)
    if (memory.has(hash)) return false
    if (memory.size >= MEMORY_LIMIT) memory.delete(memory.keys().next().value)
    memory.set(hash, until)
    return true
  }
  claims(claims) {
    const now = this.now()
    const { ver, iss, aud, sub, roles, workspace, iat, exp, nbf } = claims
    if (ver !== 1 || iss !== this.config.issuer || typeof aud !== 'string' || aud !== this.config.workspace || workspace !== aud ||
      typeof sub !== 'string' || !sub || sub.length > 256 ||
      !Array.isArray(roles) || !roles.length || roles.length > 16 || !roles.every(role => typeof role === 'string') ||
      !Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || iat < 0 || exp <= iat || exp - iat > TOKEN_MAX_SECONDS ||
      iat * 1000 > now + CLOCK_SKEW_SECONDS * 1000 || exp * 1000 <= now ||
      (nbf !== undefined && (!Number.isSafeInteger(nbf) || nbf * 1000 > now + CLOCK_SKEW_SECONDS * 1000))) throw refused()
    // Unknown roles are ignored, as the contract's readers must; admission needs a known one.
    const known = ROLES.filter(role => roles.includes(role))
    if (!known.some(role => ADMITTED.includes(role))) throw refused()
    return {
      principal: { issuer: this.config.identity, subject: sub, roles: known, workspace },
      // The session never outlives the token, nor 5 minutes from now, whatever the clocks say.
      expires: Math.min(exp * 1000, now + TOKEN_MAX_SECONDS * 1000),
    }
  }
  async verify(token) {
    if (typeof token !== 'string' || token.length > 8192) throw refused()
    const parts = token.split('.')
    if (parts.length !== 3) throw refused()
    let header, claims, signature
    try { header = object(parts[0]); claims = object(parts[1]); signature = decoded(parts[2]) }
    catch { throw refused() }
    // The key comes only from the configured key set: jku, jwk and x5u are never followed.
    if (header.alg !== 'EdDSA' || (header.typ !== undefined && header.typ !== 'JWT') ||
      typeof header.kid !== 'string' || !header.kid || header.kid.length > 256 ||
      header.crit !== undefined || header.b64 !== undefined) throw refused()
    this.claims(claims)
    const key = await this.key(header.kid)
    // Time again after the key fetch.
    const opened = this.claims(claims)
    let valid = false
    try { valid = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, signature) } catch { valid = false }
    if (!valid) throw refused()
    // No token memory: version 1 has no jti, so two opens in one second can carry equal tokens.
    // A token reaches the gate only from its own exchange of a single-use code.
    return opened
  }
  async open(code) {
    if (typeof code !== 'string' || !CODE.test(code)) throw refused()
    if (this.inflight >= MAX_EXCHANGES) throw new CloudOpenRefused(429)
    if (!this.remember(this.codes, code, this.now() + CODE_MEMORY_MS)) throw refused()
    this.inflight++
    let reply
    try { reply = await this.call(this.config.exchange, { version: 1, code, workspace: this.config.workspace }) }
    catch { throw refused() }
    finally { this.inflight-- }
    if (!reply || typeof reply !== 'object' || reply.version !== 1 || typeof reply.token !== 'string' ||
      !Number.isSafeInteger(reply.expires_in) || reply.expires_in < 1 || reply.expires_in > TOKEN_MAX_SECONDS) throw refused()
    return this.verify(reply.token)
  }
}
