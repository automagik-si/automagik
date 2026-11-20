import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

function watermarkFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'caller-watermark-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'state', 'watermark')
}

function clockCarrier(t) {
  const file = watermarkFile(t)
  let wall = seconds
  let mono = 0
  const monotonicNow = () => mono
  const now = () => wall * 1000
  const nonces = createNonces({ startedAtSec: seconds - 6, file, monotonicNow })
  const f = carrier(t, { nonces, now })
  const handler = t.mock.fn(() => ({ ok: true }))
  f.observe(handler)
  const assertion = (iat = wall) => f.key.assertion({ iat, exp: iat + 30 })
  const send = value => f.call(target, { assertion: value, body: rpc() })
  const advance = (nextWall, elapsedMs) => {
    wall = nextWall
    mono += elapsedMs
  }
  const restart = () => {
    const restarted = createCarrier({
      ...f, keys: f.key.keys, nonces: createNonces({ startedAtSec: wall, file, monotonicNow }),
      multiuser: true, keysConfigured: true, expectedAuthority: () => f.authority, now,
    })
    return value => invoke(restarted, {
      url: prefix + target, method: 'POST',
      headers: { host: f.authority, 'x-automagik-caller': value, 'content-type': 'application/json' },
      body: rpc(),
    })
  }
  return { file, nonces, handler, assertion, send, advance, restart }
}

test('a rollback refuses the delayed first use of an assertion that was valid before the step', async t => {
  const f = clockCarrier(t)
  const unused = f.assertion()
  f.advance(seconds + 1, 1000)
  assert.equal((await f.send(f.assertion())).status, 200)
  f.advance(seconds - 599, 40_000)
  assert.equal((await f.send(unused)).status, 401)
  assert.equal(f.handler.mock.callCount(), 1)
  assert.equal(f.nonces.startupSecond, seconds + 41)
  assert.equal(Number(readFileSync(f.file, 'utf8')), seconds + 41)
})

test('the rollback cutoff survives restart and allows fresh assertions as the wall recovers', async t => {
  const f = clockCarrier(t)
  assert.equal((await f.send(f.assertion())).status, 200)
  f.advance(seconds - 600, 40_000)
  assert.equal((await f.send(f.assertion())).status, 401)
  const cutoff = seconds + 40
  assert.equal(f.nonces.startupSecond, cutoff)
  f.advance(seconds - 590, 10_000)
  const restarted = f.restart()
  f.advance(cutoff + 5, (cutoff + 5 - (seconds - 590)) * 1000)
  const atCutoff = f.assertion()
  assert.equal((await f.send(atCutoff)).status, 401)
  assert.equal((await restarted(atCutoff)).status, 401)
  assert.equal(f.handler.mock.callCount(), 1)
  f.advance(cutoff + 6, 1000)
  assert.equal((await f.send(f.assertion())).status, 200)
  assert.equal((await restarted(f.assertion())).status, 200)
  assert.equal(f.handler.mock.callCount(), 3)
})

test('corrupt and unreadable watermark files refuse before verification and a missing file starts fresh', async t => {
  const file = watermarkFile(t)
  const log = t.mock.method(console, 'error', () => {})
  const start = { startedAtSec: seconds - 6, anchorSec: seconds, file }
  mkdirSync(dirname(file))
  for (const contents of ['broken JSON', '-1', '1.5', '"x"', '', undefined]) {
    if (contents === undefined) mkdirSync(file)
    else writeFileSync(file, contents)
    const nonces = createNonces(start)
    const consume = t.mock.method(nonces, 'consume')
    const f = carrier(t, { nonces })
    const lookup = t.mock.method(f.key.keys, 'get')
    const handler = t.mock.fn(() => ({ ok: true }))
    f.observe(handler)
    const assertion = f.key.assertion()
    assert.equal((await f.call(target, { assertion: 'malformed', body: rpc() })).status, 503)
    for (let i = 0; i < 2; i++) assert.equal((await f.call(target, { assertion, body: rpc() })).status, 503)
    assert.equal(lookup.mock.callCount(), 0)
    assert.equal(handler.mock.callCount(), 0)
    assert.equal(consume.mock.callCount(), 0)
    rmSync(file, { recursive: true })

    const repaired = carrier(t, { nonces: createNonces(start), keys: f.key.keys })
    repaired.observe(handler)
    assert.equal((await repaired.call(target, { assertion, body: rpc() })).status, 200)
    assert.equal(handler.mock.callCount(), 1)
    rmSync(file)
  }
  assert.equal(log.mock.callCount(), 6)
  assert.ok(log.mock.calls.every(({ arguments: [message] }) => message.includes(file)))
})

test('a same-second watermark write retry keeps refusing until persistence succeeds', async t => {
  const file = watermarkFile(t)
  const nonces = createNonces({ startedAtSec: seconds - 6, file })
  const f = carrier(t, { nonces })
  const handler = t.mock.fn(() => ({ ok: true }))
  const consume = t.mock.method(nonces, 'consume')
  f.observe(handler)
  writeFileSync(dirname(file), 'blocks mkdir')
  const assertion = f.key.assertion()
  const send = () => f.call(target, { assertion, body: rpc() })
  assert.equal((await send()).status, 503)
  assert.equal((await send()).status, 503)
  assert.equal(consume.mock.callCount(), 0)
  assert.equal(handler.mock.callCount(), 0)
  rmSync(dirname(file))
  assert.equal((await send()).status, 200)
  assert.equal(handler.mock.callCount(), 1)
  assert.equal(Number(readFileSync(file, 'utf8')), seconds)
})

