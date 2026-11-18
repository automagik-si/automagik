import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { cloudConfig, CloudConfigurationError, CloudSignIn, KEYS_TTL_MS, MAX_EXCHANGES, REFRESH_INTERVAL_MS } from '../gate-cloud.mjs'
import { CLOUD_OPEN_PATH, createGate } from '../gate.mjs'
import { COOKIE, SessionStore } from '../gate-store.mjs'
import { DSH_HOST } from '../gate-upstream.mjs'

// A fake Cloud service: reserved placeholder names, and signing keys made in memory on every run.
// No real issuer, key, host or workspace id appears here.
const ORIGIN = 'https://workspace-a.invalid'
const ENV = {
  AUTOMAGIK_GATE_CLOUD_ISSUER: 'https://cloud.invalid',
  AUTOMAGIK_GATE_CLOUD_IDENTITY_ISSUER: 'https://id.invalid',
  AUTOMAGIK_GATE_CLOUD_WORKSPACE: 'workspace-a',
  AUTOMAGIK_GATE_CLOUD_KEYS_URL: 'https://cloud.invalid/workspace-keys',
  AUTOMAGIK_GATE_CLOUD_EXCHANGE_URL: 'https://cloud.invalid/open/exchange',
  AUTOMAGIK_GATE_CLOUD_RAIL_ORIGIN: 'https://rail.invalid',
  AUTOMAGIK_GATE_CLOUD_REVOCATION_URL: 'https://cloud.invalid/revocations',
}
const RAIL = ENV.AUTOMAGIK_GATE_CLOUD_RAIL_ORIGIN
const slot = () => generateKeyPairSync('ed25519')
const slots = { a: slot(), b: slot(), stranger: slot() }
const jwk = (kid, pair = slots[kid]) => ({ ...pair.publicKey.export({ format: 'jwk' }), kid, alg: 'EdDSA', use: 'sig' })
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
const code = () => randomBytes(24).toString('base64url')
function mint(claims, { kid = 'a', key = slots[kid].privateKey, header = {} } = {}) {
  const input = `${encode({ alg: 'EdDSA', typ: 'JWT', kid, ...header })}.${encode(claims)}`
  return `${input}.${sign(null, Buffer.from(input), key).toString('base64url')}`
}
const iso = ms => new Date(ms).toISOString()
// RFC 7515 detached JWS: the signature covers the header and the exact body bytes.
function detached(body, { kid = 'a', key = slots[kid].privateKey } = {}) {
  const header = encode({ alg: 'EdDSA', typ: 'JWT', kid })
  const input = `${header}.${Buffer.from(body).toString('base64url')}`
  return `${header}..${sign(null, Buffer.from(input), key).toString('base64url')}`
}
const REVOKE = '/_gate/cloud/revocation'
const SIGN = 'x-automagik-signature'
async function waitFor(check, timeout = 2000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for the gate')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function listen(server) { server.listen(0, DSH_HOST); await once(server, 'listening'); return server.address().port }
function request(port, { path = '/', method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: DSH_HOST, port, path, method, headers: { host: new URL(ORIGIN).host, ...headers } }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', part => { text += part })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }))
    })
    req.on('error', reject)
    req.on('upgrade', (response, socket) => resolve({ status: response.statusCode, headers: response.headers, socket, body: '' }))
    req.setTimeout(5000, () => req.destroy(new Error('Test timeout')))
    req.end(body)
  })
}
const form = value => ({ method: 'POST', path: CLOUD_OPEN_PATH, body: value,
  headers: { origin: RAIL, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } })
const cookieOf = response => response.headers['set-cookie']?.[0]?.split(';', 1)[0]

