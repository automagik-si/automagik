import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import http from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { duplexPair, PassThrough } from 'node:stream'
import test from 'node:test'
import { DEFAULT_DECISION_SOCKET as serverDefault,
  decisionSocketAddress as serverAddress } from '../../../server/gate-decisions.mjs'
import { createDecisionClient, decisionSocketAddress,
  DEFAULT_DECISION_SOCKET } from '../src/decisions.js'
import { signingKey, wire, wireEncode } from './runtime.mjs'

const session = randomBytes(32).toString('base64url')
const person = randomBytes(32).toString('base64url')
const instance = wire.payload.aud
const now = 1000
const typ = 'automagik-decision'

function fixture(t, { reportAbortError = true } = {}) {
  const key = signingKey(), wrongKey = signingKey()
  const challenges = new Set()
  let reply = () => ({})
  const socketName = 'fixture-' + randomBytes(8).toString('hex')
  const mounted = new AbortController()
  let requests = 0
  const mocked = t.mock.method(http, 'request', (options, receive) => {
    requests++
    assert.equal(options.socketPath, '\0' + socketName)
    assert.equal(options.path, '/decision')
    assert.equal(options.method, 'POST')
    assert.equal(options.headers['content-type'], 'application/json')
    const req = new EventEmitter()
    const res = new PassThrough()
    req.destroy = () => res.destroy()
    const abort = () => req.emit('error', options.signal.reason)
    if (reportAbortError) options.signal.addEventListener('abort', abort, { once: true })
    req.end = body => {
      assert.equal(options.headers['content-length'], Buffer.byteLength(body))
      const sent = JSON.parse(body)
      assert.deepEqual(Object.keys(sent), ['session', 'challenge'])
      assert.equal(sent.session, session)
      assert.match(sent.challenge, /^[A-Za-z0-9_-]{22}$/)
      assert.equal(challenges.has(sent.challenge), false)
      challenges.add(sent.challenge)
      const { fields, header, status = 200, mime = 'application/jose', unsigned,
        stall, length, foreign, close } = reply(sent)
      if (close) { req.emit('close'); return }
      const claims = { version: 1, aud: instance, ...sent, active: true, resolved: false, person,
        roles: ['admin', 'member'], iat: now, exp: now + 5, ...fields }
      const protectedHeader = { ...key.header, typ, ...header }
      const signer = foreign ? wrongKey : key
      const token = unsigned ?? signer.signed(wireEncode(protectedHeader), wireEncode(claims))
      res.statusCode = status
      res.headers = { 'content-type': mime, 'content-length': length }
      receive(res)
      if (stall) res.write(token.slice(0, 10))
      else if (!res.destroyed) res.end(token)
    }
    return req
  })
  syncBuiltinESMExports()
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports() })
  const decide = createDecisionClient({ name: socketName, keys: key.keys, instance,
    disposed: mounted.signal, now: () => now * 1000 })
  return { decide, send: handler => { reply = handler }, mounted, requests: () => requests }
}

test('gate and adapter agree on the default, override and allowed abstract socket names', t => {
  const before = process.env.AUTOMAGIK_GATE_DECISION_SOCKET
  t.after(() => {
    if (before === undefined) delete process.env.AUTOMAGIK_GATE_DECISION_SOCKET
    else process.env.AUTOMAGIK_GATE_DECISION_SOCKET = before
  })
  delete process.env.AUTOMAGIK_GATE_DECISION_SOCKET
  assert.equal(DEFAULT_DECISION_SOCKET, serverDefault)
  assert.equal(decisionSocketAddress(), serverAddress())
  assert.equal(decisionSocketAddress(), '\0automagik-gate-decision')
  process.env.AUTOMAGIK_GATE_DECISION_SOCKET = 'override-1'
  assert.equal(decisionSocketAddress(), serverAddress())
  assert.equal(decisionSocketAddress(), '\0override-1')
  for (const name of ['x', '-', '0', 'x'.repeat(64)]) {
    assert.equal(decisionSocketAddress(name), '\0' + name)
    assert.equal(decisionSocketAddress(name), serverAddress(name))
  }
  const invalid = ['', 'x'.repeat(65), 'Upper', 'a/b', 'a_b', '/tmp/path',
    'a\0b', 'a\n', ' a', null]
  for (const name of invalid) {
    assert.throws(() => decisionSocketAddress(name))
    assert.throws(() => serverAddress(name))
  }
})

