import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createIdentityReaders } from '../src/host/identity.js'
import { CLAUDE, nativeWorld, person } from './fixtures/managed-native-world.js'

test('a team registration keeps the hidden setting out even after the reader is removed', () => {
  const readers = createIdentityReaders(() => {})
  assert.equal(readers.everRegistered?.(), false)
  const dispose = readers.register(() => undefined)
  assert.equal(readers.everRegistered?.(), true)
  dispose()
  assert.equal(readers.everRegistered?.(), true)
})

for (const hidden of [true, { Ada: true }]) {
  test(`managed Claude ignores hidden config ${JSON.stringify(hidden)}`, async t => {
    const w = nativeWorld(t, { identity: () => ({ name: 'Ada' }), hidden })
    await w.chat('ada').turn('hi')
    w.assertToolset(0, false)
  })
}

test('the managed hidden setting stays ignored when the identity reader throws', async t => {
  const w = nativeWorld(t, { hidden: true, identity() { throw new Error('test reader failure') } })
  await w.chat('ada').turn('hi')
  w.assertToolset(0, false)
})

test('ordinary turns share the same native process and read the switch once', async t => {
  let reads = 0
  const w = nativeWorld(t, { identity: () => ({ name: 'Ada', get nativeTools() { reads++; return true } }) })
  const chat = w.chat('ada')
  await chat.turn('hello')
  w.assertToolset(0, true)
  assert.equal(reads, 1)
  const run = w.adapter.live.get('ada').run
  await chat.turn('next question')
  assert.equal(w.events('new-session').length, 1)
  assert.equal(w.adapter.live.get('ada').run, run)
  assert.equal(reads, 1)
})

test('switching ON does not change an already running DSH toolset', async t => {
  let on = false
  let reads = 0
  const w = nativeWorld(t, { identity: () => ({ name: 'Ada', get nativeTools() { reads++; return on } }) })
  const chat = w.chat('ada')
  await chat.turn('first answer')
  w.assertToolset(0, false)
  const process = w.adapter.live.get('ada').run
  on = true
  await chat.turn('second answer')
  assert.equal(w.adapter.live.get('ada').run, process)
  assert.equal(w.events('new-session').length, 1)
  assert.equal(reads, 1)
})

test('a running native process retires when eligibility is lost', async t => {
  let blocked = false
  let reads = 0
  const w = nativeWorld(t, { identity: () => ({
    name: 'Ada', get nativeTools() { reads++; return !blocked }, nativeToolsBlocked: blocked,
  }) })
  const chat = w.chat('ada')
  await chat.turn('first answer')
  w.assertToolset(0, true)
  const current = w.adapter.live.get('ada').run
  blocked = true
  await chat.turn('after a share is mounted')
  w.assertToolset(1, false)
  await current.gone.catch(() => {})
  assert.equal(current.alive, false)
  assert.equal(reads, 1)
})

test('an unreadable sandbox level gives the DSH toolset', async t => {
  const w = nativeWorld(t, { identity: () => ({ name: 'Ada', nativeTools: true }) })
  delete w.services.sandboxPolicy
  await w.chat('ada').turn('hello')
  w.assertToolset(0, false)
})

test('a fresh Claude process replaying answered history in the same current chat starts OFF', async t => {
  const w = nativeWorld(t, { identity: () => ({ name: 'Ada', nativeTools: true }) })
  const chat = w.chat('ada')
  await chat.turn(person('first question'))
  w.adapter.endSession('ada')
  await chat.turn(person('bridge read'))
  assert.match(w.events('prompt').at(-1).text, /chat so far/)
  assert.deepEqual(w.events('new-session').map(row => row.meta.disableBuiltInTools), [false, true])
  w.assertToolset(1, false)
  assert.deepEqual(w.executed, ['read'])
})

test('Read only entered during process preparation reaches the first session/new', async t => {
  const w = nativeWorld(t, { hidden: true, identity: () => ({ name: 'Ada', nativeTools: true }) })
  const chat = w.chat('ada')
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const prepare = w.claude.spawn
  w.claude.spawn = async () => {
    entered.resolve()
    await release.promise
    return prepare()
  }
  const answer = chat.turn('hello')
  await entered.promise
  assert.equal(w.adapter.live.get('ada')?.run, undefined)
  assert.equal(w.events('new-session').length, 0)
  chat.session.append('sandbox/mode', { mode: 'read-only' })
  release.resolve()
  await answer
  assert.equal(w.adapter.live.get('ada').provider, CLAUDE)
  w.assertToolset(0, false)
})

