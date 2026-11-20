import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import fs, { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import files from 'node:fs/promises'
import http from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PassThrough, Readable } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import WebSocket from 'ws'
import { Service } from '@deepseek-ai/cordis'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import { ClientModuleRegistry } from '@deepseek-ai/dsh-client-modules'
import { RemoteAccessService } from '@deepseek-ai/dsh-api-remote-access'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import * as webApp from '@deepseek-ai/dsh-web-app'
import { createSigner } from '../../../server/gate-caller.mjs'
import { createGate } from '../../../server/gate.mjs'
import { COOKIE, SessionStore } from '../../../server/gate-store.mjs'
import { appOf, install as installAppManifest, manifestOf } from '../../bots-dsh/src/host/app-manifest.js'
import { callerOf } from '../../bots-dsh/src/host/multiuser.js'
import * as adapter from '../index.js'
import { READY_PATH } from '../src/carrier.js'
import { MUX_PATH } from '../src/mux-carrier.js'
import { invoke, localHTTP, prefix, provideConnection, rpc, runtime, send, webRuntime, wire } from './runtime.mjs'

const origin = 'https://workspace.invalid'
const instance = wire.payload.aud
const webConfig = { openBrowser: false, printUrl: false, surfaceContext: false }

function clientRegistry(ctx, dir, names, configurePackage) {
  const entries = names.map((name, index) => {
    const path = join(dir, 'node_modules', name)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'client.js'), `globalThis.fixtureBundle${index} = true;\n`)
    writeFileSync(join(path, 'client.lazy.js'), `globalThis.fixtureBundle${index} = true;\n`)
    writeFileSync(join(path, 'index.js'), 'export {}')
    const pkg = {
      name, type: 'module',
      exports: { '.': './index.js', './client': './client.js', './package.json': './package.json' },
      dsh: { client: { platform: 'web' } },
    }
    configurePackage?.(path, pkg)
    writeFileSync(join(path, 'package.json'), JSON.stringify(pkg))
    return { options: { name }, fiber: {}, parent: { tree: { ctx: { baseUrl: pathToFileURL(join(dir, 'profile.json')).href } } } }
  })
  ctx.provide('loader', { entries: () => entries })
  return new ClientModuleRegistry(ctx)
}

const fixtureDispatch = new WeakMap()

function fixtureGateway(ctx, { publicMux = false } = {}) {
  if (!ctx.get('typert')) new TypertRegistry(ctx)
  // Keep the in-process fixture's public upgrade table empty. Its RPC connection and
  // remoteAccess service are shared with the adapter.
  const gateway = new TypertGatewayService(publicMux ? ctx : ctx.isolate('webServer'), TypertGatewayService.Config({}))
  const claims = gateway.claimsEndpoint.bind(gateway)
  const dispatch = gateway.dispatchRpc.bind(gateway)
  gateway.claimsEndpoint = endpoint => endpoint === 'fixture' || claims(endpoint)
  gateway.dispatchRpc = (endpoint, payload, signal, peer) => {
    const observe = fixtureDispatch.get(gateway)
    if (endpoint !== 'fixture' || !observe) return dispatch(endpoint, payload, signal, peer)
    // This test-only RPC observes the caller, like the access snapshot. Business RPCs
    // still use the gateway's normal authorization and dispatch.
    const decision = gateway.ctx.remoteAccess.decide({ principal: peer.principal, action: 'remoteAccess/follow', resources: [] })
    assert.equal(decision.kind, 'allow')
    return observe(endpoint, payload, signal, peer)
  }
  return gateway
}

function observeRpc(ctx, handler) {
  const service = ctx.get('typertGateway')
  const gateway = service[Symbol.for('cordis.original')]
  fixtureDispatch.set(gateway, handler)
  return () => fixtureDispatch.delete(gateway)
}

function callerRuntime(t, { services = runtime(t), now, publicMux = false } = {}) {
  // The adapter registers its automagik policy before it admits any caller.
  new RemoteAccessService(services.ctx)
  const gateway = fixtureGateway(services.ctx, { publicMux })
  const dir = mkdtempSync(join(tmpdir(), 'caller-interop-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const signer = createSigner({ dir, publicDir: dir, instance: () => instance, now })
  signer.publish()
  const read = fs.readFileSync
  const mount = t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === '/proc/self/mountinfo') return `2 1 0:2 / ${dir} ro - tmpfs tmpfs rw`
    if (typeof file === 'string' && file.startsWith('/proc/self/fdinfo/')) return 'mnt_id:\t2\n'
    return read(file, ...args)
  })
  syncBuiltinESMExports()
  t.after(() => { mount.mock.restore(); syncBuiltinESMExports() })
  return { ...services, dir, signer, gateway, async activate(ctx = services.ctx) {
    const env = { AUTOMAGIK_MULTIUSER: '1', AUTOMAGIK_CALLER_KEYS: join(dir, 'caller-keys.json'), AUTOMAGIK_INSTANCE_ID: instance, DSH_HOME: dir }
    const old = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]))
    Object.assign(process.env, env)
    const elapsed = Date.now() - 10_000
    const clock = t.mock.method(Date, 'now', () => elapsed)
    try {
      const activation = ctx.plugin(adapter)
      await activation
      return () => activation.dispose()
    } finally {
      clock.mock.restore()
      for (const [name, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  } }
}

async function setup(t, { names = ['fixture-a', 'fixture-b'], fixtureDist = true, configurePackage } = {}) {
  const { ctx, webServer, connection, dir, signer, activate } = callerRuntime(t)
  const dispatched = []
  const createFetchHandler = connection.createSharedFetchHandler
  t.mock.method(connection, 'createSharedFetchHandler', function (channel) {
    const handler = createFetchHandler.call(this, channel)
    return { ...handler, fetch(request, peer) {
      dispatched.push(request.url)
      return handler.fetch(request, peer)
    } }
  })
  await activate()
  assert.equal(ctx.get('automagikCaller').version, 2)
  const route = webServer.match(prefix + '/api/fixture')
  assert.equal(route?.path, prefix)
  assert.equal(typeof route.handler, 'function')
  assert.equal(webServer.upgrades.size, 0)
  // The private mux path dispatches to the adapter's mux carrier, which reads the raw target.
  const muxRoute = webServer.upgrades.get(MUX_PATH)
  const refused = []
  const socket = Object.assign(new EventEmitter(), { destroy() { this.emit('close') }, end(bytes, flushed) { refused.push(bytes); flushed() } })
  muxRoute.handler({ url: MUX_PATH + '?', method: 'GET', headers: {}, rawHeaders: [] }, socket, Buffer.alloc(0))
  assert.match(refused[0], /^HTTP\/1\.1 400 Bad Request\r\n/)

  const dist = join(dir, 'dist')
  const index = join(dist, 'index.html')
  mkdirSync(join(dist, 'assets'), { recursive: true })
  writeFileSync(index, '<html><head><title>Fixture</title></head><body>Shell</body></html>')
  writeFileSync(join(dist, 'assets', 'x.js'), 'export const shell = true;')
  const indexCallers = []
  ctx.on('webserver/index-inject', (_table, peer) => indexCallers.push(peer.principal))
  if (fixtureDist) {
    const root = dirname(webApp.internals.resolveDistIndex())
    const readFile = files.readFile
    t.mock.method(files, 'readFile', (file, ...args) => {
      const path = typeof file === 'string' && file.startsWith(root + '/') ? join(dist, relative(root, file)) : file
      return readFile(path, ...args)
    })
  }
  const registry = clientRegistry(ctx, dir, names, configurePackage)
  const fetchBundle = registry.fetchBundle.bind(registry)
  t.mock.method(registry, 'fetchBundle', request => {
    dispatched.push(request.url)
    return fetchBundle(request)
  })
  const icon = join(dir, 'fixture.svg')
  const iconBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><title>Fixture</title></svg>')
  writeFileSync(icon, iconBytes)
  const config = { appManifest: { name: 'Fixture', short_name: 'Fixture', icon } }
  const app = appOf(config)
  await ctx.plugin({ name: 'fixture-bots-app', apply: ctx => installAppManifest({ ctx, config }) })
  let unrelated = 0
  for (const path of ['/private-resource', '/assets/x.js', '/assets/plugin-only.json', '/omni-ui/app-icon.png']) {
    webServer.register({ kind: 'exact', path, resource() { unrelated++; return new Response('private') } })
  }
  return { ctx, webServer, connection, route, signer, dir, dist, registry, app, iconBytes, indexCallers, dispatched,
    unrelated: () => unrelated }
}

