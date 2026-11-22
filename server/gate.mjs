import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { Transform } from 'node:stream'
import { COOKIE, cookieSecret, IDLE_MS, LOCAL_TRUST_NOTICE, sessionCookie, sessionHash } from './gate-store.mjs'
import { frontendPath } from './gate-frontend.mjs'
import { agentMcpHeaders, callerHeaders, callerUpgradeHeaders, DSH_HOST, ownerAssertionHeaders,
  responseHeaders, upstreamHeaders, validBodyFraming } from './gate-upstream.mjs'
import { MEMBER_UPGRADE_PATH, memberStatus, probeDsh } from './gate-mux.mjs'
import { callerTarget, CLEAR_SITE_DATA, effectiveRole, ownerFamily } from './gate-roles.mjs'
import { samePerson, SIGNATURE_HEADER } from './gate-cloud.mjs'

export const CLOUD_OPEN_PATH = '/_gate/cloud/open'
export const CLOUD_OPEN_FINISH_PATH = '/_gate/cloud/open/finish'
export const CLOUD_RENEW_PATH = '/_gate/cloud/renew'
export const CLOUD_REVOCATION_PATH = '/_gate/cloud/revocation'
const MAX_OPEN_BODY = 4096
const MAX_PENDING_OPENS = 128
const OPEN_FINISH_MS = 60_000
const MAX_RENEW_BODY = 4096
const MAX_RENEW_HISTORY = 4096
const MAX_REVOCATION_BODY = 4096
const MAX_EARLY_UPGRADE_BYTES = 1_048_576 + 1024 * 14 // One max-size mux message, with frame headers.
// Match the adapter's socket limits while the gate is still holding the handshake.
const MAX_PENDING_UPGRADES_PER_PERSON = 4
const MAX_PENDING_UPGRADES = 64
const CLOUD_BROWSER_COOKIE = '__Host-automagik-browser'
const MEDIA_PATH = /^\/api\/omni-ui\/(?:image|pet|genui-media)\/?$/i

export function pinOrigin(value) {
  const url = new URL(value)
  if (url.origin !== value || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost'))) {
    throw new Error('Gate origin must be an exact HTTPS origin or HTTP localhost origin')
  }
  return url
}
function hasSingleHost(req) {
  let count = 0
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === 'host') count++
  }
  return count === 1
}

function trustedRequest(req, origin, upgrade, allowNavigation = false) {
  if (req.headers.host !== origin.host) return false
  if (req.headers.origin !== undefined && req.headers.origin !== origin.origin) return false
  if (req.headers['sec-fetch-site'] === 'cross-site' && !(allowNavigation && !upgrade && ['GET', 'HEAD'].includes(req.method) && req.headers['sec-fetch-mode'] === 'navigate')) return false
  return !(upgrade || !['GET', 'HEAD'].includes(req.method)) || req.headers.origin === origin.origin
}
// Gate management has one spelling. Do this before authentication so an alias cannot
// become a second sign-in/management entry, or pass raw to a differently decoding upstream.
function reservedPathAlias(rawUrl, origin) {
  const raw = rawUrl.split('?', 1)[0]
  const reserved = path => path === '/_gate' || path.startsWith('/_gate/')
  return explorePath(raw, origin, reserved, raw.startsWith('/_gate/'))
}

function privatePath(rawUrl, origin) {
  return explorePath(rawUrl.split('?', 1)[0], origin, path => {
    const lower = path.toLowerCase()
    return lower === '/_automagik' || lower.startsWith('/_automagik/')
  })
}

function explorePath(raw, origin, reserved, exemptRaw = false) {
  const queue = [raw]
  const seen = new Set(queue)
  for (let i = 0; i < queue.length; i++) {
    const candidate = queue[i]
    if (reserved(candidate) && (candidate !== raw || !exemptRaw)) return true
    let normalized
    try { normalized = new URL(candidate, origin).pathname }
    catch { return true }
    const forms = [normalized, candidate.replace(/\\/g, '/').replace(/\/{2,}/g, '/')]
    try { forms.push(decodeURIComponent(candidate)) }
    catch { if (reserved(candidate)) return true }
    // Explore compositions too: collapsing empty segments changes which '..' is resolved.
    for (const form of forms) {
      if (form !== raw && (reserved(raw) || reserved(form))) return true
      if (!seen.has(form)) {
        if (seen.size >= 64) return true
        seen.add(form)
        queue.push(form)
      }
    }
  }
  return false
}

function answer(res, status, value) {
  res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}
function readBody(req, limit, raw = false) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0, failed = false
    const timer = setTimeout(() => { req.destroy(); reject(new Error('Body timeout')) }, 5000).unref()
    req.on('data', chunk => {
      if (failed) return
      size += chunk.length
      // Stop collecting and answer at once; the refusal closes the connection.
      if (size > limit) { failed = true; clearTimeout(timer); reject(new Error('Body too large')); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      clearTimeout(timer)
      const body = Buffer.concat(chunks)
      resolve(raw ? body : body.toString('utf8'))
    })
    req.on('error', error => { clearTimeout(timer); reject(error) })
  })
}
function refuseSocket(socket, status = 401) {
  const destroy = () => socket.destroy()
  const timer = setTimeout(destroy, 1000).unref()
  socket.once('error', destroy)
  socket.once('close', () => clearTimeout(timer))
  // An upgraded/CONNECT socket can stay half-open forever after FIN. Close its descriptor
  // once the rejection has flushed, with a deadline even if the peer does not read it.
  socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, destroy)
}

