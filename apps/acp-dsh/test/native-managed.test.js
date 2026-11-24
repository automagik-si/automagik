import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAssistantMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { createIdentityReaders } from '../src/host/identity.js'
import { turnStart } from '../src/host/switch.js'
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

// #1564 follow-up (A13): reuse confirms the saved switch still reads ON, once (fail closed).
test('ordinary turns share the same native process, confirming the switch once on reuse', async t => {
  let reads = 0
  const w = nativeWorld(t, { identity: () => ({ name: 'Ada', get nativeTools() { reads++; return true } }) })
  const chat = w.chat('ada')
  await chat.turn('hello')
  w.assertToolset(0, true)
  assert.equal(reads, 2)
  const run = w.adapter.live.get('ada').run
  await chat.turn('next question')
  assert.equal(w.events('new-session').length, 1)
  assert.equal(w.adapter.live.get('ada').run, run)
  assert.equal(reads, 3)
})

// E3-b: a live ON process whose identity now reads OFF is remade OFF, never reused.
test('a live ON process is remade OFF when the identity turns the switch off while still eligible', async t => {
  let on = true
  const w = nativeWorld(t, { identity: () => ({ name: 'Ada', nativeTools: on, nativeToolsBlocked: false }) })
  const chat = w.chat('ada')
  await chat.turn('first answer')
  w.assertToolset(0, true)
  const current = w.adapter.live.get('ada').run
  on = false
  await chat.turn('after turning it off')
  w.assertToolset(1, false)
  await current.gone.catch(() => {})
  assert.equal(current.alive, false)
})

// E7-e: a Session with no Bot identity on a team host stays OFF (B-8).
test('a Session with no Bot identity stays OFF while the Bot is ON', async t => {
  const w = nativeWorld(t, { identity: id => id === 'subagent-child' ? undefined : enabledIdentity() })
  await w.chat('subagent-child').turn('a subagent task')
  await w.chat('direct').turn('owner')
  assert.deepEqual(flags(w), [true, false])
})

test('switching ON replaces a running DSH toolset on the next owner turn and replays its answer', async t => {
  let on = false
  const w = nativeWorld(t, { identity: () => ({ name: 'Ada', nativeTools: on }) })
  const chat = w.chat('ada')
  await chat.turn('first question')
  w.assertToolset(0, false)
  const off = w.adapter.live.get('ada').run
  on = true
  await chat.turn('second question')
  assert.deepEqual(flags(w), [true, false])
  assert.deepEqual(promptPids(w), launchPids(w))
  assert.notEqual(launchPids(w)[0], launchPids(w)[1])
  await off.gone.catch(() => {})
  assert.equal(off.alive, false)
  assert.match(w.events('prompt')[1].text, /The chat so far, before this new/)
  assert.match(w.events('prompt')[1].text, /first question/)
  w.assertToolset(1, true)
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
  assert.equal(reads, 2)
})

