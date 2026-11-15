import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { mkdtemp, writeFile, readFile, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareHermesConnection, refreshHermesProfiles } from '../src/host/hermes-connection.js'
import { install } from '../src/host/hermes-remote.js'
import { HermesTransport, RemoteChat } from '../src/host/hermes-transport.js'
import { fakeContext } from './fake-ctx.js'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'

const deadlines = { start: 300, control: 100, cancel: 10 }
const response = (value, status = 200, cookies = []) => ({ ok: status >= 200 && status < 300, status, json: async () => value, headers: { getSetCookie: () => cookies } })
function dashboard(overrides = {}) {
  const credential = randomUUID(), access = randomUUID(), refresh = randomUUID(), password = randomUUID(), username = `sample-${randomUUID()}`
  const address = `https://${randomUUID()}.invalid/prefix`, calls = []
  const fetch = async (url, init) => {
    calls.push({ url, ...init })
    const path = url.slice(address.length)
    const custom = await overrides.handle?.(path, init)
    if (custom) return custom
    if (path === '/api/auth/providers') return response({ providers: overrides.providers ?? [{ name: 'basic', supports_password: true }] })
    if (path === '/auth/password-login') return response({ ok: true, next: '/prefix/' }, 200, [`hermes_session_at=${access}; HttpOnly`, `hermes_session_rt=${refresh}; HttpOnly`])
    if (path === '/api/status') return response(overrides.status ?? { gateway_shared_with: ['sample-profile', 'uninstalled'] })
    if (path === '/api/profiles') return response(overrides.inventory ?? { profiles: [{ name: 'sample-profile', display_name: 'Sample profile' }, { name: 'not-served' }] })
    if (path === '/api/profiles/active') return response(overrides.active ?? { active: 'not-served', current: 'sample-profile' })
    throw Error('Unexpected fixture request')
  }
  return { fetch, calls, credential, access, refresh, password, username, address,
    token: { mode: 'remote', address, authMode: 'token', credential },
    login: { mode: 'remote', address, authMode: 'password', username, password } }
}
function runtime(t, fixture, overrides = {}) {
  const ctx = fakeContext(), endpoints = new Map(), secrets = new Map(), secretCalls = [], snapshots = [], wires = []
  ctx.llm.registerAdapter = () => () => {}
  const rt = { ctx, state: { prefs: {} }, hooks: { endpoint: (name, fn) => endpoints.set(name, fn) },
    load: async () => {}, loadSecrets: async () => {}, secretValue: name => secrets.get(name),
    save: async () => { snapshots.push(JSON.stringify(rt.state)) },
    secretEndpoint: async (name, body) => { secretCalls.push({ endpoint: name, ...body }); if (name === 'secret-set') secrets.set(body.name, body.value); else secrets.delete(body.name) },
    deleteSecretIfUnchanged: async (name, expected) => {
      await rt.loadSecrets()
      if (secrets.get(name) !== expected) return false
      secretCalls.push({ endpoint: 'secret-delete', name })
      secrets.delete(name)
      return true
    },
  }
  class Wire {
    constructor(options) { this.options = options; this.listeners = new Set(); this.secrets = new Set(options.redactionSecrets); this.sent = []; wires.push(this) }
    async connect() {
      if (overrides.gatewayDelay) await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, overrides.gatewayDelay)
        this.cancelConnect = () => { clearTimeout(timer); reject(Error('Fixture gateway closed')) }
      })
      await overrides.onConnect?.(this)
      return this
    }
    async session() { await overrides.beforeSession?.(this); return { session_id: randomUUID(), stored_session_id: randomUUID(), info: { desktop_contract: 8, approval_mode: 'manual', yolo: false } } }
    async models() { await overrides.beforeModels?.(this); return overrides.models ?? [{ id: 'sample:model', model: 'model', provider: 'sample', name: 'Sample model' }] }
    async request(method, params) { this.sent.push({ method, params }); await overrides.onRequest?.(method, params, this); return {} }
    close() { if (this.closed) return; this.closed = true; this.cancelConnect?.(); for (const listener of this.listeners) listener({ kind: 'lost' }) }
  }
  install(rt, { transport: options => new Wire(options), fetch: fixture.fetch, deadlines, ...overrides })
  t.after(() => ctx.dispose())
  return { rt, endpoints, secrets, secretCalls, snapshots, wires }
}
const sshFetch = async url => url.endsWith('/api/status') ? response({ gateway_shared_with: ['sample-profile'] }) : response({ profiles: [{ name: 'sample-profile' }] })

test('SSH discovery endpoint projects only four fields and accepts no browser filesystem options', async t => {
  const f = dashboard(), calls = [], controller = new AbortController()
  const row = { alias: 'sample-work', hostname: 'work.example.invalid', user: 'sample-user', port: '2200', identityfile: '/sample/unused', password: randomUUID(), options: { forbidden: true } }
  const h = runtime(t, f, { sshHosts: async options => { calls.push(options); return { aliases: [row], knownHosts: [{ ...row, alias: 'previous.example.invalid' }], forbidden: true } } })
  const before = JSON.stringify(h.rt.state)
  const result = await h.endpoints.get('hermes-remote-ssh-hosts')({ sshDir: '/sample/ignored', env: { forbidden: true } }, controller.signal)
  assert.deepEqual(Object.keys(result).sort(), ['aliases', 'knownHosts'])
  for (const value of [...result.aliases, ...result.knownHosts]) assert.deepEqual(Object.keys(value).sort(), ['alias', 'hostname', 'port', 'user'])
  assert.deepEqual(calls, [{ signal: controller.signal }])
  assert.ok(!JSON.stringify(result).includes(row.password) && !JSON.stringify(result).includes('unused'))
  assert.equal(JSON.stringify(h.rt.state), before)
  assert.equal(h.snapshots.length, 0)
  assert.equal(h.secretCalls.length, 0)
})

test('SSH discovery failures return an empty list without raw diagnostics', async t => {
  const h = runtime(t, dashboard(), { sshHosts: async () => { throw Error('Private fixture diagnostic') } })
  assert.deepEqual(await h.endpoints.get('hermes-remote-ssh-hosts')({}), { aliases: [], knownHosts: [] })
})

