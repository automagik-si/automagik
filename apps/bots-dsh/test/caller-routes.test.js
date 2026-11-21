import assert from 'node:assert/strict'
import { test } from 'node:test'
import { callerEndpoint } from '../src/host/caller-policy.js'
import { REPLY_KIND } from '../src/host/constants.js'
import { allowlist, fixture, guest, identity, member, serviceStub, stranger } from './caller-fixture.js'
import inventory from './fixtures/caller-endpoints.json' with { type: 'json' }
import rolePaths from '../../../server/test/fixtures/caller-role-paths.json' with { type: 'json' }

const path = '/api/omni-ui'
const url = 'http://fixture.invalid' + path
const content = text => [{ type: 'text', text }]
const handler = f => f.ctx.get('automagikCallerRoutes').match(path, 'POST')
function post(f, principal, endpoint, payload, viewer = f.rt.viewerOf(principal).id) {
  return handler(f)(new Request(url, { method: 'POST', body: JSON.stringify({ endpoint, payload, viewer }) }), principal)
}
const read = async (...args) => (await post(...args)).json()
const absent = (f, principal, endpoint, payload) => handler(f)(new Request(url, {
  method: 'POST', body: JSON.stringify({ endpoint, payload }),
}), principal)
const extension = 'fixture-extended'
const refusalNames = [...Object.values(inventory.classes).flat(), extension, 'no-such-endpoint', 'space-bots', 'computer-shot']

test('CR1 v1 is frozen and matches only the fixture pairs when caller mode is available', async t => {
  const f = fixture(t)
  const routes = f.ctx.get('automagikCallerRoutes')
  assert.ok(Object.isFrozen(routes))
  assert.deepEqual(Object.keys(routes), ['version', 'match'])
  assert.equal(routes.version, 1)
  for (const row of rolePaths.routes) {
    assert.equal(typeof routes.match(row.path, row.method), row.decision === 'caller' ? 'function' : 'undefined')
  }
  assert.equal(routes.match(path, 'GET'), undefined)
  assert.equal(routes.match(path + '/feed', 'POST'), undefined)
  for (const service of [undefined, { version: 1, multiuser: true }, serviceStub({ multiuser: false })]) {
    await f.emitService(service)
    for (const row of rolePaths.targets) assert.equal(routes.match(row.path, row.method), undefined)
  }
})

test('CR2 the six reads succeed and all other endpoints refuse before calling the runtime', async t => {
  const f = fixture(t)
  await f.start()
  await f.open('a', allowlist)
  f.rt.hooks.endpoint(extension, () => assert.fail('extension ran'))
  const spies = [f.rt, f.ctx.sessionController, f.ctx.agents].flatMap(object =>
    Object.keys(object).filter(key => typeof object[key] === 'function').map(key => t.mock.method(object, key)))
  const route = handler(f)
  for (const principal of [member, guest]) {
    const viewer = f.rt.viewerOf(principal).id
    for (const spy of spies) spy.mock.resetCalls()
    for (const endpoint of refusalNames) {
      const { reason, message, code } = callerEndpoint(principal.person.roles[0], endpoint)
      const request = new Request(url, { method: 'POST', body: JSON.stringify({ endpoint, viewer }) })
      assert.deepEqual(await (await route(request, principal)).json(), { ok: false, error: { code, message, reason, details: {} } }, endpoint)
    }
    assert.ok(spies.every(spy => spy.mock.callCount() === 0))
    for (const endpoint of inventory.reads) assert.equal((await read(f, principal, endpoint, { id: 'a', botId: 'a' })).ok, true, endpoint)
  }
})

test('CR3 a guest sees an allowlisted Bot and cannot distinguish other Bots from unknown IDs', async t => {
  const f = fixture(t)
  await f.start()
  await f.open()
  await f.open('a', allowlist)
  const state = await read(f, guest, 'state')
  const list = await read(f, guest, 'list-bots')
  assert.deepEqual(state.value.bots.map(bot => bot.id), ['a'])
  assert.deepEqual(list.value, state.value.bots)
  const ungranted = await read(f, guest, 'get-bot', { id: 'b' })
  assert.equal(ungranted.error.code, 'bot/not-found')
  assert.deepEqual(ungranted, await read(f, guest, 'get-bot', { id: 'missing' }))
})

