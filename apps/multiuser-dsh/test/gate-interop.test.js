import assert from 'node:assert/strict'
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
import { invoke, localHTTP, prefix, rpc, runtime, send, wire } from './runtime.mjs'

const origin = 'https://workspace.invalid'
const instance = wire.payload.aud
const webConfig = { openBrowser: false, printUrl: false, surfaceContext: false }

function clientRegistry(ctx, dir, names) {
  const entries = names.map((name, index) => {
    const path = join(dir, 'node_modules', name)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'client.js'), `globalThis.fixtureBundle${index} = true;\n`)
    writeFileSync(join(path, 'client.lazy.js'), `globalThis.fixtureBundle${index} = true;\n`)
    writeFileSync(join(path, 'index.js'), 'export {}')
    writeFileSync(join(path, 'package.json'), JSON.stringify({
      name, type: 'module',
      exports: { '.': './index.js', './client': './client.js', './package.json': './package.json' },
      dsh: { client: { platform: 'web' } },
    }))
    return { options: { name }, fiber: {}, parent: { tree: { ctx: { baseUrl: pathToFileURL(join(dir, 'profile.json')).href } } } }
  })
  ctx.provide('loader', { entries: () => entries })
  return new ClientModuleRegistry(ctx)
}

function callerRuntime(t) {
  const services = runtime(t)
  const dir = mkdtempSync(join(tmpdir(), 'caller-interop-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const signer = createSigner({ dir, publicDir: dir, instance: () => instance })
  signer.publish()
  const read = fs.readFileSync
  const mount = t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === '/proc/self/mountinfo') return `2 1 0:2 / ${dir} ro - tmpfs tmpfs rw`
    if (typeof file === 'string' && file.startsWith('/proc/self/fdinfo/')) return 'mnt_id:\t2\n'
    return read(file, ...args)
  })
  syncBuiltinESMExports()
  t.after(() => { mount.mock.restore(); syncBuiltinESMExports() })
  return { ...services, dir, signer, async activate() {
    const env = { AUTOMAGIK_MULTIUSER: '1', AUTOMAGIK_CALLER_KEYS: join(dir, 'caller-keys.json'), AUTOMAGIK_INSTANCE_ID: instance, DSH_HOME: dir }
    const old = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]))
    Object.assign(process.env, env)
    const elapsed = Date.now() - 10_000
    const clock = t.mock.method(Date, 'now', () => elapsed)
    try {
      const activation = services.ctx.plugin(adapter)
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

async function setup(t, { names = ['fixture-a', 'fixture-b'], fixtureDist = true } = {}) {
  const { ctx, webServer, connection, dir, signer, activate } = callerRuntime(t)
  const dispatched = []
  const createFetchHandler = connection.createSharedFetchHandler.bind(connection)
  t.mock.method(connection, 'createSharedFetchHandler', channel => {
    const handler = createFetchHandler(channel)
    return { ...handler, fetch(request, peer) {
      dispatched.push(request.url)
      return handler.fetch(request, peer)
    } }
  })
  await activate()
  assert.equal(ctx.get('automagikCaller').version, 1)
  new RemoteAccessService(ctx)
  const route = webServer.match(prefix + '/api/fixture')
  assert.equal(route?.path, prefix)
  assert.equal(typeof route.handler, 'function')
  assert.equal(webServer.upgrades.size, 0)

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
  const registry = clientRegistry(ctx, dir, names)
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
  return f.connection.rpc.intercept('/api', method => method === 'fixture', async (_method, _body, _signal, peer) => {
    if (++overlapped === 2) both.resolve()
    await both.promise
    await setImmediate()
    const caller = callerOf(f.ctx)
    assert.equal(caller, peer.principal)
    return { ok: true, value: caller.person.subject }
  })
}

function businessGateway({ ctx, connection }) {
  const typert = new TypertRegistry(ctx)
  let calls = 0
  class Session extends TypertRemoteService {
    prompt() { calls++; return 'prompted' }
  }
  new Session(ctx, 'session')
  typert.register({ package: 'fixture-session', face: 'host', model: {}, schemas: [], invocations: [{
    id: 'fixture-session/prompt', service: 'session', namespace: 'session', method: 'prompt',
    invocation: { kind: 'direct' }, parameters: [], result: { mode: 'src-json' },
  }] })
  const gateway = new TypertGatewayService(ctx, TypertGatewayService.Config({}))
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
  const gate = createGate({ origin, sessions, multiuser: true, caller: f.signer, credentials: {
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
  const request = (path, method, principal, body) => {
    const issued = principal && sessions.issue(origin, principal)
    return invoke(gate.listeners('request')[0], { method, url: path, body, waitForEnd: true, headers: {
      host: new URL(origin).host, origin, cookie: issued && `${COOKIE}=${issued.secret}`, 'content-type': 'application/json',
      'content-length': body ? String(Buffer.byteLength(body)) : undefined,
    } })
  }
  return { request, upstream }
}

for (const kind of ['exact', 'prefix', 'upgrade']) {
  test(`a preexisting ${kind} route in /_automagik blocks adapter startup and receives no member requests`, async t => {
    const f = callerRuntime(t)
    const { webServer } = f
    const responderFor = webServer.responderFor
    const path = prefix + (kind === 'prefix' ? '/api' : '/api/fixture')
    const handler = t.mock.fn((_req, res) => { res.writeHead(200); res.end('intruder') })
    if (kind === 'upgrade') webServer.registerUpgrade({ path, handler })
    else webServer.register({ kind, path, handler })
    const log = t.mock.method(console, 'error', () => {})
    const dispose = await f.activate()
    assert.equal(f.ctx.get('automagikCaller'), undefined)
    assert.equal(webServer.prefixes.has(prefix), false)
    assert.equal(log.mock.callCount(), 1)
    assert.match(log.mock.calls[0].arguments[0], /startup refused.*\/_automagik/)
    const { request, upstream } = inProcessGate(t, f)
    assert.equal((await request('/api/fixture', 'POST', person('first'), rpc())).status, 404)
    assert.equal(upstream.mock.callCount(), 1)
    assert.equal(upstream.mock.calls[0].arguments[0].path, prefix + '/api/fixture')
    assert.equal(handler.mock.callCount(), 0)
    await dispose()
    assert.equal(webServer.responderFor, responderFor)
  })
}

test('the adapter reserves /_automagik for its lifetime and later intruders receive no member requests', async t => {
  const f = callerRuntime(t)
  const { webServer, connection } = f
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
  connection.rpc.intercept('/api', method => method === 'fixture', (_method, _body, _signal, peer) =>
    ({ ok: true, value: peer.principal.person.subject }))
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
    captured.push({ path: req.url, method: req.method, headers: req.headers })
    f.webServer.match(new URL(req.url, 'http://x').pathname)?.handler(req, res)
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
    const upgrade = await send(port, '/api/remote.mux', {
      upgrade: true, headers: { ...headers, connection: 'Upgrade', upgrade: 'websocket' },
    })
    assert.equal(upgrade.status, 403)
  }
  const firstHop = captured[0]
  assert.ok(firstHop.headers['x-automagik-caller'])
  assert.equal(firstHop.headers.cookie, undefined)
  assert.equal(firstHop.headers.authorization, undefined)
  const replay = await send(upstream.port, firstHop.path, { method: firstHop.method, headers: firstHop.headers, body: rpc() })
  assert.equal(replay.status, 401)
  await frontendAssertions(f, (path, method = 'GET') => send(port, path, { method, headers: first }))
})