const apiPath = path => path === '/api' || path.startsWith('/api/')
const exchangePath = url => url.pathname === '/connect'
const CALLER_PREFIX = '/_automagik/caller'

// ClientRequest cannot observe a close that occurred before the socket was handed to it.
function reuseProbe(probe) {
  return (_options, connected) => {
    if (!probe.destroyed && !probe.readableEnded && !probe.writableEnded) return probe
    probe.destroy()
    connected(new Error('DSH readiness connection closed'))
  }
}

// `connectDsh({ port, host, signal })` resolves a loopback socket on which the adapter answered
// its readiness probe; a member's request is sent on that socket and nowhere else.
export function createGate({ origin: value, sessions, credentials, access, cloud, selfHosted, bootstrap = false, multiuser = false, caller,
  successors = new Map(),
  connectDsh = options => probeDsh({ ...options, authority: credentials.authority }),
  auditAccess = record => process.stderr.write(`${JSON.stringify(record)}\n`) }) {
  if (multiuser && !caller) throw new Error('Multiuser requires a caller signer')
  const origin = pinOrigin(value)
  const clearSite = res => { if (multiuser) res.setHeader('clear-site-data', CLEAR_SITE_DATA) }
  const sessionRequired = (req, res) => {
    if (res.destroyed) return
    if (multiuser && trustedRequest(req, origin, false) && cookieSecret(req.headers.cookie)) {
      // A late request can still carry the old cookie after the browser's family
      // has rotated. A live successor means the browser is still signed in.
      const current = boundFamily(req.headers.cookie)
      if (!current || !sessions.active(current)) clearSite(res)
    }
    answer(res, 401, { error: 'Session required' })
  }
  const isMcpTarget = raw => new URL(raw, origin).pathname === '/api/omni-mcp'
  const sockets = new Map()
  const pendingUpgrades = new Map()
  let pendingUpgradeCount = 0
  const pendingOpens = new Map()
  const renewals = new Map()
  const consumed = new Set()
  const browserBindings = new WeakMap()
  // Gated HTTP responses are piped apart from the socket table. Family changes cut
  // forwarded requests at both ends, including owner streams.
  const httpRequests = new Set()
  const transports = new WeakMap()
  const endRequest = (record, hard = false) => {
    if (!httpRequests.delete(record)) return
    record.detach()
    record.abort.abort()
    record.probe?.destroy()
    record.proxy?.destroy()
    if ((record.proxy || hard) && !record.res.writableFinished) record.res.destroy()
  }
  function trackRequest(req, res, family, owner) {
    const socket = req.socket
    let transport = transports.get(socket)
    if (socket && !transport) {
      const records = new Set()
      const close = () => { for (const record of records) endRequest(record, true) }
      transport = { records, close }
      transports.set(socket, transport)
      socket.once('close', close)
    }
    const record = { family, owner, res, abort: new AbortController(), probe: undefined, proxy: undefined, detach() {
      res.off('close', closed)
      res.off('finish', finished)
      if (transport && transport.records.delete(record) && !transport.records.size) {
        socket.off('close', transport.close)
        transports.delete(socket)
      }
    } }
    const closed = () => endRequest(record, true)
    const finished = () => endRequest(record)
    httpRequests.add(record)
    transport?.records.add(record)
    res.once('close', closed)
    res.once('finish', finished)
    if (socket?.destroyed || res.destroyed) closed()
    return record
  }
  function retireTransports(id, hard = false) {
    for (const record of sockets.values()) if (record.family.id === id) record.socket.destroy()
    for (const record of httpRequests) if (record.family.id === id) endRequest(record, hard)
  }
  function boundFamily(header = '') {
    const prefix = CLOUD_BROWSER_COOKIE + '='
    const cookies = header.split(';').map(part => part.trim()).filter(part => part.startsWith(prefix))
    if (cookies.length !== 1) return
    const id = cookies[0].slice(prefix.length)
    return sessions.families.find(family => {
      const binding = browserBindings.get(family)
      return binding?.id === id && binding.familyId === family.id
    })
  }
  function cloudCookies(issued, binding) {
    const cookie = sessionCookie(issued.secret, sessions.maxAge(issued.family))
    if (!multiuser) return cookie
    // The independent cookie identifies this browser's previous transports when
    // the session cookie is absent. Authentication always uses the session cookie.
    binding ??= { id: randomUUID() }
    binding.familyId = issued.family.id
    browserBindings.set(issued.family, binding)
    return [cookie, `${CLOUD_BROWSER_COOKIE}=${binding.id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${IDLE_MS / 1000}`]
  }
  function issueCloudSession(req, res, opened) {
    const previous = sessions.authenticate(cookieSecret(req.headers.cookie), origin.origin)
    const browserFamily = previous ?? (multiuser ? boundFamily(req.headers.cookie) : undefined)
    const purge = !browserFamily || !sessions.active(browserFamily) || !samePerson(browserFamily.principal, opened.principal)
    if (browserFamily) retireTransports(browserFamily.id, true)
    if (previous) sessions.revoke(previous)
    const issued = sessions.issue(origin.origin, opened.principal, { expires: opened.expires, proof: opened.proof })
    if (purge) clearSite(res)
    res.writeHead(303, { location: '/', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      'set-cookie': cloudCookies(issued, browserBindings.get(browserFamily)) })
    res.end()
  }
  // The rail posts a single-use code. Only the gate sees the exchanged workspace token.
  async function cloudOpen(req, res) {
    const refuse = (status, error) => {
      auditAccess({ status, request_id: randomUUID() })
      res.setHeader('connection', 'close')
      answer(res, status, { error })
    }
    if (req.url !== CLOUD_OPEN_PATH) { refuse(400, 'Open codes and tokens never belong in a URL'); return }
    if (req.method !== 'POST') { refuse(405, 'Open takes a form post'); return }
    if (req.headers.host !== origin.host || req.headers.origin !== cloud.config.rail) { refuse(403, 'Invalid open origin'); return }
    if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') { refuse(415, 'Open takes a form post'); return }
    // A workspace token comes only from the gate's own exchange, never from a client.
    if (req.headers.authorization !== undefined) { refuse(401, 'Open refused'); return }
    let body
    try { body = await readBody(req, MAX_OPEN_BODY) } catch { refuse(413, 'Open refused'); return }
    const form = new URLSearchParams(body)
    const names = [...form.keys()]
    if (names.length !== 1 || names[0] !== 'code') { refuse(401, 'Open refused'); return }
    let opened
    try { opened = await cloud.open(form.get('code')) }
    catch (error) { refuse(error?.status === 429 ? 429 : 401, 'Open refused'); return }
    if (res.destroyed) return
    if (!multiuser) { issueCloudSession(req, res, opened); return }
    // The rail's cross-site POST omits the old Lax cookie. A document on the
    // gate origin can post it back before the new session replaces it.
    const now = sessions.now()
    for (const [id, pending] of pendingOpens) if (pending.deadline <= now) pendingOpens.delete(id)
    if (pendingOpens.size >= MAX_PENDING_OPENS) { refuse(429, 'Open refused'); return }
    const id = randomUUID()
    const deadline = Math.min(now + OPEN_FINISH_MS, opened.expires)
    pendingOpens.set(id, { opened, deadline, created: now })
    const nonce = randomUUID()
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'same-origin',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    })
    res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Continue to Automagik</title>
