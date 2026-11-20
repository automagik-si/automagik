import assert from 'node:assert/strict'
import crypto, { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter, once } from 'node:events'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { COOKIE, cookieSecret, createOwner, IDLE_MS, principalOf, readOwner, SessionStore, sessionCookie } from '../gate-store.mjs'
import { createSigner } from '../gate-caller.mjs'
import { verifyAssertion } from '../../apps/multiuser-dsh/src/assertion.js'
import { CLOUD_RENEW_PATH, createGate, pinOrigin } from '../gate.mjs'
import { probeDsh } from '../gate-mux.mjs'
import { DSH_HOST, DshCredentials } from '../gate-upstream.mjs'

// Reserved placeholder; no private deployment address, issuer or account belongs in tests.
const ORIGIN = 'https://workspace.invalid:8443'
const HOST = new URL(ORIGIN).host
const source = file => readFileSync(new URL(file, import.meta.url), 'utf8')
function store(t, options) {
  const dir = mkdtempSync(join(tmpdir(), 'automagik-gate-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, sessions: new SessionStore(dir, options) }
}
async function listen(server) {
  server.listen(0, DSH_HOST)
  await once(server, 'listening')
  return server.address().port
}
function request(port, path = '/', { method = 'GET', headers = {}, body, upgrade = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: DSH_HOST, port, path, method, headers: Object.fromEntries(Object.entries({ host: HOST, ...headers }).filter(([, v]) => v !== undefined)) }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }))
    })
    req.on('error', reject)
    req.on('connect', (response, socket) => { socket.destroy(); resolve({ status: response.statusCode, headers: response.headers }) })
    if (upgrade) req.on('upgrade', (response, socket, head) => resolve({ status: response.statusCode, headers: response.headers, socket, head }))
    req.setTimeout(5000, () => req.destroy(new Error('Test request timed out')))
    req.end(body)
  })
}
async function rawRequest(port, line, headers, body = '') {
  const socket = net.connect({ host: DSH_HOST, port })
  socket.setTimeout(5000, () => socket.destroy(new Error('Raw test request timed out')))
  const response = []
  socket.on('data', chunk => response.push(chunk))
  socket.write([line, ...headers, '', body].join('\r\n'))
  await once(socket, 'close')
  return Number(/^HTTP\/1\.1 (\d+)\b/.exec(Buffer.concat(response).toString())?.[1])
}
const websocketHeaders = { origin: ORIGIN, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': randomBytes(16).toString('base64'), 'sec-websocket-version': '13' }

async function fixture(t, { handleRequest, handleUpgrade } = {}) {
  let now = 1000
  const state = store(t, { now: () => now })
  const owner = createOwner(state.dir)
  const principal = principalOf(owner)
  const issued = state.sessions.issue(ORIGIN, principal)
  const seen = []
  let generation = 1
  let exchanges = 0
  const launchFile = join(state.dir, 'launch')
  const launch = () => writeFileSync(launchFile, `http://ignored.invalid/?${new URLSearchParams({ token: String(generation) })}`)
  launch()
  const upstream = http.createServer((req, res) => {
    const url = new URL(req.url, ORIGIN)
    if (url.searchParams.get('token') === String(generation)) {
      exchanges++
      res.writeHead(303, { location: './', 'set-cookie': `dsh-credential=${generation}; HttpOnly; Path=/` }).end()
      return
    }
    seen.push({ url: req.url, headers: req.headers, method: req.method })
    if (req.headers.cookie !== `dsh-credential=${generation}`) { res.writeHead(401).end(); return }
    if (handleRequest?.(req, res)) return
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => res.writeHead(200, { 'set-cookie': 'dsh-hidden=secret', 'content-type': 'text/plain' }).end(body || 'DSH'))
  })
  upstream.on('upgrade', (req, socket, head) => {
    const entry = { url: req.url, headers: req.headers, upgrade: true, chunks: [], closed: once(socket, 'close') }
    seen.push(entry)
    socket.on('error', () => {})
    socket.on('end', () => socket.end())
    if (req.headers.cookie !== `dsh-credential=${generation}`) { socket.end('HTTP/1.1 401 Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return }
    if (handleUpgrade?.(req, socket, head)) return
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSet-Cookie: dsh-hidden=secret\r\n\r\n')
    socket.on('data', data => { entry.chunks.push(data.toString()); socket.write(data) })
  })
  const port = await listen(upstream)
  const credentials = new DshCredentials({ launchFile, port })
  const gate = createGate({ origin: ORIGIN, sessions: state.sessions, credentials })
  const gatePort = await listen(gate)
  t.after(async () => { await gate.closeGate(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)) })
  return { ...state, owner, principal, issued, credentials, gate, gatePort, seen, headers: { cookie: `${COOKIE}=${issued.secret}`, origin: ORIGIN }, advance: ms => { now += ms }, restart: () => { generation++; launch() }, exchanges: () => exchanges }
}

test('all paths and methods and upgrades refuse without a session before any DSH connection', async t => {
  const f = await fixture(t)
  const routes = ['/', '/index.html', '/assets/client.js', '/connect', '/api', '/api/remote.mux', '/unknown', '/_gate/sessions', '/_gate/session/renew', '/_gate/sign-out-everywhere', '//other.invalid/path', '/?token=placeholder']
  for (const path of routes) {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'TRACE', 'CONNECT']) {
      assert.equal((await request(f.gatePort, path, { method })).status, 401, `${method} ${path}`)
    }
    assert.equal((await request(f.gatePort, path, { headers: websocketHeaders, upgrade: true })).status, 401, `WS ${path}`)
  }
  assert.equal(f.exchanges(), 0)
  assert.equal(f.seen.length, 0)
  const fake = sessionCookie(randomBytes(32).toString('base64url')).split(';')[0]
  assert.equal((await request(f.gatePort, '/', { headers: { cookie: fake } })).status, 401)
})

test('exact origin, port, Host and CSRF checks cannot be overridden with forwarding headers', async t => {
  const f = await fixture(t)
  for (const headers of [
    { origin: 'https://other.invalid:8443' }, { origin: 'https://workspace.invalid:8444' },
    { origin: 'http://workspace.invalid:8443' }, { origin: 'null' },
    { host: 'workspace.invalid:8444' }, { host: 'other.invalid:8443' },
    { 'sec-fetch-site': 'cross-site' },
    { origin: 'https://other.invalid', 'x-forwarded-host': HOST, 'x-forwarded-proto': 'https', forwarded: `host=${HOST};proto=https` },
  ]) {
    assert.equal((await request(f.gatePort, '/', { headers: { ...f.headers, ...headers } })).status, 401)
    assert.equal((await request(f.gatePort, '/api/remote.mux', { headers: { ...websocketHeaders, ...f.headers, ...headers }, upgrade: true })).status, 401)
  }
  assert.equal((await request(f.gatePort, '/_gate/sign-out-everywhere', { method: 'POST', headers: { cookie: f.headers.cookie } })).status, 401)
  assert.equal((await request(f.gatePort, '/api/remote.mux', { headers: { ...websocketHeaders, ...f.headers, origin: undefined }, upgrade: true })).status, 401)
  assert.equal(f.exchanges(), 0)
  assert.equal(f.sessions.list().length, 1)
})

test('DSH sees only gate credentials and the generated principal; browser never receives DSH cookies', async t => {
  const f = await fixture(t)
  const response = await request(f.gatePort, '/api/example?q=1', { method: 'POST', body: 'payload', headers: { ...f.headers, 'content-type': 'text/plain', authorization: 'Bearer placeholder', 'x-automagik-principal': 'forged', 'x-forwarded-host': 'other.invalid', connection: 'x-automagik-principal' } })
  assert.equal(response.status, 200)
  assert.equal(response.body, 'payload')
  assert.equal(response.headers['set-cookie'], undefined)
  const upstream = f.seen.at(-1)
  assert.equal(upstream.url, '/api/example?q=1')
  assert.equal(upstream.headers.authorization, undefined)
  assert.equal(upstream.headers['x-forwarded-host'], undefined)
  assert.equal(upstream.headers.cookie, 'dsh-credential=1')
  assert.equal(upstream.headers.host, f.credentials.authority)
  assert.deepEqual(JSON.parse(Buffer.from(upstream.headers['x-automagik-principal'], 'base64url')), f.principal)
  assert.equal(f.exchanges(), 1)
  const navigation = await request(f.gatePort, '/', { headers: { cookie: f.headers.cookie } })
  assert.equal(navigation.status, 200, 'same-origin top-level GET may omit Origin')
  for (const path of ['/?token=placeholder', '/connect?token=placeholder', '/connect']) {
    assert.equal((await request(f.gatePort, path, { headers: f.headers })).status, 401)
  }
})

