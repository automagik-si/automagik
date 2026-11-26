import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { afterRound } from './relay-rows.js'
import { until } from './until.js'

const bot = (id, name, role, createdAt) => ({ id, name, role, sessionId: id, createdAt })
const room = (id, name, extra) => ({
  id, name, members: ['a', 'b', 'c'], mode: 'everyone', admin: 'a', named: true,
  sessions: {}, log: [], seq: 0, seen: {}, ...extra,
})
const team = ({ before = {}, r1 = {}, after = {}, bots = {}, agents = {} } = {}) => ({
  version: 1, mainBotIds: ['a'],
  bots: { a: bot('a', 'Omni', 'Boss', 1), b: bot('b', 'Writer', 'Write', 2), c: bot('c', 'Reader', 'Read', 3), ...bots },
  rooms: { ...before, r1: room('r1', 'Ops', { mode: 'admin', admin: 'b', sessions: { b: 'gb', c: 'gc' }, ...r1 }), ...after },
  agents, tasks: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
})

const quiet = rt => until(() => (rt.ownershipBusy?.() ?? 0) === 0 && rt.teamCurrent(), { ms: 5000 })
const busy = rt => { if (typeof rt.ownershipBusy === 'function') assert.ok(rt.ownershipBusy() > 0) }
const achieve = async (promise, ms = 5000) => {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out waiting for the operation')), ms)
    })])
  } finally { clearTimeout(timer) }
}
const hold = () => {
  const entered = Promise.withResolvers()
  const go = Promise.withResolvers()
  return { entered: entered.promise, release: go.resolve, wait: () => { entered.resolve(); return go.promise } }
}

