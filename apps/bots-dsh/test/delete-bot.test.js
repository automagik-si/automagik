import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { createDraftSweep } from '../src/client/draft-sweep.js'

// Two ordinary Bots, a second Main Bot and the adopted original of a DSH bot, with Writer
// (b) running a group Session 'gb' of room 'Ops' as its admin.
function team() {
  return {
    version: 1,
    mainBotIds: ['a', 'm2'],
    bots: {
      a: { id: 'a', name: 'Omni', role: 'Boss', sessionId: 'a', createdAt: 1 },
      m2: { id: 'm2', name: 'Chief', role: 'Boss', sessionId: 'm2', createdAt: 2 },
      b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 3 },
      c: { id: 'c', name: 'Reader', role: 'Read', sessionId: 'c', createdAt: 4 },
      d: { id: 'd', name: 'Adopted', role: 'Old', sessionId: 'd', createdAt: 5, dshAgentId: 'dsh-agent-1' },
    },
    rooms: {
      r1: { id: 'r1', name: 'Ops', members: ['a', 'b', 'c'], mode: 'admin', admin: 'b', named: true, sessions: { b: 'gb' } },
    },
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 0,
  }
}

// The services a full apply() needs, recording archived Sessions and the fetch routes it
// registers. The API route's own handler is counted, so a tool reaching it would show.
// `scopes` are file-tool folder records (read-scope.js) on disk before the team loads, by
// Session id; `archivedSessionIds` is DSH's archive set. A `null` seed writes no team file;
// `lockedBy` writes another host's `state.lock`, so this host only reads.
async function start(seed = team(), { scopes = {}, archivedSessionIds, lockedBy } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-delete-'))
  if (seed !== null) writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  if (lockedBy !== undefined) writeFileSync(join(home, 'state.lock'), JSON.stringify(lockedBy))
  for (const [id, data] of Object.entries(scopes)) writeScope(home, id, data)
  const ctx = fakeContext()
  const archived = []
  const routes = []
  let routeCalls = 0
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      agents.set(sessionId, {
        session: { id: sessionId, requestHeader: () => undefined },
        id: sessionId,
        status: 'idle',
        followup() {},
        steer() {},
        inject() {},
        cancel() {},
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: { nextStep: [], nextTurn: [], remove: () => false },
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async (sessionId, options) => { archived.push([sessionId, options]) },
      ...(archivedSessionIds === undefined ? {} : { archivedSessionIds }),
    },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    const handler = options.fetch
    const counted = { ...options, fetch: async (request) => { routeCalls += 1; return handler(request) } }
    routes.push(counted)
    return register(counted)
  }
  apply(ctx, { home })
  const api = routes.find(route => route.path === '/api/omni-ui')
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId } })
  const call = async (endpoint, payload) => (await api.fetch(new Request('http://localhost/api/omni-ui', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  // Loading once fills the Session-owner indexes deletion reads.
  await tool('list_bots', {}, 'a')
  return { ctx, home, tool, call, routes, archived, routeCalls: () => routeCalls, stop }
}

const scopeFile = (home, id) => join(home, 'session-read-scopes', `${createHash('sha256').update(id).digest('hex')}.json`)
function writeScope(home, id, data) {
  mkdirSync(join(home, 'session-read-scopes'), { recursive: true })
  writeFileSync(scopeFile(home, id), `${JSON.stringify({ version: 1, id, ...data })}\n`)
}
// The Session ids among `ids` whose record is still on disk.
const scopesLeft = (home, ids) => ids.filter(id => existsSync(scopeFile(home, id)))

test('delete_bot is a host tool that requires the target and says what it destroys', async (t) => {
  const { ctx, stop } = await start()
  t.after(stop)
  const tool = ctx.registeredTools.get('delete_bot')
  assert.ok(tool, 'delete_bot is registered for Bots')
  assert.deepEqual(tool.parameters.required, ['bot'])
  assert.equal(tool.parameters.properties.bot.type, 'string')
  assert.match(tool.description, /Main Bot only/)
  assert.match(tool.description, /memory and conversations are archived/)
  assert.match(tool.description, /A Main Bot cannot be deleted/)
})

test('delete_bot removes the Bot, its group membership and its Sessions, as the sidebar Delete does', async (t) => {
  const { tool, call, archived, stop } = await start()
  t.after(stop)

  const out = await tool('delete_bot', { bot: 'Writer' }, 'a')
  assert.match(out, /^Deleted Writer\./)
  assert.match(out, /memory and conversations are archived/)
  assert.match(out, /left every group chat/)

  const view = (await call('state', {})).value
  assert.equal(view.bots.some(bot => bot.id === 'b'), false)
  const room = view.rooms.find(entry => entry.id === 'r1')
  // Its membership and its admin place are gone; the other members stay.
  assert.deepEqual(room.members, ['a', 'c'])
  assert.equal(room.admin, null)
  // Both its own chat and its group Session were archived, which stops armed tasks.
  assert.deepEqual(archived.map(([sessionId]) => sessionId).sort(), ['b', 'gb'])
  for (const [, options] of archived) assert.deepEqual(options, { stopActivity: true })
  // The endpoint sees the same team: the tool deleted through the host, not a second record.
  assert.equal(view.bots.some(bot => bot.name === 'Writer'), false)
})

test('delete_bot refuses a non-Main caller, itself, a Main Bot, an adopted original and an unknown name', async (t) => {
  const { tool, call, archived, stop } = await start()
  t.after(stop)

  await assert.rejects(tool('delete_bot', { bot: 'Writer' }, 'b'), { message: 'Only a Main Bot can delete Bots.' })
  await assert.rejects(tool('delete_bot', { bot: 'Reader' }, 'c'), { message: 'Only a Main Bot can delete Bots.' })
  await assert.rejects(tool('delete_bot', { bot: 'Omni' }, 'a'), { message: 'You cannot delete yourself.' })
  // A second Main Bot is refused by the host's own check, the same one the sidebar meets.
  await assert.rejects(tool('delete_bot', { bot: 'Chief' }, 'a'), { message: 'A Main Bot cannot be deleted; remove its Main Bot role first' })
  await assert.rejects(tool('delete_bot', { bot: 'Adopted' }, 'a'), { message: 'Roll back DSH adoption before deleting the original DSH bot' })
  await assert.rejects(tool('delete_bot', { bot: 'Nobody' }, 'a'), { message: /^No Bot named Nobody\. Team: / })

  // Nothing was deleted by a refused call.
  const view = (await call('state', {})).value
  assert.deepEqual(view.bots.map(bot => bot.name).sort(), ['Adopted', 'Chief', 'Omni', 'Reader', 'Writer'])
  assert.deepEqual(archived, [])
})

test('delete_bot calls the host deletion directly and leaves the authenticated API route untouched', async (t) => {
  const { tool, call, routes, archived, routeCalls, stop } = await start()
  t.after(stop)

  // The browser's route is still the one POST /api/omni-ui the host authenticates; the
  // tool adds no route of its own and sends no request through it.
  assert.deepEqual(routes.filter(route => route.path === '/api/omni-ui').map(route => route.methods), [['POST']])
  const registered = routes.length
  await tool('delete_bot', { bot: 'Reader' }, 'a')
  assert.equal(routeCalls(), 0)
  assert.equal(routes.length, registered)
  assert.deepEqual(archived.map(([sessionId]) => sessionId), ['c'])

  // A local agent has no web session, and the tool still deletes: it runs on the host.
  await tool('delete_bot', { bot: 'Writer' }, 'a')
  assert.equal(routeCalls(), 0)

  // The route answers the same host deletion, and the Bot the tool removed is already gone.
  const again = await call('delete-bot', { id: 'b' })
  assert.equal(routeCalls(), 1)
  assert.equal(again.ok, false)
  assert.deepEqual(again.error, { code: 'bot/refused', message: 'Unknown Bot', details: {} })
})

// Writer moved to a new part: its current chat is 'b-next', its first part 'b'.
function moved() {
  const seed = team()
  seed.bots.b = { ...seed.bots.b, sessionId: 'b-next', segments: [{ sessionId: 'b', endedAt: 1 }] }
  return seed
}
const savedSweep = home => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).draftSweep
// The page's `call`: the answer's value, or a rejection for a refused request.
const pageCall = call => async (endpoint, payload) => {
  const answer = await call(endpoint, payload)
  if (!answer.ok) throw Object.assign(new Error(answer.error?.message ?? 'refused'), { code: answer.error?.code })
  return answer.value
}
function storageOf(keys) {
  const items = new Map(keys.map(key => [key, '{"draft":"x"}']))
  return { items, getItem: key => (items.has(key) ? items.get(key) : null), removeItem: (key) => { items.delete(key) } }
}

test('the person\'s Delete answers with every part of the deleted Bot', async (t) => {
  const seed = team()
  seed.bots.b = { ...seed.bots.b, sessionId: 'b-next', segments: [{ sessionId: 'b', endedAt: 1 }, { sessionId: 'b-mid', endedAt: 2 }] }
  const { call, stop } = await start(seed)
  t.after(stop)
  const answer = await call('delete-bot', { id: 'b' })
  assert.equal(answer.ok, true)
  assert.deepEqual([...answer.value.deletedParts].sort(), ['b', 'b-mid', 'b-next'])
  assert.equal(answer.value.bots.some(bot => bot.id === 'b'), false)
})

test('a Bot deleted by another Bot\'s delete_bot is listed for the page\'s composer sweep, its current part last', async (t) => {
  const { home, tool, call, stop } = await start(moved())
  t.after(stop)
  assert.match(await tool('delete_bot', { bot: 'Writer' }, 'a'), /^Deleted Writer\./)
  assert.deepEqual((await call('state', {})).value.draftSweep, ['b', 'b-next'])
  assert.deepEqual(savedSweep(home), ['b', 'b-next'])
})

test('the page sweeps a Bot another Bot deleted: its composer keys go, the others stay, and the list clears', async (t) => {
  const { tool, call, stop } = await start(moved())
  t.after(stop)
  await tool('delete_bot', { bot: 'Writer' }, 'a')
  const storage = storageOf(['dsh.conversation.b', 'dsh.conversation.b-next', 'dsh.conversation.c'])
  const drafts = createDraftSweep({ storage, call: pageCall(call), openSession: () => undefined })
  drafts.note((await call('state', {})).value.draftSweep)
  await drafts.run()
  assert.deepEqual([...storage.items.keys()], ['dsh.conversation.c'])
  assert.equal(Object.hasOwn((await call('state', {})).value, 'draftSweep'), false)
})

test('the page sweeps a deleted Bot\'s right sidebar layouts with its composer keys; a live Bot\'s stay', async (t) => {
  const { call, stop } = await start(moved())
  t.after(stop)
  assert.equal((await call('delete-bot', { id: 'b' })).ok, true)
  const sidebarKey = id => `dsh.sidebar-right.v1.${id}`
  const storage = storageOf(['dsh.conversation.b-next', sidebarKey('b'), sidebarKey('b-next'), 'dsh.conversation.c', sidebarKey('c')])
  const drafts = createDraftSweep({ storage, call: pageCall(call), openSession: () => undefined })
  drafts.note((await call('state', {})).value.draftSweep)
  await drafts.run()
  assert.deepEqual([...storage.items.keys()], ['dsh.conversation.c', sidebarKey('c')])
  assert.equal(Object.hasOwn((await call('state', {})).value, 'draftSweep'), false)
})

test('a clear takes off only the ids the page names, and ids it does not hold save nothing', async (t) => {
  const { home, tool, call, stop } = await start(moved())
  t.after(stop)
  await tool('delete_bot', { bot: 'Writer' }, 'a')
  await tool('delete_bot', { bot: 'Reader' }, 'a')
  assert.deepEqual((await call('state', {})).value.draftSweep, ['b', 'b-next', 'c'])
  assert.equal((await call('drafts-swept', { ids: ['b'] })).ok, true)
  const view = (await call('state', {})).value
  assert.deepEqual(view.draftSweep, ['b-next', 'c'])
  for (const ids of [['zz', 3, null], ['b'], 'b', undefined]) {
    assert.equal((await call('drafts-swept', { ids })).ok, true)
    const again = (await call('state', {})).value
    assert.deepEqual(again.draftSweep, ['b-next', 'c'])
    assert.equal(again.revision, view.revision)
  }
  assert.deepEqual(savedSweep(home), ['b-next', 'c'])
})

test('the sweep list keeps the newest 200 ids, the deleted Bot\'s last', async (t) => {
  const seed = moved()
  seed.draftSweep = Array.from({ length: 200 }, (_, at) => `old-${at}`)
  const { tool, call, stop } = await start(seed)
  t.after(stop)
  await tool('delete_bot', { bot: 'Writer' }, 'a')
  const list = (await call('state', {})).value.draftSweep
  assert.equal(list.length, 200)
  assert.equal(list.includes('old-0'), false)
  assert.equal(list.includes('old-1'), false)
  assert.equal(list[0], 'old-2')
  assert.deepEqual(list.slice(-2), ['b', 'b-next'])
})

test('a saved sweep list keeps only distinct ids, and an empty one is no list', async (t) => {
  const seed = team()
  seed.draftSweep = ['x', 3, null, 'x', '']
  const first = await start(seed)
  t.after(first.stop)
  assert.deepEqual((await first.call('state', {})).value.draftSweep, ['x'])
  const empty = team()
  empty.draftSweep = []
  const second = await start(empty)
  t.after(second.stop)
  assert.equal(Object.hasOwn((await second.call('state', {})).value, 'draftSweep'), false)
  const long = team()
  long.draftSweep = Array.from({ length: 202 }, (_, at) => `s-${at}`)
  const third = await start(long)
  t.after(third.stop)
  const list = (await third.call('state', {})).value.draftSweep
  assert.equal(list.length, 200)
  assert.equal(list[0], 's-2')
})

test('one clear takes off at most 200 named ids: the 201st stays listed', async (t) => {
  const seed = team()
  const ids = Array.from({ length: 201 }, (_, at) => `s-${at}`)
  seed.draftSweep = ids.slice(1)
  const { call, stop } = await start(seed)
  t.after(stop)
  assert.equal((await call('drafts-swept', { ids })).ok, true)
  assert.deepEqual((await call('state', {})).value.draftSweep, ['s-200'])
})

// Ops on its second own part, with Writer's group Session on its second part too.
function movedGroup() {
  const seed = team()
  seed.rooms.r1 = { ...seed.rooms.r1, sessionId: 'r1-next', parts: [{ sessionId: 'r1' }], sessions: { b: 'gb' }, segments: { b: [{ sessionId: 'gb-0' }] } }
  return seed
}

test('a deleted group lists its own parts, its members\' group Sessions and its current Session last', async (t) => {
  const { home, call, stop } = await start(movedGroup())
  t.after(stop)
  assert.equal((await call('delete-room', { id: 'r1' })).ok, true)
  assert.deepEqual((await call('state', {})).value.draftSweep, ['r1', 'gb-0', 'gb', 'r1-next'])
  assert.deepEqual(savedSweep(home), ['r1', 'gb-0', 'gb', 'r1-next'])
})

test('a group another Bot deletes with delete_group is listed the same way', async (t) => {
  const { home, tool, call, stop } = await start(movedGroup())
  t.after(stop)
  assert.match(await tool('delete_group', { group: 'Ops' }, 'a'), /^Deleted "Ops"\./)
  assert.deepEqual((await call('state', {})).value.draftSweep, ['r1', 'gb-0', 'gb', 'r1-next'])
  assert.deepEqual(savedSweep(home), ['r1', 'gb-0', 'gb', 'r1-next'])
})

test('the page sweeps a deleted group\'s composer key and the list clears', async (t) => {
  const { call, stop } = await start(movedGroup())
  t.after(stop)
  await call('delete-room', { id: 'r1' })
  const storage = storageOf(['dsh.conversation.r1-next', 'dsh.conversation.c'])
  const drafts = createDraftSweep({ storage, call: pageCall(call), openSession: () => undefined })
  drafts.note((await call('state', {})).value.draftSweep)
  await drafts.run()
  assert.deepEqual([...storage.items.keys()], ['dsh.conversation.c'])
  assert.equal(Object.hasOwn((await call('state', {})).value, 'draftSweep'), false)
})

// R1: a deleted Bot's or group's file-tool folder records (`session-read-scopes`) leave with
// it, except a record a remaining record names, which a surviving Session reads its folder
// through.
test('a deleted Bot\'s file-tool records go: its parts and its group Session, the others stay', async (t) => {
  const scopes = {
    b: { folder: null },
    'b-next': { rootId: 'b', continuation: true },
    gb: { rootId: 'r1', continuation: false },
    r1: { folder: '/team/ops' },
    a: { folder: null },
    c: { rootId: 'a', continuation: false },
  }
  const { home, call, stop } = await start(moved(), { scopes })
  t.after(stop)
  assert.equal((await call('delete-bot', { id: 'b' })).ok, true)
  assert.deepEqual(scopesLeft(home, Object.keys(scopes)), ['r1', 'a', 'c'])
})

test('a deleted Bot\'s record a surviving Session or a scheduled task still names stays', async (t) => {
  const scopes = {
    b: { folder: '/work/b' },
    'b-next': { rootId: 'b', continuation: true },
    gb: { rootId: 'r1', continuation: false },
    // Reader was made by Writer and reads in Writer's folder; a scheduled Session may bind
    // to Writer's current part.
    c: { rootId: 'b-next', continuation: false },
    'sched-1': { candidateRoots: ['b-next', 'a'] },
  }
  const { home, call, stop } = await start(moved(), { scopes })
  t.after(stop)
  assert.equal((await call('delete-bot', { id: 'b' })).ok, true)
  assert.deepEqual(scopesLeft(home, Object.keys(scopes)), ['b', 'b-next', 'c', 'sched-1'])
})

test('delete_bot forgets the same file-tool records as the person\'s Delete', async (t) => {
  const scopes = {
    b: { folder: null },
    'b-next': { rootId: 'b', continuation: true },
    gb: { rootId: 'r1', continuation: false },
    r1: { folder: '/team/ops' },
    a: { folder: null },
    c: { rootId: 'a', continuation: false },
  }
  const { home, tool, stop } = await start(moved(), { scopes })
  t.after(stop)
  assert.match(await tool('delete_bot', { bot: 'Writer' }, 'a'), /^Deleted Writer\./)
  assert.deepEqual(scopesLeft(home, Object.keys(scopes)), ['r1', 'a', 'c'])
})

test('delete_bot keeps a deleted Bot\'s record a surviving Session still names', async (t) => {
  const scopes = {
    b: { folder: '/work/b' },
    'b-next': { rootId: 'b', continuation: true },
    gb: { rootId: 'r1', continuation: false },
    c: { rootId: 'b-next', continuation: false },
  }
  const { home, tool, stop } = await start(moved(), { scopes })
  t.after(stop)
  assert.match(await tool('delete_bot', { bot: 'Writer' }, 'a'), /^Deleted Writer\./)
  assert.deepEqual(scopesLeft(home, Object.keys(scopes)), ['b', 'b-next', 'c'])
})

// A deletion whose save fails leaves the Bot or group on disk: its records stay with it.
// The home is made read-only after the start; the stop gives it back before removing it.
function failSaves(t, home, stop) {
  chmodSync(home, 0o500)
  t.after(() => { chmodSync(home, 0o700); return stop() })
}

test('a Bot deletion whose save fails removes no file-tool record', { skip: process.getuid?.() === 0 }, async (t) => {
  const scopes = { b: { folder: '/work/b' }, 'b-next': { rootId: 'b', continuation: true } }
  const { home, call, stop } = await start(moved(), { scopes })
  failSaves(t, home, stop)
  assert.notEqual((await call('delete-bot', { id: 'b' })).ok, true)
  assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).bots.b.name, 'Writer')
  assert.deepEqual(scopesLeft(home, Object.keys(scopes)), ['b', 'b-next'])
})

