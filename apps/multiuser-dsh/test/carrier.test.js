import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import { callerOf } from '../../bots-dsh/src/host/multiuser.js'
import { createCarrier } from '../src/carrier.js'
import { createNonces } from '../src/nonces.js'
import { carrier, invoke, prefix, rpc, seconds, target, wire } from './runtime.mjs'

test('attribution is deeply immutable, isolated across overlapping calls and peers are always disposed', async t => {
  const f = carrier(t)
  f.ctx.provide('automagikCaller', { version: 1, current: f.scope.current })
  const dispose = t.mock.method(Peer.prototype, 'dispose')
  const joined = Promise.withResolvers()
  const callers = []
  f.observe(async (_endpoint, body, _signal, peer) => {
    const principal = peer.principal
    callers.push(principal.person.subject)
    if (callers.length === 2) joined.resolve()
    await joined.promise
    await setImmediate()
    assert.equal(callerOf(f.ctx), principal)
    assert.ok(Object.isFrozen(principal) && Object.isFrozen(principal.person) && Object.isFrozen(principal.person.roles))
    if (body.throw) throw new Error('fixture handler failed')
    return { ok: true, value: principal.person.subject }
  })
  const call = (subject, fail) => f.call(target, {
    assertion: f.key.assertion({ principal: { ...wire.payload.principal, subject } }),
    body: rpc('fixture', { throw: fail }),
  })
  const responses = await Promise.all([call('one', false), call('two', true)])
  assert.equal(JSON.parse(responses[0].bytes).result.value, 'one')
  assert.equal(responses[1].status, 500)
  assert.match(responses[1].bytes.toString(), /fixture handler failed/)
  assert.equal(callerOf(f.ctx), undefined)
  assert.deepEqual(callers.sort(), ['one', 'two'])
  assert.equal(dispose.mock.callCount(), 2)
})

test('carrier checks the Host, browser metadata, assertion count and exact target before dispatch', async t => {
  const f = carrier(t)
  let calls = 0
  f.observe(() => { calls++; return { ok: true } })
  for (const headers of [{ host: 'wrong' }, { origin: 'https://other.invalid' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await f.call(target, { headers })).status, 403)
  }
  const assertion = f.key.assertion()
  assert.equal((await f.call(target, { rawHeaders: ['host', f.authority, 'Host', f.authority] })).status, 403)
  assert.equal((await f.call(target, { rawHeaders: ['host', f.authority, 'x-automagik-caller', assertion, 'X-Automagik-Caller', assertion] })).status, 401)
  assert.equal((await f.call(target, { headers: { 'x-automagik-caller': undefined, 'x-automagik-principal': 'forged' } })).status, 401)
  for (const [path, method] of [[target, 'GET'], ['/api/other?b=2&a=%20&a=1', 'POST'], ['/api/fixture?b=1&a=%20&a=1', 'POST']]) {
    assert.equal((await f.call(path, { method, assertion })).status, 401)
  }
  for (const [path, method] of [['/', 'POST'], ['/connect', 'GET'], ['/_gate/sessions', 'GET'], ['/_automagik/caller', 'GET']]) {
    assert.equal((await f.call(path, { method })).status, 401, path)
  }
  assert.equal(calls, 0)
  assert.equal((await carrier(t, { multiuser: false }).call()).status, 401)
  assert.equal((await carrier(t, { keysConfigured: false }).call()).status, 401)
})

test('declared and observed oversized bodies refuse before dispatch and a body below the limit succeeds', async t => {
  const payload = rpc()
  const limit = Buffer.byteLength(payload) + 1
  const f = carrier(t, { maxRequestBodyBytes: limit })
  let calls = 0
  f.observe(() => { calls++; return { ok: true } })
  assert.equal((await f.call(target, { headers: { 'content-length': String(limit + 1) } })).status, 413)
  assert.equal((await f.call(target, { chunks: [payload, '  '] })).status, 413)
  assert.equal(calls, 0)
  assert.equal((await f.call(target, { body: payload, headers: { 'content-length': String(limit - 1) } })).status, 200)
  assert.equal(calls, 1)
})

test('non-owners cannot reach a streaming exact route and its unread upload closes', async t => {
  const f = carrier(t)
  let calls = 0
  f.connection.fetch.register({
    path: '/api/stream', methods: ['POST'], requestBody: 'streaming',
    fetch: () => { calls++; return new Response() },
  })
  const reply = await f.call('/api/stream', { body: 'unread' })
  assert.equal(reply.status, 403)
  assert.equal(reply.bytes.toString(), 'forbidden')
  assert.equal(reply.headers.connection, 'close')
  assert.equal(calls, 0)
})