test('token auth uses its dedicated header, preserves the prefix and filters installed profiles to served profiles', async () => {
  const f = dashboard(), stages = []
  const c = await prepareHermesConnection(f.token, { fetch: f.fetch, deadlines, onProgress: stage => stages.push(stage) })
  assert.deepEqual(c.profiles, [{ id: 'sample-profile', name: 'Sample profile' }])
  assert.deepEqual(stages, ['reach', 'sign-in', 'open'])
  assert.ok(f.calls.every(call => call.url.startsWith(`${f.address}/api/`) && call.headers['X-Hermes-Session-Token'] === f.credential && call.headers.Authorization === undefined && call.redirect === 'manual'))
  assert.ok(f.calls.every(call => !call.url.includes(f.credential)))
  await c.close()
})
test('standalone fallback uses the running current profile, not the sticky CLI active profile', async () => {
  const f = dashboard({ status: {} })
  const c = await prepareHermesConnection(f.token, { fetch: f.fetch, deadlines })
  assert.equal(c.profiles[0].id, 'sample-profile')
  assert.ok(f.calls.some(call => call.url.endsWith('/api/profiles/active')))
})
test('several served profiles default to the one Hermes runs as, then its active one, then the first; one profile asks nothing more', async t => {
  const several = { status: { gateway_shared_with: ['sample-profile', 'second-profile', 'third-profile'] }, inventory: { profiles: [{ name: 'sample-profile' }, { name: 'second-profile' }, { name: 'third-profile' }] } }
  for (const [name, active, expected] of [
    ['the running profile', { active: 'third-profile', current: 'second-profile' }, 'second-profile'],
    ['the active profile when the running one is not served', { active: 'third-profile', current: 'not-served' }, 'third-profile'],
    ['the first when Hermes names none that is served', { active: 'not-served', current: 'not-served' }, 'sample-profile'],
    ['the first when the answer has the wrong shape', { active: 7, current: { name: 'second-profile' } }, 'sample-profile'],
  ]) await t.test(name, async () => {
    const f = dashboard({ ...several, active })
    const c = await prepareHermesConnection(f.token, { fetch: f.fetch, deadlines })
    assert.deepEqual(c.profiles.map(profile => profile.id), ['sample-profile', 'second-profile', 'third-profile'])
    assert.equal(c.defaultProfile, expected)
    await c.close()
  })
  await t.test('a Hermes that cannot say its default still connects, on the first profile', async () => {
    const f = dashboard({ ...several, handle: path => path === '/api/profiles/active' ? response({}, 500) : undefined })
    const c = await prepareHermesConnection(f.token, { fetch: f.fetch, deadlines })
    assert.equal(c.defaultProfile, 'sample-profile')
    await c.close()
  })
  await t.test('one served profile is the default and its default is never asked for', async () => {
    const f = dashboard()
    const c = await prepareHermesConnection(f.token, { fetch: f.fetch, deadlines })
    assert.deepEqual(c.profiles.map(profile => profile.id), ['sample-profile'])
    assert.equal(c.defaultProfile, 'sample-profile')
    assert.ok(!f.calls.some(call => call.url.endsWith('/api/profiles/active')))
    await c.close()
  })
  await t.test('the connection test hands the page the profiles and that default', async sub => {
    const f = dashboard({ ...several, active: { active: 'third-profile', current: 'second-profile' } }), h = runtime(sub, f)
    const answer = await h.endpoints.get('hermes-remote-test')(f.token)
    assert.deepEqual(Object.keys(answer).sort(), ['defaultProfile', 'profiles', 'status', 'testId'])
    assert.equal(answer.defaultProfile, 'second-profile')
    assert.deepEqual(answer.profiles.map(profile => profile.id), ['sample-profile', 'second-profile', 'third-profile'])
  })
})
test('password sign-in selects one supported provider and keeps cookies instead of the password', async () => {
  const f = dashboard(), c = await prepareHermesConnection(f.login, { fetch: f.fetch, deadlines })
  const call = f.calls.find(call => call.url.endsWith('/auth/password-login'))
  assert.deepEqual(JSON.parse(call.body), { provider: 'basic', username: f.username, password: f.password })
  assert.equal(c.authHeaders.Cookie, `hermes_session_at=${f.access}; hermes_session_rt=${f.refresh}`)
  assert.deepEqual(c.secret, { kind: 'session', cookie: c.authHeaders.Cookie })
  assert.ok(!JSON.stringify(c.secret).includes(f.password) && !JSON.stringify(c.secret).includes(f.username))
  assert.ok(c.redactionSecrets.includes(f.password) && c.redactionSecrets.includes(f.access) && c.redactionSecrets.includes(f.refresh))
})
test('password-provider ambiguity or absence does not submit credentials to an arbitrary provider', async () => {
  for (const providers of [[], [{ name: 'oidc', supports_password: false }], [{ name: 'a', supports_password: true }, { name: 'b', supports_password: true }]]) {
    const f = dashboard({ providers })
    await assert.rejects(prepareHermesConnection(f.login, { fetch: f.fetch, deadlines }), { code: 'bot/hermes-unsupported' })
    assert.ok(!f.calls.some(call => call.url.endsWith('/auth/password-login')))
  }
})
test('HTTP redirects, external post-login redirects and thrown fetch details fail closed without disclosure', async () => {
  for (const kind of ['http', 'login-next', 'thrown']) {
    const f = dashboard({ handle: path => {
      if (kind === 'http' && path === '/api/status') return response({}, 302)
      if (kind === 'login-next' && path === '/auth/password-login') return response({ ok: true, next: 'https://other.invalid/' })
      if (kind === 'thrown') throw Error('private fixture detail')
    } })
    await assert.rejects(prepareHermesConnection(kind === 'login-next' ? f.login : f.token, { fetch: f.fetch, deadlines }), error => error.code.startsWith('bot/hermes-') && !error.message.includes('private fixture detail'))
    assert.ok(f.calls.every(call => call.url.startsWith(f.address)))
  }
})
test('rejected sign-in never echoes the remote response', async () => {
  const f = dashboard({ handle: path => path === '/auth/password-login' ? response({ error: 'private fixture detail' }, 401) : undefined })
  await assert.rejects(prepareHermesConnection(f.login, { fetch: f.fetch, deadlines }), error => error.code === 'bot/hermes-auth' && !error.message.includes('private fixture detail'))
})
test('profile labels redact credential echoes and credential-shaped IDs are excluded', async () => {
  const f = dashboard()
  const fetch = async url => url.endsWith('/api/status') ? response({ gateway_shared_with: ['sample-profile', f.credential] })
    : response({ profiles: [{ name: 'sample-profile', display_name: `Sample ${f.credential}` }, { name: f.credential }] })
  const c = await prepareHermesConnection(f.token, { fetch, deadlines })
  assert.deepEqual(c.profiles, [{ id: 'sample-profile', name: 'Sample [redacted]' }])
})
test('draft flags cannot authorize HTTP, but the owned SSH factory grants loopback and closes exactly once', async () => {
  const f = dashboard(); let closed = 0
  await assert.rejects(prepareHermesConnection({ ...f.token, address: 'http://127.0.0.1', allowLoopback: true }, { fetch: f.fetch, deadlines }))
  const c = await prepareHermesConnection({ mode: 'ssh', ssh: { host: 'example.invalid' } }, {
    startSsh: async () => ({ address: 'http://127.0.0.1:12345', credential: f.credential, close: async () => { closed++ } }), fetch: sshFetch, deadlines,
  })
  assert.equal(c.allowLoopback, true); assert.equal(c.secret, undefined)
  await Promise.all([c.close(), c.close()]); assert.equal(closed, 1)
})
test('unanswered and aborted requests are bounded and SSH is cleaned on failed profile discovery', async () => {
  const f = dashboard(), controller = new AbortController()
  const pending = prepareHermesConnection(f.token, { fetch: () => new Promise(() => {}), signal: controller.signal, deadlines })
  controller.abort(); await assert.rejects(pending, /did not answer|cancelled/)
  await assert.rejects(prepareHermesConnection(f.token, { fetch: () => new Promise(() => {}), deadlines: { start: 15, control: 10, cancel: 5 } }), /did not answer/)
  let closed = 0
  await assert.rejects(prepareHermesConnection({ mode: 'ssh', ssh: { host: 'example.invalid' } }, {
    startSsh: async () => ({ address: 'http://127.0.0.1:12345', credential: f.credential, close: async () => { closed++ } }), fetch: async () => response({}), deadlines,
  }), /profiles/)
  assert.equal(closed, 1)
})
test('profile refresh reuses cookies without another password and saved restoration performs no REST discovery', async () => {
  const f = dashboard(), c = await prepareHermesConnection(f.login, { fetch: f.fetch, deadlines })
  f.calls.length = 0
  assert.equal((await refreshHermesProfiles(c, { fetch: f.fetch, deadlines }))[0].id, 'sample-profile')
  assert.ok(f.calls.every(call => !call.url.includes('/auth/') && call.headers.Cookie))
  const restored = await prepareHermesConnection({ mode: 'remote', address: f.address, authMode: 'password' }, { secret: c.secret, discover: false, fetch: () => { throw Error('No REST discovery permitted') }, deadlines })
  assert.equal(restored.authHeaders.Cookie, c.authHeaders.Cookie)
})
test('quoted session cookies keep their wire form while unquoted echoes are redacted, including rotated credentials', async () => {
  const token = randomUUID(), rotated = randomUUID()
  const f = dashboard({ handle: path => {
    if (path === '/auth/password-login') return response({ ok: true }, 200, [`hermes_session_at="${token}"; HttpOnly`])
    if (path === '/api/status') return response({ gateway_shared_with: ['sample-profile'] }, 200, [`hermes_session_at="${rotated}"; HttpOnly`])
    if (path === '/api/profiles') return response({ profiles: [{ name: 'sample-profile', display_name: `Sample ${token} ${rotated}` }] })
  } })
  const c = await prepareHermesConnection(f.login, { fetch: f.fetch, deadlines })
  assert.equal(c.authHeaders.Cookie, `hermes_session_at="${rotated}"`)
  assert.equal(c.secret.cookie, c.authHeaders.Cookie)
  assert.deepEqual(c.profiles, [{ id: 'sample-profile', name: 'Sample [redacted] [redacted]' }])
  assert.ok(c.redactionSecrets.includes(token) && c.redactionSecrets.includes(rotated))
})
test('ticket cookie rotation updates the existing scoped secret reference and wire redaction without storing a password', async t => {
  const rotated = randomUUID(), f = dashboard({ handle: path => path === '/api/auth/ws-ticket' ? response({ ticket: 'sample-ticket' }, 200, [`hermes_session_at="${rotated}"; HttpOnly`]) : undefined })
  const h = runtime(t, f), tested = await h.rt.hermesRemote.test(f.login)
  const view = await h.rt.hermesRemote.save({ testId: tested.testId, profile: 'sample-profile' })
  await h.rt.hermesRemote.connect()
  const wire = h.wires.at(-1)
  await wire.options.fetch(`${f.address}/api/auth/ws-ticket`, { headers: wire.options.authHeaders })
  const stored = h.secrets.get(view.credentialRef)
  assert.ok(JSON.parse(stored).cookie.includes(rotated))
  assert.ok(!stored.includes(f.password) && !stored.includes(f.username))
  assert.ok(wire.secrets.has(rotated))
})
test('test IDs keep the adapter off until selected-profile validation; state stores only a scoped secret reference', async t => {
  const f = dashboard(), h = runtime(t, f)
  const tested = await h.rt.hermesRemote.test(f.login)
  assert.equal(h.rt.hermesRemote.view().enabled, false)
  await assert.rejects(h.rt.hermesRemote.save({ testId: tested.testId, profile: 'not-served' }), { code: 'bot/hermes-profiles' })
  const view = await h.rt.hermesRemote.save({ testId: tested.testId, profile: 'sample-profile' })
  assert.equal(view.enabled, true); assert.equal(view.modelRef, 'hermes-remote/sample:model')
  for (const secret of [f.password, f.username, f.access, f.refresh]) assert.ok(!JSON.stringify(view).includes(secret) && !h.snapshots.join('').includes(secret))
  const stored = h.secrets.get(view.credentialRef)
  assert.equal(JSON.parse(stored).kind, 'session'); assert.ok(!stored.includes(f.password) && !stored.includes(f.username))
  assert.deepEqual(h.secretCalls.find(call => call.endpoint === 'secret-set').scope, [])
  assert.ok(h.wires.every(wire => !wire.sent.some(frame => frame.method === 'prompt.submit')))
})
test('progress reflects authenticated REST and contract probing, while refresh never requests the password again', async t => {
  const f = dashboard(), requestId = randomUUID(); let status
  const h = runtime(t, f, { beforeSession: () => { status = h.endpoints.get('hermes-remote-test-status')({ requestId }) } })
  const tested = await h.rt.hermesRemote.test({ ...f.login, requestId })
  assert.deepEqual(status, { stage: 'open' })
  assert.deepEqual(h.endpoints.get('hermes-remote-test-status')({ requestId }), { stage: 'connected' })
  f.calls.length = 0
  assert.equal((await h.endpoints.get('hermes-remote-test-profiles')({ testId: tested.testId })).profiles[0].id, 'sample-profile')
  assert.ok(f.calls.every(call => !call.url.endsWith('/auth/password-login')))
})
test('saved one-click connect uses the saved profile/session without REST discovery or an automatic submit', async t => {
  const f = dashboard(), h = runtime(t, f), tested = await h.rt.hermesRemote.test(f.login)
  await h.rt.hermesRemote.save({ testId: tested.testId, profile: 'sample-profile' })
  const before = f.calls.length, result = await h.rt.hermesRemote.connect()
  assert.equal(result.profile, 'sample-profile'); assert.ok(result.modelRef); assert.equal(f.calls.length, before)
  assert.equal(h.wires.at(-1).options.authHeaders.Cookie, `hermes_session_at=${f.access}; hermes_session_rt=${f.refresh}`)
  assert.equal(h.wires.at(-1).options.profile, 'sample-profile')
})
test('tests-only cancellation aborts before a test ID exists and leaves the saved configuration untouched', async t => {
  const f = dashboard({ handle: () => new Promise(() => {}) }), h = runtime(t, f)
  h.rt.state.prefs.hermesRemote = { enabled: true, address: 'https://example.invalid', profile: 'sample-profile', models: [] }
  h.rt.state.hermesSessions = { chat: { storedSessionId: 'saved', pendingSubmit: true, uncertain: true } }
  const original = JSON.stringify(h.rt.state)
  const pending = h.rt.hermesRemote.test(f.token), rejected = assert.rejects(pending)
  await new Promise(resolve => setImmediate(resolve))
  await h.rt.hermesRemote.disconnect({ testsOnly: true }); await rejected
  assert.equal(JSON.stringify(h.rt.state), original)
})
test('replaced and expired IDs cannot save; replacing and disposing close owned SSH resources', async t => {
  const f = dashboard(), clock = { now: 0 }; let closed = 0
  const h = runtime(t, { ...f, fetch: sshFetch }, { now: () => clock.now,
    startSsh: async () => ({ address: 'http://127.0.0.1:12345', credential: f.credential, close: async () => { await new Promise(resolve => setImmediate(resolve)); closed++ } }),
  })
  const first = await h.rt.hermesRemote.test({ mode: 'ssh', ssh: { host: 'example.invalid' } })
  const second = await h.rt.hermesRemote.test({ mode: 'ssh', ssh: { host: 'example.invalid' } })
  assert.equal(closed, 1)
  await assert.rejects(h.rt.hermesRemote.save({ testId: first.testId, profile: 'sample-profile' }), { code: 'bot/hermes-expired' })
  clock.now += 5 * 60_000 + 1
  await assert.rejects(h.rt.hermesRemote.save({ testId: second.testId, profile: 'sample-profile' }), { code: 'bot/hermes-expired' })
  await h.rt.ctx.dispose(); assert.equal(closed, 2)
})
test('replacing the remote target refuses uncertain sessions and preserves their durable identities', async t => {
  const f = dashboard(), h = runtime(t, f)
  h.rt.state.prefs.hermesRemote = { enabled: true, address: 'https://example.invalid/other', profile: 'sample-profile', models: [] }
  h.rt.state.hermesSessions = { chat: { storedSessionId: 'saved', runtimeSessionId: 'runtime', pendingSubmit: true, uncertain: true } }
  const before = JSON.stringify(h.rt.state), tested = await h.rt.hermesRemote.test(f.token)
  await assert.rejects(h.rt.hermesRemote.save({ testId: tested.testId, profile: 'sample-profile' }), { code: 'bot/hermes-busy' })
  assert.equal(JSON.stringify(h.rt.state), before)
})
test('one action budget covers delayed auth plus gateway startup and closes the remaining probe', async t => {
  let first = true
  const f = dashboard({ handle: async () => { if (first) { first = false; await new Promise(resolve => setTimeout(resolve, 25)) } } })
  const h = runtime(t, f, { deadlines: { start: 45, control: 40, cancel: 5 }, gatewayDelay: 40 })
  await assert.rejects(h.rt.hermesRemote.test(f.token), /closed|cancelled|timed out/)
  assert.ok(h.wires[0].options.deadlines.start < 35)
  assert.equal(h.wires[0].closed, true)
  assert.equal(h.rt.hermesRemote.view().enabled, false)
})
test('saved SSH connects serialize and tests-only cancellation preserves the active owned lease', async t => {
  const f = dashboard(), gates = [barrier(), barrier()]; let started = 0, closed = 0, models = 0
  const h = runtime(t, { ...f, fetch: sshFetch }, {
    deadlines: { start: 1000, control: 500, cancel: 300 },
    startSsh: async () => { started++; return { address: 'http://127.0.0.1:12345', credential: f.credential, close: async () => { closed++ } } },
    beforeModels: async () => { if (h.rt.hermesRemote.view().enabled) { const gate = gates[models++]; gate.reach(); await gate.held } },
  })
  const tested = await h.rt.hermesRemote.test({ mode: 'ssh', ssh: { host: 'example.invalid' } })
  await h.rt.hermesRemote.save({ testId: tested.testId, profile: 'sample-profile' })
  assert.equal(closed, 1)
  const first = h.rt.hermesRemote.connect()
  await gates[0].entered
  const second = h.rt.hermesRemote.connect(), cancel = h.rt.hermesRemote.disconnect({ testsOnly: true })
  await eventTurn()
  assert.equal(models, 1); assert.equal(started, 2); assert.equal(closed, 1)
  gates[0].release(); await first
  await gates[1].entered
  assert.equal(closed, 2); assert.equal(started, 3)
  gates[1].release(); await second; await cancel
  assert.equal(closed, 3)
})
test('a lost completed test response can be cancelled by its preassigned request ID before the client knows a test ID', async t => {
  const f = dashboard(), requestId = randomUUID(), controller = new AbortController(); let closed = 0
  const h = runtime(t, { ...f, fetch: sshFetch }, {
    startSsh: async () => ({ address: 'http://127.0.0.1:12345', credential: f.credential, close: async () => { closed++ } }),
  })
  // The handler completed, but its result/testId was dropped before client delivery.
  await h.endpoints.get('hermes-remote-test')({ mode: 'ssh', ssh: { host: 'example.invalid' }, requestId }, controller.signal).then(() => undefined)
  assert.equal(closed, 0)
  controller.abort()
  await h.rt.hermesRemote.disconnect({ testsOnly: true, requestId })
  assert.equal(closed, 1)
  assert.deepEqual(h.endpoints.get('hermes-remote-test-status')({ requestId }), { stage: 'reach' })
  assert.equal(h.rt.hermesRemote.view().enabled, false)
})
test('request-scoped cancellation aborts the matching pending test and ignores a wrong or older request', async t => {
  let requestSignal, started
  const began = new Promise(resolve => { started = resolve })
  const f = dashboard({ handle: (_path, init) => { requestSignal = init.signal; started(); return new Promise(() => {}) } })
  const h = runtime(t, f), requestId = randomUUID()
  const pending = h.rt.hermesRemote.test({ ...f.token, requestId }), rejected = assert.rejects(pending)
  await began
  await h.rt.hermesRemote.disconnect({ testsOnly: true, requestId: randomUUID() })
  assert.equal(requestSignal.aborted, false)
  await h.rt.hermesRemote.disconnect({ testsOnly: true, requestId })
  await rejected
  assert.equal(requestSignal.aborted, true)
})
test('stale request IDs and conflicting test IDs cannot cancel a newer completed SSH test', async t => {
  const f = dashboard(), oldRequest = randomUUID(), currentRequest = randomUUID(); let closed = 0
  const h = runtime(t, { ...f, fetch: sshFetch }, {
    startSsh: async () => ({ address: 'http://127.0.0.1:12345', credential: f.credential, close: async () => { closed++ } }),
  })
  await h.rt.hermesRemote.test({ mode: 'ssh', ssh: { host: 'example.invalid' }, requestId: oldRequest })
  const current = await h.rt.hermesRemote.test({ mode: 'ssh', ssh: { host: 'example.invalid' }, requestId: currentRequest })
  assert.equal(closed, 1)
  await h.rt.hermesRemote.disconnect({ testsOnly: true, requestId: oldRequest })
  await h.rt.hermesRemote.disconnect({ testsOnly: true, requestId: currentRequest, testId: randomUUID() })
  assert.equal(closed, 1)
  assert.deepEqual(h.endpoints.get('hermes-remote-test-status')({ requestId: currentRequest }), { stage: 'connected' })
  await h.rt.hermesRemote.disconnect({ testsOnly: true, requestId: currentRequest, testId: current.testId })
  assert.equal(closed, 2)
})
test('a request cancelled while the previous test is cleaning up never starts its own SSH process afterward', async t => {
  const f = dashboard(); let started = 0, closeStarted, releaseClose
  const closing = new Promise(resolve => { closeStarted = resolve })
  const h = runtime(t, { ...f, fetch: sshFetch }, {
    startSsh: async () => { started++; return { address: 'http://127.0.0.1:12345', credential: f.credential, close: () => {
      closeStarted(); return new Promise(resolve => { releaseClose = resolve })
    } } },
  })
  await h.rt.hermesRemote.test({ mode: 'ssh', ssh: { host: 'example.invalid' }, requestId: randomUUID() })
  const requestId = randomUUID(), pending = h.rt.hermesRemote.test({ mode: 'ssh', ssh: { host: 'example.invalid' }, requestId }), rejected = assert.rejects(pending)
  await closing
  const cancelled = h.rt.hermesRemote.disconnect({ testsOnly: true, requestId })
  releaseClose()
  await cancelled; await rejected
  assert.equal(started, 1)
})


