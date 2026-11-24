import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createDraftSweep, liveSessionIds, unarchivedSessionIds } from '../src/client/draft-sweep.js'

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
  assert.match(index, /createDraftSweep\(\{ call, openSession: \(\) => mainView\(\), unarchived: \(\) => unarchivedSessionIds\(ctx\.sessions\.list\.getSnapshot\(\), workspaces\?\.list\?\.getSnapshot\(\)\) \}\)/)
  assert.match(index, /const workspaces = ctx\.get\('workspaces'\)/)
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

test('a deleted Session the person took back out of DSH\'s archive keeps its draft', async () => {
  const storage = storageOf(['dsh.conversation.x', 'dsh.conversation.y'])
  const { calls, call } = host()
  let open = 'x'
  // DSH's own list: x is back out of the archive, y is still archived.
  const sessions = { phase: 'ready', byId: { x: { id: 'x' }, y: { id: 'y' }, z: { id: 'z' } } }
  const workspaces = { phase: 'ready', archivedSessionIds: ['y'] }
  const drafts = createDraftSweep({ storage, call, openSession: () => open, unarchived: () => unarchivedSessionIds(sessions, workspaces) })
  drafts.note(['x', 'y'])
  await drafts.run()
  assert.deepEqual(calls, [['drafts-swept', { ids: ['y'] }]])
  open = 'z'
  await drafts.run()
  drafts.note(['x'])
  await drafts.run()
  assert.equal(storage.getItem('dsh.conversation.x'), '{"draft":"x"}')
  assert.deepEqual(calls, [['drafts-swept', { ids: ['y'] }]])
})

test('DSH\'s Sessions count as out of the archive only once its archive set arrived', () => {
  const sessions = { phase: 'ready', byId: { x: {}, y: {} } }
  assert.deepEqual([...unarchivedSessionIds(sessions, { phase: 'ready', archivedSessionIds: ['y'] })], ['x'])
  assert.equal(unarchivedSessionIds(sessions, { phase: 'pending', archivedSessionIds: [] }), undefined)
  assert.equal(unarchivedSessionIds(sessions, { phase: 'ready' }), undefined)
  assert.equal(unarchivedSessionIds(undefined, { phase: 'ready', archivedSessionIds: [] }), undefined)
  assert.equal(unarchivedSessionIds({ phase: 'pending', byId: {} }, { phase: 'ready', archivedSessionIds: [] }), undefined)
})

test('an older DSH with no workspaces list counts no Session out of the archive', () => {
  const back = unarchivedSessionIds({ phase: 'ready', byId: { x: {} } }, undefined)
  assert.ok(back instanceof Set)
  assert.equal(back.size, 0)
})

test('until DSH\'s archive set arrives the page sweeps nothing; then an unarchived id keeps its draft', async () => {
  const storage = storageOf(['dsh.conversation.x', 'dsh.conversation.y'])
  const { calls, call } = host()
  const sessions = { phase: 'ready', byId: { x: { id: 'x' }, y: { id: 'y' } } }
  let workspaces = { phase: 'pending', archivedSessionIds: [] }
  const drafts = createDraftSweep({ storage, call, unarchived: () => unarchivedSessionIds(sessions, workspaces) })
  drafts.note(['x', 'y'])
  await drafts.run()
  assert.deepEqual([...storage.items.keys()], ['dsh.conversation.x', 'dsh.conversation.y'])
  assert.deepEqual(calls, [])
  // The archive set arrives: x is out of it, y is still archived.
  workspaces = { phase: 'ready', archivedSessionIds: ['y'] }
  await drafts.run()
  assert.equal(storage.getItem('dsh.conversation.x'), '{"draft":"x"}')
  assert.equal(storage.getItem('dsh.conversation.y'), null)
  assert.deepEqual(calls, [['drafts-swept', { ids: ['y'] }]])
  // x is archived again and listed again: now it is swept and named.
  workspaces = { phase: 'ready', archivedSessionIds: ['x', 'y'] }
  drafts.note(['x'])
  await drafts.run()
  assert.equal(storage.getItem('dsh.conversation.x'), null)
  assert.deepEqual(calls, [['drafts-swept', { ids: ['y'] }], ['drafts-swept', { ids: ['x'] }]])
})