async function start(t, options) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-approval-group-end-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team(options)))
  const ctx = fakeContext()
  const requests = []
  const archived = []
  t.after(async () => {
    for (const { abort } of requests) abort.abort({ kind: 'user' })
    await Promise.allSettled(requests.map(({ answer }) => answer))
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const agents = new Map()
  const agentOf = id => {
    if (!agents.has(id)) agents.set(id, {
      id, session: { id, requestHeader: () => undefined }, status: 'idle',
      followup() {}, steer() {}, inject() {}, cancel() {}, async whenIdle() {},
      async runMaintenance(fn) { return fn(AbortSignal.timeout(5000)) },
      inbox: { nextStep: [], nextTurn: [], remove: () => false },
    })
    return agents.get(id)
  }
  const holds = {}
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }),
      archiveSession: async (id, opts) => { archived.push([id, opts]) },
      unarchiveSession: async id => { await holds.unarchive?.(id) },
    },
    sessionController: {
      create: async ({ sessionId } = {}) => ({ sessionId: sessionId ?? 'fresh' }),
      resolveAgent: async id => (await holds.resolve?.(id)) ?? { agent: agentOf(id) },
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async session => { await holds.rename?.(session) } },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload = {}) => (await route.fetch(new Request('http://localhost/api/omni-ui', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const tool = (name, args, id, exec) => rt.teamTools.find(item => item.name === name).execute(args, { agent: agentOf(id), ...exec })
  const held = (id, callId = id, extra) => {
    const abort = new AbortController()
    const request = { agent: { session: { id } }, toolName: 'bash', reason: 'escalate sandbox', callId, ...extra, signal: abort.signal }
    const chain = ctx.listeners.get('approval/request')
    const run = at => at === chain.length ? new Promise(resolve => {
      if (request.signal.aborted) resolve('cancelled')
      else request.signal.addEventListener('abort', () => resolve('cancelled'), { once: true })
    }) : chain[at](request, () => run(at + 1))
    const answer = run(0)
    requests.push({ abort, answer })
    const entry = rt.approvalsView().find(item => item.callId === callId)
    assert.equal(entry?.sessionId, id)
    assert.equal(entry.answerable, true)
    return { entry, answer, abort }
  }
  const settled = []
  rt.onApproval((kind, data) => { if (kind === 'settled') settled.push(data) })
  await tool('list_bots', {}, 'a')
  assert.equal(rt.holdsLock(), true)
  await quiet(rt)
  return { home, rt, ctx, call, tool, held, settled, archived, holds }
}

const child = (id, parent) => ({ agent: { session: { id, header: { origin: 'subagent', parentSession: parent } } } })
const reports = h => h.settled.map(({ id, decidedBy, why }) => [id, decidedBy, why])
const rows = h => h.rt.withdrawnView?.() ?? []
const idOf = ({ entry }) => entry.id
const idsOf = asks => asks.map(idOf)
const report = (ask, why) => [idOf(ask), 'system', why]
const remove = async h => assert.equal((await h.call('update-room', { id: 'r1', remove: ['c'] })).ok, true)
const drop = h => h.rt.dropGroupSession(h.rt.roomOf('r1'), 'c')
const archive = (h, id) => assert.ok(h.archived.some(([session, options]) => session === id && options?.stopActivity === true), id)
const cancelled = async asks => assert.deepEqual(await achieve(Promise.all(asks.map(({ answer }) => answer))), asks.map(() => 'cancelled'))
const gone = h => assert.equal(h.rt.state.rooms.r1.sessions.c, undefined)
const control = async (h, ...asks) => {
  await cancelled(asks)
  assert.deepEqual(reports(h), asks.filter(({ entry }) => !entry.child).map(ask => report(ask)))
  assert.deepEqual(rows(h), [])
  gone(h)
  archive(h, 'gc')
}
const positive = async (h, tag, asks, archived) => {
  await cancelled(asks)
  for (const id of archived) archive(h, id)
  assert.deepEqual(reports(h), asks.filter(({ entry }) => !entry.child).map(ask => report(ask, 'group')), 'D3B-' + tag)
  const records = asks.map(({ entry }) => [
    entry.id, 'group', entry.botId, entry.botId === 'c' ? 'Reader' : 'Writer',
    'r1', 'Ops', entry.sessionId, entry.child === true, entry.ownerSessionId,
  ])
  assert.deepEqual(rows(h).map(row => [
    row.id, row.why, row.botId, row.botName, row.roomId, row.roomName, row.sessionId, row.child === true, row.ownerSessionId,
  ]), records)
  const view = await h.call('state')
  assert.equal(view.ok, true)
  assert.deepEqual(view.value.work.withdrawn.map(row => row.id), idsOf(asks))
  for (const id of idsOf(asks)) assert.equal((await h.call('approval-answer', { id, choice: 'allow' })).error.code, 'bot/stale')
}

test('rfc0039 D3b [P] G1 update-room remove withdraws the seat ask of the removed member and its child', async t => {
  const h = await start(t)
  const seat = h.held('gc')
  const k = h.held('k', 'k', child('k', 'gc'))
  const other = [h.held('gb'), h.held('a')]
  assert.deepEqual([seat.entry.roomId, seat.entry.botId, k.entry.ownerSessionId], ['r1', 'c', 'gc'])
  // Room-only switch markers survive serialization and are valid ownership evidence.
  h.rt.state.switching.unrelated = { roomId: 'r1' }
  await quiet(h.rt)
  await remove(h)
  assert.deepEqual(h.rt.state.switching.unrelated, { roomId: 'r1' })
  gone(h)
  await positive(h, 'G1', [seat, k], ['gc'])
  assert.deepEqual(h.rt.approvalsView().map(entry => entry.id), idsOf(other))
  for (const { entry, answer } of other) {
    assert.equal((await h.call('approval-answer', { id: entry.id, choice: 'allow' })).ok, true)
    assert.equal(await answer, 'allowed-once')
  }
})

test('rfc0039 D3b [P] G2 update_group remove withdraws the seat ask of the removed member', async t => {
  const h = await start(t)
  const ask = h.held('gc')
  await quiet(h.rt)
  assert.match(await h.tool('update_group', { group: 'Ops', remove_members: ['Reader'] }, 'a'), /^Updated "Ops"/)
  gone(h)
  await positive(h, 'G2', [ask], ['gc'])
})

test('rfc0039 D3b [P] G3 delete-room by id withdraws every seat ask', async t => {
  const h = await start(t)
  const asks = [h.held('gb'), h.held('gc')]
  await quiet(h.rt)
  assert.equal((await h.call('delete-room', { id: 'r1' })).ok, true)
  assert.equal(h.rt.state.rooms.r1, undefined)
  await positive(h, 'G3', asks, ['gb', 'gc'])
})

test('rfc0039 D3b [P] G4 delete-room by the group Session id withdraws the dropped seat asks', async t => {
  const h = await start(t, { r1: { sessionId: 'r1-2' } })
  assert.equal(h.rt.roomOf('r1-2'), h.rt.state.rooms.r1)
  const asks = [h.held('gb'), h.held('gc')]
  await quiet(h.rt)
  assert.equal((await h.call('delete-room', { id: 'r1-2' })).ok, true)
  assert.deepEqual(h.rt.roomOf('r1').sessions, {})
  await positive(h, 'G4', asks, ['gb', 'gc'])
})

test('rfc0039 D3b [P] G5 delete_group withdraws every seat ask', async t => {
  const h = await start(t)
  const asks = [h.held('gb'), h.held('gc')]
  assert.equal(h.rt.roomBusy('r1'), false)
  await quiet(h.rt)
  assert.equal(await h.tool('delete_group', { group: 'Ops' }, 'a'), 'Deleted "Ops". Its history is archived.')
  await positive(h, 'G5', asks, ['gb', 'gc'])
})

test('rfc0039 D3b [P] G6 delete-bot withdraws its seat asks as group', async t => {
  const h = await start(t)
  const asks = [h.held('gc'), h.held('k', 'k', child('k', 'gc'))]
  await quiet(h.rt)
  assert.equal((await h.call('delete-bot', { id: 'c' })).ok, true)
  assert.equal(h.rt.botOf('c'), undefined)
  await positive(h, 'G6', asks, ['gc'])
})

test('rfc0039 D3b [P] G7 the delete_bot tool withdraws the deleted Bot\'s seat ask as group', async t => {
  const h = await start(t)
  const ask = h.held('gc')
  await quiet(h.rt)
  assert.match(await h.tool('delete_bot', { bot: 'Reader' }, 'a'), /^Deleted Reader\./)
  assert.equal(h.rt.botOf('c'), undefined)
  await positive(h, 'G7', [ask], ['gc'])
})

const lost = id => ({ error: { code: 'gateway/internal', message: `resume failed for session "${id}": SessionQueryError: stored session "${id}" is corrupt: released v2 row has seq gap (expected 20, got 16)` } })
const relay = async (h, signal) => afterRound(h.rt, 'r1', await h.tool('group_relay', {}, 'r1', { callId: 'c1', signal }))

test('rfc0039 D3b [P] G8 a lost group Session retires its seat and withdraws its ask', async t => {
  const h = await start(t)
  const ask = h.held('gb')
  t.mock.method(h.rt, 'warn', () => {})
  h.holds.resolve = id => id === 'gb' ? lost(id) : undefined
  await quiet(h.rt)
  const round = await achieve(relay(h, AbortSignal.timeout(5000)))
  assert.deepEqual(round.replies.filter(reply => reply.kind === 'failed').map(reply => [reply.name, reply.code]), [['Writer', 'SESSION_RESET']])
  assert.ok(h.rt.roomOf('r1').members.includes('b'))
  assert.equal(h.rt.roomOf('r1').sessions.b, undefined)
  await positive(h, 'G8', [ask], ['gb'])
})

test('rfc0039 D3b [P] G9 retirement names the member whose delivery failed', async t => {
  const h = await start(t)
  const ask = h.held('gb')
  const original = h.rt.botOf('b')
  let later
  h.holds.resolve = id => {
    if (id !== 'gb') return
    if (later === undefined) {
      h.rt.state.bots.b = { ...original }
      later = h.held('gb', 'replacement')
    }
    return lost(id)
  }
  t.mock.method(h.rt, 'warn', () => {})
  await quiet(h.rt)
  await achieve(relay(h, AbortSignal.timeout(5000)))
  assert.notEqual(h.rt.botOf('b'), original)
  assert.equal(h.rt.roomOf('r1').sessions.b, undefined)
  await cancelled([ask, later])
  archive(h, 'gb')
  assert.deepEqual(reports(h), [report(ask, 'group'), report(later)], 'D3B-G9')
  assert.deepEqual(rows(h).map(row => row.id), [idOf(ask)])
})

function replaceOnRelease(t, h) {
  const release = h.rt.releaseBot
  const original = h.rt.botOf('c')
  const replacement = { ...original }
  let later
  t.mock.method(h.rt, 'releaseBot', async (...args) => {
    assert.equal(h.rt.botOf('c'), original)
    h.rt.state.bots.c = replacement
    later = h.held('gc', 'replacement')
    return release(...args)
  })
  return { replacement, later: () => later }
}

test('rfc0039 D3b [C] G10 delete-bot of a replaced record labels no seat', async t => {
  const h = await start(t)
  const ask = h.held('gc')
  const replacement = replaceOnRelease(t, h)
  assert.equal((await h.call('delete-bot', { id: 'c' })).ok, true)
  assert.ok(replacement.later())
  await control(h, ask, replacement.later())
})

test('rfc0039 D3b [C] G11 a record put back between a deletion\'s drops gets no label', async t => {
  const h = await start(t, { after: { r2: room('r2', 'Dev', { sessions: { c: 'gc2' } }) } })
  const ask = h.held('gc')
  const replaced = replaceOnRelease(t, h)
  let late
  h.rt.onApproval((kind, data) => {
    if (kind !== 'settled' || data.id !== idOf(ask)) return
    h.rt.state.bots.c = replaced.replacement
    late = h.held('gc2', 'late')
  })
  assert.equal((await h.call('delete-bot', { id: 'c' })).ok, true)
  assert.ok(late)
  assert.equal(h.rt.botOf('c'), replaced.replacement)
  await control(h, ask, replaced.later(), late)
  archive(h, 'gc2')
})

test('rfc0039 D3b [C] G12 a seat named anywhere else in the team is cancelled without a label', async t => {
  const location = [state => state.rooms.r2.sessions, 'c', 'gc']
  const cases = [
    location,
    [state => state.rooms.r2.sessions, 'c', 'gc', true],
    [state => (state.rooms.r1.segments ??= {}), 'b', [{ sessionId: 'gc' }]],
    [state => state.bots.d, 'segments', [{ sessionId: 'gc' }]],
    [state => state.rooms.r2, 'parts', [{ sessionId: 'gc' }]],
    [state => state.bots.d, 'sessionId', 'gc'],
    [state => state.bots, 'gc', { ...bot('gc', 'First', 'First', 5), sessionId: 'gx' }],
    [state => state.rooms, 'gc', room('gc', 'First', { sessionId: 'gx' })],
    [state => state.switching, 'gc', { roomId: 'r2' }],
    [state => state.switching, 'gx', { botId: 'c', roomId: 'r1' }],
    [state => state.tasks, 'gc', { title: 'Task', from: 'a', status: 'working' }],
    [state => state, 'subscriptionRuns', [{ sessionId: 'gc', botId: 'b' }]],
    [state => state.agents, 'x', { id: 'x', kind: 'dsh', sessions: ['gc'] }],
  ]
  for (const [table, key, value, nonmember] of cases) {
    const h = await start(t, {
      after: { r2: room('r2', 'Dev', nonmember ? { members: ['a', 'b'] } : {}) },
      bots: { d: bot('d', 'Echo', 'Echo', 4) },
    })
    const ask = h.held('gc')
    const target = table(h.rt.state)
    target[key] = value
    assert.equal(target[key], value)
    if (nonmember) assert.equal(h.rt.roomOf('r2').members.includes('c'), false)
    await remove(h)
    await control(h, ask)
  }
  const h = await start(t)
  const ask = h.held('gc')
  const queried = []
  const off = h.rt.hooks.sessionOwner(id => {
    queried.push(id)
    return id === 'gc' ? { botId: 'a', label: 'run' } : undefined
  })
  try {
    await remove(h)
    if (typeof h.rt.ownershipBusy === 'function') assert.ok(queried.includes('gc'))
    await control(h, ask)
  } finally { off() }

  // The live cancel also matches the child's ID, even though its seat was H.
  const other = await start(t, { r1: { sessions: { b: 'gb', c: 'H' } } })
  const wrongSeat = other.held('gc', 'child', child('gc', 'H'))
  assert.equal(wrongSeat.entry.ownerSessionId, 'H')
  other.rt.roomOf('r1').sessions.c = 'gc'
  other.rt.indexSessions()
  assert.equal(other.rt.roomOf('r1').sessions.c, wrongSeat.entry.sessionId)
  await remove(other)
  await control(other, wrongSeat)
})

test('rfc0039 D3b [C] G13 an ask of a replaced room record gets no label', async t => {
  const h = await start(t)
  const ask = h.held('gc')
  const original = h.rt.roomOf('r1')
  h.rt.state.rooms.r1 = { ...original }
  assert.notEqual(h.rt.roomOf('r1'), original)
  await remove(h)
  await control(h, ask)
})

test('rfc0039 D3b [C] G14 candidate wiring: a drop while the gate is held gets no label', async t => {
  const h = await start(t)
  const ask = h.held('gc')
  const leave = h.rt.enterOwnership?.()
  try {
    if (leave !== undefined) assert.equal(h.rt.ownershipBusy?.(), 1)
    await remove(h)
    await control(h, ask)
  } finally { leave?.() }
  await quiet(h.rt)
})

test('rfc0039 D3b [C] G15 a reopen already started keeps the seat unlabelled', async t => {
  const h = await start(t, { bots: { d: { ...bot('d', 'Echo', 'E', 5), sessionId: 'd2', segments: [{ sessionId: 'gc' }] } } })
  const ask = h.held('gc')
  const gate = hold()
  h.holds.unarchive = id => { assert.equal(id, 'gc'); return gate.wait() }
  const opening = h.rt.switchPart('d', 'gc')
  try {
    await achieve(Promise.race([gate.entered, opening.then(() => assert.fail('reopen returned before unarchive'))]))
    busy(h.rt)
    h.rt.state.bots.d.segments = []
    await remove(h)
    await control(h, ask)
  } finally { gate.release(); await opening }
  assert.equal(h.rt.chatOf('d'), 'gc')
})

test('rfc0039 D3b [C] G16 the person answering first keeps the answer and gets no row', async t => {
  const h = await start(t)
  const ask = h.held('gc')
  assert.equal((await h.call('approval-answer', { id: idOf(ask), choice: 'allow' })).ok, true)
  assert.equal(await ask.answer, 'allowed-once')
  await remove(h)
  assert.deepEqual(reports(h), [[idOf(ask), 'web', undefined]])
  assert.deepEqual(rows(h), [])
  gone(h)
  archive(h, 'gc')
})

test('rfc0039 D3b [C] G17 a drop without the team lock labels nothing', async t => {
  const h = await start(t)
  const ask = h.held('gc')
  writeFileSync(join(h.home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other-owner' }))
  assert.equal(h.rt.holdsLock(), false)
  drop(h)
  await control(h, ask)
})

test('rfc0039 D3b [P] G18 an ask admitted during the cancel is cancelled without a label', async t => {
  const h = await start(t)
  const ask = h.held('gc')
  let late
  h.rt.onApproval((kind, data) => {
    if (kind === 'settled' && data.id === idOf(ask)) {
      h.rt.groupOwners.set('gc', { botId: 'c', roomId: 'r1' })
      late = h.held('gc', 'late')
    }
  })
  await quiet(h.rt)
  await remove(h)
  assert.ok(late)
  const admittedDuringDrop = [late]
  await cancelled([ask, ...admittedDuringDrop])
  assert.deepEqual(reports(h).slice(1), admittedDuringDrop.map(entry => report(entry)))
  assert.deepEqual(reports(h).slice(0, 1), [report(ask, 'group')], 'D3B-G18')
  assert.deepEqual(rows(h).map(row => row.id), [idOf(ask)])
})

test('rfc0039 D3b [P] G19 an epoch change between an answer and its row leaves the reason without a row', async t => {
  const h = await start(t)
  const ask = h.held('gc')
  const generation = h.rt.teamGeneration
  let ran = false
  h.rt.onApproval((kind, data) => {
    if (kind === 'settled' && data.id === idOf(ask)) {
      ran = true
      h.rt.teamGeneration = () => ({ epoch: -1, term: -1 })
    }
  })
  await quiet(h.rt)
  try { await remove(h) } finally { h.rt.teamGeneration = generation }
  assert.equal(ran, true)
  await cancelled([ask])
  assert.deepEqual(reports(h), [report(ask, 'group')], 'D3B-G19')
  assert.deepEqual(rows(h), [])
})

test('rfc0039 D3b [C] G20 a Session-owner hook that fails withholds the label', async t => {
  for (const behavior of ['throws', 'disposes', 'unexpected', 'rejects', 'adds a seat', 'replaces the room', 'loses the lock']) {
    const h = await start(t, { after: { r2: room('r2', 'Dev') } })
    const ask = h.held('gc')
    let calls = 0
    const off = h.rt.hooks.sessionOwner(id => {
      if (id !== 'gc') return
      calls += 1
      if (behavior === 'throws') throw new Error('unreadable')
      if (behavior === 'disposes') off()
      if (behavior === 'unexpected') return false
      if (behavior === 'rejects') return Promise.reject(new Error('wrong hook return type'))
      if (behavior === 'adds a seat') h.rt.roomOf('r2').sessions.c = 'gc'
      if (behavior === 'replaces the room') h.rt.state.rooms.r1 = { ...h.rt.state.rooms.r1 }
      if (behavior === 'loses the lock') writeFileSync(join(h.home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other' }))
    })
    const following = []
    const offNext = h.rt.hooks.sessionOwner(id => { following.push(id) })
    try {
      drop(h)
      if (typeof h.rt.ownershipBusy === 'function') {
        assert.equal(calls, 1, behavior)
        if (behavior === 'disposes') assert.deepEqual(following, ['gc'])
      }
      await control(h, ask)
    } finally { off(); offNext() }
  }
})

test('rfc0039 D3b [C] G21 malformed evidence counts as a reference', async t => {
  const cases = [
    [state => state.rooms.r2, 'segments', []],
    [state => state.bots.a, 'segments', [{}]],
    [state => state, 'tasks', []],
    [state => state.switching, 'x', {}],
    [state => state.switching, 'y', 'gc-old'],
    [state => state.bots, 'unrelated', { id: 7, name: 'X' }],
    [state => state.rooms, 'r3', room('r9', 'Odd')],
    [state => state.rooms.r2, 'parts', 'not a list'],
  ]
  for (const [table, key, value] of cases) {
    const h = await start(t, { after: { r2: room('r2', 'Dev') } })
    const ask = h.held('gc')
    const target = table(h.rt.state)
    target[key] = value
    assert.equal(target[key], value)
    drop(h)
    assert.deepEqual(reports(h), [report(ask)], 'D3B-G21')
    await control(h, ask)
  }
})

test('rfc0039 D3b [P] G22 a failing row keeps the reason and never stops the next cancellation', async t => {
  const h = await start(t)
  const ask = h.held('gc')
  const k = h.held('k', 'k', child('k', 'gc'))
  const warnings = t.mock.method(h.rt, 'warn', () => {})
  h.rt.onApproval((kind, data) => {
    if (kind === 'settled' && data.id === idOf(ask)) {
      h.rt.roomOf('r1').name = { toString: 7 }
    }
  })
  await quiet(h.rt)
  try { drop(h) } finally { h.rt.roomOf('r1').name = 'Ops' }
  await cancelled([ask, k])
  assert.equal(h.rt.waitsForApproval('gc'), false)
  archive(h, 'gc')
  assert.deepEqual(rows(h), [])
  assert.deepEqual(reports(h), [report(ask, 'group')], 'D3B-G22')
  const failures = warnings.mock.calls.filter(({ arguments: [message] }) => message === 'ds-bot: recording a withdrawn ask failed: %s')
  assert.equal(failures.length, 2)
  assert.ok(failures.every(({ arguments: [, error] }) => error instanceof TypeError))
})

const native = { x: { id: 'x', kind: 'dsh', name: 'Native', sessions: ['xs'], createdAt: 1 } }

test('rfc0039 D3b [C] G26 a drop during agent-adopt of its Session gets no label', async t => {
  const h = await start(t, { agents: native })
  const ask = h.held('gc')
  const gate = hold()
  h.holds.resolve = id => { if (id === 'gc') return gate.wait() }
  const adopting = h.call('agent-adopt', { agentId: 'x', sessionId: 'gc' })
  try {
    await achieve(Promise.race([gate.entered, adopting.then(() => assert.fail('adopt returned before resolve'))]))
    busy(h.rt)
    drop(h)
    await control(h, ask)
  } finally { gate.release(); assert.equal((await adopting).ok, true) }
  assert.ok(h.rt.state.agents.x.sessions.includes('gc'))
})

test('rfc0039 D3b [C] G27 the drop consults an outstanding no-note return', async t => {
  const h = await start(t)
  const ask = h.held('gc')
  const queried = []
  const original = h.rt.returnsTo
  h.rt.returnsTo = id => { queried.push(id); return id === 'gc' }
  try {
    await remove(h)
    if (typeof original === 'function') assert.deepEqual(queried, ['gc'])
    await control(h, ask)
  } finally { h.rt.returnsTo = original }
})

test('rfc0039 D3b [C] G28 a drop while an agent-adopt request is still loading gets no label', async t => {
  const h = await start(t, { agents: native })
  const ask = h.held('gc')
  const gate = hold()
  const refresh = h.rt.refresh
  let first = true
  h.rt.refresh = async (...args) => {
    if (first) { first = false; await gate.wait() }
    return refresh(...args)
  }
  const adopting = h.call('agent-adopt', { agentId: 'x', sessionId: 'gc' })
  try {
    await achieve(gate.entered)
    assert.equal(first, false)
    busy(h.rt)
    drop(h)
    await control(h, ask)
  } finally {
    h.rt.refresh = refresh
    gate.release()
    assert.equal((await adopting).ok, true)
  }
  assert.ok(h.rt.state.agents.x.sessions.includes('gc'))
})

test('rfc0039 D3b [C] G29 a drop while createBot takes an existing Session gets no label', async t => {
  const h = await start(t)
  const ask = h.held('gc')
  const gate = hold()
  h.holds.rename = session => { if (session.id === 'host-1') return gate.wait() }
  const creating = h.rt.createBot({ name: 'Host', role: 'Host', existingSessionId: 'host-1' })
  try {
    await achieve(Promise.race([gate.entered, creating.then(() => assert.fail('createBot returned before rename'))]))
    assert.equal(h.rt.botOf('host-1'), undefined)
    busy(h.rt)
    await remove(h)
    await control(h, ask)
  } finally { gate.release(); assert.equal((await creating).id, 'host-1') }
})

test('rfc0039 D3b [C] G30 ownership hooks settle asks synchronously and pending changes withhold labels', async t => {
  for (const action of ['abort', 'allow', 'cancel', 'admit']) {
    const h = await start(t)
    const ask = h.held('gc')
    const own = action === 'abort' ? h.held('a') : undefined
    let mapped, late, pending, lateAnswer
    if (own !== undefined) h.rt.onApproval((kind, data) => {
      if (kind !== 'settled' || data.id !== idOf(ask)) return
      try {
        h.rt.answerApproval(idOf(own), 'allow')
        lateAnswer = 'allowed'
      } catch (error) { lateAnswer = error.code }
    })
    const interleave = () => {
      mapped = h.rt.groupOwners.has('gc')
      if (action === 'allow') h.rt.answerApproval(idOf(ask), 'allow')
      if (action === 'abort') own.abort.abort()
      if (action === 'cancel') h.rt.cancelApprovals('gc')
      if (action === 'admit') {
        h.rt.groupOwners.set('gc', { botId: 'c', roomId: 'r1' })
        try { late = h.held('gc', 'hook') } finally { if (!mapped) h.rt.groupOwners.delete('gc') }
      }
      pending = h.rt.waitsForApproval(own?.entry.sessionId ?? 'gc')
    }
    // Base has no evidence read on drop. Give it the same decision before the live cancel.
    const candidate = typeof h.rt.ownershipBusy === 'function'
    const off = h.rt.hooks.sessionOwner(id => { if (id === 'gc') interleave() })
    try {
      if (!candidate) interleave()
      drop(h)
    } finally { off() }
    const expected = action === 'allow' ? [[idOf(ask), 'web', undefined]]
      : action === 'abort' ? [[idOf(own), 'dsh', undefined], report(ask)]
        : action === 'admit' ? [report(ask), report(late)] : [report(ask)]
    assert.deepEqual(reports(h), expected, `D3B-G30-${action}`)
    assert.deepEqual([mapped, pending], [!candidate, action === 'admit'], action)
    if (own !== undefined) assert.equal(lateAnswer, 'bot/stale')
    if (action === 'allow') assert.equal(await achieve(ask.answer), 'allowed-once')
    else await cancelled([ask, ...(own === undefined ? [] : [own]), ...(late === undefined ? [] : [late])])
    assert.deepEqual(rows(h), [])
    gone(h)
    archive(h, 'gc')
  }
})

test('rfc0039 D3b [C] G31 working_directory holds the gate through folder approval', async t => {
  const h = await start(t)
  const { rt } = h
  const ask = h.held('gc')
  const gate = hold()
  const target = join(h.home, 'new-folder')
  const work = { output: 'changed' }
  const load = rt.load
  let countAtLoad
  t.mock.method(rt, 'load', (...args) => { countAtLoad ??= rt.ownershipBusy?.(); return load(...args) })
  t.mock.method(rt, 'workDirOf', () => join(h.home, 'old-folder'))
  t.mock.method(rt, 'folderAt', async () => target)
  t.mock.method(rt, 'isFolder', async () => true)
  t.mock.method(rt, 'real', async path => path)
  t.mock.method(rt, 'workFolder', async path => path)
  const approve = t.mock.method(rt, 'approveFolder', gate.wait)
  const update = t.mock.method(rt, 'updateBot', async () => {})
  const exec = { name: 'working_directory', arguments: { cd: target }, agent: { id: 'a', session: { id: 'a' } } }
  const run = h.ctx.listeners.get('tools/execute').reduceRight((next, listener) => () => listener(exec, next), () => work)
  const moving = run()
  try {
    await achieve(Promise.race([gate.entered, moving.then(() => assert.fail('folder change returned before approval'))]))
    assert.equal(approve.mock.calls[0].arguments[1].path, target)
    assert.equal(update.mock.callCount(), 0)
    drop(h)
    assert.deepEqual(reports(h), [report(ask)], 'D3B-G31')
    if (typeof rt.ownershipBusy === 'function') assert.ok(countAtLoad > 0)
    await control(h, ask)
  } finally {
    gate.release()
    assert.equal(await achieve(moving), work)
  }
  assert.deepEqual(update.mock.calls[0].arguments.slice(0, 2), ['a', { workDir: target }])
  await quiet(rt)
})

test('rfc0039 D3b [C] G33 recovery holds the gate until a started chain settles', async t => {
  const h = await start(t)
  const { rt } = h
  const ask = h.held('gc')
  const gate = hold()
  h.holds.resolve = id => { if (id === 'b') return gate.wait() }
  rt.state.switching.b = { botId: 'b' }
  let finished = false
  const recovery = rt.heldBack().finally(() => { finished = true })
  try {
    await achieve(gate.entered)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(rt.state.switching.b, { botId: 'b' })
    drop(h)
    assert.deepEqual(reports(h), [report(ask)], 'D3B-G33')
    if (typeof rt.ownershipBusy === 'function') assert.equal(finished, false)
    await control(h, ask)
  } finally {
    gate.release()
    await achieve(recovery)
    await until(() => rt.state.switching.b === undefined, { ms: 5000 })
  }
  await quiet(rt)
})

test('rfc0039 D3b [C] G34 sparse ownership lists withhold the label', async t => {
  const cases = [
    [state => state.bots.a, 'segments'],
    [state => state.rooms.r2, 'parts'],
    [state => state.rooms.r2.segments, 'b'],
    [state => state.agents.x, 'sessions'],
    [state => state, 'subscriptionRuns'],
  ]
  for (const [table, key] of cases) {
    const h = await start(t, { after: { r2: room('r2', 'Dev', { segments: {} }) }, agents: native })
    const ask = h.held('gc')
    h.rt.state.rooms.r2.segments ??= {}
    const target = table(h.rt.state)
    target[key] = Array(1)
    assert.equal(Object.hasOwn(target[key], 0), false)
    try { drop(h) } finally { delete target[key] }
    assert.deepEqual(reports(h), [report(ask)], 'D3B-G34')
    await control(h, ask)
  }
})

test('rfc0039 D3b [C] G35 an ordinary approval propagates a note-clearing error', async t => {
  const h = await start(t)
  const request = { agent: { session: { id: 'a' } }, toolName: 'bash', signal: new AbortController().signal }
  void h.ctx.listeners.get('approval/request')[0](request, () => new Promise(() => {}))
  const ask = h.rt.approvalsView().find(entry => entry.sessionId === 'a')
  assert.equal(ask?.answerable, true)
  const failure = new Error('cannot clear the approval note')
  const note = t.mock.method(h.rt, 'noteApproval', () => { throw failure })
  try {
    assert.throws(() => h.rt.answerApproval(ask.id, 'allow'), error => error === failure, 'D3B-G35')
  } finally { note.mock.restore() }
  assert.deepEqual(reports(h), [])
  assert.equal(h.rt.waitsForApproval('a'), false)
})

test('rfc0039 D3b [C] G36 an MCP mutation holds ownership before its audit transaction refresh', async t => {
  const h = await start(t)
  const { rt } = h
  const ask = h.held('gc')
  const gate = hold()
  // Drain startup before providing the fixture token. The fetch handler can use
  // the token without asking agent access to start its HTTP listener.
  await rt.agentAccess.owner('view')
  const token = 'fixture-token'
  const hash = createHash('sha256').update(token).digest('hex')
  writeFileSync(join(h.home, 'agent-tokens.json'), JSON.stringify([{ id: 'fixture', name: 'Fixture', hash }]))
  const refresh = rt.refresh
  let refreshing = false
  const mocked = t.mock.method(rt, 'refresh', async (...args) => {
    if (!refreshing) { refreshing = true; await gate.wait() }
    return refresh(...args)
  })
  const mutation = rt.agentAccess.fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'update_bot', arguments: { id: 'a', instructions: 'MCP edit' } },
    }),
  }))
  try {
    await achieve(Promise.race([gate.entered, mutation.then(() => assert.fail('MCP mutation returned before refresh'))]))
    assert.notEqual(rt.state.bots.a.instructions, 'MCP edit')
    drop(h)
    assert.deepEqual(reports(h), [report(ask)], 'D3B-G36')
    busy(rt)
    await control(h, ask)
  } finally {
    gate.release()
    mocked.mock.restore()
    const response = await achieve(mutation)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).result.isError, false)
  }
  assert.equal(rt.state.bots.a.instructions, 'MCP edit')
  const { audit } = await rt.agentAccess.owner('view')
  assert.deepEqual(audit.filter(row => row.action === 'update_bot').map(row => row.outcome).sort(), ['allowed', 'started'])
  await quiet(rt)
})

