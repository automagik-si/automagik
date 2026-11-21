import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { Duplex, PassThrough, Readable, Writable } from 'node:stream'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { createGate, CLOUD_OPEN_PATH, CLOUD_OPEN_FINISH_PATH, CLOUD_RENEW_PATH } from '../gate.mjs'
import { SessionStore, cookieSecret, sessionCookie } from '../gate-store.mjs'
import routeFixture from './fixtures/caller-role-paths.json' with { type: 'json' }

const origin = 'https://workspace.invalid'
const workspace = 'workspace'
const issuer = 'https://id.invalid'
const feed = '/api/omni-ui/feed?viewer=mounted.owner'

function fixture(t, { upstreamStatus = 200 } = {}) {
  let now = 1000
  const sessions = new SessionStore(undefined, { memory: true, accepts: () => true, now: () => now })
  const upstreams = []
  const signed = []
  const invalidated = []
  const socket = () => {
    const output = []
    return Object.assign(new Duplex({
      read() {},
      write(chunk, _encoding, done) { output.push(chunk.toString()); done() },
    }), { output })
  }
  t.mock.method(http, 'request', (options, respond) => {
    const proxy = new Writable({ autoDestroy: false, write(_chunk, _encoding, done) { done() } })
    proxy.setTimeout = () => {}
    if (options.headers.upgrade === 'websocket') {
      const upstream = socket()
      upstreams.push({ options, proxy, upstream })
      proxy.once('finish', () => proxy.emit('upgrade', { headers: {} }, upstream, Buffer.alloc(0)))
      return proxy
    }
    const upstream = new PassThrough()
    upstream.statusCode = upstreamStatus
    upstream.headers = { 'content-type': 'text/event-stream' }
    upstreams.push({ options, proxy, upstream })
    proxy.once('finish', () => {
      respond(upstream)
      upstream.write('data: private content\n\n')
    })
    proxy.once('close', () => upstream.destroy())
    return proxy
  })
  const gate = createGate({
    origin, sessions, multiuser: true, caller: { sign: value => { signed.push(value); return 'fixture' } },
    connectDsh: async () => new PassThrough(),
    credentials: { port: 1, authority: '127.0.0.1:1', cookie: async () => 'dsh=fixture', invalidate: value => invalidated.push(value) },
    cloud: {
      config: { workspace, rail: 'https://rail.invalid' }, drops: () => false, pollInterval: 300_000,
      open: async subject => ({ principal: { issuer, subject, roles: ['guest'], workspace }, expires: 60_000 }),
      renew: async principal => ({ principal: { ...principal, roles: ['member'] }, expires: 60_000 }),
    },
    auditAccess: () => {},
  })
  t.after(() => gate.emit('close'))
  function issue(subject, role) {
    const issued = sessions.issue(origin, { issuer, subject, roles: [role], workspace }, {
      expires: 60_000, proof: { aud: workspace, token: 'proof', exp: 60 },
    })
    return { ...issued, cookie: sessionCookie(issued.secret).split(';', 1)[0] }
  }
  async function request(url, { cookie, method = 'GET', headers = {}, body } = {}) {
    const req = Object.assign(Readable.from(body ? [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))] : []), {
      url, method, socket: new EventEmitter(),
      headers: { host: new URL(origin).host, origin, ...(cookie ? { cookie } : {}), ...headers },
    })
    req.rawHeaders = Object.entries(req.headers).flat()
    const res = new PassThrough()
    res.body = ''
    res.headers = {}
    res.setHeader = (name, value) => { res.headers[name] = value }
    res.writeHead = (status, headers) => Object.assign(res, { status, headersSent: true, headers: { ...res.headers, ...headers } })
    res.on('data', chunk => { res.body += chunk.toString() })
    await gate.listeners('request')[0](req, res)
    await setImmediate()
    return res
  }
  async function upgrade(cookie) {
    const downstream = socket()
    const headers = { host: new URL(origin).host, origin, cookie, upgrade: 'websocket', 'sec-websocket-version': '13' }
    const req = { url: '/api/remote.mux', method: 'GET', headers, rawHeaders: Object.entries(headers).flat() }
    await gate.listeners('upgrade')[0](req, downstream, Buffer.alloc(0))
    await setImmediate()
    return downstream
  }
  return { sessions, issue, request, upgrade, upstreams, signed, invalidated, setTime: value => { now = value } }
}

