import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { PassThrough, Readable, Writable } from 'node:stream'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { createGate, CLOUD_RENEW_PATH } from '../gate.mjs'
import { SessionStore, cookieSecret, sessionCookie } from '../gate-store.mjs'

const origin = 'https://workspace.invalid'
const workspace = 'workspace'
const issuer = 'https://id.invalid'
const feed = '/api/omni-ui/feed?viewer=mounted.owner'

function fixture(t) {
  const now = 1000
  const sessions = new SessionStore(undefined, { memory: true, accepts: () => true, now: () => now })
  const upstreams = []
  t.mock.method(http, 'request', (options, respond) => {
    const proxy = new Writable({ autoDestroy: false, write(_chunk, _encoding, done) { done() } })
    const upstream = new PassThrough()
    upstream.statusCode = 200
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
    origin, sessions, multiuser: true, caller: {},
    credentials: { port: 1, authority: '127.0.0.1:1', cookie: async () => 'dsh=fixture' },
    cloud: {
      config: { workspace }, drops: () => false, pollInterval: 300_000,
      renew: async principal => ({ principal: { ...principal, roles: ['member'] }, expires: 60_000 }),
    },
  })
  t.after(() => gate.emit('close'))
  function issue(subject, role) {
    const issued = sessions.issue(origin, { issuer, subject, roles: [role], workspace }, {
      expires: 60_000, proof: { aud: workspace, token: 'proof', exp: 60 },
    })
    return { ...issued, cookie: sessionCookie(issued.secret).split(';', 1)[0] }
  }
  async function request(url, { cookie, method = 'GET', headers = {}, body } = {}) {
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
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
  return { sessions, issue, request, upstreams }
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