function savedToken(h, f, { authMode = 'token', secret = { kind: 'token', credential: f.credential } } = {}) {
  const credentialRef = `HERMES_REMOTE_${randomUUID().replaceAll('-', '').toUpperCase()}`
  h.secrets.set(credentialRef, JSON.stringify(secret))
  h.rt.state.prefs.hermesRemote = { enabled: true, mode: 'remote', authMode, address: f.address, profile: 'sample-profile', setupVersion: 1, credentialRef, models: [] }
  return { mode: 'remote', authMode, address: f.address, credentialRef, credential: '' }
}

test('saved-token-retest-without-secret: a matching saved token re-tests profiles without revealing or re-entering it', async t => {
  const f = dashboard({ status: { gateway_shared_with: ['sample-profile', 'another-profile'] }, inventory: { profiles: [{ name: 'sample-profile', display_name: 'Sample profile' }, { name: 'another-profile', display_name: 'Another profile' }] } }), h = runtime(t, f), draft = savedToken(h, f)
  const tested = await h.endpoints.get('hermes-remote-test')({ ...draft, profile: 'another-profile' })
  assert.deepEqual(tested.profiles, [{ id: 'sample-profile', name: 'Sample profile' }, { id: 'another-profile', name: 'Another profile' }])
  assert.ok(f.calls.length > 0 && f.calls.every(call => call.headers['X-Hermes-Session-Token'] === f.credential))
  const refreshed = await h.endpoints.get('hermes-remote-test-profiles')({ testId: tested.testId })
  assert.deepEqual(refreshed.profiles, tested.profiles)
  const view = await h.endpoints.get('hermes-remote-save')({ testId: tested.testId, profile: 'another-profile' })
  assert.equal(view.profile, 'another-profile')
  assert.equal(view.credentialRef, draft.credentialRef, 'a saved token keeps its existing secret reference')
  assert.equal(h.secretCalls.length, 0, 'reusing a saved token never rewrites or deletes the source secret')
  for (const value of [tested, refreshed, view, h.rt.state]) assert.ok(!JSON.stringify(value).includes(f.credential))
  assert.ok(h.wires.every(wire => !wire.sent.some(frame => frame.method === 'prompt.submit')))
})