test('rfc0039 D3b [C] G37 a losing seat creation holds its counter while opening the winner', async t => {
  const h = await start(t, { r1: { sessions: { c: 'gc' } } })
  const { rt } = h
  const gate = hold()
  const capabilities = rt.ensureCapabilities
  const create = t.mock.method(rt, 'createSession', async () => 'unused')
  const applyPermission = rt.applyPermission
  t.mock.method(rt, 'applyPermission', async (member, id, ...args) => {
    if (id !== 'unused') return applyPermission(member, id, ...args)
    assert.equal(member.id, 'b')
    rt.roomOf('r1').sessions.b = 'winner'
  })
  t.mock.method(rt, 'ensureCapabilities', (id, ...args) => id === 'winner' ? gate.wait() : capabilities(id, ...args))
  const deliver = t.mock.method(rt, 'deliver', async ({ exchangeId }) => rt.roomWaiters.get(exchangeId)?.resolve('Done'))
  const round = relay(h, AbortSignal.timeout(5000))
  try {
    await achieve(Promise.race([gate.entered, round.then(() => assert.fail('round returned before opening the winner'))]))
    assert.equal(create.mock.callCount(), 1)
    assert.equal(rt.roomOf('r1').sessions.b, 'winner')
    archive(h, 'unused')
    if (typeof rt.ownershipBusy === 'function') assert.equal(rt.ownershipBusy(), 2, 'D3B-G37')
  } finally {
    gate.release()
    await achieve(round)
  }
  assert.equal(deliver.mock.calls[0].arguments[0].sessionId, 'winner')
  await quiet(rt)
})