test('a group deletion whose save fails removes no file-tool record', { skip: process.getuid?.() === 0 }, async (t) => {
  const scopes = { r1: { folder: '/team/ops' }, 'r1-next': { rootId: 'r1', continuation: true }, gb: { rootId: 'r1-next', continuation: false } }
  const { home, call, stop } = await start(movedGroup(), { scopes })
  failSaves(t, home, stop)
  assert.notEqual((await call('delete-room', { id: 'r1' })).ok, true)
  assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).rooms.r1.name, 'Ops')
  assert.deepEqual(scopesLeft(home, Object.keys(scopes)), ['r1', 'r1-next', 'gb'])
})

test('a deleted group\'s file-tool records go: its parts, its members\' Sessions and its own', async (t) => {
  const scopes = {
    r1: { folder: '/team/ops' },
    'r1-next': { rootId: 'r1', continuation: true },
    gb: { rootId: 'r1-next', continuation: false },
    'gb-0': { rootId: 'r1', continuation: false },
    b: { folder: null },
  }
  const { home, call, stop } = await start(movedGroup(), { scopes })
  t.after(stop)
  assert.equal((await call('delete-room', { id: 'r1' })).ok, true)
  assert.deepEqual(scopesLeft(home, Object.keys(scopes)), ['b'])
})