test('saved token reuse refuses changed address, mode, auth mode or credential reference, and fresh credentials override it', async t => {
  const f = dashboard(), h = runtime(t, f, { startSsh: async () => { throw Object.assign(Error('Fixture unavailable'), { code: 'bot/hermes-ssh' }) } }), draft = savedToken(h, f)
  for (const change of [{ address: f.address + '/other' }, { authMode: 'password' }, { credentialRef: 'HERMES_REMOTE_OTHER' }, { credentialRef: undefined }, { mode: 'ssh', ssh: { host: 'example.invalid' } }]) {
    f.calls.length = 0
    await assert.rejects(h.rt.hermesRemote.test({ ...draft, ...change }))
    assert.ok(f.calls.every(call => call.headers['X-Hermes-Session-Token'] !== f.credential))
  }
  const replacement = randomUUID()
  await h.rt.hermesRemote.test({ ...draft, credential: replacement })
  assert.ok(f.calls.length > 0 && f.calls.every(call => call.headers['X-Hermes-Session-Token'] === replacement))
})

test('saved token re-test fails closed when its source reference, value or connection changes while REST is pending', async t => {
  for (const change of ['reference', 'secret', 'address']) {
    let reached, resume
    const reachedRequest = new Promise(resolve => { reached = resolve })
    const waiting = new Promise(resolve => { resume = resolve })
    const f = dashboard({ handle: async path => { if (path === '/api/status') { reached(); await waiting } } }), h = runtime(t, f), draft = savedToken(h, f)
    const pending = h.rt.hermesRemote.test(draft), rejected = assert.rejects(pending, error => error.code.startsWith('bot/hermes-') && !error.message.includes(f.credential))
    await reachedRequest
    if (change === 'reference') h.rt.state.prefs.hermesRemote.credentialRef = 'HERMES_REMOTE_OTHER'
    if (change === 'secret') h.secrets.set(draft.credentialRef, JSON.stringify({ kind: 'token', credential: randomUUID() }))
    if (change === 'address') h.rt.state.prefs.hermesRemote.address += '/other'
    resume(); await rejected
    assert.equal(h.wires.length, 0)
  }
})

test('saved token re-test cannot refresh or save after its source credential changes', async t => {
  const f = dashboard(), h = runtime(t, f), draft = savedToken(h, f)
  const tested = await h.rt.hermesRemote.test(draft)
  h.rt.state.prefs.hermesRemote.credentialRef = 'HERMES_REMOTE_OTHER'
  await assert.rejects(h.rt.hermesRemote.refreshProfiles({ testId: tested.testId }))
  await assert.rejects(h.rt.hermesRemote.save({ testId: tested.testId, profile: 'sample-profile' }))
  assert.equal(h.rt.state.prefs.hermesRemote.credentialRef, 'HERMES_REMOTE_OTHER')
})

test('safe-errors-collapsed: an expired saved token or session reaches the UI endpoint as a fixed typed auth failure', async t => {
  // A saved session mints a ticket and is refused there. A saved token has no ticket: Hermes
  // turns its socket away without a word, and one request with the same token says why.
  const turnedAway = () => { const socket = new EventTarget(); socket.close = () => {}; queueMicrotask(() => socket.dispatchEvent(new Event('close'))); return socket }
  for (const authMode of ['token', 'password']) {
    const asked = authMode === 'token' ? '/api/profiles' : '/api/auth/ws-ticket'
    const f = dashboard({ handle: path => path === asked ? response({ message: 'private fixture detail' }, 401) : undefined })
    const sockets = []
    const h = runtime(t, f, { transport: options => new HermesTransport({ ...options, socket: (url, protocols) => { sockets.push({ url, protocols }); return turnedAway() } }) })
    savedToken(h, f, { authMode, secret: authMode === 'token' ? { kind: 'token', credential: f.credential } : { kind: 'session', cookie: `hermes_session_at=${f.access}` } })
    await assert.rejects(h.endpoints.get('hermes-remote-connect')({}), error => {
      assert.equal(error.code, 'bot/hermes-auth')
      for (const secret of [f.credential, f.access, 'private fixture detail', 'token=']) assert.ok(!error.message.includes(secret))
      return true
    })
    assert.equal(f.calls.length, 1)
    assert.ok(f.calls[0].url.endsWith(asked))
    assert.equal(authMode === 'token' ? f.calls[0].headers['X-Hermes-Session-Token'] : f.calls[0].headers.Cookie, authMode === 'token' ? f.credential : `hermes_session_at=${f.access}`)
    assert.equal(sockets.length, authMode === 'token' ? 1 : 0, 'a refused ticket opens no socket')
  }
})

test('saved sign-in restoration preserves only allowlisted typed codes and exposes fixed messages without remote detail', async t => {
  for (const code of ['bot/hermes-auth', 'bot/hermes-ssh-auth', 'bot/hermes-ssh-host-key', 'bot/hermes-ssh-missing', 'bot/hermes-unknown']) {
    const detail = randomUUID(), f = dashboard(), h = runtime(t, f, { transport: () => ({ connect: async () => { throw Object.assign(Error(detail), { code }) }, close() {} }) })
    savedToken(h, f)
    await assert.rejects(h.endpoints.get('hermes-remote-connect')({}), error => {
      assert.equal(error.code, code === 'bot/hermes-unknown' ? 'bot/refused' : code)
      assert.ok(!error.message.includes(detail))
      return true
    })
  }
})


test('saved-token re-test rejects expired authentication through the real REST helper with a typed redacted error', async t => {
  const f = dashboard({ handle: path => path === '/api/status' ? response({ error: 'private fixture detail' }, 401) : undefined }), h = runtime(t, f), draft = savedToken(h, f)
  await assert.rejects(h.endpoints.get('hermes-remote-test')(draft), error => {
    assert.equal(error.code, 'bot/hermes-auth')
    assert.ok(!error.message.includes(f.credential) && !error.message.includes('private fixture detail'))
    return true
  })
  assert.equal(f.calls[0].headers['X-Hermes-Session-Token'], f.credential)
  assert.equal(h.wires.length, 0)
})

