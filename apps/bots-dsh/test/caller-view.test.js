import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CALLER_BOT_KEYS, closesPart } from '../src/host/caller-view.js'
import { REPLY_KIND, SOURCE_KIND } from '../src/host/constants.js'
import { SKILL_ACTIVITY, SKILL_ACTIVITY_RECORD } from '../src/shared/skill-activity.js'
import { allowlist, code, fixture, guest, member, owners, stranger } from './caller-fixture.js'

const page = value => Buffer.from(JSON.stringify(value)).toString('base64url')
const text = text => ({ type: 'text', text })
const say = (f, part, turn, line) => {
  f.event(part, 'turn/start', { turn })
  f.event(part, 'user/message', { source: { kind: 'user' }, content: [text(line)] })
}

test('V1 grants and look keys are projected independently of the principal’s other families', async t => {
  const f = fixture(t, { seed: team => {
    team.bots.b.avatar = { shape: 'star', unknown: 'private' }
  } })
  await f.start()
  await f.open()
  await f.open('a', allowlist)
  assert.deepEqual(f.rt.callerBots(stranger), [])
  assert.deepEqual(f.rt.callerBots(guest).map(row => row.id), ['a'])
  assert.deepEqual(f.rt.callerBots(member).map(row => row.id), ['a', 'b'])
  for (const bot of f.rt.callerBots(member)) assert.deepEqual(Object.keys(bot), CALLER_BOT_KEYS)
  assert.deepEqual(CALLER_BOT_KEYS, ['id', 'name', 'role', 'color', 'kind', 'avatar', 'main'])
  assert.deepEqual(f.rt.callerBot(member, 'b').avatar, { shape: 'star' })
  assert.equal(f.rt.callerBot(member, 'a').main, true)
})

test('V2 the serialized page has only the allowed user and assistant text fields', async t => {
  const f = fixture(t)
  await f.start()
  const part = await f.open()
  f.event(part, 'turn/start', { turn: 1 })
  const user = f.event(part, 'user/message', { source: { kind: 'user', via: 'private-via' },
    content: [text('owner message'), { type: 'image', attachment: { attachmentId: 'private-image' } }] })
  for (const content of ['private-selected private-custom', 'private-view-title private-values', 'private-reason private-note']) {
    f.event(part, 'user/message', { source: { kind: REPLY_KIND }, content: [text(content)] })
  }
  f.event(part, 'user/message', { source: { kind: 'user', handoff: true }, content: [text('private-package')] })
  f.event(part, 'tool/call', { name: 'ask_user', arguments: { private: 'private-card' } })
  f.event(part, 'tool/call', { name: 'show_view', args: { title: 'private-view' } })
  f.event(part, 'tool/result', { content: [text('private-result')] })
  const bot = f.event(part, 'assistant/message', { message: { content: [text('Bot answer'), text(' '), { type: 'thinking', text: 'private-thinking' }] } })
  say(f, part, 2, 'private-hidden-user')
  f.event(part, 'assistant/message', { message: { content: [text('private-hidden-answer')] } })
  f.rt.state.exchangeTurns[part] = [2]
  const result = await f.rt.callerChat(member, 'b')
  assert.doesNotMatch(JSON.stringify(result), /private-/)
  assert.deepEqual(result, { cursor: null, items: [
    { kind: 'user', text: 'owner message', time: user.time, seq: user.seq, turn: 1, images: 1 },
    { kind: 'bot', text: 'Bot answer', time: bot.time, seq: bot.seq, turn: 1 },
  ] })
})

test('V3 unknown and invisible Bot reads return the same error', async t => {
  const f = fixture(t)
  await f.start()
  for (const id of ['b', 'missing']) {
    const error = { ...code('not-found'), message: 'Unknown Bot' }
    assert.throws(() => f.rt.callerBot(guest, id), error)
    await assert.rejects(f.rt.callerChat(guest, id), error)
  }
})

test('member and guest pages return settled skill names only while their chat remains readable', async t => {
  const f = fixture(t)
  await f.start()
  const part = await f.open('a', allowlist)
  const named = (name, turn, extra) => {
    const event = f.event(part, SKILL_ACTIVITY_RECORD, { id: `private-${name}`, name, turn, step: 0, ...extra }, { notify: false })
    event.ignorable = true
  }
  named('mint', 1)
  named('hidden', 2)
  named('elsewhere', 1, { roomId: 'wrong-room' })
  f.rt.state.exchangeTurns[part] = [2]
  for (const viewer of [member, guest]) {
    const result = await f.rt.callerChat(viewer, 'a')
    assert.deepEqual(result.items.map(({ kind, name }) => [kind, name]), [[SKILL_ACTIVITY, 'mint']])
    assert.doesNotMatch(JSON.stringify(result), /private-|hidden|elsewhere|wrong-room/)
  }
  await assert.rejects(f.rt.callerChat(stranger, 'a'), code('not-found'))
  const entered = Promise.withResolvers()
  const resume = Promise.withResolvers()
  const read = f.ctx.sessionController.events
  t.mock.method(f.ctx.sessionController, 'events', async (...args) => {
    entered.resolve()
    await resume.promise
    return read(...args)
  })
  const pending = f.rt.callerChat(guest, 'a')
  await entered.promise
  await f.rt.setPeople('a', owners)
  resume.resolve()
  await assert.rejects(pending, code('not-found'))
})