test('CR4 the caller projection keeps private team, card and history fields out of every read', async t => {
  const f = fixture(t, { seed: team => {
    team.bots.a.name = 'private-invisible-name'
    team.bots.a.instructions = 'private-invisible-instructions'
    team.bots.b.instructions = 'private-visible-instructions'
  } })
  await f.start()
  const part = await f.open()
  const state = f.rt.state
  for (const [key, marker] of [
    ['questions', 'private-question'], ['views', 'private-view'], ['closedCards', 'private-closed-card'],
    ['btwCards', 'private-side-card'], ['sideChats', 'private-side-chat'],
    ['notices', 'private-notice'], ['secrets', 'private-secret'],
  ]) state[key] = { marker }
  state.rooms['private-room'] = { id: 'private-room', sessionId: 'private-room-part', members: ['b'] }
  state.bots.a.people = { mode: 'owners', allow: [{ ...identity, subject: 'private-person', role: 'member' }] }
  f.event('private-room-part', 'turn/start', { turn: 1 })
  f.event('private-room-part', 'user/message', { source: { kind: 'user' }, content: content('private-room-history') })
  f.event('b', 'turn/start', { turn: 1 })
  f.event('b', 'user/message', { source: { kind: 'user' }, content: content('private-unpublished') })
  f.event(part, 'turn/start', { turn: 1 })
  f.event(part, 'user/message', { source: { kind: REPLY_KIND }, content: content('private-card-answer') })
  f.event(part, 'assistant/message', { message: { content: content('allowed-text') } })

  for (const [endpoint, payload] of [
    ['state'], ['state', { health: true }], ['list-bots'], ['get-bot', { id: 'b' }],
    ['chat', { botId: 'b' }], ['earlier', { botId: 'b', cursor: null }],
  ]) {
    const reply = await post(f, member, endpoint, payload)
    assert.equal(reply.status, 200)
    assert.equal(reply.headers.get('content-type'), 'application/json')
    assert.equal(reply.headers.get('cache-control'), 'no-store')
    const body = await reply.json()
    assert.equal(body.ok, true, endpoint)
    assert.doesNotMatch(JSON.stringify(body), /private-|people|instructions|working|lastAt|sessionId|thinking/)
    if (endpoint === 'state') assert.deepEqual(Object.keys(body.value), ['revision', 'bots', 'viewer'])
    if (endpoint === 'chat' || endpoint === 'earlier') assert.equal(body.value.items[0].text, 'allowed-text')
  }
})

test('CR5 viewer ids are stable per person and process, and missing or stale viewers refuse', async t => {
  const f = fixture(t)
  const g = fixture(t)
  await f.start()
  const load = t.mock.method(f.rt, 'load')
  const route = handler(f)
  const same = f.rt.viewerOf(member).id
  for (const name of [...inventory.reads, ...refusalNames]) {
    const different = await route(new Request(url, { method: 'POST', body: JSON.stringify({ endpoint: name, viewer: 'previous' }) }), member)
    assert.equal((await different.json()).error.code, 'bot/viewer-changed', name)
    if (name !== 'whoami') assert.equal((await (await absent(f, member, name)).json()).error.code, 'bot/viewer-changed', name)
  }
  assert.equal(load.mock.callCount(), 0)
  const first = (await (await absent(f, member, 'whoami')).json()).value
  const second = (await (await absent(f, guest, 'whoami')).json()).value
  assert.deepEqual(first, { role: 'member', identity, multiuser: true, viewer: { id: same, role: 'member' } })
  assert.equal(second.viewer.id, same)
  assert.notEqual(f.rt.viewerOf(stranger).id, same)
  assert.notEqual(g.rt.viewerOf(member).id, same)
  assert.doesNotMatch(same, /issuer|pat/)
})

test('CR6 malformed bodies and internal errors return safe responses', async t => {
  const f = fixture(t)
  await f.start()
  const route = handler(f)
  const viewer = f.rt.viewerOf(member).id
  for (const body of [
    '{', JSON.stringify({ endpoint: 'x'.repeat(65), viewer }), JSON.stringify({ endpoint: 'state', payload: [], viewer }),
    JSON.stringify({ endpoint: 'state', viewer: null }), JSON.stringify({ endpoint: 'get-bot', viewer, payload: { id: '' } }),
    JSON.stringify({ endpoint: 'earlier', viewer, payload: { botId: 'b', cursor: 1 } }),
  ]) {
    const reply = await route(new Request(url, { method: 'POST', body }), member)
    assert.equal((await reply.json()).error.code, 'bot/invalid')
  }
  const projected = t.mock.method(f.rt, 'callerBots', () => { throw new TypeError('private /path') })
  assert.deepEqual((await read(f, member, 'list-bots')).error, { code: 'bot/internal', message: 'Something went wrong.', details: {} })
  assert.match(f.warnings.at(-1), /TypeError/)
  assert.doesNotMatch(f.warnings.at(-1), /private|\/path/)
  projected.mock.restore()
  t.mock.method(f.rt, 'readOnly', () => 'lock lost')
  assert.equal((await read(f, member, 'state')).error.code, 'bot/read-only')
})

