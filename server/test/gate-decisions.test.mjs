import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { createDecisionClient } from '../../apps/multiuser-dsh/src/decisions.js'
import { createSigner, instanceOf, rotateCallerKeys, sessionHash } from '../gate-caller.mjs'
import { createDecisionServer, decisionSocketAddress } from '../gate-decisions.mjs'
import { createGate } from '../gate.mjs'
import { createOwner, IDLE_MS, principalOf, SessionStore } from '../gate-store.mjs'

const origin = 'https://workspace.invalid'
const person = (roles = ['owner']) => ({
  issuer: origin, subject: 'same-person', roles, workspace: 'workspace',
})
const challenge = randomBytes(16).toString('base64url')
const nameOf = () => 'decision-' + randomBytes(12).toString('hex')
function frame(session, { body = JSON.stringify({ session, challenge }), method = 'POST',
  path = '/decision', type = 'application/json',
  framing = `Content-Length: ${Buffer.byteLength(body)}\r\n`,
} = {}) {
  return `${method} ${path} HTTP/1.1\r\nHost: localhost\r\n` +
    `Content-Type: ${type}\r\n${framing}\r\n${body}`
}
const emptyReply = status => `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
const hashOf = ({ id }) => sessionHash(id)
const decode = segment => JSON.parse(Buffer.from(segment, 'base64url'))

function inject(server, ...chunks) {
  const socket = new EventEmitter()
  let reply = ''
  socket.destroy = () => socket.emit('close')
  socket.end = (bytes, done) => { reply = bytes; done() }
  server.emit('connection', socket)
  for (const chunk of chunks) socket.emit('data', Buffer.from(chunk))
  socket.emit('end')
  return reply
}

function fixture(t, { firstBoot = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gate-decisions-'))
  const dir = join(root, 'home')
  const publicDir = join(root, 'public')
  mkdirSync(dir)
  mkdirSync(publicDir)
  let now = 60_000
  let elapsed = 0
  const instance = firstBoot ? () => instanceOf({ env: {}, dir }) : () => 'workspace'
  const signer = createSigner({ dir, publicDir, instance, now: () => now,
    monotonicNow: () => elapsed })
  signer.publish()
  const file = join(publicDir, 'caller-keys.json')
  const keys = () => new Map(JSON.parse(readFileSync(file)).keys.map(jwk => [jwk.kid, {
    instance: instance(), key: createPublicKey({ format: 'jwk', key: { kty: 'OKP', ...jwk } }),
  }]))
  const sessions = new SessionStore(dir, { memory: true, accepts: () => true, now: () => now })
  const successors = new Map()
  const dropped = new Set()
  const name = nameOf()
  const signs = t.mock.method(signer, 'signDecision')
  const server = createDecisionServer({ origin, sessions,
    cloud: { drops: family => dropped.has(family) },
    successors, signer, name })
  t.after(async () => {
    await server.closeDecision()
    rmSync(root, { recursive: true, force: true })
  })
  const verifyReply = response => {
    assert.match(response, /^HTTP\/1\.1 200 OK\r\n/)
    assert.match(response, /\r\nContent-Type: application\/jose\r\n/)
    const [h, p, s] = response.split('\r\n\r\n')[1].split('.')
    const { kid } = decode(h)
    assert.deepEqual(decode(h), { alg: 'EdDSA', kid, typ: 'automagik-decision' })
    const signature = Buffer.from(s, 'base64url')
    assert.ok(verify(null, Buffer.from(`${h}.${p}`), keys().get(kid).key, signature))
    return { kid, claims: decode(p) }
  }
  return { dir, publicDir, file, sessions, successors, server, signer, signs, dropped, name,
    keys, verifyReply, inject: (...chunks) => inject(server, ...chunks),
    now: () => now, advance: ms => { now += ms; elapsed += ms },
    client: () => createDecisionClient({ name, keys: { get: kid => keys().get(kid) },
      now: () => now }),
    issue: (principal = person(), expires) => sessions.issue(origin, principal, { expires }),
    rotate: (action, emergency = false) => rotateCallerKeys({ dir, publicDir, instance: instance(),
      action, emergency, now: () => now }),
    ask: family => verifyReply(inject(server, frame(hashOf(family)))).claims,
  }
}

test('decision framing rejects malformed, chunked, oversized and coalesced input', t => {
  const f = fixture(t)
  const session = hashOf(f.issue().family)
  const valid = frame(session)
  for (const bytes of [frame(session, { method: 'GET' }), frame(session, { path: '/decision?' }),
    frame(session, { type: 'text/plain' }), frame(session, { body: '{}' }), frame('short'),
    frame('A'.repeat(42) + 'B'),
    frame(session, { body: JSON.stringify({ session, challenge: 'A'.repeat(21) + 'B' }) }),
    frame(session, { body: ' '.repeat(1025) }),
    frame(session, { framing: 'Transfer-Encoding: chunked\r\n' }),
    frame(session, { framing: 'Content-Length: 75\r\ncontent-length: 75\r\n' }),
    frame(session, { framing: '' }), valid.slice(0, -1), valid + 'X', valid + valid]) {
    assert.equal(f.inject(bytes), emptyReply('400 Bad Request'))
  }
  assert.equal(f.signs.mock.callCount(), 0)
  const split = valid.indexOf('\r\n\r\n') + 2
  const { claims } = f.verifyReply(f.inject(valid.slice(0, split), valid.slice(split), valid))
  assert.equal(claims.session, session)
  assert.equal(f.signs.mock.callCount(), 1, 'bytes after the answer never get another signature')
})

test('first boot answers 503 until a claim supplies the audience and lazy key publication', t => {
  const f = fixture(t, { firstBoot: true })
  const session = sessionHash('unknown')
  assert.equal(f.inject(frame(session)), emptyReply('503 Service Unavailable'))
  assert.equal(existsSync(f.file), false)
  const owner = createOwner(f.dir)
  const family = f.issue(principalOf(owner)).family
  const { aud, active } = f.ask(family)
  assert.equal(aud, owner.instance_id)
  assert.equal(active, true)
  assert.equal(existsSync(f.file), true)
})

test('decision signatures follow caller key promotion and retirement', t => {
  const f = fixture(t)
  const session = hashOf(f.issue().family)
  const first = f.verifyReply(f.inject(frame(session))).kid
  f.rotate('stage')
  f.rotate('promote')
  f.advance(1000)
  const promoted = f.verifyReply(f.inject(frame(session))).kid
  assert.notEqual(promoted, first)
  assert.equal(f.keys().has(first), true)
  f.rotate('retire', true)
  f.advance(1000)
  assert.equal(f.verifyReply(f.inject(frame(session))).kid, promoted)
  assert.equal(f.keys().has(first), false)
})

test('decisions separate the family from the person and do not extend idle or hard expiry', t => {
  const f = fixture(t)
  const { family: a, secret } = f.issue()
  const { family: b } = f.issue(person(['admin']), f.now() + 2000)
  const before = f.now()
  const { issuer, subject } = person()
  const anonymous = createHash('sha256').update(`${issuer}\n${subject}`).digest('base64url')
  assert.deepEqual(f.ask(a), { version: 1, aud: person().workspace, session: hashOf(a), challenge,
    active: true, resolved: false, person: anonymous, roles: ['owner'],
    iat: before / 1000, exp: before / 1000 + 5 })
  assert.equal(f.ask(b).person, anonymous)
  assert.notEqual(hashOf(a), hashOf(b))
  assert.equal(f.ask({ id: 'unknown' }).active, false)
  const rotated = f.sessions.renew(a)
  assert.notEqual(rotated, secret)
  assert.equal(f.ask(a).active, true)
  f.advance(2000)
  assert.equal(f.ask(b).active, false)
  f.issue()
  assert.equal(f.sessions.familyBySessionHash(hashOf(b)), undefined)
  assert.equal(f.ask(a).active, true)
  assert.equal(a.touched, before)
  assert.equal(b.touched, before)
  f.advance(IDLE_MS - 2000)
  assert.equal(f.ask(a).active, false)
})

test('decisions intersect roles across eight hops and refuse nine hops or an evicted link', t => {
  const f = fixture(t)
  const families = Array.from({ length: 10 }, (_, i) => {
    const roles = i === 4 ? ['member'] : ['owner', 'member']
    return f.issue(person(roles)).family
  })
  for (let i = 0; i < families.length - 1; i++) {
    const family = families[i]
    f.sessions.revoke(family)
    f.successors.set(hashOf(family), {
      session: hashOf(families[i + 1]), origin, roles: family.principal.roles,
    })
  }
  assert.equal(f.ask(families[0]).active, false)
  const result = f.ask(families[1])
  assert.equal(result.session, hashOf(families[1]))
  assert.equal(result.resolved, true)
  assert.deepEqual(result.roles, ['member'])
  f.successors.delete(hashOf(families[5]))
  assert.equal(f.ask(families[1]).active, false)
  f.dropped.add(families[9])
  assert.equal(f.ask(families[8]).active, false)
  f.dropped.clear()
  f.sessions.revoke(families[9])
  const inactive = f.ask(families[8])
  assert.equal(inactive.active, false)
  assert.equal(Object.hasOwn(inactive, 'person'), false)
  assert.equal(Object.hasOwn(inactive, 'roles'), false)
})

test('decisions require the pinned origin at every successor hop', t => {
  const f = fixture(t)
  const otherOrigin = 'https://old-workspace.invalid'
  const terminal = f.issue().family
  const oldTerminal = f.sessions.issue(otherOrigin, person()).family
  const link = (from, to, fromOrigin) => {
    f.successors.set(hashOf(from), { session: hashOf(to), origin: fromOrigin, roles: ['owner'] })
  }
  const first = { id: 'first' }
  const middle = { id: 'middle' }
  link(first, middle, origin)
  link(middle, terminal, otherOrigin)
  assert.equal(f.ask(first).active, false)
  link(middle, oldTerminal, origin)
  assert.equal(f.ask(first).active, false)
  link(middle, terminal, origin)
  assert.equal(f.ask(first).resolved, true)
})

test('decisions use one indexed lookup per hop regardless of family count', t => {
  const f = fixture(t)
  for (let i = 0; i < 2048; i++) f.issue()
  const terminal = f.issue().family
  const earlier = Array.from({ length: 8 }, () => f.issue().family)
  const chain = [...earlier, terminal]
  f.sessions.revokeAll(family => earlier.includes(family))
  for (const [i, family] of earlier.entries()) {
    assert.equal(f.sessions.familyBySessionHash(hashOf(family)), undefined)
    f.successors.set(hashOf(family), {
      session: hashOf(chain[i + 1]), origin, roles: ['owner'],
    })
  }
  assert.equal(f.sessions.families.length, 2049)
  const lookup = t.mock.method(f.sessions, 'familyBySessionHash')
  Object.defineProperty(f.sessions, 'families', {
    get: () => assert.fail('decision lookup read the family list'),
  })
  const decision = f.ask(chain[0])
  assert.equal(decision.active, true)
  assert.equal(decision.resolved, true)
  assert.deepEqual(lookup.mock.calls.map(call => call.arguments), chain.map(f => [hashOf(f)]))
})

test('claim reset revokes the family and preserves the decision audience', async t => {
  const { SelfHostedClaim } = await import('../gate-claim.mjs')
  const f = fixture(t, { firstBoot: true })
  const owner = createOwner(f.dir)
  const claim = new SelfHostedClaim({ dir: f.dir, origin, sessions: f.sessions })
  const { family } = f.issue(principalOf(owner))
  assert.equal(f.ask(family).active, true)
  assert.deepEqual(await claim.reset(), { reset: true })
  const answer = f.ask(family)
  assert.equal(answer.active, false)
  assert.equal(answer.aud, owner.instance_id)
})

async function runGateEntrypoint(t, id, settings, check) {
  const env = process.env
  const exitCode = process.exitCode
  const signals = ['SIGTERM', 'SIGINT']
  const original = Object.fromEntries(signals.map(signal => [signal, process.listeners(signal)]))
  const installed = signal => process.listeners(signal)
    .filter(handler => !original[signal].includes(handler))
  process.env = { AUTOMAGIK_GATE_ENABLED: '1', AUTOMAGIK_GATE_MULTIUSER: '1', ...settings }
  const log = t.mock.method(console, 'log', () => {})
  try {
    await import(`../gate-entrypoint.mjs?${id}`)
    await check(log)
  } finally {
    for (const handler of installed('SIGTERM')) await handler()
    for (const signal of signals) {
      for (const handler of installed(signal)) process.off(signal, handler)
    }
    process.env = env
    process.exitCode = exitCode
  }
}

test('on an origin-changing restart the first reachable decision is inactive', async t => {
  const f = fixture(t, { firstBoot: true })
  const owner = createOwner(f.dir, { auth: {
    version: 1, status: 'claimed', generation: 'generation', origin,
    rpID: new URL(origin).hostname, userID: 'user',
    credentials: [{ id: 'YQ', publicKey: 'Yg', counter: 0 }], recovery: [],
  } })
  const store = new SessionStore(f.dir)
  const { family } = store.issue(origin, principalOf(owner))
  assert.equal(store.active(family), true)
  const session = hashOf(family)
  const controlPath = join(f.dir, 'control.sock')
  const port = 12345
  const order = []
  let reply
  t.mock.method(net.Server.prototype, 'listen', function (address, ...args) {
    order.push(address)
    if (address === controlPath) writeFileSync(controlPath, '')
    if (address === decisionSocketAddress(f.name)) reply = inject(this, frame(session))
    queueMicrotask(args.at(-1))
    return this
  })

  await runGateEntrypoint(t, 'origin-restart', {
    AUTOMAGIK_GATE_ORIGIN: 'https://new-workspace.invalid',
    AUTOMAGIK_GATE_HOME: f.dir, AUTOMAGIK_GATE_CALLER_PUBLIC: f.publicDir,
    AUTOMAGIK_GATE_DECISION_SOCKET: f.name,
    AUTOMAGIK_GATE_PORT: String(port), AUTOMAGIK_GATE_CLAIM: 'remote', AUTOMAGIK_GATE_IMAGE: '1',
  }, log => {
    assert.equal(log.mock.callCount(), 1)
    assert.deepEqual(order, [controlPath, decisionSocketAddress(f.name), port])
    assert.deepEqual(new SessionStore(f.dir).families, [])
    const { claims } = f.verifyReply(reply)
    assert.equal(claims.aud, owner.instance_id)
    assert.equal(claims.session, session)
    assert.equal(claims.active, false)
  })
})

test('an Access restart decides only for families at its pinned origin', async t => {
  const f = fixture(t, { firstBoot: true })
  const owner = createOwner(f.dir)
  const store = new SessionStore(f.dir)
  const old = store.issue('https://old-workspace.invalid', principalOf(owner)).family
  const current = store.issue(origin, principalOf(owner)).family
  assert.equal(store.active(old), true)
  assert.equal(store.active(current), true)
  const replies = new Map()
  t.mock.method(net.Server.prototype, 'listen', function (address, ...args) {
    if (address === decisionSocketAddress(f.name)) {
      for (const family of [old, current]) {
        const session = hashOf(family)
        replies.set(session, inject(this, frame(session)))
      }
    }
    queueMicrotask(args.at(-1))
    return this
  })
  await runGateEntrypoint(t, 'access-origin-restart', {
    AUTOMAGIK_GATE_ORIGIN: origin, AUTOMAGIK_GATE_HOME: f.dir,
    AUTOMAGIK_GATE_CALLER_PUBLIC: f.publicDir, AUTOMAGIK_GATE_DECISION_SOCKET: f.name,
    AUTOMAGIK_GATE_ACCESS_TEAM_DOMAIN: 'team.invalid', AUTOMAGIK_GATE_ACCESS_AUD: 'audience',
    AUTOMAGIK_GATE_ACCESS_EMAILS: 'owner@team.invalid',
  }, log => {
    assert.equal(log.mock.callCount(), 1)
    assert.deepEqual(new SessionStore(f.dir).families, [old, current])
    const oldClaims = f.verifyReply(replies.get(hashOf(old))).claims
    assert.equal(oldClaims.session, hashOf(old))
    assert.equal(oldClaims.active, false)
    assert.equal(Object.hasOwn(oldClaims, 'roles'), false)
    const currentClaims = f.verifyReply(replies.get(hashOf(current))).claims
    assert.equal(currentClaims.session, hashOf(current))
    assert.equal(currentClaims.active, true)
    assert.deepEqual(currentClaims.roles, ['owner'])
  })
})

const connect = name => net.createConnection(decisionSocketAddress(name))
const listen = (server, host = '127.0.0.1') => {
  server.listen(0, host)
  return once(server, 'listening').then(() => server.address().port)
}

test('same-namespace decisions survive real rebind and the TCP path stays unsigned', async t => {
  const f = fixture(t, { firstBoot: true })
  await f.server.start()
  const gate = createGate({ origin, sessions: f.sessions, multiuser: true, caller: f.signer })
  t.after(() => gate.closeGate())
  const port = await listen(gate)
  const status = await new Promise((resolve, reject) => {
    const options = { host: '127.0.0.1', port, path: '/decision', method: 'POST' }
    const req = http.request(options, res => {
      res.resume()
      resolve(res.statusCode)
    }).on('error', reject)
    req.end()
  })
  assert.equal(status, 401)
  assert.equal(f.signs.mock.callCount(), 0)
  const decide = f.client()
  assert.equal(await decide(sessionHash('before-claim')), undefined)
  const owner = createOwner(f.dir)
  const session = hashOf(f.issue(principalOf(owner)).family)
  assert.equal((await decide(session)).active, true)
  await gate.rebind(port, '127.0.0.2')
  assert.equal(gate.address().address, '127.0.0.2')
  assert.equal((await decide(session)).active, true)
})

test('decision socket limits connections, enforces the deadline and closes open peers', async t => {
  const f = fixture(t)
  await f.server.start()
  const sockets = []
  t.after(() => sockets.forEach(socket => socket.destroy()))
  async function dial() {
    const socket = connect(f.name)
    socket.on('error', () => {})
    sockets.push(socket)
    await once(socket, 'connect')
    return socket
  }
  await Promise.all(Array.from({ length: 64 }, dial))
  const overflow = await dial()
  assert.deepEqual(await once(overflow, 'close'), [false])
  const [trickle] = sockets
  const ended = once(trickle, 'close')
  const start = performance.now()
  trickle.write('P')
  for (let i = 0; i < 3; i++) { await setTimeout(420); trickle.write('O') }
  assert.equal(trickle.destroyed, false)
  await ended
  assert.ok(performance.now() - start < 2400)
  assert.equal(f.signs.mock.callCount(), 0)
  const open = await dial()
  const closed = once(open, 'close')
  await f.server.closeDecision()
  await closed
})

test('a bind collision fails without taking over the live decision address', async t => {
  const f = fixture(t)
  await f.server.start()
  const collision = createDecisionServer({ name: f.name })
  await assert.rejects(collision.start(), { code: 'EADDRINUSE' })
  await collision.closeDecision()
  const session = hashOf(f.issue().family)
  assert.equal((await f.client()(session)).active, true)
})

test('a separate Linux network namespace cannot connect to the decision socket', async t => {
  const probe = spawnSync('unshare', ['-n', '--', '/bin/true'])
  if (probe.status !== 0) { t.skip('unprivileged unshare -n is unavailable'); return }
  const f = fixture(t)
  await f.server.start()
  const result = spawnSync('unshare', ['-n', '--', process.execPath, '-e', `
    require('node:net').connect(process.argv[1].replace('abstract:', '\\0'))
      .on('connect', () => process.exit(2))
      .on('error', error => process.exit(error.code === 'ECONNREFUSED' ? 0 : 3))
  `, 'abstract:' + f.name], { timeout: 5000 })
  assert.equal(result.status, 0, result.stderr?.toString())
  assert.equal(f.signs.mock.callCount(), 0)
})

test('entrypoint closes decisions on bind failure and shutdown', { timeout: 8000 }, async t => {
  const f = fixture(t)
  const occupied = net.createServer()
  const port = await listen(occupied)
  t.after(() => occupied.close())
  const guard = join(f.dir, 'no-outbound.mjs')
  writeFileSync(guard, `import https from 'node:https'