test('rfc0039 D3b [C] G38 working_directory holds the gate from the tool guard through its permission retry', async t => {
  const h = await start(t)
  const { rt } = h
  const ask = h.held('gc')
  const gate = hold()
  const folder = join(h.home, 'folder')
  const target = join(folder, 'nested')
  const exec = { name: 'working_directory', arguments: { cd: target }, agent: { id: 'a', session: { id: 'a' } } }
  const wanted = 'workspace-write'
  const failed = new Error('the Session log refused the write')
  let level = 'danger-full-access'
  let offline = true
  h.ctx.provided.set('permissionPresets', {
    catalog: () => ({ options: [{ value: wanted }] }),
    current: () => level,
    set(_session, nextLevel) { if (offline) throw failed; level = nextLevel },
  })
  rt.botOf('a').permission = wanted
  await assert.rejects(rt.applyPermission(rt.botOf('a'), 'a', undefined, exec.agent.session), error => error === failed)
  assert.equal(rt.levelHeld('a'), true)
  offline = false
  rt.levelRetryMs = 0

  const assertShellChoice = rt.assertShellChoice
  let countAtShellChoice
  t.mock.method(rt, 'assertShellChoice', (...args) => {
    countAtShellChoice ??= rt.ownershipBusy?.()
    return assertShellChoice(...args)
  })
  const load = rt.load
  t.mock.method(rt, 'load', async (...args) => {
    if (rt.levelHeld('a')) await gate.wait()
    return load(...args)
  })
  t.mock.method(rt, 'workDirOf', () => folder)
  t.mock.method(rt, 'folderAt', async () => target)
  t.mock.method(rt, 'isFolder', async () => true)
  t.mock.method(rt, 'workFolder', async path => path)
  const work = { output: 'changed' }
  const execute = t.mock.fn(() => work)
  const run = h.ctx.listeners.get('tools/execute').reduceRight((next, listener) => () => listener(exec, next), execute)
  const moving = run()
  try {
    await achieve(Promise.race([gate.entered, moving.then(() => assert.fail('folder change ran before the permission retry'))]))
    assert.equal(rt.levelHeld('a'), true)
    assert.equal(execute.mock.callCount(), 0)
    assert.equal(rt.teamCurrent(), true)
    drop(h)
    assert.deepEqual(reports(h), [report(ask)], 'D3B-G38')
    if (typeof rt.ownershipBusy === 'function') assert.ok(countAtShellChoice > 0, 'D3B-G38-shell')
    await control(h, ask)
  } finally {
    gate.release()
    assert.equal(await achieve(moving), work)
  }
  assert.equal(level, wanted)
  assert.equal(rt.levelHeld('a'), false)
  assert.equal(execute.mock.callCount(), 1)
  await quiet(rt)
})