function person(subject, role = 'member') {
  return { ...wire.payload.principal, roles: [role], subject }
}

function observe(f) {
  const both = Promise.withResolvers()
  let overlapped = 0
  return observeRpc(f.ctx, async (_method, _body, _signal, peer) => {
    if (++overlapped === 2) both.resolve()
    await both.promise
    await setImmediate()
    const caller = callerOf(f.ctx)
    assert.equal(caller, peer.principal)
    return { ok: true, value: caller.person.subject }
  })
}

function businessGateway({ ctx, connection }) {
  const typert = ctx.get('typert')
  let calls = 0
  class Session extends TypertRemoteService {
    prompt() { calls++; return 'prompted' }
  }
  new Session(ctx, 'session')
  typert.register({ package: 'fixture-session', face: 'host', model: {}, schemas: [], invocations: [{
    id: 'fixture-session/prompt', service: 'session', namespace: 'session', method: 'prompt',
    invocation: { kind: 'direct' }, parameters: [], result: { mode: 'src-json' },
  }] })
  const gateway = ctx.get('typertGateway')[Symbol.for('cordis.original')]
  assert.equal(gateway.claimsEndpoint('session/prompt'), true)
  return {
    calls: () => calls,
    async follow(person) {
      const peer = connection.createPeer({ principal: { kind: 'automagik', instance, person }, interactions: 'none' })
      try {
        const stream = await gateway.stream({ namespace: 'remoteAccess', method: 'follow', args: {}, peer })
        const iterator = stream[Symbol.asyncIterator]()
        try { return (await iterator.next()).value }
        finally { await iterator.return() }
      } finally { await peer.dispose() }
    },
    async ownerPrompt() {
      const peer = connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })
      try { return await gateway.invoke({ namespace: 'session', method: 'prompt', args: {}, peer }) }
      finally { await peer.dispose() }
    },
  }
}

function result(reply) {
  assert.equal(reply.status, 200, reply.bytes.toString())
  return JSON.parse(reply.bytes).result
}

async function frontendAssertions(f, browser) {
  for (const path of ['/', '/index.html', '/assets/x.js', '/manifest.webmanifest', f.app.icon.path]) {
    const get = await browser(path)
    const head = await browser(path, 'HEAD')
    assert.equal(get.status, 200, path)
    assert.equal(head.status, get.status, path)
    assert.equal(head.headers['content-type'], get.headers['content-type'], path)
    assert.equal(head.bytes.length, 0, path)
    if (path === '/assets/x.js') {
      assert.equal(get.headers['content-type'], 'text/javascript; charset=utf-8')
      assert.equal(get.bytes.toString(), 'export const shell = true;')
    } else if (path === '/manifest.webmanifest') {
      assert.equal(get.headers['content-type'], 'application/manifest+json')
      assert.deepEqual(JSON.parse(get.bytes), manifestOf(f.app))
    } else if (path === f.app.icon.path) {
      assert.deepEqual(get.bytes, f.iconBytes)
      assert.equal(get.headers['content-type'], 'image/svg+xml')
      for (const reply of [get, head]) {
        assert.equal(reply.headers['x-content-type-options'], 'nosniff')
        assert.equal(reply.headers['content-security-policy'], "default-src 'none'")
      }
    } else {
      assert.equal(get.headers['content-type'], 'text/html; charset=utf-8')
      assert.match(get.bytes.toString(), /Shell<\/body>/)
    }
  }
  assert.ok(f.indexCallers.length > 0)
  assert.ok(f.indexCallers.every(row => row.kind === 'automagik' && row.person.subject === 'first'))
  const [entry] = f.registry.graph().entries
  const [batch] = f.registry.graph().batches
  assert.deepEqual(batch.entries, ['fixture-a', 'fixture-b'])
  const chunk = `/plugins/${entry.id}/client.lazy.js?rev=${entry.rev}`
  for (const path of ['/' + entry.url, '/' + batch.url, chunk]) {
    const get = await browser(path)
    const head = await browser(path, 'HEAD')
    assert.equal(get.status, 200, path)
    assert.equal(head.status, 200, path)
    assert.equal(get.headers['content-type'], 'text/javascript; charset=utf-8')
    assert.equal(head.headers['content-type'], get.headers['content-type'])
    assert.match(get.bytes.toString(), /globalThis\.fixtureBundle0 = true/)
    if (path === '/' + batch.url) assert.match(get.bytes.toString(), /globalThis\.fixtureBundle1 = true/)
    assert.equal(head.bytes.length, 0)
  }
  for (const path of [
    `/plugins/${entry.id}/client.js`,
    `/plugins/${entry.id}/client.js?rev=${entry.rev}`,
    '/' + batch.url.replace('fixture-b', 'unregistered'),
    '/' + batch.url.replace('fixture-a/client.js', 'fixture-a/client.js.map'),
    '/private-resource',
    '/assets/plugin-only.json',
    '/omni-ui/app-icon.png',
  ]) assert.equal((await browser(path)).status, 404, path)
  assert.equal(f.unrelated(), 0)
}

function inProcessGate(t, f, cookie = () => assert.fail('owner credential requested')) {
  const sessions = new SessionStore(f.dir, { memory: true, accepts: () => true })
  const port = 54321
  f.webServer.listenedPort = port
  // The gate's probe is answered in-process by the same web server, before signing.
  // A refused probe prevents any forwarded request, as on loopback.
  const probes = []
  const connectDsh = async () => {
    const responder = f.webServer.responderFor(READY_PATH)
    const reply = await invoke((req, res) => {
      if (!responder) { res.writeHead(404); return res.end() }
      return responder.handler(req, res)
    }, { url: READY_PATH, method: 'GET', headers: { host: `127.0.0.1:${port}` }, waitForEnd: true })
    const ready = reply.headers?.['x-automagik-ready']
    probes.push({ status: reply.status, ready })
    if (reply.status !== 204 || ready !== '1' || reply.bytes.length) throw new Error('unready')
    return new PassThrough()
  }
  const gate = createGate({ origin, sessions, multiuser: true, caller: f.signer, connectDsh, credentials: {
    port, authority: `127.0.0.1:${port}`, cookie,
  } })
  t.after(() => gate.closeGate())
  const upstream = t.mock.method(http, 'request', (options, respond) => {
    const proxy = new PassThrough()
    const chunks = []
    proxy.on('data', chunk => chunks.push(chunk))
    proxy.on('end', async () => {
      try {
        const target = new URL(options.path, 'http://x')
        const responder = f.webServer.responderFor(target.pathname)
        const reply = await invoke((req, res) => {
          if (!responder) { res.writeHead(404); return res.end() }
          if (typeof responder === 'function') return responder(req, res)
          if ('resource' in responder) return f.webServer.serveResource(req, res, target, responder.resource)
          return responder.handler(req, res)
        }, {
          url: options.path, method: options.method, headers: options.headers, chunks, waitForEnd: true,
        })
        const response = Readable.from(reply.bytes.length ? [reply.bytes] : [])
        Object.assign(response, { statusCode: reply.status, headers: reply.headers ?? {} })
        respond(response)
      } catch (error) { proxy.destroy(error) }
    })
    return proxy
  })
  const request = (path, method, principal, body, headers = {}) => {
    const issued = principal && sessions.issue(origin, principal)
    return invoke(gate.listeners('request')[0], { method, url: path, body, waitForEnd: true, headers: {
      host: new URL(origin).host, origin, cookie: issued && `${COOKIE}=${issued.secret}`, 'content-type': 'application/json',
      'content-length': body ? String(Buffer.byteLength(body)) : undefined, ...headers,
    } })
  }
  return { request, upstream, probes }
}