// One workspace gate in front of a fake DSH, and the fake Cloud it talks to.
async function fixture(t, { env = ENV, origin = ORIGIN, cloudState, pollInterval } = {}) {
  const state = cloudState ?? {
    now: 1_800_000_000_000,
    keys: [jwk('a')],
    signer: 'a',
    codes: new Map(),
    exchanges: [],
    keyFetches: 0,
    exchangeStatus: 200,
    reply: undefined,
    listFetches: 0,
    revocationList: undefined,
    revocationSignature: undefined,
    revocationStatus: 200,
  }
  const dir = mkdtempSync(join(tmpdir(), 'automagik-cloud-'))
  const config = cloudConfig(env)
  const audit = [], proxied = []
  let cloudServer
  if (!cloudState) {
    cloudServer = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/workspace-keys') {
        state.keyFetches++
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: state.keys }))
        return
      }
      if (req.method === 'POST' && req.url === '/open/exchange') {
        let body = ''
        req.on('data', part => { body += part })
        req.on('end', () => {
          state.exchanges.push({ headers: req.headers, body: JSON.parse(body) })
          const { code: presented, workspace } = JSON.parse(body)
          const issued = state.codes.get(presented)
          // Single use, for one workspace: a refusal issues no token and echoes no code.
          if (state.exchangeStatus !== 200 || !issued || issued.used || issued.workspace !== workspace) {
            res.writeHead(state.exchangeStatus === 200 ? 400 : state.exchangeStatus, { 'content-type': 'application/json' }).end('{"error":"refused"}')
            return
          }
          issued.used = true
          const iat = Math.floor(state.now / 1000)
          const token = mint({ ver: 1, iss: ENV.AUTOMAGIK_GATE_CLOUD_ISSUER, aud: workspace, sub: issued.sub, roles: issued.roles,
            workspace, iat, exp: iat + 300, ...issued.claims }, { kid: issued.kid ?? state.signer, ...(issued.key ? { key: issued.key } : {}), header: issued.header })
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(state.reply?.(token) ?? { version: 1, token, expires_in: 300 }))
        })
        return
      }
      if (req.method === 'GET' && req.url === '/revocations') {
        state.listFetches++
        const document = state.revocationList ?? { version: 1, workspace: 'workspace-a',
          issued_at: iso(state.now), expires_at: iso(state.now + 300_000), revoked: [] }
        const body = JSON.stringify(document)
        const signature = state.revocationSignature === undefined
          ? detached(body) : state.revocationSignature
        const headers = { 'content-type': 'application/json' }
        if (signature !== null) headers[SIGN] = signature
        res.writeHead(state.revocationStatus, headers).end(body)
        return
      }
      res.writeHead(404).end()
    })
    state.port = await listen(cloudServer)
  }
  // The gate's HTTPS calls are routed to the fake Cloud on loopback; paths come only from config.
  const routed = (url, options, callback) => {
    assert.equal(url.origin, new URL(ENV.AUTOMAGIK_GATE_CLOUD_ISSUER).origin, 'Cloud calls go only to configured locations')
    return http.request({ ...options, hostname: DSH_HOST, port: state.port, path: url.pathname }, callback)
  }
  const cloud = new CloudSignIn(config, { now: () => state.now, request: routed,
    ...(pollInterval === undefined ? {} : { pollInterval }) })
  const sessions = new SessionStore(dir, { now: () => state.now, memory: true, accepts: cloud.accepts })
  const upstream = http.createServer((req, res) => {
    proxied.push(req.headers)
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ principal: JSON.parse(Buffer.from(req.headers['x-automagik-principal'], 'base64url')) }))
  })
  const upstreamPort = await listen(upstream)
  const gate = createGate({ origin, sessions, cloud, auditAccess: entry => audit.push(entry),
    credentials: { port: upstreamPort, authority: `${DSH_HOST}:${upstreamPort}`, cookie: async () => 'dsh-credential=server-held' } })
  const gatePort = await listen(gate)
  t.after(async () => {
    await gate.closeGate()
    upstream.closeAllConnections()
    await new Promise(resolve => upstream.close(resolve))
    if (cloudServer) { cloudServer.closeAllConnections(); await new Promise(resolve => cloudServer.close(resolve)) }
    rmSync(dir, { recursive: true, force: true })
  })
  const issue = (options = {}) => {
    const value = options.value ?? code()
    state.codes.set(value, { workspace: 'workspace-a', sub: 'person-1', roles: ['owner'], used: false, ...options })
    return value
  }
  const open = value => request(gatePort, form(new URLSearchParams({ code: value }).toString()))
  return { state, dir, audit, proxied, sessions, cloud, port: gatePort, issue, open }
}

test('a rail open code becomes a gate session; the token never leaves the server', async t => {
  const f = await fixture(t)
  const opened = await f.open(f.issue())
  assert.equal(opened.status, 303)
  assert.equal(opened.headers.location, '/')
  assert.equal(opened.headers['cache-control'], 'no-store')
  const setCookie = opened.headers['set-cookie'][0]
  assert.match(setCookie, new RegExp(`^${COOKIE}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300$`))
  assert.equal(opened.body, '')
  assert.ok(!JSON.stringify(opened.headers).includes('eyJ'), 'no token in any response header')
  // Server to server, with no Cloud credential: only the code and this workspace's id.
  assert.equal(f.state.exchanges.length, 1)
  assert.deepEqual(Object.keys(f.state.exchanges[0].body).sort(), ['code', 'version', 'workspace'])
  assert.equal(f.state.exchanges[0].body.workspace, 'workspace-a')
  for (const name of ['authorization', 'cookie', 'x-api-key', 'proxy-authorization']) assert.equal(f.state.exchanges[0].headers[name], undefined)
  const page = await request(f.port, { headers: { cookie: cookieOf(opened) } })
  assert.equal(page.status, 200)
  assert.deepEqual(JSON.parse(page.body).principal, { issuer: 'https://id.invalid', subject: 'person-1', roles: ['owner'], workspace: 'workspace-a' })
  assert.equal(f.proxied.at(-1).cookie, 'dsh-credential=server-held')
  assert.deepEqual(f.audit, [])
})

// Mutant CLOUD_AUDIENCE_ANY drops the aud check; CLOUD_WORKSPACE_CLAIM drops workspace === aud.
test('a token for another workspace is refused even with a valid signature', async t => {
  const f = await fixture(t)
  for (const claims of [{ aud: 'workspace-b', workspace: 'workspace-b' }, { aud: 'workspace-b' }, { workspace: 'workspace-b' },
    { aud: ['workspace-a'] }, { iss: 'https://other-cloud.invalid' }, { ver: 2 }]) {
    const opened = await f.open(f.issue({ claims }))
    assert.equal(opened.status, 401, JSON.stringify(claims))
    assert.equal(opened.headers['set-cookie'], undefined)
  }
  assert.equal(f.sessions.list().length, 0)
  assert.equal(f.audit.length, 6)
  assert.ok(f.audit.every(entry => Object.keys(entry).sort().join() === 'request_id,status'), 'audit logs no code or token')
})

