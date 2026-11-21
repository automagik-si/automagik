import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { Script } from 'node:vm'
import { CLAIM_MS, CHALLENGE_MS, CLAIM_PENALTY_LIMIT, CLAIM_PENALTY_MS, ClaimConfigurationError, SelfHostedClaim, passkeyOrigin } from '../gate-claim.mjs'
import { controlServer, hostCommand } from '../gate-control.mjs'
import { SessionStore, readOwner } from '../gate-store.mjs'
import { createGate } from '../gate.mjs'
import { DSH_HOST } from '../gate-upstream.mjs'
import { SoftwareAuthenticator } from './fixtures/software-authenticator.mjs'
import { claimPage } from '../gate-claim-ui.mjs'

const ORIGIN = 'http://localhost:4381'
const listen = async server => { server.listen(0, DSH_HOST); await once(server, 'listening'); return server.address().port }

// Mutant UI_LITERAL_NEWLINE emits invalid JavaScript inside the rendered HTML.
test('every generated sign-in page contains browser-parseable JavaScript', () => {
  for (const mode of ['claim', 'sign-in', 'recovery', 'settings']) {
    const html = claimPage(mode, 'fixture-nonce')
    const script = html.match(/<script nonce="fixture-nonce">([\s\S]*?)<\/script>/)?.[1]
    assert.ok(script)
    assert.doesNotThrow(() => new Script(script))
  }
})
async function fixture(t, { origin = ORIGIN, interactive = false, published = DSH_HOST, claimMode = 'local', clearOnSignIn = false } = {}) {
  let now = Date.now(), closed = false
  const dir = mkdtempSync(join(tmpdir(), 'automagik-claim-'))
  const sessions = new SessionStore(dir, { now: () => now })
  const logs = [], shown = [], seen = []
  const claim = new SelfHostedClaim({ dir, origin, sessions, claimMode, clearOnSignIn, now: () => now, audit: record => logs.push(record) })
  const control = await controlServer(claim)
  await claim.start({ interactive, show: value => shown.push(value) })
  const upstream = http.createServer((req, res) => { seen.push(req.url); res.end('workspace') })
  const upstreamPort = await listen(upstream)
  const gate = createGate({ origin, sessions, credentials: { authority: `${DSH_HOST}:${upstreamPort}`, port: upstreamPort, cookie: async () => 'dsh=server-held' }, selfHosted: claim })
  const port = await listen(gate)
  claim.bindingChange = (claimed, drop) => gate.rebind(port, () => claim.claimed ? published : DSH_HOST, drop)
  const bootstrap = claimMode === 'local' ? createGate({ origin, sessions, selfHosted: claim, bootstrap: true }) : undefined
  const bootstrapPort = bootstrap ? await listen(bootstrap) : undefined
  const browser = (target = 'auto') => {
    let preauth = ''
    return async (path, options = {}) => {
      const claimPath = ['/_gate/claim', '/_gate/claim/options', '/_gate/claim/verify'].includes(path)
      const selected = typeof target === 'number' ? target : target === 'bootstrap' || (target === 'auto' && claimMode === 'local' && claimPath) ? bootstrapPort : port
      const result = await requestAt(selected, origin, path, { ...options, cookie: [options.cookie, preauth].filter(Boolean).join('; ') })
      const fresh = result.headers['set-cookie']?.find(value => value.startsWith('__Host-automagik-preauth='))
      if (fresh) preauth = fresh.split(';')[0]
      return result
    }
  }
  const request = browser()
  const code = () => interactive ? shown.at(-1) : readFileSync(join(dir, 'claim-code'), 'utf8').trim()
  const close = async () => { if (closed) return; closed = true; await gate.closeGate(); if (bootstrap) await bootstrap.closeGate(); await new Promise(resolve => control.close(resolve)); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)) }
  t.after(async () => { await close(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, sessions, claim, gate, bootstrap, port, bootstrapPort, browser, request, logs, shown, seen, code, origin, advance: ms => { now += ms }, close }
}
function requestAt(port, origin, path, { data, cookie, headers = {}, method = data === undefined ? 'GET' : 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: DSH_HOST, port, path, method, headers: { host: new URL(origin).host,
      connection: 'close', ...(data === undefined ? {} : { origin, 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', value => { text += value })
      res.on('end', () => { let body; try { body = JSON.parse(text) } catch { body = text } resolve({ status: res.statusCode, headers: res.headers, text, body }) })
    })
    req.on('error', reject); req.setTimeout(8000, () => req.destroy(new Error('Test request timeout')))
    req.end(data === undefined ? undefined : JSON.stringify(data))
  })
}
const cookieOf = response => response.headers['set-cookie']?.find(value => value.startsWith('__Host-automagik-session='))?.split(';')[0]
async function enroll(f, device = new SoftwareAuthenticator()) {
  const code = f.code()
  const options = await f.request('/_gate/claim/options', { data: { code } })
  assert.equal(options.status, 200)
  const credential = device.register(options.body.options, f.origin)
  const completed = await f.request('/_gate/claim/verify', { data: { id: options.body.id, code, credential } })
  assert.equal(completed.status, 200)
  return { device, completed, cookie: cookieOf(completed), recovery: completed.body.recoveryCodes, code }
}
async function signIn(f, device) {
  const options = await f.request('/_gate/signin/options', { data: {} })
  assert.equal(options.status, 200)
  const completed = await f.request('/_gate/signin/verify', { data: { id: options.body.id, credential: device.authenticate(options.body.options, f.origin) } })
  assert.equal(completed.status, 200)
  return cookieOf(completed)
}

// Mutants CLAIM_CODE_RESPONSE and CLAIM_NO_EXPIRY expose a secret or allow expired claims.
test('claim code is 128-bit, private, hashed, absent from responses/logs and replaced only by the host', async t => {
  const f = await fixture(t)
  const code = f.code()
  assert.match(code, /^[a-f0-9]{32}$/)
  assert.equal(statSync(join(f.dir, 'claim-code')).mode & 0o777, 0o600)
  const state = readFileSync(join(f.dir, 'claim-state.json'), 'utf8')
  assert.ok(!state.includes(code))
  for (const path of ['/', '/_gate/sign-in', '/_gate/settings', '/_gate/passkeys', '/_gate/claim-code', '/claim-code']) {
    const r = await f.request(path); assert.equal(r.status, 401); assert.ok(!r.text.includes(code))
  }
  const page = await f.request('/_gate/claim')
  assert.equal(page.status, 200); assert.ok(!page.text.includes(code))
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/)
  f.advance(CLAIM_MS)
  assert.equal((await f.request('/_gate/claim/options', { data: { code } })).status, 401)
  assert.equal(f.code(), code, 'a network request must not replace an expired code')
  await hostCommand(f.dir, 'renew-claim')
  assert.notEqual(f.code(), code)
  assert.equal((await f.request('/_gate/claim/options', { data: { code } })).status, 401)
  assert.ok(!JSON.stringify(f.logs).includes(code))
})

