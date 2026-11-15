// A saved permission level DSH no longer offers (#1001, option C). The level stays saved. A
// Session that already runs is lowered to the narrowest level DSH still offers only when that
// is proven to narrow it; one whose level cannot be compared is left as it was, as before; a
// start is refused, as before, and nothing is lowered in its place. The team runs over a fake
// DSH presets service; no step leans on a fixed sleep.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { HELD_NOT_SET } from '../src/shared/held.js'
import { fakeContext } from './fake-ctx.js'
import { afterRound } from './relay-rows.js'

const FULL = 'danger-full-access'
const WRITE = 'workspace-write'
const GONE = 'legacy-level'
const SPECS = {
  'read-only': { sandbox: 'read-only', approval: 'ask' },
  [WRITE]: { sandbox: 'workspace-write', approval: 'ask' },
  auto: { sandbox: 'danger-full-access', approval: 'ask' },
  [FULL]: { sandbox: 'danger-full-access', approval: 'never' },
  odd: { sandbox: 'elsewhere', approval: 'ask' },
}
const NOT_OFFERED = 'The saved permission level is no longer offered, so nothing was started. Pick a permission level again.'
const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', name: 'Omni', role: '', instructions: '', createdAt: 1 },
    b2: { id: 'b2', name: 'Ada', role: '', instructions: '', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Launch', named: true, members: ['m1', 'b2'], mode: 'everyone', notice: '', sessions: { m1: 'g1' }, seq: 0, log: [] } },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

// `offered`: the levels DSH offers, in order. `levels`: what DSH reports for a Session.
// `born`: what a new Session reads. `acp`: collects the agent sessions ended, keeps the gate.
function team(t, { offered = [WRITE, FULL], bots = {}, room = {}, tasks, levels = {}, born, defaultPreset = WRITE, home: at } = {}) {
  const home = at ?? mkdtempSync(join(tmpdir(), 'ds-bot-level-gone-'))
  const statePath = join(home, 'state.json')
  if (at === undefined) writeFileSync(statePath, JSON.stringify({ ...TEAM, bots: { m1: { ...TEAM.bots.m1, ...bots.m1 }, b2: { ...TEAM.bots.b2, ...bots.b2 } }, rooms: { r1: { ...TEAM.rooms.r1, ...room } }, ...(tasks ? { tasks } : {}) }))
  const log = []
  const open = new Set()
  const presetOf = new Map(Object.entries(levels))
  const ended = []
  let gate
  const service = {
    offered: [...offered],
    specs: { ...SPECS },
    // `<session>` or `<session>:<level>`: a set that fails there.
    failing: new Set(),
    unreadable: new Set(),
    catalog: () => ({ options: service.offered.map(value => ({ value, name: value })), defaultOptions: [], defaultPreset }),
    resolve: (name) => {
      if (!service.offered.includes(name)) throw new Error(`permission: unknown preset "${name}"`)
      return service.specs[name]
    },
    current: (session) => {
      if (service.unreadable.has(session.id)) throw new Error('permission: not readable')
      return presetOf.get(session.id)
    },
    set: (session, name) => {
      service.resolve(name)
      if (service.failing.has(session.id) || service.failing.has(`${session.id}:${name}`)) throw new Error('permission: not ready')
      log.push(`${session.id} preset ${name}`)
      presetOf.set(session.id, name)
    },
  }
  const acpAgents = { endSession: (sessionId) => { ended.push(sessionId) }, holdTurns: (held) => { gate = held; return () => {} } }
  const ctx = fakeContext({ services: { permissionPresets: service, acpAgents } })
  let sessions = 0
  const announce = (session) => { for (const listener of ctx.listeners.get('session/created') ?? []) void Promise.resolve(listener(session)).catch(() => {}) }
  const inboxes = new Map()
  const inboxOf = (sessionId) => {
    if (!inboxes.has(sessionId)) inboxes.set(sessionId, { nextTurn: [], nextStep: [], remove: () => true })
    return inboxes.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }], listModels: async () => [{ id: 'deepseek-v4-flash' }], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => ({ id: 'w1', path: home }),
      resolveByPath: async path => ({ id: 'w1', path }),
      create: async path => ({ id: 'w1', path }),
      archiveSession: async (sessionId) => { log.push(`${sessionId} archived`) },
    },
    sessionController: {
      async create() {
        const sessionId = `s${++sessions}`
        open.add(sessionId)
        if (born !== undefined) presetOf.set(sessionId, born)
        announce({ id: sessionId })
        return { sessionId }
      },
      async resolveAgent(sessionId) {
        const session = { id: sessionId }
        if (!open.has(sessionId)) {
          open.add(sessionId)
          announce(session)
        }
        await new Promise(resolve => setTimeout(resolve, 1))
        // Enough of an agent for a fresh part to be made from it (parts.js moveOn).
        return { agent: { id: sessionId, session: Object.assign(session, { deriveMessages: () => [], requestHeader: () => undefined }), inbox: inboxOf(sessionId), followup() {}, whenIdle: async () => {}, runMaintenance: job => job(new AbortController().signal) } }
      },
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async (session) => { log.push(`${session.id} first turn`) }, list: () => [...open].map(id => ({ id })), get: () => undefined },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  apply(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    if (at === undefined) rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const rt = ctx.provided.get('omniTeam')
  t.mock.method(rt, 'warn', () => {})
  rt.levelRetryMs = 0
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const sets = sessionId => log.filter(line => line.startsWith(`${sessionId} preset `)).map(line => line.split(' preset ')[1])
  // DSH opens a Session it then lists, and the team has taken its level again when this returns.
  const opens = async (sessionId) => {
    open.add(sessionId)
    await Promise.all((ctx.listeners.get('session/created') ?? []).map(listener => Promise.resolve(listener({ id: sessionId })).catch(() => {})))
  }
  // DSH's catalog changed: every loaded Session takes its level again.
  const changed = () => Promise.all((ctx.listeners.get('permission-presets/catalog-changed') ?? []).map(listener => listener()))
  const tool = (sessionId, body = async () => 'ran', header) => ctx.listeners.get('tools/execute')[0]({ name: 'bash', arguments: {}, agent: { id: sessionId, session: { id: sessionId, ...(header ? { header } : {}) } } }, body)
  const turn = sessionId => gate({ agent: { id: sessionId, session: { id: sessionId } } })
  const saved = () => JSON.parse(readFileSync(statePath, 'utf8'))
  // The person writes in the group, and its round runs to the end.
  const round = async (roomId, text) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) await listener({ id: roomId }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
    // The relay's own result names where its rows start; the round runs on, and its rows are read as the chat does.
    return afterRound(rt, roomId, await ctx.registeredTools.get('group_relay').execute({}, { agent: { id: roomId, inbox: inboxOf(roomId) }, callId: 'round-1', signal: new AbortController().signal }))
  }
  const view = async () => (await call('state', {})).value
  return { ctx, rt, home, service, call, log, sets, opens, changed, tool, turn, ended, saved, view, round, levelOf: id => presetOf.get(id), made: () => sessions }
}
const refused = /could not be set on this conversation, so no tool runs here/