test('renewal rotates and reuse revokes the family, while a second family stays signed in', async t => {
  const f = await fixture(t)
  const second = f.sessions.issue(ORIGIN, f.principal)
  const response = await request(f.gatePort, '/_gate/session/renew', { method: 'POST', headers: f.headers })
  assert.equal(response.status, 200)
  const setCookie = response.headers['set-cookie'][0]
  for (const flag of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=43200']) assert.ok(setCookie.includes(flag))
  assert.ok(setCookie.startsWith('__Host-'))
  assert.ok(!/Domain=/i.test(setCookie))
  const fresh = setCookie.split(';')[0]
  assert.notEqual(fresh, f.headers.cookie)
  assert.equal((await request(f.gatePort, '/_gate/sessions', { headers: { ...f.headers, cookie: fresh } })).status, 200)
  assert.equal((await request(f.gatePort, '/', { headers: f.headers })).status, 401)
  assert.equal((await request(f.gatePort, '/', { headers: { ...f.headers, cookie: fresh } })).status, 401)
  assert.equal((await request(f.gatePort, '/', { headers: { ...f.headers, cookie: `${COOKIE}=${second.secret}` } })).status, 200)
})

test('session list omits secrets, reports local trust, and sign out everywhere clears all families', async t => {
  const f = await fixture(t)
  f.sessions.issue(ORIGIN, f.principal)
  const response = await request(f.gatePort, '/_gate/sessions', { headers: f.headers })
  const list = JSON.parse(response.body)
  assert.equal(list.sessions.length, 2)
  assert.equal(list.current, f.issued.family.id)
  assert.match(list.local_trust_notice, /replay.*Origin/)
  assert.ok(!response.body.includes(f.issued.secret))
  const logout = await request(f.gatePort, '/_gate/sign-out-everywhere', { method: 'POST', headers: f.headers })
  assert.equal(logout.status, 200)
  assert.match(logout.headers['set-cookie'][0], /Max-Age=0/)
  assert.equal((await request(f.gatePort, '/', { headers: f.headers })).status, 401)
  assert.equal(new SessionStore(f.dir).list().length, 0)
})

test('sessions slide for 12-hour idle, survive restart as hashes, and stay origin-bound', t => {
  let now = 0
  const f = store(t, { now: () => now })
  const owner = createOwner(f.dir)
  const issued = f.sessions.issue(ORIGIN, principalOf(owner))
  const saved = readFileSync(join(f.dir, 'sessions.json'), 'utf8')
  assert.ok(!saved.includes(issued.secret))
  assert.equal(statSync(join(f.dir, 'sessions.json')).mode & 0o777, 0o600)
  const restarted = new SessionStore(f.dir, { now: () => now })
  assert.equal(restarted.authenticate(issued.secret, 'https://other.invalid'), undefined)
  now += IDLE_MS - 1
  assert.ok(restarted.authenticate(issued.secret, ORIGIN))
  now += IDLE_MS - 1
  const family = restarted.authenticate(issued.secret, ORIGIN)
  assert.ok(family)
  const rotated = restarted.renew(family)
  const again = new SessionStore(f.dir, { now: () => now })
  assert.ok(again.authenticate(rotated, ORIGIN))
  assert.equal(again.authenticate(issued.secret, ORIGIN), undefined)
  assert.equal(again.authenticate(rotated, ORIGIN), undefined)
  const idle = again.issue(ORIGIN, principalOf(owner))
  now += IDLE_MS
  assert.equal(again.authenticate(idle.secret, ORIGIN), undefined)
})

test('random owner ids persist; unknown, corrupt or linked records never reopen a claim', t => {
  const a = store(t), b = store(t)
  assert.equal(readOwner(a.dir), undefined)
  const first = createOwner(a.dir), second = createOwner(b.dir)
  assert.notEqual(first.instance_id, second.instance_id)
  assert.notEqual(first.local_id, second.local_id)
  assert.deepEqual(readOwner(a.dir), first)
  assert.equal(statSync(join(a.dir, 'owner.json')).mode & 0o777, 0o600)
  assert.deepEqual(principalOf(first), { issuer: `local:${first.instance_id}`, subject: first.local_id, roles: ['owner'], workspace: first.instance_id })
  for (const record of [{ ...first, version: 2 }, { ...first, linked: {} }, { version: 1 }, '{bad json']) {
    const bytes = typeof record === 'string' ? record : JSON.stringify(record)
    writeFileSync(join(a.dir, 'owner.json'), bytes)
    assert.throws(() => readOwner(a.dir))
    assert.throws(() => createOwner(a.dir), { code: 'EEXIST' })
    assert.equal(readFileSync(join(a.dir, 'owner.json'), 'utf8'), bytes)
  }
})

test('a DSH restart re-reads the launch credential; failed POST is never replayed', async t => {
  const f = await fixture(t)
  assert.equal((await request(f.gatePort, '/', { headers: f.headers })).status, 200)
  f.restart()
  assert.equal((await request(f.gatePort, '/api/mutate', { method: 'POST', body: 'once', headers: f.headers })).status, 401)
  assert.equal((await request(f.gatePort, '/', { headers: f.headers })).status, 200)
  assert.equal(f.exchanges(), 2)
  assert.equal(f.seen.filter(r => r.method === 'POST').length, 1)
})

test('authenticated upgrades carry the principal and close on logout, replay and idle expiry', async t => {
  for (const reason of ['logout', 'replay', 'idle']) await t.test(reason, async t => {
    const f = await fixture(t)
    const response = await request(f.gatePort, '/api/remote.mux', { headers: { ...websocketHeaders, ...f.headers }, upgrade: true })
    assert.equal(response.status, 101)
    assert.equal(response.headers['set-cookie'], undefined)
    const socket = response.socket
    t.after(() => socket.destroy())
    const seen = f.seen.at(-1)
    assert.equal(seen.headers.cookie, 'dsh-credential=1')
    assert.deepEqual(JSON.parse(Buffer.from(seen.headers['x-automagik-principal'], 'base64url')), f.principal)
    const data = once(socket, 'data')
    socket.write('echo')
    assert.equal((await data)[0].toString(), 'echo')
    const closed = once(socket, 'close')
    socket.resume()
    if (reason === 'logout') f.sessions.revokeAll()
    if (reason === 'replay') { f.sessions.renew(f.issued.family); f.sessions.authenticate(f.issued.secret, ORIGIN) }
    if (reason === 'idle') { f.advance(IDLE_MS); socket.write('must-not-reach-dsh') }
    await closed
    await seen.closed
    assert.deepEqual(seen.chunks, ['echo'], 'no post-expiry frame reaches DSH')
  })
})

test('cookies reject duplicates and malformed values; configured origins are exact', () => {
  const value = randomBytes(32).toString('base64url')
  assert.equal(cookieSecret(`${COOKIE}=${value}`), value)
  assert.equal(cookieSecret(`${COOKIE}=${value}; ${COOKIE}=${value}`), undefined)
  assert.equal(cookieSecret(`${COOKIE}=bad`), undefined)
  assert.match(sessionCookie(value), /; Secure;/)
  for (const invalid of ['http://workspace.invalid', `${ORIGIN}/`, `${ORIGIN}/path`, `${ORIGIN}?x=1`, 'file:///tmp/gate']) assert.throws(() => pinOrigin(invalid))
  assert.equal(pinOrigin(ORIGIN).origin, ORIGIN)
  assert.equal(pinOrigin('http://localhost:3082').origin, 'http://localhost:3082')
})

test('the shipped gate stays disabled without explicit configuration', () => {
  assert.throws(() => execFileSync(process.execPath, ['server/gate-entrypoint.mjs'], { env: { PATH: process.env.PATH }, stdio: 'pipe' }), error => {
    assert.equal(error.status, 1)
    assert.match(error.stderr.toString(), /disabled or invalid/)
    return true
  })
})

// Real pinned DSH BrowserAuth, extracted without the unrelated plugin imports. This proves
// that its version-1 browser credential is also the owner credential admitted by /api.
test('gate exchange works against the pinned DSH authenticator, including restart recovery', async t => {
  const text = source('../../apps/desktop/test/fixtures/client-connection-cookie-lax/index.js')
  const manifest = JSON.parse(source('../../apps/desktop/runtime/patches/patches.json'))
  const pin = manifest.find(p => p.patch === 'client-connection-cookie-lax.patch')
  assert.equal(createHash('sha256').update(text).digest('hex'), pin.files[0].before)
  const start = text.indexOf('const AUTH_RECORD_KEY =')
  const end = text.indexOf('//#endregion', start)
  const { BrowserAuth } = runInNewContext(`${text.slice(start, end)}\n({ BrowserAuth })`, {
    Buffer, URL, Headers, Date, createHash, randomBytes,
    timingSafeEqual, createHmac,
    credentialKey: (a, b) => `${a}:${b}`,
  })
  let auth = new BrowserAuth({}, randomBytes(32), 30)
  const f = store(t)
  const launchFile = join(f.dir, 'launch')
  const server = http.createServer((req, res) => {
    if (auth.authorizeIndex(req, res)) res.end('owner')
  })
  const port = await listen(server)
  t.after(() => new Promise(resolve => server.close(resolve)))
  const credentials = new DshCredentials({ launchFile, port })
  writeFileSync(launchFile, auth.authenticatedUrl(`http://ignored.invalid/`))
  const cookie = await credentials.cookie()
  assert.equal(auth.isAuthenticated({ headers: { host: credentials.authority, cookie } }), true)
  auth = new BrowserAuth({}, randomBytes(32), 30)
  assert.equal(auth.isAuthenticated({ headers: { host: credentials.authority, cookie } }), false)
  writeFileSync(launchFile, auth.authenticatedUrl('http://ignored.invalid/'))
  const fresh = await credentials.cookie(true)
  assert.notEqual(fresh, cookie)
  assert.equal(auth.isAuthenticated({ headers: { host: credentials.authority, cookie: fresh } }), true)
})

test('malformed and newer session stores fail startup, never become empty valid stores', t => {
  const f = store(t)
  for (const record of [null, {}, { version: 2, families: [] }, { version: 1, families: [{}] }]) {
    const bytes = JSON.stringify(record)
    writeFileSync(join(f.dir, 'sessions.json'), bytes)
    assert.throws(() => new SessionStore(f.dir))
    assert.equal(readFileSync(join(f.dir, 'sessions.json'), 'utf8'), bytes)
  }
  assert.throws(() => f.sessions.issue(ORIGIN, { issuer: 'local:placeholder', subject: 'placeholder', roles: ['admin'], workspace: 'placeholder' }))
})

// Mutant REFUSE_FIN_ONLY restores end(response) without descriptor destruction or deadline.
test('refused half-open WebSocket and CONNECT clients release server descriptors', async t => {
  const f = await fixture(t)
  const clients = []
  try {
    for (const kind of ['upgrade', 'connect']) {
      const probes = Array.from({ length: 5 }, async () => {
        const socket = net.connect({ host: DSH_HOST, port: f.gatePort, allowHalfOpen: true })
        clients.push(socket)
        socket.on('error', () => {})
        await once(socket, 'connect')
        let response = ''
        socket.setEncoding('utf8')
        socket.on('data', chunk => { response += chunk })
        const ended = once(socket, 'end')
        socket.write(kind === 'upgrade'
          ? `GET /api/remote.mux HTTP/1.1\r\nHost: ${HOST}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`
          : `CONNECT ${HOST} HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`)
        await ended
        assert.match(response, /^HTTP\/1\.1 401 Refused/)
        assert.equal(socket.writableEnded, false, 'the client deliberately keeps its writable half open')
      })
      await Promise.all(probes)
    }
    const deadline = Date.now() + 1500
    let connections
    do {
      connections = await new Promise((resolve, reject) => f.gate.getConnections((error, count) => error ? reject(error) : resolve(count)))
      if (connections === 0) break
      await new Promise(resolve => setTimeout(resolve, 10))
    } while (Date.now() < deadline)
    assert.equal(connections, 0, 'refused half-open sockets must release all gate descriptors')
    assert.equal(f.exchanges(), 0)
  } finally {
    for (const client of clients) client.destroy()
  }
})

function observeConstantTime(t) {
  const comparisons = []
  const real = crypto.timingSafeEqual
  t.mock.method(crypto, 'timingSafeEqual', (left, right) => {
    assert.ok(Buffer.isBuffer(left) && Buffer.isBuffer(right))
    assert.equal(left.length, 32)
    assert.equal(right.length, 32)
    comparisons.push(left.toString('hex'))
    return real(left, right)
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  return comparisons
}

// Mutant CURRENT_HASH_STRING_EQUALITY replaces only the current timingSafeEqual call.
test('current session hashes use fixed-length timingSafeEqual', t => {
  const comparisons = observeConstantTime(t)
  const f = store(t)
  const issued = f.sessions.issue(ORIGIN, principalOf(createOwner(f.dir)))
  assert.equal(f.sessions.authenticate(issued.secret, ORIGIN), issued.family)
  assert.deepEqual(comparisons, [issued.family.current], 'current hash must use timingSafeEqual')
})

// Mutant ROTATED_HASH_STRING_EQUALITY replaces historical comparisons with string matching.
test('every rotated hash uses timingSafeEqual even when the current hash matched', t => {
  const comparisons = observeConstantTime(t)
  const f = store(t)
  const issued = f.sessions.issue(ORIGIN, principalOf(createOwner(f.dir)))
  f.sessions.renew(issued.family)
  const latest = f.sessions.renew(issued.family)
  const expected = [issued.family.current, ...issued.family.used]
  assert.equal(f.sessions.authenticate(latest, ORIGIN), issued.family)
  assert.deepEqual(comparisons, expected, 'current match must still compare all rotated hashes with timingSafeEqual')
  comparisons.length = 0
  assert.equal(f.sessions.authenticate(issued.secret, ORIGIN), undefined)
  assert.deepEqual(comparisons, expected, 'replay must compare every rotated hash with timingSafeEqual')
  assert.equal(f.sessions.list().length, 0)
})

// The adapter's readiness answer; `seen` and `wire` exclude the probe, so hop counts are the
// requests the gate forwarded.
const PROBE_LINE = 'GET /_automagik/caller/_ready HTTP/1.1'
async function callerFixture(t, { multiuser = true, selfHosted, carrierStatus = 200, captureWire = false, upgradeStatus = 101,
  probe = res => res.writeHead(204, { 'x-automagik-ready': '1' }).end(), connectDsh, handleRequest, handleUpgrade, now } = {}) {
  const { dir, sessions } = store(t, { memory: true, accepts: () => true, now })
  const seen = [], cookieCalls = [], signs = [], wire = []
  const workspace = 'caller-workspace'
  const issue = (role, options) => {
    const principal = { issuer: 'https://identity.invalid', subject: role, roles: [role], workspace }
    const issued = sessions.issue(ORIGIN, principal, options)
    return { ...issued, principal, headers: { cookie: `${COOKIE}=${issued.secret}`, origin: ORIGIN } }
  }
  const probes = []
  const upstream = http.createServer((req, res) => {
    const { method, url, rawHeaders, headers } = req
    if (method === 'GET' && url === '/_automagik/caller/_ready') {
      probes.push({ remotePort: req.socket.remotePort })
      probe(res, req)
      return
    }
    const hop = { method, url, rawHeaders, headers }
    // The connection's remote port, kept out of deep comparisons of hops.
    Object.defineProperty(hop, 'remotePort', { value: req.socket.remotePort })
    seen.push(hop)
    if (handleRequest?.(req, res)) return
    const chunks = []
    if (captureWire) req.on('data', chunk => chunks.push(chunk))
    else req.resume()
    req.on('end', () => {
      if (captureWire) hop.body = Buffer.concat(chunks).toString()
      res.writeHead(url.startsWith('/_automagik/caller') ? carrierStatus : 200).end()
    })
  })
  if (captureWire) upstream.on('connection', socket => socket.on('data', chunk => { if (!chunk.toString('latin1').startsWith(PROBE_LINE)) wire.push(chunk) }))
  const upgraded = new Set()
  upstream.on('upgrade', (req, socket, head) => {
    upgraded.add(socket)
    socket.once('close', () => upgraded.delete(socket))
    const { method, url, headers, rawHeaders } = req
    const hop = { method, url, headers }
    Object.defineProperties(hop, { rawHeaders: { value: rawHeaders }, remotePort: { value: socket.remotePort } })
    seen.push(hop)
    socket.on('error', () => {})
    if (handleUpgrade?.(req, socket, head)) return
    if (upgradeStatus !== 101) { socket.end(`HTTP/1.1 ${upgradeStatus} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return }
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
  })
  const port = await listen(upstream)
  const credentials = { port, authority: `${DSH_HOST}:${port}`, async cookie(refresh) {
    cookieCalls.push(refresh)
    return 'dsh=cached'
  } }
  const signer = createSigner({ dir, publicDir: dir, instance: () => workspace })
  const caller = { sign(value) { signs.push(value); return signer.sign(value) } }
  const gates = []
  const makeGate = async (enabled, hosted = selfHosted, options = {}) => {
    const gate = createGate({ origin: ORIGIN, sessions, credentials, multiuser: enabled, caller, selfHosted: hosted, connectDsh, ...options })
    const gatePort = await listen(gate)
    gates.push(gate)
    t.after(() => gate.closeGate())
    return gatePort
  }
  const gatePort = await makeGate(multiuser)
  const stopUpstream = () => {
    for (const socket of upgraded) socket.destroy()
    upstream.closeAllConnections()
    return new Promise(resolve => upstream.close(resolve))
  }
  t.after(stopUpstream)
  return { dir, sessions, issue, seen, signs, cookieCalls, gatePort, makeGate, stopUpstream, wire, probes, upstream, port,
    credentials, signer, workspace, gate: gates[0], gates }
}

test('the gate sends exactly one framed DELETE or POST with the original body on every HTTP proxy path', async t => {
  const f = await callerFixture(t, { captureWire: true })
  const off = await f.makeGate(false)
  const member = f.issue('member')
  const owner = f.issue('owner')
  const body = 'alpha\r\nbeta'
  for (const [port, path, target, headers] of [
    [f.gatePort, '/api/example', '/_automagik/caller/api/example', member.headers],
    [f.gatePort, '/api/example', '/api/example', owner.headers],
    [off, '/api/example', '/api/example', owner.headers],
    [off, '/api/omni-mcp', '/api/omni-mcp', { origin: ORIGIN, authorization: 'Bearer fixture' }],
  ]) {
    const base = [`Host: ${HOST}`, 'Connection: close', ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`)]
    for (const [method, framed, upload] of [
      ['DELETE', 'Transfer-Encoding: chunked', '5\r\nalpha\r\n6\r\n\r\nbeta\r\n0\r\n\r\n'],
      ['POST', 'Transfer-Encoding: Chunked', '5\r\nalpha\r\n6\r\n\r\nbeta\r\n0\r\n\r\n'],
      ['DELETE', `Content-Length: ${Buffer.byteLength(body)}`, body],
    ]) {
      const count = f.seen.length
      const offset = f.wire.length
      assert.equal(await rawRequest(port, `${method} ${path} HTTP/1.1`, [...base, framed], upload), 200)
      assert.equal(f.seen.length, count + 1)
      const hop = f.seen.at(-1)
      assert.deepEqual([hop.method, hop.url, hop.body], [method, target, body])
      const isChunked = framed.startsWith('Transfer-Encoding')
      assert.equal(hop.headers['transfer-encoding'], isChunked ? 'chunked' : undefined)
      assert.equal(hop.headers['content-length'], isChunked ? undefined : String(Buffer.byteLength(body)))
      const raw = Buffer.concat(f.wire.slice(offset)).toString()
      assert.equal(raw.split('\r\n', 1)[0], `${method} ${target} HTTP/1.1`)
      assert.equal(raw.match(/ HTTP\/1\.1\r\n/g)?.length, 1)
      assert.ok(raw.endsWith(isChunked ? '\r\n0\r\n\r\n' : body))
    }
  }
})

test('ambiguous or unsupported upload framing is refused before signing or acquiring credentials', async t => {
  const f = await callerFixture(t)
  const off = await f.makeGate(false)
  const member = f.issue('member')
  const owner = f.issue('owner')
  for (const [port, path, cookie] of [
    [f.gatePort, '/api/example', member.headers.cookie],
    [f.gatePort, '/api/example', owner.headers.cookie],
    [off, '/api/omni-mcp', owner.headers.cookie],
  ]) {
    const base = [`Host: ${HOST}`, `Origin: ${ORIGIN}`, `Cookie: ${cookie}`, 'Connection: close']
    for (const framing of [['Transfer-Encoding: chunked', 'Content-Length: 5'], ['Transfer-Encoding: gzip, chunked']]) {
      assert.equal(await rawRequest(port, `POST ${path} HTTP/1.1`, [...base, ...framing], '0\r\n\r\n'), 400)
    }
  }
  assert.deepEqual(f.seen, [])
  assert.deepEqual(f.signs, [])
  assert.deepEqual(f.cookieCalls, [])
})

test('public HTTP, upgrade and MCP reject duplicate Host headers with the same or different values', async t => {
  const f = await callerFixture(t)
  const off = await f.makeGate(false)
  const owner = f.issue('owner')
  const auth = t.mock.method(f.sessions, 'authenticate')
  const base = [`Origin: ${ORIGIN}`, `Cookie: ${owner.headers.cookie}`]
  for (const [line, headers, port] of [
    ['GET / HTTP/1.1', ['Connection: close'], f.gatePort],
    ['GET /api/remote.mux HTTP/1.1', ['Connection: Upgrade', 'Upgrade: websocket'], f.gatePort],
    ['POST /api/omni-mcp HTTP/1.1', ['Connection: close', 'Content-Length: 0'], off],
  ]) {
    for (const hosts of [[], [`Host: ${HOST}`, `hOsT: ${HOST}`], [`Host: ${HOST}`, 'hOsT: other.invalid']]) {
      assert.equal(await rawRequest(port, line, [...base, ...headers, ...hosts]), 400, line)
    }
  }
  assert.equal(await rawRequest(f.gatePort, 'GET / HTTP/1.1',
    [...base, 'Connection: close', `Host: ${HOST}`, ...Array(1050).fill('x: v'), 'Host: other.invalid']), 400)
  assert.equal(auth.mock.callCount(), 0)
  assert.deepEqual(f.seen, [])
  assert.deepEqual(f.signs, [])
  assert.deepEqual(f.cookieCalls, [])
})

test('the member carrier rewrite binds the exact method and query and drops browser credentials and assertions', async t => {
  const f = await callerFixture(t)
  const member = f.issue('member')
  const path = '/api/x?b=2&a=%20&a=1'
  const response = await request(f.gatePort, path, { method: 'POST', body: 'body', headers: {
    ...member.headers, cookie: member.headers.cookie + '; dsh=spoofed', authorization: 'Bearer browser',
    'x-automagik-caller': 'spoofed', 'x-automagik-principal': 'spoofed',
    connection: 'keep-alive, x-automagik-caller', 'sec-websocket-key': 'spoofed',
  } })
  assert.equal(response.status, 200)
  const [hop] = f.seen
  assert.equal(hop.url, '/_automagik/caller' + path)
  assert.equal(hop.headers.cookie, undefined)
  assert.equal(hop.headers.authorization, undefined)
  assert.equal(hop.headers['sec-websocket-key'], undefined)
  assert.equal(hop.rawHeaders.filter((value, i) => i % 2 === 0 && value.toLowerCase() === 'x-automagik-caller').length, 1)
  assert.equal(hop.headers['x-automagik-principal'], Buffer.from(JSON.stringify(member.principal)).toString('base64url'))
  const { instance, keys: [{ kid, crv, x }] } = JSON.parse(readFileSync(join(f.dir, 'caller-keys.json')))
  assert.deepEqual(verifyAssertion(hop.headers['x-automagik-caller'], {
    keys: new Map([[kid, { instance, key: crypto.createPublicKey({ key: { kty: 'OKP', crv, x }, format: 'jwk' }) }]]),
    method: 'POST', path, nowSec: Math.floor(Date.now() / 1000), startedAtSec: 0,
  }).principal, member.principal)
  assert.deepEqual(f.cookieCalls, [])
})

test('the gate fences all carrier namespace spellings before authentication on every transport', async t => {
  const f = await callerFixture(t)
  const off = await f.makeGate(false)
  const paths = ['/_automagik', '/_automagik/caller/api/x', '//_automagik', '/x/../_automagik/caller',
    '/api/%2e%2e/_automagik', '/%5Fautomagik', '/%5fAUTOMAGIK/caller', '/\\_automagik',
    '/_automagik%2Fcaller', '/_AUTOMAGIK', '/%255Fautomagik', '/_automagik?x=1']
  for (const port of [f.gatePort, off]) {
    for (const headers of [f.issue('owner').headers, f.issue('member').headers, {}]) {
      for (const path of paths) {
        assert.equal((await request(port, path, { headers })).status, 400, path)
        assert.equal((await request(port, path, { headers: { ...websocketHeaders, ...headers }, upgrade: true })).status, 400, path)
        assert.equal((await request(port, path, { method: 'CONNECT', headers })).status, 400, path)
      }
    }
  }
  assert.equal(f.seen.length, 0)
  assert.equal(f.cookieCalls.length, 0)
  assert.equal(f.signs.length, 0)
})

test('owner and admin HTTP and WebSocket forwarding are identical in both modes', async t => {
  const f = await callerFixture(t)
  const off = await f.makeGate(false)
  for (const role of ['owner', 'admin']) {
    const { headers } = f.issue(role)
    for (const port of [f.gatePort, off]) {
      assert.equal((await request(port, '/api/x?x=1', { headers })).status, 200)
      const ws = await request(port, '/api/remote.mux', { headers: { ...websocketHeaders, ...headers }, upgrade: true })
      assert.equal(ws.status, 101)
      ws.socket.destroy()
    }
    const [onHttp, onUpgrade, offHttp, offUpgrade] = f.seen.splice(0)
    assert.deepEqual(onHttp.headers, offHttp.headers)
    assert.equal(onHttp.url, offHttp.url)
    assert.deepEqual(onUpgrade, offUpgrade)
    assert.equal(onHttp.headers['x-automagik-caller'], undefined)
    assert.equal(onUpgrade.headers['x-automagik-caller'], undefined)
  }
  assert.equal(f.cookieCalls.length, 8)
})

test('revocation between authorization and the owner credential step never mints a cookie', async t => {
  const f = await callerFixture(t)
  const httpGate = await f.makeGate(true, { handle(_req, _res, family) { f.sessions.revoke(family); return false } })
  const authenticate = f.sessions.authenticate.bind(f.sessions)
  for (const role of ['owner', 'admin']) {
    let issued = f.issue(role)
    assert.equal((await request(httpGate, '/api/x', { headers: issued.headers })).status, 401)
    issued = f.issue(role)
    f.sessions.authenticate = (...args) => {
      const family = authenticate(...args)
      f.sessions.revoke(family)
      return family
    }
    assert.equal((await request(f.gatePort, '/api/remote.mux', { headers: { ...websocketHeaders, ...issued.headers }, upgrade: true })).status, 401)
    f.sessions.authenticate = authenticate
  }
  assert.deepEqual(f.cookieCalls, [])
  assert.deepEqual(f.seen, [])
})

test('member frontend allowlist, MCP refusal and rollback never use the owner credential', async t => {
  const f = await callerFixture(t)
  const member = f.issue('member')
  const guest = f.issue('guest')
  const off = await f.makeGate(false)
  for (const { headers } of [member, guest]) {
    const before = f.seen.length
    const signed = f.signs.length
    // Delivery 5b carries a member's or guest's exact /api/remote.mux to the adapter, signed.
    const carried = await request(f.gatePort, '/api/remote.mux', { headers: { ...websocketHeaders, ...headers }, upgrade: true })
    assert.equal(carried.status, 101)
    carried.socket.destroy()
    assert.equal(f.seen.length, before + 1)
    assert.equal(f.signs.length, signed + 1)
    assert.equal((await request(off, '/api/x', { headers })).status, 403)
    assert.equal(f.seen.length, before + 1)
    assert.equal(f.signs.length, signed + 1)
    assert.equal((await request(off, '/api/remote.mux', { headers: { ...websocketHeaders, ...headers }, upgrade: true })).status, 403)
    assert.equal(f.seen.length, before + 1)
    assert.equal(f.signs.length, signed + 1)
  }
  assert.equal(f.seen.length, 2)
  for (const hop of f.seen.splice(0)) {
    assert.equal(hop.url, '/_automagik/caller/api/remote.mux')
    assert.ok(hop.headers['x-automagik-caller'])
    assert.equal(hop.headers.cookie, undefined)
  }
  const paths = JSON.parse(source('./fixtures/caller-frontend-paths.json'))
  for (const path of paths.allowed) assert.equal((await request(f.gatePort, path, { headers: member.headers, method: 'HEAD' })).status, 200, path)
  for (const path of paths.refused) assert.equal((await request(f.gatePort, path, { headers: member.headers })).status, 404, path)
  assert.ok(f.seen.every(hop => hop.url.startsWith('/_automagik/caller/')))
  assert.equal(f.seen.length, paths.allowed.length)
  assert.equal((await request(f.gatePort, '/x', { method: 'PUT', headers: member.headers })).status, 405)
  assert.equal((await request(f.gatePort, '/api/omni-mcp', { method: 'POST' })).status, 403)
  const owner = f.issue('owner')
  for (const alias of ['/api/omni-mcp?x=1', '/x/../api/omni-mcp']) {
    assert.equal((await request(f.gatePort, alias, { method: 'POST', headers: owner.headers })).status, 403)
  }
  assert.deepEqual(f.cookieCalls, [])
  assert.equal((await request(off, '/api/omni-mcp', { method: 'POST' })).status, 200)
  assert.equal(f.cookieCalls.length, 1)
  assert.equal(f.seen.at(-1).url, '/api/omni-mcp')
})

test('carrier unavailability, an upstream 401 and an inactive member never use the owner fallback', async t => {
  const f = await callerFixture(t, { carrierStatus: 401 })
  const { headers, family } = f.issue('member')
  assert.equal((await request(f.gatePort, '/api/x', { headers })).status, 401)
  assert.equal(f.seen.length, 1)
  assert.equal(f.signs.length, 1)
  await f.stopUpstream()
  // Delivery 5b: with DSH gone the readiness probe fails, so nothing more is signed.
  assert.equal((await request(f.gatePort, '/api/x', { headers })).status, 503)
  assert.equal(f.signs.length, 1)
  const staleGate = await f.makeGate(true, { handle() { f.sessions.revoke(family); return false } })
  assert.equal((await request(staleGate, '/api/x', { headers })).status, 401)
  assert.equal(f.signs.length, 1)
  assert.deepEqual(f.cookieCalls, [])
})

test('gate handlers refuse private paths and revoked owner families before requesting credentials', async t => {
  const { sessions } = store(t, { memory: true, accepts: () => true })
  const events = []
  const forbid = () => { events.push('owner credential or caller assertion requested'); throw new Error('Unexpected credential request') }
  const credentials = { cookie: forbid }
  const request = (path, headers = {}, method = 'GET') => {
    const fields = { host: HOST, ...headers }
    return { url: path, method, headers: fields, rawHeaders: Object.entries(fields).flat() }
  }
  async function status(gate, req, transport = 'request') {
    const handle = gate.listeners(transport)[0]
    if (transport === 'request') {
      let result
      await handle(req, {
        writeHead(code) { result = code; return this },
        end() {},
      })
      return result
    }
    const socket = new EventEmitter()
    socket.destroy = () => socket.emit('close')
    socket.resume = () => {}
    socket.pause = () => {}
    let result
    socket.end = (line, callback) => { result = Number(line.split(' ')[1]); callback() }
    await handle(req, socket, Buffer.alloc(0))
    return result
  }
  const take = sessions.authenticate.bind(sessions)
  const issue = role => {
    const { secret } = sessions.issue(ORIGIN, { issuer: 'fixture', subject: role, roles: [role], workspace: 'w' })
    return { cookie: `${COOKIE}=${secret}`, origin: ORIGIN }
  }
  for (const multiuser of [false, true]) {
    // No adapter answers the probe here; a refused probe signs nothing.
    const connectDsh = () => Promise.reject(new Error('No adapter'))
    const gate = createGate({ origin: ORIGIN, sessions, credentials, multiuser, caller: { sign: forbid }, connectDsh, selfHosted: {
      handle(_req, _res, family) {
        if (family?.principal.roles.some(role => role === 'owner' || role === 'admin')) sessions.revoke(family)
        return false
      },
    } })
    try {
      for (const path of ['/api/x', '/api/omni-mcp']) {
        for (const framing of [
          { 'transfer-encoding': 'chunked', 'content-length': '5' },
          { 'transfer-encoding': 'gzip, chunked' },
        ]) {
          assert.equal(await status(gate, request(path, { ...issue('owner'), ...framing }, 'POST')), 400)
        }
      }
      for (const duplicate of [HOST, 'other.invalid']) {
        const withDuplicate = req => ({ ...req, rawHeaders: [...req.rawHeaders, 'hOsT', duplicate] })
        assert.equal(await status(gate, withDuplicate(request('/', issue('owner')))), 400)
        assert.equal(await status(gate, withDuplicate(request('/api/omni-mcp', issue('owner'), 'POST'))), 400)
        assert.equal(await status(gate, withDuplicate(request('/api/remote.mux', { ...websocketHeaders, ...issue('owner') })), 'upgrade'), 400)
      }
      for (const framing of [{ 'transfer-encoding': 'chunked' }, { 'content-length': '5' }]) {
        assert.equal(await status(gate, request('/api/remote.mux', { ...websocketHeaders, ...issue('owner'), ...framing }), 'upgrade'), 400)
      }
      for (const path of ['/_automagik', '/%255Fautomagik/caller/api/fixture', '/x/../_AUTOMAGIK', '//_automagik', '/\\_automagik']) {
        assert.equal(await status(gate, request(path)), 400)
        assert.equal(await status(gate, request(path, websocketHeaders), 'upgrade'), 400)
        assert.equal(await status(gate, request(path, {}, 'CONNECT'), 'connect'), 400)
      }
      for (const role of ['owner', 'admin']) {
        assert.equal(await status(gate, request('/api/x', issue(role))), 401)
        const headers = issue(role)
        sessions.authenticate = (...args) => {
          const family = take(...args)
          sessions.revoke(family)
          return family
        }
        assert.equal(await status(gate, request('/api/remote.mux', { ...websocketHeaders, ...headers }), 'upgrade'), 401)
        sessions.authenticate = take
        if (multiuser) {
          for (const path of ['/api/omni-mcp', '/api/omni-mcp?x=1', '/x/../api/omni-mcp']) {
            assert.equal(await status(gate, request(path, { ...websocketHeaders, ...issue(role) }), 'upgrade'), 403)
          }
        }
      }
      const member = issue('member')
      // Delivery 5b: multiuser carries a member's exact /api/remote.mux once the adapter answers.
      assert.equal(await status(gate, request('/api/remote.mux', { ...websocketHeaders, ...member }), 'upgrade'), multiuser ? 503 : 403)
      if (!multiuser) assert.equal(await status(gate, request('/api/x', member)), 403)
      else assert.equal(await status(gate, request('/api/omni-mcp', { origin: ORIGIN }, 'POST')), 403)
    } finally { await gate.closeGate() }
  }
  assert.deepEqual(events, [])
})

test('owner browser requests cannot reach the DSH /connect exchange', async t => {
  const f = await fixture(t)
  for (const path of ['/connect', '/connect?next=x', '/x/../connect', '/%2E/connect']) {
    assert.equal(new URL(path, ORIGIN).pathname, '/connect', path)
    assert.equal((await request(f.gatePort, path, { headers: { ...websocketHeaders, ...f.headers }, upgrade: true })).status, 401, path)
  }
  assert.equal(f.exchanges(), 0)
  assert.equal(f.seen.length, 0)
  assert.equal((await request(f.gatePort, '/connect', { headers: f.headers })).status, 401)
  assert.equal(f.exchanges(), 0)
  assert.equal(f.seen.length, 0)
})

test('/connect upgrades preserve role refusals with multiuser on and off', async t => {
  const f = await callerFixture(t)
  for (const port of [f.gatePort, await f.makeGate(false)]) {
    for (const [role, status] of [['owner', 401], ['admin', 401], ['member', 403], ['guest', 403]]) {
      const { headers } = f.issue(role)
      const response = await request(port, '/connect', { headers: { ...websocketHeaders, ...headers }, upgrade: true })
      assert.equal(response.status, status, role)
    }
    assert.deepEqual(f.cookieCalls, [])
    assert.deepEqual(f.seen, [])
    assert.deepEqual(f.signs, [])
  }
})

test('a late owner HTTP 401 clears the cookie without minting after revocation', async t => {
  const held = Promise.withResolvers()
  const f = await fixture(t, { handleRequest(req, res) {
    if (req.url !== '/held') return false
    held.resolve(res)
    return true
  } })
  const mint = t.mock.method(f.credentials, 'mint')
  const response = request(f.gatePort, '/held', { headers: f.headers })
  const upstream = await Promise.race([held.promise, response.then(() => assert.fail('DSH did not hold the request'))])
  assert.equal(mint.mock.callCount(), 1)
  f.sessions.revoke(f.issued.family)
  upstream.writeHead(401).end()
  assert.equal((await response).status, 401)
  assert.equal(mint.mock.callCount(), 1)
  assert.equal(f.credentials.cached, undefined)
  const next = f.sessions.issue(ORIGIN, f.principal)
  assert.equal((await request(f.gatePort, '/', { headers: { ...f.headers, cookie: `${COOKIE}=${next.secret}` } })).status, 200)
  assert.equal(mint.mock.callCount(), 2)
})

test('an owner upgrade 401 leaves minting to the next authorized request', async t => {
  const f = await fixture(t)
  const mint = t.mock.method(f.credentials, 'mint')
  assert.equal((await request(f.gatePort, '/', { headers: f.headers })).status, 200)
  assert.equal(mint.mock.callCount(), 1)
  f.restart()
  const response = await request(f.gatePort, '/api/remote.mux', { headers: { ...websocketHeaders, ...f.headers }, upgrade: true })
  assert.equal(response.status, 401)
  assert.equal(mint.mock.callCount(), 1)
  assert.equal(f.credentials.cached, undefined)
  assert.equal((await request(f.gatePort, '/', { headers: f.headers })).status, 200)
  assert.equal(mint.mock.callCount(), 2)
})

test('revoking an owner while DSH holds the upgrade closes the client without minting', async t => {
  const held = Promise.withResolvers()
  const f = await fixture(t, { handleUpgrade() { held.resolve(); return true } })
  const mint = t.mock.method(f.credentials, 'mint')
  const headers = Object.entries({ host: HOST, ...websocketHeaders, ...f.headers }).map(([name, value]) => `${name}: ${value}`)
  const socket = net.connect({ host: DSH_HOST, port: f.gatePort })
  socket.setTimeout(5000, () => socket.destroy(new Error('Raw test request timed out')))
  socket.setEncoding('utf8')
  let received = ''
  let status
  socket.on('data', chunk => {
    if (status !== undefined) return
    received += chunk
    const match = /^HTTP\/1\.1 (\d+)(?=[ \r\n])/.exec(received)
    if (match) status = Number(match[1])
  })
  const response = once(socket, 'close').catch(error => {
    if (error.code !== 'ECONNRESET') throw error
  })
  socket.write(['GET /api/remote.mux HTTP/1.1', ...headers, '', ''].join('\r\n'))
  await Promise.race([held.promise, response.then(() => assert.fail('DSH did not hold the upgrade'))])
  assert.equal(mint.mock.callCount(), 1)
  f.sessions.revoke(f.issued.family)
  await response
  assert.notEqual(status, 101)
  assert.equal(mint.mock.callCount(), 1)
  await f.seen[0].closed
})

test('an owner upgrade 401 that arrives after the family went inactive starts no mint', async t => {
  const f = await fixture(t, { handleUpgrade(_req, socket) {
    socket.end('HTTP/1.1 401 Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
    return true
  } })
  const mint = t.mock.method(f.credentials, 'mint')
  const originalRequest = http.request
  t.mock.method(http, 'request', (options, ...args) => {
    const req = originalRequest(options, ...args)
    if (options.hostname === DSH_HOST && options.port === f.credentials.port && options.method === 'GET' && options.path === '/api/remote.mux') {
      req.prependOnceListener('response', () => f.advance(13 * 60 * 60 * 1000))
    }
    return req
  })
  const response = await request(f.gatePort, '/api/remote.mux', { headers: { ...websocketHeaders, ...f.headers }, upgrade: true })
  response.socket?.destroy()
  assert.equal(f.sessions.active(f.issued.family), false, 'the family went inactive before the 401')
  assert.equal(response.status, 401)
  assert.equal(f.seen.length, 1)
  assert.equal(f.credentials.cached, undefined)
  // On origin/dev, the upgrade response callback calls credentials.cookie(true), starting a second mint.
  assert.equal(mint.mock.callCount(), 1)
})

test('DshCredentials invalidates only the matching cached cookie without exchanging', async t => {
  const f = await fixture(t)
  const cookie = await f.credentials.cookie()
  assert.equal(f.exchanges(), 1)
  f.credentials.invalidate('other')
  assert.equal(f.credentials.cached, cookie)
  assert.equal(f.exchanges(), 1)
  f.credentials.invalidate(cookie)
  assert.equal(f.credentials.cached, undefined)
  assert.equal(f.credentials.pending, undefined)
  assert.equal(f.exchanges(), 1)
  f.restart()
  assert.notEqual(await f.credentials.cookie(), cookie)
  assert.equal(f.exchanges(), 2)
})

// --- RFC 0038 delivery 5b: the member stream carrier and the readiness probe ----------------

const signedHops = f => f.seen.filter(hop => hop.headers['x-automagik-caller'] !== undefined)
async function rawUpgrade(port, method, path, headers) {
  return rawRequest(port, `${method} ${path} HTTP/1.1`, [`Host: ${HOST}`, 'Connection: Upgrade', 'Upgrade: websocket',
    'Sec-WebSocket-Version: 13', `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`)])
}

test('member upgrades are carried only on the exact mux path, signed as GET, without DSH credentials', async t => {
  const f = await callerFixture(t)
  const member = f.issue('member')
  for (const path of ['/api/remote.mux?x=1', '/api/remote.mux/', '/API/remote.mux', '/api//remote.mux', '/api/other', '/']) {
    assert.equal((await request(f.gatePort, path, { headers: { ...websocketHeaders, ...member.headers }, upgrade: true })).status, 403, path)
  }
  assert.equal(await rawUpgrade(f.gatePort, 'POST', '/api/remote.mux', { Cookie: member.headers.cookie, Origin: ORIGIN }), 403)
  for (const role of ['viewer']) {
    const roleless = f.issue(role)
    assert.equal((await request(f.gatePort, '/api/remote.mux', { headers: { ...websocketHeaders, ...roleless.headers }, upgrade: true })).status, 403)
  }
  assert.deepEqual(f.signs, [])
  assert.deepEqual(signedHops(f), [])
  // The exact path: one GET assertion for /api/remote.mux, the handshake fields and nothing else.
  const carried = await request(f.gatePort, '/api/remote.mux', { headers: { ...websocketHeaders, ...member.headers,
    authorization: 'Bearer browser', 'x-automagik-principal': 'spoofed', 'sec-websocket-protocol': 'chat' }, upgrade: true })
  assert.equal(carried.status, 101)
  carried.socket.destroy()
  assert.deepEqual(f.signs.map(({ method, path }) => [method, path]), [['GET', '/api/remote.mux']])
  const [hop] = signedHops(f)
  assert.equal(hop.url, '/_automagik/caller/api/remote.mux')
  assert.deepEqual(Object.keys(hop.headers).sort(), ['connection', 'host', 'origin', 'sec-websocket-key', 'sec-websocket-version',
    'upgrade', 'x-automagik-caller'])
  assert.equal(hop.headers.host, `${DSH_HOST}:${f.port}`)
  // A refused signature answers 403 and sends nothing signed.
  const refusing = await f.makeGate(true, undefined, { caller: { sign() { throw new Error('refused') } } })
  assert.equal((await request(refusing, '/api/remote.mux', { headers: { ...websocketHeaders, ...f.issue('member').headers }, upgrade: true })).status, 403)
  assert.equal(signedHops(f).length, 1)
  // Multiuser off: member upgrades stay 403 and nothing is probed or signed.
  const probes = f.probes.length
  const off = await f.makeGate(false)
  assert.equal((await request(off, '/api/remote.mux', { headers: { ...websocketHeaders, ...f.issue('guest').headers }, upgrade: true })).status, 403)
  assert.equal(f.probes.length, probes)
  assert.equal(f.signs.length, 1)
  assert.deepEqual(f.cookieCalls, [])
})

test('a carried upgrade passes carrier refusals and never touches the owner credential', async t => {
  for (const [status, expected] of [[400, 400], [401, 401], [403, 403], [429, 429], [503, 503], [500, 502]]) {
    const f = await callerFixture(t, { upgradeStatus: status })
    const { headers } = f.issue('member')
    assert.equal((await request(f.gatePort, '/api/remote.mux', { headers: { ...websocketHeaders, ...headers }, upgrade: true })).status, expected)
    assert.equal(f.signs.length, 1)
    assert.deepEqual(f.cookieCalls, [])
  }
})

test('a strict probe signs nothing on a bad answer', async t => {
  const raw = text => (_res, req) => { req.socket.write(text) }
  const answers = {
    'refused connection': undefined,
    '404': res => res.writeHead(404).end(),
    '503': res => res.writeHead(503).end(),
    'missing header': res => res.writeHead(204).end(),
    'two ready headers': raw('HTTP/1.1 204 No Content\r\nx-automagik-ready: 1\r\nx-automagik-ready: 1\r\n\r\n'),
    'truncated status line': raw('HTTP/1.1 204\r\nx-automagik-ready: 1\r\n\r\n'),
    'invalid status reason': raw('HTTP/1.1 204 No Content\tbad\r\nx-automagik-ready: 1\r\n\r\n'),
    'space before header colon': raw('HTTP/1.1 204 No Content\r\nx-automagik-ready : 1\r\n\r\n'),
    'invalid field name': raw('HTTP/1.1 204 No Content\r\nx-automagik-ready: 1\r\ninvalid field: ok\r\n\r\n'),
    'duplicate zero length': raw('HTTP/1.1 204 No Content\r\nx-automagik-ready: 1\r\nContent-Length: 0\r\ncontent-length: 0\r\n\r\n'),
    'connection close': res => res.writeHead(204, { 'x-automagik-ready': '1', connection: 'close' }).end(),
    'a body': raw('HTTP/1.1 204 No Content\r\nx-automagik-ready: 1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n'),
    'content-length': raw('HTTP/1.1 204 No Content\r\nx-automagik-ready: 1\r\nContent-Length: 2\r\n\r\nok'),
    'bytes after the header block': raw('HTTP/1.1 204 No Content\r\nx-automagik-ready: 1\r\n\r\nHTTP/1.1 200 OK\r\n\r\n'),
    'timeout': () => {},
  }
  for (const [name, probe] of Object.entries(answers)) {
    const f = await callerFixture(t, { probe })
    if (name === 'refused connection') await f.stopUpstream()
    const member = f.issue('member')
    assert.equal((await request(f.gatePort, '/api/x', { method: 'POST', body: 'x', headers: member.headers })).status, 503, name)
    assert.equal((await request(f.gatePort, '/api/remote.mux', { headers: { ...websocketHeaders, ...member.headers }, upgrade: true })).status, 503, name)
    assert.deepEqual(f.signs, [], name)
    assert.deepEqual(f.seen, [], name)
    assert.deepEqual(f.cookieCalls, [], name)
  }
})

function openFeed(port, headers, agent) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: DSH_HOST, port, path: '/api/held', agent, headers: { host: HOST, ...headers } }, res => {
      const ended = new Promise(done => { res.once('close', done); res.once('error', done) })
      res.once('data', () => resolve({ res, ended }))
    })
    req.on('error', reject)
    req.end()
  })
}