test('saved-token source binding is rechecked after wire probing before a test ID can be returned', async t => {
  const f = dashboard(); let reached, resume
  const started = new Promise(resolve => { reached = resolve })
  const h = runtime(t, f, { beforeModels: async () => { reached(); await new Promise(resolve => { resume = resolve }) } }), draft = savedToken(h, f)
  const pending = h.rt.hermesRemote.test(draft), rejected = assert.rejects(pending, { code: 'bot/hermes-auth' })
  await started
  h.secrets.set(draft.credentialRef, JSON.stringify({ kind: 'token', credential: randomUUID() }))
  resume(); await rejected
  assert.ok(h.wires.every(wire => wire.closed))
})

test('saved SSH restoration sanitizes allowlisted and unknown factory errors before the UI endpoint', async t => {
  for (const code of ['bot/hermes-ssh-auth', 'bot/hermes-ssh-unknown', 'bot/hermes']) {
    const f = dashboard(), detail = randomUUID(), h = runtime(t, f, { startSsh: async () => { throw Object.assign(Error(detail), { code }) } })
    h.rt.state.prefs.hermesRemote = { enabled: true, setupVersion: 1, mode: 'ssh', authMode: 'token', ssh: { host: 'example.invalid' }, profile: 'sample-profile', models: [] }
    await assert.rejects(h.endpoints.get('hermes-remote-connect')({}), error => {
      assert.equal(error.code, code === 'bot/hermes-ssh-auth' ? code : 'bot/refused')
      assert.ok(!error.message.includes(detail))
      return true
    })
  }
})


test('unconfirmed SSH cleanup takes priority over its startup error without exposing diagnostics or process identities', async t => {
  const f = dashboard(), detail = randomUUID(), h = runtime(t, f, { startSsh: async () => { throw Object.assign(Error(detail), { code: 'bot/hermes-ssh-auth', cleanupUnknown: true, localClosed: false, pid: 4321 }) } })
  h.rt.state.prefs.hermesRemote = { enabled: true, setupVersion: 1, mode: 'ssh', authMode: 'token', ssh: { host: 'example.invalid' }, profile: 'sample-profile', models: [] }
  await assert.rejects(h.endpoints.get('hermes-remote-connect')({}), error => {
    assert.equal(error.code, 'bot/hermes-ssh-cleanup')
    assert.ok(!error.message.includes(detail) && !error.message.includes('4321'))
    assert.equal(error.cleanupUnknown, undefined)
    assert.equal(error.localClosed, undefined)
    assert.equal(error.pid, undefined)
    return true
  })
})


test('a matching legacy saved raw token can be re-tested without entering or returning its value', async t => {
  const f = dashboard(), h = runtime(t, f), credentialRef = 'HERMES_REMOTE_CREDENTIAL'
  h.secrets.set(credentialRef, f.credential)
  h.rt.state.prefs.hermesRemote = { enabled: true, address: f.address, profile: 'sample-profile', credentialRef, models: [] }
  const result = await h.rt.hermesRemote.test({ mode: 'remote', address: f.address, authMode: 'token', credentialRef, credential: '' })
  assert.ok(result.testId)
  assert.ok(f.calls.every(call => call.headers['X-Hermes-Session-Token'] === f.credential))
  assert.ok(!JSON.stringify(result).includes(f.credential))
  const view = await h.rt.hermesRemote.save({ testId: result.testId, profile: 'sample-profile' })
  assert.notEqual(view.credentialRef, credentialRef, 'upgrading a raw token stores a descriptor under a new reference')
  const descriptor = JSON.parse(h.secrets.get(view.credentialRef))
  assert.equal(descriptor.kind, 'token')
  assert.ok(descriptor.credential === f.credential, 'the descriptor retains the validated token')
  assert.ok(h.secrets.get(credentialRef) === f.credential, 'the legacy source remains unchanged')
  for (const value of [view, h.rt.state]) assert.ok(!JSON.stringify(value).includes(f.credential))
})


test('stale-save-overwrites-replacement: configuring a replacement during awaited secret storage survives rejected fresh-token save', async t => {
  const f = dashboard(), h = await durableRuntime(t, f), draft = savedToken(h, f)
  h.rt.state.hermesSessions = { old: { storedSessionId: randomUUID() } }
  await h.rt.save()
  const tested = await h.endpoints.get('hermes-remote-test')({ ...draft, credential: f.credential })
  const originalSet = h.rt.secretEndpoint
  let reached, resume, temporaryRef
  const writing = new Promise(resolve => { reached = resolve }), held = new Promise(resolve => { resume = resolve })
  h.rt.secretEndpoint = async (name, body) => {
    await originalSet(name, body)
    if (name === 'secret-set' && !temporaryRef) { temporaryRef = body.name; reached(); await held }
  }
  const pending = h.endpoints.get('hermes-remote-save')({ testId: tested.testId, profile: 'sample-profile' }), rejected = assert.rejects(pending)
  await writing
  const configuring = h.endpoints.get('hermes-remote-configure')({ enabled: true, address: 'https://replacement.invalid/new', profile: 'replacement-profile', credential: randomUUID() })
  resume(); await rejected
  const replacement = await configuring
  const replacementRecord = h.rt.state.prefs.hermesRemote, replacementSessions = h.rt.state.hermesSessions
  assert.equal(replacement.address, 'https://replacement.invalid/new')
  assert.equal(h.rt.state.prefs.hermesRemote, replacementRecord)
  assert.equal(h.rt.state.hermesSessions, replacementSessions)
  assert.equal(h.rt.hermesRemote.view().address, replacement.address)
  assert.equal(h.rt.hermesRemote.view().profile, replacement.profile)
  assert.equal(h.rt.hermesRemote.view().credentialRef, replacement.credentialRef)
  assert.equal(h.secrets.has(temporaryRef), false)
  assert.equal(h.secrets.has(replacement.credentialRef), true)
})

test('a failed save rolls back its own installed configuration and session reset and deletes its temporary secret', async t => {
  const f = dashboard(), h = await durableRuntime(t, f), draft = savedToken(h, f)
  h.rt.state.prefs.hermesRemote.profile = 'previous-profile'
  h.rt.state.hermesSessions = { old: { storedSessionId: randomUUID() } }
  const originalRecord = h.rt.state.prefs.hermesRemote, originalSessions = h.rt.state.hermesSessions
  await h.rt.save()
  const tested = await h.rt.hermesRemote.test({ ...draft, credential: f.credential })
  const originalSave = h.rt.save
  let first = true
  h.rt.save = async () => { if (first) { first = false; throw Error('Fixture persistence failed') }; await originalSave() }
  await assert.rejects(h.rt.hermesRemote.save({ testId: tested.testId, profile: 'sample-profile' }), /Fixture persistence failed/)
  assert.equal(h.rt.state.prefs.hermesRemote, originalRecord)
  assert.equal(h.rt.state.hermesSessions, originalSessions)
  assert.deepEqual([...h.secrets.keys()], [draft.credentialRef])
})

test('a replacement configuration stays owned when an earlier installed save fails after awaiting persistence', async t => {
  const f = dashboard(), h = runtime(t, f), draft = savedToken(h, f)
  const tested = await h.rt.hermesRemote.test(draft), originalSave = h.rt.save
  let reached, resume, held = false
  const writing = new Promise(resolve => { reached = resolve }), wait = new Promise(resolve => { resume = resolve })
  h.rt.save = async () => {
    if (!held) { held = true; reached(); await wait; throw Error('Fixture persistence failed') }
    await originalSave()
  }
  const pending = h.rt.hermesRemote.save({ testId: tested.testId, profile: 'sample-profile' }), rejected = assert.rejects(pending)
  await writing
  const configuring = h.endpoints.get('hermes-remote-configure')({ enabled: true, address: 'https://replacement.invalid/new', profile: 'replacement-profile', credential: randomUUID() })
  resume(); await rejected; await configuring
  const replacementRecord = h.rt.state.prefs.hermesRemote, replacementSessions = h.rt.state.hermesSessions
  assert.equal(h.rt.state.prefs.hermesRemote, replacementRecord)
  assert.equal(h.rt.state.hermesSessions, replacementSessions)
})


for (const boundary of ['stopLive', 'persistence']) {
  test(`saved-token-source-changed-during-save: replacement during ${boundary} rejects and preserves the source credential durably`, async t => {
    const f = dashboard(), h = runtime(t, f), draft = savedToken(h, f)
    h.rt.state.prefs.hermesRemote.profile = 'previous-profile'
    h.rt.state.hermesSessions = { old: { storedSessionId: randomUUID() } }
    const originalRecord = h.rt.state.prefs.hermesRemote, originalSessions = h.rt.state.hermesSessions
    await h.rt.save()
    const tested = await h.endpoints.get('hermes-remote-test')(draft)
    let reached, resume, first = true
    const blocked = new Promise(resolve => { reached = resolve }), held = new Promise(resolve => { resume = resolve })
    if (boundary === 'stopLive') {
      h.rt.hermesRemote.adapter.live.set('sample-live', { run: { stop: async () => { reached(); await held } } })
    } else {
      const originalSave = h.rt.save
      h.rt.save = async () => {
        await originalSave()
        if (first) { first = false; reached(); await held }
      }
    }
    const pending = h.endpoints.get('hermes-remote-save')({ testId: tested.testId, profile: 'sample-profile' })
    const rejected = assert.rejects(pending, error => error.code === 'bot/hermes-auth')
    await blocked
    const replacement = JSON.stringify({ kind: 'token', credential: randomUUID() })
    await h.rt.secretEndpoint('secret-set', { name: draft.credentialRef, value: replacement, purpose: 'Fixture replacement credential', scope: [] })
    resume(); await rejected
    assert.equal(h.rt.state.prefs.hermesRemote, originalRecord)
    assert.equal(h.rt.state.hermesSessions, originalSessions)
    assert.ok(h.secrets.get(draft.credentialRef) === replacement, 'the newer source credential remains intact')
    assert.equal(h.secrets.size, 1, 'a rejected save leaves no stale copied credential')
    assert.deepEqual(JSON.parse(h.snapshots.at(-1)).prefs.hermesRemote, originalRecord, 'the last persisted configuration matches the rollback in memory')
    assert.deepEqual(JSON.parse(h.snapshots.at(-1)).hermesSessions, originalSessions, 'the restored session map is persisted too')
  })
}