test('a conversation that runs wider is lowered to the narrowest level still offered, and the level stays saved', async (t) => {
  const { rt, call, sets, opens, tool, saved, levelOf } = team(t, { bots: { m1: { permission: GONE } }, levels: { m1: FULL } })
  await call('state', {})
  await opens('m1')
  assert.deepEqual(sets('m1'), [WRITE])
  assert.equal(levelOf('m1'), WRITE)
  assert.equal(await tool('m1'), 'ran')
  assert.equal(rt.unappliedSessions().length, 0)
  // The person's choice is not rewritten, in memory or on disk.
  assert.equal(rt.botOf('m1').permission, GONE)
  await rt.save()
  assert.equal(saved().bots.m1.permission, GONE)
  // Opened again it is already no wider: nothing more is set.
  await opens('m1')
  assert.deepEqual(sets('m1'), [WRITE])
})

test('a conversation already no wider than the narrowest level is left as it is', async (t) => {
  const { call, sets, opens, tool, levelOf } = team(t, { offered: ['read-only', WRITE, FULL], bots: { m1: { permission: GONE }, b2: { permission: GONE } }, levels: { m1: 'read-only', b2: WRITE } })
  await call('state', {})
  await opens('m1')
  await opens('b2')
  assert.deepEqual(sets('m1'), [])
  // Wider than the narrowest by one step: lowered.
  assert.deepEqual(sets('b2'), ['read-only'])
  assert.equal(levelOf('m1'), 'read-only')
  assert.equal(await tool('m1'), 'ran')
})