const freshRelayText = [
  '[Handoff · part 2]',
  'The user started a fresh conversation (part 2) in your own chat. This message is not from the user.',
  'Nothing from earlier parts is carried over, on purpose: start from your instructions and your tools as they are now, not from what an earlier conversation concluded about them.',
  'Earlier parts stay saved; read_own_chat finds them if the user refers to something said there.',
  'Nothing needs an answer now; wait for the next message.',
].join('\n')
const ack = 'Noted. I have my handoff note and carry on from here.'
const sourced = (text, source) => ({ ...person(text), source })
const freshRelay = (text = freshRelayText) => sourced(text, { kind: 'bot', form: 'relay', role: 'handoff', handoff: true })
const timeContext = () => sourced('Current time.', { kind: 'time-context', form: 'snapshot' })
const openingContext = () => [
  sourced('Runtime context for a plain ACP reply.', { kind: 'runtime-context', form: 'snapshot' }),
  sourced('Available skills.', { kind: 'skill-catalog', form: 'catalog' }),
  timeContext(),
]
const openingHistory = () => [
  freshRelay(),
  ...openingContext(),
  { role: 'assistant', source: { kind: 'model', provider: CLAUDE, model: 'default' }, content: [{ type: 'text', text: ack }] },
]
const enabledIdentity = () => ({ name: 'Ada', nativeTools: true })
const flags = w => w.events('new-session').map(row => row.meta.disableBuiltInTools)
const promptPids = w => w.events('prompt').map(row => row.pid)
const launchPids = w => w.events('new-session').map(row => row.pid)

test('R1 an owner prompt after the fixed handoff ACK starts the first Claude process ON', async t => {
  const w = nativeWorld(t, { identity: enabledIdentity })
  const chat = w.chat('direct')
  chat.history.push(...openingHistory())
  assert.deepEqual(launchPids(w), [])
  const owner = 'Teste automático (1564-A): plain owner direct Electron'
  const answer = await chat.turn(person(owner))
  assert.deepEqual(answer.at(-1).reason, { kind: 'stop' })
  assert.equal(w.events('prompt').length, 1)
  assert.deepEqual(promptPids(w), launchPids(w))
  assert.ok(w.events('prompt')[0].text.includes(owner))
  assert.ok(w.events('prompt')[0].text.includes(ack))
  t.diagnostic(JSON.stringify({ flags: flags(w), launchPids: launchPids(w), promptPids: promptPids(w) }))
  assert.deepEqual(flags(w), [false])
  w.assertToolset(0, true)
})

test('B1/R2 the owner replaces a live OFF Claude that answered only the fresh relay', async t => {
  const w = nativeWorld(t, { identity: enabledIdentity })
  const chat = w.chat('direct')
  const startup = await chat.turn(freshRelay(), CLAUDE, openingContext())
  assert.deepEqual(startup.at(-1).reason, { kind: 'stop' })
  w.assertToolset(0, false)
  const off = w.adapter.live.get('direct').run
  const owner = await chat.turn('owner after the relay')
  assert.deepEqual(owner.at(-1).reason, { kind: 'stop' })
  t.diagnostic(JSON.stringify({ flags: flags(w), launchPids: launchPids(w), promptPids: promptPids(w) }))
  assert.deepEqual(flags(w), [true, false])
  assert.deepEqual(promptPids(w), launchPids(w))
  const [offPid, onPid] = launchPids(w)
  assert.notEqual(offPid, onPid)
  await off.gone.catch(() => {})
  assert.equal(off.alive, false)
  assert.match(w.events('prompt')[1].text, /The chat so far, before this new/)
  w.assertToolset(1, true)
})

test('B2 a scheduled turn retires a live ON process and prompts an OFF process', async t => {
  const w = nativeWorld(t, { identity: enabledIdentity })
  const chat = w.chat('direct')
  await chat.turn('owner')
  await chat.turn(sourced('plain: reminder', { kind: 'schedule' }))
  assert.deepEqual(flags(w), [false, true])
  assert.deepEqual(promptPids(w), launchPids(w))
})

test('C1 a carried newPart package and answer leave the owner process OFF', async t => {
  const w = nativeWorld(t, { identity: enabledIdentity })
  const chat = w.chat('direct')
  const carried = freshRelay('[Handoff · part 2]\nOmni moved your own chat with the user on to a fresh conversation, part 2, because a fresh conversation was started. This message is not from the user.\n\n## Latest messages (oldest first)\n[part 1 #3] scheduled: check the calendar')
  chat.history.push(carried, ...openingHistory().slice(1))
  await chat.turn('owner')
  assert.deepEqual(flags(w), [true])
})