test('interactive host shows the code only through its console callback', async t => {
  const f = await fixture(t, { interactive: true })
  assert.match(f.code(), /^[a-f0-9]{32}$/)
  assert.equal(existsSync(join(f.dir, 'claim-code')), false)
  assert.equal(f.shown.length, 1)
  assert.ok(!readFileSync(join(f.dir, 'claim-state.json'), 'utf8').includes(f.code()))
})

// Mutants CLAIM_BAD_EXPIRY and CLAIM_EXPIRE_DURING_VERIFY permit invalid or late commits.
test('malformed claim expiry fails closed and an expiry during asynchronous work prevents the owner commit', async t => {
  const f = await fixture(t), code = f.code(), path = join(f.dir, 'claim-state.json')
  const state = JSON.parse(readFileSync(path, 'utf8'))
  for (const expires of [undefined, null, 'later', Number.MAX_SAFE_INTEGER + 1]) {
    writeFileSync(path, JSON.stringify({ ...state, expires }))
    assert.throws(() => f.claim.checkCode(code))
  }
  writeFileSync(path, JSON.stringify(state))
  const o = await f.request('/_gate/claim/options', { data: { code } }), device = new SoftwareAuthenticator()
  const original = f.claim.recoveryCodes.bind(f.claim)
  f.claim.recoveryCodes = async () => { const result = await original(); f.advance(CLAIM_MS); return result }
  assert.equal((await f.request('/_gate/claim/verify', { data: { code, id: o.body.id, credential: device.register(o.body.options, f.origin) } })).status, 401)
  assert.equal(readOwner(f.dir), undefined)
  assert.equal(f.sessions.list().length, 0)
})

