// Gate-only state. Never mount this directory into DSH or a Bot's container.
import { EventEmitter } from 'node:events'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const IDLE_MS = 12 * 60 * 60 * 1000
export const COOKIE = '__Host-automagik-session'
export const LOCAL_TRUST_NOTICE = 'On loopback, another local service can receive your cookie. A local process holding it can replay it with any Origin; origin binding does not prevent this. Local processes are inside the host trust boundary.'
const digest = value => createHash('sha256').update(value).digest('hex')
export const sessionHash = familyId => createHash('sha256').update(familyId).digest('base64url')
const secret = () => randomBytes(32).toString('base64url')
const hashPattern = /^[a-f0-9]{64}$/
const localPrincipal = p => p && typeof p.subject === 'string' && p.subject.length > 0 &&
  typeof p.workspace === 'string' && p.workspace.length > 0 && p.issuer === `local:${p.workspace}` &&
  Array.isArray(p.roles) && p.roles.length === 1 && p.roles[0] === 'owner' &&
  Object.keys(p).sort().join(',') === 'issuer,roles,subject,workspace'
// The Cloud renewal proof is the exact workspace token the gate verified at open, kept with the
// in-memory Cloud session and never written to a browser, a file or a log.
const validProof = p => p && typeof p === 'object' && !Array.isArray(p) &&
  Object.keys(p).sort().join(',') === 'aud,exp,token' &&
  typeof p.token === 'string' && p.token.length > 0 && p.token.length <= 8192 &&
  typeof p.aud === 'string' && p.aud.length > 0 && p.aud.length <= 256 &&
  Number.isSafeInteger(p.exp)
const validFamily = f => f && typeof f.id === 'string' && typeof f.origin === 'string' &&
  localPrincipal(f.principal) && hashPattern.test(f.current) && Array.isArray(f.used) &&
  f.used.every(h => typeof h === 'string' && hashPattern.test(h)) &&
  Number.isSafeInteger(f.created) && Number.isSafeInteger(f.touched) && f.touched >= f.created

