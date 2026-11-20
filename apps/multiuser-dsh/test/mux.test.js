import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import fs, { mkdtempSync, rmSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as tick, setTimeout as sleep } from 'node:timers/promises'
import test from 'node:test'
import WebSocket, { WebSocketServer } from 'ws'
import { Context, Service } from '@deepseek-ai/cordis'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import { apply as applyRemoteClient } from '@deepseek-ai/dsh-api-gateway/client'
import { RemoteAccessService } from '@deepseek-ai/dsh-api-remote-access'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { createSigner } from '../../../server/gate-caller.mjs'
import { callerOf } from '../../bots-dsh/src/host/multiuser.js'
import * as adapter from '../index.js'
import { READY_PATH } from '../src/carrier.js'
import { createMux, fragmentCounter } from '../src/mux.js'
import { createMuxCarrier, MUX_PATH } from '../src/mux-carrier.js'
import { createNonces } from '../src/nonces.js'
import { createPeerRegistry } from '../src/peers.js'
import { createScope } from '../src/scope.js'
import { invoke, prefix, rpc, seconds, signingKey, wire } from './runtime.mjs'

const instance = wire.payload.aud
const MEMBER_PATH = '/api/remote.mux'
// A test projection that passes items unchanged (5c supplies the real one).
const identity = ({ item }) => item
const person = (subject, role = 'member') => ({ ...wire.payload.principal, subject, roles: [role] })

// --- A DSH host with the adapter installed, listening on loopback --------------------------

// One fixture Remote service: a unary `fixture/call` and a stream `fixture/ticks`.
function fixtureService(ctx, calls, cancellations) {
  class Fixture extends TypertRemoteService {
    call() {
      calls.push(['call', callerOf(ctx)])
      return 'called'
    }
    async *ticks() {
      calls.push(['ticks', callerOf(ctx)])
      for (let i = 0; i < 3; i++) yield { tick: i }
    }
    async *hold(signal) {
      try {
        yield { tick: 0 }
        if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      } finally {
        cancellations.push(signal.aborted)
      }
    }
  }
  new Fixture(ctx, 'fixture')
  ctx.typert.register({ package: 'fixture-mux', face: 'host', model: {}, schemas: [], invocations: [
    { id: 'fixture-mux/call', service: 'fixture', namespace: 'fixture', method: 'call', invocation: { kind: 'direct' },
      parameters: [], result: { mode: 'src-json' } },
    { id: 'fixture-mux/ticks', service: 'fixture', namespace: 'fixture', method: 'ticks', invocation: { kind: 'direct' },
      parameters: [], result: { mode: 'src-json' }, mode: 'stream' },
    { id: 'fixture-mux/hold', service: 'fixture', namespace: 'fixture', method: 'hold', invocation: { kind: 'direct' },
      parameters: [], cancellation: { parameter: 'signal' }, result: { mode: 'src-json' }, mode: 'stream' },
  ] })
}

async function host(t, { gateway = true, remoteAccess = true, appReady, multiuser = '1', events = false, foreign,
  plugins = false, stub, isolatedAccess = false, signerRandom, listen = true } = {}) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const webServer = new WebServer(ctx, { host: '127.0.0.1', port: 0 })
  if (listen) await webServer[Service.init]()
  else webServer.listenedPort = 54321
  // With `plugins`, remoteAccess and the connection are plugins a test can unload and reload.
  let connectionFiber, accessFiber
  const provideAccess = () => {
    accessFiber = ctx.plugin({ name: 'fixture-access', apply: c => { new RemoteAccessService(c) } })
    return accessFiber
  }
  if (plugins) {
    connectionFiber = ctx.plugin({ name: 'fixture-connection', apply: c => { new HostConnectionService(c, [], {}) } })
    await connectionFiber
  } else new HostConnectionService(ctx, [], {})
  const connection = ctx.get('connection')
  if (appReady) ctx.provide('appReady', appReady)
  const calls = []
  let access
  if (remoteAccess && plugins) await provideAccess()
  else if (remoteAccess) new RemoteAccessService(ctx)
  access = ctx.get('remoteAccess')
  if (foreign) access.registerPolicy('automagik', foreign)
  const cancellations = []
  new TypertRegistry(ctx)
  fixtureService(ctx, calls, cancellations)
  let typertGateway, eventSource
  const makeGateway = c => {
    typertGateway = new TypertGatewayService(c, TypertGatewayService.Config({}))
    if (stub) Object.assign(typertGateway.wireStream, stub.wireStream)
    if (events) {
      eventSource = remoteEvents()
      typertGateway.registerRemoteEvents(signal => eventSource.iterate(signal), { home: '/fixture-home' })
    }
  }
  const provideGateway = before => ctx.plugin({ name: 'fixture-gateway', apply(c) {
    before?.(c)
    makeGateway(c)
  } })
  if (gateway) makeGateway(ctx)
  const adapterCtx = isolatedAccess ? ctx.isolate('remoteAccess') : ctx
  if (isolatedAccess) new RemoteAccessService(adapterCtx)
  const dir = mkdtempSync(join(tmpdir(), 'caller-mux-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const signer = createSigner({ dir, publicDir: dir, instance: () => instance, random: signerRandom })
  signer.publish()
  const read = fs.readFileSync
  const mount = t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === '/proc/self/mountinfo') return `2 1 0:2 / ${dir} ro - tmpfs tmpfs rw`
    if (typeof file === 'string' && file.startsWith('/proc/self/fdinfo/')) return 'mnt_id:\t2\n'
    return read(file, ...args)
  })
  syncBuiltinESMExports()
  t.after(() => { mount.mock.restore(); syncBuiltinESMExports() })
  const activate = async () => {
    const env = { AUTOMAGIK_MULTIUSER: multiuser, AUTOMAGIK_CALLER_KEYS: join(dir, 'caller-keys.json'), AUTOMAGIK_INSTANCE_ID: instance, DSH_HOME: dir }
    const old = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]))
    Object.assign(process.env, env)
    const elapsed = Date.now() - 10_000
    const clock = t.mock.method(Date, 'now', () => elapsed)
    try {
      const fiber = adapterCtx.plugin(adapter)
      await fiber
      return () => fiber.dispose()
    } finally {
      clock.mock.restore()
      for (const [name, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  }
  const dispose = await activate()
  await tick()
  const port = webServer.port
  let family = 0
  const sign = (principal, { method = 'GET', path = MEMBER_PATH, familyId = `family-${++family}` } = {}) =>
    signer.sign({ principal, familyId, method, path })
  return { ctx, webServer, connection, access, gateway: typertGateway, eventSource, calls, signer, sign, port, dispose, activate,
    connectionFiber, accessFiber: () => accessFiber, provideAccess, provideGateway, adapterCtx, cancellations,
    socket: (principal, options) => member(port, principal && sign(principal, options)) }
}

// The forwarded-event source a Remote assembly registers: notifications and scoped waterfalls.
function remoteEvents() {
  const queue = []
  let wake
  return {
    push(dispatch) { queue.push(dispatch); wake?.() },
    async *iterate(signal) {
      while (!signal.aborted) {
        while (queue.length) yield queue.shift()
        await new Promise(resolve => {
          wake = resolve
          signal.addEventListener('abort', resolve, { once: true })
        })
      }
    },
  }
}

// --- A ws client of the private route -------------------------------------------------------

function member(port, assertion, { path = MUX_PATH, headers = {} } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
    headers: { ...(assertion ? { 'x-automagik-caller': assertion } : {}), ...headers }, perMessageDeflate: false,
  })
  return client(ws)
}

function client(ws) {
  const frames = []
  const waiters = new Set()
  const settle = () => { for (const waiter of Array.from(waiters)) waiter() }
  ws.on('message', (data, isBinary) => {
    if (!isBinary) frames.push(JSON.parse(data.toString()))
    settle()
  })
  ws.on('error', () => {})
  const closed = new Promise(resolve => ws.once('close', (code, reason) => { settle(); resolve({ code, reason: reason.toString() }) }))
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error('refused'), { status: res.statusCode })))
    ws.once('close', () => reject(new Error('closed before opening')))
  })
  opened.catch(() => {})
  const until = (check, ms = 5000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(run); reject(new Error(`timed out; frames ${JSON.stringify(frames).slice(0, 400)}`)) }, ms)
    const run = () => {
      const value = check()
      if (value) { clearTimeout(timer); waiters.delete(run); resolve(value) }
    }
    waiters.add(run)
    run()
  })
  return {
    ws, frames, closed, opened, until,
    send: message => ws.send(typeof message === 'string' ? message : JSON.stringify(message)),
    open(streamId, endpoint, payload = { args: {} }) { this.send({ type: 'open', streamId, endpoint, payload }) },
    of: streamId => frames.filter(frame => frame.streamId === streamId),
    terminal: (streamId, ms) => until(() => frames.find(frame => frame.streamId === streamId && frame.type !== 'item'), ms),
  }
}