function heldMemberTransports() {
  const feeds = [], muxes = []
  return {
    feeds, muxes,
    handleRequest(req, res) {
      if (!req.url.endsWith('/api/held')) return false
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: open\n\n')
      feeds.push({ res, closed: once(res, 'close') })
      return true
    },
    handleUpgrade(_req, socket) {
      muxes.push({ closed: once(socket, 'close') })
      // HTTP hands off a half-open socket on upgrade. Acknowledge the gate's FIN.
      socket.once('end', () => socket.end())
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
      socket.on('data', data => socket.write(data))
      return true
    },
    async open(port, headers) {
      const feedCount = feeds.length
      const muxCount = muxes.length
      const feed = await openFeed(port, headers)
      assert.equal(feed.res.statusCode, 200)
      assert.equal(feeds.length, feedCount + 1)
      const upgrade = await request(port, '/api/remote.mux', { headers: { ...websocketHeaders, ...headers }, upgrade: true })
      assert.equal(upgrade.status, 101)
      assert.equal(muxes.length, muxCount + 1)
      const { socket } = upgrade
      const closed = once(socket, 'close')
      socket.resume()
      return { feed, socket, closed, dshFeed: feeds.at(-1), dshMux: muxes.at(-1) }
    },
  }
}

test('revocation and hard family expiry end a member feed and mux at both ends', { timeout: 5000 }, async t => {
  let now = Date.now()
  const held = heldMemberTransports()
  const f = await callerFixture(t, { ...held, now: () => now })
  for (const end of ['revocation', 'expiry']) {
    const { family, headers } = f.issue('member', { expires: now + 5000 })
    const live = await held.open(f.gatePort, headers)
    assert.ok(f.sessions.active(family))
    if (end === 'revocation') f.sessions.revoke(family)
    else now += 5000
    assert.equal(f.sessions.active(family), false)
    await Promise.all([live.feed.ended, live.closed, live.dshFeed.closed, live.dshMux.closed])
  }
})

