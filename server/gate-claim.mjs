// Self-hosted only. Access mode never constructs this service or its host control socket.
import { EventEmitter } from 'node:events'
import { createHash, randomBytes, randomUUID, scrypt as derive, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server'
import { decodeAttestationObject, decodeClientDataJSON } from '@simplewebauthn/server/helpers'
import { createOwner, principalOf, readOwner, sessionCookie, LOCAL_TRUST_NOTICE } from './gate-store.mjs'
import { CLEAR_SITE_DATA } from './gate-roles.mjs'
import { claimPage } from './gate-claim-ui.mjs'

export const CLAIM_MS = 15 * 60 * 1000
export const CHALLENGE_MS = 5 * 60 * 1000
export const PREAUTH_COOKIE = '__Host-automagik-preauth'
export const CLAIM_PENALTY_LIMIT = 64
export const CLAIM_PENALTY_MS = 250
const scrypt = promisify(derive)
const hash = value => createHash('sha256').update(String(value ?? '')).digest()
const opaque = () => randomBytes(32).toString('base64url')
const fail = (status = 401, message = 'Passkey authentication required') => Object.assign(new Error(message), { status })
const IP_REASON = 'IP origins cannot use passkeys; use localhost or a stable HTTPS name.'
export class ClaimConfigurationError extends Error {}
export function passkeyOrigin(value) {
  let url
  try { url = new URL(value) } catch { throw new ClaimConfigurationError('Configure an exact localhost or HTTPS passkey origin') }
  if (isIP(url.hostname.replace(/^\[|\]$/g, ''))) throw new ClaimConfigurationError(IP_REASON)
  if (url.origin !== value || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost'))) {
    throw new ClaimConfigurationError('Passkeys require an exact HTTPS origin or HTTP localhost origin, without a path')
  }
  return url
}
function write(file, value) {
  const fresh = `${file}.${process.pid}.tmp`
  writeFileSync(fresh, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  chmodSync(fresh, 0o600)
  renameSync(fresh, file)
}
function read(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}
function reply(res, status, body) {
  res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(body))
}
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw fail(415, 'Use application/json')
  const chunks = []; let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 32 * 1024) throw fail(413, 'Request too large')
    chunks.push(chunk)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail()
    return value
  } catch { throw fail(400, 'Invalid JSON request') }
}
const credentialValid = c => c && typeof c.id === 'string' && /^[A-Za-z0-9_-]+$/.test(c.id) &&
  typeof c.publicKey === 'string' && /^[A-Za-z0-9_-]+$/.test(c.publicKey) && Number.isSafeInteger(c.counter) && c.counter >= 0
function validateAuth(auth) {
  if (!auth || auth.version !== 1 || !['claimed', 'unclaimed'].includes(auth.status) ||
    typeof auth.generation !== 'string' || typeof auth.origin !== 'string' || typeof auth.rpID !== 'string' ||
    typeof auth.userID !== 'string' || !Array.isArray(auth.credentials) || !auth.credentials.every(credentialValid) ||
    !Array.isArray(auth.recovery) || !auth.recovery.every(c => /^[a-f0-9]{32}$/.test(c.salt) && /^[a-f0-9]{64}$/.test(c.hash)) ||
    (auth.status === 'claimed' && !auth.credentials.length)) throw new ClaimConfigurationError('Unsupported passkey state; preserve it and use a compatible gate build')
}