test('a conversation whose level cannot be compared is never set to the fallback', async (t) => {
  // It still reads the dropped level, which DSH no longer resolves; the narrowest level DSH
  // offers now is full access. Nothing proves that allows no more: it keeps what it has.
  const dropped = team(t, { offered: [FULL], bots: { m1: { permission: GONE } }, levels: { m1: GONE }, defaultPreset: FULL })
  await dropped.call('state', {})
  await dropped.opens('m1')
  assert.deepEqual(dropped.sets('m1'), [])
  assert.equal(dropped.levelOf('m1'), GONE)
  assert.equal(await dropped.tool('m1'), 'ran')
  assert.equal(dropped.rt.unappliedSessions().length, 0)

  // DSH reports no level, or reading it throws, under an ordinary catalog: the same.
  const blind = team(t, { bots: { m1: { permission: GONE }, b2: { permission: GONE } }, levels: { b2: FULL } })
  await blind.call('state', {})
  blind.service.unreadable.add('b2')
  await blind.opens('m1')
  await blind.opens('b2')
  assert.deepEqual([blind.sets('m1'), blind.sets('b2')], [[], []])
  assert.equal(await blind.tool('m1'), 'ran')
  assert.equal(await blind.tool('b2'), 'ran')

  // No offered level can be ranked: nothing is set, nothing is held.
  const odd = team(t, { offered: ['odd'], bots: { m1: { permission: GONE } }, levels: { m1: 'odd' }, defaultPreset: 'odd' })
  await odd.call('state', {})
  await odd.opens('m1')
  assert.deepEqual(odd.sets('m1'), [])
  assert.equal(await odd.tool('m1'), 'ran')
})

test('a narrower level that cannot be set holds the conversation until it can', async (t) => {
  const { ctx, call, service, sets, opens, tool, turn, ended, levelOf, rt } = team(t, { bots: { m1: { permission: GONE } }, levels: { m1: FULL } })
  await call('state', {})
  service.failing.add('m1')
  await opens('m1')
  assert.deepEqual(sets('m1'), [])
  assert.equal(levelOf('m1'), FULL)
  assert.deepEqual(rt.unappliedSessions(), ['m1'])
  assert.ok(ended.includes('m1'))
  let ran = false
  await assert.rejects(tool('m1', async () => { ran = true }), refused)
  assert.equal(ran, false)
  assert.equal(await turn('m1'), HELD_NOT_SET)
  // A subagent child works under it: held too.
  ctx.sessions.get = id => (id === 'child' ? { header: { origin: 'subagent', parentSession: 'm1' } } : undefined)
  await assert.rejects(tool('child', async () => { ran = true }), refused)
  // Its level stops being readable: it was wider, so the hold stays.
  service.unreadable.add('m1')
  await assert.rejects(tool('m1', async () => { ran = true }), refused)
  assert.equal(ran, false)
  assert.deepEqual(rt.unappliedSessions(), ['m1'])
  // Readable and settable again: the next call lowers it, and it runs.
  service.unreadable.clear()
  service.failing.clear()
  assert.equal(await tool('m1'), 'ran')
  assert.deepEqual(sets('m1'), [WRITE])
  assert.equal(await turn('m1'), undefined)
  assert.equal(rt.unappliedSessions().length, 0)
})

test('Auto as the narrowest level: taken while it holds, and held when it and its fallback fail', async (t) => {
  const holds = team(t, { offered: ['auto', FULL], bots: { m1: { permission: GONE } }, levels: { m1: FULL }, defaultPreset: FULL })
  await holds.call('state', {})
  await holds.opens('m1')
  assert.deepEqual(holds.sets('m1'), ['auto'])
  // Auto cannot be set, and the workspace-write it would run as is not offered here.
  const fails = team(t, { offered: ['auto', FULL], bots: { m1: { permission: GONE } }, levels: { m1: FULL }, defaultPreset: FULL })
  await fails.call('state', {})
  fails.service.failing.add('m1:auto')
  await fails.opens('m1')
  assert.deepEqual(fails.sets('m1'), [])
  assert.deepEqual(fails.rt.unappliedSessions(), ['m1'])
  await assert.rejects(fails.tool('m1'), refused)
})