test('rfc0039 D3b [C] G39 pre-step holds the gate before the sign-in matcher reads the batch', async t => {
  const h = await start(t)
  const ask = h.held('gc')
  h.rt.botOf('a').sessionPinned = true
  const message = 'sign-in response'
  const loginTextMatches = t.mock.fn(text => {
    if (text !== message) return false
    drop(h)
    return true
  })
  h.ctx.provided.set('acpAgents', { loginTextMatches })
  const payload = { agent: { id: 'a', session: { id: 'a' } }, messages: [{ role: 'user', content: message }], signal: new AbortController().signal }
  const result = { kind: 'reject' }
  const nextStep = t.mock.fn(() => result)
  const run = h.ctx.listeners.get('agent/pre-step').reduceRight((next, listener) => () => listener(payload, next), nextStep)
  assert.equal(await run(), result)
  assert.equal(nextStep.mock.callCount(), 1)
  assert.equal(loginTextMatches.mock.callCount(), 1)
  assert.deepEqual(payload.messages, [])
  assert.deepEqual(reports(h), [report(ask)], 'D3B-G39')
  await control(h, ask)
  await quiet(h.rt)
})

test('rfc0039 D3b [C] G40 restoring current Sessions holds the gate across queued unarchives', async t => {
  const h = await start(t)
  const ask = h.held('gc')
  const first = hold()
  const last = hold()
  const registry = h.ctx.workspaceRegistry
  let countAtSnapshot
  Object.defineProperty(registry, 'archivedSessionIds', {
    get() {
      countAtSnapshot ??= h.rt.ownershipBusy?.()
      return ['a', 'gc']
    },
  })
  const unarchived = []
  h.holds.unarchive = async id => {
    if (id === 'a') await first.wait()
    if (id === 'gc') await last.wait()
    unarchived.push(id)
  }
  try {
    await h.rt.save()
    await achieve(first.entered)
    assert.equal(h.rt.teamCurrent(), true)
    assert.deepEqual(unarchived, [])
    drop(h)
    assert.deepEqual(reports(h), [report(ask)], 'D3B-G40')
    if (typeof h.rt.ownershipBusy === 'function') assert.ok(countAtSnapshot > 0, 'D3B-G40-snapshot')
    await control(h, ask)

    first.release()
    await achieve(last.entered)
    assert.deepEqual(unarchived, ['a'])
    if (typeof h.rt.ownershipBusy === 'function') assert.ok(h.rt.ownershipBusy() > 0, 'D3B-G40-last')
  } finally {
    first.release()
    last.release()
    await until(() => unarchived.includes('gc'), { ms: 5000 })
    await quiet(h.rt)
  }
  assert.deepEqual(unarchived, ['a', 'gc'])
})