async function status(port, path, headers = {}) {
  const socket = connect({ host: '127.0.0.1', port })
  socket.setEncoding('latin1')
  let text = ''
  socket.on('data', chunk => { text += chunk })
  socket.on('error', () => {})
  const lines = [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: Upgrade', 'Upgrade: websocket',
    'Sec-WebSocket-Version: 13', `Sec-WebSocket-Key: ${Buffer.alloc(16, 1).toString('base64')}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`)]
  socket.write(lines.join('\r\n') + '\r\n\r\n')
  await once(socket, 'close')
  return Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1])
}

function probe(port) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: READY_PATH, headers: { connection: 'keep-alive' } }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: res.rawHeaders, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
}

const httpCall = (port, assertion, path, body) => new Promise((resolve, reject) => {
  const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: prefix + path, headers: {
    'content-type': 'application/json', 'x-automagik-caller': assertion,
  } }, res => {
    const chunks = []
    res.on('data', chunk => chunks.push(chunk))
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }))
  })
  req.on('error', reject)
  req.end(body)
})

// --- A mux with a fake wire stream on a plain loopback server --------------------------------

function fakeWire() {
  const streams = new Map()
  const opened = []
  return {
    opened, streams,
    wireStream: {
      async open(endpoint, payload, uplink, peer, signal) {
        opened.push({ endpoint, payload, peer, signal, uplink })
        const make = streams.get(endpoint)
        if (!make) throw Object.assign(new Error(`no fixture ${endpoint}`), { isDSHRemoteError: true, code: 'gateway/method-unavailable', details: {} })
        return make({ payload, uplink, peer, signal })
      },
      failure: error => ({ code: error.code ?? 'gateway/internal', message: error.message, details: error.details ?? {} }),
    },
  }
}

