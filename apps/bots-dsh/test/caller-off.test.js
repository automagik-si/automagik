import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SOURCE_KIND } from '../src/host/constants.js'
import { RESUME_DELAY_MS } from '../src/host/resume.js'
import { allowlist, code, fixture, member, serviceStub, workspace } from './caller-fixture.js'

test('O1 off mode leaves owner operations and stored people alone', async t => {
  // The restart pass runs RESUME_DELAY_MS after the start and adds its daily resume counts to the
  // team state (restartResumes). Run it at once and before the key snapshot below, or a run slower
  // than that delay takes it in the middle and the saved keys change for a reason that is not multiuser.
  const timer = setTimeout
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => timer(callback, ms === RESUME_DELAY_MS ? 0 : ms, ...args))
  for (const service of [null, serviceStub({ multiuser: false })]) {
    const planted = { mode: 'workspace', allow: [{ role: 'guest', subject: 'old', issuer: 'old-idp' }] }
    let initialSave
    const f = fixture(t, {
      service, seed: team => { team.bots.b.people = planted },
      beforeLoad: rt => { initialSave = t.mock.method(rt, 'save') },
    })
    await f.start()
    let bound
    await Promise.race([f.rt.resumesDone, new Promise(resolve => { bound = timer(resolve, 5_000) })])
    clearTimeout(bound)
    assert.equal(f.rt.resumeBootPending(), false)
    assert.equal(f.rt.hostAuthority, undefined)
    assert.equal(initialSave.mock.calls.filter(call => call.arguments[0]?.required).length, 0)
    assert.equal(service?.hasProvider() ?? false, false)
    const published = t.mock.method(f.rt, 'publishPart')
    const closed = t.mock.method(f.rt, 'closePart')
    // The pass keeps its notes in memory until the next save: save once so the snapshot is the team after the start.
    await f.rt.save()
    const initialKeys = Object.keys(f.saved()).sort()
    const grant = JSON.stringify(f.saved().bots.b.people)
    const created = await f.call('create-bot', { name: 'New Bot', model: 'deepseek/v4' })
    assert.equal(created.ok, true, JSON.stringify(created))
    assert.equal(Object.hasOwn(f.saved().bots[created.value.id], 'people'), false)
    assert.equal((await f.call('update-bot', { id: 'b', role: 'Editor', instructions: 'Write a draft' })).ok, true)
    assert.equal((await f.call('set-main', { id: 'b', main: true })).ok, true)
    assert.equal((await f.call('chat', { botId: 'b' })).ok, true)
    assert.equal((await f.call('bot-fresh', { id: 'b' })).ok, true)
    await f.finishSwitch()
    const fresh = f.rt.chatOf('b')
    assert.notEqual(fresh, 'b')
    assert.equal((await f.call('bot-new-part', { botId: 'b' })).ok, true)
    await f.finishSwitch()
    assert.notEqual(f.rt.chatOf('b'), fresh)
    assert.equal((await f.call('bot-open-part', { botId: 'b', sessionId: 'b' })).ok, true)
    assert.equal(f.rt.chatOf('b'), 'b')
    f.event('b', 'turn/start', { turn: 1 })
    f.event('b', 'user/message', { source: { kind: SOURCE_KIND, role: 'request', exchangeId: 'relay' } })
    assert.deepEqual(f.rt.state.exchangeTurns.b, [1])
    await f.rt.save()
    assert.equal(JSON.stringify(f.saved().bots.b.people), grant)
    assert.deepEqual(Object.keys(f.saved()).sort(), initialKeys)
    await f.edit(next => { next.bots.b.people = allowlist })
    assert.deepEqual(f.rt.botOf('b').people, allowlist)
    assert.deepEqual(f.saved().bots.b.people, allowlist)
    assert.equal(published.mock.callCount(), 0)
    assert.equal(closed.mock.callCount(), 0)
    assert.equal((await f.call('people-seen')).error.code, 'bot/refused')
    await assert.rejects(f.rt.setPeople('b', workspace), code('refused'))
    assert.throws(() => f.rt.callerBots(member), code('not-found'))
    assert.throws(() => f.rt.callerBot(member, 'b'), code('not-found'))
    await assert.rejects(f.rt.callerChat(member, 'b'), code('not-found'))
  }
})

test('A9 v1 still carries its principal and leaves a planted grant inert', async t => {
  const service = { version: 1, multiuser: true, current: () => member, provide() { assert.fail('v1 provider registered') } }
  const f = fixture(t, { service, seed: team => { team.bots.b.people = workspace } })
  await f.start()
  assert.deepEqual(f.saved().bots.b.people, workspace)
  assert.equal(f.rt.hostAuthority, undefined)
  assert.deepEqual(f.readable(), [])
  await assert.rejects(f.rt.setPeople('b', workspace), code('refused'))
})