test('G5 sign-out and Cloud demotion cut the owner and admin HTTP feeds at both ends by family', async t => {
  const f = fixture(t)
  for (const transition of ['sign-out', 'demotion']) {
    const { family, cookie } = f.issue(transition, 'owner')
    const response = await f.request(feed, { cookie })
    const proxy = f.upstreams.at(-1)
    assert.equal(proxy.options.path, feed)
    assert.equal(response.status, 200)
    assert.match(response.body, /private content/)
    const other = f.issue('other-' + transition, 'admin')
    const otherFeed = await f.request('/api/another-stream', { cookie: other.cookie })
    const otherProxy = f.upstreams.at(-1)
    const changed = transition === 'sign-out'
      ? await f.request('/_gate/sign-out-everywhere', { cookie, method: 'POST' })
      : await f.request(CLOUD_RENEW_PATH, { cookie, method: 'POST', headers: { 'content-type': 'application/json' },
        body: { version: 2, renew: true, workspace } })
    assert.equal(changed.status, 200)
    assert.equal(f.sessions.active(family), false)
    if (transition === 'demotion') {
      const current = f.sessions.authenticate(cookieSecret(changed.headers['set-cookie'].split(';', 1)[0]), origin)
      assert.deepEqual(current.principal.roles, ['member'])
    }
    assert.equal(response.destroyed, true)
    assert.equal(proxy.proxy.destroyed, true)
    assert.equal(proxy.upstream.destroyed, true)
    assert.equal(otherFeed.destroyed, false)
    assert.equal(otherProxy.upstream.destroyed, false)
    // A streaming route outside the Bot API is tracked by its own family too.
    f.sessions.revoke(other.family)
    assert.equal(otherFeed.destroyed, true)
  }
})

const form = { 'content-type': 'application/x-www-form-urlencoded' }
const startOpen = f => f.request(CLOUD_OPEN_PATH, { method: 'POST', body: 'code=new-person',
  headers: { ...form, origin: 'https://rail.invalid', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } })

test('G7 the cookie-less rail POST finishes on-origin and cuts the previous family before installing the guest', async t => {
  const f = fixture(t)
  for (const role of ['owner', 'member']) {
    const old = f.issue(role, role)
    const response = await f.request(feed.replace('.owner', '.' + role), { cookie: old.cookie })
    const proxy = f.upstreams.at(-1)
    const other = f.issue('independent', 'owner')
    const independent = await f.request(feed, { cookie: other.cookie })
    assert.match(response.body, /private content/)
    const rail = await startOpen(f)
    assert.equal(rail.status, 200)
    assert.equal(rail.headers['set-cookie'], undefined)
    assert.equal(rail.headers['clear-site-data'], undefined)
    assert.equal(response.destroyed, false)
    const open = /name="open" value="([^"]+)"/.exec(rail.body)[1]
    const complete = { cookie: old.cookie, method: 'POST', body: 'open=' + open, headers: form }
    assert.equal((await f.request(CLOUD_OPEN_FINISH_PATH, { ...complete, headers: { ...form, origin: 'https://rail.invalid' } })).status, 403)
    const finished = await f.request(CLOUD_OPEN_FINISH_PATH, complete)
    assert.equal(finished.status, 303)
    assert.equal(finished.headers['clear-site-data'], '"cache", "storage"')
    assert.equal(f.sessions.active(old.family), false)
    assert.equal(response.destroyed, true)
    assert.equal(proxy.proxy.destroyed, true)
    proxy.upstream.write('data: after replacement\n\n')
    await setImmediate()
    assert.doesNotMatch(response.body, /after replacement/)
    assert.equal(independent.destroyed, false)
    assert.deepEqual(f.sessions.authenticate(cookieSecret(finished.headers['set-cookie']), origin).principal.roles, ['guest'])
    assert.equal((await f.request(CLOUD_OPEN_FINISH_PATH, complete)).status, 401)
    f.sessions.revoke(other.family)
  }
})