<form method="post" action="${CLOUD_OPEN_FINISH_PATH}"><input type="hidden" name="open" value="${id}">
<button>Continue to Automagik</button></form><script nonce="${nonce}">document.forms[0].requestSubmit()</script></html>`)
  }
  async function finishCloudOpen(req, res) {
    if (!multiuser || req.url !== CLOUD_OPEN_FINISH_PATH || req.method !== 'POST' || !trustedRequest(req, origin, false) ||
        req.headers.authorization !== undefined ||
        req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
      answer(res, 403, { error: 'Open refused' })
      return
    }
    let body
    try { body = await readBody(req, MAX_OPEN_BODY) }
    catch { answer(res, 413, { error: 'Open refused' }); return }
    if (res.destroyed) return
    const form = new URLSearchParams(body)
    const id = form.get('open')
    const pending = pendingOpens.get(id)
    if ([...form.keys()].length !== 1 || !pending) { answer(res, 401, { error: 'Open refused' }); return }
    pendingOpens.delete(id)
    const { opened, deadline, created } = pending
    if (deadline <= sessions.now() || cloud.drops({ principal: opened.principal, created })) {
      answer(res, 401, { error: 'Open refused' })
      return
    }
    issueCloudSession(req, res, opened)
  }
  // Contracts v2 (delivery 4): a renewing browser sends JSON, never a code. The request is
  // authenticated only by the gate's current Cloud session; the gate rechecks the role with
  // Cloud and replaces the session, keeping the rechecked roles and a life of 5 minutes at most.
  async function cloudRenew(req, res) {
    const refuse = (status, error) => {
      auditAccess({ status, request_id: randomUUID() })
      res.setHeader('connection', 'close')
      answer(res, status, { error })
    }
    if (req.url !== CLOUD_RENEW_PATH) { refuse(400, 'Renewal refused'); return }
    if (req.method !== 'POST') { refuse(405, 'Renewal takes a JSON post'); return }
    if (req.headers.host !== origin.host) { refuse(403, 'Invalid renewal origin'); return }
    if (req.headers.origin !== origin.origin || req.headers['sec-fetch-site'] === 'cross-site') { refuse(403, 'Invalid renewal origin'); return }
    if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') { refuse(415, 'Renewal takes JSON'); return }
    // A renewal is proved by the session cookie alone: no token, code or bearer is accepted.
    if (req.headers.authorization !== undefined) { refuse(401, 'Renewal refused'); return }
    let body
    try { body = await readBody(req, MAX_RENEW_BODY) } catch { refuse(413, 'Renewal refused'); return }
    let request
    try { request = JSON.parse(body) } catch { refuse(401, 'Renewal refused'); return }
    // Exactly the v2 shape: a v1 body, an unknown field or a role it names is refused whole.
    const fields = request && typeof request === 'object' && !Array.isArray(request) ? Object.keys(request).sort().join(',') : ''
    if (fields !== 'renew,version,workspace' || request.version !== 2 || request.renew !== true ||
      request.workspace !== cloud.config.workspace) { refuse(401, 'Renewal refused'); return }
    const family = sessions.authenticate(cookieSecret(req.headers.cookie), origin.origin)
    const current = family?.current
    const binding = browserBindings.get(family)
    const renewable = () => family && sessions.active(family) && !cloud.drops(family) &&
      (binding === undefined || binding.familyId === family.id)
    // An expired or already-revoked session, or one Cloud has dropped, never reaches Cloud.
    if (!renewable()) { refuse(401, 'Renewal refused'); return }
    if (renewals.has(family.id)) { refuse(429, 'Renewal in progress'); return }
    // The proof is the exact workspace token this gate verified for the session. A missing or
    // expired held token is refused with no grace, before Cloud is called. `workspace` is v1's
    // aud, never a host: it must equal both the configured id and the held token's aud.
    const proof = family.proof
    if (!proof || proof.aud !== request.workspace || proof.exp * 1000 <= sessions.now()) {
      refuse(401, 'Renewal refused')
      return
    }
    if (res.destroyed) return
    const release = () => { if (renewals.get(family.id) === release) renewals.delete(family.id) }
    renewals.set(family.id, release)
    res.once('close', release)
    try {
      const renewed = await cloud.renew(family.principal, proof)
      if (res.destroyed || renewals.get(family.id) !== release) return
      if (!samePerson(renewed.principal, family.principal) || !renewable() ||
          family.current !== current || consumed.has(family.id)) {
        refuse(401, 'Renewal refused')
        return
      }
      consumed.add(family.id)
      let issued
      try {
        issued = sessions.issue(origin.origin, renewed.principal, {
          expires: renewed.expires, proof: renewed.proof,
        })
      } catch (error) {
        consumed.delete(family.id)
        throw error
      }
      if (consumed.size > MAX_RENEW_HISTORY) consumed.delete(consumed.values().next().value)
      // Retire the old cookie and transports before exposing the renewed session.
      retireTransports(family.id, true)
      sessions.revoke(family)
      const session = sessionHash(issued.family.id)
      successors.set(sessionHash(family.id), {
        session, origin: family.origin, roles: family.principal.roles,
      })
      if (successors.size > MAX_RENEW_HISTORY) successors.delete(successors.keys().next().value)
      res.setHeader('set-cookie', cloudCookies(issued, binding))
      answer(res, 200, {})
    } catch (error) {
      if (!res.destroyed && renewals.get(family.id) === release) {
        refuse(error?.status === 429 ? 429 : 401, 'Renewal refused')
      }
    } finally {
      res.off('close', release)
      release()
    }
  }
  // Cloud's signed revocation call (contracts v1, section 6). It needs no browser session and
  // sets none; the detached JWS covers the exact body bytes, and the gate changes nothing
  // unless that signature verifies against the published key set.
  async function cloudRevoke(req, res) {
    const refuse = status => {
      auditAccess({ status, request_id: randomUUID() })
      res.setHeader('connection', 'close')
      answer(res, status, { error: 'Revocation refused' })
    }
    if (req.url !== CLOUD_REVOCATION_PATH) { refuse(400); return }
    if (req.method !== 'POST') { refuse(405); return }
    if (req.headers.host !== origin.host) { refuse(403); return }
    if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      refuse(415)
      return
    }
    // The call is signed by Cloud, never by a person, a browser header or a gate session.
    if (req.headers.authorization !== undefined) { refuse(401); return }
    const signature = req.headers[SIGNATURE_HEADER]
    if (typeof signature !== 'string') { refuse(401); return }
    let body
    try { body = await readBody(req, MAX_REVOCATION_BODY, true) } catch { refuse(413); return }
    try { await cloud.revokeCall(body, signature) } catch { refuse(401); return }
    if (res.destroyed) return
    sessions.revokeAll(family => cloud.drops(family))
    res.writeHead(204, { 'cache-control': 'no-store' })
    res.end()
  }
  async function authorize(req, upgrade = false) {
    if (trustedRequest(req, origin, upgrade)) {
      const family = sessions.authenticate(cookieSecret(req.headers.cookie), origin.origin)
      if (family) return { family }
    }
    // Access exchanges happen only on HTTP; an upgrade must already hold a gate session.
    if (!access || upgrade) return undefined
    try {
      if (!trustedRequest(req, origin, upgrade, true)) throw new Error('Refused')
      // Invalid or replayed gate cookies never silently turn into a fresh Access session.
      if (req.headers.cookie?.split(';').some(part => part.trim().startsWith(`${COOKIE}=`))) throw new Error('Refused')
      if (!req.url.startsWith('/') || req.url.startsWith('//') || new URL(req.url, origin).searchParams.has('token')) throw new Error('Refused')
      const principal = await access.signIn(req.headers['cf-access-jwt-assertion'])
      const issued = sessions.issue(origin.origin, principal)
      return { family: issued.family, cookie: sessionCookie(issued.secret) }
    } catch {
      auditAccess({ status: 401, request_id: randomUUID() })
      return undefined
    }
  }
  // A Cloud workspace has several people: their session list and "sign out everywhere" are
  // their own. A self-hosted instance has one human, so it keeps every session in scope.
  const mine = family => cloud ? other => samePerson(other.principal, family.principal) : undefined
  const server = http.createServer(async (req, res) => {
    if (!hasSingleHost(req) || !validBodyFraming(req)) {
      res.writeHead(400, { connection: 'close', ...(multiuser ? { 'cache-control': 'no-store' } : {}) }).end()
      return
    }
    if (reservedPathAlias(req.url, origin)) { answer(res, 400, { error: 'Non-canonical gate path' }); return }
    if (privatePath(req.url, origin)) { answer(res, 400, { error: 'Private path' }); return }
    if (cloud && req.url === CLOUD_REVOCATION_PATH) { await cloudRevoke(req, res); return }
    if (cloud && req.url === CLOUD_RENEW_PATH) { await cloudRenew(req, res); return }
    if (cloud && req.url.split('?', 1)[0] === CLOUD_OPEN_FINISH_PATH) { await finishCloudOpen(req, res); return }
    if (cloud && req.url.split('?', 1)[0] === CLOUD_OPEN_PATH) { await cloudOpen(req, res); return }
    // The owner-only agent route uses a literal target. In multiuser mode also
    // refuse URLs DSH would match to that exact route before obtaining a credential.
    if (req.url === '/api/omni-mcp' || (multiuser && isMcpTarget(req.url))) {
      if (req.headers.host !== origin.host
        || (req.headers.origin !== undefined && req.headers.origin !== origin.origin)
        || req.headers['sec-fetch-site'] === 'cross-site') {
        auditAccess({ status: 403, request_id: randomUUID() })
        answer(res, 403, { error: 'Invalid MCP origin' })
        return
      }
      if (multiuser) { answer(res, 403, { error: 'Agent access is off in multiuser mode' }); return }
      try {
        const cookie = await credentials.cookie()
        const proxy = http.request({ hostname: DSH_HOST, port: credentials.port,
          method: req.method, path: '/api/omni-mcp',
          headers: agentMcpHeaders(req, credentials, cookie), timeout: 10000 }, upstream => {
          // Refresh for the next call after a DSH restart; never replay this body.
          if (upstream.statusCode === 401) credentials.cookie(true).catch(() => {})
          res.writeHead(upstream.statusCode, responseHeaders(upstream.headers))
          upstream.pipe(res)
          upstream.on('error', () => res.destroy())
        })
        proxy.on('timeout', () => proxy.destroy(new Error('MCP timeout')))
        proxy.on('error', () => {
          if (!res.headersSent) answer(res, 502, { error: 'MCP unavailable' })
          else res.destroy()
        })
        res.on('close', () => proxy.destroy())
        req.pipe(proxy)
      } catch { answer(res, 502, { error: 'MCP unavailable' }) }
      return
    }
    const authorization = await authorize(req)
    const family = authorization?.family
    const role = multiuser && family ? effectiveRole(family.principal.roles) : undefined
    if (multiuser && family && role === undefined) { answer(res, 403, { error: 'Not available' }); return }
    if (selfHosted && await selfHosted.handle(req, res, family, { bootstrap })) return
    if (!family) { sessionRequired(req, res); return }
    if (authorization.cookie) {
      res.setHeader('set-cookie', authorization.cookie)
      clearSite(res)
    }
    try {
      // No absolute-form URLs, launch-token exchanges or token-bearing browser URLs.
      if (!req.url.startsWith('/') || req.url.startsWith('//')) { answer(res, 400, { error: 'Invalid path' }); return }
      const url = new URL(req.url, origin)
      if (url.searchParams.has('token')) { answer(res, 401, { error: 'Session required' }); return }
      if (url.pathname.startsWith('/_gate/')) {
        if (url.pathname === '/_gate/sessions' && req.method === 'GET') {
          answer(res, 200, { sessions: sessions.list(mine(family)), current: family.id, local_trust_notice: LOCAL_TRUST_NOTICE })
        } else if (url.pathname === '/_gate/session/renew' && req.method === 'POST') {
          res.setHeader('set-cookie', sessionCookie(sessions.renew(family), sessions.maxAge(family)))
          answer(res, 200, {})
        } else if (url.pathname === '/_gate/sign-out-everywhere' && req.method === 'POST') {
          sessions.revokeAll(mine(family))
          res.setHeader('set-cookie', sessionCookie('', 0))
          clearSite(res)
          answer(res, 200, {})
        } else answer(res, 404, { error: 'Unknown gate route' })
        return
      }
      // The gate-held browser credential also admits DSH's /api and WebSocket owner peer.
      // /connect is a DSH bearer exchange, never a second browser sign-in path.
      if (exchangePath(url)) { answer(res, 401, { error: 'Session exchanges belong to the gate' }); return }
      if (multiuser && ['document', 'iframe', 'frame'].includes(req.headers['sec-fetch-dest']) &&
          explorePath(req.url.split('?', 1)[0], origin, path => MEDIA_PATH.test(path))) {
        answer(res, 403, { error: 'Not available' })
        return
      }
      const owner = ownerFamily(family, multiuser)
      if (!owner && !multiuser) { answer(res, 403, { error: 'Owner access required' }); return }
      if (!sessions.active(family)) { sessionRequired(req, res); return }
      let path = req.url, headers, cookie, probe, record
      if (owner) {
        if (multiuser) {
          record = trackRequest(req, res, family, true)
          if (!httpRequests.has(record)) return
        }
        cookie = await credentials.cookie()
        if (res.destroyed) return
        if (!sessions.active(family)) { sessionRequired(req, res); return }
        if (record && !httpRequests.has(record)) return
        headers = upstreamHeaders(req, credentials, cookie, family.principal)
        if (multiuser && req.method === 'POST' && req.url === '/api/omni-ui' &&
            sessions.active(family) && !cloud?.drops(family)) {
          ownerAssertionHeaders(req, headers, limit => caller.signOwner({
            principal: family.principal, familyId: family.id,
          }, limit))
        }
      } else {
        const decision = callerTarget({ role, method: req.method, raw: req.url, origin })
        if (!decision.allow) { answer(res, decision.status, { error: 'Not available' }); return }
        if (rebinding) { res.writeHead(503, { connection: 'close', 'cache-control': 'no-store' }).end(); return }
        if (!apiPath(url.pathname)) {
          if (!['GET', 'HEAD'].includes(req.method)) { answer(res, 405, { error: 'Method not allowed' }); return }
          if (!frontendPath(url)) { answer(res, 404, { error: 'Unknown frontend path' }); return }
        }
        const target = url.pathname + url.search
        record = trackRequest(req, res, family, false)
        if (!httpRequests.has(record)) return
        try { probe = await connectDsh({ port: credentials.port, host: DSH_HOST, signal: record.abort.signal }) }
        catch {
          // Nothing is signed: no adapter answered on this connection, or the session ended.
          if (!res.destroyed) {
            if (httpRequests.has(record)) answer(res, 503, { error: 'DSH unavailable' })
            else sessionRequired(req, res)
          }
          return
        }
        record.probe = probe
        if (!sessions.active(family) || res.destroyed || !httpRequests.has(record)) {
          probe.destroy()
          if (!res.destroyed) sessionRequired(req, res)
          return
        }
        let assertion
        try { assertion = caller.sign({ principal: family.principal, familyId: family.id, method: req.method, path: target }) }
        catch { probe.destroy(); answer(res, 403, { error: 'Caller refused' }); return }
        path = CALLER_PREFIX + target
        headers = callerHeaders(req, credentials, family.principal, assertion)
      }
      // A member's request goes on the probed connection: with `agent` undefined, Node uses
      // createConnection; `agent: false` would open a new connection.
      const options = { hostname: DSH_HOST, port: credentials.port, method: req.method, path, headers, timeout: 30_000 }
      if (probe) options.createConnection = reuseProbe(probe)
      const proxy = http.request(options, upstream => {
        if (record && (!httpRequests.has(record) || !sessions.active(family))) {
          upstream.destroy()
          endRequest(record)
          return
        }
        // A 401 drops the refused cookie. The next owner request checks its family before minting.
        // Never replay a body.
        if (owner && upstream.statusCode === 401) credentials.invalidate(cookie)
        const response = responseHeaders(upstream.headers)
        if (multiuser) {
          // Only a gate session transition can clear the browser's site data.
          delete response['clear-site-data']
          delete response['x-automagik-dsh-refresh']
          if (owner && upstream.statusCode === 401) response['x-automagik-dsh-refresh'] = '1'
          const asset = ['GET', 'HEAD'].includes(req.method) &&
            (url.pathname.startsWith('/assets/') || frontendPath(url) === 'bundle')
          if (!asset) response['cache-control'] = 'no-store'
        }
        res.writeHead(upstream.statusCode, response)
        if (record) upstream.pipe(activeStream(family, false, () => endRequest(record, true))).pipe(res)
        else upstream.pipe(res)
        upstream.on('error', () => res.destroy())
      })
      if (record) record.proxy = proxy
      proxy.on('timeout', () => proxy.destroy(new Error('DSH timeout')))
      // A member's probed connection that breaks before an answer (a DSH restart) is a 503.
      proxy.on('error', () => {
        if (res.destroyed) return
        if (!res.headersSent) answer(res, owner ? 502 : 503, { error: 'DSH unavailable' })
        else res.destroy()
      })
      if (!record) res.on('close', () => proxy.destroy())
      req.pipe(proxy)
    } catch {
      if (res.destroyed) return
      if (!res.headersSent) answer(res, 502, { error: 'DSH unavailable' })
      else res.destroy()
    }
  })
  // Inspect the complete header block, still bounded by Node's header byte limit.
  server.maxHeadersCount = 0
  server.on('connect', (req, socket) => refuseSocket(socket, !hasSingleHost(req) || !validBodyFraming(req) ||
    reservedPathAlias(req.url, origin) || privatePath(req.url, origin) ? 400 : 401))
  server.on('upgrade', async (req, socket, head) => {
    socket.on('error', () => {})
    // Node hands bytes after upgrade headers to the tunnel. Only a bodyless
    // upgrade can use this path without treating HTTP body bytes as tunnel data.
    if (!hasSingleHost(req) || req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length']) > 0) {
      refuseSocket(socket, 400)
      return
    }
    if (reservedPathAlias(req.url, origin) || privatePath(req.url, origin)) { refuseSocket(socket, 400); return }
    const authorization = await authorize(req, true)
    const family = authorization?.family
    if (!family) { refuseSocket(socket); return }
    try {
      if (multiuser && isMcpTarget(req.url)) { refuseSocket(socket, 403); return }
      if (!req.url.startsWith('/') || req.url.startsWith('//') || new URL(req.url, origin).searchParams.has('token') || req.headers.upgrade?.toLowerCase() !== 'websocket') { refuseSocket(socket); return }
      const owner = ownerFamily(family, multiuser)
      if (!owner && !(multiuser && callerTarget({ role: effectiveRole(family.principal.roles),
        method: req.method, raw: req.url, upgrade: true, origin }).allow)) { refuseSocket(socket, 403); return }
      if (!sessions.active(family)) { refuseSocket(socket, 401); return }
      if (exchangePath(new URL(req.url, origin))) { refuseSocket(socket, 401); return }
      if (!sessions.active(family)) { refuseSocket(socket, 401); return }
      if (!owner) {
        if (req.headers['sec-websocket-version'] !== '13') refuseSocket(socket, 400)
        else if (rebinding) refuseSocket(socket, 503)
        else await carryMember(req, socket, head, family)
        return
      }
      const record = { socket, family }
      sockets.set(socket, record)
      socket.on('error', () => record.proxy?.destroy())
      socket.on('close', () => { sockets.delete(socket); record.proxy?.destroy(); record.upstream?.destroy() })
      const cookie = await credentials.cookie()
      if (!sessions.active(family) || socket.destroyed) { refuseSocket(socket); return }
      const proxy = record.proxy = http.request({ hostname: DSH_HOST, port: credentials.port, method: 'GET', path: req.url, headers: upstreamHeaders(req, credentials, cookie, family.principal, true), timeout: 5000 })
      proxy.on('error', () => socket.destroy())
      proxy.on('timeout', () => proxy.destroy())
      proxy.on('response', response => {
        response.resume()
        // Drop the refused cookie and leave minting to a later request that passes its activity check.
        if (response.statusCode === 401) credentials.invalidate(cookie)
        refuseSocket(socket, response.statusCode === 401 ? 401 : 502)
      })
      relay(record, socket, head, proxy)
      proxy.end()
    } catch { refuseSocket(socket, 502) }
  })
  function activeStream(family, touch, close) {
    return new Transform({
      transform(chunk, _encoding, callback) {
        if (!(touch ? sessions.touch(family) : sessions.active(family))) {
          callback(new Error('Session expired'))
          return
        }
        callback(null, chunk)
      },
    }).on('error', close)
  }
  // The upstream handshake's answer, relayed and metered by session activity for owners and
  // members alike.
  function relay(record, socket, head, proxy) {
    const { family } = record
    proxy.on('upgrade', (response, upstream, upstreamHead) => {
      record.upstream = upstream
      if (!sessions.active(family) || socket.destroyed) { upstream.destroy(); socket.destroy(); return }
      proxy.setTimeout(0)
      const headers = { ...responseHeaders(response.headers), connection: 'Upgrade', upgrade: 'websocket' }
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`)
      if (head.length) upstream.write(head)
      if (upstreamHead.length) socket.write(upstreamHead)
      upstream.on('error', () => socket.destroy())
      upstream.on('close', () => socket.destroy())
      const close = () => { socket.destroy(); upstream.destroy() }
      const admitted = activeStream(family, true, close)
      const outgoing = activeStream(family, false, close)
      socket.on('close', () => { admitted.destroy(); outgoing.destroy() })
      socket.pipe(admitted).pipe(upstream).pipe(outgoing).pipe(socket)
    })
  }
  // A member's or guest's /api/remote.mux: signed as GET for the exact path and sent, with the
  // handshake fields and the assertion only, on the connection the adapter answered its probe on.
  async function carryMember(req, socket, head, family) {
    if (socket.destroyed) return
    const person = JSON.stringify([family.principal.issuer, family.principal.subject])
    const held = pendingUpgrades.get(person) ?? 0
    if (held >= MAX_PENDING_UPGRADES_PER_PERSON) return refuseSocket(socket, 429)
    if (pendingUpgradeCount >= MAX_PENDING_UPGRADES) return refuseSocket(socket, 503)
    pendingUpgrades.set(person, held + 1)
    pendingUpgradeCount++
    let released = false
    const release = () => {
      if (released) return
      released = true
      socket.off('close', release)
      pendingUpgradeCount--
      const left = pendingUpgrades.get(person) - 1
      if (left === 0) pendingUpgrades.delete(person)
      else pendingUpgrades.set(person, left)
    }
    // A refusal keeps its slot until close frees the buffered browser bytes.
    socket.once('close', release)
    const abort = new AbortController()
    const record = { socket, family, member: true, proxy: undefined, probe: undefined }
    sockets.set(socket, record)
    socket.on('close', () => { sockets.delete(socket); abort.abort(); record.probe?.destroy(); record.proxy?.destroy(); record.upstream?.destroy() })
    socket.on('error', () => record.proxy?.destroy())
    // Read until the probe settles so a browser FIN is visible even on an
    // upgrade's half-open socket. Keep any early tunnel bytes for relay.
    const early = []
    let earlyBytes = head.length
    const departed = () => { abort.abort(); socket.destroy() }
    const buffer = chunk => {
      earlyBytes += chunk.length
      if (earlyBytes > MAX_EARLY_UPGRADE_BYTES) departed()
      else early.push(chunk)
    }
    if (socket.readableEnded || earlyBytes > MAX_EARLY_UPGRADE_BYTES) { departed(); return }
    socket.once('end', departed)
    socket.on('data', buffer)
    socket.resume()
    let probe
    try { probe = await connectDsh({ port: credentials.port, host: DSH_HOST, signal: abort.signal }) }
    catch {
      if (!socket.destroyed) refuseSocket(socket, 503)
      return
    } finally {
      socket.pause()
      socket.off('data', buffer)
      socket.off('end', departed)
    }
    if (socket.readableEnded || socket.destroyed) { probe.destroy(); departed(); return }
    record.probe = probe
    for (let i = early.length - 1; i >= 0; i--) socket.unshift(early[i])
    if (!sessions.active(family) || socket.destroyed) {
      probe.destroy()
      refuseSocket(socket, 401)
      return
    }
    let assertion
    try { assertion = caller.sign({ principal: family.principal, familyId: family.id, method: 'GET', path: MEMBER_UPGRADE_PATH }) }
    catch {
      probe.destroy()
      refuseSocket(socket, 403)
      return
    }
    const proxy = http.request({ hostname: DSH_HOST, port: credentials.port, method: 'GET', path: CALLER_PREFIX + MEMBER_UPGRADE_PATH,
      headers: callerUpgradeHeaders(req, credentials, family.principal, assertion), createConnection: reuseProbe(probe), timeout: 5000 })
    record.proxy = proxy
    proxy.on('error', () => { if (record.upstream) socket.destroy(); else refuseSocket(socket, 503) })
    proxy.on('timeout', () => proxy.destroy())
    // The carrier's refusal passes through; the owner credential is never touched here.
    proxy.on('response', response => {
      response.resume()
      refuseSocket(socket, memberStatus(response.statusCode))
    })
    proxy.once('upgrade', release)
    relay(record, socket, head, proxy)
    proxy.end()
  }
  const revoke = id => retireTransports(id)
  sessions.on('revoke', revoke)
  const timer = setInterval(() => {
    for (const record of sockets.values()) if (!sessions.active(record.family)) record.socket.destroy()
    for (const record of httpRequests) if (!sessions.active(record.family)) endRequest(record)
  }, 1000).unref()
  // Section 6's poll fallback: at least every 5 minutes while the gate holds sessions, and
  // while a removal is still pending (it may have ended the last session, and only a later
  // list can lift it). A failed poll changes nothing, and the next tick tries again.
  let pollTimer
  if (cloud) {
    pollTimer = setInterval(() => {
      if (!sessions.families.length && !cloud.hasPendingRemoval()) return
      cloud.poll().then(() => sessions.revokeAll(family => cloud.drops(family))).catch(() => {})
    }, cloud.pollInterval)
    pollTimer.unref()
  }
  let rebinding = false, closing = false
  server.on('close', () => {
    if (!rebinding || closing) {
      pendingOpens.clear()
      clearInterval(timer); clearInterval(pollTimer); sessions.off('revoke', revoke)
    }
  })
  let binding = Promise.resolve()
  server.rebind = (port, target, drop = false) => {
    if (drop) {
      for (const record of sockets.values()) record.socket.destroy()
      for (const record of httpRequests) endRequest(record, true)
      server.closeAllConnections()
    }
    const task = binding.then(async () => {
      if (closing) return
      const host = typeof target === 'function' ? target() : target
      const address = server.address()
      if (address?.address === host && (port === 0 || address.port === port)) return
      rebinding = true
      try {
        await new Promise((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve())
          // Stop accepting first, then drop member connections and any other connections
          // covered by drop that were accepted while this rebind was queued.
          for (const record of sockets.values()) if (drop || record.member) record.socket.destroy()
          for (const record of httpRequests) if (drop || !record.owner) endRequest(record, true)
          if (drop) server.closeAllConnections()
        })
        if (!closing) await new Promise((resolve, reject) => {
          const failed = error => reject(error)
          server.once('error', failed)
          server.listen(port, host, () => { server.off('error', failed); resolve() })
        })
      } finally {
        rebinding = false
      }
    })
    binding = task.catch(() => {})
    return task
  }
  server.closeGate = () => {
    closing = true
    for (const record of sockets.values()) record.socket.destroy()
    for (const record of httpRequests) endRequest(record, true)
    server.closeAllConnections()
    return new Promise(resolve => server.close(resolve))
  }
  return server
}