test('rfc0039 D3b [C] G41 archiving a current Session queues a gated unarchive', async t => {
  const h = await start(t)
  const ask = h.held('gc')
  const archive = Promise.withResolvers()
  const unarchive = hold()
  const assertShellChoice = h.rt.assertShellChoice
  let countAtOwnerRead
  t.mock.method(h.rt, 'assertShellChoice', (...args) => {
    countAtOwnerRead ??= h.rt.ownershipBusy?.()
    return assertShellChoice(...args)
  })
  h.holds.unarchive = async id => {
    assert.equal(id, 'a')
    await archive.promise
    await unarchive.wait()
  }
  const activity = t.mock.fn(() => ({ active: false }))
  const checkActivity = h.ctx.listeners.get('workspace/session-activity').reduceRight(
    (next, listener) => () => listener({ sessionId: 'a' }, next), activity)
  try {
    assert.deepEqual(await achieve(checkActivity()), { active: false })
    assert.equal(activity.mock.callCount(), 1)
    archive.resolve()
    await achieve(unarchive.entered)
    assert.equal(h.rt.teamCurrent(), true)
    drop(h)
    assert.deepEqual(reports(h), [report(ask)], 'D3B-G41')
    if (typeof h.rt.ownershipBusy === 'function') assert.ok(countAtOwnerRead > 0)
    await control(h, ask)
  } finally {
    archive.resolve()
    unarchive.release()
    await quiet(h.rt)
  }
})