test('until DSH\'s Session list arrives the page sweeps nothing, even with the archive set ready', async () => {
  const storage = storageOf(['dsh.conversation.x'])
  const { calls, call } = host()
  const sessions = { phase: 'pending', byId: {} }
  const workspaces = { phase: 'ready', archivedSessionIds: [] }
  const drafts = createDraftSweep({ storage, call, unarchived: () => unarchivedSessionIds(sessions, workspaces) })
  drafts.note(['x'])
  await drafts.run()
  assert.equal(storage.getItem('dsh.conversation.x'), '{"draft":"x"}')
  assert.deepEqual(calls, [])
})

test('one naming holds at most 200 ids; the rest stay pending for the next run', async () => {
  const ids = Array.from({ length: 201 }, (_, at) => `s-${at}`)
  const storage = storageOf(ids.map(id => `dsh.conversation.${id}`))
  const { calls, call } = host()
  const drafts = createDraftSweep({ storage, call })
  drafts.note(ids)
  await drafts.run()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0][1].ids, ids.slice(0, 200))
  await drafts.run()
  assert.deepEqual(calls.at(-1), ['drafts-swept', { ids: ['s-200'] }])
  await drafts.run()
  assert.equal(calls.length, 2)
})

// R2: the right sidebar's per-Session layout (DSH's `dsh.sidebar-right.v1.<id>`) leaves with
// the composer state, under the same rules.
const sidebarKey = id => `dsh.sidebar-right.v1.${id}`

test('the sweep also removes a deleted Session\'s right sidebar layout; other Sessions keep theirs', async () => {
  const storage = storageOf(['dsh.conversation.a', sidebarKey('a'), sidebarKey('b'), 'dsh.conversation.c', sidebarKey('c')])
  const { calls, call } = host()
  const drafts = createDraftSweep({ storage, call })
  drafts.note(['a', 'b'])
  await drafts.run()
  assert.deepEqual([...storage.items.keys()], ['dsh.conversation.c', sidebarKey('c')])
  assert.deepEqual(calls, [['drafts-swept', { ids: ['a', 'b'] }]])
})

test('an id whose sidebar layout stays is not named, and it is swept on a later run', async () => {
  const stuck = [sidebarKey('a')]
  const storage = storageOf(['dsh.conversation.a', sidebarKey('a')], stuck)
  const { calls, call } = host()
  const drafts = createDraftSweep({ storage, call })
  drafts.note(['a'])
  await drafts.run()
  assert.equal(storage.getItem('dsh.conversation.a'), null)
  assert.equal(storage.getItem(sidebarKey('a')), '{"draft":"x"}')
  assert.deepEqual(calls, [])
  stuck.length = 0
  await drafts.run()
  assert.equal(storage.getItem(sidebarKey('a')), null)
  assert.deepEqual(calls, [['drafts-swept', { ids: ['a'] }]])
})

test('the sidebar layout of the open chat, of an unarchived Session and before DSH\'s lists arrive stays', async () => {
  const storage = storageOf([sidebarKey('open'), sidebarKey('back'), sidebarKey('gone')])
  const { calls, call } = host()
  let workspaces = { phase: 'pending', archivedSessionIds: [] }
  const sessions = { phase: 'ready', byId: { open: {}, back: {}, gone: {} } }
  const drafts = createDraftSweep({
    storage, call, openSession: () => 'open', unarchived: () => unarchivedSessionIds(sessions, workspaces),
  })
  drafts.note(['open', 'back', 'gone'])
  await drafts.run()
  assert.deepEqual([...storage.items.keys()], [sidebarKey('open'), sidebarKey('back'), sidebarKey('gone')])
  assert.deepEqual(calls, [])
  workspaces = { phase: 'ready', archivedSessionIds: ['open', 'gone'] }
  await drafts.run()
  assert.deepEqual([...storage.items.keys()], [sidebarKey('open'), sidebarKey('back')])
  assert.deepEqual(calls, [['drafts-swept', { ids: ['gone'] }]])
})