for (const kind of ['exact', 'prefix', 'upgrade', 'mux upgrade']) {
  test(`a preexisting ${kind} route in /_automagik blocks adapter startup and receives no member requests`, async t => {
    const f = callerRuntime(t)
    const { webServer } = f
    const responderFor = webServer.responderFor
    const path = kind === 'mux upgrade' ? MUX_PATH : prefix + (kind === 'prefix' ? '/api' : '/api/fixture')
    const handler = t.mock.fn((_req, res) => { res.writeHead(200); res.end('intruder') })
    if (kind.endsWith('upgrade')) webServer.registerUpgrade({ path, handler })
    else webServer.register({ kind, path, handler })
    const log = t.mock.method(console, 'error', () => {})
    const dispose = await f.activate()
    assert.equal(f.ctx.get('automagikCaller'), undefined)
    assert.equal(webServer.prefixes.has(prefix), false)
    assert.equal(log.mock.callCount(), 1)
    assert.match(log.mock.calls[0].arguments[0], /startup refused.*\/_automagik/)
    const sign = t.mock.method(f.signer, 'sign')
    const { request, upstream } = inProcessGate(t, f)
    assert.equal((await request('/api/fixture', 'POST', person('first'), rpc())).status, 503)
    assert.equal(sign.mock.callCount(), 0)
    assert.equal(upstream.mock.callCount(), 0)
    const target = prefix + '/api/fixture'
    const reply = await invoke(webServer.responderFor(target).handler, {
      url: target, method: 'POST', body: rpc(), headers: { host: '127.0.0.1:54321' },
    })
    assert.equal(reply.status, 404)
    if (kind.endsWith('upgrade')) {
      // The handshake on the held path is refused by the reservation, never handed over.
      const refused = []
      const socket = Object.assign(new EventEmitter(), { destroy() { this.emit('close') }, end(bytes, flushed) { refused.push(bytes); flushed() } })
      webServer.upgrades.get(path).handler({ url: path, method: 'GET', headers: {} }, socket, Buffer.alloc(0))
      assert.match(refused[0], /^HTTP\/1\.1 503 /)
    }
    assert.equal(handler.mock.callCount(), 0)
    await dispose()
    assert.equal(webServer.responderFor, responderFor)
  })
}

test('the adapter reserves /_automagik for its lifetime and later intruders receive no member requests', async t => {
  const f = callerRuntime(t)
  const { webServer } = f
  const { register, registerUpgrade } = webServer
  const dispose = await f.activate()
  const handler = t.mock.fn()
  for (const path of ['/_automagik', prefix + '/api/fixture']) {
    for (const kind of ['exact', 'prefix']) {
      assert.throws(() => webServer.register({ kind, path, handler }), /\/_automagik routes are reserved/)
    }
    assert.throws(() => webServer.registerUpgrade({ path, handler }), /\/_automagik routes are reserved/)
  }
  const sibling = { kind: 'exact', path: '/_automagik-other', handler }
  const removeSibling = webServer.register(sibling)
  assert.equal(webServer.match(sibling.path), sibling)
  removeSibling()
  observeFixture(f.ctx)
  const { request } = inProcessGate(t, f)
  assert.equal(result(await request('/api/fixture', 'POST', person('first'), rpc())).value, 'first')
  assert.equal(handler.mock.callCount(), 0)
  await dispose()
  assert.equal(webServer.register, register)
  assert.equal(webServer.registerUpgrade, registerUpgrade)
  assert.equal(webServer.prefixes.has(prefix), false)
  webServer.register({ kind: 'exact', path: '/_automagik', handler })()
  webServer.registerUpgrade({ path: '/_automagik', handler })()
})

test('the real plugin route composes DSH services behind the gate over an in-process transport', async t => {
  const f = await setup(t)
  const stopObserving = observe(f)
  const { request, upstream } = inProcessGate(t, f)
  const calls = await Promise.all(['first', 'second'].map(subject =>
    request('/api/fixture', 'POST', person(subject), rpc())))
  assert.deepEqual(calls.map(reply => result(reply).value), ['first', 'second'])
  assert.equal(callerOf(f.ctx), undefined)
  await stopObserving()
  const business = businessGateway(f)
  for (const role of ['member', 'guest']) {
    const principal = person(role, role)
    const denied = result(await request('/api/session/prompt', 'POST', principal, rpc('session/prompt', { args: {} })))
    assert.equal(denied.ok, false)
    assert.equal(denied.error.code, 'remote-access/denied')
    assert.equal(business.calls(), 0)
    assert.deepEqual(await business.follow(principal), { type: 'baseline', owner: false, grants: [] })
  }
  assert.equal(await business.ownerPrompt(), 'prompted')
  assert.equal(business.calls(), 1)
  for (const [raw, expected] of wire.canonicalTargets) {
    const count = f.dispatched.length
    assert.equal((await request(raw, 'GET', person('first'))).status, 404, raw)
    const { path, headers } = upstream.mock.calls.at(-1).arguments[0]
    assert.equal(path, prefix + expected, raw)
    const payload = JSON.parse(Buffer.from(headers['x-automagik-caller'].split('.')[1], 'base64url'))
    assert.equal(payload.path, expected, raw)
    assert.deepEqual(f.dispatched.slice(count), ['http://dsh.internal' + expected], raw)
  }
  await frontendAssertions(f, (path, method = 'GET') => request(path, method, person('first')))
  assert.ok(upstream.mock.calls.every(({ arguments: [options] }) =>
    options.path.startsWith(prefix + '/') && options.headers['x-automagik-caller'] && !options.headers.cookie))
  assert.ok(Number(readFileSync(join(f.dir, 'multiuser-dsh', 'caller-watermark'), 'utf8')) > 0)
})

test('a replacement fallback gets no member index or asset requests when the static frontend is unavailable', async t => {
  const f = await setup(t)
  const stock = f.ctx.plugin(webApp, webConfig)
  await stock
  const { request } = inProcessGate(t, f)
  assert.equal((await request('/', 'GET', person('first'))).status, 200)
  await stock.dispose()
  rmSync(f.dist, { recursive: true })
  let calls = 0
  await f.ctx.plugin({ name: 'replacement-fallback', apply(ctx) {
    ctx.effect(() => ctx.webServer.registerFallback({ resource() { calls++; return new Response('private') } }))
  } })
  for (const path of ['/', '/index.html', '/assets/x.js']) {
    assert.equal((await request(path, 'GET', person('first'))).status, 404, path)
  }
  assert.equal(calls, 0)
})