test('Cloud v2 renewal closes the old family feed and mux, and cookie rotation keeps both', { timeout: 5000 }, async t => {
  const held = heldMemberTransports()
  const f = await callerFixture(t, held)
  const expires = Date.now() + 60_000
  const proof = { aud: f.workspace, exp: Math.floor(expires / 1000), token: 'old-proof' }
  const { family, principal, headers } = f.issue('member', { expires, proof })
  const renew = t.mock.fn(async () => ({ principal, expires, proof: { ...proof, token: 'new-proof' } }))
  const cloud = { config: { workspace: f.workspace }, drops: () => false, renew, pollInterval: 300_000 }
  const port = await f.makeGate(true, undefined, { cloud })
  const live = await held.open(port, headers)
  const rotated = await request(port, '/_gate/session/renew', { method: 'POST', headers })
  assert.equal(rotated.status, 200)
  const cookie = rotated.headers['set-cookie'][0].split(';', 1)[0]
  assert.notEqual(cookie, headers.cookie)
  assert.equal(f.sessions.authenticate(cookieSecret(cookie), ORIGIN), family)
  assert.equal(renew.mock.callCount(), 0)
  const feedData = once(live.feed.res, 'data')
  const echo = once(live.socket, 'data')
  live.dshFeed.res.write('data: still open\n\n')
  live.socket.write('still open')
  assert.match((await feedData)[0].toString(), /still open/)
  assert.equal((await echo)[0].toString(), 'still open')
  const renewed = await request(port, CLOUD_RENEW_PATH, {
    method: 'POST', headers: { ...headers, cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ version: 2, renew: true, workspace: f.workspace }),
  })
  assert.equal(renewed.status, 200)
  assert.deepEqual(renew.mock.calls.map(call => call.arguments), [[principal, proof]])
  assert.equal(f.sessions.active(family), false)
  const fresh = cookieSecret(renewed.headers['set-cookie'][0].split(';', 1)[0])
  const next = f.sessions.authenticate(fresh, ORIGIN)
  assert.ok(next)
  assert.notEqual(next.id, family.id)
  assert.deepEqual(next.proof, { ...proof, token: 'new-proof' })
  await Promise.all([live.feed.ended, live.closed, live.dshFeed.closed, live.dshMux.closed])
})