async function bare(t, { limits, socketLimits, project, ready = () => true } = {}) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const connection = new HostConnectionService(ctx, [], {})
  const key = signingKey()
  const scope = createScope()
  const registry = createPeerRegistry()
  const fake = fakeWire()
  const mux = createMux({ wireStream: fake.wireStream, scope, registry, ready, project, limits })
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  t.after(async () => {
    await mux.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  const nonces = createNonces({ startedAtSec: seconds - 6, monotonicNow: () => seconds * 1000 })
  const admission = { keys: key.keys, nonces, multiuser: true, keysConfigured: true,
    expectedAuthority: () => `127.0.0.1:${port}`, now: () => seconds * 1000 }
  const handler = createMuxCarrier({ admission, connection, registry, ready, mux, limits: socketLimits })
  server.on('upgrade', (req, socket, head) => handler(req, socket, head))
  const assertion = (subject = 'member-1', fields = {}) =>
    key.assertion({ method: 'GET', path: MEMBER_PATH, principal: person(subject), ...fields })
  return { ctx, connection, scope, registry, fake, mux, port, assertion,
    socket: (subject, fields) => member(port, assertion(subject, fields)) }
}

// A stream the test drives item by item.
function controlled() {
  const items = []
  let wake, done = false
  const state = { pulled: 0, returned: false }
  return {
    state,
    push(value) { items.push(value); wake?.() },
    end() { done = true; wake?.() },
    make: ({ signal }) => (async function* () {
      try {
        while (true) {
          while (items.length) {
            state.pulled++
            yield items.shift()
          }
          if (done || signal.aborted) return
          await new Promise(resolve => {
            wake = resolve
            signal.addEventListener('abort', resolve, { once: true })
          })
        }
      } finally { state.returned = true }
    })(),
  }
}

// --- B1-B5: binding, admission and readiness --------------------------------------------------

test('a carried socket binds one Peer whose streams run as the caller and is released on close', async t => {
  const f = await bare(t, { project: identity })
  const seen = []
  f.fake.streams.set('fixture/who', ({ peer }) => (async function* () {
    seen.push({ caller: f.scope.current(), session: f.scope.session(), peer })
    yield { subject: f.scope.current().person.subject }
  })())
  const created = t.mock.method(f.connection, 'createPeer')
  const a = f.socket('alice')
  await a.opened
  assert.equal(created.mock.callCount(), 1)
  const peer = created.mock.calls[0].result
  assert.equal(peer.interactions, 'answer')
  assert.equal(peer.principal.person.subject, 'alice')
  assert.equal(f.registry.size, 1)
  assert.ok(f.registry.live(peer))
  a.open('1', 'fixture/who')
  a.open('2', 'fixture/who')
  await a.until(() => a.of('1').at(-1)?.type === 'end' && a.of('2').at(-1)?.type === 'end')
  assert.deepEqual(a.of('1'), [{ type: 'item', streamId: '1', value: { subject: 'alice' } }, { type: 'end', streamId: '1' }])
  assert.ok(seen.every(row => row.peer === peer && row.caller === peer.principal && row.session === wire.payload.session))
  assert.equal(f.scope.current(), undefined)
  a.ws.close()
  await a.closed
  while (f.registry.size || !peer.signal.aborted) await sleep(5)
  assert.equal(f.mux.size, 0)
})

test('upgrade admission refuses before the handshake', async t => {
  const f = await host(t)
  const open = t.mock.method(f.gateway.wireStream, 'open')
  const created = t.mock.method(f.connection, 'createPeer')
  const principal = person('first')
  const signed = (options) => f.sign(principal, options)
  const cases = [
    [MUX_PATH + '?', { 'x-automagik-caller': signed() }, 400],
    [prefix + '/api/./remote.mux', { 'x-automagik-caller': signed() }, 400],
    [prefix + '/api//remote.mux', { 'x-automagik-caller': signed() }, 503],
    [MUX_PATH, {}, 401],
    [MUX_PATH, { 'x-automagik-caller': 'not-an-assertion' }, 401],
    [MUX_PATH, { 'x-automagik-caller': signed({ path: '/api/other' }) }, 401],
    [MUX_PATH, { 'x-automagik-caller': signed({ method: 'POST' }) }, 401],
    [MUX_PATH, { 'x-automagik-caller': signed(), 'x-automagik-caller-2': 'x', Origin: 'https://elsewhere.invalid' }, 403],
    [MUX_PATH, { 'x-automagik-caller': signed(), 'Sec-Fetch-Site': 'cross-site' }, 403],
    [MUX_PATH, { 'x-automagik-caller': signed(), 'Content-Length': '5' }, 400],
    [MUX_PATH, { 'x-automagik-caller': signed(), 'Transfer-Encoding': 'chunked' }, 400],
  ]
  for (const [path, headers, expected] of cases) assert.equal(await status(f.port, path, headers), expected, `${path} ${JSON.stringify(headers)}`)
  // A verified assertion without the session family is refused; the same caller with one opens.
  const b = await bare(t)
  const made = t.mock.method(b.connection, 'createPeer')
  assert.equal(await status(b.port, MUX_PATH, { 'x-automagik-caller': b.assertion('alice', { session: undefined }) }), 401)
  assert.equal(made.mock.callCount(), 0)
  const ok = member(b.port, b.assertion('alice'))
  await ok.opened
  ok.ws.close()
  await ok.closed
  assert.equal(b.fake.opened.length, 0)
  // A replayed assertion is consumed once.
  const replayed = signed()
  const first = member(f.port, replayed)
  await first.opened
  assert.equal(await status(f.port, MUX_PATH, { 'x-automagik-caller': replayed }), 401)
  first.ws.close()
  await first.closed
  // A non-GET upgrade is refused before admission.
  const post = connect({ host: '127.0.0.1', port: f.port })
  let text = ''
  post.on('data', chunk => { text += chunk })
  post.write(`POST ${MUX_PATH} HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nx-automagik-caller: ${signed({ method: 'POST' })}\r\n\r\n`)
  await once(post, 'close')
  assert.match(text, /^HTTP\/1\.1 400 /)
  assert.equal(open.mock.callCount(), 0)
  assert.equal(created.mock.callCount(), 1, 'only the admitted socket made a Peer')
})

test('HTTP and upgrade share admitCaller', async t => {
  let nextNonce
  const f = await host(t, { signerRandom: size => nextNonce ?? randomBytes(size) })
  const principal = person('first')
  const refusals = [
    [{}, 401],
    [{ 'x-automagik-caller': 'bad' }, 401],
    [{ 'Sec-Fetch-Site': 'cross-site' }, 403],
    [{ Origin: 'https://elsewhere.invalid' }, 403],
  ]
  for (const [headers, expected] of refusals) {
    const assertion = headers['x-automagik-caller'] ?? (Object.keys(headers).length ? f.sign(principal) : undefined)
    const upgradeHeaders = { ...headers, ...(assertion ? { 'x-automagik-caller': assertion } : {}) }
    assert.equal(await status(f.port, MUX_PATH, upgradeHeaders), expected)
    const http = await new Promise(resolve => {
      const httpAssertion = headers['x-automagik-caller'] ?? (Object.keys(headers).length ? f.sign(principal, { method: 'POST', path: '/api/fixture/call' }) : undefined)
      const req = httpRequest({ host: '127.0.0.1', port: f.port, method: 'POST', path: prefix + '/api/fixture/call', headers: {
        ...headers, ...(httpAssertion ? { 'x-automagik-caller': httpAssertion } : {}), 'content-type': 'application/json',
      } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
      req.end(rpc('fixture/call', { args: {} }))
    })
    assert.equal(http, expected)
  }
  // A signed request succeeds on both with the adapter's own clock (no `now` passed).
  const socket = f.socket(principal)
  await socket.opened
  const reply = await httpCall(f.port, f.sign(principal, { method: 'POST', path: '/api/fixture/call' }), '/api/fixture/call', rpc('fixture/call', { args: {} }))
  assert.equal(reply.status, 200)
  // Each assertion is signed for its own verb and path, with a deliberately shared nonce.
  const paired = (method, path, nonce) => {
    nextNonce = nonce
    try { return f.signer.sign({ principal, familyId: 'replay-family', method, path }) }
    finally { nextNonce = undefined }
  }
  const rpcPath = '/api/fixture/call'
  const call = nonce => httpCall(f.port, paired('POST', rpcPath, nonce), rpcPath, rpc('fixture/call', { args: {} }))
  const httpFirst = Buffer.alloc(16, 0x11)
  assert.equal((await call(httpFirst)).status, 200)
  assert.equal(await status(f.port, MUX_PATH, { 'x-automagik-caller': paired('GET', MEMBER_PATH, httpFirst) }), 401)
  const upgradeFirst = Buffer.alloc(16, 0x22)
  const shared = paired('GET', MEMBER_PATH, upgradeFirst)
  const opened = member(f.port, shared)
  await opened.opened
  assert.equal(await status(f.port, MUX_PATH, { 'x-automagik-caller': shared }), 401)
  assert.equal((await call(upgradeFirst)).status, 401)
  for (const c of [socket, opened]) { c.ws.close(); await c.closed }
})

test('the upgrade, HTTP and the probe are 503 until carrier, appReady, gateway and policy are present', async t => {
  const listeners = new Set()
  const appReady = { onReady(listener) { listeners.add(listener); return () => listeners.delete(listener) } }
  const f = await host(t, { appReady })
  const principal = person('first')
  assert.equal(await status(f.port, MUX_PATH, { 'x-automagik-caller': f.sign(principal) }), 503)
  assert.equal((await probe(f.port)).status, 503)
  assert.equal((await callMember(f)).status, 503)
  for (const fire of listeners) fire()
  const ready = await probe(f.port)
  assert.equal(ready.status, 204)
  assert.equal(ready.body.length, 0)
  assert.deepEqual(ready.raw.filter((_, i) => i % 2 === 0 && ready.raw[i].toLowerCase() === 'x-automagik-ready').length, 1)
  assert.equal(ready.headers['x-automagik-ready'], '1')
  assert.notEqual(ready.headers.connection, 'close')
  const ok = f.socket(principal)
  await ok.opened
  ok.ws.close()
  await ok.closed

  // A missing gateway or policy owner closes admission.
  const bareHost = await host(t, { gateway: false })
  assert.equal((await probe(bareHost.port)).status, 503)
  assert.equal(await status(bareHost.port, MUX_PATH, { 'x-automagik-caller': bareHost.sign(principal) }), 503)
  assert.equal((await callMember(bareHost)).status, 503)
  const noPolicy = await host(t, { remoteAccess: false })
  assert.equal((await probe(noPolicy.port)).status, 503)
  assert.equal(await status(noPolicy.port, MUX_PATH, { 'x-automagik-caller': noPolicy.sign(principal) }), 503)
  const http = await httpCall(noPolicy.port, noPolicy.sign(principal, { method: 'POST', path: '/api/fixture/call' }), '/api/fixture/call', rpc('fixture/call', { args: {} }))
  assert.equal(http.status, 503)
  // No adapter: A's reservation answers 503 for the probe and the private upgrade.
  await f.dispose()
  assert.equal((await probe(f.port)).status, 503)
  assert.equal(await status(f.port, MUX_PATH, { 'x-automagik-caller': f.sign(principal) }), 503)
})

test('socket caps refuse the fifth socket of a person and free the slot only after teardown', async t => {
  const f = await bare(t, { socketLimits: { maxSocketsPerPerson: 4, maxSockets: 6 } })
  const created = t.mock.method(f.connection, 'createPeer')
  const four = []
  for (let i = 0; i < 4; i++) {
    const c = f.socket('alice')
    await c.opened
    four.push(c)
  }
  const fifth = f.socket('alice')
  await assert.rejects(fifth.opened, error => error.status === 429)
  const bob = [f.socket('bob'), f.socket('bob')]
  for (const c of bob) await c.opened
  const total = f.socket('carol')
  await assert.rejects(total.opened, error => error.status === 503)
  assert.equal(created.mock.callCount(), 6)
  // Closing starts teardown; the slot is free only once the socket and its Peer are released.
  let released = false
  const peer = created.mock.calls[0].result
  const dispose = peer.dispose.bind(peer)
  peer.dispose = async () => { await dispose(); released = true }
  four[0].ws.close()
  await four[0].closed
  while (!released) await sleep(5)
  const again = f.socket('alice')
  await again.opened
  for (const c of [...four.slice(1), ...bob, again]) { c.ws.close(); await c.closed }
})

// --- B6-B8, B14: limits and the downlink --------------------------------------------------------

test('stream and message limits', async t => {
  const f = await bare(t, { limits: { maxStreamsPerSocket: 64 } })
  const hold = controlled()
  f.fake.streams.set('fixture/hold', hold.make)
  const a = f.socket('alice')
  await a.opened
  for (let i = 1; i <= 64; i++) a.open(String(i), 'fixture/hold')
  a.open('65', 'fixture/hold')
  const refused = await a.terminal('65')
  assert.equal(refused.type, 'error')
  assert.equal(refused.error.code, 'gateway/protocol')
  while (f.fake.opened.length < 64) await sleep(5)
  assert.equal(f.fake.opened.length, 64)
  // Exactly 1 MiB passes the socket (the stream's own inbox overflows), 1 MiB + 1 is 1009.
  const exact = (size, streamId = '1') => {
    const shell = JSON.stringify({ type: 'item', streamId, value: '' })
    return JSON.stringify({ type: 'item', streamId, value: 'x'.repeat(size - Buffer.byteLength(shell)) })
  }
  a.send(exact(1_048_576))
  const overflow = await a.terminal('1')
  assert.equal(overflow.error.code, 'gateway/uplink-overflow')
  assert.equal(a.ws.readyState, WebSocket.OPEN)
  a.send(exact(1_048_577, '2'))
  assert.equal((await a.closed).code, 1009)

  // Split over fragments, the reassembled size still counts.
  const b = f.socket('bob')
  await b.opened
  const text = exact(1_048_577, 'x')
  b.ws.send(text.slice(0, 600_000), { fin: false })
  b.ws.send(text.slice(600_000), { fin: true })
  assert.equal((await b.closed).code, 1009)

  // Malformed and duplicate ids are 1008, binary is 1003.
  for (const [message, code, open] of [['{', 1008], [JSON.stringify({ type: 'open', streamId: 'd', endpoint: 'fixture/hold', payload: { args: {} } }), 1008, true],
    [Buffer.from('binary'), 1003]]) {
    const c = f.socket('carol')
    await c.opened
    if (open) c.open('d', 'fixture/hold')
    c.ws.send(message)
    assert.equal((await c.closed).code, code)
  }
})

function rawFrames(count, { opcode = 1, body = 'x' } = {}) {
  const frames = []
  for (let i = 0; i < count; i++) {
    const last = i === count - 1
    const payload = Buffer.from(body)
    const header = Buffer.from([(last ? 0x80 : 0) | (i === 0 ? opcode : 0), 0x80 | payload.length])
    const mask = Buffer.alloc(4)
    frames.push(header, mask, payload)
  }
  return Buffer.concat(frames)
}

test('a message over the frame limit destroys the socket, also from the upgrade head', async t => {
  const counter = []
  const count = fragmentCounter(3, () => counter.push('exceeded'))
  count(rawFrames(3))
  count(rawFrames(2).subarray(0, 5))
  count(rawFrames(2).subarray(5))
  assert.deepEqual(counter, [])
  // Control frames inside a fragmented message do not count.
  const ping = Buffer.from([0x89, 0x80, 0, 0, 0, 0])
  const frames = rawFrames(3)
  count(Buffer.concat([frames.subarray(0, 7), ping, frames.subarray(7)]))
  assert.deepEqual(counter, [])
  count(rawFrames(4))
  assert.deepEqual(counter, ['exceeded'])

  const f = await bare(t)
  const hold = controlled()
  f.fake.streams.set('fixture/hold', hold.make)
  for (const head of [false, true]) {
    const socket = connect({ host: '127.0.0.1', port: f.port })
    const handshake = [`GET ${MUX_PATH} HTTP/1.1`, `Host: 127.0.0.1:${f.port}`, 'Connection: Upgrade', 'Upgrade: websocket',
      'Sec-WebSocket-Version: 13', `Sec-WebSocket-Key: ${Buffer.alloc(16, 2).toString('base64')}`,
      `x-automagik-caller: ${f.assertion('alice')}`].join('\r\n') + '\r\n\r\n'
    // One text message in 1025 frames: the tap destroys the socket before ws delivers it.
    const split = rawFrames(1025, { body: '' })
    let text = ''
    socket.on('data', chunk => { text += chunk.toString('latin1') })
    socket.on('error', () => {})
    if (head) socket.write(Buffer.concat([Buffer.from(handshake), split]))
    else {
      socket.write(handshake)
      while (!text.includes('\r\n\r\n')) await sleep(5)
      socket.write(split)
    }
    await once(socket, 'close')
    assert.match(text, /^HTTP\/1\.1 101 /)
    // Destroyed, not closed with a close frame (a message ws delivered would be 1008).
    assert.equal(text.slice(text.indexOf('\r\n\r\n') + 4).includes('\x88'), false)
  }
  assert.equal(f.fake.opened.length, 0)
  while (f.mux.size) await sleep(5)
})

test('a slow socket is closed and the fast one survives', async t => {
  const f = await bare(t, { limits: { personQueueBytes: 1_048_576 }, project: identity })
  f.fake.streams.set('fixture/flood', ({ signal }) => (async function* () {
    const chunk = 'y'.repeat(65_536)
    for (let i = 0; i < 400 && !signal.aborted; i++) {
      yield chunk
      await tick()
    }
  })())
  const fast = f.socket('alice')
  const slow = f.socket('alice')
  await Promise.all([fast.opened, slow.opened])
  // The slow tab stops reading; its unsent bytes grow until the person's budget is crossed.
  slow.ws._socket.pause()
  slow.open('s', 'fixture/flood')
  while (f.fake.opened.length < 1) await sleep(5)
  const slowStream = f.fake.opened[0]
  fast.open('f', 'fixture/flood')
  while (!slowStream.signal.aborted) await sleep(5)
  // The server closed the slow socket 1008 behind its backlog; the fast one keeps receiving.
  await fast.until(() => fast.of('f').some(frame => frame.type === 'end'), 20_000)
  assert.equal(fast.of('f').filter(frame => frame.type === 'item').length, 400)
  assert.equal(fast.ws.readyState, WebSocket.OPEN)
  slow.ws._socket.resume()
  assert.equal((await slow.closed).code, 1008)
  assert.equal(slow.of('s').some(frame => frame.type === 'end'), false)
  fast.ws.close()
  await fast.closed
})

test('a slow reader flooded with Pings is closed by the control-write budget', { timeout: 3000 }, async t => {
  const f = await bare(t, { limits: { personQueueBytes: 512, maxWriteDelayMs: 1000 } })
  const original = WebSocket.prototype.pong
  const stalled = Promise.withResolvers()
  let writes = 0
  t.mock.method(WebSocket.prototype, 'pong', function (...args) {
    if (!this._isServer) return Reflect.apply(original, this, args)
    writes++
    stalled.resolve(this)
    // Model a slow transport that has not acknowledged the Pong's write callback.
  })
  const slow = f.socket('alice')
  await slow.opened
  slow.ws._socket.pause()
  for (let i = 0; i < 20; i++) slow.ws.ping(Buffer.alloc(125))
  const ws = await stalled.promise
  while (ws.readyState === WebSocket.OPEN && writes === 1) await tick()
  assert.equal(writes, 1, 'the other Pongs never bypass the accounted writer')
  assert.equal(ws.readyState, WebSocket.CLOSING)
  slow.ws._socket.resume()
  assert.equal((await slow.closed).code, 1008)
})

// A stalled in-process WebSocket keeps queue behavior deterministic without loopback.
function stalledWriterMux(t, { open, limits, project = identity }) {
  const registry = createPeerRegistry()
  const scope = createScope()
  const mux = createMux({ wireStream: { open }, scope, registry, ready: () => true, project, limits })
  t.after(() => mux.close())
  t.mock.method(WebSocketServer.prototype, 'handleUpgrade', (ws, _socket, _head, done) => done(ws))
  return {
    mux,
    async socket(subject = 'one') {
      const principal = { kind: 'automagik', instance, person: person(subject) }
      const peer = { ctx: { effect() {} }, async dispose() {} }
      registry.add(peer, { principal, kind: 'socket' })
      const ws = new EventEmitter()
      const written = []
      const controls = []
      let flush
      let stalled = true
      Object.assign(ws, {
        readyState: WebSocket.OPEN,
        close(code) { this.readyState = WebSocket.CLOSED; this.code = code; this.emit('close') },
        terminate() { this.close(1006) },
        send(text, done) { written.push(JSON.parse(text)); done() },
        pong(data, done) {
          controls.push(data)
          if (stalled) flush = done
          else done()
        },
      })
      const done = mux.handleUpgrade(ws, new EventEmitter(), Buffer.alloc(0), { peer, principal, binding: true })
      t.after(() => { ws.terminate(); return done })
      const message = message => ws.emit('message', Buffer.from(JSON.stringify(message)), false)
      ws.emit('ping', Buffer.alloc(0))
      return {
        ws, written, controls,
        open: (streamId, endpoint, payload = { args: {} }) => message({ type: 'open', streamId, endpoint, payload }),
        cancel: streamId => message({ type: 'cancel', streamId }),
        flush() { stalled = false; flush?.() },
      }
    },
  }
}

test('large rejected opens leave only withdrawal keys and queued errors behind a stalled writer', async t => {
  const opened = []
  const held = Promise.withResolvers()
  const empty = []
  t.after(() => held.resolve(empty))
  const f = stalledWriterMux(t, {
    limits: { personQueueBytes: 1_048_576 },
    async open(endpoint, payload) {
      opened.push([endpoint, payload.args.large.length])
      if (endpoint === 'fixture/held') return held.promise
      throw new Error('open rejected by gateway')
    },
  })
  const first = await f.socket()
  const second = await f.socket()
  const large = { args: { large: 'x'.repeat(300_000) } }
  const records = []
  const mapSet = Map.prototype.set
  const capture = t.mock.method(Map.prototype, 'set', function (key, value) {
    if (typeof key === 'string' && key.startsWith('rejected-')) records.push(value)
    return Reflect.apply(mapSet, this, [key, value])
  })
  for (let i = 0; i < 40; i++) {
    first.open(`rejected-${i}`, 'fixture/reject', large)
    await tick()
  }
  capture.mock.restore()
  assert.equal(opened.length, 40, 'rejections immediately return their argument budget')
  assert.equal(first.written.length, 0)
  assert.equal(records.length, 40)
  for (const [i, record] of records.entries()) {
    assert.deepEqual(record, {
      id: `rejected-${i}`, endpoint: 'fixture/reject', resourceKey: undefined,
      retainedBytes: Buffer.byteLength('fixture/reject'), source: undefined, ended: false, frames: 1,
    }, 'the internal record holds one queued error and no open payload')
  }
  const retained = []
  f.mux.end(entry => { retained.push(entry); return false })
  assert.equal(retained.length, 40)
  for (const entry of retained) {
    assert.deepEqual(Object.keys(entry).sort(), ['endpoint', 'peer', 'principal', 'resourceKey', 'session', 'streamId'])
    assert.equal(entry.endpoint, 'fixture/reject')
    assert.match(entry.streamId, /^rejected-/)
  }
  first.open('held-1', 'fixture/held', large)
  first.open('held-2', 'fixture/held', large)
  second.open('held-3', 'fixture/held', large)
  second.open('over-budget', 'fixture/held', large)
  assert.equal(opened.length, 43, 'pending arguments are charged across the person’s sockets')
  second.flush()
  await tick()
  assert.equal(second.written.find(frame => frame.streamId === 'over-budget').error.code, 'gateway/protocol')
  held.resolve(empty)
  await tick()
  second.open('after-open', 'fixture/reject', large)
  await tick()
  assert.equal(opened.length, 44)
  first.flush()
  await tick()
  assert.equal(first.written.filter(frame => frame.streamId.startsWith('rejected-')).length, 40)
})

test('withdrawal drops queued output only for the matching resource on the same endpoint', async t => {
  const opened = [], projected = []
  const endpoint = 'session/follow'
  const sources = { session: controlled(), subagent: controlled() }
  sources.session.push('queued for the first session')
  sources.subagent.push('queued for the second session')
  const f = stalledWriterMux(t, {
    async open(_endpoint, { args }, _inbox, _peer, signal) {
      opened.push(signal)
      return sources[args.request.address.kind].make({ signal })
    },
    project({ endpoint, resourceKey, item }) {
      projected.push([endpoint, resourceKey])
      return item
    },
  })
  const client = await f.socket()
  const follow = (streamId, address) => client.open(streamId, endpoint, { args: { request: { address } } })
  follow('first', { kind: 'session', sessionId: 'session-1' })
  follow('second', { kind: 'subagent', parentSessionId: 'session-1', childSessionId: 'session-2' })
  follow('malformed', { kind: 'session', sessionId: { id: 'session-1' } })
  follow('too-long', { kind: 'session', sessionId: 'é'.repeat(257) })
  follow('unpaired', { kind: 'session', sessionId: '\ud800' })
  await tick()
  assert.equal(opened.length, 2)
  assert.deepEqual(projected, [[endpoint, 'session-1'], [endpoint, 'session-2']])
  assert.deepEqual(client.written, [])
  assert.equal(f.mux.end(stream => stream.endpoint === endpoint && stream.resourceKey === 'session-1'), 1)
  assert.deepEqual(opened.map(signal => signal.aborted), [true, false])
  client.flush()
  sources.subagent.push('after withdrawal')
  sources.subagent.end()
  await tick()
  assert.deepEqual(client.written.filter(frame => frame.streamId === 'first').map(frame => frame.error?.code), ['remote-access/denied'])
  assert.deepEqual(client.written.filter(frame => frame.streamId === 'second'), [
    { type: 'item', streamId: 'second', value: 'queued for the second session' },
    { type: 'item', streamId: 'second', value: 'after withdrawal' },
    { type: 'end', streamId: 'second' },
  ])
  for (const id of ['malformed', 'too-long', 'unpaired']) {
    assert.equal(client.written.find(frame => frame.streamId === id).error.code, 'gateway/protocol')
  }
})

test('a resource key holds its share of the person budget until its queued output drains', async t => {
  const opened = []
  const f = stalledWriterMux(t, {
    limits: { personQueueBytes: 1200 },
    async open(endpoint) { opened.push(endpoint); return [] },
  })
  const first = await f.socket()
  const second = await f.socket()
  first.open('follow', 'session/follow', { args: { request: { address: { kind: 'session', sessionId: 'é'.repeat(256) } } } })
  await tick()
  assert.deepEqual(opened, ['session/follow'])
  assert.deepEqual(first.written, [])
  const payload = { args: { large: 'x'.repeat(750) } }
  second.open('held', 'fixture/large', payload)
  assert.deepEqual(opened, ['session/follow'])
  second.flush()
  await tick()
  assert.equal(second.written.find(frame => frame.streamId === 'held').error.code, 'gateway/protocol')
  first.flush()
  await tick()
  second.open('released', 'fixture/large', payload)
  assert.deepEqual(opened, ['session/follow', 'fixture/large'])
})

test('queued Pong data is copied out of the receive allocation', async t => {
  const f = stalledWriterMux(t, {})
  const copy = await f.socket()
  const incoming = Buffer.alloc(131_072, 0x61).subarray(17, 20)
  copy.ws.emit('ping', incoming)
  copy.flush()
  await tick()
  assert.deepEqual(copy.controls[1], Buffer.from('aaa'))
  assert.ok(copy.controls[1].buffer !== incoming.buffer, 'the Pong must release the receive allocation')
})

test('empty Pings hit the socket and person writer entry caps', async t => {
  const f = stalledWriterMux(t, { limits: {
    personQueueBytes: 1_048_576, maxWriterEntriesPerPerson: 6, maxWriterEntriesPerSocket: 4,
  } })
  const alone = await f.socket('alone')
  for (let i = 0; i < 3; i++) alone.ws.emit('ping', Buffer.alloc(0))
  assert.equal(alone.ws.readyState, WebSocket.OPEN)
  alone.ws.emit('ping', Buffer.alloc(0))
  assert.equal(alone.ws.code, 1008)
  assert.equal(alone.controls.length, 1)

  const one = await f.socket('shared')
  const two = await f.socket('shared')
  for (let i = 0; i < 2; i++) {
    one.ws.emit('ping', Buffer.alloc(0))
    two.ws.emit('ping', Buffer.alloc(0))
  }
  assert.equal(one.ws.readyState, WebSocket.OPEN)
  assert.equal(two.ws.readyState, WebSocket.OPEN)
  two.ws.emit('ping', Buffer.alloc(0))
  assert.equal(two.ws.code, 1008)
  assert.equal(one.ws.readyState, WebSocket.OPEN)
  assert.equal(two.controls.length, 1)
})

test('the 65th open reserves its refused ID until the writer completes the error', async t => {
  let opened = 0
  const f = stalledWriterMux(t, {
    async open(_endpoint, _payload, _uplink, _peer, signal) {
      opened++
      return controlled().make({ signal })
    },
  })
  for (const flush of [false, true]) {
    const client = await f.socket()
    const before = opened
    for (let i = 0; i < 64; i++) client.open(String(i), 'fixture/hold')
    client.open('refused', 'fixture/hold')
    await tick()
    assert.equal(opened, before + 64)
    client.cancel('1')
    await tick()
    if (flush) {
      client.flush()
      await tick()
      assert.equal(client.written.find(frame => frame.streamId === 'refused').error.code, 'gateway/protocol')
    }
    client.open('refused', 'fixture/hold')
    await tick()
    assert.equal(opened, before + (flush ? 65 : 64))
    assert.equal(client.ws.readyState, flush ? WebSocket.OPEN : WebSocket.CLOSED)
    if (!flush) assert.equal(client.ws.code, 1008)
  }
})

test('a stalled Pong has the same write deadline as a data frame', { timeout: 3000 }, async t => {
  const f = await bare(t, { limits: { maxWriteDelayMs: 100 } })
  const stalled = Promise.withResolvers()
  t.mock.method(WebSocket.prototype, 'pong', function () { stalled.resolve() })
  const slow = f.socket('alice')
  await slow.opened
  slow.ws.ping('held')
  await stalled.promise
  assert.equal((await slow.closed).code, 1006)
  assert.equal(f.fake.opened.length, 0)
})

test('an owner-visible broadcast burst never fills a member event queue', async t => {
  const f = await host(t, { events: true })
  const memberSocket = f.socket(person('first'))
  await memberSocket.opened
  memberSocket.open('e', '$events')
  const [ready] = await memberSocket.until(() => memberSocket.of('e').length && memberSocket.of('e'))
  assert.equal(ready.value.type, 'ready')
  const owner = f.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' })
  const control = await f.gateway.wireStream.open('$events', { args: {} }, (async function* () {})(), owner, new AbortController().signal)
  const iterator = control[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value.type, 'ready')
  for (let i = 0; i < 1000; i++) f.eventSource.push({ event: 'fixture/notice', args: [i] })
  for (let i = 0; i < 1000; i++) assert.deepEqual((await iterator.next()).value, { type: 'emit', event: 'fixture/notice', args: [i] })
  const memberClients = [...f.gateway.remoteEventClients.values()].filter(client => !client.answers)
  assert.equal(memberClients.length, 1)
  assert.equal(memberClients[0].queue.frames.size, 0)
  assert.deepEqual(memberSocket.of('e').map(frame => frame.value.type), ['ready'])
  await iterator.return()
  await owner.dispose()
  memberSocket.ws.close()
  await memberSocket.closed
})

test('end() drops queued frames and an item already pulled', async t => {
  const f = await bare(t, { limits: { personQueueBytes: 256 * 1024 * 1024 }, project: identity })
  const second = controlled()
  // Stream 1 yields a frame large enough to stall the writer, two frames that stay queued, and
  // one more item that the pump has pulled when end() runs.
  const big = 'z'.repeat(24 * 1024 * 1024)
  const first = [{ n: 0, big }, { n: 1 }, { n: 2 }, { n: 3 }]
  let returned = false
  let ended
  f.fake.streams.set('fixture/first', () => ({
    [Symbol.asyncIterator]() { return this },
    async next() {
      if (!first.length) return new Promise(() => {})
      const value = first.shift()
      if (value.n === 3) ended = f.mux.end(({ endpoint }) => endpoint === 'fixture/first', 'withdrawn')
      return { value, done: false }
    },
    async return() { returned = true; return { value: undefined, done: true } },
  }))
  f.fake.streams.set('fixture/second', second.make)
  const a = f.socket('alice')
  await a.opened
  a.ws._socket.pause()
  a.open('2', 'fixture/second')
  while (f.fake.opened.length < 1) await sleep(5)
  a.open('1', 'fixture/first')
  while (!returned) await sleep(5)
  assert.equal(ended, 1)
  second.push({ ok: true })
  await sleep(50)
  a.ws._socket.resume()
  const terminal = await a.terminal('1', 20_000)
  assert.equal(terminal.type, 'error')
  assert.equal(terminal.error.code, 'remote-access/denied')
  await a.until(() => a.of('2').length === 1, 20_000)
  // Only the frame already handed to ws.send arrives; the queued ones and the pulled item do not.
  assert.deepEqual(a.of('1').filter(frame => frame.type === 'item').map(frame => frame.value.n), [0])
  assert.deepEqual(a.of('2')[0], { type: 'item', streamId: '2', value: { ok: true } })
  a.ws.close()
  await a.closed
})

test('a finished stream keeps its ID and can be withdrawn while its output is queued', { timeout: 5000 }, async t => {
  const f = await bare(t, { project: identity })
  const stalled = [Promise.withResolvers(), Promise.withResolvers()]
  const send = WebSocket.prototype.send
  let blocked = 0
  t.mock.method(WebSocket.prototype, 'send', function (text, ...args) {
    if (this._isServer && JSON.parse(text).streamId === 'block') {
      const stall = stalled[blocked]
      blocked += 1
      stall.resolve(() => Reflect.apply(send, this, [text, ...args]))
      return
    }
    return Reflect.apply(send, this, [text, ...args])
  })
  const blocker = controlled()
  blocker.push({ blocking: true })
  f.fake.streams.set('fixture/block', blocker.make)
  const finished = [Promise.withResolvers(), Promise.withResolvers()]
  let opened = 0
  f.fake.streams.set('fixture/finite', () => (async function* () {
    const done = finished[opened++]
    yield { queued: 1 }
    yield { queued: 2 }
    done.resolve()
  })())
  const a = f.socket('alice')
  await a.opened
  a.open('block', 'fixture/block')
  const flush = await stalled[0].promise
  a.open('finite', 'fixture/finite')
  await finished[0].promise
  await tick()
  assert.equal(f.mux.end(({ endpoint }) => endpoint === 'fixture/finite', 'withdrawn'), 1)
  flush()
  const denied = await a.terminal('finite')
  assert.equal(denied.error.code, 'remote-access/denied')
  assert.deepEqual(a.of('finite'), [denied])

  // Hold a second writer and verify a duplicate ID still closes the connection.
  const b = f.socket('bob')
  const secondBlocker = controlled()
  secondBlocker.push({ blocking: true })
  f.fake.streams.set('fixture/block', secondBlocker.make)
  await b.opened
  b.open('block', 'fixture/block')
  await stalled[1].promise
  b.open('finite', 'fixture/finite')
  await finished[1].promise
  await tick()
  b.open('finite', 'fixture/finite')
  assert.equal((await b.closed).code, 1008)
  assert.equal(opened, 2)
  a.ws.close()
  await a.closed
})

test('cancel marks a resolving stream before its next item reaches the writer', { timeout: 5000 }, async t => {
  const f = await bare(t, { project: identity })
  const pulling = Promise.withResolvers()
  const cancelled = Promise.withResolvers()
  const returned = Promise.withResolvers()
  f.fake.streams.set('fixture/cancel', ({ signal }) => ({
    [Symbol.asyncIterator]() { return this },
    next() {
      if (signal.aborted) return { done: true }
      const item = Promise.withResolvers()
      signal.addEventListener('abort', () => {
        item.resolve({ value: 'late', done: false })
        cancelled.resolve()
      }, { once: true })
      pulling.resolve()
      return item.promise
    },
    return() { returned.resolve(); return { done: true } },
  }))
  const a = f.socket('alice')
  await a.opened
  a.open('cancel', 'fixture/cancel')
  await pulling.promise
  a.send({ type: 'cancel', streamId: 'cancel' })
  await cancelled.promise
  // A separate frame acts as a FIFO barrier for any item the cancelled source could have queued.
  f.fake.streams.set('fixture/barrier', () => (async function* () { yield 'barrier' })())
  a.open('barrier', 'fixture/barrier')
  await a.terminal('barrier')
  assert.deepEqual(a.of('cancel'), [])
  await returned.promise
  a.ws.close()
  await a.closed
})

test('stream IDs are limited by UTF-8 bytes before opening a source', async t => {
  const f = await bare(t, { project: identity })
  f.fake.streams.set('fixture/finite', () => (async function* () { yield 1 })())
  const a = f.socket('alice')
  await a.opened
  const valid = 'é'.repeat(128)
  const refused = valid + 'x'
  a.open(refused, 'fixture/finite')
  const failure = await a.terminal(refused)
  assert.equal(failure.error?.code, 'gateway/protocol')
  assert.equal(f.fake.opened.length, 0)
  a.open(valid, 'fixture/finite')
  assert.equal((await a.terminal(valid)).type, 'end')
  assert.equal(f.fake.opened.length, 1)
  a.ws.close()
  await a.closed
})

// --- B7: cancel, close, revocation, family withdrawal ----------------------------------------------------

test('cancel ends one stream; close, policy revocation and family withdrawal end every stream', async t => {
  const f = await bare(t, { project: identity })
  const streams = []
  f.fake.streams.set('fixture/hold', options => {
    const stream = controlled()
    streams.push({ stream, signal: options.signal })
    return stream.make(options)
  })
  const a = f.socket('alice')
  await a.opened
  a.open('1', 'fixture/hold')
  a.open('2', 'fixture/hold')
  while (streams.length < 2) await sleep(5)
  a.send({ type: 'cancel', streamId: '1' })
  while (!streams[0].signal.aborted) await sleep(5)
  assert.equal(streams[1].signal.aborted, false)
  streams[1].stream.push({ alive: true })
  await a.until(() => a.of('2').length === 1)
  assert.equal(a.of('1').length, 0, 'a cancelled stream gets no terminal frame, as in DSH')
  // Socket close ends every stream.
  a.open('3', 'fixture/hold')
  while (streams.length < 3) await sleep(5)
  a.ws.close()
  await a.closed
  while (!streams[1].signal.aborted || !streams[2].signal.aborted) await sleep(5)
  // Revocation (the policy lost) and the end of the gate session family close the socket.
  for (const end of ['revoke', 'family']) {
    const b = f.socket('bob')
    await b.opened
    b.open('1', 'fixture/hold')
    b.open('2', 'fixture/hold')
    const before = streams.length
    while (streams.length < before + 2) await sleep(5)
    if (end === 'revoke') f.registry.revokeAll('policy lost')
    else f.mux.end(({ session }) => session === wire.payload.session, 'session ended')
    if (end === 'revoke') assert.equal((await b.closed).code, 1011)
    while (!streams.slice(before).every(entry => entry.signal.aborted)) await sleep(5)
    if (end === 'family') {
      await b.until(() => b.frames.filter(frame => frame.type === 'error').length === 2)
      assert.ok(b.frames.every(frame => frame.error.code === 'remote-access/denied'))
      b.ws.close()
      await b.closed
    }
  }
})

// --- B9-B13: events, the empty policy, policy loss, unload and parity ------------------------

const resultOf = reply => JSON.parse(reply.body).result

test('a member $events stream gets readiness only and cannot answer', async t => {
  const f = await host(t, { events: true })
  const m = f.socket(person('first'))
  await m.opened
  m.open('e', '$events')
  await m.until(() => m.of('e').length)
  const [ready] = m.of('e')
  assert.equal(ready.value.type, 'ready')
  assert.deepEqual(ready.value.host, { home: '/fixture-home' })
  assert.equal(f.gateway.hasLiveClient(), false)
  // A pending waterfall is the owner's alone.
  const subject = {}
  const settled = []
  f.eventSource.push({ event: 'fixture/ask', request: { agent: subject, question: 'q' },
    context: { agentId: 'agent-1', subject, value: f.ctx }, resolve: value => settled.push(value), reject: error => settled.push(error) })
  while (f.gateway.getPendingRemoteEvents().length < 1) await sleep(5)
  const answer = await httpCall(f.port, f.sign(person('first'), { method: 'POST', path: '/api/$events/result' }), '/api/$events/result',
    rpc('$events/result', { args: { clientId: ready.value.clientId, eventId: 'any', outcome: { kind: 'result', value: 1 } } }))
  assert.equal(answer.status, 200)
  assert.equal(resultOf(answer).ok, false)
  assert.equal(f.gateway.getPendingRemoteEvents().length, 1)
  assert.deepEqual(settled, [])
  // The owner control receives the pending waterfall and ordinary notifications; the member
  // gets neither, and its DSH-side queue stays empty.
  const owner = f.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' })
  const stop = new AbortController()
  const control = (await f.gateway.wireStream.open('$events', { args: {} }, (async function* () {})(), owner, stop.signal))[Symbol.asyncIterator]()
  assert.equal((await control.next()).value.type, 'ready')
  assert.equal((await control.next()).value.type, 'waterfall')
  assert.equal(f.gateway.hasLiveClient(), true)
  f.eventSource.push({ event: 'fixture/notice', args: ['hello'] })
  assert.deepEqual((await control.next()).value, { type: 'emit', event: 'fixture/notice', args: ['hello'] })
  stop.abort()
  await control.return()
  await owner.dispose()
  assert.equal(f.gateway.hasLiveClient(), false)
  const memberClient = [...f.gateway.remoteEventClients.values()].find(client => !client.answers)
  assert.equal(memberClient.queue.frames.size, 0)
  await sleep(20)
  assert.deepEqual(m.of('e').map(frame => frame.value.type), ['ready'])
  m.ws.close()
  await m.closed
})

test('with the empty policy no business call or filtered notification succeeds', async t => {
  const f = await host(t, { events: true })
  const m = f.socket(person('first'))
  await m.opened
  m.open('ticks', 'fixture/ticks')
  const denied = await m.terminal('ticks')
  assert.equal(denied.type, 'error')
  assert.equal(denied.error.code, 'remote-access/denied')
  const call = resultOf(await httpCall(f.port, f.sign(person('first'), { method: 'POST', path: '/api/fixture/call' }), '/api/fixture/call',
    rpc('fixture/call', { args: {} })))
  assert.equal(call.ok, false)
  assert.equal(call.error.code, 'remote-access/denied')
  assert.deepEqual(f.calls, [])
  // The access snapshot and the ready frame are the exceptions.
  m.open('follow', 'remoteAccess/follow')
  await m.until(() => m.of('follow').length)
  assert.deepEqual(m.of('follow')[0].value, { type: 'baseline', owner: false, grants: [] })
  m.open('e', '$events')
  await m.until(() => m.of('e').length)
  f.eventSource.push({ event: 'fixture/notice', args: [1] })
  await sleep(30)
  assert.deepEqual(m.of('e').map(frame => frame.value.type), ['ready'])
  // The owner's own call is unchanged.
  const owner = f.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })
  assert.equal(await f.gateway.invoke({ namespace: 'fixture', method: 'call', args: {}, peer: owner }), 'called')
  await owner.dispose()
  m.ws.close()
  await m.closed
})

const grant = { bindings: () => [{ resource: { kind: 'global' }, role: { actions: ['fixture/call', 'fixture/ticks'] } }] }
const callMember = (f, path = '/api/fixture/call') => {
  const assertion = f.sign(person('first'), { method: 'POST', path })
  return httpCall(f.port, assertion, path, rpc(path.slice('/api/'.length), { args: {} }))
}

test('B11 member RPC reaches only the live gateway and never a foreign interceptor', { timeout: 5000 }, async t => {
  const f = await host(t, { gateway: false, listen: false })
  const authority = `127.0.0.1:${f.port}`
  const request = (url, options = {}) => invoke(f.webServer.match(url).handler, {
    url, method: 'GET', headers: { host: authority }, ...options,
  })
  const ready = () => request(READY_PATH)
  const call = () => {
    const path = '/api/fixture/call'
    return request(prefix + path, {
      method: 'POST', body: rpc('fixture/call', { args: {} }),
      headers: { host: authority, 'content-type': 'application/json',
        'x-automagik-caller': f.sign(person('first'), { method: 'POST', path }) },
    })
  }
  const foreign = t.mock.fn(() => ({ ok: true, value: 'foreign' }))
  const occupiedMatches = t.mock.fn(() => true)
  const occupy = () => f.connection.rpc.intercept('/api', occupiedMatches, foreign)
  let remove = occupy()
  assert.equal((await call()).status, 503)
  assert.equal(occupiedMatches.mock.callCount(), 0)
  assert.equal(foreign.mock.callCount(), 0)
  // The service can exist even when its interceptor failed to register.
  const blocked = f.provideGateway()
  await blocked
  await tick()
  assert.ok(f.ctx.get('typertGateway'))
  assert.equal((await ready()).status, 503)
  assert.equal((await call()).status, 503)
  assert.equal(occupiedMatches.mock.callCount(), 0)
  assert.equal(foreign.mock.callCount(), 0)
  await blocked.dispose()
  await remove()

  const matches = t.mock.fn(() => true)
  let sibling
  const sharedParent = f.provideGateway(c => {
    sibling = c.inject(['connection'], s => { s.connection.rpc.intercept('/api', matches, foreign) })
  })
  await sharedParent
  await sibling
  await tick()
  assert.ok(f.ctx.get('typertGateway'))
  assert.equal(f.connection.interceptors.get('/api').matches, matches)
  assert.equal((await ready()).status, 503)
  assert.equal((await call()).status, 503)
  const upgraded = Promise.withResolvers()
  const socket = new EventEmitter()
  socket.end = text => upgraded.resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1]))
  socket.destroy = () => socket.emit('close')
  const headers = { host: authority, 'x-automagik-caller': f.sign(person('first')) }
  f.webServer.upgrades.get(MUX_PATH).handler({ method: 'GET', url: MUX_PATH, headers, rawHeaders: Object.entries(headers).flat() }, socket, Buffer.alloc(0))
  assert.equal(await upgraded.promise, 503)
  socket.destroy()
  assert.equal(matches.mock.callCount(), 0)
  assert.equal(foreign.mock.callCount(), 0)
  await sharedParent.dispose()

  let observer, unrelated
  const unrelatedFetch = t.mock.fn(() => new Response('unrelated'))
  const live = f.provideGateway(c => {
    observer = c.inject(['connection'], s => { assert.ok(s.connection) })
    unrelated = c.inject(['connection'], s => {
      s.connection.fetch.register({ path: '/api/unrelated', methods: ['POST'], requestBody: 'streaming', fetch: unrelatedFetch })
    })
  })
  await live
  await observer
  await unrelated
  await tick()
  assert.equal(f.connection.fetchRoutes.get('/api/unrelated')?.fetch, unrelatedFetch)
  assert.equal((await ready()).status, 204)
  const denied = await call()
  assert.equal(resultOf({ ...denied, body: denied.bytes.toString() }).error.code, 'remote-access/denied')
  assert.equal(unrelatedFetch.mock.callCount(), 0)
  const exact = t.mock.fn(() => new Response('owner only'))
  const removeExact = f.connection.fetch.register({
    path: '/api/fixture/call', methods: ['POST'], requestBody: 'streaming', fetch: exact,
  })
  assert.equal((await call()).status, 403)
  assert.equal(exact.mock.callCount(), 0)
  await removeExact()
  await live.dispose()
  remove = occupy()
  assert.equal((await call()).status, 503)
  assert.equal(occupiedMatches.mock.callCount(), 0)
  assert.equal(foreign.mock.callCount(), 0)
  assert.deepEqual(f.calls, [])
  await remove()
})

