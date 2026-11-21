import assert from 'node:assert/strict'
import { createPublicKey } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import http, { request as requestUpstream } from 'node:http'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex, duplexPair, PassThrough, Readable, Writable } from 'node:stream'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { verifyOwner } from '../../apps/multiuser-dsh/src/assertion.js'
import { createNonces } from '../../apps/multiuser-dsh/src/nonces.js'
import { createSigner, sessionHash } from '../gate-caller.mjs'
import { createGate } from '../gate.mjs'
import { SessionStore, sessionCookie } from '../gate-store.mjs'

const origin = 'https://workspace.invalid'
const workspace = 'workspace'
const path = '/api/omni-ui'
const header = 'x-automagik-owner-assertion'
const now = () => 60_000

function connectHttp(server) {
  const [client, socket] = duplexPair()
  client.setTimeout = socket.setTimeout = () => {}
  // A parser error writes its reply then destroys the server side immediately.
  // Node 24.18+ also destroys the client side of the pair (close, no end); older ones leave it.
  socket.once('close', () => { if (!client.readableEnded && !client.destroyed) client.push(null) })
  server.emit('connection', socket)
  return client
}

async function post(server, cookie, extra, body = '') {
  const client = connectHttp(server)
  let reply = ''
  client.on('data', bytes => { reply += bytes })
  const ended = new Promise(resolve => { client.once('end', resolve); client.once('close', resolve) })
  const headers = [`Host: ${new URL(origin).host}`, `Origin: ${origin}`, `Cookie: ${cookie}`,
    'Connection: close', ...extra]
  client.write(`POST ${path} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n${body}`)
  await ended
  client.destroy()
  return reply
}

