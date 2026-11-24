import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
async function start(seed = team()) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-delete-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
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