test('workspace A\'s open code is refused at workspace B, by the Cloud service and by B', async t => {
  const a = await fixture(t)
  const b = await fixture(t, { origin: 'https://workspace-b.invalid', cloudState: a.state,
    env: { ...ENV, AUTOMAGIK_GATE_CLOUD_WORKSPACE: 'workspace-b' } })
  const value = a.issue()
  const response = await request(b.port, { ...form(`code=${value}`), headers: { ...form().headers, host: 'workspace-b.invalid' } })
  assert.equal(response.status, 401)
  // B asked for its own workspace; the Cloud service refused a code minted for A.
  assert.equal(a.state.exchanges.at(-1).body.workspace, 'workspace-b')
  // A token minted for A and handed to B's verifier is refused on audience.
  const iat = Math.floor(a.state.now / 1000)
  const token = mint({ ver: 1, iss: ENV.AUTOMAGIK_GATE_CLOUD_ISSUER, aud: 'workspace-a', workspace: 'workspace-a', sub: 'person-1', roles: ['owner'], iat, exp: iat + 300 })
  await assert.rejects(b.cloud.verify(token), /refused/)
  assert.equal((await a.cloud.verify(token)).principal.workspace, 'workspace-a')
})

// Mutant CLOUD_LIFETIME_UNBOUNDED drops exp - iat <= 300; CLOUD_EXPIRY_SKEW accepts exp in the past.
test('expired, over-long and future tokens are refused', async t => {
  const f = await fixture(t)
  const iat = Math.floor(f.state.now / 1000)
  for (const claims of [{ iat: iat - 301, exp: iat - 1 }, { iat: iat - 300, exp: iat }, { exp: iat + 301 }, { iat: iat + 31, exp: iat + 200 },
    { exp: iat }, { nbf: iat + 60 }, { iat: '1' }, { exp: iat + 300.5 }]) {
    const opened = await f.open(f.issue({ claims }))
    assert.equal(opened.status, 401, JSON.stringify(claims))
  }
  assert.equal(f.sessions.list().length, 0)
})

// Mutant CLOUD_SIGNATURE_SKIPPED skips verify(); CLOUD_KID_ANY_KEY tries every cached key.
test('a wrong key, an unknown key id, alg none and header-supplied keys are refused', async t => {
  const f = await fixture(t)
  const cases = [
    { kid: 'a', key: slots.stranger.privateKey },
    { kid: 'stranger' },
    { kid: 'a', key: slots.stranger.privateKey, header: { jwk: jwk('stranger'), jku: 'https://attacker.invalid/keys' } },
    { kid: 'a', header: { alg: 'none' } },
    { kid: 'a', header: { alg: 'RS256' } },
    { kid: 'a', header: { crit: ['exp'] } },
  ]
  for (const options of cases) {
    const opened = await f.open(f.issue(options))
    assert.equal(opened.status, 401, JSON.stringify(options.header ?? options.kid))
  }
  // A key id the published set does not name is refused after a fresh fetch, even over a real
  // slot's signature: no fallback to another key.
  f.state.now += REFRESH_INTERVAL_MS
  assert.equal((await f.open(f.issue({ kid: 'retired', key: slots.a.privateKey }))).status, 401)
  assert.equal(f.sessions.list().length, 0)
  const iat = Math.floor(f.state.now / 1000)
  const good = mint({ ver: 1, iss: ENV.AUTOMAGIK_GATE_CLOUD_ISSUER, aud: 'workspace-a', workspace: 'workspace-a', sub: 'person-1', roles: ['owner'], iat, exp: iat + 300 })
  const [header, claims] = good.split('.')
  await assert.rejects(f.cloud.verify(`${header}.${claims}.`), /refused/)
  await assert.rejects(f.cloud.verify(`${header}.${encode({ ver: 1, iss: ENV.AUTOMAGIK_GATE_CLOUD_ISSUER, aud: 'workspace-a', workspace: 'workspace-a', sub: 'person-2', roles: ['owner'], iat, exp: iat + 300 })}.${good.split('.')[2]}`), /refused/)
})

// Mutant CLOUD_CODE_MEMORY drops the gate's own single-use record.
test('a replayed open code is refused by the gate and by the Cloud service', async t => {
  const f = await fixture(t)
  const value = f.issue()
  assert.equal((await f.open(value)).status, 303)
  const replay = await f.open(value)
  assert.equal(replay.status, 401)
  assert.equal(replay.headers['set-cookie'], undefined)
  assert.equal(f.state.exchanges.length, 1, 'the gate refuses its own replay before calling the Cloud service')
  // A second gate process (a restart) has no memory; the Cloud service's single use still holds.
  const restarted = await fixture(t, { cloudState: f.state })
  assert.equal((await restarted.open(value)).status, 401)
  assert.equal(f.state.exchanges.length, 2)
  assert.equal(restarted.sessions.list().length, 0)
  // Two fresh codes in the same second may carry equal tokens (no jti in version 1): both open.
  assert.equal((await f.open(f.issue())).status, 303)
  assert.equal((await f.open(f.issue())).status, 303)
})