const toolPhase = (ctx, phase, exec, tail) => (ctx.listeners.get(phase) ?? []).reduceRight(
  (next, listener) => () => listener(exec, next), tail)()

test('rfc0039 D3b [C] G42 working_directory holds the gate during DSH pre-execute approval', async t => {
  const h = await start(t)
  const { rt, ctx } = h
  const ask = h.held('gc')
  const target = join(h.home, 'target')
  const exec = { name: 'working_directory', callId: 'folder-change', arguments: { cd: target }, agent: { id: 'a', session: { id: 'a' } } }
  t.mock.method(rt, 'workDirOf', () => h.home + '-previous')
  t.mock.method(rt, 'folderAt', async () => target)
  t.mock.method(rt, 'isFolder', async () => true)
  t.mock.method(rt, 'workFolder', async path => path)
  t.mock.method(rt, 'approveFolder', async () => {})
  const update = t.mock.method(rt, 'updateBot', async () => {})
  const execute = t.mock.fn(() => ({ output: 'changed' }))

  // DSH handles `ask` after the pre-execute waterfall and dispatches only on allow.
  const decision = { kind: 'ask', reason: 'override Auto review' }
  let countAtPreExecute
  let approval
  try {
    const prepare = () => { countAtPreExecute = rt.ownershipBusy?.(); return decision }
    assert.equal(await achieve(toolPhase(ctx, 'tools/pre-execute', exec, prepare)), decision)
    approval = h.held('a', exec.callId, { toolName: exec.name, reason: decision.reason })
    assert.equal(rt.waitsForApproval('a'), true)
    assert.equal(execute.mock.callCount(), 0)
    assert.equal(rt.teamCurrent(), true)
    drop(h)
    assert.deepEqual(reports(h), [report(ask)], 'D3B-G42')
    if (typeof rt.ownershipBusy === 'function') assert.ok(countAtPreExecute > 0)
    await control(h, ask)

    rt.answerApproval(approval.entry.id, 'allow')
    assert.equal(await achieve(approval.answer), 'allowed-once')
    busy(rt)
    assert.deepEqual(await achieve(toolPhase(ctx, 'tools/execute', exec, execute)), { output: 'changed' })
    assert.equal(execute.mock.callCount(), 1)
    assert.deepEqual(update.mock.calls[0].arguments.slice(0, 2), ['a', { workDir: target }])
  } finally {
    approval?.abort.abort()
    ctx.emit('tools/result', exec)
    await quiet(rt)
  }
})

