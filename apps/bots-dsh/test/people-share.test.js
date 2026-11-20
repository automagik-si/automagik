import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allowlist, fixture, member, owners, serviceStub, stranger, workspace } from './caller-fixture.js'

const empty = { mode: 'allowlist', allow: [] }
const edit = (f, people, expect) => f.call('update-bot', { id: 'b', people, expect })

test('PS1 people-share returns committed settings as share status changes and refuses off mode', async t => {
  const f = fixture(t)
  await f.start()
  assert.deepEqual((await f.call('people-share', { id: 'b' })).value, { state: null, people: owners })
  assert.equal((await f.call('people-share', { id: 'unknown' })).error.code, 'bot/not-found')
  const held = Promise.withResolvers()
  const started = Promise.withResolvers()
  const fresh = f.rt.startFresh.bind(f.rt)
  const stub = t.mock.method(f.rt, 'startFresh', async (...args) => {
    started.resolve()
    await held.promise
    return fresh(...args)
  })
  const opening = f.rt.setPeople('b', workspace)
  await started.promise
  assert.deepEqual((await f.call('people-share', { id: 'b' })).value, { state: 'opening', people: workspace })
  held.resolve()
  await opening
  await f.finishSwitch()
  assert.deepEqual((await f.call('people-share', { id: 'b' })).value, { state: 'open', people: workspace })
  stub.mock.restore()
  await f.rt.setPeople('b', owners)
  t.mock.method(f.rt, 'startFresh', () => { throw new Error('fixture failure') })
  await assert.rejects(f.rt.setPeople('b', workspace), /fixture failure/)
  assert.deepEqual((await f.call('people-share', { id: 'b' })).value, { state: 'spoiled', people: workspace })
  await f.emitService(serviceStub({ multiuser: false }))
  assert.equal((await f.call('people-share', { id: 'b' })).error.code, 'bot/refused')
})

test('PS2 saving an empty allowlist or removing the last person withdraws access in one action', async t => {
  const f = fixture(t)
  await f.start()
  await f.open()
  const visible = () => f.service.visibleBotIds(member).has('b')
  assert.equal(visible(), true)
  assert.equal((await edit(f, empty, workspace)).ok, true)
  assert.deepEqual(f.saved().bots.b.people, empty)
  assert.equal(visible(), false)
  assert.equal((await edit(f, allowlist, empty)).ok, true)
  assert.equal(visible(), true)
  assert.equal((await edit(f, empty, allowlist)).ok, true)
  assert.equal(visible(), false)
  assert.deepEqual(f.saved().bots.b.people, empty)
})

test('PS3 a stale widening cannot restore a removed person, and stale narrowing still saves', async t => {
  const service = serviceStub()
  const seen = service.seen
  service.seen = () => [...seen(), { ...stranger.person, lastSeen: Date.now() }]
  const f = fixture(t, { service })
  await f.start()
  await f.open('b', allowlist)
  assert.equal((await edit(f, empty, allowlist)).ok, true)
  const added = { issuer: stranger.person.issuer, subject: stranger.person.subject, role: 'guest' }
  assert.equal((await edit(f, { ...allowlist, allow: [...allowlist.allow, added] }, allowlist)).error.code, 'bot/stale')
  assert.deepEqual(f.saved().bots.b.people, empty)
  for (const principal of [member, stranger]) assert.equal(f.service.visibleBotIds(principal).has('b'), false)
  assert.equal((await edit(f, owners, allowlist)).ok, true)
  assert.deepEqual(f.saved().bots.b.people, owners)
})