test('a group\'s level and a task follow the same rule', async (t) => {
  const tasks = { t1: { title: 'Task', from: 'b2', at: 1, status: 'working' } }
  const { call, sets, opens, tool } = team(t, { bots: { b2: { permission: GONE } }, room: { permission: GONE }, tasks, levels: { g1: FULL, t1: FULL, m1: FULL } })
  await call('state', {})
  await opens('g1')
  await opens('t1')
  await opens('m1')
  assert.deepEqual(sets('g1'), [WRITE])
  assert.deepEqual(sets('t1'), [WRITE])
  // The member's own chat is not the group's: it has no saved level, and nothing is set.
  assert.deepEqual(sets('m1'), [])
  assert.equal(await tool('g1'), 'ran')
  assert.equal(await tool('t1'), 'ran')
})

test('a start is refused as before, and nothing is lowered in its place', async (t) => {
  // A new Session reads full access, which the fallback would lower: it is not touched.
  const { rt, call, log, sets, made, opens, round } = team(t, { bots: { m1: { permission: GONE } }, room: { permission: GONE, sessions: {} }, born: FULL, defaultPreset: FULL })
  await call('state', {})
  await assert.rejects(rt.startTask({ title: 'Wish', text: 'Do it', from: 'm1' }), { message: NOT_OFFERED })
  const [[taskId, task]] = Object.entries(rt.state.tasks)
  assert.equal(task.status, 'failed')
  assert.deepEqual(sets(taskId), [])
  assert.equal(log.includes(`${taskId} first turn`), false)
  assert.ok(log.includes(`${taskId} archived`))
  // DSH announcing the task's Session again once it is a task, before its start is decided,
  // lowers nothing either.
  const save = rt.save
  let announced = 0
  rt.save = async (...args) => {
    const working = Object.entries(rt.state.tasks).find(([, entry]) => entry.status === 'working')
    if (working !== undefined && announced === 0) {
      announced += 1
      await opens(working[0])
    }
    return save(...args)
  }
  await assert.rejects(rt.startTask({ title: 'Wish', text: 'Do it', from: 'm1' }), { message: NOT_OFFERED })
  rt.save = save
  assert.equal(announced, 1)
  for (const [id] of Object.entries(rt.state.tasks)) assert.deepEqual(sets(id), [], id)
  // The members' first turn in the group: refused before a Session is made for either,
  // and the group says why each is silent.
  const before = made()
  const result = await round('r1', 'Report in')
  assert.deepEqual(result.replies.filter(reply => reply.kind === 'failed').map(reply => [reply.name, reply.code, reply.text]).sort(), [['Ada', 'PERMISSION', NOT_OFFERED], ['Omni', 'PERMISSION', NOT_OFFERED]])
  assert.equal(made(), before, 'no Session was made')
  assert.deepEqual(rt.roomOf('r1').sessions ?? {}, {})
})

test('picking a level again settles it, and a level DSH offers again comes back by itself', async (t) => {
  const { rt, call, service, sets, opens, changed, view } = team(t, { bots: { m1: { permission: GONE }, b2: { permission: GONE } }, levels: { m1: FULL, b2: FULL } })
  await call('state', {})
  await opens('m1')
  await opens('b2')
  assert.deepEqual([sets('m1'), sets('b2')], [[WRITE], [WRITE]])
  // Picked again: applied, and the view says no more.
  assert.equal((await call('update-bot', { id: 'm1', permission: FULL })).ok, true)
  assert.equal(sets('m1').at(-1), FULL)
  assert.equal((await view()).bots.find(bot => bot.id === 'm1').permissionNotOffered, undefined)
  // DSH offers the saved level again: the loaded conversation takes it, with no pick.
  service.offered.push(GONE)
  service.specs[GONE] = SPECS[FULL]
  await changed()
  assert.equal(sets('b2').at(-1), GONE)
  assert.equal(rt.botOf('b2').permission, GONE)
  assert.equal((await view()).bots.find(bot => bot.id === 'b2').permissionNotOffered, undefined)
  // And dropped again: it reads the dropped level, which cannot be compared, so it is left.
  service.offered.pop()
  await changed()
  assert.equal(sets('b2').at(-1), GONE)
  assert.equal((await view()).bots.find(bot => bot.id === 'b2').permissionNotOffered, true)
})