test('a failed rollback write retains the pending cutoff after wall time recovers', async t => {
  const f = clockCarrier(t)
  const unused = f.assertion()
  f.advance(seconds + 1, 1000)
  assert.equal((await f.send(f.assertion())).status, 200)
  const backup = f.file + '.backup'
  renameSync(f.file, backup)
  mkdirSync(f.file)
  f.advance(seconds - 599, 40_000)
  assert.equal((await f.send(unused)).status, 503)
  f.advance(seconds + 2, 1000)
  assert.equal((await f.send(unused)).status, 503)
  assert.equal(f.handler.mock.callCount(), 1)
  assert.equal(f.nonces.startupSecond, seconds - 6)
  assert.equal(Number(readFileSync(backup, 'utf8')), seconds + 1)
  rmSync(f.file, { recursive: true })
  renameSync(backup, f.file)
  assert.equal((await f.send(unused)).status, 401)
  assert.equal(f.handler.mock.callCount(), 1)
  assert.equal(f.nonces.startupSecond, seconds + 41)
  assert.equal(Number(readFileSync(f.file, 'utf8')), seconds + 41)
  f.advance(seconds + 47, 45_000)
  assert.equal((await f.send(f.assertion())).status, 200)
})

test('frequent small rollbacks accumulate and refuse an unused assertion after its lifetime', async t => {
  const f = clockCarrier(t)
  const unused = f.assertion()
  assert.equal((await f.send(f.assertion())).status, 200)
  for (let elapsed = 2; elapsed < 40; elapsed += 2) {
    f.advance(seconds, 2000)
    await f.send(f.assertion())
  }
  f.advance(seconds, 2000)
  assert.equal((await f.send(unused)).status, 401)
  assert.equal(f.nonces.startupSecond, seconds + 6)
})

test('500 ms clock observations refuse an unused assertion after 40 seconds with the wall held', async t => {
  const f = clockCarrier(t)
  const unused = f.assertion()
  assert.equal((await f.send(f.assertion())).status, 200)
  for (let elapsed = 500; elapsed < 40_000; elapsed += 500) {
    f.advance(seconds, 500)
    await f.send(f.assertion())
  }
  f.advance(seconds, 500)
  assert.equal((await f.send(unused)).status, 401)
})

test('C5D1 only two raw pairs are offered to the v1 route provider', async t => {
  const calls = []
  let provider = { version: 1, match: (path, method) => {
    calls.push([method, path])
    return () => new Response('caller')
  } }
  const f = carrier(t, { callerRoutes: () => provider })
  const post = '/api/omni-ui', feed = post + '/feed'
  assert.equal((await f.call(post)).bytes.toString(), 'caller')
  assert.equal((await f.call(feed, { method: 'GET' })).bytes.toString(), 'caller')
  for (const [method, raw] of [
    ['POST', post + '?x=1'], ['POST', post + '?'], ['POST', '/api/./omni-ui'], ['POST', '/api/x/../omni-ui'],
    ['POST', post + '/'], ['POST', '/api//omni-ui'], ['POST', '/api/omni%2Dui'],
    ['HEAD', feed], ['POST', feed], ['GET', post + '/image'],
  ]) {
    const path = new URL(raw, 'http://x')
    const assertion = f.key.assertion({ method, path: path.pathname + path.search })
    assert.equal((await f.call(raw, { method, assertion })).status, 404, method + ' ' + raw)
  }
  assert.deepEqual(calls, [['POST', post], ['GET', feed]])
  for (const missing of [undefined, { version: 2 }, { version: 1, match: () => undefined }]) {
    provider = missing
    assert.equal((await f.call(post)).status, 404)
  }
  provider = { version: 1, match() { throw new Error('private message') } }
  const refused = await f.call(post)
  assert.equal(refused.status, 500)
  assert.equal(refused.bytes.length, 0)
})

test('C5D2 pair body limits are shared with the gate and release POST slots after refusals', async t => {
  const { CALLER_PAIRS } = await import('../src/carrier.js')
  const { targets } = (await import('../../../server/test/fixtures/caller-role-paths.json', { with: { type: 'json' } })).default
  assert.deepEqual(CALLER_PAIRS, new Map(targets.filter(row => row.callerRoute).map(row => [row.method + ' ' + row.path, row.maxBody])))
  let calls = 0
  const f = carrier(t, { callerSlots: 1, maxRequestBodyBytes: 100, callerRoutes: () => ({
    version: 1, match: () => () => { calls++; return new Response() },
  }) })
  const path = '/api/omni-ui'
  for (const options of [
    { headers: { 'content-length': '101' } },
    { chunks: ['x'.repeat(100), 'y'] },
  ]) assert.equal((await f.call(path, options)).status, 413)
  assert.equal((await f.call(path + '/feed', { method: 'GET', body: 'x' })).status, 413)
  assert.equal((await f.call(path + '/feed', { method: 'GET', headers: { 'content-length': '1' } })).status, 413)
  assert.equal(calls, 0)
  assert.equal((await f.call(path, { body: 'x'.repeat(100) })).status, 200)
  assert.equal(calls, 1)
})

test('C5D3 the matched handler runs in the admitted scope with its registered Peer', async t => {
  const { createPeerRegistry } = await import('../src/peers.js')
  const registry = createPeerRegistry()
  let admitted, calls = 0
  const f = carrier(t, { registry, callerRoutes: () => ({
    version: 1, match: () => async (_request, principal, peer) => {
      calls++
      admitted = peer
      await setImmediate()
      assert.equal(registry.live(peer), true)
      assert.equal(peer.principal, principal)
      assert.equal(f.scope.current(), principal)
      return new Response('read')
    },
  }) })
  const response = await f.call('/api/omni-ui')
  assert.equal(response.status, 200)
  assert.equal(response.bytes.toString(), 'read')
  assert.equal(calls, 1)
  assert.equal(f.scope.current(), undefined)
  assert.equal(registry.live(admitted), false)
})