test('a newly created carrier refuses a still-valid assertion from the earlier carrier', async t => {
  const f = carrier(t)
  f.observe(() => ({ ok: true }))
  const assertion = f.key.assertion({ iat: seconds + 4 })
  assert.equal((await f.call(target, { assertion, body: rpc() })).status, 200)
  const restarted = createCarrier({
    ...f, keys: f.key.keys, nonces: createNonces({ startedAtSec: seconds }),
    multiuser: true, keysConfigured: true, expectedAuthority: () => f.authority,
    now: () => (seconds + 1) * 1000,
  })
  const replay = await invoke(restarted, {
    url: prefix + target, method: 'POST',
    headers: { host: f.authority, 'x-automagik-caller': assertion, 'content-type': 'application/json' },
    body: rpc(),
  })
  assert.equal(replay.status, 401)
})

test('a restart after wall-clock rollback cuts off assertions using the persisted verification second', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'caller-watermark-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'multiuser-dsh', 'caller-watermark')
  const nonces = createNonces({ startedAtSec: seconds - 6, file })
  const f = carrier(t, { nonces })
  f.observe(() => ({ ok: true }))
  const assertion = f.key.assertion({ iat: seconds + 5 })
  assert.equal((await f.call(target, { assertion, body: rpc() })).status, 200)
  assert.equal(Number(readFileSync(file, 'utf8')), seconds)
  assert.equal(statSync(file).mode & 0o777, 0o600)

  let nowSec = seconds - 1
  const restarted = createCarrier({
    ...f, keys: f.key.keys, nonces: createNonces({ startedAtSec: nowSec, file }),
    multiuser: true, keysConfigured: true, expectedAuthority: () => f.authority,
    now: () => nowSec * 1000,
  })
  const send = value => invoke(restarted, {
    url: prefix + target, method: 'POST',
    headers: { host: f.authority, 'x-automagik-caller': value, 'content-type': 'application/json' },
    body: rpc(),
  })
  nowSec = seconds
  assert.equal((await send(assertion)).status, 401)
  nowSec = seconds + 1
  assert.equal((await send(f.key.assertion({ iat: seconds + 6 }))).status, 200)
  assert.equal(Number(readFileSync(file, 'utf8')), seconds + 1)
  writeFileSync(file, 'unreadable watermark')
  assert.equal(createNonces({ startedAtSec: nowSec, file }).startupSecond, nowSec)
  assert.equal(createNonces({ startedAtSec: nowSec, file: dir }).startupSecond, nowSec)
})

test('both sides share a frontend allowlist and refuse unrelated resources before dispatch', async t => {
  const requested = []
  const resource = request => {
    requested.push(new URL(request.url).pathname)
    for (const name of ['cookie', 'authorization', 'x-automagik-caller', 'x-automagik-principal', 'origin']) {
      assert.equal(request.headers.get(name), null)
    }
    assert.equal(request.headers.get('host'), f.authority)
    return new Response('resource')
  }
  const f = carrier(t, { staticResource: resource, appResource: resource, clientModules: () => ({ fetchBundle: request => {
    requested.push(new URL(request.url).pathname)
    return new Response('bundle')
  } }) })
  const paths = JSON.parse(readFileSync(new URL('../../../server/test/fixtures/caller-frontend-paths.json', import.meta.url)))
  f.webServer.registerFallback({ resource: () => assert.fail('unrelated fallback was dispatched') })
  f.webServer.register({ kind: 'exact', path: '/private.json', resource() {
    assert.fail('unrelated GET resource was dispatched')
  } })
  for (const path of paths.allowed) assert.equal((await f.call(path, { method: 'GET', headers: {
    cookie: 'untrusted', authorization: 'untrusted', 'x-automagik-principal': 'spoofed',
  } })).status, 200, path)
  assert.equal(requested.length, paths.allowed.length)
  for (const raw of paths.refused) {
    const url = new URL(raw, 'http://dsh.internal')
    assert.equal((await f.call(url.pathname + url.search, { method: 'HEAD' })).status, 404, raw)
  }
  assert.equal(requested.length, paths.allowed.length)
})

test('closing the response during dispatch aborts the Request signal', async t => {
  const f = carrier(t)
  const entered = Promise.withResolvers()
  const aborted = Promise.withResolvers()
  f.observe(async (_endpoint, _body, signal) => {
    signal.addEventListener('abort', () => aborted.resolve(signal), { once: true })
    entered.resolve()
    await aborted.promise
    return { ok: true, value: null }
  })
  let response
  const inFlight = f.call(target, { body: rpc(), onTransport(_req, res) { response = res } })
  await entered.promise
  response.destroy()
  assert.equal((await aborted.promise).aborted, true)
  await inFlight
})