for (const [name, source] of [
  ['C2 a scheduler', { kind: 'schedule' }],
  ['C3 another Bot', { kind: 'bot', form: 'relay', role: 'request', senderName: 'Other' }],
]) {
  test(`${name} after the fresh handoff ACK opens OFF`, async t => {
    const w = nativeWorld(t, { identity: enabledIdentity })
    const chat = w.chat('direct')
    chat.history.push(...openingHistory())
    await chat.turn(sourced('plain: request', source))
    assert.deepEqual(flags(w), [true])
  })
}

test('C4 a restart after an answered owner turn replays history with Claude OFF', async t => {
  const w = nativeWorld(t, { identity: enabledIdentity })
  const chat = w.chat('direct')
  chat.history.push(...openingHistory())
  await chat.turn('first owner turn')
  w.adapter.endSession('direct')
  await chat.turn('second owner turn')
  assert.deepEqual(flags(w).slice(1), [true])
  assert.match(w.events('prompt')[1].text, /chat so far/)
})

test('C5 an explicit OFF switch stays OFF after the opening', async t => {
  const w = nativeWorld(t, { identity: () => ({ name: 'Ada', nativeTools: false }) })
  const chat = w.chat('direct')
  chat.history.push(...openingHistory())
  await chat.turn('owner')
  assert.deepEqual(flags(w), [true])
})

test('C6 Read only stays OFF after the opening', async t => {
  const w = nativeWorld(t, { identity: enabledIdentity })
  const chat = w.chat('direct')
  chat.session.append('sandbox/mode', { mode: 'read-only' })
  chat.history.push(...openingHistory())
  await chat.turn('owner')
  assert.deepEqual(flags(w), [true])
})

for (const [name, change] of [
  ['extra text', opening => { opening[0].content[0].text += '\nOne more line.' }],
  ['a trailing newline', opening => { opening[0].content[0].text += '\n' }],
  ['an extra text block', opening => { opening[0].content.push({ type: 'text', text: 'Another block.' }) }],
  ['an extra user row', opening => { opening.splice(1, 0, person('an earlier user input')) }],
  ['another relay', opening => { opening.splice(1, 0, freshRelay()) }],
  ['a mismatched part number', opening => { opening[0].content[0].text = freshRelayText.replace('(part 2)', '(part 3)') }],
  ['group wording', opening => { opening[0].content[0].text = freshRelayText.replace('your own chat', 'the group chat "Group"') }],
  ...Object.entries({ resume: true, joined: ['another input'], principal: 'visitor' }).map(([key, value]) => [
    `a relay with ${key}`, opening => { opening[0].source[key] = value },
  ]),
]) {
  test(`C7 a handoff with ${name} does not exempt answered history`, async t => {
    const w = nativeWorld(t, { identity: enabledIdentity })
    const chat = w.chat('direct')
    const opening = structuredClone(openingHistory())
    change(opening)
    chat.history.push(...opening)
    await chat.turn('owner')
    assert.deepEqual(flags(w), [true])
  })
}

test('C8 a resumed relay with the owner source opens OFF', async t => {
  const w = nativeWorld(t, { identity: enabledIdentity })
  const chat = w.chat('direct')
  await chat.turn(sourced('plain: resumed handoff carrying earlier messages', { kind: 'user', handoff: true, resume: true }))
  assert.deepEqual(flags(w), [true])
})

for (const [name, history] of [
  ['C9 in a fresh chat', () => []],
  ['C9b after the handoff ACK', openingHistory],
]) {
  test(`${name} an owner turn with a time-context refresh starts ON`, async t => {
    const w = nativeWorld(t, { identity: enabledIdentity })
    const chat = w.chat('direct')
    chat.history.push(...history(), timeContext())
    await chat.turn('owner')
    assert.deepEqual(flags(w), [false])
  })
}

test('a time-context refresh on an owner turn keeps the live ON process', async t => {
  let reads = 0
  const w = nativeWorld(t, { identity: () => ({ name: 'Ada', get nativeTools() { reads++; return true } }) })
  const chat = w.chat('direct')
  await chat.turn('first owner turn')
  w.assertToolset(0, true)
  const run = w.adapter.live.get('direct').run
  await chat.turn(person('plain: second owner turn'), CLAUDE, [timeContext()])
  t.diagnostic(JSON.stringify({ flags: flags(w), launchPids: launchPids(w), promptPids: promptPids(w), reads }))
  assert.deepEqual(flags(w), [false])
  const [pid] = launchPids(w)
  assert.deepEqual(promptPids(w), [pid, pid])
  assert.equal(w.adapter.live.get('direct').run, run)
  assert.equal(reads, 1)
})