test('the real Web App keeps the owner fallback while the carrier serves the same dist privately', async t => {
  const f = callerRuntime(t)
  await f.ctx.plugin(webApp, webConfig)
  const fallback = f.webServer.fallback
  assert.equal(typeof fallback.resource, 'function')
  const stock = t.mock.method(fallback, 'resource')
  const cookie = 'fixture-owner=credential'
  f.connection.browserAuth.authorizeIndex = request => request.headers.get('cookie') === cookie
  const { request, upstream } = inProcessGate(t, f, () => cookie)
  const owner = person('owner', 'owner')
  const control = await request('/', 'GET', owner)
  assert.equal(control.status, 200)
  assert.match(control.bytes.toString(), /<link rel="manifest" href="\.\/manifest\.webmanifest" \/>/)
  assert.equal(stock.mock.callCount(), 1)

  await f.activate()
  assert.equal(f.webServer.fallback, fallback)
  const after = await request('/', 'GET', owner)
  assert.equal(after.status, control.status)
  assert.deepEqual(after.headers, control.headers)
  assert.deepEqual(after.bytes, control.bytes)
  assert.equal(stock.mock.callCount(), 2)
  stock.mock.resetCalls()

  const dist = dirname(webApp.internals.resolveDistIndex())
  const asset = readdirSync(join(dist, 'assets')).find(name => name.endsWith('.js'))
  assert.ok(asset, 'the pinned Web App dist contains a JavaScript asset')
  const member = person('first')
  for (const path of ['/', '/index.html']) {
    const response = await request(path, 'GET', member)
    assert.equal(response.status, 200)
    assert.equal(response.headers['content-type'], 'text/html; charset=utf-8')
    assert.match(response.bytes.toString(), /<base href="\.\/">/)
    assert.match(response.bytes.toString(), /<link rel="manifest" href="\.\/manifest\.webmanifest" crossorigin="use-credentials" \/>/)
    assert.equal(upstream.mock.calls.at(-1).arguments[0].path, prefix + path)
  }
  const path = '/assets/' + asset
  const response = await request(path, 'GET', member)
  assert.equal(response.status, 200)
  assert.equal(response.headers['content-type'], 'text/javascript; charset=utf-8')
  assert.equal(response.headers['cache-control'], 'no-cache')
  assert.match(response.headers.etag, /^W\//)
  assert.deepEqual(response.bytes, readFileSync(join(dist, path)))
  assert.equal(upstream.mock.calls.at(-1).arguments[0].path, prefix + path)
  assert.equal(stock.mock.callCount(), 0)
})

test('member rendering adds credentials to only the manifest link in the pinned rc.2 index', async t => {
  const distIndex = webApp.internals.resolveDistIndex()
  const f = await setup(t, { fixtureDist: false })
  const { request } = inProcessGate(t, f)
  const rawIndex = readFileSync(distIndex, 'utf8')
  const tag = '<link rel="manifest" href="./manifest.webmanifest" />'
  const expected = '<link rel="manifest" href="./manifest.webmanifest" crossorigin="use-credentials" />'
  assert.ok(rawIndex.includes(tag))
  const peer = f.connection.createPeer({ principal: { kind: 'automagik', instance, person: person('first') }, interactions: 'none' })
  try {
    const rendered = f.webServer.renderIndex(rawIndex, peer).replace('<head>', '<head><base href="./">')
    assert.ok(rendered.includes(tag))
    for (const path of ['/', '/index.html']) {
      const reply = await request(path, 'GET', person('first'))
      assert.equal(reply.status, 200)
      assert.equal(reply.bytes.toString(), rendered.replace(tag, expected))
    }
  } finally { await peer.dispose() }
  assert.equal((await request('/manifest.webmanifest', 'GET')).status, 401)
  assert.equal((await request('/manifest.webmanifest', 'GET', person('first'))).status, 200)
})

test('a package id containing .map remains in the executable startup combo and its source-map URLs are refused', async t => {
  const f = await setup(t, { names: ['a.map-extra', 'fixture-b'] })
  const { request, upstream } = inProcessGate(t, f)
  const [batch] = f.registry.graph().batches
  assert.deepEqual(batch.entries, ['a.map-extra', 'fixture-b'])
  const reply = await request('/' + batch.url, 'GET', person('first'))
  assert.equal(reply.status, 200)
  assert.match(reply.bytes.toString(), /globalThis\.fixtureBundle0 = true/)
  assert.match(reply.bytes.toString(), /globalThis\.fixtureBundle1 = true/)
  const [entry] = f.registry.graph().entries
  for (const path of ['/' + batch.url.replace('a.map-extra/client.js', 'a.map-extra/client.js.map'),
    `/plugins/a.map-extra/client.js.map?rev=${entry.rev}`]) {
    assert.equal((await request(path, 'GET', person('first'))).status, 404, path)
  }
  assert.equal(upstream.mock.callCount(), 1)
})

test('a full-size combo advertised by rc.2 passes through the gate and verified carrier', async t => {
  const names = Array.from({ length: 42 }, (_, i) => `@fixture/client-${i}-${'startup-'.repeat(4)}bundle`)
  const f = await setup(t, { names })
  const { request, upstream } = inProcessGate(t, f)
  const [batch] = f.registry.graph().batches
  assert.deepEqual(batch.entries, names)
  const path = '/' + batch.url
  assert.ok(Buffer.byteLength(path) >= 2100)
  const reply = await request(path, 'GET', person('first'))
  assert.equal(reply.status, 200)
  assert.match(reply.bytes.toString(), /globalThis\.fixtureBundle0 = true/)
  assert.match(reply.bytes.toString(), /globalThis\.fixtureBundle41 = true/)
  assert.equal(upstream.mock.calls.at(-1).arguments[0].path, prefix + path)
  assert.equal(f.dispatched.at(-1), 'http://dsh.internal' + path)
})

test('gate interop through the installed private route preserves attribution, policy and frontend response headers', async t => {
  const f = await setup(t)
  const stopObserving = observe(f)
  const captured = []
  const upstream = await localHTTP(t, (req, res) => {
    // The gate's readiness probe is answered here too; captured hops exclude it.
    if (req.url !== READY_PATH) captured.push({ path: req.url, method: req.method, headers: req.headers })
    f.webServer.match(new URL(req.url, 'http://x').pathname)?.handler(req, res)
  })
  const carried = []
  upstream.server.on('upgrade', (req, socket, head) => {
    carried.push({ path: req.url, headers: req.headers })
    f.webServer.upgrades.get(new URL(req.url, 'http://x').pathname)?.handler(req, socket, head)
  })
  f.webServer.listenedPort = upstream.port
  const sessions = new SessionStore(f.dir, { memory: true, accepts: () => true })
  const gate = createGate({ origin, sessions, multiuser: true, caller: f.signer, credentials: {
    port: upstream.port, authority: upstream.authority, cookie: () => assert.fail('owner credential requested'),
  } })
  gate.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => { gate.once('listening', resolve); gate.once('error', reject) })
  t.after(() => gate.closeGate())
  const { port } = gate.address()
  const issue = (subject, role) => {
    const { secret } = sessions.issue(origin, person(subject, role))
    return { host: new URL(origin).host, origin, cookie: `${COOKIE}=${secret}` }
  }
  const first = issue('first', 'member')
  const second = issue('second', 'member')
  const guest = issue('guest', 'guest')
  const call = (endpoint, headers, payload) => send(port, '/api/' + endpoint, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: rpc(endpoint, payload),
  })
  const replies = await Promise.all([call('fixture', first), call('fixture', second)])
  assert.deepEqual(replies.map(reply => result(reply).value), ['first', 'second'])
  await stopObserving()
  const business = businessGateway(f)
  for (const [headers, principal] of [[first, person('first')], [guest, person('guest', 'guest')]]) {
    assert.equal(result(await call('session/prompt', headers, { args: {} })).error.code, 'remote-access/denied')
    assert.equal(business.calls(), 0)
    assert.equal((await business.follow(principal)).owner, false)
    // Delivery 5b carries a member's /api/remote.mux to the adapter; this handshake has no
    // WebSocket key, so the adapter's WebSocket server refuses it and the gate passes the 400.
    const upgrade = await send(port, '/api/remote.mux', {
      upgrade: true, headers: { ...headers, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13' },
    })
    assert.equal(upgrade.status, 400)
    const hop = carried.at(-1)
    assert.equal(hop.path, prefix + '/api/remote.mux')
    assert.ok(hop.headers['x-automagik-caller'])
    assert.equal(hop.headers.cookie, undefined)
  }
  const firstHop = captured[0]
  assert.ok(firstHop.headers['x-automagik-caller'])
  assert.equal(firstHop.headers.cookie, undefined)
  assert.equal(firstHop.headers.authorization, undefined)
  const replay = await send(upstream.port, firstHop.path, { method: firstHop.method, headers: firstHop.headers, body: rpc() })
  assert.equal(replay.status, 401)
  await frontendAssertions(f, (path, method = 'GET') => send(port, path, { method, headers: first }))
})

const fixturePath = '/api/fixture'

function observeFixture(ctx) {
  assert.ok(observeRpc(ctx, (_method, _body, _signal, peer) => ({ ok: true, value: peer.principal.person.subject })))
}

function countFallback(t, webServer) {
  const resource = t.mock.fn(() => new Response('public fallback'))
  webServer.registerFallback({ resource })
  return resource
}

test('the reserved carrier refuses before the connection arrives and after it leaves', async t => {
  const f = callerRuntime(t, { services: webRuntime(t) })
  const fallback = countFallback(t, f.webServer)
  await f.activate()

  const path = prefix + '/api/x'
  const responder = f.webServer.responderFor(path)
  const refused = await invoke(responder.handler, { url: path, method: 'GET', headers: {} })
  assert.equal(refused.status, 503)
  assert.equal(refused.headers['content-length'], '0')
  assert.equal(refused.bytes.length, 0)
  assert.equal((await f.webServer.readResource(new Request('http://x' + prefix + '/x'))).status, 404)

  const connection = provideConnection(f.ctx)
  await connection
  observeFixture(f.ctx)
  const { request } = inProcessGate(t, f)
  const member = () => request(fixturePath, 'POST', person('first'), rpc())
  assert.equal(result(await member()).value, 'first')
  await connection.dispose()
  assert.equal((await member()).status, 503)
  assert.equal(fallback.mock.callCount(), 0)
})

