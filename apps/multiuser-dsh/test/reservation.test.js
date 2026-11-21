import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Service } from '@deepseek-ai/cordis'
import * as adapter from '../index.js'
import { reservationOf } from '../src/reservation.js'
import { invoke, prefix, runtime } from './runtime.mjs'

async function upgrade(port, path) {
  const socket = createConnection({ host: '127.0.0.1', port })
  socket.setEncoding('utf8')
  socket.setTimeout(5000, () => socket.destroy(new Error('Upgrade timed out')))
  const chunks = []
  socket.on('data', chunk => chunks.push(chunk))
  socket.once('connect', () => {
    socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`)
  })
  await once(socket, 'close')
  return chunks.join('')
}

const refusal = status => `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
const switching = 'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'

async function activate(ctx, mode, home) {
  const env = { AUTOMAGIK_MULTIUSER: mode, DSH_HOME: home }
  const old = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]))
  Object.assign(process.env, env)
  try {
    const fiber = ctx.plugin(adapter)
    await fiber
    return () => fiber.dispose()
  } finally {
    for (const [name, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

test('private upgrades follow the live adapter owner and refuse unknown or disabled routes on the wire', async t => {
  const { ctx, webServer } = runtime(t)
  await webServer[Service.init]()
  const home = mkdtempSync(join(tmpdir(), 'caller-upgrade-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const reservation = reservationOf(webServer)
  const claim = t.mock.method(reservation, 'claim')
  const dispose = await activate(ctx, '1', home)
  const owner = claim.mock.calls.at(-1).result
  const path = prefix + '/api/private.mux'
  const publicPath = '/api/remote.mux'
  const handler = t.mock.fn((_req, socket) => { socket.end(switching) })
  const publicHandler = t.mock.fn((_req, socket) => { socket.end(switching) })
  const oldRemove = owner.registerUpgrade({ path, handler })
  assert.throws(() => owner.registerUpgrade({ path, handler }), /duplicate reserved route/)
  assert.throws(() => owner.registerUpgrade({ path: publicPath, handler }), /invalid or duplicate reserved route/)
  assert.equal(webServer.upgrades.size, 0)
  webServer.registerUpgrade({ path: publicPath, handler: publicHandler })
  const send = path => upgrade(webServer.port, path)
  assert.equal(await send(path), switching)
  assert.equal(handler.mock.callCount(), 1)
  assert.equal(await send(publicPath), switching)
  assert.equal(publicHandler.mock.callCount(), 1)
  handler.mock.resetCalls()

  const unavailable = refusal('503 Service Unavailable')
  await dispose()
  assert.equal(await send(path), unavailable)
  const intruder = t.mock.fn()
  const removeIntruder = webServer.registerUpgrade({ path, handler: intruder })
  assert.equal(await send(path), unavailable)
  assert.equal(intruder.mock.callCount(), 0)
  removeIntruder()

  const disposeNext = await activate(ctx, '1', home)
  const next = claim.mock.calls.at(-1).result
  assert.equal(await send(path), unavailable)
  assert.equal(handler.mock.callCount(), 0)
  const nextHandler = t.mock.fn((_req, socket) => { socket.end(switching) })
  next.registerUpgrade({ path, handler: nextHandler })
  oldRemove()
  owner.release()
  assert.equal(await send(path), switching)
  assert.equal(nextHandler.mock.callCount(), 1)
  assert.equal(webServer.upgrades.size, 1)
  await disposeNext()

  await activate(ctx, '0', home)
  const disabled = claim.mock.calls.at(-1).result
  disabled.registerUpgrade({ path, handler })
  assert.equal(await send(path), refusal('401 Unauthorized'))
  assert.equal(await send(path + '/unmatched'), unavailable)
  assert.equal(handler.mock.callCount(), 0)
  assert.equal(webServer.upgrades.size, 1)
})

test('private HTTP route priority and independent collision tokens stay scoped to the current reservation', async t => {
  const { webServer } = runtime(t)
  const reservation = reservationOf(webServer)
  const marker = Symbol.for('automagik.multiuser-dsh.reservation')
  assert.deepEqual(Object.getOwnPropertyDescriptor(webServer, marker), {
    value: reservation, enumerable: false, writable: false, configurable: false,
  })
  const { match } = webServer
  const { get } = webServer.upgrades
  assert.equal(reservationOf(webServer), reservation)
  assert.equal(webServer.match, match)
  assert.equal(webServer.upgrades.get, get)
  const path = prefix + '/api/x'
  const status = async (url, { handler } = webServer.responderFor(url)) =>
    (await invoke(handler, { url, method: 'GET', headers: {} })).status
  assert.equal(await status(path), 503)
  const undoFirst = reservation.refuse()
  const undoSecond = reservation.refuse()
  assert.equal(await status(path), 404)
  undoFirst()
  undoFirst()
  assert.equal(await status(path), 404)

  const owner = reservation.claim({ admitUpgrade: () => true })
  assert.equal(reservation.claim({ admitUpgrade: () => true }), undefined)
  const broad = { kind: 'prefix', path: prefix, handler: (_req, res) => res.writeHead(200).end() }
  const narrow = { ...broad, path: prefix + '/api' }
  const exact = { ...broad, kind: 'exact', path }
  owner.register(broad)
  owner.register(narrow)
  const remove = owner.register(exact)
  assert.throws(() => owner.register(exact), /duplicate reserved route/)
  assert.throws(() => owner.register({ ...exact, path: '/public' }), /invalid or duplicate reserved route/)
  assert.throws(() => owner.register({ ...exact, kind: 'other' }), /reserved route kind/)
  const selected = webServer.match(path)
  assert.equal(selected.kind, exact.kind)
  assert.equal(selected.path, exact.path)
  assert.equal(typeof selected.handler, 'function')
  assert.equal(await status(path), 200)
  assert.equal(webServer.match(path + '/child').path, narrow.path)
  assert.equal(webServer.match(prefix + '/assets').path, broad.path)
  assert.equal(await status('/_automagik/unknown'), 404)
  assert.equal(webServer.exact.size, 0)
  assert.equal(webServer.prefixes.size, 0)

  remove()
  const replacement = { ...exact }
  owner.register(replacement)
  remove()
  assert.equal(webServer.match(path).kind, replacement.kind)
  assert.equal(await status(path, selected), 503)
  const selectedReplacement = webServer.match(path)
  assert.equal(await status(path, selectedReplacement), 200)
  owner.release()
  assert.equal(await status(path, selectedReplacement), 503)
  assert.equal(await status(path), 404)
  undoSecond()
  assert.equal(await status(path), 503)
})

test('private upgrade admission is checked when the selected route is invoked', t => {
  const { webServer } = runtime(t)
  let active = true
  let admitted = false
  const reservation = reservationOf(webServer)
  const admitUpgrade = t.mock.fn(() => admitted)
  const owner = reservation.claim({ active: () => active, admitUpgrade })
  const path = prefix + '/api/private.mux'
  const handler = t.mock.fn()
  owner.registerUpgrade({ path, handler })
  const route = webServer.upgrades.get(path)
  const socket = Object.assign(new EventEmitter(), {
    destroy: t.mock.fn(() => socket.emit('close')),
    end: t.mock.fn((_bytes, flushed) => flushed()),
  })
  route.handler({}, socket, Buffer.alloc(0))
  assert.equal(socket.end.mock.calls[0].arguments[0], refusal('401 Unauthorized'))
  assert.equal(socket.destroy.mock.callCount(), 1)
  assert.equal(handler.mock.callCount(), 0)
  admitted = true
  route.handler({}, socket, Buffer.alloc(0))
  assert.equal(handler.mock.callCount(), 1)
  active = false
  route.handler({}, socket, Buffer.alloc(0))
  assert.equal(socket.end.mock.calls[1].arguments[0], refusal('503 Service Unavailable'))
  assert.equal(admitUpgrade.mock.callCount(), 2)
  active = true
  owner.release()
  route.handler({}, socket, Buffer.alloc(0))
  assert.equal(socket.end.mock.calls[2].arguments[0], refusal('503 Service Unavailable'))
  assert.equal(handler.mock.callCount(), 1)
})
