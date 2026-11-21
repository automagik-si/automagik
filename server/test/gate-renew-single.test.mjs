import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough, Readable } from 'node:stream'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { sessionHash } from '../gate-caller.mjs'
import { createDecisionServer } from '../gate-decisions.mjs'
import { CLOUD_OPEN_FINISH_PATH, CLOUD_OPEN_PATH, CLOUD_RENEW_PATH, createGate } from '../gate.mjs'
import { cookieSecret, SessionStore } from '../gate-store.mjs'

const origin = 'https://workspace.invalid'
const rail = 'https://rail.invalid'
const workspace = 'workspace'
const principal = (subject, roles = ['owner']) => ({
  issuer: 'https://id.invalid', subject, roles, workspace,
})
const sessionOptions = { expires: 60_000, proof: { aud: workspace, token: 'fixture', exp: 60 } }
const cookies = res => [res.headers['set-cookie']].flat().filter(Boolean)
  .map(value => value.split(';', 1)[0])

function fixture(t, multiuser) {
  const sessions = new SessionStore(undefined, {
    memory: true, accepts: () => true, now: () => 1000,
  })
  const successors = new Map()
  const calls = []
  const cloud = {
    config: { workspace, rail }, drops: () => false, pollInterval: 300_000,
    open: async subject => ({ principal: principal(subject), ...sessionOptions }),
    renew(person) {
      const call = Promise.withResolvers()
      calls.push({ ...call, accept: (roles = person.roles) => call.resolve({
        principal: { ...person, roles }, ...sessionOptions,
      }) })
      return call.promise
    },
  }
  const gate = createGate({ origin, sessions, cloud, multiuser, successors,
    caller: {}, auditAccess() {} })
  t.after(() => gate.closeGate())
  let snapshot
  const name = 'renew-' + randomBytes(8).toString('hex')
  const decisions = createDecisionServer({ origin, sessions, cloud, successors, name,
    signer: { signDecision: claims => { snapshot = claims; return 'fixture' } },
  })
  function decide(family) {
    const socket = new EventEmitter()
    socket.destroy = () => socket.emit('close')
    socket.end = (_, done) => done()
    const session = sessionHash(family.id)
    const body = JSON.stringify({ session, challenge: 'A'.repeat(22) })
    const headers = 'POST /decision HTTP/1.1\r\nHost: localhost\r\n' +
      'Content-Type: application/json\r\n'
    const request = `${headers}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
    decisions.emit('connection', socket)
    socket.emit('data', Buffer.from(request))
    assert.equal(snapshot.session, session)
    return snapshot
  }
  function request(url, { method = 'POST', cookie, type, body, source = origin } = {}) {
    const headers = { host: new URL(origin).host, origin: source }
    if (cookie) headers.cookie = cookie
    if (type) headers['content-type'] = type
    const req = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), {
      method, url, headers, rawHeaders: Object.entries(headers).flat(), socket: new EventEmitter(),
    })
    const res = new PassThrough()
    res.headers = {}
    res.body = ''
    res.setHeader = (name, value) => { res.headers[name] = value }
    res.writeHead = (status, headers) => Object.assign(res, {
      status, headers: { ...res.headers, ...headers },
    })
    res.on('data', chunk => { res.body += chunk.toString() })
    return { res, done: gate.listeners('request')[0](req, res).then(() => res) }
  }
  const form = 'application/x-www-form-urlencoded'
  async function signIn(subject, cookie) {
    const opened = await request(CLOUD_OPEN_PATH, {
      source: rail, type: form, body: `code=${subject}`,
    }).done
    if (!multiuser) return opened
    const id = /name="open" value="([^"]+)"/.exec(opened.body)?.[1]
    assert.ok(id)
    return request(CLOUD_OPEN_FINISH_PATH, { cookie, type: form, body: `open=${id}` }).done
  }
  return {
    request, signIn, calls, successors, sessions, decide,
    authenticate: cookie => sessions.authenticate(cookieSecret(cookie), origin),
    renew: cookie => request(CLOUD_RENEW_PATH, {
      cookie, type: 'application/json',
      body: JSON.stringify({ version: 2, renew: true, workspace }),
    }),
  }
}

async function start(f, cookie, number = 1) {
  const pending = f.renew(cookie)
  await setImmediate()
  assert.equal(f.calls.length, number)
  return pending
}

function refused(res, status = 401, error = 'Renewal refused') {
  assert.equal(res.status, status)
  assert.deepEqual(cookies(res), [])
  assert.deepEqual(JSON.parse(res.body), { error })
}

for (const multiuser of [false, true]) {
  const mode = `multiuser ${multiuser ? 'on' : 'off'}`
  test(`${mode}: one concurrent Cloud renewal wins, a later old cookie gets 401`, async t => {
    const f = fixture(t, multiuser)
    const cookie = cookies(await f.signIn('one')).join('; ')
    const prior = f.authenticate(cookie)
    const pending = await start(f, cookie)
    refused(await f.renew(cookie).done, 429, 'Renewal in progress')
    assert.equal(f.calls.length, 1)
    f.calls[0].accept()
    const renewed = await pending.done
    assert.equal(renewed.status, 200)
    const current = f.authenticate(cookies(renewed).join('; '))
    assert.equal(current.principal.subject, 'one')
    assert.deepEqual(f.successors.get(sessionHash(prior.id)), {
      session: sessionHash(current.id), origin, roles: ['owner'],
    })
    assert.equal(f.decide(prior).resolved, true)
    refused(await f.renew(cookie).done)
    assert.equal(f.calls.length, 1)
  })

  test(`${mode}: a Cloud refusal frees the slot and preserves the current family`, async t => {
    const f = fixture(t, multiuser)
    const cookie = cookies(await f.signIn('one')).join('; ')
    const family = f.authenticate(cookie)
    const first = await start(f, cookie)
    f.calls[0].reject(new Error('fixture refusal'))
    refused(await first.done)
    assert.equal(f.authenticate(cookie), family)
    assert.equal(f.successors.size, 0)
    assert.equal(f.decide(family).active, true)
    const next = await start(f, cookie, 2)
    f.calls[1].accept()
    assert.equal((await next.done).status, 200)
  })

  test(`${mode}: a disconnected leader leaves its retry in control of the slot`, async t => {
    const f = fixture(t, multiuser)
    const cookie = cookies(await f.signIn('one')).join('; ')
    const family = f.authenticate(cookie)
    const first = await start(f, cookie)
    first.res.destroy()
    const next = await start(f, cookie, 2)
    f.calls[0].accept()
    await first.done
    assert.equal(first.res.status, undefined)
    assert.deepEqual(cookies(first.res), [])
    assert.equal(f.authenticate(cookie), family)
    assert.equal(f.successors.size, 0)
    refused(await f.renew(cookie).done, 429, 'Renewal in progress')
    f.calls[1].accept()
    assert.equal((await next.done).status, 200)
  })

  test(`${mode}: sign-out everywhere fences a held renewal`, async t => {
    const f = fixture(t, multiuser)
    const cookie = cookies(await f.signIn('one')).join('; ')
    const family = f.authenticate(cookie)
    const pending = await start(f, cookie)
    assert.equal((await f.request('/_gate/sign-out-everywhere', { cookie }).done).status, 200)
    f.calls[0].accept()
    refused(await pending.done)
    assert.equal(f.sessions.active(family), false)
    assert.equal(f.sessions.families.length, 0)
    assert.equal(f.successors.size, 0)
    assert.equal(f.decide(family).active, false)
  })

  test(`${mode}: plain rotation fences a held renewal and its new cookie works`, async t => {
    const f = fixture(t, multiuser)
    const cookie = cookies(await f.signIn('one')).join('; ')
    const family = f.authenticate(cookie)
    const pending = await start(f, cookie)
    const rotated = await f.request('/_gate/session/renew', { cookie }).done
    assert.equal(rotated.status, 200)
    f.calls[0].accept()
    refused(await pending.done)
    assert.equal(f.successors.size, 0)
    assert.equal(f.authenticate(cookies(rotated)[0]), family)
    assert.equal(f.decide(family).resolved, false)
  })
}

test('renewal evicts the oldest successor at the 4096-entry bound', async t => {
  const f = fixture(t, true)
  const cookie = cookies(await f.signIn('one')).join('; ')
  const current = f.authenticate(cookie)
  for (let i = 0; i < 4096; i++) {
    f.successors.set(sessionHash(String(i)), {
      session: sessionHash(current.id), origin, roles: ['owner'],
    })
  }
  assert.equal(f.decide({ id: '0' }).resolved, true)
  const pending = await start(f, cookie)
  f.calls[0].accept()
  assert.equal((await pending.done).status, 200)
  assert.equal(f.successors.size, 4096)
  assert.equal(f.decide({ id: '0' }).active, false)
  assert.equal(f.decide({ id: '1' }).active, true)
})
