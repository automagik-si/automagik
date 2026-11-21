import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import fs, { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import { RemoteAccessService } from '@deepseek-ai/dsh-api-remote-access'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { callerOf, callerService } from '../../bots-dsh/src/host/multiuser.js'
import * as adapter from '../index.js'
import { verifyOwner } from '../src/assertion.js'
import { createMuxCarrier, MUX_PATH } from '../src/mux-carrier.js'
import { createNonces } from '../src/nonces.js'
import { carrier, invoke, prefix, rpc, runtime,
  seconds, signingKey, target, wire } from './runtime.mjs'

const path = '/api/omni-ui'
const field = 'x-automagik-owner-assertion'
const ownerType = 'automagik-owner-caller'
const instance = wire.payload.aud
const principal = { ...wire.payload.principal, roles: ['admin', 'guest'] }
const ownerToken = (key, claims = {}) => key.assertion({ principal, method: 'POST', path,
  iat: seconds, exp: seconds + 30, ...claims }, { typ: ownerType })
const ownerRequest = (assertion, { url = path, method = 'POST' } = {}) =>
  new Request('http://localhost' + url, { method, headers: { [field]: assertion } })
const accepted = { principal, session: wire.payload.session }

function verification({ nonces, now = () => seconds * 1000, key = signingKey() } = {}) {
  nonces ??= createNonces({ startedAtSec: seconds - 10, anchorSec: seconds })
  const check = (assertion, opts) => verifyOwner(ownerRequest(assertion, opts), {
    keys: key.keys, instance, nonces, now,
  })
  return { key, check, nonces }
}

test('verifyOwner accepts an owner assertion once across concurrent copies', async () => {
  const f = verification()
  const assertion = ownerToken(f.key)
  const copy = () => Promise.resolve().then(() => f.check(assertion))
  const checks = await Promise.all(Array.from({ length: 5 }, copy))
  assert.deepEqual(checks, [accepted, undefined, undefined, undefined, undefined])
  assert.equal(f.check(assertion), undefined)
  const owner = { ...principal, roles: ['owner'] }
  const result = f.check(ownerToken(f.key, { principal: owner }))
  assert.deepEqual(result, { ...accepted, principal: owner })
})

test('verifyOwner refuses duplicates, wrong routes or methods, expiry and missing fields', () => {
  const f = verification()
  const assertion = ownerToken(f.key)
  const mismatches = [{ method: 'GET' }, { url: path + '?x' }, { url: path + '/' },
    { url: '/api/other' }]
  for (const options of mismatches) {
    assert.equal(f.check(assertion, options), undefined)
  }
  const duplicate = new Request('http://localhost' + path, {
    method: 'POST', headers: [[field, assertion], ['X-Automagik-Owner-Assertion', assertion]],
  })
  const verify = req => verifyOwner(req, { keys: f.key.keys, nonces: f.nonces,
    now: () => seconds * 1000 })
  assert.equal(verify(duplicate), undefined)
  assert.deepEqual(f.check(assertion), accepted)
  for (const claims of [
    { exp: seconds }, { exp: seconds + 61 }, { iat: seconds + 6 }, { iat: seconds - 5 },
    { session: undefined }, { session: 'A'.repeat(42) + 'B' }, { session: 'wrong' },
    { method: 'GET' }, { path: '/api/other' }, { path: path + '?x' },
    { principal: { ...principal, roles: ['member'] } },
    { principal: { ...principal, roles: ['admin', 'admin'] } },
    { aud: 'other' }, { nonce: 'wrong' },
  ]) assert.equal(f.check(ownerToken(f.key, claims)), undefined, JSON.stringify(claims))
  assert.equal(f.check(f.key.assertion({ method: 'POST', path })), undefined)
})

test('verifyOwner preserves the nonce on bad signatures and refuses a full store', () => {
  const nonces = createNonces({ capacity: 1, startedAtSec: seconds - 10, anchorSec: seconds })
  const f = verification({ nonces })
  const assertion = ownerToken(f.key)
  const [h, p, signature] = assertion.split('.')
  const initial = signature[0] === 'A' ? 'B' : 'A'
  assert.equal(f.check(`${h}.${p}.${initial}${signature.slice(1)}`), undefined)
  assert.deepEqual(f.check(assertion), accepted)
  assert.equal(f.check(ownerToken(f.key)), undefined)
})

test('verifyOwner refuses a broken watermark and replay across replacement or rollback', t => {
  const dir = mkdtempSync(join(tmpdir(), 'owner-watermark-'))
  t.after(() => rmSync(dir, { force: true, recursive: true }))
  const file = join(dir, 'watermark')
  const key = signingKey()
  const assertion = ownerToken(key)
  writeFileSync(file, 'broken')
  assert.equal(verification({ key, nonces: createNonces({ file }) }).check(assertion), undefined)
  rmSync(file)
  let mono = 0, wall = seconds
  const nonces = () => createNonces({ file, startedAtSec: seconds - 10,
    anchorSec: wall, monotonicNow: () => mono })
  const current = verification({ key, nonces: nonces(), now: () => wall * 1000 })
  assert.deepEqual(current.check(assertion), accepted)
  assert.equal(verification({ key, nonces: nonces() }).check(assertion), undefined)
  mono += 20_000
  wall -= 30
  assert.equal(current.check(ownerToken(key, { iat: seconds + 1, exp: seconds + 31 })), undefined)
})

test('owner and carrier admissions consume the same nonce in either order', async t => {
  for (const ownerFirst of [true, false]) {
    const nonces = createNonces({ startedAtSec: seconds - 10, anchorSec: seconds })
    const f = carrier(t, { nonces })
    const check = verification({ nonces, key: f.key }).check
    const nonce = randomBytes(16).toString('base64url')
    const owner = ownerToken(f.key, { nonce })
    const member = f.key.assertion({ nonce })
    f.observe(() => ({ ok: true, value: null }))
    if (ownerFirst) assert.deepEqual(check(owner), accepted)
    const result = await f.call(target, { assertion: member, body: rpc() })
    assert.equal(result.status, ownerFirst ? 401 : 200)
    assert.equal(check(owner), undefined)
  }
})

test('HTTP and mux reject owner-typed assertions with otherwise matching claims', async t => {
  const nonces = createNonces({ startedAtSec: seconds - 10, anchorSec: seconds })
  const f = carrier(t, { nonces })
  const bogus = claims => f.key.assertion(claims, { typ: ownerType })
  assert.equal((await f.call(target, { assertion: bogus({}), body: rpc() })).status, 401)
  const headers = { host: f.authority,
    'x-automagik-caller': bogus({ method: 'GET', path: '/api/remote.mux' }) }
  const socket = new EventEmitter()
  socket.destroy = () => socket.emit('close')
  socket.end = (frame, done) => { assert.match(frame, /^HTTP\/1\.1 401 /); done() }
  const closed = once(socket, 'close')
  const carry = createMuxCarrier({
    ready: () => ({}), admission: { keys: f.key.keys, nonces, multiuser: true, keysConfigured: true,
      expectedAuthority: () => f.authority, now: () => seconds * 1000 },
  })
  const req = { method: 'GET', url: MUX_PATH, headers, rawHeaders: Object.entries(headers).flat() }
  carry(req, socket, Buffer.alloc(0))
  await closed
})

async function mount(t) {
  const { ctx, webServer } = runtime(t)
  const key = signingKey()
  const dir = mkdtempSync(join(tmpdir(), 'owner-adapter-'))
  const file = join(dir, 'caller-keys.json')
  writeFileSync(file, JSON.stringify({ version: 1, instance, keys: [key.published] }))
  t.after(() => rmSync(dir, { force: true, recursive: true }))
  const nodeRead = fs.readFileSync
  const read = t.mock.method(fs, 'readFileSync', (path, ...args) => {
    if (path === '/proc/self/mountinfo') return `2 1 0:2 / ${dir} ro - tmpfs tmpfs rw`
    if (typeof path === 'string' && path.startsWith('/proc/self/fdinfo/')) return 'mnt_id:\t2\n'
    return nodeRead(path, ...args)
  })
  syncBuiltinESMExports()
  t.after(() => { read.mock.restore(); syncBuiltinESMExports() })
  webServer.listenedPort = 54321
  new RemoteAccessService(ctx)
  new TypertRegistry(ctx)
  new TypertGatewayService(ctx, TypertGatewayService.Config({}))
  async function activate(mode = '1', keys = file) {
    const env = { AUTOMAGIK_MULTIUSER: mode, AUTOMAGIK_CALLER_KEYS: keys,
      AUTOMAGIK_INSTANCE_ID: instance, DSH_HOME: dir }
    const old = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]))
    Object.assign(process.env, env)
    const clock = t.mock.method(Date, 'now', () => (seconds - 10) * 1000)
    try {
      const fiber = ctx.plugin(adapter)
      await fiber
      return { service: ctx.get('automagikCaller'), dispose: () => fiber.dispose() }
    } finally {
      clock.mock.restore()
      for (const [name, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  }
  return { key, ctx, webServer, activate }
}

test('the mounted v2 service guards carrier scope and supports both v2 shapes', async t => {
  const { ctx, key, webServer, activate } = await mount(t)
  const { service, dispose } = await activate()
  t.mock.method(Date, 'now', () => seconds * 1000)
  const nonce = randomBytes(16).toString('base64url')
  const currentRequest = ownerRequest(ownerToken(key))
  let scoped = 0
  ctx.provide('automagikCallerRoutes', { version: 1, match() {
    return () => {
      assert.equal(callerOf(ctx).person.subject, wire.payload.principal.subject)
      assert.equal(service.verify(currentRequest), undefined)
      scoped++
      return new Response('ok')
    }
  } })
  const method = 'POST'
  const send = memberNonce => {
    const assertion = key.assertion({ method, path, nonce: memberNonce })
    const headers = { host: `127.0.0.1:${webServer.port}`, 'x-automagik-caller': assertion }
    const url = prefix + path
    return invoke(webServer.match(url).handler, { url, method, headers })
  }
  const carried = await send(nonce)
  assert.equal(carried.status, 200)
  assert.equal(scoped, 1)
  assert.equal(service.verify(ownerRequest(ownerToken(key, { nonce }))), undefined)
  assert.deepEqual(service.verify(currentRequest), accepted)
  const ownerNonce = randomBytes(16).toString('base64url')
  assert.deepEqual(service.verify(ownerRequest(ownerToken(key, { nonce: ownerNonce }))), accepted)
  assert.equal((await send(ownerNonce)).status, 401)
  const { verify, decide, ...legacy } = service
  for (const shape of [legacy, service]) {
    assert.equal(callerService({ get: () => shape }), shape)
    assert.equal(callerOf({ get: () => shape }), undefined)
  }
  await dispose()
  assert.equal(service.verify(ownerRequest(ownerToken(key))), undefined)
  assert.equal(await service.decide(wire.payload.session), undefined)
  const replacement = await activate()
  assert.equal(replacement.service.verify(currentRequest), undefined)
  await replacement.dispose()
})

test('the mounted v2 service gates optional calls on mode, keys and disposal', async t => {
  const { key, activate } = await mount(t)
  const disabled = await activate('0')
  assert.equal(disabled.service.verify(ownerRequest(ownerToken(key))), undefined)
  assert.equal(await disabled.service.decide(wire.payload.session), undefined)
  await disabled.dispose()
  const unconfigured = await activate('1', '')
  assert.equal(unconfigured.service.verify(ownerRequest(ownerToken(key))), undefined)
  assert.equal(await unconfigured.service.decide(wire.payload.session), undefined)
  await unconfigured.dispose()
  const live = await activate()
  let connected = 0
  const mock = t.mock.method(http, 'request', ({ signal }, receive) => {
    connected++
    const req = new EventEmitter()
    const response = new PassThrough()
    response.statusCode = 200
    response.headers = { 'content-type': 'application/jose' }
    req.end = () => { receive(response); response.write('partial') }
    req.destroy = () => response.destroy()
    signal.addEventListener('abort', () => req.emit('error', signal.reason), { once: true })
    return req
  })
  syncBuiltinESMExports()
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports() })
  const pending = live.service.decide(wire.payload.session)
  assert.equal(connected, 1)
  await live.dispose()
  assert.equal(await pending, undefined)
  assert.equal(await live.service.decide(wire.payload.session), undefined)
  assert.equal(connected, 1)
})