test('an actual rebind without drop ends member HTTP and mux and finishes listening', { timeout: 5000 }, async t => {
  const held = heldMemberTransports()
  const f = await callerFixture(t, held)
  const { headers } = f.issue('member')
  for (const [host, drop] of [[DSH_HOST, true], ['127.0.0.2', false]]) {
    const live = await held.open(f.gatePort, headers)
    await f.gate.rebind(f.gatePort, host, drop)
    assert.deepEqual(f.gate.address(), { address: host, family: 'IPv4', port: f.gatePort })
    await Promise.all([live.feed.ended, live.closed, live.dshFeed.closed, live.dshMux.closed])
  }
})

test('a browser disconnect cancels both outstanding pipelined member requests', { timeout: 5000 }, async t => {
  const held = heldMemberTransports()
  const both = Promise.withResolvers()
  const f = await callerFixture(t, { handleRequest(req, res) {
    const handled = held.handleRequest(req, res)
    if (held.feeds.length === 2) both.resolve()
    return handled
  } })
  const first = f.issue('member')
  const second = f.issue('guest')
  const browser = net.connect(f.gatePort, DSH_HOST)
  t.after(() => browser.destroy())
  const responses = []
  browser.on('data', data => responses.push(data))
  const firstBytes = once(browser, 'data')
  const raw = ({ headers }) => `GET /api/held HTTP/1.1\r\nHost: ${HOST}\r\nOrigin: ${ORIGIN}\r\nCookie: ${headers.cookie}\r\n\r\n`
  browser.write(raw(first) + raw(second))
  await Promise.all([firstBytes, both.promise])
  assert.equal(signedHops(f).length, 2)
  assert.match(Buffer.concat(responses).toString(), /^HTTP\/1\.1 200 /)
  assert.equal(Buffer.concat(responses).toString().match(/HTTP\/1\.1 200 /g).length, 1)
  const closed = once(browser, 'close')
  browser.destroy()
  await Promise.all([closed, ...held.feeds.map(feed => feed.closed)])
})