test('earlier deletions\' records go at start: archived, unknown to the team, unnamed and bound to no folder', async (t) => {
  const scopes = {
    // A Bot deleted before this rule: its first part and its second.
    'old-0': { folder: null },
    'old-1': { rootId: 'old-0', continuation: true },
    // A deleted group member's Session whose root was a live Bot.
    'old-g': { rootId: 'a', continuation: false },
    a: { folder: null },
    // An archived Session bound to a folder, itself or through its root: no Session's limit changes.
    'old-f': { folder: '/work/f' },
    'old-fc': { rootId: 'old-f', continuation: false },
    // An archived Session a live record names.
    'old-n': { folder: null },
    live: { rootId: 'old-n', continuation: false },
    // Not archived, and the team's own archived Sessions: a Bot's and a task's.
    plain: { folder: null },
    b: { folder: null },
    'task-1': { folder: null },
  }
  const archivedSessionIds = ['old-0', 'old-1', 'old-g', 'old-f', 'old-fc', 'old-n', 'b', 'task-1']
  const seed = { ...team(), tasks: { 'task-1': { title: 'Done work', from: 'a', status: 'done', at: 1 } } }
  const { ctx, home, stop } = await start(seed, { scopes, archivedSessionIds })
  t.after(stop)
  assert.deepEqual([...await ctx.provided.get('omniTeam').readScopeOrphansForgotten].sort(), ['old-0', 'old-1', 'old-g'])
  assert.deepEqual(scopesLeft(home, Object.keys(scopes)), ['a', 'old-f', 'old-fc', 'old-n', 'live', 'plain', 'b', 'task-1'])
})

// The start pass removes nothing it cannot trust: a host that only reads, or a team file
// that is not there (it loads as an empty team, which knows no Session).
const orphanScopes = { 'old-0': { folder: null }, 'old-1': { rootId: 'old-0', continuation: true } }

test('a reading host removes no earlier deletion\'s record at start', async (t) => {
  const lockedBy = { pid: process.pid, host: 'other-test-host', token: 'other-test-writer' }
  const { ctx, home, stop } = await start(team(), { scopes: orphanScopes, archivedSessionIds: ['old-0', 'old-1'], lockedBy })
  t.after(stop)
  assert.deepEqual(await ctx.provided.get('omniTeam').readScopeOrphansForgotten, [])
  assert.deepEqual(scopesLeft(home, Object.keys(orphanScopes)), ['old-0', 'old-1'])
})

test('with no team file the start pass removes no record', async (t) => {
  const { ctx, home, stop } = await start(null, { scopes: orphanScopes, archivedSessionIds: ['old-0', 'old-1'] })
  t.after(stop)
  assert.deepEqual(await ctx.provided.get('omniTeam').readScopeOrphansForgotten, [])
  assert.deepEqual(scopesLeft(home, Object.keys(orphanScopes)), ['old-0', 'old-1'])
})
