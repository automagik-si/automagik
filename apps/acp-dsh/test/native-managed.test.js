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