test('decide verifies active and inactive snapshots with a fresh challenge', async t => {
  const f = fixture(t)
  assert.deepEqual(await f.decide(session), {
    active: true, person, roles: ['admin', 'member'], resolved: false,
  })
  f.send(() => ({ fields: { roles: [], resolved: true } }))
  assert.deepEqual(await f.decide(session), { active: true, person, roles: [], resolved: true })
  f.send(() => ({ fields: { active: false, person: undefined, roles: undefined } }))
  assert.deepEqual(await f.decide(session), { active: false })
  assert.equal(await f.decide('invalid'), undefined)
  assert.equal(await f.decide('A'.repeat(42) + 'B'), undefined)
  assert.equal(f.requests(), 3)
})

test('decide rejects malformed claims, the wrong key, and unsigned replies', async t => {
  const f = fixture(t)
  for (const fields of [
    { version: '1' }, { version: 2 }, { version: undefined }, { aud: 'other' }, { aud: undefined },
    { session: 'A'.repeat(43) }, { session: undefined },
    { challenge: 'A'.repeat(22) }, { challenge: undefined },
    { active: 'true' }, { active: undefined }, { resolved: 1 }, { resolved: undefined },
    { person: undefined }, { person: 'A'.repeat(42) + 'B' }, { person: 1 }, { person: 'x' },
    { roles: undefined }, { roles: 'admin' }, { roles: ['admin', 'admin'] }, { roles: ['unknown'] },
    { active: false }, { active: false, roles: undefined }, { active: false, person: undefined },
    { iat: '1000' }, { iat: 1000.5 }, { iat: undefined }, { exp: 1005.5 }, { exp: undefined },
    { iat: 2 ** 53, exp: 2 ** 53 + 5 }, { iat: 995, exp: 1000 }, { iat: 1006, exp: 1011 },
    { exp: 1006 }, { exp: 1004 }, { extra: true },
  ]) {
    f.send(() => ({ fields }))
    assert.equal(await f.decide(session), undefined, JSON.stringify(fields))
  }
  for (const response of [
    { header: { typ: 'automagik-caller' } }, { header: { typ: 'automagik-owner-caller' } },
    { header: { alg: 'none' } }, { header: { kid: 'A'.repeat(22) } }, { foreign: true },
    { status: 503, unsigned: '' }, { mime: 'text/plain' }, { unsigned: 'spoofed' },
  ]) {
    f.send(() => response)
    assert.equal(await f.decide(session), undefined, JSON.stringify(response))
  }
})

test('decide bounds announced and streamed reply size and the last-byte deadline', async t => {
  const f = fixture(t)
  f.send(() => ({ length: '2049' }))
  assert.equal(await f.decide(session), undefined)
  f.send(() => ({ unsigned: 'x'.repeat(2049) }))
  assert.equal(await f.decide(session), undefined)
  f.send(() => ({ stall: true }))
  const start = performance.now()
  // The mock transport has no socket handle to hold the process open.
  const hold = setInterval(() => {}, 100)
  t.after(() => clearInterval(hold))
  assert.equal(await f.decide(session), undefined)
  assert.ok(performance.now() - start < 2400)
})

test('abort and disposal cancel a held decision and disposal blocks later calls', async t => {
  const f = fixture(t, { reportAbortError: false })
  f.send(() => ({ stall: true }))
  const controller = new AbortController()
  const pending = f.decide(session, controller.signal)
  controller.abort()
  assert.equal(await pending, undefined)
  const duringDisposal = f.decide(session)
  f.mounted.abort()
  assert.equal(await duringDisposal, undefined)
  assert.equal(await f.decide(session), undefined)
  assert.equal(f.requests(), 2)
})

test('decide settles when the request closes without a response', { timeout: 1000 }, async t => {
  const f = fixture(t, { reportAbortError: false })
  f.send(() => ({ close: true }))
  assert.equal(await f.decide(session), undefined)
})

test('decide settles and closes the socket on a 101 from Node HTTP', { timeout: 1000 }, async t => {
  const [client, peer] = duplexPair()
  t.after(() => { client.destroy(); peer.destroy() })
  const closed = once(client, 'close')
  t.mock.method(http.Agent.prototype, 'createConnection', () => client)
  peer.once('data', bytes => {
    assert.match(bytes.toString(), /^POST \/decision HTTP\/1\.1\r\n/)
    peer.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\n' +
      'Upgrade: fixture\r\n\r\n')
  })
  const decide = createDecisionClient({ name: 'fixture-upgrade' })
  assert.equal(await decide(session), undefined)
  await closed
})