test('finished requests do not tie a later keep-alive feed to the old family, and revocation before signing refuses', async t => {
  const held = heldMemberTransports()
  const f = await callerFixture(t, held)
  // Reuse the connection for a second family after the first response finished.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
  t.after(() => agent.destroy())
  const first = f.issue('member')
  const second = f.issue('guest')
  const done = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: DSH_HOST, port: f.gatePort, path: '/api/x', agent, headers: { host: HOST, ...first.headers } }, res => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.end()
  })
  assert.equal(done, 200)
  const stream = await openFeed(f.gatePort, second.headers, agent)
  let ended = false
  stream.ended.then(() => { ended = true })
  f.sessions.revoke(first.family)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(ended, false, 'the other family\'s response stays open')
  f.sessions.revoke(second.family)
  await stream.ended
  await held.feeds.at(-1).closed
  // A revocation between the probe's answer and the signing: nothing signed, nothing forwarded, 401.
  const signs = f.signs.length
  const hops = signedHops(f).length
  let victim
  const racing = await f.makeGate(true, undefined, { connectDsh: async () => {
    f.sessions.revoke(victim.family)
    return new net.Socket()
  } })
  victim = f.issue('member')
  assert.equal((await request(racing, '/api/x', { headers: victim.headers })).status, 401)
  assert.equal(f.signs.length, signs)
  assert.equal(signedHops(f).length, hops)
})