const denied = () => { throw new Error('Unexpected outbound connection') }
https.request = denied; https.get = denied; globalThis.fetch = denied
`)
  const env = { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS,
    LOCALDOMAIN: process.env.LOCALDOMAIN, HERDR_APP_BIN: process.env.HERDR_APP_BIN,
    TMPDIR: tmpdir(), AUTOMAGIK_GATE_ENABLED: '1', AUTOMAGIK_GATE_ORIGIN: origin,
    AUTOMAGIK_GATE_HOME: f.dir, AUTOMAGIK_GATE_CALLER_PUBLIC: f.publicDir,
    AUTOMAGIK_GATE_MULTIUSER: '1', AUTOMAGIK_GATE_DECISION_SOCKET: f.name,
    AUTOMAGIK_GATE_PORT: String(port), AUTOMAGIK_GATE_CLOUD_IDENTITY_ISSUER: origin,
    AUTOMAGIK_GATE_CLOUD_ISSUER: 'https://cloud.invalid',
    AUTOMAGIK_GATE_CLOUD_WORKSPACE: 'workspace',
    AUTOMAGIK_GATE_CLOUD_KEYS_URL: 'https://cloud.invalid/keys',
    AUTOMAGIK_GATE_CLOUD_EXCHANGE_URL: 'https://cloud.invalid/exchange',
    AUTOMAGIK_GATE_CLOUD_RAIL_ORIGIN: 'https://rail.invalid',
    AUTOMAGIK_GATE_CLOUD_REVOCATION_URL: 'https://cloud.invalid/revocations',
  }
  const launch = overrides => {
    const proc = spawn(process.execPath, ['--import', guard, 'server/gate-entrypoint.mjs'], {
      env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    t.after(() => { if (proc.exitCode === null) proc.kill('SIGKILL') })
    const exited = once(proc, 'exit')
    let logs = ''
    proc.stderr.on('data', bytes => { logs += bytes })
    const ready = new Promise(resolve => proc.stdout.on('data', bytes => {
      if (String(bytes).includes('listening on loopback')) resolve(true)
    }))
    return { proc, exited, ready: Promise.race([ready, exited.then(() => logs)]) }
  }
  const failed = launch()
  assert.deepEqual(await failed.exited, [1, null])
  await f.server.start()
  const collision = launch()
  assert.deepEqual(await collision.exited, [1, null])
  await f.server.closeDecision()
  await new Promise(resolve => occupied.close(resolve))
  const active = launch()
  assert.equal(await active.ready, true)
  const peer = connect(f.name)
  await once(peer, 'connect')
  // Shutdown destroys open peers, so the client may see a reset before its close;
  // events.once would reject on that error, so wait for the close event alone.
  peer.on('error', error => assert.equal(error.code, 'ECONNRESET'))
  const closed = new Promise(resolve => peer.once('close', resolve))
  active.proc.kill('SIGTERM')
  await closed
  assert.deepEqual(await active.exited, [0, null])
  const disabled = launch({ AUTOMAGIK_GATE_MULTIUSER: '0' })
  assert.equal(await disabled.ready, true)
  const absent = await once(connect(f.name), 'error')
  assert.equal(absent[0].code, 'ECONNREFUSED')
  disabled.proc.kill('SIGTERM')
  assert.deepEqual(await disabled.exited, [0, null])
})