test('a failed durable rollback keeps the new credential referenced by the persisted candidate and reports uncertainty', async t => {
  const f = dashboard(), h = runtime(t, f), draft = savedToken(h, f)
  const originalRecord = h.rt.state.prefs.hermesRemote
  const tested = await h.rt.hermesRemote.test({ ...draft, credential: f.credential }), originalSave = h.rt.save
  let first = true
  h.rt.save = async () => {
    if (first) { first = false; await originalSave(); throw Error('Fixture write completion failed') }
    throw Error('Fixture rollback write failed')
  }
  await assert.rejects(h.rt.hermesRemote.save({ testId: tested.testId, profile: 'sample-profile' }), error => {
    assert.equal(error.code, 'bot/hermes-connection')
    assert.match(error.message, /could not be restored on disk/)
    assert.ok(!error.message.includes(f.credential) && !error.message.includes('Fixture'))
    return true
  })
  assert.equal(h.rt.state.prefs.hermesRemote, originalRecord)
  const persistedReference = JSON.parse(h.snapshots.at(-1)).prefs.hermesRemote.credentialRef
  assert.ok(h.secrets.has(persistedReference), 'the last persisted record still has a usable credential reference')
  assert.ok(h.secrets.has(draft.credentialRef), 'the previous configuration retains its source credential')
})


const barrier = () => {
  let reach, release
  return { entered: new Promise(resolve => { reach = resolve }), held: new Promise(resolve => { release = resolve }), reach: () => reach(), release: () => release() }
}
const eventTurn = () => new Promise(resolve => setImmediate(resolve))
async function durableRuntime(t, fixture, overrides) {
  const h = runtime(t, fixture, overrides), home = await mkdtemp(join(tmpdir(), 'hermes-mutation-'))
  h.rt.statePath = join(home, 'state.json')
  const originalSave = h.rt.save
  h.rt.save = async options => { await originalSave(options); await writeFile(h.rt.statePath, JSON.stringify(h.rt.state)) }
  t.after(() => rm(home, { recursive: true, force: true }))
  return h
}

for (const rollback of [false, true]) {
  test(`hermes-mutation-lock-dropped: ${rollback ? 'rollback' : 'fresh save'} credential cleanup serializes a newer configure`, async t => {
    // This test parks a newer configure behind the mutation lock on purpose, and the
    // product starts the setup budget when the action is created, before the queue wait
    // (#1210). The fixture's 100 ms control deadline would therefore race the parked
    // window on a loaded CI host; what this test proves is the serialization, and the
    // dedicated queue-deadline test below still proves that waiting counts against it.
    // A wider budget only made the race rarer: on a starved host every phase can still
    // outlast it. So the clock stands still here: no setup timer fires and no deadline
    // check sees time pass, and the test waits on its barrier and its own events only.
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
    const f = dashboard(), h = await durableRuntime(t, f, { deadlines: { start: 1000, control: 1000, cancel: 50 } }), gate = barrier()
    await h.rt.hermesRemote.configure({ enabled: true, address: f.address, profile: 'sample-profile', credential: f.credential })
    const tested = await h.rt.hermesRemote.test(f.token), secretEndpoint = h.rt.secretEndpoint, compare = h.rt.deleteSecretIfUnchanged
    let deletedReference, newerWrite = false
    h.rt.deleteSecretIfUnchanged = async (name, expected) => { deletedReference = name; gate.reach(); await gate.held; return compare(name, expected) }
    h.rt.secretEndpoint = async (name, body) => {
      if (deletedReference && name === 'secret-set' && body.name === 'HERMES_REMOTE_CREDENTIAL') newerWrite = true
      return secretEndpoint(name, body)
    }
    if (rollback) {
      const save = h.rt.save
      let first = true
      h.rt.save = async options => { await save(options); if (first) { first = false; throw Error('Fixture candidate write failed') } }
    }
    const saving = h.rt.hermesRemote.save({ testId: tested.testId, profile: 'sample-profile' })
    const saveDone = rollback ? assert.rejects(saving) : saving
    await gate.entered
    const nextToken = randomUUID(), configuring = h.endpoints.get('hermes-remote-configure')({ enabled: true, address: f.address, profile: 'replacement-profile', credential: nextToken })
    await eventTurn()
    const queued = !newerWrite
    gate.release()
    await saveDone
    const view = await configuring
    assert.ok(queued, 'a newer configure cannot write a credential while the earlier cleanup owns the mutation lock')
    assert.ok(deletedReference)
    assert.ok(h.secrets.get(view.credentialRef) === nextToken, 'the durable replacement reference retains its newer token')
    const disk = JSON.parse(await readFile(h.rt.statePath, 'utf8'))
    assert.equal(disk.prefs.hermesRemote.credentialRef, view.credentialRef)
    assert.equal(disk.prefs.hermesRemote.profile, 'replacement-profile')
  })
}

test('hermes-mutation-lock-dropped: simultaneous saves serialize and the second cannot reuse the consumed test', async t => {
  const f = dashboard(), gate = barrier()
  let probes = 0
  const h = await durableRuntime(t, f, { beforeModels: async () => { probes++; if (probes === 2) { gate.reach(); await gate.held } } })
  const tested = await h.rt.hermesRemote.test(f.token)
  const first = h.endpoints.get('hermes-remote-save')({ testId: tested.testId, profile: 'sample-profile' })
  void first.catch(() => {})
  await gate.entered
  const second = h.rt.hermesRemote.save({ testId: tested.testId, profile: 'sample-profile' })
  void second.catch(() => {})
  await eventTurn()
  const probesWhileHeld = probes
  gate.release()
  const results = await Promise.allSettled([first, second])
  assert.equal(probesWhileHeld, 2, 'the second save cannot probe while the first owns the queue')
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'rejected')
  assert.equal(results[1].reason.code, 'bot/hermes-expired')
  assert.ok(h.secrets.has(results[0].value.credentialRef))
})


test('uncertain durable state or writer ownership keeps unreferenced credentials instead of deleting them', async t => {
  for (const kind of ['missing', 'malformed', 'referenced', 'other-writer', 'no-path', 'no-compare-helper', 'unknown-compare-helper']) {
    const f = dashboard(), h = await durableRuntime(t, f)
    await h.rt.hermesRemote.configure({ enabled: true, address: f.address, profile: 'sample-profile', credential: f.credential })
    const oldReference = h.rt.hermesRemote.view().credentialRef, tested = await h.rt.hermesRemote.test(f.token), save = h.rt.save, statePath = h.rt.statePath
    h.rt.save = async options => {
      assert.equal(options.required, true)
      await save(options)
      if (kind === 'missing') await unlink(statePath)
      if (kind === 'malformed') await writeFile(statePath, '{invalid')
      if (kind === 'referenced') { const disk = structuredClone(h.rt.state); disk.prefs.hermesRemote.credentialRef = oldReference; await writeFile(statePath, JSON.stringify(disk)) }
      if (kind === 'other-writer') h.rt.readOnly = () => 'Fixture another writer'
      if (kind === 'no-path') h.rt.statePath = undefined
      if (kind === 'no-compare-helper') h.rt.deleteSecretIfUnchanged = undefined
      if (kind === 'unknown-compare-helper') h.rt.deleteSecretIfUnchanged = async () => undefined
    }
    const view = await h.rt.hermesRemote.save({ testId: tested.testId, profile: 'sample-profile' })
    assert.ok(h.secrets.has(oldReference), `${kind}: uncertain cleanup retains the old credential`)
    assert.ok(h.secrets.has(view.credentialRef), 'the active reference remains usable')
    assert.ok(!h.secretCalls.some(call => call.endpoint === 'secret-delete'))
  }
})

test('mutation queues release after errors and are independent for separate Bot runtimes', { timeout: 1000 }, async t => {
  const gate = barrier(), f = dashboard({ handle: async path => { if (path === '/api/status') { gate.reach(); await gate.held } } }), first = runtime(t, f)
  const other = dashboard(), second = runtime(t, other)
  const pending = first.rt.hermesRemote.test(f.token)
  await gate.entered
  const view = await second.rt.hermesRemote.configure({ enabled: true, address: other.address, profile: 'sample-profile', credential: other.credential })
  assert.equal(view.address, other.address)
  gate.release(); await pending
  await assert.rejects(second.rt.hermesRemote.configure({ enabled: 'invalid' }))
  assert.equal((await second.rt.hermesRemote.configure({ enabled: false })).enabled, false)
})