test('the probe and the request share one connection', async t => {
  const f = await callerFixture(t, {
    probe: res => res.writeHead(204, { 'x-automagik-ready': '1', 'content-length': '0' }).end(),
  })
  const member = f.issue('member')
  assert.equal((await request(f.gatePort, '/api/x', { headers: member.headers })).status, 200)
  assert.equal(f.probes.length, 1)
  assert.equal(f.seen.at(-1).remotePort, f.probes.at(-1).remotePort)
  const upgraded = await request(f.gatePort, '/api/remote.mux', { headers: { ...websocketHeaders, ...member.headers }, upgrade: true })
  assert.equal(upgraded.status, 101)
  upgraded.socket.destroy()
  assert.equal(f.probes.length, 2)
  assert.equal(f.seen.at(-1).remotePort, f.probes.at(-1).remotePort)
  assert.notEqual(f.probes[0].remotePort, f.probes[1].remotePort)
})

test('browser EOF before a member upgrade probe completes signs nothing', { timeout: 5000 }, async t => {
  const { sessions } = store(t, { memory: true, accepts: () => true })
  const { secret } = sessions.issue(ORIGIN, {
    issuer: 'https://identity.invalid', subject: 'member', roles: ['member'], workspace: 'caller-workspace',
  })
  const started = Promise.withResolvers()
  const answer = Promise.withResolvers()
  const browser = new EventEmitter()
  Object.assign(browser, {
    destroy() {
      this.destroyed = true
      this.emit('close')
    },
    pause() {},
    resume() {},
    end() { this.destroy() },
  })
  let signs = 0
  const gate = createGate({ origin: ORIGIN, sessions, credentials: { port: 1, authority: `${DSH_HOST}:1` }, multiuser: true,
    caller: { sign() { signs++; throw new Error('unexpected signature') } },
    connectDsh({ signal }) { started.resolve(signal); return answer.promise },
  })
  t.after(() => gate.closeGate())
  const headers = { ...websocketHeaders, host: HOST, cookie: `${COOKIE}=${secret}` }
  gate.emit('upgrade', { method: 'GET', url: '/api/remote.mux', headers, rawHeaders: Object.entries(headers).flat() }, browser, Buffer.alloc(0))
  const signal = await started.promise
  browser.emit('end') // Readable FIN with the writable half still open.
  let destroyed = false
  answer.resolve({ destroy() { destroyed = true } }) // The answer may already have been in flight.
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(signs, 0)
  assert.equal(signal.aborted, true)
  assert.equal(browser.destroyed, true)
  assert.equal(destroyed, true)
})