test('gateway replacement closes an idle access-snapshot follower before the next heartbeat', { timeout: 5000 }, async t => {
  const f = await host(t, { gateway: false, listen: false })
  const authority = `127.0.0.1:${f.port}`
  const principal = person('idle')
  t.mock.method(WebSocketServer.prototype, 'handleUpgrade', (_req, socket, _head, done) => done(socket))
  const follow = (stall = false) => {
    const socket = new EventEmitter()
    const frames = []
    const first = Promise.withResolvers()
    const closed = Promise.withResolvers()
    let finishPong
    Object.assign(socket, {
      readyState: WebSocket.OPEN,
      close(code) { this.readyState = WebSocket.CLOSED; this.emit('close', code) },
      destroy() { this.close(1006) },
      end(text) { first.reject(new Error(text)); this.destroy() },
      send(text, done) { frames.push(JSON.parse(text)); first.resolve(frames[0]); done() },
      ping(_data, done) { done() },
      pong(_data, done) { finishPong = done },
    })
    socket.once('close', closed.resolve)
    const headers = { host: authority, 'x-automagik-caller': f.sign(principal) }
    f.webServer.upgrades.get(MUX_PATH).handler({ method: 'GET', url: MUX_PATH, headers, rawHeaders: Object.entries(headers).flat() }, socket, Buffer.alloc(0))
    if (stall) socket.emit('ping', Buffer.alloc(0))
    socket.emit('message', JSON.stringify({ type: 'open', streamId: 'access', endpoint: 'remoteAccess/follow', payload: { args: {} } }))
    return { socket, frames, first: first.promise, closed: closed.promise, flush: () => finishPong?.() }
  }
  const old = f.provideGateway()
  await old
  await tick()
  const follower = follow()
  const baseline = await follower.first
  assert.equal(baseline.type, 'item')
  assert.equal(baseline.value.type, 'baseline')
  const queued = follow(true)
  await tick()
  assert.equal(f.access.followers.size, 2)
  assert.deepEqual(queued.frames, [])

  await old.dispose()
  const current = f.provideGateway()
  await current
  await tick()
  const probe = await invoke(f.webServer.match(READY_PATH).handler, { method: 'GET', url: READY_PATH, headers: { host: authority } })
  assert.equal(probe.status, 204)
  const deadline = sleep(500, 'still open')
  assert.equal(await Promise.race([follower.closed, deadline]), 1011)
  assert.equal(await Promise.race([queued.closed, deadline]), 1011)
  queued.flush()
  await tick()
  assert.deepEqual(queued.frames, [])
  assert.deepEqual(follower.frames, [baseline])
  assert.equal(f.access.followers.size, 0)
  const fresh = follow()
  assert.equal((await fresh.first).value.type, 'baseline')
  fresh.socket.close()
  await fresh.closed
})