test('a replacement connection inherits an unpersisted rollback cutoff', async t => {
  const start = Math.floor(Date.now() / 1000)
  let wall = start * 1000
  let mono = 0
  t.mock.method(Date, 'now', () => wall)
  t.mock.method(performance, 'now', () => mono)
  const f = callerRuntime(t, { services: webRuntime(t), now: () => wall })
  await f.activate()
  const first = provideConnection(f.ctx)
  await first
  observeFixture(f.ctx)
  const { request } = inProcessGate(t, f)
  const principal = person('first')
  const member = () => request(fixturePath, 'POST', principal, rpc())
  assert.equal((await member()).status, 200)

  wall += 6000
  const assertion = f.signer.sign({ principal, familyId: 'fixture', method: 'POST', path: fixturePath })
  const path = prefix + fixturePath
  const sendUnused = () => invoke(f.webServer.match(path).handler, {
    url: path, method: 'POST', body: rpc(),
    headers: { host: '127.0.0.1:54321', 'content-type': 'application/json', 'x-automagik-caller': assertion },
  })
  const file = join(f.dir, 'multiuser-dsh', 'caller-watermark')
  let blocked = true
  const rename = fs.renameSync
  const renameMock = t.mock.method(fs, 'renameSync', (from, to) => {
    if (blocked && to === file) throw Object.assign(new Error('blocked watermark rename'), { code: 'EACCES' })
    return rename(from, to)
  })
  syncBuiltinESMExports()
  t.after(() => { renameMock.mock.restore(); syncBuiltinESMExports() })
  wall -= 106_000
  mono += 40_000
  assert.equal((await sendUnused()).status, 503)
  assert.equal(Number(readFileSync(file, 'utf8')), start)
  await first.dispose()
  wall = start * 1000
  await provideConnection(f.ctx)
  assert.equal(f.ctx.get('automagikCaller').version, 2)
  observeFixture(f.ctx)
  const atWatermark = (await member()).status
  wall += 6000
  mono += 6000
  const whileBlocked = (await sendUnused()).status
  blocked = false
  const afterRepair = (await sendUnused()).status
  assert.deepEqual({ atWatermark, whileBlocked, afterRepair }, { atWatermark: 503, whileBlocked: 503, afterRepair: 401 })
  assert.equal(Number(readFileSync(file, 'utf8')), start + 40)
  wall += 40_000
  mono += 40_000
  assert.equal(result(await member()).value, 'first')
})

test('a delayed claim projects from its claim time before the first request', async t => {
  let wall = Date.now()
  let mono = 0
  t.mock.method(Date, 'now', () => wall)
  t.mock.method(performance, 'now', () => mono)
  const f = callerRuntime(t, { services: webRuntime(t), now: () => wall })
  await f.activate()
  assert.equal(f.ctx.get('automagikCaller'), undefined)
  wall += 100_000
  mono += 100_000
  const claimedAt = Math.floor(wall / 1000)
  await provideConnection(f.ctx)
  assert.equal(f.ctx.get('automagikCaller').version, 2)
  observeFixture(f.ctx)
  inProcessGate(t, f)
  const principal = person('first')
  const assertion = f.signer.sign({ principal, familyId: 'fixture', method: 'POST', path: fixturePath })

  // Forty seconds elapse before the wall clock steps back to the issue second.
  mono += 40_000
  const path = prefix + fixturePath
  const reply = await invoke(f.webServer.match(path).handler, {
    url: path, method: 'POST', body: rpc(),
    headers: { host: '127.0.0.1:54321', 'content-type': 'application/json', 'x-automagik-caller': assertion },
  })
  assert.equal(reply.status, 401)
  assert.equal(Number(readFileSync(join(f.dir, 'multiuser-dsh', 'caller-watermark'), 'utf8')), claimedAt + 40)
})

test('a replacement connection refuses an unused assertion on its first request after an unobserved rollback', async t => {
  let wall = 100_000
  let mono = 0
  t.mock.method(Date, 'now', () => wall)
  t.mock.method(performance, 'now', () => mono)
  const f = callerRuntime(t, { services: webRuntime(t), now: () => wall })
  await f.activate()
  const first = provideConnection(f.ctx)
  await first
  observeFixture(f.ctx)
  f.webServer.listenedPort = 54321
  const method = 'POST'
  const path = prefix + fixturePath
  const sign = () => f.signer.sign({ principal: person('first'), familyId: 'fixture', method, path: fixturePath })
  const send = assertion => invoke(f.webServer.match(path).handler, {
    url: path, method, body: rpc(),
    headers: { host: '127.0.0.1:54321', 'content-type': 'application/json', 'x-automagik-caller': assertion },
  })
  const file = join(f.dir, 'multiuser-dsh', 'caller-watermark')
  assert.equal(result(await send(sign())).value, 'first')
  assert.equal(Number(readFileSync(file, 'utf8')), 100)

  wall = 110_000
  mono += 10_000
  const unused = sign()
  // After another 40 seconds the wall steps back to the issue second, before any further request.
  mono += 40_000
  await first.dispose()
  await provideConnection(f.ctx)
  observeFixture(f.ctx)
  assert.equal((await send(unused)).status, 401)
  assert.equal(Number(readFileSync(file, 'utf8')), 150)
})

test('a replacement connection anchors at a forward correction before the first request', async t => {
  let wall = 100_000
  let mono = 0
  t.mock.method(Date, 'now', () => wall)
  t.mock.method(performance, 'now', () => mono)
  const f = callerRuntime(t, { services: webRuntime(t), now: () => wall })
  await f.activate()
  const first = provideConnection(f.ctx)
  await first
  observeFixture(f.ctx)
  f.webServer.listenedPort = 54321
  const method = 'POST'
  const path = prefix + fixturePath
  const sign = () => f.signer.sign({ principal: person('first'), familyId: 'fixture', method, path: fixturePath })
  const send = assertion => invoke(f.webServer.match(path).handler, {
    url: path, method, body: rpc(),
    headers: { host: '127.0.0.1:54321', 'content-type': 'application/json', 'x-automagik-caller': assertion },
  })
  const file = join(f.dir, 'multiuser-dsh', 'caller-watermark')
  assert.equal(result(await send(sign())).value, 'first')
  assert.equal(Number(readFileSync(file, 'utf8')), 100)

  wall = 200_000
  mono += 1000
  await first.dispose()
  await provideConnection(f.ctx)
  observeFixture(f.ctx)
  const unused = sign()
  wall += 40_000
  mono += 40_000
  wall = 200_000
  assert.equal((await send(unused)).status, 401)
  assert.equal(Number(readFileSync(file, 'utf8')), 240)
})

test('new and retained carrier handlers refuse while a caller dependent holds teardown open', async t => {
  const f = callerRuntime(t, { services: webRuntime(t) })
  await f.activate()
  const connection = provideConnection(f.ctx)
  await connection
  observeFixture(f.ctx)
  const entered = Promise.withResolvers()
  const hold = Promise.withResolvers()
  await f.ctx.inject(['automagikCaller'], c => c.effect(() => () => {
    entered.resolve()
    return hold.promise
  }))

  const { request, upstream } = inProcessGate(t, f)
  const member = () => request(fixturePath, 'POST', person('first'), rpc())
  const { handler } = f.webServer.match(prefix + fixturePath)
  assert.equal(result(await member()).value, 'first')
  const { path, method, headers } = upstream.mock.calls[0].arguments[0]
  const disconnect = connection.dispose()
  try {
    await entered.promise
    assert.equal(f.ctx.get('automagikCaller'), undefined)
    const fresh = (await member()).status
    const assertion = f.signer.sign({ principal: person('first'), familyId: 'fixture', method, path: fixturePath })
    const retained = (await invoke(handler, {
      url: path, method, body: rpc(), headers: { ...headers, 'x-automagik-caller': assertion },
    })).status
    assert.deepEqual({ fresh, retained }, { fresh: 503, retained: 503 })
  } finally {
    hold.resolve()
    await disconnect
  }
})

