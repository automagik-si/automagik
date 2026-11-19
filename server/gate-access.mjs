// Optional owner sign-in. No discovery and no connection until a configured gate receives
// an assertion. All key locations come from host configuration, never from JWT headers.
import { constants, createPublicKey, verify } from 'node:crypto'
import https from 'node:https'
import { isIP } from 'node:net'
import { isUtf8 } from 'node:buffer'
import { createOwner, principalOf, readOwner } from './gate-store.mjs'

const SETTINGS = ['AUTOMAGIK_GATE_ACCESS_TEAM_DOMAIN', 'AUTOMAGIK_GATE_ACCESS_AUD', 'AUTOMAGIK_GATE_ACCESS_EMAILS']
export const CERT_TTL_MS = 5 * 60 * 1000
export const REFRESH_INTERVAL_MS = 30 * 1000
export const CLOCK_SKEW_SECONDS = 30
const MAX_CERT_BYTES = 128 * 1024
const reject = () => new Error('Access assertion refused')
export class AccessConfigurationError extends Error {}

export function accessConfig(env) {
  const values = SETTINGS.map(name => env[name]?.trim() || '')
  if (values.every(value => !value)) return undefined
  const missing = SETTINGS.filter((name, i) => !values[i])
  if (missing.length) throw new AccessConfigurationError(`Missing Access settings: ${missing.join(', ')}`)
  const [domain, audience, list] = values
  // ASCII DNS host only: no scheme, path, port, credentials, IP, wildcard or trailing dot.
  if (domain.length > 253 || isIP(domain) || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(domain)) {
    throw new AccessConfigurationError('AUTOMAGIK_GATE_ACCESS_TEAM_DOMAIN must be a DNS host only, without scheme, port or path')
  }
  if (audience.length > 1024 || /\s/.test(audience)) throw new AccessConfigurationError('Invalid AUTOMAGIK_GATE_ACCESS_AUD')
  const emails = list.split(',').map(value => value.trim().toLowerCase())
  if (emails.some(value => !/^[^\s@]+@[^\s@]+$/.test(value))) throw new AccessConfigurationError('Invalid AUTOMAGIK_GATE_ACCESS_EMAILS')
  return { issuer: `https://${domain.toLowerCase()}`, audience, emails: new Set(emails) }
}

export function fetchAccessKeys(url, { request = https.get } = {}) {
  return new Promise((resolve, rejectPromise) => {
    let response
    const req = request(url, { headers: { accept: 'application/json' } }, incoming => {
      response = incoming
      incoming.on('error', () => rejectPromise(reject()))
      incoming.on('aborted', () => rejectPromise(reject()))
      if (incoming.statusCode !== 200) { req.destroy(reject()); return }
      const chunks = []
      let size = 0
      incoming.on('data', chunk => {
        size += chunk.length
        if (size > MAX_CERT_BYTES) { req.destroy(reject()); return }
        chunks.push(chunk)
      })
      incoming.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch { rejectPromise(reject()) }
      })
    })
    // Absolute deadline, including DNS/TLS and slow-drip bodies; no redirects are followed.
    const timer = setTimeout(() => req.destroy(reject()), 5000).unref()
    req.on('close', () => { clearTimeout(timer); response?.destroy() })
    req.on('error', () => { clearTimeout(timer); rejectPromise(reject()) })
  })
}

export function decoded(segment) {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw reject()
  const bytes = Buffer.from(segment, 'base64url')
  if (bytes.toString('base64url') !== segment) throw reject()
  return bytes
}
export function object(segment) {
  const bytes = decoded(segment)
  if (!isUtf8(bytes)) throw reject()
  const value = JSON.parse(bytes.toString('utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw reject()
  return value
}
function publicKeys(document) {
  if (!document || !Array.isArray(document.keys) || !document.keys.length || document.keys.length > 16) throw reject()
  const keys = new Map()
  for (const jwk of document.keys) {
    if (jwk.kty !== 'RSA' || (jwk.alg !== undefined && jwk.alg !== 'RS256') || (jwk.use !== undefined && jwk.use !== 'sig')) continue
    if (typeof jwk.kid !== 'string' || !jwk.kid || jwk.kid.length > 256 || keys.has(jwk.kid) || jwk.d !== undefined) throw reject()
    if (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes('verify'))) throw reject()
    const key = createPublicKey({ key: jwk, format: 'jwk' })
    const bits = key.asymmetricKeyDetails?.modulusLength
    if (key.asymmetricKeyType !== 'rsa' || bits < 2048 || bits > 8192) throw reject()
    keys.set(jwk.kid, key)
  }
  if (!keys.size) throw reject()
  return keys
}

export class AccessSignIn {
  constructor(config, { ownerDir, now = Date.now, loadKeys = fetchAccessKeys } = {}) {
    this.config = config
    this.ownerDir = ownerDir
    this.now = now
    this.loadKeys = loadKeys
    this.keys = new Map()
    this.expires = 0
    this.nextFetch = 0
  }
  async key(kid) {
    if (this.now() < this.expires && this.keys.has(kid)) return this.keys.get(kid)
    if (!this.pending) {
      if (this.now() < this.nextFetch) throw reject()
      this.nextFetch = this.now() + REFRESH_INTERVAL_MS
      this.pending = Promise.resolve().then(() => this.loadKeys(new URL('/cdn-cgi/access/certs', this.config.issuer)))
        .then(document => { this.keys = publicKeys(document); this.expires = this.now() + CERT_TTL_MS })
        .catch(() => { this.keys.clear(); this.expires = 0; throw reject() })
        .finally(() => { this.pending = undefined })
    }
    await this.pending
    const key = this.now() < this.expires && this.keys.get(kid)
    if (!key) throw reject()
    return key
  }
  async signIn(assertion) {
    if (typeof assertion !== 'string' || assertion.length > 16 * 1024) throw reject()
    const parts = assertion.split('.')
    if (parts.length !== 3) throw reject()
    const header = object(parts[0])
    if (header.alg !== 'RS256' || (header.typ !== undefined && header.typ !== 'JWT') ||
      typeof header.kid !== 'string' || !header.kid || header.kid.length > 256 ||
      header.crit !== undefined || header.b64 !== undefined) throw reject()
    const claims = object(parts[1])
    const validateClaims = () => {
      const now = this.now() / 1000
      const { exp, nbf, iat, aud, email } = claims
      if (claims.iss !== this.config.issuer ||
        !(typeof aud === 'string' ? aud === this.config.audience : Array.isArray(aud) && aud.every(value => typeof value === 'string') && aud.includes(this.config.audience)) ||
        ![exp, nbf, iat].every(value => Number.isSafeInteger(value) && value >= 0) ||
        exp <= now - CLOCK_SKEW_SECONDS || nbf > now + CLOCK_SKEW_SECONDS || iat > now + CLOCK_SKEW_SECONDS || exp <= iat || exp <= nbf ||
        typeof email !== 'string' || !this.config.emails.has(email.toLowerCase()) ||
        claims.type !== 'app') throw reject()
    }
    validateClaims()
    const signature = decoded(parts[2])
    const key = await this.key(header.kid)
    validateClaims()
    if (!verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), { key, padding: constants.RSA_PKCS1_PADDING }, signature)) throw reject()
    let owner = readOwner(this.ownerDir)
    if (!owner) {
      try { owner = createOwner(this.ownerDir) }
      catch (error) { if (error.code !== 'EEXIST') throw error; owner = readOwner(this.ownerDir) }
    }
    return principalOf(owner)
  }
}