// Mutant CLOUD_OPEN_QUERY accepts a code from the query string.
test('a code or token in a URL, a token in a header and a token in the form are refused', async t => {
  const f = await fixture(t)
  const iat = Math.floor(f.state.now / 1000)
  const token = mint({ ver: 1, iss: ENV.AUTOMAGIK_GATE_CLOUD_ISSUER, aud: 'workspace-a', workspace: 'workspace-a', sub: 'person-1', roles: ['owner'], iat, exp: iat + 300 })
  const value = f.issue()
  for (const path of [`${CLOUD_OPEN_PATH}?code=${value}`, `${CLOUD_OPEN_PATH}?token=${token}`, `${CLOUD_OPEN_PATH}?`]) {
    const response = await request(f.port, { ...form(''), path })
    assert.equal(response.status, 400, path.split('?')[1])
    assert.ok(!response.body.includes(value) && !response.body.includes(token))
  }
  for (const path of [`/?token=${token}`, `/?code=${value}`, `/connect?token=${token}`, `/#${token}`]) {
    assert.equal((await request(f.port, { path })).status, 401, path.slice(0, 9))
  }
  assert.equal((await request(f.port, { headers: { authorization: `Bearer ${token}` } })).status, 401)
  assert.equal((await request(f.port, { ...form(`code=${value}`), headers: { ...form().headers, authorization: `Bearer ${token}` } })).status, 401)
  assert.equal((await f.open(value)).status, 303)
  for (const body of [`token=${token}`, `code=${f.issue()}&token=${token}`, `code=${token}`, `code=${f.issue()}&code=${f.issue()}`, '']) {
    assert.equal((await request(f.port, form(body))).status, 401, body.slice(0, 12))
  }
  assert.equal(f.state.exchanges.filter(entry => entry.body.code === token).length, 0, 'a token is never sent as a code')
  assert.equal(f.sessions.list().length, 1, 'only the one real open made a session')
  assert.equal(f.proxied.length, 0)
})

// Mutant CLOUD_RAIL_ORIGIN_ANY accepts any Origin on the open post.
test('only the rail origin may post an open code, as a form', async t => {
  const f = await fixture(t)
  const value = f.issue()
  const headers = form().headers
  const cases = [
    { headers: { ...headers, origin: 'https://attacker.invalid' }, status: 403 },
    { headers: { ...headers, origin: undefined }, status: 403 },
    { headers: { ...headers, origin: 'null' }, status: 403 },
    { headers: { ...headers, origin: ORIGIN }, status: 403 },
    { headers: { ...headers, host: 'other.invalid' }, status: 403 },
    { headers: { ...headers, 'content-type': 'application/json' }, status: 415 },
    { method: 'GET', status: 405 },
  ]
  for (const { method = 'POST', headers: sent = headers, status } of cases) {
    const clean = Object.fromEntries(Object.entries(sent).filter(([, v]) => v !== undefined))
    const response = await request(f.port, { method, path: CLOUD_OPEN_PATH, headers: clean, body: method === 'POST' ? `code=${value}` : undefined })
    assert.equal(response.status, status, JSON.stringify({ method, origin: sent.origin, type: sent['content-type'] }))
  }
  assert.equal(f.state.exchanges.length, 0)
  assert.equal((await f.open(value)).status, 303, 'refused posts did not use up the code')
  const big = await request(f.port, form(`code=${value}&pad=${'x'.repeat(5000)}`))
  assert.equal(big.status, 413)
})

// Mutant CLOUD_KEY_SLOTS_UNBOUNDED accepts a key set with more than two keys.
test('key rotation across the two slots, and more than two keys fail closed', async t => {
  const f = await fixture(t)
  assert.equal((await f.open(f.issue())).status, 303)
  // Phase one: the new key is published beside the signing key; tokens from either verify.
  f.state.keys = [jwk('a'), jwk('b')]
  assert.equal((await f.open(f.issue({ kid: 'b' }))).status, 401, 'an unknown kid refetches at most once per interval')
  f.state.now += REFRESH_INTERVAL_MS
  assert.equal((await f.open(f.issue({ kid: 'b' }))).status, 303)
  assert.equal((await f.open(f.issue({ kid: 'a' }))).status, 303)
  // Phase two: the signer switched and the old slot is retired; once the cache ends, a is refused.
  f.state.keys = [jwk('b')]
  f.state.now += KEYS_TTL_MS
  assert.equal((await f.open(f.issue({ kid: 'b' }))).status, 303)
  assert.equal((await f.open(f.issue({ kid: 'a' }))).status, 401)
  // Three published keys is not two slots: the whole set is refused, and no cached key is kept.
  f.state.keys = [jwk('a'), jwk('b'), jwk('stranger')]
  f.state.now += KEYS_TTL_MS
  assert.equal((await f.open(f.issue({ kid: 'b' }))).status, 401)
  f.state.now += REFRESH_INTERVAL_MS
  for (const keys of [[], [{ ...jwk('a'), d: 'private' }], [jwk('a'), { ...jwk('b'), kid: 'a' }], [{ kty: 'RSA', kid: 'a' }]]) {
    f.state.keys = keys
    f.state.now += REFRESH_INTERVAL_MS
    assert.equal((await f.open(f.issue({ kid: 'a' }))).status, 401, JSON.stringify(keys).slice(0, 40))
  }
  assert.ok(f.state.keyFetches >= 7)
})