test('adapter disposal leaves the permanent guard ahead of the fallback and later public routes', async t => {
  const f = callerRuntime(t)
  const fallback = countFallback(t, f.webServer)
  const dispose = await f.activate()
  const { match } = f.webServer
  observeFixture(f.ctx)
  const { request } = inProcessGate(t, f)
  const member = () => request(fixturePath, 'POST', person('first'), rpc())
  assert.equal(result(await member()).value, 'first')
  await dispose()
  assert.equal(f.webServer.match, match)
  assert.equal((await member()).status, 503)
  const handler = t.mock.fn((_req, res) => res.writeHead(200).end())
  const removeExact = f.webServer.register({ kind: 'exact', path: prefix + fixturePath, handler })
  const removePrefix = f.webServer.register({ kind: 'prefix', path: prefix + '/api', handler })
  assert.equal((await member()).status, 503)
  assert.equal(handler.mock.callCount(), 0)
  assert.equal(fallback.mock.callCount(), 0)
  removeExact()
  removePrefix()
  await f.activate()
  assert.equal(f.webServer.match, match)
  assert.equal(f.ctx.get('automagikCaller').version, 2)
  assert.equal(f.webServer.match(prefix + fixturePath).path, prefix)
})

test('adapter disposal while a member POST body is held refuses before RPC dispatch', async t => {
  const wall = Date.now()
  t.mock.method(Date, 'now', () => wall)
  const f = callerRuntime(t, { now: () => wall })
  const dispose = await f.activate()
  f.webServer.listenedPort = 54321
  const interceptor = t.mock.fn(() => ({ ok: true }))
  assert.ok(observeRpc(f.ctx, interceptor))

  const method = 'POST'
  const path = prefix + fixturePath
  const assertion = f.signer.sign({ principal: person('first'), familyId: 'fixture', method, path: fixturePath })
  const entered = Promise.withResolvers()
  const hold = Promise.withResolvers()
  const response = invoke(f.webServer.match(path).handler, {
    url: path, method, body: rpc(),
    headers: { host: '127.0.0.1:54321', 'content-type': 'application/json', 'x-automagik-caller': assertion },
    onTransport(req) {
      const iterator = req.iterator.bind(req)
      req.iterator = async function* (options) {
        entered.resolve()
        await hold.promise
        yield* iterator(options)
      }
    },
  })
  try {
    await Promise.race([entered.promise, response.then(() => assert.fail('request finished before reading the body'))])
    await dispose()
    assert.ok(f.ctx.get('connection'))
  } finally {
    hold.resolve()
  }
  const { status } = await response
  assert.deepEqual({ status, calls: interceptor.mock.callCount() }, { status: 503, calls: 0 })
})

test('a held POST is cancelled before its body arrives across connection reactivation', async t => {
  let wall = Date.now()
  t.mock.method(Date, 'now', () => wall)
  const f = callerRuntime(t, { services: webRuntime(t), now: () => wall })
  await f.activate()
  const first = provideConnection(f.ctx)
  await first
  f.webServer.listenedPort = 54321
  const calls = t.mock.fn((_method, _body, _signal, peer) => ({ ok: true, value: peer.principal.person.subject }))
  observeRpc(f.ctx, calls)
  const method = 'POST'
  const path = prefix + fixturePath
  const assertFor = subject => f.signer.sign({ principal: person(subject), familyId: 'fixture', method, path: fixturePath })
  const headers = assertion => ({ host: '127.0.0.1:54321', 'content-type': 'application/json', 'x-automagik-caller': assertion })
  const entered = Promise.withResolvers()
  const hold = Promise.withResolvers()
  let completed
  const old = invoke(f.webServer.match(path).handler, {
    url: path, method, body: rpc(), headers: headers(assertFor('old')),
    onTransport(req) {
      const iterator = req.iterator.bind(req)
      req.iterator = async function* (options) {
        entered.resolve()
        await hold.promise
        yield* iterator(options)
      }
    },
  }).then(reply => (completed = reply))
  try {
    await Promise.race([entered.promise, old.then(() => assert.fail('body read never started'))])
    await first.dispose()
    await provideConnection(f.ctx)
    wall += 6000
    const fresh = await invoke(f.webServer.match(path).handler, {
      url: path, method, body: rpc(), headers: headers(assertFor('new')),
    })
    assert.equal(result(fresh).value, 'new')
    assert.equal(completed?.status, 503, 'the old body is still held')
  } finally {
    hold.resolve()
    await old
  }
  assert.equal(calls.mock.callCount(), 1)
  assert.equal(calls.mock.calls[0].arguments[3].principal.person.subject, 'new')
})

for (const event of ['adapter disposal', 'connection loss']) {
  test(`a dispatched RPC keeps its caller through ${event} while new requests receive 503`, async t => {
    let wall = Date.now()
    t.mock.method(Date, 'now', () => wall)
    const f = callerRuntime(t, { services: webRuntime(t), now: () => wall })
    const ctx = event === 'connection loss' ? f.ctx.isolate('automagikCaller') : f.ctx
    const dispose = await f.activate(ctx)
    const connection = provideConnection(f.ctx)
    await connection
    const service = ctx.get('automagikCaller')
    assert.equal(service.version, 2)
    if (ctx !== f.ctx) assert.equal(f.ctx.get('automagikCaller'), undefined)
    const entered = Promise.withResolvers()
    const hold = Promise.withResolvers()
    assert.ok(observeRpc(f.ctx, async (_method, _body, _signal, peer) => {
      entered.resolve()
      await hold.promise
      const principal = callerOf(ctx)
      assert.equal(principal, peer.principal)
      return { ok: true, value: principal.person.subject }
    }))

    const { request } = inProcessGate(t, f)
    const member = subject => request(fixturePath, 'POST', person(subject), rpc())
    const response = member('first')
    await Promise.race([entered.promise, response.then(() => assert.fail('RPC did not enter the interceptor'))])
    const stopped = event === 'connection loss' ? connection.dispose() : dispose()
    try {
      await setImmediate()
      assert.equal((await member('second')).status, 503)
      assert.equal(ctx.get('automagikCaller'), service)
    } finally {
      hold.resolve()
      await stopped
    }
    assert.equal(result(await response).value, 'first')
    assert.equal(ctx.get('automagikCaller'), undefined)
    assert.equal(callerOf(ctx), undefined)

    wall += 6000
    if (event === 'connection loss') {
      await provideConnection(f.ctx)
      observeFixture(f.ctx)
    } else {
      await f.activate(ctx)
    }
    assert.equal(ctx.get('automagikCaller').version, 2)
    assert.notEqual(ctx.get('automagikCaller'), service)
    assert.equal(result(await member('second')).value, 'second')
  })
}

test('adapter disposal aborts a dispatched RPC at the drain deadline and completes while the RPC is held', { timeout: 2000 }, async t => {
  const f = callerRuntime(t)
  const dispose = await f.activate()
  const schedule = globalThis.setTimeout
  t.mock.method(globalThis, 'setTimeout', (fn, delay, ...args) => schedule(fn, delay === 30_000 ? 10 : delay, ...args))
  const entered = Promise.withResolvers()
  const hold = Promise.withResolvers()
  assert.ok(observeRpc(f.ctx, async (_method, _body, signal) => {
    entered.resolve(signal)
    await hold.promise
    return { ok: true }
  }))

  f.webServer.listenedPort = 54321
  const method = 'POST'
  const path = prefix + fixturePath
  const assertion = f.signer.sign({ principal: person('first'), familyId: 'fixture', method, path: fixturePath })
  let transport
  const response = invoke(f.webServer.match(path).handler, {
    url: path, method, body: rpc(),
    headers: { host: '127.0.0.1:54321', 'content-type': 'application/json', 'x-automagik-caller': assertion },
    onTransport(_req, res) { transport = res },
  })
  try {
    const signal = await Promise.race([entered.promise, response.then(() => assert.fail('RPC did not enter the interceptor'))])
    assert.equal(signal.aborted, false)
    await dispose()
    assert.equal(signal.aborted, true)
    assert.equal(transport.destroyed, true)
    assert.equal(f.ctx.get('automagikCaller'), undefined)
  } finally {
    hold.resolve()
    await response
  }
})

test('an overlapping activation leaves the first owner serving through its disposal', async t => {
  const f = callerRuntime(t)
  await f.activate()
  const original = f.ctx.get('automagikCaller')
  const log = t.mock.method(console, 'error', () => {})
  const disposeOverlap = await f.activate()
  assert.deepEqual(log.mock.calls.map(call => call.arguments), [
    ['multiuser-dsh: startup refused because /_automagik is already reserved'],
  ])
  assert.equal(f.ctx.get('automagikCaller'), original)
  observeFixture(f.ctx)
  const { request } = inProcessGate(t, f)
  const member = () => request(fixturePath, 'POST', person('first'), rpc())
  assert.equal(result(await member()).value, 'first')
  await disposeOverlap()
  assert.equal(result(await member()).value, 'first')
})