test('a shared gateway cannot use a different RemoteAccessService from the adapter policy', async t => {
  const f = await host(t, { isolatedAccess: true, foreign: grant })
  const principal = { kind: 'automagik', instance, person: person('first') }
  const decide = { principal, action: 'fixture/call', resources: [{ kind: 'global' }] }
  const isolated = f.adapterCtx.get('remoteAccess')
  assert.ok(f.access instanceof RemoteAccessService)
  assert.ok(isolated instanceof RemoteAccessService)
  assert.notEqual(f.access.policies, isolated.policies)
  assert.equal(f.ctx.get('typertGateway').wireStream, f.adapterCtx.get('typertGateway').wireStream)
  assert.equal(f.access.decide(decide).kind, 'allow')
  assert.equal(isolated.decide(decide).kind, 'deny')
  assert.equal((await probe(f.port)).status, 503)
  assert.equal((await callMember(f)).status, 503)
  assert.equal(await status(f.port, MUX_PATH, { 'x-automagik-caller': f.sign(principal.person) }), 503)
  assert.deepEqual(f.calls, [])
})

test('a foreign or lost policy closes admission, open streams, a second open and held HTTP', { timeout: 5000 }, async t => {
  const warn = t.mock.method(console, 'warn', () => {})
  const taken = await host(t, { foreign: grant })
  assert.ok(warn.mock.calls.some(call => /automagik policy is not ours/.test(call.arguments[0])))
  assert.equal((await probe(taken.port)).status, 503)
  assert.equal(await status(taken.port, MUX_PATH, { 'x-automagik-caller': taken.sign(person('first')) }), 503)
  assert.equal((await callMember(taken)).status, 503)
  assert.deepEqual(taken.calls, [])

  const f = await host(t, { plugins: true })
  const open = t.mock.method(f.gateway.wireStream, 'open')
  const m = f.socket(person('first'))
  await m.opened
  m.open('hold', 'remoteAccess/follow')
  await m.until(() => m.of('hold').length === 1)
  const body = rpc('fixture/call', { args: {} })
  const path = '/api/fixture/call'
  const arrived = once(f.webServer.server, 'request')
  const { promise: held, resolve, reject } = Promise.withResolvers()
  const req = httpRequest({ host: '127.0.0.1', port: f.port, method: 'POST', path: prefix + path, headers: {
    'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)),
    'x-automagik-caller': f.sign(person('first'), { method: 'POST', path }),
  } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
  req.on('error', reject)
  t.after(() => req.destroy())
  req.write(body.slice(0, 5))
  await arrived
  await f.accessFiber().dispose()
  assert.equal(open.mock.calls[0].arguments[4].aborted, true)
  // A second open on the original socket, sent after the loss, opens nothing.
  m.send({ type: 'open', streamId: 'again', endpoint: 'remoteAccess/follow', payload: { args: {} } })
  assert.equal((await m.closed).code, 1011)
  assert.equal((await probe(f.port)).status, 503)
  assert.equal(await held, 503, 'policy loss cancels an unfinished upload')
  await f.provideAccess()
  assert.equal((await probe(f.port)).status, 204)
  assert.equal(open.mock.callCount(), 1)
  assert.deepEqual(f.calls, [])
  assert.equal(resultOf(await callMember(f)).error.code, 'remote-access/denied')
})

for (const event of ['adapter disposal', 'connection loss']) {
  test(`unload closes sockets at once and drains admitted HTTP across ${event}`, async t => {
    const stub = fakeWire()
    stub.streams.set('fixture/hold', controlled().make)
    const f = await host(t, { plugins: true, stub })
    const entered = Promise.withResolvers()
    const hold = Promise.withResolvers()
    t.mock.method(f.gateway, 'claimsEndpoint', () => true)
    t.mock.method(f.gateway, 'dispatchRpc', async (_method, _body, _signal, peer) => {
      assert.equal(f.access.decide({ principal: peer.principal, action: 'remoteAccess/follow', resources: [] }).kind, 'allow')
      entered.resolve()
      await hold.promise
      const caller = callerOf(f.ctx)
      assert.equal(caller, peer.principal)
      return { ok: true, value: caller.person.subject }
    })
    assert.throws(() => f.webServer.registerUpgrade({ path: MUX_PATH, handler() {} }), /routes are reserved/)
    const m = f.socket(person('first'))
    await m.opened
    m.open('hold', 'fixture/hold')
    while (stub.opened.length < 1) await sleep(5)
    const response = httpCall(f.port, f.sign(person('second'), { method: 'POST', path: '/api/fixture' }), '/api/fixture', rpc('fixture'))
    await entered.promise
    const stopped = event === 'connection loss' ? f.connectionFiber.dispose() : f.dispose()
    assert.equal((await m.closed).code, 1011)
    assert.equal(stub.opened[0].signal.aborted, true)
    assert.ok(f.ctx.get('automagikCaller'), 'automagikCaller outlives the held RPC')
    assert.equal(await status(f.port, MUX_PATH, { 'x-automagik-caller': f.sign(person('first')) }), 503)
    assert.equal((await probe(f.port)).status, 503)
    hold.resolve()
    assert.equal(resultOf(await response).value, 'second')
    await stopped
    assert.equal(f.ctx.get('automagikCaller'), undefined)
    // A handler registered on the private path afterwards receives no member connection.
    if (event === 'adapter disposal') {
      const intruder = t.mock.fn()
      const remove = f.webServer.registerUpgrade({ path: MUX_PATH, handler: intruder })
      assert.equal(await status(f.port, MUX_PATH, { 'x-automagik-caller': f.sign(person('first')) }), 503)
      assert.equal(intruder.mock.callCount(), 0)
      remove()
    }
  })
}

// DSH's own Node client (dsh-api-gateway/client) over a socket the test chooses.
async function dshClient(t, open) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const frames = []
  const connection = {
    interactions: 'none', rpc: {},
    openWebSocket(path) {
      const ws = open(path)
      ws.on('message', data => frames.push(JSON.parse(data.toString())))
      return ws
    },
    start: () => ({ stop() {} }),
  }
  ctx.provide('connection', connection)
  ctx.provide('typert', { remotes: { register: () => () => {} } })
  applyRemoteClient(ctx)
  await tick()
  const remote = ctx.get('remote')
  const take = async (endpoint, { cancelAfter } = {}) => {
    const abort = new AbortController()
    const items = []
    try {
      for await (const item of remote.openRemoteStream(endpoint, { args: {} }, abort.signal)) {
        items.push(item)
        if (items.length === cancelAfter) abort.abort()
      }
    } catch (error) { items.push({ failed: error.code ?? error.name }) }
    return items
  }
  return { frames, take }
}

test('parity with DSH\'s mux including cancellation of a held source', { timeout: 5000 }, async t => {
  const f = await host(t, { multiuser: '0' })
  // A test-only policy that grants the fixture stream to members.
  f.access.registerPolicy('automagik', { bindings: () => [{ resource: { kind: 'global' }, role: { actions: ['fixture/ticks', 'fixture/hold'] } }] })
  const ownerPeer = () => f.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })
  t.mock.method(f.connection, 'admitConnection', () => {
    const peer = ownerPeer()
    return { peer, release: () => peer.dispose() }
  })
  const carriers = []
  for (const project of [identity, undefined]) {
    const key = signingKey()
    const registry = createPeerRegistry()
    const mux = createMux({ wireStream: f.gateway.wireStream, scope: createScope(), registry, ready: () => true, project })
    const server = createServer()
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { port } = server.address()
    t.after(async () => { await mux.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
    const nonces = createNonces({ startedAtSec: seconds - 6, monotonicNow: () => seconds * 1000 })
    const handler = createMuxCarrier({ admission: { keys: key.keys, nonces, multiuser: true, keysConfigured: true,
      expectedAuthority: () => `127.0.0.1:${port}`, now: () => seconds * 1000 }, connection: f.connection, registry, ready: () => true, mux })
    server.on('upgrade', handler)
    carriers.push({ port, key })
  }
  const owner = await dshClient(t, path => new WebSocket(`ws://127.0.0.1:${f.port}${path}`))
  const viaCarrier = ({ port, key }) => dshClient(t, () => new WebSocket(`ws://127.0.0.1:${port}${MUX_PATH}`, {
    headers: { 'x-automagik-caller': key.assertion({ method: 'GET', path: MEMBER_PATH }) },
  }))
  const memberClient = await viaCarrier(carriers[0])
  const run = async client => [
    await client.take('remoteAccess/follow', { cancelAfter: 1 }),
    await client.take('fixture/ticks'),
    await client.take('fixture/hold', { cancelAfter: 1 }),
  ]
  const ownerItems = await run(owner)
  const memberItems = await run(memberClient)
  // Principal-dependent: the access snapshot (owner baseline vs member grants).
  assert.deepEqual(ownerItems[0][0], { type: 'baseline', owner: true })
  assert.deepEqual(memberItems[0][0], { type: 'baseline', owner: false, grants: [{ resource: { kind: 'global' }, actions: ['fixture/hold', 'fixture/ticks'] }] })
  assert.deepEqual(memberItems[0].slice(1), ownerItems[0].slice(1))
  assert.deepEqual(memberItems[1], [{ tick: 0 }, { tick: 1 }, { tick: 2 }])
  assert.deepEqual(memberItems[1], ownerItems[1])
  assert.deepEqual(memberItems[2][0], ownerItems[2][0])
  while (f.cancellations.length < 2) await tick()
  assert.deepEqual(f.cancellations, [true, true])
  assert.deepEqual(memberItems[2], ownerItems[2])
  const normal = frames => {
    const ids = [...new Set(frames.map(frame => frame.streamId))]
    const names = ['follow', 'ticks', 'cancelled']
    return frames.map(frame => {
      const name = names[ids.indexOf(frame.streamId)]
      return name === 'follow' && frame.type === 'item'
        ? { type: frame.type, streamId: name } : { ...frame, streamId: name }
    })
  }
  const ownerFrames = normal(owner.frames)
  assert.deepEqual(ownerFrames.filter(frame => frame.streamId === 'cancelled'),
    [{ type: 'item', streamId: 'cancelled', value: { tick: 0 } }])
  assert.deepEqual(normal(memberClient.frames), ownerFrames)
  // Without a caller projection the member's fixture stream ends with no item.
  const unprojected = await viaCarrier(carriers[1])
  assert.deepEqual(await unprojected.take('fixture/ticks'), [])
})