test('the view tells the saved level is not offered, and what the Bot\'s chat runs as now', async (t) => {
  const { rt, call, service, opens, view } = team(t, { bots: { m1: { permission: GONE }, b2: { permission: WRITE } }, room: { permission: GONE }, levels: { m1: FULL } })
  await call('state', {})
  await opens('m1')
  const first = await view()
  const bot = id => first.bots.find(entry => entry.id === id)
  assert.deepEqual([bot('m1').permission, bot('m1').permissionNotOffered, bot('m1').permissionRuns], [GONE, true, WRITE])
  assert.deepEqual([bot('b2').permissionNotOffered, bot('b2').permissionRuns], [undefined, undefined])
  // A group's members each have their own: it names no level.
  const room = first.rooms.find(entry => entry.id === 'r1')
  assert.deepEqual([room.permission, room.permissionNotOffered, room.permissionRuns], [GONE, true, undefined])
  // A catalog that cannot be read shows nothing gone: only a level shown not to be offered counts.
  const catalog = service.catalog
  service.catalog = () => { throw new Error('permission: the catalog could not be read') }
  assert.deepEqual(rt.permissionFallbackOf('bot', rt.botOf('m1')), {})
  service.catalog = catalog
  // With no level offered at all the fact is still told.
  service.offered.length = 0
  const empty = await view()
  assert.equal(empty.bots.find(entry => entry.id === 'm1').permissionNotOffered, true)
  assert.deepEqual(empty.permissions.options, [])
})

test('a saved Auto, and a team without DSH\'s levels, are not told as a level no longer offered', async (t) => {
  const auto = team(t, { bots: { m1: { permission: 'auto' } }, levels: { m1: FULL } })
  await auto.call('state', {})
  await auto.opens('m1')
  const bot = (await auto.view()).bots.find(entry => entry.id === 'm1')
  assert.equal(bot.permissionNotOffered, undefined)
  // Its own fallback, as before: workspace-write.
  assert.deepEqual(auto.sets('m1'), [WRITE])
  assert.equal(bot.permissionFallback, WRITE)
})

test('the diagnostics answer carries what became of each conversation, as a fixed value', async (t) => {
  const { rt, ctx, call, service, opens } = team(t, {
    offered: ['read-only', WRITE, FULL],
    bots: { m1: { permission: GONE }, b2: { permission: GONE } },
    room: { permission: GONE, sessions: { m1: 'g1', b2: 'g2' } },
    levels: { m1: FULL, b2: 'read-only', g1: GONE, g2: FULL },
  })
  await call('state', {})
  service.failing.add('g2')
  for (const id of ['m1', 'b2', 'g1', 'g2']) await opens(id)
  const spies = [t.mock.method(rt, 'refresh'), t.mock.method(rt, 'load'), t.mock.method(rt, 'save'), t.mock.method(rt, 'resolveAgent'), t.mock.method(ctx.sessionController, 'resolveAgent'), t.mock.method(ctx.sessionController, 'create')]
  const sets = service.set
  let wrote = 0
  service.set = (...args) => { wrote += 1; return sets(...args) }
  const report = (await call('diagnostics-permissions', {})).value
  for (const spy of spies) assert.equal(spy.mock.callCount(), 0)
  assert.equal(wrote, 0)
  const of = (kind, botId) => report.sessions.find(row => row.kind === kind && row.botId === botId).notOffered
  assert.deepEqual([of('chat', 'm1'), of('chat', 'b2'), of('group', 'm1'), of('group', 'b2')], ['narrowed', 'kept', 'unknown', 'held'])
  // The dropped level leaves as `custom`, never by its name; the held row carries its mark.
  assert.doesNotMatch(JSON.stringify(report), new RegExp(GONE))
  assert.notEqual(report.sessions.find(row => row.kind === 'group' && row.botId === 'b2').unapplied, undefined)
  // A value the host does not list never leaves.
  t.mock.method(rt, 'permissionFactsOf', () => ({ kind: 'chat', source: 'bot', botId: 'm1', saved: GONE, gone: '/home/alice/secret' }))
  const odd = (await call('diagnostics-permissions', {})).value
  assert.ok(odd.sessions.length > 0)
  assert.ok(odd.sessions.every(row => !Object.hasOwn(row, 'notOffered')))
})