// Mutant CLOUD_SESSION_UNBOUNDED issues the session without the token's expiry.
test('the gate session ends with the workspace token and renewal never extends it', async t => {
  const f = await fixture(t)
  const iat = Math.floor(f.state.now / 1000)
  const opened = await f.open(f.issue({ claims: { exp: iat + 120 } }))
  assert.equal(opened.status, 303)
  assert.match(opened.headers['set-cookie'][0], /Max-Age=120$/)
  let cookie = cookieOf(opened)
  f.state.now += 60_000
  const renewed = await request(f.port, { method: 'POST', path: '/_gate/session/renew', headers: { cookie, origin: ORIGIN } })
  assert.equal(renewed.status, 200)
  assert.match(renewed.headers['set-cookie'][0], /Max-Age=60$/)
  cookie = cookieOf(renewed)
  assert.equal((await request(f.port, { headers: { cookie } })).status, 200)
  f.state.now += 60_000
  assert.equal((await request(f.port, { headers: { cookie } })).status, 401)
  assert.equal(f.sessions.list().length, 0)
  // A session made from a future-dated token still ends five minutes from now at most.
  const ahead = await f.open(f.issue({ claims: { iat: iat + 150, exp: iat + 450 } }))
  assert.equal(ahead.status, 303)
  assert.ok(f.sessions.list()[0].expires_at <= f.state.now + 300_000)
  // Ended sessions do not pile up in memory.
  f.state.now += 300_000
  assert.equal((await f.open(f.issue())).status, 303)
  assert.equal(f.sessions.families.length, 1)
})

// Mutant CLOUD_ROLES_ANY admits members and guests before (f)'s safeguards (Decided 26).
test('Cloud workspaces stay owner-only: members and guests are refused, unknown roles ignored', async t => {
  const f = await fixture(t)
  for (const roles of [['member'], ['guest'], ['member', 'guest'], ['superuser'], []]) {
    assert.equal((await f.open(f.issue({ roles }))).status, 401, roles.join())
  }
  const admin = await f.open(f.issue({ roles: ['admin', 'superuser'] }))
  assert.equal(admin.status, 303)
  const page = await request(f.port, { headers: { cookie: cookieOf(admin) } })
  assert.deepEqual(JSON.parse(page.body).principal.roles, ['admin'])
  // The store refuses a local owner principal in Cloud mode, and a Cloud principal when self-hosted.
  assert.throws(() => f.sessions.issue(ORIGIN, { issuer: 'local:x', subject: 'x', roles: ['owner'], workspace: 'x' }))
  const file = new SessionStore(join(f.dir, 'file-store'))
  assert.throws(() => file.issue(ORIGIN, { issuer: 'https://id.invalid', subject: 'person-1', roles: ['owner'], workspace: 'workspace-a' }))
  assert.throws(() => file.issue(ORIGIN, { issuer: 'local:x', subject: 'x', roles: ['owner'], workspace: 'x' }, { expires: 1 }))
})

test('a person\'s session list and sign-out-everywhere are their own', async t => {
  const f = await fixture(t)
  const first = cookieOf(await f.open(f.issue({ sub: 'person-1' })))
  const second = cookieOf(await f.open(f.issue({ sub: 'person-1' })))
  const other = cookieOf(await f.open(f.issue({ sub: 'person-2' })))
  const listed = await request(f.port, { path: '/_gate/sessions', headers: { cookie: first } })
  assert.equal(JSON.parse(listed.body).sessions.length, 2)
  const out = await request(f.port, { method: 'POST', path: '/_gate/sign-out-everywhere', headers: { cookie: first, origin: ORIGIN } })
  assert.equal(out.status, 200)
  assert.equal((await request(f.port, { headers: { cookie: second } })).status, 401)
  assert.equal((await request(f.port, { headers: { cookie: other } })).status, 200)
  // A new open from a browser that already holds a session replaces it.
  const again = await request(f.port, { ...form(`code=${f.issue({ sub: 'person-2' })}`), headers: { ...form().headers, cookie: other } })
  assert.equal(again.status, 303)
  assert.equal((await request(f.port, { headers: { cookie: other } })).status, 401)
  assert.equal(f.sessions.list().length, 1)
})

test('a failed or malformed exchange issues no session', async t => {
  const f = await fixture(t)
  const replies = [
    token => ({ version: 2, token, expires_in: 300 }),
    token => ({ version: 1, token, expires_in: 301 }),
    token => ({ version: 1, token, expires_in: 0 }),
    () => ({ version: 1, expires_in: 300 }),
    () => ['not', 'an', 'object'],
  ]
  for (const reply of replies) {
    f.state.reply = reply
    assert.equal((await f.open(f.issue())).status, 401)
  }
  f.state.reply = undefined
  f.state.exchangeStatus = 500
  assert.equal((await f.open(f.issue())).status, 401)
  f.state.exchangeStatus = 200
  assert.equal((await f.open('short')).status, 401)
  assert.equal(f.sessions.list().length, 0)
})