test('V4 the requested part is rechecked at completion', async t => {
  const f = fixture(t)
  await f.start()
  const first = await f.open()
  await f.rt.startFresh('b')
  await f.finishSwitch()
  const second = f.rt.chatOf('b')
  say(f, second, 1, 'requested')
  let hold, entered
  const read = f.ctx.sessionController.events
  t.mock.method(f.ctx.sessionController, 'events', async (...args) => {
    entered.resolve(args[0].address.sessionId)
    await hold.promise
    return read(...args)
  })
  for (const unshare of [false, true]) {
    hold = Promise.withResolvers()
    entered = Promise.withResolvers()
    const request = f.rt.callerChat(member, 'b')
    assert.equal(await entered.promise, second)
    if (unshare) await f.rt.setPeople('b', owners)
    else f.rt.closePart(first, 'relay')
    hold.resolve()
    if (unshare) await assert.rejects(request, code('not-found'))
    else assert.equal((await request).items.at(-1).text, 'requested')
  }
})

test('V5 cursors walk the same page and then cross to the previous readable part', async t => {
  const f = fixture(t)
  await f.start()
  const first = await f.open()
  say(f, first, 1, 'first')
  await f.rt.startFresh('b')
  await f.finishSwitch()
  const second = f.rt.chatOf('b')
  say(f, second, 1, 'second start')
  for (let i = 0; i < 62; i++) f.event(second, 'assistant/message', { message: { content: [text('response ' + i)] } })
  const latest = await f.rt.callerChat(member, 'b')
  assert.equal(latest.items.length, 60)
  assert.equal(latest.cursor, page({ part: 1, beforeSeq: latest.items[0].seq }))
  const earlier = await f.rt.callerChat(member, 'b', latest.cursor)
  assert.equal(earlier.items[0].kind, 'divider')
  assert.equal(earlier.items[1].text, 'second start')
  assert.equal(earlier.cursor, page({ part: 0 }))
  assert.equal((await f.rt.callerChat(member, 'b', earlier.cursor)).items[0].text, 'first')
  for (const cursor of [4, '', '*', 'x'.repeat(257), page(null), page({ part: '0' }), page({ part: 0, field: 4 }), page({ part: 0, beforeSeq: -1 })]) {
    await assert.rejects(f.rt.callerChat(member, 'b', cursor), { ...code('invalid'), message: 'Bad page' })
  }
})

test('V6 reading an archived part makes no warm Agent or tool call', async t => {
  const f = fixture(t)
  await f.start()
  const first = await f.open()
  say(f, first, 1, 'archived')
  await f.rt.startFresh('b')
  await f.finishSwitch()
  assert.ok(f.archived.includes(first))
  f.agents.delete(first)
  const unexpected = () => assert.fail('cold caller read made an Agent call')
  for (const [object, method] of [[f.rt, 'resolveAgent'], [f.ctx.sessionController, 'resolveAgent'], [f.ctx.agents, 'resume'], [f.rt, 'hideBotUnusedTools']]) {
    object[method] = unexpected
  }
  assert.equal((await f.rt.callerChat(member, 'b', page({ part: 0 }))).items[0].text, 'archived')
})

test('V7 a reading host refuses all three reads', async t => {
  const f = fixture(t)
  await f.start()
  f.rt.readOnly = () => 'held by another host'
  assert.throws(() => f.rt.callerBots(member), code('read-only'))
  assert.throws(() => f.rt.callerBot(member, 'b'), code('read-only'))
  await assert.rejects(f.rt.callerChat(member, 'b'), code('read-only'))
})

test('V8 no turn is inferred farther back than twenty pages', async t => {
  const f = fixture(t)
  await f.start()
  const part = await f.open()
  say(f, part, 1, 'out of range')
  for (let i = 0; i < 60 * 21; i++) {
    f.event(part, 'assistant/message', { message: { content: [text('unresolved')] } }, { notify: false })
  }
  assert.deepEqual((await f.rt.callerChat(member, 'b')).items, [])
  assert.equal(f.reads.length, 21)
  assert.deepEqual(f.verificationReads, [part])
})

// #2061: the outgoing agent's handoff-note request before an agent switch is Omni's own, hidden
// turn; it never closes a shared Bot's caller part.
test('a handoff-note request closes no caller part', () => {
  const request = role => ({ type: 'user/message', data: { source: { kind: SOURCE_KIND, form: 'relay', role, exchangeId: 'e1' } } })
  assert.equal(closesPart(request('handoff-note')), false)
  assert.equal(closesPart(request('request')), true)
})