test('the windows learn of it: the key changes with what a level allows and with each outcome', async (t) => {
  const { rt, call, service, opens } = team(t, { offered: ['read-only', WRITE, FULL], bots: { m1: { permission: GONE } }, levels: { m1: FULL } })
  await call('state', {})
  const start = rt.permissionKey()
  await opens('m1')
  const lowered = rt.permissionKey()
  assert.notEqual(lowered, start, 'a conversation was lowered')
  // A preset keeps its name and changes what it allows: the narrowest offered is another now.
  service.specs = { ...service.specs, 'read-only': SPECS[FULL] }
  assert.notEqual(rt.permissionKey(), lowered)
})

test('after a restart the saved level is as it was, and the same rule holds', async (t) => {
  const first = team(t, { bots: { m1: { permission: GONE } }, levels: { m1: FULL } })
  await first.call('state', {})
  await first.opens('m1')
  await first.rt.save()
  const file = first.saved()
  // What the previous version reads: the level by its name, and no field it does not know.
  assert.equal(file.bots.m1.permission, GONE)
  assert.doesNotMatch(JSON.stringify(file), /permissionNotOffered|permissionRuns|"gone"|narrowed/)
  await first.ctx.dispose()
  // A new host on the same team: the Session reads full access again, and is lowered again.
  const second = team(t, { home: first.home, levels: { m1: FULL } })
  await second.call('state', {})
  assert.equal(second.rt.botOf('m1').permission, GONE)
  await second.opens('m1')
  assert.deepEqual(second.sets('m1'), [WRITE])
})

test('a lowered conversation is not read as Full access, and a gone level is not taken for one', async (t) => {
  // The rule that keeps a Full access Session on its coding CLI (#1039) reads the level.
  const { rt, call, opens } = team(t, { bots: { m1: { permission: GONE }, b2: { permission: GONE } }, levels: { m1: FULL } })
  await call('state', {})
  assert.equal(rt.sessionWide('m1', { id: 'm1' }), true, 'before it is lowered it reads full access')
  await opens('m1')
  assert.equal(rt.sessionWide('m1', { id: 'm1' }), false)
  // With no Session in hand it goes by the saved level, which DSH cannot resolve: not wide.
  assert.equal(rt.sessionWide('b2'), false)
  assert.equal(rt.sessionWide('fresh', undefined, { bot: rt.botOf('b2') }), false)
})

test('a start refused on a held conversation keeps it held', async (t) => {
  // A Bot whose greeting waits, at a saved level that is gone; its chat reads full access and
  // the narrower level could not be set, so it is held.
  const { rt, call, service, sets, opens, tool, turn, levelOf } = team(t, {
    bots: { m1: { permission: GONE, model: 'deepseek/deepseek-v4-flash', kickoff: { text: 'Hello', from: null } } },
    levels: { m1: FULL },
  })
  await call('state', {})
  service.failing.add('m1')
  await opens('m1')
  assert.deepEqual(rt.unappliedSessions(), ['m1'])
  // The greeting is tried again, as a change to the Bot does: refused, and still held.
  await assert.rejects(rt.applyPermission(rt.botOf('m1'), 'm1', undefined, undefined, { start: true }), { message: NOT_OFFERED })
  assert.deepEqual(rt.unappliedSessions(), ['m1'])
  await call('update-bot', { id: 'm1', role: 'Planner' })
  assert.notEqual(rt.botOf('m1').kickoff, undefined, 'the greeting stays held')
  assert.deepEqual(rt.unappliedSessions(), ['m1'])
  assert.equal(levelOf('m1'), FULL)
  let ran = false
  await assert.rejects(tool('m1', async () => { ran = true }), refused)
  assert.equal(ran, false)
  assert.equal(await turn('m1'), HELD_NOT_SET)
  assert.deepEqual(sets('m1'), [])
})