test('exchanges in flight are capped; the rest get 429 without using their code', async t => {
  const f = await fixture(t)
  const pending = []
  const held = []
  const original = f.cloud.call
  f.cloud.call = () => new Promise(resolve => held.push(resolve))
  for (let i = 0; i < MAX_EXCHANGES; i++) pending.push(f.open(f.issue()))
  for (let i = 0; held.length < MAX_EXCHANGES && i < 10_000; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(held.length, MAX_EXCHANGES)
  const value = f.issue()
  assert.equal((await f.open(value)).status, 429)
  for (const resolve of held) resolve({})
  assert.deepEqual((await Promise.all(pending)).map(response => response.status), Array(MAX_EXCHANGES).fill(401))
  f.cloud.call = original
  assert.equal((await f.open(value)).status, 303)
})

test('Cloud settings are all or none, HTTPS only, and never echoed', () => {
  assert.equal(cloudConfig({}), undefined)
  assert.equal(cloudConfig(Object.fromEntries(Object.keys(ENV).map(name => [name, ' ']))), undefined)
  assert.throws(() => cloudConfig({ AUTOMAGIK_GATE_CLOUD_WORKSPACE: 'workspace-a' }), error =>
    error instanceof CloudConfigurationError && /AUTOMAGIK_GATE_CLOUD_ISSUER/.test(error.message) && !error.message.includes('workspace-a'))
  assert.throws(() => cloudConfig({ ...ENV, AUTOMAGIK_GATE_CLOUD_REVOCATION_URL: '' }), error =>
    error instanceof CloudConfigurationError &&
      /AUTOMAGIK_GATE_CLOUD_REVOCATION_URL/.test(error.message))
  for (const [name, value] of [['AUTOMAGIK_GATE_CLOUD_KEYS_URL', 'http://cloud.invalid/keys'], ['AUTOMAGIK_GATE_CLOUD_EXCHANGE_URL', 'https://u:p@cloud.invalid/x'],
    ['AUTOMAGIK_GATE_CLOUD_RAIL_ORIGIN', 'https://rail.invalid/path'], ['AUTOMAGIK_GATE_CLOUD_ISSUER', 'https://cloud.invalid/?q=1'],
    ['AUTOMAGIK_GATE_CLOUD_WORKSPACE', 'has space'],
    ['AUTOMAGIK_GATE_CLOUD_KEYS_URL', 'https://cloud.invalid/keys#frag'],
    ['AUTOMAGIK_GATE_CLOUD_REVOCATION_URL', 'http://cloud.invalid/revocations']]) {
    assert.throws(() => cloudConfig({ ...ENV, [name]: value }), CloudConfigurationError, name)
  }
  const config = cloudConfig(ENV)
  assert.equal(config.rail, RAIL)
  assert.equal(config.workspace, 'workspace-a')
  assert.equal(config.revocation.href, ENV.AUTOMAGIK_GATE_CLOUD_REVOCATION_URL)
})

test('the entrypoint refuses Access and Cloud together and a partial Cloud setting, naming only settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'automagik-cloud-entry-'))
  try {
    const base = { PATH: process.env.PATH, AUTOMAGIK_GATE_ENABLED: '1', AUTOMAGIK_GATE_ORIGIN: ORIGIN, AUTOMAGIK_GATE_HOME: dir }
    const both = { ...base, ...ENV, AUTOMAGIK_GATE_ACCESS_TEAM_DOMAIN: 'team.invalid', AUTOMAGIK_GATE_ACCESS_AUD: 'aud', AUTOMAGIK_GATE_ACCESS_EMAILS: 'owner@example.invalid' }
    for (const [env, pattern] of [[both, /Access or Cloud sign-in, not both/], [{ ...base, AUTOMAGIK_GATE_CLOUD_WORKSPACE: 'workspace-a' }, /Missing Cloud settings/]]) {
      assert.throws(() => execFileSync(process.execPath, ['server/gate-entrypoint.mjs'], { env, stdio: 'pipe' }), error => {
        const stderr = error.stderr.toString()
        assert.match(stderr, pattern)
        assert.ok(!stderr.includes('workspace-a') && !stderr.includes('cloud.invalid'))
        return true
      })
    }
    assert.deepEqual(readdirSync(dir), [], 'a refused start writes no gate state')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// Mutant CLOUD_STARTUP_PREFETCH fetches the key set at startup.
test('the configured Cloud entrypoint opens no connection until an open code arrives, and writes no state', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'automagik-cloud-entry-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const marker = join(dir, 'outbound-attempt')
  const guard = join(dir, 'no-outbound.mjs')
  writeFileSync(guard, `import https from 'node:https'; import http from 'node:http'; import { writeFileSync } from 'node:fs';
const denied = () => { writeFileSync(${JSON.stringify(marker)}, 'attempted'); throw new Error('Unexpected outbound'); };
https.get = denied; https.request = denied; http.get = denied; globalThis.fetch = denied;
`)
  const reservation = http.createServer()
  const port = await listen(reservation)
  await new Promise(resolve => reservation.close(resolve))
  const home = join(dir, 'home')
  const child = spawn(process.execPath, ['--import', pathToFileURL(guard).href, 'server/gate-entrypoint.mjs'], {
    env: { PATH: process.env.PATH, TMPDIR: tmpdir(), ...ENV, AUTOMAGIK_GATE_ENABLED: '1', AUTOMAGIK_GATE_ORIGIN: ORIGIN, AUTOMAGIK_GATE_PORT: String(port), AUTOMAGIK_GATE_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Entry startup timeout')), 5000)
      child.stdout.on('data', chunk => { if (chunk.toString().includes('listening on loopback')) { clearTimeout(timer); resolve() } })
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Entry exited ${code}; ${stderr}`)) })
    })
    assert.equal((await request(port)).status, 401)
    assert.equal((await request(port, { path: '/_gate/claim' })).status, 401, 'Cloud mode has no claim route')
    assert.equal(existsSync(marker), false, 'startup and a plain request open no Cloud connection')
    // The first open is the first connection, to the configured exchange only.
    const opened = await request(port, form(`code=${code()}`))
    assert.equal(opened.status, 401)
    assert.equal(existsSync(marker), true)
    assert.ok(!existsSync(join(home, 'sessions.json')) && !existsSync(join(home, 'owner.json')), 'Cloud sessions stay in memory')
    assert.ok(stderr.split('\n').filter(Boolean).every(line => Object.keys(JSON.parse(line)).sort().join() === 'request_id,status'))
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      await exited
    }
  }
})

test('without Cloud settings the open route is an ordinary unauthenticated path', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'automagik-cloud-off-'))
  const sessions = new SessionStore(dir)
  const gate = createGate({ origin: ORIGIN, sessions, credentials: { port: 1, authority: `${DSH_HOST}:1`, cookie: async () => '' }, auditAccess: () => {} })
  const port = await listen(gate)
  t.after(async () => { await gate.closeGate(); rmSync(dir, { recursive: true, force: true }) })
  const response = await request(port, form(`code=${code()}`))
  assert.equal(response.status, 401)
  assert.equal(response.body, JSON.stringify({ error: 'Session required' }))
})

// Mutant CLOUD_REVOKE_ANY drops signature verification on the revocation call.
test('a signed revocation call drops that person\'s sessions and refuses a new open', async t => {
  const f = await fixture(t)
  const removed = cookieOf(await f.open(f.issue({ sub: 'person-1' })))
  const kept = cookieOf(await f.open(f.issue({ sub: 'person-2' })))
  const body = JSON.stringify({ version: 1, event: 'session.revoke', workspace: 'workspace-a',
    subject: 'person-1', reason: 'removed', issued_at: iso(f.state.now) })
  const called = await request(f.port, { method: 'POST', path: REVOKE, body,
    headers: { 'content-type': 'application/json', [SIGN]: detached(body) } })
  assert.equal(called.status, 204)
  assert.equal(called.body, '')
  assert.equal((await request(f.port, { headers: { cookie: removed } })).status, 401)
  assert.equal((await request(f.port, { headers: { cookie: kept } })).status, 200)
  assert.equal(f.sessions.list().length, 1)
  assert.equal((await f.open(f.issue({ sub: 'person-1' }))).status, 401)
  assert.equal(f.sessions.list().length, 1, 'a refused open issues no session')
  // The call is idempotent: a repeat is accepted and changes nothing.
  assert.equal((await request(f.port, { method: 'POST', path: REVOKE, body,
    headers: { 'content-type': 'application/json', [SIGN]: detached(body) } })).status, 204)
  assert.equal(f.sessions.list().length, 1)
})

// Mutant CLOUD_REVOKE_BODY_TRUSTED reads fields before it checks the signature.
test('a revocation call is refused unless it is signed by a published key', async t => {
  const f = await fixture(t)
  const cookie = cookieOf(await f.open(f.issue()))
  const body = JSON.stringify({ version: 1, event: 'session.revoke', workspace: 'workspace-a',
    subject: 'person-1', reason: 'removed', issued_at: iso(f.state.now) })
  const json = { 'content-type': 'application/json' }
  const cases = [
    { headers: { ...json }, status: 401 },
    { headers: { ...json, [SIGN]: '' }, status: 401 },
    { headers: { ...json, [SIGN]: 'not-a-signature' }, status: 401 },
    { headers: { ...json, [SIGN]: detached(body, { kid: 'stranger' }) }, status: 401 },
    { headers: { ...json,
      [SIGN]: detached(body, { key: slots.stranger.privateKey }) }, status: 401 },
    { headers: { ...json, [SIGN]: detached(`${body} `) }, status: 401 },
    { headers: { ...json, [SIGN]: detached(body), authorization: 'Bearer x' }, status: 401 },
    { headers: { ...json, [SIGN]: detached(body), host: 'other.invalid' }, status: 403 },
    { headers: { ...json, [SIGN]: detached(body), 'content-type': 'text/plain' }, status: 415 },
    { method: 'GET', headers: { ...json, [SIGN]: detached(body) }, status: 405 },
  ]
  for (const { method = 'POST', headers, status } of cases) {
    const response = await request(f.port, { method, path: REVOKE,
      body: method === 'POST' ? body : undefined, headers })
    assert.equal(response.status, status, JSON.stringify(headers))
  }
  assert.equal((await request(f.port, { headers: { cookie } })).status, 200)
  assert.equal(f.sessions.list().length, 1)
  assert.ok(f.audit.every(entry => Object.keys(entry).sort().join(',') === 'request_id,status'),
    'a refused call logs no subject, workspace or signature')
})

// Mutant CLOUD_REVOKE_FIELDS_ANY accepts an unknown version, event, workspace or reason.
test('a signed but malformed revocation call changes nothing', async t => {
  const f = await fixture(t)
  const cookie = cookieOf(await f.open(f.issue()))
  const base = { version: 1, event: 'session.revoke', workspace: 'workspace-a',
    subject: 'person-1', reason: 'removed', issued_at: iso(f.state.now) }
  const cases = [
    { version: 2 }, { version: '1' }, { event: 'session.renew' }, { workspace: 'workspace-b' },
    { subject: '' }, { subject: 'x'.repeat(257) }, { reason: 'deleted' },
    { issued_at: 'yesterday' }, { issued_at: 1 },
  ]
  for (const patch of cases) {
    const body = JSON.stringify({ ...base, ...patch })
    const response = await request(f.port, { method: 'POST', path: REVOKE, body,
      headers: { 'content-type': 'application/json', [SIGN]: detached(body) } })
    assert.equal(response.status, 401, JSON.stringify(patch))
  }
  assert.equal((await request(f.port, { headers: { cookie } })).status, 200)
})

// Mutant CLOUD_REVOKE_ROLE_CUT_ALL drops the created <= effective_at bound.
test('role_lowered drops only the sessions that existed at its effective time', async t => {
  const f = await fixture(t)
  const early = cookieOf(await f.open(f.issue({ sub: 'person-1' })))
  f.state.now += 60_000
  const late = cookieOf(await f.open(f.issue({ sub: 'person-1' })))
  const body = JSON.stringify({ version: 1, event: 'session.revoke', workspace: 'workspace-a',
    subject: 'person-1', reason: 'role_lowered', issued_at: iso(f.state.now - 30_000) })
  const called = await request(f.port, { method: 'POST', path: REVOKE, body,
    headers: { 'content-type': 'application/json', [SIGN]: detached(body) } })
  assert.equal(called.status, 204)
  assert.equal((await request(f.port, { headers: { cookie: early } })).status, 401)
  assert.equal((await request(f.port, { headers: { cookie: late } })).status, 200)
  // The lowered person may sign in again with the roles Cloud now mints.
  assert.equal((await f.open(f.issue({ sub: 'person-1', roles: ['admin'] }))).status, 303)
})

// Mutant CLOUD_POLL_NEVER keeps the fallback from running while sessions exist.
test('the poll fallback drops sessions from a signed list', async t => {
  const f = await fixture(t, { pollInterval: 20 })
  const removed = cookieOf(await f.open(f.issue({ sub: 'person-1' })))
  const kept = cookieOf(await f.open(f.issue({ sub: 'person-2' })))
  assert.equal(typeof f.cloud.poll, 'function')
  f.state.revocationList = { version: 1, workspace: 'workspace-a',
    issued_at: iso(f.state.now), expires_at: iso(f.state.now + 300_000),
    revoked: [{ subject: 'person-1', reason: 'removed', effective_at: iso(f.state.now) }] }
  await waitFor(() => f.sessions.list().length === 1)
  assert.equal((await request(f.port, { headers: { cookie: removed } })).status, 401)
  assert.equal((await request(f.port, { headers: { cookie: kept } })).status, 200)
  assert.ok(f.state.listFetches > 0)
})

// Mutant CLOUD_POLL_TRUSTS_ANY applies an expired, unsigned or foreign list.
test('an expired, unsigned or wrong-workspace list changes nothing', async t => {
  const f = await fixture(t, { pollInterval: 20 })
  const cookie = cookieOf(await f.open(f.issue()))
  assert.equal(typeof f.cloud.poll, 'function')
  const valid = { version: 1, workspace: 'workspace-a', issued_at: iso(f.state.now),
    expires_at: iso(f.state.now + 300_000),
    revoked: [{ subject: 'person-1', reason: 'removed', effective_at: iso(f.state.now) }] }
  for (const document of [
    { ...valid, workspace: 'workspace-b' },
    { ...valid, expires_at: iso(f.state.now - 1) },
    { ...valid, version: 2 },
    { ...valid, revoked: 'not-an-array' },
  ]) {
    f.state.revocationList = document
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal((await request(f.port, { headers: { cookie } })).status, 200,
      JSON.stringify(document).slice(0, 40))
  }
  f.state.revocationList = valid
  for (const signature of [null, detached('other')]) {
    f.state.revocationSignature = signature
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal((await request(f.port, { headers: { cookie } })).status, 200)
  }
  f.state.revocationSignature = undefined
  await waitFor(() => f.sessions.list().length === 0)
})

// Mutant CLOUD_REMOVE_FOREVER never lets Cloud lift a removal for a new open.
test('a later signed list is Cloud\'s word on a removal: new opens resume', async t => {
  const f = await fixture(t, { pollInterval: 20 })
  const old = cookieOf(await f.open(f.issue({ sub: 'person-1' })))
  const call = JSON.stringify({ version: 1, event: 'session.revoke', workspace: 'workspace-a',
    subject: 'person-1', reason: 'removed', issued_at: iso(f.state.now) })
  const called = await request(f.port, { method: 'POST', path: REVOKE, body: call,
    headers: { 'content-type': 'application/json', [SIGN]: detached(call) } })
  assert.equal(called.status, 204)
  assert.equal((await f.open(f.issue({ sub: 'person-1' }))).status, 401)
  f.state.now += 1000
  f.state.revocationList = { version: 1, workspace: 'workspace-a',
    issued_at: iso(f.state.now), expires_at: iso(f.state.now + 300_000), revoked: [] }
  assert.equal(typeof f.cloud.poll, 'function')
  await f.cloud.poll()
  assert.equal((await f.open(f.issue({ sub: 'person-1' }))).status, 303)
  assert.equal((await request(f.port, { headers: { cookie: old } })).status, 401,
    'a dropped session is never restored')
})