test('a duplicate caller provider fails the injected child and releases its reservation', async t => {
  const f = callerRuntime(t)
  const fallback = countFallback(t, f.webServer)
  const { register, registerUpgrade } = f.webServer
  const value = { version: 'fixture' }
  const fixture = f.ctx.plugin({ name: 'fixture-caller', apply(ctx) {
    ctx.provide('automagikCaller', value)
  } })
  await fixture
  const dispose = await f.activate()
  const children = [...f.ctx.registry.values()].flatMap(runtime => [...runtime.fibers])
  const child = children.find(fiber => fiber.parent?.fiber.name === adapter.name && Object.hasOwn(fiber.inject, 'connection'))
  assert.ok(child)
  await assert.rejects(child.await(), /service "automagikCaller" has been registered at <fixture-caller>/)
  assert.equal(f.ctx.get('automagikCaller'), value)
  assert.equal(f.webServer.register, register)
  assert.equal(f.webServer.registerUpgrade, registerUpgrade)
  observeFixture(f.ctx)
  const { request } = inProcessGate(t, f)
  const member = () => request(fixturePath, 'POST', person('first'), rpc())
  assert.equal((await member()).status, 503)
  assert.equal(fallback.mock.callCount(), 0)
  await dispose()
  await fixture.dispose()
  await f.activate()
  assert.equal(f.ctx.get('automagikCaller').version, 2)
  assert.equal(result(await member()).value, 'first')
})

test('a waiting owner reloads the watermark and refuses the previous owner’s signed request', async t => {
  let wall = Date.now()
  const f = callerRuntime(t, { now: () => wall })
  const disposeFirst = await f.activate()
  const first = f.ctx.get('automagikCaller')
  const waiting = f.ctx.isolate('connection').isolate('typertGateway')
  fixtureGateway(waiting)
  await f.activate(waiting)
  assert.equal(waiting.get('connection'), undefined)
  assert.equal(f.ctx.get('automagikCaller'), first)

  t.mock.method(Date, 'now', () => wall)
  observeFixture(f.ctx)
  const { request, upstream } = inProcessGate(t, f)
  const member = () => request(fixturePath, 'POST', person('first'), rpc())
  assert.equal(result(await member()).value, 'first')
  const { path, method, headers } = upstream.mock.calls[0].arguments[0]
  assert.ok(headers['x-automagik-caller'])
  await disposeFirst()
  assert.equal(waiting.get('automagikCaller'), undefined)

  await provideConnection(waiting)
  observeFixture(waiting)
  assert.equal(waiting.get('automagikCaller').version, 2)
  const route = f.webServer.match(prefix + fixturePath)
  assert.equal(route.path, prefix)
  const replay = await invoke(route.handler, { url: path, method, headers, body: rpc() })
  assert.equal(replay.status, 401)
  wall += 6000
  assert.equal(result(await member()).value, 'first')
})

test('member indexes use conditional GET and HEAD with a render-specific weak ETag', async t => {
  const f = await setup(t)
  const { request, upstream } = inProcessGate(t, f)
  f.ctx.on('webserver/index-inject', (table, peer) => {
    table.push({ kind: 'global', name: 'fixtureSubject', value: peer.principal.person.subject })
  })
  for (const path of ['/', '/index.html']) {
    const first = person('first')
    const get = await request(path, 'GET', first)
    assert.equal(get.status, 200)
    assert.equal(get.headers['cache-control'], 'no-cache')
    assert.match(get.headers.etag, /^W\//)
    assert.equal(get.headers.etag, `W/"${createHash('sha1').update(get.bytes).digest('base64url')}"`)
    const headers = { 'if-none-match': get.headers.etag }
    const head = await request(path, 'HEAD', first)
    assert.equal(head.status, 200)
    for (const name of ['content-type', 'cache-control', 'etag']) assert.equal(head.headers[name], get.headers[name])
    assert.equal(head.bytes.length, 0)
    for (const method of ['GET', 'HEAD']) {
      const reply = await request(path, method, first, undefined, headers)
      assert.equal(reply.status, 304)
      assert.equal(reply.headers.etag, get.headers.etag)
      assert.equal(reply.headers['cache-control'], get.headers['cache-control'])
      assert.equal(reply.bytes.length, 0)
    }
    const count = upstream.mock.callCount()
    assert.equal((await request(path, 'GET', undefined, undefined, headers)).status, 401)
    assert.equal(upstream.mock.callCount(), count)

    const second = await request(path, 'GET', person('second'), undefined, headers)
    assert.equal(second.status, 200)
    assert.notDeepEqual(second.bytes, get.bytes)
    assert.notEqual(second.headers.etag, get.headers.etag)
    const untap = f.webServer.tapIndex(html => html.replace('Shell', 'Tapped shell'))
    const changed = await request(path, 'GET', first, undefined, headers)
    untap()
    assert.equal(changed.status, 200)
    assert.notEqual(changed.headers.etag, get.headers.etag)
    assert.match(changed.bytes.toString(), /Tapped shell/)
  }
})

test('the gate and carrier refuse exported package assets that rc.2 serves directly', async t => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNoAAAAggCBd81ytgAAAABJRU5ErkJggg==', 'base64')
  const f = await setup(t, { names: ['fixture-asset'], configurePackage(dir, pkg) {
    pkg.exports['./assets/*'] = './assets/*'
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'assets', 'icon.png'), png)
  } })
  const path = '/plugins/fixture-asset/assets/icon.png?rev=fixture'
  const direct = await f.registry.fetchBundle(new Request('http://dsh.internal' + path))
  assert.equal(direct.status, 200)
  assert.equal(direct.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await direct.arrayBuffer()), png)

  const { request, upstream } = inProcessGate(t, f)
  const principal = person('first')
  f.dispatched.length = 0
  assert.equal((await request(path, 'GET', principal)).status, 404)
  assert.equal(upstream.mock.callCount(), 0)
  const assertion = f.signer.sign({ principal, familyId: 'fixture', method: 'GET', path })
  const reply = await invoke(f.route.handler, {
    url: prefix + path, method: 'GET', headers: { host: '127.0.0.1:54321', 'x-automagik-caller': assertion },
  })
  assert.equal(reply.status, 404)
  assert.deepEqual(f.dispatched, [])
})

test('packages with .map IDs serve their startup combo and executable chunks through the gate', async t => {
  const names = ['example.map', '@scope/x.map']
  const f = await setup(t, { names })
  const { request, upstream } = inProcessGate(t, f)
  const get = path => request(path, 'GET', person('first'))
  const { batches: [batch], entries } = f.registry.graph()
  assert.deepEqual(batch.entries, names)
  const comboPath = '/' + batch.url
  const combo = await get(comboPath)
  assert.equal(combo.status, 200)
  for (const [index, { id, rev }] of entries.entries()) {
    const script = `globalThis.fixtureBundle${index} = true;`
    assert.ok(combo.bytes.includes(script))
    const chunk = await get(`/plugins/${id}/client.lazy.js?rev=${rev}`)
    assert.equal(chunk.status, 200)
    assert.equal(chunk.bytes.toString(), `${script}\n;\n//# sourceMappingURL=client.lazy.js.map?rev=${rev}\n`)
    for (const query of ['', `?rev=${rev}`]) assert.equal((await get(`/plugins/${id}/client.js${query}`)).status, 404)
    const count = upstream.mock.callCount()
    for (const path of [
      `/plugins/${id}/client.lazy.js.map?rev=${rev}`,
      `/plugins/${id}/client.js.map?rev=${rev}`,
      '/' + batch.url.replace(id + '/client.js', id + '/client.js.map'),
    ]) assert.equal((await get(path)).status, 404, path)
    assert.equal(upstream.mock.callCount(), count)
  }
  const sourceMap = /\/\/# sourceMappingURL=(\S+)$/.exec(combo.bytes.toString().trimEnd())
  assert.ok(sourceMap)
  const mapURL = new URL(sourceMap[1], 'http://dsh.internal' + comboPath)
  const direct = await f.registry.fetchBundle(new Request(mapURL))
  assert.equal(direct.status, 200)
  assert.equal((await direct.json()).sections.length, names.length)
  const count = upstream.mock.callCount()
  assert.equal((await get(mapURL.pathname + mapURL.search)).status, 404)
  assert.equal(upstream.mock.callCount(), count)
})