test('an unreadable sandbox level gives the DSH toolset', async t => {
  const w = nativeWorld(t, { identity: () => ({ name: 'Ada', nativeTools: true }) })
  delete w.services.sandboxPolicy
  await w.chat('ada').turn('hello')
  w.assertToolset(0, false)
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

// #1564 follow-up: the fresh relay follows the saved switch, so the child it opened is ON and the
// owner batched with it reuses that child.
test('a fresh relay rejected before its prompt opens ON, and the owner batched with it reuses that child', async t => {
  const w = nativeWorld(t, { identity: enabledIdentity, env: { FAKE_ACP_NO_OPTIONS: '1' } })
  const { session } = w.chat('fresh')
  const relay = freshRelay()
  session.append('user/message', relay, { surfaceOp: 'append' })
  const stream = async model => {
    const chunks = []
    const messages = session.deriveMessages()
    for await (const chunk of w.adapter.stream(markAgentLoopRequest({ provider: CLAUDE, model, sessionId: session.id, messages }))) chunks.push(chunk)
    return chunks
  }
  const failed = await stream('unsupported-model')
  assert.equal(failed.at(-1).reason.kind, 'error')
  const live = w.adapter.live.get(session.id)
  assert.ok(live?.run.alive)
  assert.equal(live.native, true)
  assert.equal(live.nativeManaged, true)
  assert.deepEqual(flags(w), [false])
  assert.deepEqual(promptPids(w), [])

  const owner = person('plain owner direct')
  session.append('user/message', owner, { surfaceOp: 'append' })
  const messages = session.deriveMessages()
  assert.deepEqual(messages.slice(turnStart(messages)), [relay, owner])
  const answer = await stream('default')
  assert.equal(answer.at(-1).reason.kind, 'stop')
  const [onPid] = launchPids(w)
  t.diagnostic(JSON.stringify({ flags: flags(w), launchPids: launchPids(w), promptPids: promptPids(w) }))
  assert.deepEqual(flags(w), [false])
  assert.deepEqual(promptPids(w), [onPid])
  assert.match(w.events('prompt')[0].text, /plain owner direct/)
  w.assertToolset(0, true)
  assert.equal(w.adapter.live.get(session.id).run, live.run)

  const content = answer.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
  session.append('assistant/message', {
    turn: 1, step: 1, message: createAssistantMessage({ content, source: { provider: CLAUDE, model: 'default' } }),
  }, { surfaceOp: 'append' })
  session.append('user/message', person('plain: follow-up owner message'), { surfaceOp: 'append' })
  assert.equal((await stream('default')).at(-1).reason.kind, 'stop')
  assert.deepEqual(flags(w), [false])
  assert.deepEqual(promptPids(w), [onPid, onPid])
  assert.match(w.events('prompt')[1].text, /follow-up owner message/)
  t.diagnostic(JSON.stringify({ followUpPid: w.events('prompt')[1].pid }))
})

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

// #1564 follow-up (E7-c): a handoff and a scheduled turn follow the saved switch.
test('B1/R2 the fresh relay opens Claude ON, and the owner turn reuses it', async t => {
  const w = nativeWorld(t, { identity: enabledIdentity })
  const chat = w.chat('direct')
  const startup = await chat.turn(freshRelay(), CLAUDE, openingContext())
  assert.deepEqual(startup.at(-1).reason, { kind: 'stop' })
  w.assertToolset(0, true)
  const on = w.adapter.live.get('direct').run
  const owner = await chat.turn('owner after the relay')
  assert.deepEqual(owner.at(-1).reason, { kind: 'stop' })
  t.diagnostic(JSON.stringify({ flags: flags(w), launchPids: launchPids(w), promptPids: promptPids(w) }))
  assert.deepEqual(flags(w), [false])
  const [onPid] = launchPids(w)
  assert.deepEqual(promptPids(w), [onPid, onPid])
  assert.equal(w.adapter.live.get('direct').run, on)
})

test('B2 a scheduled turn reuses the live ON process', async t => {
  const w = nativeWorld(t, { identity: enabledIdentity })
  const chat = w.chat('direct')
  await chat.turn('owner')
  const on = w.adapter.live.get('direct').run
  await chat.turn(sourced('plain: reminder', { kind: 'schedule' }))
  assert.deepEqual(flags(w), [false])
  assert.deepEqual(promptPids(w), [launchPids(w)[0], launchPids(w)[0]])
  assert.equal(w.adapter.live.get('direct').run, on)
  assert.equal(on.alive, true)
})

test('C1 an owner turn after a carried newPart package and answer opens ON and replays the package', async t => {
  const w = nativeWorld(t, { identity: enabledIdentity })
  const chat = w.chat('direct')
  const carried = freshRelay('[Handoff · part 2]\nOmni moved your own chat with the user on to a fresh conversation, part 2, because a fresh conversation was started. This message is not from the user.\n\n## Latest messages (oldest first)\n[part 1 #3] scheduled: check the calendar')
  chat.history.push(carried, ...openingHistory().slice(1))
  await chat.turn('owner')
  assert.deepEqual(flags(w), [false])
  assert.match(w.events('prompt')[0].text, /check the calendar/)
})

for (const [name, source] of [
  ['C2 a scheduler', { kind: 'schedule' }],
  ['C3 another Bot', { kind: 'bot', form: 'relay', role: 'request', senderName: 'Other' }],
]) {
  test(`${name} after the fresh handoff ACK opens ON`, async t => {
    const w = nativeWorld(t, { identity: enabledIdentity })
    const chat = w.chat('direct')
    chat.history.push(...openingHistory())
    await chat.turn(sourced('plain: request', source))
    assert.deepEqual(flags(w), [false])
  })
}

test('C4 a restart with an owner input replays the handoff and answered owner turn with Claude ON', async t => {
  const w = nativeWorld(t, { identity: enabledIdentity })
  const chat = w.chat('direct')
  chat.history.push(...openingHistory())
  await chat.turn('first owner turn')
  w.adapter.endSession('direct')
  await chat.turn('second owner turn')
  assert.deepEqual(flags(w), [false, false])
  assert.match(w.events('prompt')[1].text, /chat so far/)
  assert.match(w.events('prompt')[1].text, /first owner turn/)
  assert.match(w.events('prompt')[1].text, /Handoff \(not from the user\)/)
})

test('a restart for a scheduled input replays the answered chat with the saved ON', async t => {
  const w = nativeWorld(t, { identity: enabledIdentity })
  const chat = w.chat('ada')
  await chat.turn(person('first question'))
  w.adapter.endSession('ada')
  await chat.turn(sourced('native-read', { kind: 'schedule' }))
  assert.match(w.events('prompt').at(-1).text, /chat so far/)
  assert.deepEqual(flags(w), [false, false])
  w.assertToolset(1, true)
  assert.equal(w.events('native-tool-ran')[0].name, 'Read')
  assert.deepEqual(w.executed, [])
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

test('C8 a resumed relay with the owner source opens ON', async t => {
  const w = nativeWorld(t, { identity: enabledIdentity })
  const chat = w.chat('direct')
  await chat.turn(sourced('plain: resumed handoff carrying earlier messages', { kind: 'user', handoff: true, resume: true }))
  assert.deepEqual(flags(w), [false])
})

test('owner input in a mixed batch with generated context starts ON', async t => {
  const w = nativeWorld(t, { identity: enabledIdentity })
  const chat = w.chat('direct')
  chat.history.push(sourced('plain: reminder', { kind: 'schedule' }), ...openingContext())
  await chat.turn('owner in the same batch')
  assert.deepEqual(flags(w), [false])
  assert.deepEqual(promptPids(w), launchPids(w))
  assert.match(w.events('prompt')[0].text, /owner in the same batch/)
})

// #1564 follow-up (E7-c): a member's turn (a principal) follows the saved switch too.
for (const principal of [{ kind: 'person', id: 'visitor' }, 'visitor', null]) {
  test(`a user source with principal ${JSON.stringify(principal)} opens ON with the switch ON`, async t => {
    const w = nativeWorld(t, { identity: enabledIdentity })
    const input = sourced('plain: a principal', { kind: 'user', principal })
    await w.chat('direct').turn(input, CLAUDE, [timeContext()])
    assert.deepEqual(flags(w), [false])
    const chat = w.chat('live')
    await chat.turn('actual owner')
    assert.deepEqual(flags(w), [false, false])
    await chat.turn(input, CLAUDE, [timeContext()])
    assert.deepEqual(flags(w), [false, false])
    const [first, live] = launchPids(w)
    assert.deepEqual(promptPids(w), [first, live, live])
  })
}

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
  // Reuse confirms the saved switch once (fail closed).
  assert.equal(reads, 3)
})