test('G8 an unidentified old stream is closed, and an expired family cannot deliver another HTTP frame', async t => {
  const f = fixture(t)
  const owner = f.issue('owner', 'owner')
  const first = await f.request(feed, { cookie: owner.cookie })
  const rail = await startOpen(f)
  const open = /name="open" value="([^"]+)"/.exec(rail.body)?.[1]
  assert.ok(open)
  const finished = await f.request(CLOUD_OPEN_FINISH_PATH, { method: 'POST', body: 'open=' + open, headers: form })
  assert.equal(finished.status, 303)
  assert.equal(first.destroyed, true)
  assert.equal(f.sessions.active(owner.family), true)
  const next = await f.request(feed, { cookie: owner.cookie })
  f.setTime(60_000)
  f.upstreams.at(-1).upstream.write('data: after expiry\n\n')
  await setImmediate()
  assert.equal(next.destroyed, true)
  assert.doesNotMatch(next.body, /after expiry/)
})

test('G9 an upstream owner 401 marks credential refresh without clearing the gate family', async t => {
  const f = fixture(t, { upstreamStatus: 401 })
  const owner = f.issue('owner', 'owner')
  const response = await f.request('/api/omni-ui', { cookie: owner.cookie, method: 'POST' })
  assert.equal(response.status, 401)
  assert.equal(response.headers['x-automagik-dsh-refresh'], '1')
  assert.equal(response.headers['clear-site-data'], undefined)
  assert.deepEqual(f.invalidated, ['dsh=fixture'])
  assert.equal(f.sessions.active(owner.family), true)
  f.sessions.revoke(owner.family)
  const expired = await f.request('/api/omni-ui', { cookie: owner.cookie, method: 'POST' })
  assert.equal(expired.status, 401)
  assert.equal(expired.headers['x-automagik-dsh-refresh'], undefined)
  assert.equal(expired.headers['clear-site-data'], '"cache", "storage"')
})

test('G10 only the fixture’s viewer-bound feed target reaches the gate signer and carrier', async t => {
  const f = fixture(t)
  const { cookie, family } = f.issue('member', 'member')
  const { path, query, method } = routeFixture.targets.find(row => row.query)
  assert.equal((await f.request(path, { cookie, method })).status, 403)
  assert.equal(f.signed.length, 0)
  assert.equal(f.upstreams.length, 0)
  const target = path + query
  const dispatched = await f.request(target, { cookie, method })
  assert.equal(dispatched.status, 200, 'the stub accepted the signed dispatch')
  assert.deepEqual(f.signed, [{ principal: family.principal, familyId: family.id, method, path: target }])
  assert.equal(f.upstreams[0].options.path, '/_automagik/caller' + target)
  f.sessions.revoke(family)
})

test('G11 a mux rechecks its family before forwarding a server frame after expiry', async t => {
  const f = fixture(t)
  const screens = []
  for (const role of ['owner', 'member']) {
    const { cookie } = f.issue(role, role)
    const downstream = await f.upgrade(cookie)
    const { upstream } = f.upstreams.at(-1)
    upstream.push(Buffer.from('first frame'))
    await setImmediate()
    assert.match(downstream.output.join(''), /^HTTP\/1.1 101 [\s\S]*first frame$/)
    screens.push({ upstream, downstream })
  }
  f.setTime(60_000)
  for (const { upstream } of screens) upstream.push(Buffer.from('expired family frame'))
  await setImmediate()
  for (const { downstream } of screens) {
    assert.equal(downstream.destroyed, true)
    assert.doesNotMatch(downstream.output.join(''), /expired family frame/)
  }
})

test('G6 a rejected cross-site navigation carrying an active owner cookie leaves site data alone', async t => {
  const f = fixture(t)
  const { family, cookie } = f.issue('owner', 'owner')
  const rejected = await f.request('/', { cookie, headers: { origin: undefined, 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'cross-site' } })
  assert.equal(rejected.status, 401)
  assert.equal(rejected.headers['clear-site-data'], undefined)
  assert.equal(f.sessions.active(family), true)
  assert.deepEqual(f.upstreams, [])
  const signedOut = await f.request('/_gate/sign-out-everywhere', { cookie, method: 'POST' })
  assert.equal(signedOut.headers['clear-site-data'], '"cache", "storage"')
  const stale = await f.request('/', { cookie })
  assert.equal(stale.status, 401)
  assert.equal(stale.headers['clear-site-data'], '"cache", "storage"')
})