test('a cancelled queued test never starts or cancels a newer request', { timeout: 1000 }, async t => {
  const f = dashboard(), h = runtime(t, f, { deadlines: { start: 500, control: 500, cancel: 100 } }), gate = barrier(), set = h.rt.secretEndpoint
  let first = true
  h.rt.secretEndpoint = async (name, body) => { if (name === 'secret-set' && first) { first = false; gate.reach(); await gate.held }; return set(name, body) }
  const configuring = h.rt.hermesRemote.configure({ enabled: true, address: f.address, profile: 'sample-profile', credential: f.credential })
  await gate.entered
  const oldRequest = randomUUID(), newerRequest = randomUUID()
  const stale = h.rt.hermesRemote.test({ ...f.token, requestId: oldRequest }), rejected = assert.rejects(stale)
  const cancelling = h.rt.hermesRemote.disconnect({ testsOnly: true, requestId: oldRequest })
  await rejected
  const newer = h.rt.hermesRemote.test({ ...f.token, requestId: newerRequest })
  gate.release(); await configuring; await cancelling
  assert.ok((await newer).testId)
  assert.equal(f.calls.length, 2, 'only the newer request performed authenticated discovery')
  assert.deepEqual(h.endpoints.get('hermes-remote-test-status')({ requestId: newerRequest }), { stage: 'connected' })
})

test('the startup deadline includes queue waiting and an expired queued test performs no work', { timeout: 1000 }, async t => {
  const f = dashboard(), h = runtime(t, f, { deadlines: { start: 30, control: 500, cancel: 100 } }), gate = barrier(), set = h.rt.secretEndpoint
  let first = true
  h.rt.secretEndpoint = async (name, body) => { if (name === 'secret-set' && first) { first = false; gate.reach(); await gate.held }; return set(name, body) }
  const configuring = h.rt.hermesRemote.configure({ enabled: true, address: f.address, profile: 'sample-profile', credential: f.credential })
  await gate.entered
  try { await assert.rejects(h.rt.hermesRemote.test(f.token), { code: 'bot/hermes-timeout' }); assert.equal(f.calls.length, 0) }
  finally { gate.release() }
  await configuring
  assert.ok((await h.rt.hermesRemote.test(f.token)).testId)
})

test('an already-running real RemoteChat Stop can finish while locked teardown awaits it', { timeout: 1000 }, async t => {
  const f = dashboard(), h = runtime(t, f, { deadlines: { start: 500, control: 500, cancel: 500 } }), gate = barrier()
  const identity = { pendingSubmit: true, runtimeSessionId: randomUUID() }
  let writes = 0, closed = false
  const transport = { listeners: new Set(), deadlines: { cancel: 500 }, bounded: promise => promise,
    request: async method => { assert.equal(method, 'session.interrupt'); gate.reach(); await gate.held; identity.pendingSubmit = false },
    close: () => { closed = true },
  }
  const run = new RemoteChat(transport, { identity, save: async () => { writes++; await h.rt.save({ required: true }) } })
  h.rt.hermesRemote.adapter.live.set('sample-live', { run })
  const stopping = run.stop()
  await gate.entered
  const disconnecting = h.rt.hermesRemote.disconnect()
  gate.release(); await stopping; await disconnecting
  assert.ok(writes >= 2)
  assert.equal(closed, true)
})


test('cookie rotation during a locked native connect persists inline without reentrant deadlock', { timeout: 1000 }, async t => {
  const rotated = randomUUID(), f = dashboard({ handle: path => path === '/api/auth/ws-ticket' ? response({ ticket: 'sample-ticket' }, 200, [`hermes_session_at=${rotated}; HttpOnly`]) : undefined })
  const h = runtime(t, f, { onConnect: async wire => { if (h.rt.hermesRemote.view().enabled) await wire.options.fetch(`${f.address}/api/auth/ws-ticket`, { headers: wire.options.authHeaders }) } })
  const tested = await h.rt.hermesRemote.test(f.login)
  const saved = await h.rt.hermesRemote.save({ testId: tested.testId, profile: 'sample-profile' })
  assert.ok((await h.rt.hermesRemote.connect()).modelRef)
  assert.ok(h.secrets.get(saved.credentialRef).includes(rotated), 'the rotated session is durably stored before connect finishes')
})


test('a public configure inheriting the active async context still queues instead of forking the owner', { timeout: 1000 }, async t => {
  const f = dashboard(), gate = barrier()
  let configuring, writesDuringOwner
  const h = runtime(t, f, { deadlines: { start: 500, control: 500, cancel: 500 }, onConnect: async () => {
    configuring = h.rt.hermesRemote.configure({ enabled: true, address: f.address, profile: 'replacement-profile', credential: randomUUID() })
    await eventTurn()
    writesDuringOwner = h.secretCalls.length
    gate.reach(); await gate.held
  } })
  const testing = h.rt.hermesRemote.test(f.token), rejected = assert.rejects(testing)
  await gate.entered
  gate.release(); await rejected; await configuring
  assert.equal(writesDuringOwner, 0, 'a public call cannot inherit trusted internal reentrancy')
  assert.equal(h.rt.hermesRemote.view().profile, 'replacement-profile')
})


for (const rollback of [false, true]) {
  test(`a direct secret replacement in the ${rollback ? 'rollback' : 'fresh save'} cleanup await gap is preserved atomically`, async t => {
    const f = dashboard(), h = await durableRuntime(t, f), gate = barrier()
    await h.rt.hermesRemote.configure({ enabled: true, address: f.address, profile: 'sample-profile', credential: f.credential })
    const tested = await h.rt.hermesRemote.test(f.token), endpoint = h.rt.secretEndpoint, compare = h.rt.deleteSecretIfUnchanged
    let pendingReference
    h.rt.secretEndpoint = async (name, body) => {
      if (name === 'secret-delete') { pendingReference = body.name; gate.reach(); await gate.held }
      return endpoint(name, body)
    }
    h.rt.deleteSecretIfUnchanged = async (name, expected) => { pendingReference = name; gate.reach(); await gate.held; return compare(name, expected) }
    if (rollback) {
      const save = h.rt.save
      let first = true
      h.rt.save = async options => { await save(options); if (first) { first = false; throw Error('Fixture candidate write failed') } }
    }
    const saving = h.rt.hermesRemote.save({ testId: tested.testId, profile: 'sample-profile' }), finished = rollback ? assert.rejects(saving) : saving
    await gate.entered
    const replacement = randomUUID()
    await h.rt.secretEndpoint('secret-set', { name: pendingReference, value: replacement, scope: [] })
    gate.release(); await finished
    assert.ok(h.secrets.get(pendingReference) === replacement, 'a changed value survives the compare-delete boundary')
    assert.ok(h.secrets.has(h.rt.hermesRemote.view().credentialRef), 'the configured credential remains usable')
  })
}


function chatWire(wire) {
  wire.epoch = 'sample-epoch'; wire.redact = value => value
  wire.deadlines = { cancel: 10 }
  wire.bounded = async (promise, milliseconds) => {
    let timer
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Fixture ignored interrupt')), milliseconds) })]) }
    finally { clearTimeout(timer) }
  }
}

test('hermes-chat-admission-fence-dropped: a real run cannot submit after replacement owns the connection FIFO', { timeout: 2000 }, async t => {
  const f = dashboard(), h = await durableRuntime(t, f, { deadlines: { start: 1000, control: 1000, cancel: 50 }, onConnect: chatWire }), gate = barrier()
  await h.rt.hermesRemote.configure({ enabled: true, address: f.address, profile: 'old-profile', credential: f.credential })
  const adapter = h.rt.hermesRemote.adapter, identity = adapter.identity('sample-chat'), run = await adapter.open({ identity, save: () => h.rt.save({ required: true }) })
  await run.prepare(); adapter.live.set('sample-chat', { run })
  const set = h.rt.secretEndpoint
  h.rt.secretEndpoint = async (name, body) => { if (name === 'secret-set') { gate.reach(); await gate.held }; return set(name, body) }
  const configuring = h.rt.hermesRemote.configure({ enabled: true, address: f.address, profile: 'new-profile', credential: randomUUID() })
  await gate.entered
  const queuedIdentity = adapter.identity('queued-old-chat')
  const submitting = run.submit('Sample prompt'), opening = adapter.open({ identity: queuedIdentity, save: () => h.rt.save({ required: true }) })
  const settled = Promise.allSettled([submitting, opening])
  const agent = { session: { id: 'queued-stream' }, ctx: { tools: { register: () => () => {} } } }, get = h.rt.ctx.get
  h.rt.ctx.get = name => name === 'agents' ? { get: () => agent, list: () => [agent] } : get(name)
  const stream = adapter.stream(markAgentLoopRequest({ provider: 'hermes-remote', model: 'sample:model', sessionId: agent.session.id, messages: [{ role: 'user', content: 'Sample queued prompt' }] }))
  const queuedRow = stream.next()
  await eventTurn()
  const admittedWhileOwned = run.transport.sent.some(frame => frame.method === 'prompt.submit')
  gate.release(); await configuring
  const [submission, queuedOpen] = await settled
  assert.equal(queuedOpen.status, 'rejected', 'an old queued open cannot bind itself to the replacement profile')
  assert.equal(queuedOpen.reason.code, 'bot/hermes-busy')
  const row = await queuedRow
  assert.equal(row.value.reason.failure.message, 'A chat is still running on this connection; stop it or wait.')
  await stream.return()
  assert.equal(admittedWhileOwned, false, 'no prompt bytes leave while connection replacement owns the FIFO')
  assert.equal(submission.status, 'rejected')
  assert.equal(submission.reason.code, 'bot/hermes-busy')
  assert.ok(!run.transport.sent.some(frame => frame.method === 'prompt.submit'))
})