test('a start that fails on the way leaves no flag: the Session is lowered later as any other', async (t) => {
  for (const failing of ['save', 'resolveAgent']) {
    const { rt, service, call, sets, changed } = team(t, { bots: { m1: { permission: WRITE } }, born: FULL, defaultPreset: FULL })
    await call('state', {})
    const real = rt[failing]
    let failed = 0
    rt[failing] = async (...args) => {
      const working = Object.values(rt.state.tasks ?? {}).some(task => task.status === 'working')
      if (working && failed === 0) {
        failed += 1
        throw new Error(`${failing} failed`)
      }
      return real(...args)
    }
    await assert.rejects(rt.startTask({ title: 'Wish', text: 'Do it', from: 'm1' }), new RegExp(`${failing} failed`), failing)
    rt[failing] = real
    assert.equal(failed, 1, failing)
    const [[taskId]] = Object.entries(rt.state.tasks)
    assert.deepEqual(sets(taskId), [], failing)
    // Its Bot's level leaves the catalog afterwards: the Session, which reads full access,
    // is lowered at the catalog change, which a flag left behind would prevent.
    rt.botOf('m1').permission = GONE
    service.offered = [WRITE, FULL]
    await changed()
    assert.deepEqual(sets(taskId), [WRITE], failing)
  }
})

test('a level DSH itself changes on the Bot\'s chat reaches the windows', async (t) => {
  const { rt, call, service, opens, view } = team(t, { offered: ['read-only', WRITE, FULL], bots: { m1: { permission: GONE } }, levels: { m1: WRITE } })
  await call('state', {})
  await opens('m1')
  const bot = async () => (await view()).bots.find(entry => entry.id === 'm1')
  assert.equal((await bot()).permissionRuns, 'read-only')
  const before = rt.permissionKey()
  // Changed in DSH, with no change to the Bot, the catalog or an outcome.
  service.set({ id: 'm1' }, FULL)
  const after = rt.permissionKey()
  assert.notEqual(after, before)
  assert.equal((await bot()).permissionRuns, FULL)
  // To a level that is not offered, and to none that can be read: each is another key.
  service.offered.push('odd')
  service.set({ id: 'm1' }, 'odd')
  service.offered.pop()
  const dropped = rt.permissionKey()
  assert.notEqual(dropped, after)
  service.unreadable.add('m1')
  assert.notEqual(rt.permissionKey(), dropped)
  // Two offered levels of the same rank whose names a weak digest would take for one.
  service.unreadable.clear()
  service.offered.push('custom-ar', 'custom-c0')
  service.specs = { ...service.specs, 'custom-ar': SPECS[WRITE], 'custom-c0': SPECS[WRITE] }
  service.set({ id: 'm1' }, 'custom-ar')
  const one = rt.permissionKey()
  service.set({ id: 'm1' }, 'custom-c0')
  assert.notEqual(rt.permissionKey(), one)
  assert.equal((await bot()).permissionRuns, 'custom-c0')
  // The key tells no level by name and nothing of what one allows.
  assert.doesNotMatch(rt.permissionKey().split(':').at(-1), /odd|custom|sandbox|approval|full|write/)
})

test('a fresh part of a Bot whose saved level is gone is lowered as any conversation that runs', async (t) => {
  // The new Session reads full access, DSH's default here; the Bot's saved level is gone.
  const { rt, call, sets, levelOf } = team(t, { bots: { m1: { permission: GONE } }, levels: { m1: FULL }, born: FULL, defaultPreset: FULL })
  await call('state', {})
  await rt.startFresh('m1')
  const end = Date.now() + 15_000
  while (rt.chatOf('m1') === 'm1' && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 2))
  const fresh = rt.chatOf('m1')
  assert.notEqual(fresh, 'm1', 'the Bot moved on to its fresh part')
  assert.deepEqual(sets(fresh), [WRITE])
  assert.equal(levelOf(fresh), WRITE)
  assert.equal(rt.botOf('m1').permission, GONE)
})