test('the revisioned Bot team client.pane.js chunk form passes through the gate', async t => {
  const f = await setup(t, { names: ['fixture-pane'] })
  const [{ id, rev }] = f.registry.graph().entries
  const source = 'globalThis.fixturePane = true;\n'
  writeFileSync(join(f.dir, 'node_modules', id, 'client.pane.js'), source)
  const { request } = inProcessGate(t, f)
  const reply = await request(`/plugins/${id}/client.pane.js?rev=${rev}`, 'GET', person('first'))
  assert.equal(reply.status, 200)
  assert.equal(reply.bytes.toString(), `${source};\n//# sourceMappingURL=client.pane.js.map?rev=${rev}\n`)
})

// --- RFC 0038 delivery 5b: the member stream carrier through the real gate ------------------

// The real gate on loopback, probing and forwarding to `target` (a listening DSH web server).
async function loopbackGate(t, f, target, { now } = {}) {
  const sessions = new SessionStore(f.dir, { memory: true, accepts: () => true, now })
  const credentials = { port: target.port, authority: `127.0.0.1:${target.port}`, cookie: () => assert.fail('owner credential requested') }
  const gate = createGate({ origin, sessions, multiuser: true, caller: f.signer, credentials })
  gate.listen(0, '127.0.0.1')
  await once(gate, 'listening')
  t.after(() => gate.closeGate())
  const { port } = gate.address()
  const issue = (principal, options) => {
    const issued = sessions.issue(origin, principal, options)
    return { ...issued, headers: { host: new URL(origin).host, origin, cookie: `${COOKIE}=${issued.secret}` } }
  }
  const socket = headers => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/remote.mux`, { headers, perMessageDeflate: true })
    const frames = []
    ws.on('message', data => frames.push(JSON.parse(data.toString())))
    ws.on('error', () => {})
    const opened = new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error('refused'), { status: res.statusCode })))
    })
    opened.catch(() => {})
    return { ws, frames, opened, closed: once(ws, 'close') }
  }
  return { sessions, credentials, port, issue, socket,
    http: (path, headers, body) => send(port, path, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body }) }
}

// Every request DSH's web server receives, as raw headers, before any route sees it.
function recordHops(webServer) {
  const hops = []
  const record = req => { hops.push({ url: req.url, rawHeaders: req.rawHeaders }) }
  webServer.server.prependListener('request', record)
  webServer.server.prependListener('upgrade', record)
  return hops
}

async function streamRuntime(t) {
  const f = callerRuntime(t, { publicMux: true })
  await f.webServer[Service.init]()
  await f.activate()
  return f
}

test('member and guest upgrades are carried through the real gate with the caller header list', async t => {
  const f = await streamRuntime(t)
  const hops = recordHops(f.webServer)
  const g = await loopbackGate(t, f, f.webServer)
  for (const role of ['member', 'guest']) {
    const { headers } = g.issue(person(role, role))
    const s = g.socket(headers)
    await s.opened
    s.ws.send(JSON.stringify({ type: 'open', streamId: 'follow', endpoint: 'remoteAccess/follow', payload: { args: {} } }))
    while (!s.frames.length) await setImmediate()
    assert.deepEqual(s.frames[0], { type: 'item', streamId: 'follow', value: { type: 'baseline', owner: false, grants: [] } })
    const hop = hops.findLast(entry => entry.url === MUX_PATH)
    const names = hop.rawHeaders.filter((_, i) => i % 2 === 0).map(name => name.toLowerCase()).sort()
    assert.deepEqual(names, ['connection', 'host', 'origin', 'sec-websocket-extensions', 'sec-websocket-key',
      'sec-websocket-version', 'upgrade', 'x-automagik-caller'])
    s.ws.close()
    await s.closed
  }
  // Each carried hop followed one probe on its own connection; no hop carried a DSH credential.
  assert.ok(hops.every(hop => !hop.rawHeaders.some((value, i) => i % 2 === 0 && value.toLowerCase() === 'cookie')))
})

test('revoking a member session closes the carried socket and releases its Peer and streams', async t => {
  const f = await streamRuntime(t)
  const created = t.mock.method(f.connection, 'createPeer')
  const g = await loopbackGate(t, f, f.webServer)
  const issued = g.issue(person('first'))
  const s = g.socket(issued.headers)
  await s.opened
  s.ws.send(JSON.stringify({ type: 'open', streamId: 'follow', endpoint: 'remoteAccess/follow', payload: { args: {} } }))
  while (!s.frames.length) await setImmediate()
  const peer = created.mock.calls.map(call => call.result).find(candidate => candidate.interactions === 'answer')
  const access = f.ctx.get('remoteAccess')
  assert.equal(access.followers.size, 1)
  g.sessions.revoke(issued.family)
  await s.closed
  while (!peer.signal.aborted || access.followers.size) await setImmediate()
})

test('hard family expiry at the real gate closes the member socket and both stream pumps', { timeout: 5000 }, async t => {
  const f = await streamRuntime(t)
  const created = t.mock.method(f.connection, 'createPeer')
  let now = Date.now()
  const g = await loopbackGate(t, f, f.webServer, { now: () => now })
  const issued = g.issue(person('first'), { expires: now + 5000 })
  const s = g.socket(issued.headers)
  await s.opened
  for (const streamId of ['one', 'two']) {
    s.ws.send(JSON.stringify({ type: 'open', streamId, endpoint: 'remoteAccess/follow', payload: { args: {} } }))
  }
  while (s.frames.length < 2) await setImmediate()
  const peer = created.mock.calls.map(call => call.result).find(candidate => candidate.interactions === 'answer')
  const access = f.ctx.get('remoteAccess')
  assert.equal(access.followers.size, 2)
  assert.ok(g.sessions.active(issued.family))
  now += 5000
  assert.equal(g.sessions.active(issued.family), false)
  await s.closed
  while (!peer.signal.aborted || access.followers.size) await setImmediate()
  assert.deepEqual(s.frames.map(frame => frame.streamId).sort(), ['one', 'two'])
})

test('a DSH restart interval never hands a signed member request to an early private route', async t => {
  const f = callerRuntime(t)
  await f.webServer[Service.init]()
  const early = []
  const record = req => early.push({ url: req.url, caller: req.headers['x-automagik-caller'] })
  f.webServer.register({ kind: 'prefix', path: prefix, handler(req, res) { record(req); res.writeHead(200).end('early') } })
  f.webServer.registerUpgrade({ path: MUX_PATH, handler(req, socket) {
    record(req)
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
  } })
  const g = await loopbackGate(t, f, f.webServer)
  const member = () => g.issue(person('first')).headers
  const attempt = async () => {
    const http = await g.http('/api/fixture', member(), rpc())
    const s = g.socket(member())
    const upgrade = await s.opened.then(() => 101, error => error.status)
    return [http.status, upgrade]
  }
  assert.deepEqual(await attempt(), [503, 503])
  assert.ok(early.length > 0, 'the early route saw the probes')
  assert.ok(early.every(entry => entry.caller === undefined))
  // The adapter activates late: startup is refused (A's 404 for HTTP, 503 for upgrades).
  const log = t.mock.method(console, 'error', () => {})
  await f.activate()
  assert.match(log.mock.calls[0].arguments[0], /startup refused/)
  log.mock.restore()
  assert.deepEqual(await attempt(), [503, 503])
  assert.ok(early.every(entry => entry.caller === undefined))

  // A clean restart: a fresh DSH whose adapter activates normally carries members again.
  const next = runtime(t)
  new RemoteAccessService(next.ctx)
  await next.webServer[Service.init]()
  fixtureGateway(next.ctx, { publicMux: true })
  observeFixture(next.ctx)
  await f.activate(next.ctx)
  g.credentials.port = next.webServer.port
  g.credentials.authority = `127.0.0.1:${next.webServer.port}`
  const reply = await g.http('/api/fixture', member(), rpc())
  assert.equal(result(reply).value, 'first')
  const s = g.socket(member())
  await s.opened
  s.ws.close()
  await s.closed
  assert.ok(early.every(entry => entry.caller === undefined))
})