function pendingMemberUpgrades(t) {
  const { sessions } = store(t, { memory: true, accepts: () => true })
  const probes = []
  const sign = t.mock.fn(() => { throw new Error('unexpected signature') })
  const gate = createGate({
    origin: ORIGIN, sessions, credentials: { port: 1, authority: `${DSH_HOST}:1` }, multiuser: true, caller: { sign },
    connectDsh({ signal }) {
      probes.push(signal)
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    },
  })
  t.after(() => gate.closeGate())
  return {
    probes, sign,
    issue(subject) {
      return sessions.issue(ORIGIN, { issuer: 'https://identity.invalid', subject, roles: ['member'], workspace: 'caller-workspace' })
    },
    async upgrade({ secret }, { head = Buffer.alloc(0), version = '13' } = {}) {
      const socket = new EventEmitter()
      Object.assign(socket, {
        destroy() {
          if (this.destroyed) return
          this.destroyed = true
          this.emit('close')
        },
        end(text, done) { this.status = Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1]); done() },
        pause() {},
        resume() { this.resumed = true },
      })
      const headers = { ...websocketHeaders, 'sec-websocket-version': version, host: HOST, cookie: `${COOKIE}=${secret}` }
      gate.emit('upgrade', { method: 'GET', url: '/api/remote.mux', headers, rawHeaders: Object.entries(headers).flat() }, socket, head)
      await new Promise(resolve => setImmediate(resolve))
      return socket
    },
  }
}

test('the gate refuses a fifth pending member upgrade across two families before probing', async t => {
  const f = pendingMemberUpgrades(t)
  const first = f.issue('member'), second = f.issue('member')
  assert.notEqual(first.family.id, second.family.id)
  const held = await Promise.all([first, second, first, second].map(family => f.upgrade(family)))
  assert.ok(held.every(socket => socket.resumed && !socket.destroyed))
  assert.equal(f.probes.length, 4)
  const fifth = await f.upgrade(second)
  assert.equal(fifth.status, 429)
  assert.equal(fifth.resumed, undefined)
  assert.equal(f.probes.length, 4)
  held[0].destroy()
  assert.equal(f.probes[0].aborted, true)
  assert.equal((await f.upgrade(second)).resumed, true)
  assert.equal(f.probes.length, 5)
  assert.equal(f.sign.mock.callCount(), 0)
})

test('the gate caps pending upgrades across people and returns a slot on close', async t => {
  const f = pendingMemberUpgrades(t)
  const held = await Promise.all(Array.from({ length: 64 }, (_, i) => f.upgrade(f.issue(`member-${i}`))))
  assert.ok(held.every(socket => socket.resumed && !socket.destroyed))
  assert.equal(f.probes.length, 64)
  const next = f.issue('extra')
  assert.equal((await f.upgrade(next)).status, 503)
  assert.equal(f.probes.length, 64)
  held[0].destroy()
  assert.equal((await f.upgrade(next)).resumed, true)
  assert.equal(f.probes.length, 65)
})

test('a pending member upgrade counts head toward its early byte allowance', async t => {
  const f = pendingMemberUpgrades(t)
  const member = f.issue('member')
  const limit = 1_048_576 + 1024 * 14
  const oversized = await f.upgrade(member, { head: Buffer.alloc(limit + 1) })
  assert.equal(oversized.destroyed, true)
  assert.equal(oversized.resumed, undefined)
  assert.equal(f.probes.length, 0)
  const held = await f.upgrade(member, { head: Buffer.alloc(1) })
  held.emit('data', Buffer.alloc(limit - 1))
  assert.equal(held.destroyed, undefined)
  held.emit('data', Buffer.alloc(1))
  assert.equal(held.destroyed, true)
  assert.equal(f.probes[0].aborted, true)
  assert.equal(f.sign.mock.callCount(), 0)
})

test('the gate refuses a noncanonical WebSocket version before probing', async t => {
  const f = pendingMemberUpgrades(t)
  const malformed = await f.upgrade(f.issue('member'), { version: '13.0' })
  assert.equal(malformed.status, 400)
  assert.equal(malformed.resumed, undefined)
  assert.deepEqual(f.probes, [])
  assert.equal(f.sign.mock.callCount(), 0)
})

test('member upgrades preserve head and later bytes while the readiness probe is pending', { timeout: 5000 }, async t => {
  const held = Promise.withResolvers()
  const browserBytes = Promise.withResolvers()
  let received = Buffer.alloc(0)
  const f = await callerFixture(t, {
    probe(res) { held.resolve(() => res.writeHead(204, { 'x-automagik-ready': '1' }).end()) },
    handleUpgrade(_req, socket, head) {
      const add = chunk => {
        received = Buffer.concat([received, chunk])
        if (received.length >= 'head-during'.length) browserBytes.resolve(received.toString())
      }
      socket.once('end', () => socket.end())
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
      add(head)
      socket.on('data', add)
      return true
    },
  })
  const upgradeSocket = Promise.withResolvers()
  f.gate.on('upgrade', (_req, socket) => upgradeSocket.resolve(socket))
  const { headers } = f.issue('member')
  const raw = net.connect({ host: DSH_HOST, port: f.gatePort })
  t.after(() => raw.destroy())
  raw.resume()
  const fields = Object.entries({ ...websocketHeaders, ...headers, host: HOST }).map(([name, value]) => `${name}: ${value}`)
  raw.write(['GET /api/remote.mux HTTP/1.1', ...fields, '', 'head-'].join('\r\n'))
  const ready = await held.promise
  const browser = await upgradeSocket.promise
  const during = once(browser, 'data')
  raw.write('during')
  assert.equal((await during)[0].toString(), 'during')
  assert.equal(f.signs.length, 0)
  ready()
  assert.equal(await browserBytes.promise, 'head-during')
  assert.equal(f.signs.length, 1)
})

test('a restart after the probe reaches nobody', async t => {
  for (const transport of ['HTTP', 'upgrade']) {
    await t.test(transport, async t => {
      const restarted = []
      let next
      const f = await callerFixture(t, {
        async connectDsh(options) {
          const old = await probeDsh({ ...options, authority: f.credentials.authority })
          const closed = once(old, 'close')
          await Promise.all([closed, f.stopUpstream()])
          next = http.createServer((request, response) => { restarted.push(request.headers); response.writeHead(200).end() })
          next.on('upgrade', (request, socket) => { restarted.push(request.headers); socket.destroy() })
          next.listen(f.port, DSH_HOST)
          await once(next, 'listening')
          t.after(() => { next.closeAllConnections(); return new Promise(resolve => next.close(resolve)) })
          return old
        },
      })
      const member = f.issue('member')
      const reply = transport === 'HTTP'
        ? await request(f.gatePort, '/api/x', { method: 'POST', body: 'x', headers: member.headers })
        : await request(f.gatePort, '/api/remote.mux', { headers: { ...websocketHeaders, ...member.headers }, upgrade: true })
      assert.equal(reply.status, 503)
      assert.ok(next.listening)
      assert.equal(f.probes.length, 1)
      assert.equal(f.signs.length, 1)
      assert.deepEqual(restarted.filter(headers => headers['x-automagik-caller'] !== undefined), [])
      assert.deepEqual(restarted, [])
      assert.deepEqual(f.seen, [])
    })
  }
})