test('a real adapter stream admitted first keeps its uncertain identity and blocks profile or credential replacement', { timeout: 2000 }, async t => {
  const session = barrier(), admission = barrier(), f = dashboard()
  const h = await durableRuntime(t, f, { deadlines: { start: 1000, control: 1000, cancel: 50 }, beforeSession: async () => { session.reach(); await session.held }, onConnect: chatWire, onRequest: method => { if (method === 'prompt.submit') admission.reach() } })
  await h.rt.hermesRemote.configure({ enabled: true, address: f.address, profile: 'old-profile', credential: f.credential })
  h.rt.state.prefs.hermesRemote.models = [{ id: 'sample:model', name: 'Sample', model: 'model', provider: 'sample' }]
  await h.rt.save()
  const agent = { session: { id: 'sample-stream' }, ctx: { tools: { register: () => () => {} } } }, get = h.rt.ctx.get
  h.rt.ctx.get = name => name === 'agents' ? { get: () => agent, list: () => [agent] } : get(name)
  const stream = h.rt.hermesRemote.adapter.stream(markAgentLoopRequest({ provider: 'hermes-remote', model: 'sample:model', sessionId: agent.session.id, messages: [{ role: 'user', content: 'Sample prompt' }] }))
  const row = stream.next()
  await session.entered
  const identity = h.rt.state.hermesSessions[agent.session.id], run = h.rt.hermesRemote.adapter.live.get(agent.session.id).run
  const oldRecord = h.rt.state.prefs.hermesRemote, oldSecret = h.secrets.get(oldRecord.credentialRef)
  const configuring = h.rt.hermesRemote.configure({ enabled: true, address: f.address, profile: 'new-profile', credential: randomUUID() }), result = Promise.allSettled([configuring])
  await eventTurn(); session.release(); await admission.entered
  const [replacement] = await result
  try {
    assert.equal(replacement.status, 'rejected')
    assert.equal(replacement.reason.code, 'bot/hermes-busy')
    assert.equal(h.rt.state.prefs.hermesRemote, oldRecord)
    assert.equal(h.rt.state.hermesSessions[agent.session.id], identity)
    assert.ok(identity.pendingSubmit || identity.uncertain)
    assert.ok(h.secrets.get(oldRecord.credentialRef) === oldSecret, 'busy refusal preserves the old key')
    assert.ok(JSON.parse(await readFile(h.rt.statePath, 'utf8')).hermesSessions[agent.session.id].storedSessionId)
  } finally { run.push({ kind: 'error', text: 'Fixture turn ended' }); await row; await stream.return() }
})

for (const save of [false, true]) {
  test(`hermes-replaceability-recheck-dropped: ${save ? 'test-save' : 'configure'} refuses uncertainty discovered by real ignored Stop before changing keys`, { timeout: 2000 }, async t => {
    const f = dashboard(), h = await durableRuntime(t, f, { deadlines: { start: 1000, control: 1000, cancel: 50 } })
    await h.rt.hermesRemote.configure({ enabled: true, address: f.address, profile: 'old-profile', credential: f.credential })
    const tested = save ? await h.rt.hermesRemote.test(f.token) : undefined
    const identity = h.rt.hermesRemote.adapter.identity('sample-stop')
    Object.assign(identity, { runtimeSessionId: randomUUID(), storedSessionId: randomUUID() })
    const transport = { listeners: new Set(), sent: [], close() {}, request: async method => { transport.sent.push(method); return {} } }
    chatWire(transport)
    const run = new RemoteChat(transport, { identity, save: () => h.rt.save({ required: true }) }), stop = run.stop.bind(run)
    run.stop = () => { identity.pendingSubmit = true; return stop() }
    h.rt.hermesRemote.adapter.live.set('sample-stop', { run })
    const oldRecord = h.rt.state.prefs.hermesRemote, oldSecret = h.secrets.get(oldRecord.credentialRef), writes = h.secretCalls.length
    await h.rt.save()
    const replacing = save ? h.rt.hermesRemote.save({ testId: tested.testId, profile: 'sample-profile' }) : h.rt.hermesRemote.configure({ enabled: true, address: f.address, profile: 'new-profile', credential: randomUUID() })
    await assert.rejects(replacing, { code: 'bot/hermes-busy', message: 'A chat is still running on this connection; stop it or wait.' })
    assert.equal(h.rt.state.prefs.hermesRemote, oldRecord)
    assert.equal(h.rt.state.hermesSessions['sample-stop'], identity)
    assert.equal(identity.uncertain, true)
    assert.ok(h.secrets.get(oldRecord.credentialRef) === oldSecret)
    assert.equal(h.secretCalls.length, writes, 'no credential is written or removed before the post-Stop guard')
    assert.equal(JSON.parse(await readFile(h.rt.statePath, 'utf8')).hermesSessions['sample-stop'].storedSessionId, identity.storedSessionId)
  })
}


test('an admitted turn also blocks same-profile credential replacement through configure and test-save', async t => {
  for (const save of [false, true]) {
    const f = dashboard(), h = await durableRuntime(t, f)
    await h.rt.hermesRemote.configure({ enabled: true, address: f.address, profile: 'sample-profile', credential: f.credential })
    const tested = save ? await h.rt.hermesRemote.test(f.token) : undefined
    const identity = h.rt.hermesRemote.adapter.identity('same-profile-chat')
    Object.assign(identity, { pendingSubmit: true, runtimeSessionId: randomUUID(), storedSessionId: randomUUID() })
    const record = h.rt.state.prefs.hermesRemote, secret = h.secrets.get(record.credentialRef), writes = h.secretCalls.length
    const changing = save ? h.rt.hermesRemote.save({ testId: tested.testId, profile: 'sample-profile' }) : h.rt.hermesRemote.configure({ enabled: true, address: f.address, profile: 'sample-profile', credential: randomUUID() })
    await assert.rejects(changing, { code: 'bot/hermes-busy' })
    assert.equal(h.rt.state.prefs.hermesRemote, record)
    assert.equal(h.rt.state.hermesSessions['same-profile-chat'], identity)
    assert.ok(h.secrets.get(record.credentialRef) === secret)
    assert.equal(h.secretCalls.length, writes)
  }
})


for (const cancel of [true, false]) {
  test(`hermes-chat-admission-cancel-wait-dropped: real adapter ${cancel ? 'Stop' : 'startup deadline'} settles queued admission while settings persistence remains blocked`, { timeout: 2000 }, async t => {
    const opened = barrier(), loaded = barrier(), writing = barrier(), controller = new AbortController(), f = dashboard()
    const limits = { start: cancel ? 1000 : 40, control: 1000, cancel: 10 }
    const h = await durableRuntime(t, f, { deadlines: limits, onConnect: async wire => { chatWire(wire); opened.reach(); await opened.held } })
    await h.rt.hermesRemote.configure({ enabled: true, address: f.address, profile: 'old-profile', credential: f.credential })
    h.rt.state.prefs.hermesRemote.models = [{ id: 'sample:model', name: 'Sample', model: 'model', provider: 'sample' }]
    await h.rt.save()
    const agent = { session: { id: 'queued-admission' }, ctx: { tools: { register: () => () => {} } } }, get = h.rt.ctx.get
    h.rt.ctx.get = name => name === 'agents' ? { get: () => agent, list: () => [agent] } : get(name)
    const stream = h.rt.hermesRemote.adapter.stream(markAgentLoopRequest({ provider: 'hermes-remote', model: 'sample:model', sessionId: agent.session.id, signal: controller.signal, messages: [{ role: 'user', content: 'Sample prompt' }] }))
    const row = stream.next()
    await opened.entered
    const load = h.rt.load, set = h.rt.secretEndpoint
    h.rt.load = async () => { loaded.reach(); await loaded.held; return load() }
    h.rt.secretEndpoint = async (name, body) => { if (name === 'secret-set') { writing.reach(); await writing.held }; return set(name, body) }
    const configuring = h.rt.hermesRemote.configure({ enabled: true, address: f.address, profile: 'new-profile', credential: randomUUID() })
    opened.release(); await loaded.entered; await eventTurn()
    assert.ok(h.rt.hermesRemote.adapter.live.has(agent.session.id), 'the old run reached adapter admission before teardown')
    loaded.release(); await writing.entered
    if (cancel) controller.abort()
    let timer, returned
    try {
      returned = await Promise.race([row.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), cancel ? limits.cancel * 4 : limits.start * 3) })])
    } finally {
      clearTimeout(timer); writing.release(); await configuring; await row; await stream.return()
    }
    await eventTurn()
    assert.equal(returned, true, 'queued admission must settle before the settings owner releases its lock')
    assert.ok(h.wires.every(wire => !wire.sent.some(frame => frame.method === 'prompt.submit')), 'cancelled or expired queued work never submits later')
  })
}