// Mutant CONTROL_KEEP_STALE_SOCKET prevents restart after a killed gate.
test('host control recovers a crash socket but refuses to replace a live controller or a file', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'automagik-control-crash-'))
  const moduleURL = new URL('../gate-control.mjs', import.meta.url).href
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {controlServer} from ${JSON.stringify(moduleURL)};await controlServer({dir:process.argv[1]});console.log('ready')`, dir], { stdio: ['ignore', 'pipe', 'pipe'] })
  let control
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'exit'); child.kill('SIGKILL'); await closed }
    if (control) await new Promise(resolve => control.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  })
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw Error('Control fixture exited before ready') })])
  const closed = once(child, 'exit'); child.kill('SIGKILL'); await closed
  assert.equal(statSync(join(dir, 'control.sock')).isSocket(), true)
  control = await controlServer({ dir, renewCode: async () => ({ renewed: true }) })
  await assert.rejects(controlServer({ dir }), /already running/)
  assert.deepEqual(await hostCommand(dir, 'renew-claim'), { renewed: true })
  await new Promise(resolve => control.close(resolve)); control = undefined
  writeFileSync(join(dir, 'control.sock'), 'preserve', { mode: 0o600 })
  await assert.rejects(controlServer({ dir }), /not a socket/)
  assert.equal(readFileSync(join(dir, 'control.sock'), 'utf8'), 'preserve')
})

// Mutant CLAIM_HASH_STRING_EQUALITY bypasses the fixed-length native comparison.
test('claim hashes are compared with timingSafeEqual for both good and bad secrets', async t => {
  const f = await fixture(t)
  const real = crypto.timingSafeEqual, calls = []
  t.mock.method(crypto, 'timingSafeEqual', (left, right) => { calls.push([left.length, right.length]); return real(left, right) })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  f.claim.checkCode(f.code())
  assert.throws(() => f.claim.checkCode('wrong'))
  assert.deepEqual(calls, [[32, 32], [32, 32]])
})

// Mutant CLAIM_REPLACE_OWNER overwrites the first claim and permits two successful claimers.
test('two concurrent passkey claims leave exactly one owner and one winning session', async t => {
  const f = await fixture(t), code = f.code()
  const devices = [new SoftwareAuthenticator(), new SoftwareAuthenticator()]
  const browsers = devices.map(() => f.browser())
  const options = await Promise.all(browsers.map(request => request('/_gate/claim/options', { data: { code } })))
  const results = await Promise.all(options.map((o, i) => browsers[i]('/_gate/claim/verify', { data: { code, id: o.body.id, credential: devices[i].register(o.body.options, f.origin) } })))
  assert.deepEqual(results.map(r => r.status).sort(), [200, 401])
  const owner = readOwner(f.dir)
  assert.equal(owner.auth.credentials.length, 1)
  assert.equal(f.sessions.list().length, 1)
  assert.equal(existsSync(join(f.dir, 'claim-code')), false)
  assert.equal(existsSync(join(f.dir, 'claim-state.json')), false)
  assert.ok(results.find(r => r.status === 200).body.offerSecondPasskey)
  assert.equal((await f.request('/_gate/claim/options', { data: { code } })).status, 401)
  assert.ok(!results.some(r => r.text.includes(code)))
})

// Mutants PASSKEY_WRONG_ORIGIN and PASSKEY_NO_UV weaken the real WebAuthn verification.
test('real registration and sign-in reject wrong origin/port, RP, challenge, missing UV and replay', async t => {
  const f = await fixture(t)
  for (const extra of [{ origin: 'http://localhost:4382' }, { rpID: 'other.invalid' }, { challenge: 'wrong' }, { uv: false }, { crossOrigin: true }]) {
    f.advance(60_001)
    const o = await f.request('/_gate/claim/options', { data: { code: f.code() } })
    const device = new SoftwareAuthenticator()
    const response = device.register(o.body.options, extra.origin ?? f.origin, extra)
    assert.notEqual((await f.request('/_gate/claim/verify', { data: { code: f.code(), id: o.body.id, credential: response } })).status, 200)
    assert.equal(readOwner(f.dir), undefined)
  }
  f.advance(60_001)
  const enrolled = await enroll(f)
  assert.equal((await f.request('/', { cookie: enrolled.cookie })).status, 200)
  assert.equal((await f.request('/?token=launch-secret')).status, 401)
  assert.equal((await f.request('/connect?token=launch-secret')).status, 401)
  for (const extra of [{ origin: 'http://localhost:4382' }, { rpID: 'other.invalid' }, { challenge: 'wrong' }, { uv: false }, { corrupt: true }, { crossOrigin: true }]) {
    const o = await f.request('/_gate/signin/options', { data: {} })
    const credential = enrolled.device.authenticate(o.body.options, extra.origin ?? f.origin, extra)
    const data = { id: o.body.id, credential }
    assert.notEqual((await f.request('/_gate/signin/verify', { data })).status, 200)
    assert.equal((await f.request('/_gate/signin/verify', { data })).status, 401)
    f.advance(60_001)
  }
  assert.ok(await signIn(f, enrolled.device))
})

test('HTTP origin and IP checks explain the refusal and all reserved aliases fail before claims', async t => {
  const f = await fixture(t)
  for (const claimMode of ['', 'LOCAL', 'other']) assert.throws(() => new SelfHostedClaim({ dir: f.dir, origin: f.origin, sessions: f.sessions, claimMode }), /AUTOMAGIK_GATE_CLAIM/)
  for (const headers of [{ host: 'localhost:4382' }, { origin: 'http://localhost:4382' }, { 'x-forwarded-host': 'localhost:4381', host: 'other.invalid' }]) {
    assert.equal((await f.request('/_gate/claim/options', { data: { code: f.code() }, headers })).status, 403)
  }
  const ip = await f.request('/_gate/claim', { headers: { host: DSH_HOST } })
  assert.equal(ip.status, 400); assert.match(ip.body.error, /IP origins.*localhost/)
  assert.throws(() => passkeyOrigin(`https://${DSH_HOST}`), /IP origins/)
  assert.throws(() => passkeyOrigin(`http://${DSH_HOST}`), /IP origins/)
  assert.equal(passkeyOrigin('https://instance.invalid:8443').hostname, 'instance.invalid')
  for (const path of ['/x/..//_gate/claim', '/_gate/%63laim', '/%5fgate/claim/options', '/_gate/./recovery/options']) {
    assert.equal((await f.request(path, { data: { code: f.code() } })).status, 400)
    assert.equal((await f.browser('bootstrap')(path, { data: { code: f.code() } })).status, 400)
  }
  assert.equal(readOwner(f.dir), undefined)
})