function read(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}
function write(file, value) {
  const fresh = `${file}.${process.pid}.tmp`
  writeFileSync(fresh, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  chmodSync(fresh, 0o600)
  renameSync(fresh, file)
}

export function readOwner(dir) {
  const record = read(join(dir, 'owner.json'))
  if (record === undefined) return undefined
  // Unknown versions and malformed records stop startup; neither means unclaimed.
  if (record.version !== 1 || !record.local_id || !record.instance_id || record.linked !== undefined) {
    throw new Error('Owner record unsupported; preserve it and use a compatible gate build')
  }
  if (typeof record.local_id !== 'string' || typeof record.instance_id !== 'string') throw new Error('Invalid owner record')
  return record
}

// Exclusive owner creation for authenticated sign-in. The caller must first
// prove the claim. Exclusive creation ensures an existing or newer record is not replaced.
export function createOwner(dir, { auth } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const owner = { version: 1, local_id: randomUUID(), instance_id: randomUUID(), ...(auth === undefined ? {} : { auth }) }
  writeFileSync(join(dir, 'owner.json'), `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: 0o600 })
  return owner
}
export function principalOf(owner) {
  return { issuer: `local:${owner.instance_id}`, subject: owner.local_id, roles: ['owner'], workspace: owner.instance_id }
}
export function sessionCookie(value, maxAge = IDLE_MS / 1000) {
  // Secure is required by __Host-, including HTTP localhost (browser's trusted loopback).
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
}
export function cookieSecret(header = '') {
  const values = header.split(';').map(v => v.trim()).filter(v => v.startsWith(`${COOKIE}=`))
  if (values.length !== 1) return undefined
  const value = values[0].slice(COOKIE.length + 1)
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined
}

export class SessionStore extends EventEmitter {
  #bySession = new Map()
  #sessionHashes = new WeakMap()

  // Cloud mode keeps its sessions in memory only (`memory`), each bounded by its token's expiry,
  // and admits only the principals its own check (`accepts`) allows. Self-hosted keeps the file.
  constructor(dir, { now = Date.now, memory = false, accepts = localPrincipal } = {}) {
    super()
    this.now = now
    this.accepts = accepts
    if (memory) { this.families = []; return }
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.file = join(dir, 'sessions.json')
    const stored = read(this.file)
    if (stored !== undefined && (!stored || stored.version !== 1 || !Array.isArray(stored.families) || !stored.families.every(validFamily))) throw new Error('Unsupported session store')
    this.families = stored?.families ?? []
    for (const family of this.families) this.#index(family)
  }
  #index(family) {
    const session = sessionHash(family.id)
    this.#sessionHashes.set(family, session)
    this.#bySession.set(session, family)
  }
  #unindex(family) {
    const session = this.#sessionHashes.get(family)
    this.#sessionHashes.delete(family)
    if (this.#bySession.get(session) === family) this.#bySession.delete(session)
  }
  familyBySessionHash(session) { return this.#bySession.get(session) }
  save() { if (this.file) write(this.file, { version: 1, families: this.families }) }
  // Sign-in calls this only after authentication. `expires` (ms) is a hard end, never renewed.
  // `proof` is the verified Cloud workspace token the v2 renewal sends; Cloud sessions keep it
  // in memory, and no file-backed (self-hosted) session ever holds one.
  issue(origin, principal, { expires, proof } = {}) {
    if (!this.accepts(principal)) throw new Error('Principal refused for this session store')
    if (expires !== undefined && (!this.memory || !Number.isSafeInteger(expires))) throw new Error('Invalid session expiry')
    if (proof !== undefined && (!this.memory || !validProof(proof))) throw new Error('Invalid session proof')
    // Ended Cloud sessions leave memory here: their browsers drop the cookie, so none returns.
    if (this.memory) {
      this.families = this.families.filter(family => {
        if (family.expires === undefined || this.now() < family.expires) return true
        this.#unindex(family)
        return false
      })
    }
    const value = secret()
    const family = {
      id: randomUUID(), origin, principal: structuredClone(principal),
      current: digest(value), used: [], created: this.now(), touched: this.now(),
      ...(expires === undefined ? {} : { expires }),
      ...(proof === undefined ? {} : { proof: structuredClone(proof) }),
    }
    this.families.push(family)
    this.#index(family)
    this.save()
    return { secret: value, family }
  }
  get memory() { return !this.file }
  active(family) {
    return this.#sessionHashes.has(family) && this.now() - family.touched < IDLE_MS &&
      (family.expires === undefined || this.now() < family.expires)
  }
  // Cookie lifetime in seconds: the idle limit, or what is left before a hard end.
  maxAge(family) {
    const idle = IDLE_MS / 1000
    return family.expires === undefined ? idle : Math.max(0, Math.min(idle, Math.ceil((family.expires - this.now()) / 1000)))
  }
  authenticate(value, origin) {
    if (!value) return undefined
    const hash = Buffer.from(digest(value), 'hex')
    let current = false
    const family = this.families.find(f => {
      const matchesCurrent = timingSafeEqual(Buffer.from(f.current, 'hex'), hash)
      let matchesUsed = false
      // Compare every historical hash, including when the current one already matched.
      for (const used of f.used) {
        const matches = timingSafeEqual(Buffer.from(used, 'hex'), hash)
        matchesUsed = matches || matchesUsed
      }
      if (!matchesCurrent && !matchesUsed) return false
      current = matchesCurrent
      return true
    })
    if (!family || family.origin !== origin) return undefined
    if (!this.active(family) || !current) { this.revoke(family); return undefined }
    this.touch(family)
    return family
  }
  touch(family) {
    if (!this.active(family)) return false
    family.touched = this.now()
    this.save()
    return true
  }
  renew(family) {
    if (!this.active(family)) throw new Error('Expired session')
    const value = secret()
    family.used.push(family.current)
    family.current = digest(value)
    family.touched = this.now()
    this.save()
    return value
  }
  revoke(family) {
    this.families = this.families.filter(f => f !== family)
    this.#unindex(family)
    this.save()
    this.emit('revoke', family.id)
  }
  // `where` narrows to some families (one person's, in Cloud mode); without it, every family.
  revokeAll(where = () => true) {
    const previous = []
    this.families = this.families.filter(family => {
      if (!where(family)) return true
      previous.push(family)
      return false
    })
    for (const family of previous) this.#unindex(family)
    this.save()
    for (const family of previous) this.emit('revoke', family.id)
  }
  list(where = () => true) {
    return this.families.filter(f => this.active(f) && where(f)).map(f => ({ id: f.id, created: f.created, last_active: f.touched,
      expires_at: Math.min(f.touched + IDLE_MS, f.expires ?? Infinity) }))
  }
}