for (const [tag, name] of [['G43', 'update_bot'], ['G44', 'update_group']]) {
  test(`rfc0039 D3b [C] ${tag} ${name} with work_dir holds the gate during the permission retry`, async t => {
    const previous = '/previous-workspace'
    const h = await start(t, { after: { r2: room('r2', 'Dev') } })
    const { rt, ctx } = h
    const ask = h.held('gc')
    const gate = hold()
    const args = name === 'update_bot' ? { bot: 'Writer', work_dir: '' } : { group: 'Dev', work_dir: '' }
    const target = name === 'update_bot' ? rt.botOf('b') : rt.roomOf('r2')
    target.workDir = previous
    const exec = { name, arguments: args, agent: { id: 'a', session: { id: 'a' } } }
    const wanted = 'workspace-write'
    const failure = new Error('the Session log refused the write')
    let level = 'danger-full-access'
    let offline = true
    ctx.provided.set('permissionPresets', {
      catalog: () => ({ options: [{ value: wanted }] }),
      current: () => level,
      set(_session, nextLevel) { if (offline) throw failure; level = nextLevel },
    })
    rt.botOf('a').permission = wanted
    await assert.rejects(rt.applyPermission(rt.botOf('a'), 'a', undefined, exec.agent.session), error => error === failure)
    assert.equal(rt.levelHeld('a'), true)
    offline = false
    rt.levelRetryMs = 0

    const assertShellChoice = rt.assertShellChoice
    let countAtOwnerRead
    t.mock.method(rt, 'assertShellChoice', (...params) => {
      countAtOwnerRead ??= rt.ownershipBusy?.()
      return assertShellChoice(...params)
    })
    const load = rt.load
    t.mock.method(rt, 'load', async (...params) => {
      if (rt.levelHeld('a')) await gate.wait()
      return load(...params)
    })
    const execute = t.mock.fn(() => h.tool(name, args, 'a', exec))
    const moving = toolPhase(ctx, 'tools/execute', exec, execute)
    try {
      await achieve(Promise.race([gate.entered, moving.then(() => assert.fail('folder edit ran before the permission retry'))]))
      assert.equal(rt.levelHeld('a'), true)
      assert.equal(execute.mock.callCount(), 0)
      assert.equal(target.workDir, previous)
      assert.equal(rt.teamCurrent(), true)
      drop(h)
      assert.deepEqual(reports(h), [report(ask)], 'D3B-' + tag)
      if (typeof rt.ownershipBusy === 'function') assert.ok(countAtOwnerRead > 0)
      await control(h, ask)
    } finally {
      gate.release()
      assert.match(await achieve(moving), /^Updated /)
      await quiet(rt)
    }
    assert.equal(execute.mock.callCount(), 1)
    assert.equal(level, wanted)
    assert.equal(rt.levelHeld('a'), false)
    assert.equal(target.workDir, undefined)
  })
}