// Mutant PASSKEY_SKIP_REVOKE leaves pre-change families valid.
test('offer second passkey; adding/removing passkeys and regenerating recovery codes revoke every session', async t => {
  const f = await fixture(t), enrolled = await enroll(f)
  assert.equal(enrolled.completed.body.offerSecondPasskey, true)
  const page = await f.request('/_gate/settings', { cookie: enrolled.cookie })
  assert.match(page.text, /Add a second passkey/)
  const info = await f.request('/_gate/passkeys', { cookie: enrolled.cookie })
  assert.match(info.body.bot_trust_notice, /not from its own Bots/)
  const second = new SoftwareAuthenticator()
  const o = await f.request('/_gate/passkeys/options', { data: {}, cookie: enrolled.cookie })
  const added = await f.request('/_gate/passkeys/verify', { data: { id: o.body.id, credential: second.register(o.body.options, f.origin) }, cookie: enrolled.cookie })
  assert.equal(added.status, 200); assert.equal(f.sessions.list().length, 0)
  assert.equal((await f.request('/', { cookie: enrolled.cookie })).status, 401)
  let cookie = await signIn(f, second)
  assert.equal((await f.request('/_gate/passkeys/remove', { data: { id: enrolled.device.id }, cookie })).status, 200)
  assert.equal(f.sessions.list().length, 0)
  cookie = await signIn(f, second)
  const replaced = await f.request('/_gate/recovery/codes', { data: {}, cookie })
  assert.equal(replaced.status, 200); assert.equal(replaced.body.recoveryCodes.length, 8)
  assert.equal(f.sessions.list().length, 0)
  const hashes = readOwner(f.dir).auth.recovery
  const derive = promisify(crypto.scrypt)
  for (let i = 0; i < hashes.length; i++) {
    const value = replaced.body.recoveryCodes[i].replaceAll('-', '')
    assert.equal((await derive(value, hashes[i].salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })).toString('hex'), hashes[i].hash)
    assert.ok(!JSON.stringify(hashes).includes(value))
  }
})

// Mutant RECOVERY_REUSE does not remove the used slow hash.
test('recovery codes work once, revoke sessions immediately, and only authorize passkey registration', async t => {
  const f = await fixture(t), enrolled = await enroll(f)
  const o = await f.request('/_gate/recovery/options', { data: { code: enrolled.recovery[0] } })
  assert.equal(o.status, 200); assert.equal(f.sessions.list().length, 0)
  assert.equal((await f.request('/', { cookie: enrolled.cookie })).status, 401)
  assert.equal((await f.request('/_gate/recovery/options', { data: { code: enrolled.recovery[0] } })).status, 401)
  assert.equal((await f.request('/')).status, 401)
  const newDevice = new SoftwareAuthenticator()
  const done = await f.request('/_gate/recovery/verify', { data: { id: o.body.id, credential: newDevice.register(o.body.options, f.origin) } })
  assert.equal(done.status, 200); assert.equal(done.headers['set-cookie'], undefined)
  assert.equal(f.sessions.list().length, 0)
  assert.ok(await signIn(f, newDevice))
})

// Mutant CLAIM_NO_RATE_LIMIT bypasses throttling for claim and recovery secrets.
test('claim and recovery routes are rate limited and expired challenges cannot be replayed', async t => {
  const f = await fixture(t)
  for (let i = 0; i < 5; i++) assert.equal((await f.request('/_gate/claim/options', { data: { code: 'wrong' } })).status, 401)
  assert.equal((await f.request('/_gate/claim/options', { data: { code: f.code() } })).status, 429)
  f.advance(60_001)
  const o = await f.request('/_gate/claim/options', { data: { code: f.code() } })
  f.advance(CHALLENGE_MS)
  const device = new SoftwareAuthenticator()
  assert.equal((await f.request('/_gate/claim/verify', { data: { id: o.body.id, code: f.code(), credential: device.register(o.body.options, f.origin) } })).status, 401)
  const enrolled = await enroll(f)
  for (let i = 0; i < 5; i++) assert.equal((await f.request('/_gate/recovery/options', { data: { code: 'wrong' } })).status, 401)
  assert.equal((await f.request('/_gate/recovery/options', { data: { code: enrolled.recovery[0] } })).status, 429)
})