function fixture(t, {
  multiuser = true, credential = async () => 'dsh=fixture', fail = false, wire = false,
  handleUpstream,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-owner-'))
  const publicDir = join(dir, 'public')
  mkdirSync(publicDir)
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const signer = createSigner({ dir, publicDir, instance: () => workspace, now })
  const ownerSigned = [], carried = [], forwarded = []
  const credentials = { authority: '127.0.0.1:1', port: 1, cookie: credential }
  const sessions = new SessionStore(dir, { memory: true, accepts: () => true, now })
  let dropped = false
  const gate = createGate({ origin, sessions, multiuser, credentials,
    cloud: { pollInterval: 300_000, drops: () => dropped },
    connectDsh: async () => new PassThrough(),
    caller: {
      sign(args) { carried.push(args); return signer.sign(args) },
      signOwner(args, limit) {
        ownerSigned.push(args)
        if (fail) throw new Error('fixture signer refused')
        return signer.signOwner(args, limit)
      },
    },
  })
  t.after(() => gate.closeGate())
  const upstream = http.createServer((req, res) => {
    forwarded.push({ headers: req.headers, path: req.url })
    if (handleUpstream) {
      handleUpstream(req, res).catch(error => res.destroy(error))
      return
    }
    req.resume()
    res.writeHead(202, { connection: 'close' }).end('fixture')
  })
  t.mock.method(http, 'request', (options, onResponse) => {
    if (wire) {
      return requestUpstream({ ...options, createConnection: () => connectHttp(upstream) },
        onResponse)
    }
    forwarded.push(options)
    const proxy = new Writable({ write(_bytes, _encoding, done) { done() } })
    proxy.setTimeout = () => {}
    if (onResponse) proxy.on('finish', () => onResponse(Object.assign(Readable.from(['fixture']), {
      statusCode: 202, headers: {},
    })))
    return proxy
  })
  const issue = (...roles) => {
    const principal = { workspace, issuer: origin, subject: 'test', roles }
    const { secret, family } = sessions.issue(origin, principal)
    return { family, cookie: sessionCookie(secret).split(';', 1)[0] }
  }
  const request = async ({
    cookie, target = path, method = 'POST', headers = {}, upgrade = false,
  }) => {
    const incoming = { host: new URL(origin).host, origin, cookie, ...headers }
    const rawHeaders = Object.entries(incoming).flat()
    const req = Object.assign(Readable.from([]), {
      method, url: target, headers: incoming, rawHeaders, socket: new EventEmitter(),
    })
    if (upgrade) {
      const socket = new Duplex({ read() {}, write(_chunk, _encoding, done) { done() } })
      t.after(() => socket.destroy())
      await gate.listeners('upgrade')[0](req, socket, Buffer.alloc(0))
      return
    }
    const res = new PassThrough()
    res.resume()
    res.setHeader = () => {}
    res.writeHead = status => Object.assign(res, { status, headersSent: true })
    await gate.listeners('request')[0](req, res)
    await setImmediate()
    return res.status
  }
  return { gate, carried, ownerSigned, forwarded, issue, request, signer,
    drop: () => { dropped = true },
    keys() {
      const published = JSON.parse(readFileSync(join(publicDir, 'caller-keys.json')))
      return new Map(published.keys.map(jwk => [jwk.kid, {
        instance: workspace, key: createPublicKey({ key: { kty: 'OKP', ...jwk }, format: 'jwk' }),
      }]))
    },
  }
}

test('the exact owner/admin POST gets an assertion bound to its family', async t => {
  const f = fixture(t)
  for (const roles of [['owner'], ['admin', 'member']]) {
    const { cookie, family } = f.issue(...roles)
    assert.equal(await f.request({ cookie }), 202)
    const token = f.forwarded.at(-1).headers[header]
    const request = new Request(origin + path, { method: 'POST', headers: { [header]: token } })
    const nonces = createNonces({ startedAtSec: 50, anchorSec: 60 })
    assert.deepEqual(verifyOwner(request, { keys: f.keys(), nonces, now }), {
      principal: family.principal, session: sessionHash(family.id),
    })
  }
  const member = f.issue('member')
  const input = { principal: member.family.principal, familyId: member.family.id }
  assert.throws(() => f.signer.signOwner(input), /outside the signing scope/)
  assert.equal(await f.request({ cookie: member.cookie }), 202)
  assert.equal(f.carried.length, 1)
  assert.equal(f.forwarded.at(-1).path, '/_automagik/caller' + path)
  assert.equal(f.forwarded.at(-1).headers[header], undefined)
  assert.equal(f.ownerSigned.length, 2)
})

test('owner URL aliases, GET and upgrade keep their upstream requests unsigned', async t => {
  const f = fixture(t)
  const { cookie } = f.issue('owner')
  for (const target of ['/api/omni-ui/', '/api//omni-ui', '/api/./omni-ui', '/api/omni-ui?',
    '/api/omni-ui?x', '/api%2Fomni-ui', '/api/%6fmni-ui']) {
    assert.equal(await f.request({ cookie, target }), 202, target)
    assert.equal(f.forwarded.at(-1).path, target)
    assert.equal(f.forwarded.at(-1).headers[header], undefined)
  }
  assert.equal(await f.request({ cookie, method: 'GET' }), 202)
  await f.request({ cookie, method: 'GET', upgrade: true, headers: { upgrade: 'websocket' } })
  assert.equal(f.forwarded.at(-1).headers.upgrade, 'websocket')
  assert.equal(f.forwarded.at(-1).headers[header], undefined)
  assert.equal(f.ownerSigned.length, 0)
})

test('ambiguous owner headers preserve upstream handling without signing', { timeout: 5000 },
  async t => {
    const f = fixture(t, { wire: true })
    const { cookie } = f.issue('owner')
    let handled = 0
    f.gate.on('request', () => { handled++ })
    const send = (extra, body) => post(f.gate, cookie, extra, body)
    for (const [extra, body] of [
      [['Content-Length: 0', 'CONTENT-LENGTH: 0']],
      [['Transfer-Encoding: chunked', 'TRANSFER-ENCODING: chunked'], '0\r\n\r\n'],
    ]) {
      assert.match(await send(extra, body), /^HTTP\/1\.1 400 /, extra.join(', '))
      assert.equal(handled, 0)
    }
    assert.match(await send(['HOST: duplicate.invalid']), /^HTTP\/1\.1 400 /)
    assert.match(await send([`Origin: ${origin}`]), /^HTTP\/1\.1 401 /)
    assert.equal(handled, 2)
    assert.equal(f.forwarded.length, 0)
    const cases = [
      ['Content-Type: application/json', 'CONTENT-TYPE: application/json'],
      ['X-Automagik-Generic: first', 'x-automagik-generic: second'],
      ['X-Automagik-Owner-Assertion: client'],
      ...['host', 'origin', 'content-type', 'content-length', 'transfer-encoding',
        'x-automagik-other']
        .map(name => [`Connection: foo, ${name.toUpperCase()}`]),
    ]
    for (const [index, extra] of cases.entries()) {
      assert.match(await send(extra), /^HTTP\/1\.1 202 /, extra.join(', '))
      assert.equal(f.forwarded.length, index + 1)
      assert.equal(f.forwarded.at(-1).path, path)
      assert.equal(f.forwarded.at(-1).headers[header], undefined)
    }
    assert.equal(f.ownerSigned.length, 0)
  })

test('an accepted ambiguous owner POST stays unsigned through the DSH Fetch bridge',
  { timeout: 5000 }, async t => {
    // Server CI installs the Bot harness. Both harnesses pin the same DSH version.
    const source = ['multiuser-dsh', 'bots-dsh'].map(app => new URL(
      `../../apps/${app}/dev/harness/node_modules/@deepseek-ai/` +
        'dsh-client-connection/src/http-bridge.ts', import.meta.url,
    )).find(file => existsSync(file))
    if (!source) { t.skip('the pinned DSH test harness is unavailable'); return }
    if (!process.features.typescript) { t.skip('this Node cannot strip TypeScript'); return }
    // Node cannot load TS directly under node_modules. The bridge has only Node runtime imports.
    const js = stripTypeScriptTypes(readFileSync(source, 'utf8'))
    const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
    const { bridge } = await import(moduleUrl)
    const payload = '{"message":"fixture"}'
    const peer = {}
    let received
    const f = fixture(t, { wire: true, handleUpstream: (req, res) => bridge(req, res, {
      requestBodyMode: () => 'buffered',
      async fetch(request, caller) {
        const body = await request.text()
        received = { request, caller, body }
        const accepted = request.method === 'POST' && new URL(request.url).pathname === path &&
          body === payload
        return new Response(null, { status: accepted ? 202 : 400 })
      },
    }, peer) })
    const { cookie } = f.issue('owner')
    const reply = await post(f.gate, cookie, [
      'Content-Type: application/json', 'CONTENT-TYPE: text/plain',
      `Content-Length: ${Buffer.byteLength(payload)}`,
    ], payload)
    assert.match(reply, /^HTTP\/1\.1 202 /)
    assert.equal(f.forwarded.length, 1)
    assert.equal(f.forwarded[0].headers[header], undefined)
    assert.equal(received.request.headers.has(header), false)
    assert.equal(received.request.headers.get('content-type'), 'application/json')
    assert.equal(received.body, payload)
    assert.equal(received.caller, peer)
    assert.equal(f.ownerSigned.length, 0)
  })

test('an oversized upstream block forwards the owner POST unsigned', async t => {
  const f = fixture(t)
  const { cookie } = f.issue('owner')
  const accept = 'x'.repeat(15_000)
  assert.equal(await f.request({ cookie, headers: { accept } }), 202)
  assert.equal(f.forwarded[0].headers.accept, accept)
  assert.equal(f.forwarded[0].headers[header], undefined)
})

test('a signer exception preserves the owner upstream status without an assertion', async t => {
  const f = fixture(t, { fail: true })
  assert.equal(await f.request(f.issue('owner')), 202)
  assert.equal(f.ownerSigned.length, 1)
  assert.equal(f.forwarded[0].headers[header], undefined)
})

test('a Cloud drop during credential lookup suppresses the signature', async t => {
  const held = Promise.withResolvers()
  const f = fixture(t, { credential: () => held.promise })
  const pending = f.request(f.issue('owner'))
  await setImmediate()
  f.drop()
  held.resolve('dsh=fixture')
  assert.equal(await pending, 202)
  assert.equal(f.ownerSigned.length, 0)
  assert.equal(f.forwarded[0].headers[header], undefined)
})

test('multiuser off forwards the owner POST without signing', async t => {
  const f = fixture(t, { multiuser: false })
  assert.equal(await f.request(f.issue('owner')), 202)
  assert.equal(f.ownerSigned.length, 0)
  assert.equal(f.forwarded[0].headers[header], undefined)
})