export class SelfHostedClaim extends EventEmitter {
  constructor({ dir, origin, sessions, claimMode = 'local', clearOnSignIn = false, now = Date.now, audit = record => process.stderr.write(`${JSON.stringify(record)}\n`) }) {
    super()
    if (!['local', 'remote'].includes(claimMode)) throw new ClaimConfigurationError('AUTOMAGIK_GATE_CLAIM must be local or remote')
    this.claimMode = claimMode
    this.clearOnSignIn = clearOnSignIn
    this.dir = dir; this.origin = passkeyOrigin(origin); this.sessions = sessions; this.now = now; this.audit = audit
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.owner = readOwner(dir)
    if (this.owner?.auth !== undefined) validateAuth(this.owner.auth)
    this.pending = new Map(); this.rates = new Map(); this.preauth = new Map(); this.claimPenalties = new Set(); this.claimFailures = 0; this.queue = Promise.resolve()
    this.claimFile = join(dir, 'claim-state.json'); this.codeFile = join(dir, 'claim-code')
  }
  get claimed() { return this.owner?.auth?.status === 'claimed' && this.owner.auth.origin === this.origin.origin && this.owner.auth.rpID === this.origin.hostname }
  get claimable() { return !this.owner || this.owner.auth?.status === 'unclaimed' }
  exclusive(work) { const task = this.queue.then(work); this.queue = task.catch(() => {}); return task }
  async start({ interactive = false, show = () => {} } = {}) {
    if (!this.claimed) this.sessions.revokeAll()
    if (this.claimable) this.newCode({ interactive, show })
  }
  newCode({ interactive = false, show = () => {} } = {}) {
    if (!this.claimable) throw fail(409, 'The instance already has an owner')
    const value = randomBytes(16).toString('hex')
    this.claim = { version: 1, hash: hash(value).toString('hex'), expires: this.now() + CLAIM_MS, generation: opaque() }
    write(this.claimFile, this.claim)
    rmSync(this.codeFile, { force: true })
    if (interactive) show(value)
    else { writeFileSync(this.codeFile, `${value}\n`, { mode: 0o600 }); chmodSync(this.codeFile, 0o600) }
    this.pending.clear()
    this.preauth.clear()
  }
  rate(bucket) {
    const entry = this.rates.get(bucket)
    if (!entry || this.now() >= entry.until) { this.rates.set(bucket, { until: this.now() + 60_000, count: 1 }); return }
    if (++entry.count > (bucket === 'signin' ? 20 : 5)) throw fail(429, 'Too many attempts; wait one minute')
  }
  checkCode(code) {
    const stored = read(this.claimFile)
    if (!this.claimable || !stored || stored.version !== 1 || !/^[a-f0-9]{64}$/.test(stored.hash) ||
      !Number.isSafeInteger(stored.expires) || stored.generation !== this.claim?.generation ||
      this.now() >= stored.expires || !timingSafeEqual(Buffer.from(stored.hash, 'hex'), hash(code))) throw fail()
    return stored
  }
  browser(req, res) {
    const values = (req.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${PREAUTH_COOKIE}=`))
    const token = values.length === 1 ? values[0].slice(PREAUTH_COOKIE.length + 1) : undefined
    let current
    const existing = () => {
      for (const [id, session] of this.preauth) if (session.expires <= this.now()) this.preauth.delete(id)
      const id = current?.id ?? (typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token) ? hash(token).toString('hex') : undefined)
      return id ? this.preauth.get(id) : undefined
    }
    return {
      existing,
      start: () => {
        const found = existing()
        if (found) return found
        // Unauthenticated callers cannot allocate sessions before the options route's proof.
        // Expire/evict unused records, retaining browsers with an active ceremony.
        if (this.preauth.size >= 128) {
          const protectedIDs = new Set([...this.pending.values()].filter(p => p.expires > this.now()).map(p => p.browser))
          for (const id of this.preauth.keys()) if (!protectedIDs.has(id)) { this.preauth.delete(id); break }
        }
        if (this.preauth.size >= 128) throw fail(429, 'Too many pending ceremonies')
        const secret = opaque(), id = hash(secret).toString('hex')
        current = { id, expires: this.now() + CHALLENGE_MS }
        this.preauth.set(id, current)
        res.setHeader('set-cookie', `${PREAUTH_COOKIE}=${secret}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${CHALLENGE_MS / 1000}`)
        return current
      },
    }
  }
  generation() { return this.owner?.auth?.generation ?? this.claim?.generation }
  requireFamily(family) { if (!family || !this.claimed || !this.sessions.active(family)) throw fail() }
  save(auth, { revoke = true } = {}) {
    if (revoke) { this.sessions.revokeAll(); this.pending.clear(); this.preauth.clear(); auth.generation = opaque() }
    const owner = { ...this.owner, auth }
    write(join(this.dir, 'owner.json'), owner)
    this.owner = owner
  }
  remember(purpose, options, extra = {}) {
    for (const [id, p] of this.pending) if (p.expires <= this.now()) this.pending.delete(id)
    if (this.pending.size >= 32) throw fail(429, 'Too many pending ceremonies')
    const id = opaque()
    this.pending.set(id, { purpose, challenge: options.challenge, expires: this.now() + CHALLENGE_MS, generation: this.generation(), ...extra })
    return { id, options }
  }
  take(id, purpose, family, browser) {
    const p = this.pending.get(id)
    if (!p || p.purpose !== purpose || p.expires <= this.now() || p.generation !== this.generation() ||
      (p.family && p.family !== family?.id) || (purpose !== 'add' && (!p.browser || p.browser !== browser?.id || browser.expires <= this.now()))) throw fail()
    // A different browser cannot burn the legitimate browser's challenge.
    this.pending.delete(id)
    return p
  }
  current(p) { if (p.expires <= this.now() || p.generation !== this.generation() || (p.browser && p.browserExpires <= this.now())) throw fail() }
  async registration(purpose, family, browser) {
    const userID = this.owner?.auth?.userID ?? opaque()
    const options = await generateRegistrationOptions({
      rpName: 'Automagik', rpID: this.origin.hostname, userName: 'owner', userID: Buffer.from(userID, 'base64url'),
      supportedAlgorithmIDs: [-7], attestationType: 'none',
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      excludeCredentials: (this.owner?.auth?.credentials ?? []).map(c => ({ id: c.id })),
    })
    return this.remember(purpose, options, { userID, family: family?.id, browser: browser?.id, browserExpires: browser?.expires })
  }
  async verifyRegistration(p, response) {
    // No attestation PKI, metadata service, certificate fetch or untrusted certificate URL.
    if (decodeAttestationObject(Buffer.from(response?.response?.attestationObject ?? '', 'base64url')).get('fmt') !== 'none' ||
      decodeClientDataJSON(response.response.clientDataJSON).crossOrigin === true) throw fail()
    const verified = await verifyRegistrationResponse({ response, expectedChallenge: p.challenge, expectedOrigin: this.origin.origin,
      expectedRPID: this.origin.hostname, supportedAlgorithmIDs: [-7], requireUserPresence: true, requireUserVerification: true })
    if (!verified.verified) throw fail()
    const c = verified.registrationInfo.credential
    return { id: c.id, publicKey: Buffer.from(c.publicKey).toString('base64url'), counter: c.counter,
      transports: c.transports, created: this.now() }
  }
  async recoveryCodes() {
    const codes = [], records = []
    for (let i = 0; i < 8; i++) {
      const raw = randomBytes(16).toString('hex'); const salt = randomBytes(16).toString('hex')
      codes.push(raw.match(/.{8}/g).join('-'))
      const derived = await scrypt(raw, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
      records.push({ salt, hash: derived.toString('hex') })
    }
    return { codes, records }
  }
  async reset() {
    return this.exclusive(async () => {
      this.sessions.revokeAll(); this.pending.clear(); this.preauth.clear(); this.rates.clear(); this.claimFailures = 0
      if (this.owner) this.save({ version: 1, status: 'unclaimed', generation: opaque(), origin: this.origin.origin,
        rpID: this.origin.hostname, userID: opaque(), credentials: [], recovery: [] })
      await this.bindingChange?.(false, true)
      this.newCode()
      return { reset: true }
    })
  }
  async renewCode() { return this.exclusive(async () => { this.newCode(); return { renewed: true } }) }
  penalty(signal) {
    if (signal?.aborted) return Promise.resolve()
    if (this.claimPenalties.size >= CLAIM_PENALTY_LIMIT) throw fail(429, 'Too many pending claim attempts')
    return new Promise(resolve => {
      let timer
      const done = () => {
        if (!this.claimPenalties.delete(done)) return
        clearTimeout(timer)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      this.claimPenalties.add(done)
      timer = setTimeout(done, CLAIM_PENALTY_MS)
      signal?.addEventListener('abort', done, { once: true })
      if (signal?.aborted) done()
    })
  }
  async action(route, data, family, browser, signal) {
    if (this.claimMode === 'remote' && (route === 'claim/options' || route === 'claim/verify')) {
      try { this.checkCode(data.code) }
      catch (error) {
        this.claimFailures = Math.min(Number.MAX_SAFE_INTEGER, this.claimFailures + 1)
        const status = !signal?.aborted && this.claimPenalties.size >= CLAIM_PENALTY_LIMIT ? 429 : error.status ?? 400
        this.audit({ status, claim_failures: this.claimFailures, request_id: randomUUID() })
        // Delay each wrong attempt outside the state queue. Invalid traffic must never
        // spend a shared allowance or make a correct code wait behind the penalty.
        await this.penalty(signal)
        throw error
      }
    }
    return this.exclusive(async () => {
      if (route === 'claim/options') {
        if (this.claimMode === 'local') this.rate('claim')
        this.checkCode(data.code)
        const preauth = browser?.start()
        if (!preauth) throw fail()
        return this.registration('claim', undefined, preauth)
      }
      if (route === 'claim/verify') {
        if (this.claimMode === 'local') this.rate('claim')
        this.checkCode(data.code)
        const p = this.take(data.id, 'claim', undefined, browser?.existing())
        const credential = await this.verifyRegistration(p, data.credential)
        const recovery = await this.recoveryCodes()
        this.current(p); this.checkCode(data.code)
        const auth = { version: 1, status: 'claimed', generation: opaque(), origin: this.origin.origin, rpID: this.origin.hostname,
          userID: p.userID, credentials: [credential], recovery: recovery.records }
        // Exclusive creation prevents two claims from replacing the first owner, including across processes.
        if (!this.owner) this.owner = createOwner(this.dir, { auth })
        else this.save(auth)
        this.sessions.revokeAll(); this.pending.clear(); this.claim = undefined
        rmSync(this.claimFile, { force: true }); rmSync(this.codeFile, { force: true })
        const issued = this.sessions.issue(this.origin.origin, principalOf(this.owner))
        // Rebinding closes the listener only after this HTTP response has completed.
        this.bindingChange?.(true, false).catch(() => {})
        return { cookie: sessionCookie(issued.secret), recoveryCodes: recovery.codes, offerSecondPasskey: true }
      }
      if (route === 'signin/options') {
        this.rate('signin')
        if (!this.claimed) throw fail(409, 'Use recovery or a host reset to enrol this origin')
        const options = await generateAuthenticationOptions({ rpID: this.origin.hostname, userVerification: 'required',
          allowCredentials: this.owner.auth.credentials.map(c => ({ id: c.id, transports: c.transports })) })
        const preauth = browser?.start()
        if (!preauth) throw fail()
        return this.remember('signin', options, { browser: preauth.id, browserExpires: preauth.expires })
      }
      if (route === 'signin/verify') {
        this.rate('signin')
        const p = this.take(data.id, 'signin', undefined, browser?.existing())
        if (!this.claimed) throw fail()
        const stored = this.owner.auth.credentials.find(c => c.id === data.credential?.id)
        if (data.credential?.response?.userHandle && data.credential.response.userHandle !== this.owner.auth.userID) throw fail()
        if (!stored || decodeClientDataJSON(data.credential.response.clientDataJSON).crossOrigin === true) throw fail()
        const result = await verifyAuthenticationResponse({ response: data.credential, expectedChallenge: p.challenge,
          expectedOrigin: this.origin.origin, expectedRPID: this.origin.hostname, requireUserVerification: true,
          credential: { ...stored, publicKey: Buffer.from(stored.publicKey, 'base64url') } })
        this.current(p)
        if (!result.verified) throw fail()
        stored.counter = result.authenticationInfo.newCounter
        this.save(this.owner.auth, { revoke: false })
        const issued = this.sessions.issue(this.origin.origin, principalOf(this.owner))
        return { cookie: sessionCookie(issued.secret) }
      }
      if (route === 'passkeys/options') { this.rate('passkeys'); this.requireFamily(family); return this.registration('add', family) }
      if (route === 'passkeys/verify') {
        this.rate('passkeys'); this.requireFamily(family)
        const p = this.take(data.id, 'add', family); const credential = await this.verifyRegistration(p, data.credential)
        this.current(p)
        this.requireFamily(family)
        if (this.owner.auth.credentials.some(c => c.id === credential.id)) throw fail(409, 'Passkey already registered')
        this.owner.auth.credentials.push(credential); this.save(this.owner.auth)
        return { signInAgain: true }
      }
      if (route === 'passkeys/remove') {
        this.requireFamily(family)
        const credentials = this.owner.auth.credentials.filter(c => c.id !== data.id)
        if (!credentials.length || credentials.length === this.owner.auth.credentials.length) throw fail(409, 'Keep at least one registered passkey')
        this.save({ ...this.owner.auth, credentials }); return { signInAgain: true }
      }
      if (route === 'recovery/codes') {
        this.rate('recovery'); this.requireFamily(family)
        const recovery = await this.recoveryCodes(); this.requireFamily(family)
        this.save({ ...this.owner.auth, recovery: recovery.records })
        return { recoveryCodes: recovery.codes, signInAgain: true }
      }
      if (route === 'recovery/options') {
        this.rate('recovery')
        if (!this.owner?.auth || this.owner.auth.status !== 'claimed') throw fail()
        const raw = typeof data.code === 'string' ? data.code.replaceAll('-', '').toLowerCase() : ''
        let found = -1
        for (let i = 0; i < this.owner.auth.recovery.length; i++) {
          const record = this.owner.auth.recovery[i]
          const candidate = await scrypt(raw, record.salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
          if (timingSafeEqual(candidate, Buffer.from(record.hash, 'hex'))) found = i
        }
        if (found < 0) throw fail()
        const recovery = this.owner.auth.recovery.filter((c, i) => i !== found)
        this.save({ ...this.owner.auth, recovery })
        this.audit({ status: 'recovery-used', request_id: randomUUID() })
        const preauth = browser?.start()
        if (!preauth) throw fail()
        return this.registration('recovery', undefined, preauth)
      }
      if (route === 'recovery/verify') {
        this.rate('recovery')
        const p = this.take(data.id, 'recovery', undefined, browser?.existing()); const credential = await this.verifyRegistration(p, data.credential)
        this.current(p)
        if (this.owner.auth.origin === this.origin.origin && this.owner.auth.credentials.some(c => c.id === credential.id)) throw fail(409, 'Passkey already registered')
        const credentials = this.owner.auth.origin === this.origin.origin ? [...this.owner.auth.credentials, credential] : [credential]
        this.save({ ...this.owner.auth, origin: this.origin.origin, rpID: this.origin.hostname, credentials })
        this.bindingChange?.(true, false).catch(() => {})
        return { signInAgain: true }
      }
      throw fail(404, 'Unknown passkey route')
    })
  }
  async handle(req, res, family, { bootstrap = false } = {}) {
    const path = new URL(req.url, this.origin).pathname
    const root = '/_gate/'
    const pages = new Map([['claim', this.claimable], ['sign-in', !this.claimable], ['recovery', !this.claimable], ['settings', Boolean(family)]])
    const actions = new Set(['claim/options', 'claim/verify', 'signin/options', 'signin/verify', 'passkeys/options', 'passkeys/verify',
      'passkeys/remove', 'recovery/options', 'recovery/verify', 'recovery/codes'])
    if (!path.startsWith(root)) return false
    const route = path.slice(root.length)
    const claimRoute = route === 'claim' || route.startsWith('claim/')
    if (claimRoute && bootstrap !== (this.claimMode === 'local')) {
      reply(res, 404, { error: 'Unknown gate route' }); return true
    }
    if (!pages.has(route) && !actions.has(route) && route !== 'passkeys') return false
    try {
      let incoming
      try { incoming = new URL(`${this.origin.protocol}//${req.headers.host}`) } catch { throw fail(403, 'Origin must match the configured passkey origin') }
      if (isIP(incoming.hostname.replace(/^\[|\]$/g, ''))) throw fail(400, IP_REASON)
      if (req.headers.host !== this.origin.host || (req.headers.origin !== undefined && req.headers.origin !== this.origin.origin) ||
        req.headers['sec-fetch-site'] === 'cross-site' || (req.method === 'POST' && req.headers.origin !== this.origin.origin)) throw fail(403, 'Origin must match the configured passkey origin, including its port')
      if (req.method === 'GET' && route === 'passkeys') { this.requireFamily(family); reply(res, 200, this.settings()); return true }
      if (req.method === 'GET' && pages.get(route)) {
        if (route === 'settings') this.requireFamily(family)
        const nonce = opaque()
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY',
          'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'` })
        res.end(claimPage(route, nonce)); return true
      }
      if (req.method === 'GET' && route === 'settings') throw fail()
      if (req.method !== 'POST' || !actions.has(route)) throw fail()
      const controller = new AbortController()
      const disconnected = () => controller.abort()
      res.once('close', disconnected)
      try {
        const data = await body(req)
        if (res.destroyed || controller.signal.aborted) return true
        const result = await this.action(route, data, family, this.browser(req, res), controller.signal)
        if (res.destroyed) return true
        if (result.cookie) {
          res.setHeader('set-cookie', result.cookie)
          if (this.clearOnSignIn) res.setHeader('clear-site-data', CLEAR_SITE_DATA)
          delete result.cookie
        }
        reply(res, 200, result)
      } finally { res.off('close', disconnected) }
    } catch (error) {
      if (res.destroyed) return true
      this.audit({ status: error.status ?? 400, request_id: randomUUID() })
      reply(res, error.status ?? 400, { error: error.status ? error.message : 'Passkey verification failed' })
    }
    return true
  }
  settings() { return { passkeys: this.owner?.auth?.credentials.map(c => ({ id: c.id, created: c.created })) ?? [],
    recoveryCodesRemaining: this.owner?.auth?.recovery.length ?? 0, local_trust_notice: LOCAL_TRUST_NOTICE,
    bot_trust_notice: 'Sign-in protects this instance from the network, not from its own Bots.' } }
}