// Mutant RESET_KEEP_PUBLIC_BIND fails the host-reset listener boundary.
test('host reset is a private socket operation, revokes all keys/sessions and returns the actual listener to loopback', async t => {
  const f = await fixture(t, { published: '0.0.0.0' })
  assert.equal(f.gate.address().address, DSH_HOST)
  assert.equal(statSync(join(f.dir, 'control.sock')).mode & 0o777, 0o600)
  const enrolled = await enroll(f)
  for (let i = 0; i < 100 && f.gate.address()?.address !== '0.0.0.0'; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(f.gate.address()?.address, '0.0.0.0')
  assert.equal((await f.request('/_gate/reset', { data: {}, cookie: enrolled.cookie })).status, 404)
  const before = readOwner(f.dir)
  await hostCommand(f.dir, 'reset')
  assert.equal(f.gate.address().address, DSH_HOST)
  const after = readOwner(f.dir)
  assert.equal(after.instance_id, before.instance_id); assert.equal(after.local_id, before.local_id)
  assert.equal(after.auth.credentials.length, 0); assert.equal(after.auth.recovery.length, 0)
  assert.equal(f.sessions.list().length, 0)
  assert.equal((await f.request('/', { cookie: enrolled.cookie })).status, 401)
  assert.equal((await f.request('/_gate/claim')).status, 200)
  assert.match(f.code(), /^[a-f0-9]{32}$/)
})

test('newer or malformed owner authentication state fails closed without making a new claim', async t => {
  const f = await fixture(t), enrolled = await enroll(f)
  await f.close()
  const owner = readOwner(f.dir); owner.auth.version = 2
  const data = JSON.stringify(owner)
  writeFileSync(join(f.dir, 'owner.json'), data)
  assert.throws(() => new SelfHostedClaim({ dir: f.dir, origin: f.origin, sessions: f.sessions }), ClaimConfigurationError)
  assert.equal(readFileSync(join(f.dir, 'owner.json'), 'utf8'), data)
  assert.equal(existsSync(join(f.dir, 'claim-code')), false)
  assert.ok(enrolled.recovery.length)
})

// Mutant RESET_WRITE_BEFORE_REBIND leaves an unclaimed public listener on a disk error.
test('reset closes the public listener before a failed claim-code write', async t => {
  const f = await fixture(t, { published: '0.0.0.0' })
  await enroll(f)
  for (let i = 0; i < 100 && f.gate.address()?.address !== '0.0.0.0'; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(f.gate.address()?.address, '0.0.0.0')
  f.claim.newCode = () => { throw new Error('Simulated disk failure') }
  await assert.rejects(hostCommand(f.dir, 'reset'), /Host operation refused/)
  assert.equal(f.gate.address()?.address, DSH_HOST)
  assert.equal(f.claim.claimed, false)
  assert.equal(f.sessions.list().length, 0)
})

test('a changed origin requires recovery to pin the new RP/origin; it never reopens the first claim', async t => {
  const f = await fixture(t), enrolled = await enroll(f)
  await f.close()
  const owner = readOwner(f.dir), origin = 'https://instance.invalid:8443'
  const replacement = new SelfHostedClaim({ dir: f.dir, origin, sessions: f.sessions, audit: () => {} })
  await replacement.start()
  assert.equal(replacement.claimable, false); assert.equal(replacement.claimed, false)
  assert.equal(existsSync(join(f.dir, 'claim-code')), false)
  assert.throws(() => replacement.newCode())
  const record = { id: 'fixture-browser', expires: Date.now() + CHALLENGE_MS }, browser = { start: () => record, existing: () => record }
  const o = await replacement.action('recovery/options', { code: enrolled.recovery[0] }, undefined, browser)
  const device = new SoftwareAuthenticator()
  await replacement.action('recovery/verify', { id: o.id, credential: device.register(o.options, origin) }, undefined, browser)
  assert.equal(replacement.claimed, true)
  const changed = readOwner(f.dir)
  assert.equal(changed.instance_id, owner.instance_id)
  assert.equal(changed.auth.origin, origin); assert.equal(changed.auth.rpID, 'instance.invalid')
  assert.equal(changed.auth.credentials.length, 1)
})

async function entry(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'automagik-claim-entry-'))
  const reserve = http.createServer(), port = await listen(reserve)
  const bootstrapReserve = http.createServer(), bootstrapPort = await listen(bootstrapReserve)
  await new Promise(resolve => reserve.close(resolve))
  await new Promise(resolve => bootstrapReserve.close(resolve))
  const child = spawn(process.execPath, ['server/gate-entrypoint.mjs'], {
    env: { PATH: process.env.PATH, TMPDIR: tmpdir(), AUTOMAGIK_GATE_ENABLED: '1', AUTOMAGIK_GATE_IMAGE: '1',
      AUTOMAGIK_GATE_HOME: dir, AUTOMAGIK_GATE_ORIGIN: ORIGIN, AUTOMAGIK_GATE_PORT: String(port), AUTOMAGIK_GATE_BOOTSTRAP_PORT: String(bootstrapPort), ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const startup = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Gate entry startup timed out')), 8000)
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('listening on loopback')) { clearTimeout(timer); resolve() } })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Gate entry exited ${code}: ${stderr}`)) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
  })
  t.after(async () => { if (child.exitCode === null) { const closed = once(child, 'exit'); child.kill('SIGTERM'); await closed } rmSync(dir, { recursive: true, force: true }) })
  await startup
  const get = (path, bootstrap = false) => requestAt(bootstrap ? bootstrapPort : port, ORIGIN, path)
  return { dir, get, port, bootstrapPort, output: () => ({ stdout, stderr }) }
}

// Mutant IMAGE_CLAIM_STDOUT prints the generated claim secret in the image's application log.
test('the real image-mode entry writes a 0600 code file, never stdout/stderr or HTTP', async t => {
  const f = await entry(t)
  const secret = readFileSync(join(f.dir, 'claim-code'), 'utf8').trim()
  assert.equal(statSync(join(f.dir, 'claim-code')).mode & 0o777, 0o600)
  assert.match(secret, /^[a-f0-9]{32}$/)
  assert.equal((await f.get('/_gate/claim')).status, 404)
  const claim = await f.get('/_gate/claim', true)
  assert.equal(claim.status, 200)
  assert.ok(!claim.text.includes(secret))
  const ordinary = await f.get('/')
  assert.equal(ordinary.status, 401)
  assert.ok(!JSON.stringify(f.output()).includes(secret), 'image code must never reach application stdout or stderr')
})

test('Access mode never opens claim pages, writes claim secrets or starts host-reset control', async t => {
  const f = await entry(t, { AUTOMAGIK_GATE_ACCESS_TEAM_DOMAIN: 'team.invalid', AUTOMAGIK_GATE_ACCESS_AUD: '{audience}', AUTOMAGIK_GATE_ACCESS_EMAILS: 'owner@example.invalid' })
  assert.equal((await f.get('/_gate/claim')).status, 401)
  assert.equal(existsSync(join(f.dir, 'claim-code')), false)
  assert.equal(existsSync(join(f.dir, 'claim-state.json')), false)
  assert.equal(existsSync(join(f.dir, 'control.sock')), false)
})

test('remote entry configuration exposes claims only on main and opens no bootstrap listener', async t => {
  const f = await entry(t, { AUTOMAGIK_GATE_CLAIM: 'remote' })
  assert.equal((await f.get('/_gate/claim')).status, 200)
  await assert.rejects(f.get('/_gate/claim', true), { code: 'ECONNREFUSED' })
})

test('self-hosted ceremonies open no external connection and expired sign-in challenges fail', async t => {
  let fetches = 0
  t.mock.method(globalThis, 'fetch', () => { fetches++; throw new Error('Unexpected external connection') })
  const f = await fixture(t), enrolled = await enroll(f)
  const o = await f.request('/_gate/signin/options', { data: {} })
  f.advance(CHALLENGE_MS)
  assert.equal((await f.request('/_gate/signin/verify', { data: { id: o.body.id, credential: enrolled.device.authenticate(o.body.options, f.origin) } })).status, 401)
  assert.equal(fetches, 0)
})

// Mutants LOCAL_MAIN_CLAIM and REMOTE_CLAIM_BUCKET break the connector boundary or owner admission.
for (const claimMode of ['local', 'remote']) test(`same-namespace forwarder respects ${claimMode} claim mode before and after host reset`, async t => {
  const f = await fixture(t, { claimMode, published: '0.0.0.0' })
  const proxy = http.createServer((req, res) => {
    const hop = http.request({ hostname: DSH_HOST, port: f.port, path: req.url, method: req.method, headers: req.headers }, upstream => {
      res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res)
    })
    hop.on('error', () => { res.writeHead(502); res.end() }); req.pipe(hop)
  })
  const proxyPort = await listen(proxy)
  t.after(async () => { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)) })
  const visitor = f.browser(proxyPort)
  for (const phase of ['before reset', 'after reset']) {
    const code = f.code(), page = await visitor('/_gate/claim')
    assert.equal(page.status, claimMode === 'local' ? 404 : 200, phase)
    if (claimMode === 'local') {
      const flood = await Promise.all(Array.from({ length: 12 }, () => visitor('/_gate/claim/options', { data: { code: 'wrong' } })))
      assert.ok(flood.every(r => r.status === 404))
      assert.equal((await visitor('/_gate/claim/options', { data: { code } })).status, 404)
      const options = await f.request('/_gate/claim/options', { data: { code } }), device = new SoftwareAuthenticator()
      assert.equal(options.status, 200, 'main-port traffic must not drain the host claim bucket')
      const credential = device.register(options.body.options, f.origin)
      const preauth = options.headers['set-cookie'].find(c => c.startsWith('__Host-automagik-preauth=')).split(';')[0]
      const blocked = await visitor('/_gate/claim/verify', { data: { code, id: options.body.id, credential }, cookie: preauth })
      assert.equal(blocked.status, 404); assert.equal(readOwner(f.dir)?.auth?.status === 'claimed', false)
      assert.equal((await f.request('/_gate/claim/verify', { data: { code, id: options.body.id, credential } })).status, 200)
      assert.equal((await f.browser('bootstrap')('/_gate/reset', { data: {} })).status, 401)
    } else {
      const started = Date.now()
      const flood = Promise.all(Array.from({ length: 12 }, () => visitor('/_gate/claim/options', { data: { code: 'wrong' } })))
      const options = await visitor('/_gate/claim/options', { data: { code } })
      assert.equal(options.status, 200, 'wrong-code requests must not lock out the owner')
      const failed = await flood
      assert.ok(failed.every(r => r.status === 401))
      assert.ok(Date.now() - started >= 200, 'wrong attempts must incur a per-attempt delay')
      const device = new SoftwareAuthenticator()
      assert.equal((await visitor('/_gate/claim/verify', { data: { code, id: options.body.id, credential: device.register(options.body.options, f.origin) } })).status, 200)
      assert.ok(f.logs.some(record => record.claim_failures >= 12))
      assert.ok(!JSON.stringify(f.logs).includes(code))
    }
    assert.equal((await visitor('/_gate/reset', { data: {} })).status, 401)
    await hostCommand(f.dir, 'reset')
    assert.equal(f.gate.address()?.address, DSH_HOST)
    assert.equal(f.sessions.list().length, 0)
    assert.equal(f.claim.claimMode, claimMode)
    f.advance(60_001)
  }
})

// Mutant CLAIM_PREAUTH_TRANSFER removes browser binding from a first-claim ceremony.
test('claim verification requires the initiating browser preauth cookie with secure attributes', async t => {
  const f = await fixture(t), a = f.browser(), b = f.browser(), code = f.code(), device = new SoftwareAuthenticator()
  const o = await a('/_gate/claim/options', { data: { code } })
  const set = o.headers['set-cookie'].find(c => c.startsWith('__Host-automagik-preauth='))
  assert.match(set, /HttpOnly/); assert.match(set, /Secure/); assert.match(set, /Path=\//)
  assert.match(set, /SameSite=(Strict|Lax)/); assert.match(set, /Max-Age=300/); assert.ok(!/Domain=/i.test(set))
  assert.ok(!o.text.includes(set.split(';')[0].split('=')[1]))
  await b('/_gate/claim/options', { data: { code } })
  const data = { code, id: o.body.id, credential: device.register(o.body.options, f.origin) }
  const other = await b('/_gate/claim/verify', { data })
  assert.equal(other.status, 401); assert.equal(cookieOf(other), undefined); assert.equal(readOwner(f.dir), undefined)
  assert.equal((await requestAt(f.bootstrapPort, f.origin, '/_gate/claim/verify', { data })).status, 401)
  f.advance(60_001)
  assert.equal((await a('/_gate/claim/verify', { data })).status, 200)
  assert.notEqual((await a('/_gate/claim/verify', { data })).status, 200)
})

// Mutant SIGNIN_PREAUTH_TRANSFER permits a second browser to turn another ceremony into its cookie.
test('sign-in verification rejects another browser, missing or duplicate preauth and expired preauth', async t => {
  const f = await fixture(t), enrolled = await enroll(f), a = f.browser(), b = f.browser()
  const o = await a('/_gate/signin/options', { data: {} })
  await b('/_gate/signin/options', { data: {} })
  const data = { id: o.body.id, credential: enrolled.device.authenticate(o.body.options, f.origin) }
  const stolen = await b('/_gate/signin/verify', { data })
  assert.equal(stolen.status, 401); assert.equal(cookieOf(stolen), undefined)
  for (const cookie of [undefined, '__Host-automagik-preauth=invalid', '__Host-automagik-preauth=bad; __Host-automagik-preauth=other']) {
    assert.equal((await requestAt(f.port, f.origin, '/_gate/signin/verify', { data, cookie })).status, 401)
  }
  const original = await a('/_gate/signin/verify', { data })
  assert.equal(original.status, 200); assert.ok(cookieOf(original))
  assert.equal((await a('/_gate/signin/verify', { data })).status, 401)
  f.advance(CHALLENGE_MS - 1000)
  const expired = await a('/_gate/signin/options', { data: {} })
  f.advance(1000) // The new challenge is live; the reused browser session itself has expired.
  const denied = await a('/_gate/signin/verify', { data: { id: expired.body.id, credential: enrolled.device.authenticate(expired.body.options, f.origin) } })
  assert.equal(denied.status, 401); assert.equal(cookieOf(denied), undefined)
})

// Mutant RECOVERY_PREAUTH_TRANSFER allows another browser to install a recovery passkey.
test('recovery verification is bound to its initiating browser and remains single use', async t => {
  const f = await fixture(t), enrolled = await enroll(f), a = f.browser(), b = f.browser()
  const o = await a('/_gate/recovery/options', { data: { code: enrolled.recovery[0] } }), device = new SoftwareAuthenticator()
  await b('/_gate/signin/options', { data: {} })
  const data = { id: o.body.id, credential: device.register(o.body.options, f.origin) }
  const before = readFileSync(join(f.dir, 'owner.json'), 'utf8')
  const other = await b('/_gate/recovery/verify', { data })
  assert.equal(other.status, 401); assert.equal(cookieOf(other), undefined)
  assert.equal(readFileSync(join(f.dir, 'owner.json'), 'utf8'), before)
  assert.equal((await requestAt(f.port, f.origin, '/_gate/recovery/verify', { data })).status, 401)
  const completed = await a('/_gate/recovery/verify', { data })
  assert.equal(completed.status, 200); assert.equal(cookieOf(completed), undefined)
  assert.equal(readOwner(f.dir).auth.credentials.length, 2)
  assert.equal((await a('/_gate/recovery/verify', { data })).status, 401)
})

function holdPenaltyTimers(t) {
  const nativeSet = globalThis.setTimeout, nativeClear = globalThis.clearTimeout, live = new Map()
  let total = 0, peak = 0
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    if (ms !== CLAIM_PENALTY_MS) return nativeSet(callback, ms, ...args)
    const timer = { unref() { return this } }
    live.set(timer, () => callback(...args)); total++; peak = Math.max(peak, live.size)
    return timer
  })
  t.mock.method(globalThis, 'clearTimeout', timer => { if (!live.delete(timer)) nativeClear(timer) })
  const flush = () => { for (const callback of [...live.values()]) callback() }
  t.after(flush)
  const until = async (condition, message) => {
    for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => nativeSet(resolve, 10))
    assert.ok(condition(), message)
  }
  return { live, flush, until, total: () => total, peak: () => peak }
}

// Mutants REMOTE_PENALTIES_UNBOUNDED and REMOTE_PENALTIES_BLOCK_OWNER remove the cap or apply it before checking a correct code.
test('remote flood retains only 64 penalty timers, rejects overflow immediately and admits a correct claim while saturated', async t => {
  const f = await fixture(t, { claimMode: 'remote' }), held = holdPenaltyTimers(t)
  assert.equal(CLAIM_PENALTY_LIMIT, 64)
  const statuses = []
  const flood = Array.from({ length: 256 }, (_, i) => f.request(i % 2 ? '/_gate/claim/options' : '/_gate/claim/verify', { data: { code: 'wrong' } })
    .then(r => { statuses.push(r.status); return r }, () => { statuses.push(0); return { status: 0 } }))
  t.after(async () => { held.flush(); await Promise.all(flood) })
  await held.until(() => held.live.size > 64 || statuses.length >= 192, 'overflow must answer without waiting for any penalty deadline')
  assert.equal(held.live.size, 64, 'the global delayed-attempt resource ceiling is fixed')
  assert.equal(f.claim.claimPenalties.size, 64)
  assert.equal(held.peak(), 64)
  assert.equal(statuses.length, 192); assert.ok(statuses.every(status => status === 429))
  const overflow = await Promise.all(Array.from({ length: 4096 }, (_, i) => f.claim.action(i % 2 ? 'claim/options' : 'claim/verify', { code: 'wrong' })
    .then(() => 200, error => error.status)))
  assert.ok(overflow.every(status => status === 429), 'both claim routes share the same resource ceiling')
  assert.equal(held.total(), 64, 'overflow must allocate no penalty timer')
  const owner = await enroll(f)
  assert.ok(owner.cookie)
  assert.equal((await f.request('/', { cookie: owner.cookie })).status, 200)
  assert.equal(held.live.size, 64, 'a complete correct claim must finish before the delayed wrong attempts')
  held.flush()
  await Promise.all(flood)
  assert.equal(statuses.filter(status => status === 401).length, 64)
  assert.equal(statuses.filter(status => status === 429).length, 192)
  assert.equal(held.live.size, 0); assert.equal(f.claim.claimPenalties.size, 0)
})

// Mutant REMOTE_PENALTIES_NO_CANCEL keeps a disconnected client's timer and slot alive.
test('remote penalty disconnect cancels its timer, releases its slot and allows immediate reuse', async t => {
  const f = await fixture(t, { claimMode: 'remote' }), held = holdPenaltyTimers(t)
  const req = http.request({ hostname: DSH_HOST, port: f.port, method: 'POST', path: '/_gate/claim/options', headers: {
    host: new URL(f.origin).host, origin: f.origin, 'content-type': 'application/json', connection: 'close',
  } })
  req.on('error', () => {})
  req.end(JSON.stringify({ code: 'wrong' }))
  t.after(() => req.destroy())
  await held.until(() => held.live.size === 1, 'a complete request must keep its penalty until response disconnect or deadline')
  const lateCallback = [...held.live.values()][0]
  const closed = new Promise(resolve => req.once('close', resolve)); req.destroy(); await closed
  await held.until(() => f.claim.claimPenalties.size === 0 && held.live.size === 0, 'disconnect must clear the penalty timer and release its slot before the deadline')
  lateCallback()
  assert.equal(f.claim.claimPenalties.size, 0, 'late timeout cleanup must be idempotent')
  const next = f.request('/_gate/claim/verify', { data: { code: 'wrong' } })
  await held.until(() => held.live.size === 1, 'a freed slot must admit another wrong attempt immediately')
  held.flush()
  assert.equal((await next).status, 401)
  assert.equal(f.claim.claimPenalties.size, 0); assert.equal(held.live.size, 0)
  const aborted = new AbortController(); aborted.abort()
  const before = held.total()
  await assert.rejects(f.claim.action('claim/options', { code: 'wrong' }, undefined, undefined, aborted.signal), { status: 401 })
  assert.equal(held.total(), before, 'an already-disconnected request must allocate no timer')
})

test('G4 self-hosted sign-in clears site data when configured and keeps the new session cookie', async t => {
  for (const clearOnSignIn of [true, false]) {
    const f = await fixture(t, { clearOnSignIn })
    const { device, completed } = await enroll(f)
    const expected = clearOnSignIn ? '"cache", "storage"' : undefined
    assert.equal(completed.headers['clear-site-data'], expected)
    const options = await f.request('/_gate/signin/options', { data: {} })
    assert.equal(options.status, 200)
    assert.equal(options.headers['clear-site-data'], undefined)
    const reply = await f.request('/_gate/signin/verify', {
      data: { id: options.body.id, credential: device.authenticate(options.body.options, f.origin) },
    })
    assert.equal(reply.status, 200)
    assert.equal(reply.headers['clear-site-data'], expected)
    assert.ok(cookieOf(reply))
  }
})