test('CR7 the only gated boot data is the role for the index Peer', async t => {
  const f = fixture(t)
  function rows(principal) {
    const table = []
    for (const listener of f.ctx.listeners.get('webserver/index-inject')) listener(table, { principal })
    return table
  }
  for (const [principal, role] of [
    [{ kind: 'owner' }, 'owner'], [member, 'member'], [guest, 'guest'],
    [{ kind: 'automagik', person: { roles: [] } }, 'none'], [undefined, 'none'],
  ]) assert.deepEqual(rows(principal), [{ kind: 'global', name: '__AUTOMAGIK_VIEW__', value: { version: 1, role } }])
  for (const service of [undefined, { version: 1 }, serviceStub({ multiuser: false })]) {
    await f.emitService(service)
    assert.deepEqual(rows(member), [])
  }
})

test('CR8 gated owner whoami uses the gate principal and rejects stale requests before dispatch', async t => {
  const f = fixture(t)
  await f.start()
  const headers = subject => ({ 'x-automagik-principal': Buffer.from(JSON.stringify({ ...identity, subject, roles: ['admin'] })).toString('base64url') })
  const first = (await f.call('whoami', null, { headers: headers('first') })).value
  const second = (await f.call('whoami', null, { headers: headers('second') })).value
  assert.deepEqual(first, { role: 'owner', multiuser: true, viewer: { id: first.viewer.id, role: 'admin' } })
  assert.notEqual(first.viewer.id, second.viewer.id)
  const refresh = t.mock.method(f.rt, 'refresh')
  assert.equal((await f.call('state', null, { headers: headers('second'), viewer: first.viewer.id })).error.code, 'bot/viewer-changed')
  assert.equal(refresh.mock.callCount(), 0)
  assert.deepEqual((await f.call('whoami')).value.viewer, { id: 'local', role: 'owner' })
  await f.emitService(undefined)
  assert.equal((await f.call('state')).ok, true)
  assert.equal((await f.call('whoami')).ok, false)
})

test('CR9 adapter teardown keeps the configured owner boot gated and closes calls from a mounted owner tab', async t => {
  const f = fixture(t)
  await f.start()
  const previous = process.env.AUTOMAGIK_MULTIUSER
  process.env.AUTOMAGIK_MULTIUSER = '1'
  t.after(() => {
    if (previous === undefined) delete process.env.AUTOMAGIK_MULTIUSER
    else process.env.AUTOMAGIK_MULTIUSER = previous
  })
  const headers = subject => ({ 'x-automagik-principal': Buffer.from(JSON.stringify({ ...identity, subject, roles: ['owner'] })).toString('base64url') })
  const viewer = (await f.call('whoami', null, { headers: headers('first') })).value.viewer.id
  let dispatched = 0
  f.rt.hooks.endpoint('queued-owner-action', () => { dispatched++; return true })
  await f.emitService(undefined)
  const switched = await f.call('queued-owner-action', null, { headers: headers('second'), viewer })
  assert.equal(switched.ok, false)
  assert.equal(switched.error.code, 'bot/viewer-changed')
  assert.equal((await f.postOwner('queued-owner-action', null, { headers: headers('first'), viewer })).status, 503)
  assert.equal((await f.postOwner('whoami', null, { headers: headers('first') })).status, 503)
  const table = []
  for (const inject of f.ctx.listeners.get('webserver/index-inject')) inject(table, { principal: { kind: 'owner' } })
  assert.deepEqual(table, [{ kind: 'global', name: '__AUTOMAGIK_VIEW__', value: { version: 1, role: 'owner' } }])
  assert.equal(dispatched, 0)
  await f.emitService(f.service)
  assert.equal((await f.call('queued-owner-action', null, { headers: headers('first'), viewer })).ok, true)
  assert.equal(dispatched, 1)
})
