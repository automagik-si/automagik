import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createDraftSweep, liveSessionIds } from '../src/client/draft-sweep.js'

// A page's storage, with the keys it holds; `stuck` keys ignore a removal, as the viewer's
// draft guard does in a document that is not the current viewer.
function storageOf(keys, stuck = []) {
  const items = new Map(keys.map(key => [key, '{"draft":"x"}']))
  return {
    items,
    getItem: key => (items.has(key) ? items.get(key) : null),
    removeItem: (key) => { if (!stuck.includes(key)) items.delete(key) },
  }
}

// The host's `drafts-swept`, recorded; `fail` makes the next calls reject.
function host({ fail = 0 } = {}) {
  const calls = []
  let failing = fail
  const call = async (endpoint, payload) => {
    calls.push([endpoint, payload])
    if (failing > 0) {
      failing -= 1
      throw new Error('offline')
    }
    return true
  }
  return { calls, call }
}

test('the sweep removes the listed composer keys and names exactly those, in one call', async () => {
  const storage = storageOf(['dsh.conversation.a', 'dsh.conversation.b', 'dsh.conversation.c'])
  const { calls, call } = host()
  const drafts = createDraftSweep({ storage, call })
  drafts.note(['a', 'b'])
  await drafts.run()
  assert.deepEqual([...storage.items.keys()], ['dsh.conversation.c'])
  assert.deepEqual(calls, [['drafts-swept', { ids: ['a', 'b'] }]])
  await drafts.run()
  assert.equal(calls.length, 1)
})

test('a key the viewer guard keeps is not named; the other is', async () => {
  const storage = storageOf(['dsh.conversation.a', 'dsh.conversation.b'], ['dsh.conversation.a'])
  const { calls, call } = host()
  const drafts = createDraftSweep({ storage, call })
  drafts.note(['a', 'b'])
  await drafts.run()
  assert.deepEqual(calls, [['drafts-swept', { ids: ['b'] }]])
  assert.equal(storage.getItem('dsh.conversation.a'), '{"draft":"x"}')
})

test('the chat open in the main view is skipped, then swept once it is no longer open', async () => {
  const storage = storageOf(['dsh.conversation.a', 'dsh.conversation.b'])
  const { calls, call } = host()
  let open = 'a'
  const drafts = createDraftSweep({ storage, call, openSession: () => open })
  drafts.note(['a', 'b'])
  await drafts.run()
  assert.deepEqual(calls, [['drafts-swept', { ids: ['b'] }]])
  assert.equal(storage.getItem('dsh.conversation.a'), '{"draft":"x"}')
  open = 'c'
  await drafts.run()
  assert.deepEqual(calls.at(-1), ['drafts-swept', { ids: ['a'] }])
  assert.equal(storage.getItem('dsh.conversation.a'), null)
})

test('a failed naming waits for the next view, then is sent once again', async () => {
  const storage = storageOf(['dsh.conversation.a'])
  const { calls, call } = host({ fail: 1 })
  const drafts = createDraftSweep({ storage, call })
  drafts.note(['a'])
  await drafts.run()
  await drafts.run()
  await drafts.run()
  assert.equal(calls.length, 1)
  drafts.note([])
  await drafts.run()
  assert.deepEqual(calls, [['drafts-swept', { ids: ['a'] }], ['drafts-swept', { ids: ['a'] }]])
  await drafts.run()
  assert.equal(calls.length, 2)
})

test('two windows over one storage both name the ids; the host clears them once', async () => {
  const storage = storageOf(['dsh.conversation.a'])
  const first = host()
  const second = host()
  const one = createDraftSweep({ storage, call: first.call })
  const two = createDraftSweep({ storage, call: second.call })
  one.note(['a'])
  two.note(['a'])
  await Promise.all([one.run(), two.run()])
  assert.deepEqual(first.calls, [['drafts-swept', { ids: ['a'] }]])
  assert.deepEqual(second.calls, [['drafts-swept', { ids: ['a'] }]])
  assert.equal(storage.getItem('dsh.conversation.a'), null)
})

test('a key already gone (a reload mid-sweep) is named; no storage sends nothing', async () => {
  const storage = storageOf([])
  const { calls, call } = host()
  const drafts = createDraftSweep({ storage, call })
  drafts.note(['a'])
  await drafts.run()
  assert.deepEqual(calls, [['drafts-swept', { ids: ['a'] }]])
  const none = host()
  const blind = createDraftSweep({ storage: null, call: none.call })
  blind.note(['a'])
  await blind.run()
  assert.deepEqual(none.calls, [])
})

test('the page notes each full view and sweeps after it reads the team', () => {
  const index = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')
  assert.match(index, /drafts\.note\(value\.draftSweep, liveSessionIds\(value\)\)/)
  assert.equal(index.match(/drafts\.run\(\)/g)?.length, 2)
  assert.match(index, /createDraftSweep\(\{ call, openSession: \(\) => mainView\(\) \}\)/)
})

test('an id seen once stays pending after a later view drops it, until this page sweeps it', async () => {
  const storage = storageOf(['dsh.conversation.x'])
  const { calls, call } = host()
  let open = 'x'
  const drafts = createDraftSweep({ storage, call, openSession: () => open })
  drafts.note(['x'])
  await drafts.run()
  drafts.note([])
  open = undefined
  await drafts.run()
  assert.equal(storage.getItem('dsh.conversation.x'), null)
  assert.deepEqual(calls, [['drafts-swept', { ids: ['x'] }]])
})

test('an id a later view shows live is never swept', async () => {
  const storage = storageOf(['dsh.conversation.x'])
  const { calls, call } = host()
  let open = 'x'
  const drafts = createDraftSweep({ storage, call, openSession: () => open })
  drafts.note(['x'])
  await drafts.run()
  drafts.note([], new Set(['x']))
  open = undefined
  await drafts.run()
  assert.equal(storage.getItem('dsh.conversation.x'), '{"draft":"x"}')
  assert.deepEqual(calls, [])
})

test('the live ids are every Bot part, group Session and DSH bot Session a view shows', () => {
  const view = {
    bots: [{ id: 'b', sessionId: 'b-next', parts: ['b', 'b-mid'] }],
    rooms: [{ id: 'r', sessionId: 'r-next', ownParts: ['r'], parts: ['g', 'g-0'] }],
    agents: [{ id: 'ag', sessions: ['s1', 's2'] }],
  }
  assert.deepEqual([...liveSessionIds(view)].sort(), ['b', 'b-mid', 'b-next', 'g', 'g-0', 'r', 'r-next', 's1', 's2'])
  assert.deepEqual([...liveSessionIds({ bots: [{ id: 'b', parts: [3, null] }], rooms: [{}] })], ['b'])
  assert.deepEqual([...liveSessionIds(undefined)], [])
})
