// A caller of startTask may name the group a task reports to (`reportRoomId`, #1294). It
// changes where the task's report is delivered and nothing else: the task's level is the
// one the same call without it gets, whatever the levels of its Bot, of the group of the
// call and of the report group. A group the Bot is not a member of is refused before any
// task or Session is made. The team runs over a fake DSH presets service, as in
// task-caller-group.test.js; a tool call is the `tools/execute` waterfall DSH runs around a
// tool's body.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const FULL = 'danger-full-access'
const WRITE = 'workspace-write'
const READ_ONLY = 'read-only'
const STOCK = {
  [WRITE]: { sandbox: 'workspace-write', approval: 'ask' },
  [FULL]: { sandbox: 'danger-full-access', approval: 'never' },
  [READ_ONLY]: { sandbox: 'read-only', approval: 'ask' },
}
const AUTO_SPEC = { sandbox: 'danger-full-access', approval: 'ask' }

const room = (id, name, members, sessions) => ({ id, name, named: true, members, mode: 'everyone', notice: '', sessions, seq: 0, log: [] })
const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', name: 'Main', role: '', instructions: '', createdAt: 1 },
    b2: { id: 'b2', name: 'Ada', role: '', instructions: '', createdAt: 2 },
  },
  rooms: {
    // The group the call is made in.
    r1: room('r1', 'Launch', ['m1', 'b2'], { m1: 'g1', b2: 'g2' }),
    // Another group the Bot is in: the report group.
    r2: room('r2', 'Review', ['m1', 'b2'], { m1: 'h1', b2: 'h2' }),
    // A group the Bot is not in.
    r3: room('r3', 'Elsewhere', ['b2'], { b2: 'k2' }),
    // A group the Bot is in with no Session there yet.
    r4: room('r4', 'Quiet', ['m1', 'b2'], { b2: 'q2' }),
    // One more group the Bot is in, for a Session set aside before the end.
    r5: room('r5', 'Later', ['m1', 'b2'], { m1: 'p1', b2: 'p2' }),
  },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

function team(t, { bots = {}, rooms = {}, tasks, defaultPreset = WRITE } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-report-room-'))
  const allRooms = Object.fromEntries(Object.entries(TEAM.rooms).map(([id, base]) => [id, { ...base, ...rooms[id] }]))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM, bots: { m1: { ...TEAM.bots.m1, ...bots.m1 }, b2: { ...TEAM.bots.b2, ...bots.b2 } }, rooms: allRooms, ...(tasks ? { tasks } : {}) }))
  const log = []
  const open = new Set()
  const presetOf = new Map()
  const service = {
    names: () => [...Object.keys(STOCK), 'auto'],
    catalog: () => ({ options: service.names().map(value => ({ value, name: value })), defaultOptions: [], defaultPreset }),
    resolve: (name) => {
      if (!service.names().includes(name)) throw new Error(`permission: unknown preset "${name}"`)
      return name === 'auto' ? AUTO_SPEC : STOCK[name]
    },
    current: session => presetOf.get(session.id),
    set: (session, name) => {
      service.resolve(name)
      if (presetOf.get(session.id) !== name) log.push(`${session.id} preset ${name}`)
      presetOf.set(session.id, name)
    },
  }
  const ctx = fakeContext({ services: { permissionPresets: service } })
  const made = { sessions: 0 }
  Object.assign(ctx, {
    workspaceRegistry: {
      get: () => ({ id: 'w1', path: home }),
      resolveByPath: async path => ({ id: 'w1', path }),
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      async create() {
        const sessionId = `s${++made.sessions}`
        open.add(sessionId)
        for (const listener of ctx.listeners.get('session/created') ?? []) void listener({ id: sessionId })
        return { sessionId }
      },
      async resolveAgent(sessionId) {
        const session = { id: sessionId }
        if (!open.has(sessionId)) {
          open.add(sessionId)
          for (const listener of ctx.listeners.get('session/created') ?? []) void listener(session)
        }
        await new Promise(resolve => setTimeout(resolve, 1))
        return { agent: { session, followup() {} } }
      },
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async (session) => { log.push(`${session.id} first turn`) }, list: () => [...open].map(id => ({ id })) },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  apply(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const rt = ctx.provided.get('omniTeam')
  // Where reports go: every delivery the team makes, as it asks for it.
  const delivered = []
  rt.deliver = async (args) => { delivered.push(args); return 'exchange' }
  const warnings = []
  const warn = rt.warn
  rt.warn = (...args) => { warnings.push(args.join(' ')); return warn?.(...args) }
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const presets = sessionId => log.filter(line => line.startsWith(`${sessionId} preset `)).map(line => line.split(' preset ')[1])
  const settle = () => new Promise(resolve => setTimeout(resolve, 20))
  const toolCall = (sessionId, body, name = 'grant_wish') => {
    const exec = { name, arguments: {}, agent: { id: sessionId, session: { id: sessionId } } }
    const hooks = [...(ctx.listeners.get('tools/execute') ?? [])]
    const next = index => () => (index < hooks.length ? hooks[index](exec, next(index + 1)) : body())
    return next(0)()
  }
  const wish = (from = 'm1', extra = {}) => rt.startTask({ title: 'Wish', text: 'Do it', from, ...extra })
  // The task's first turn ends with its last words, as DSH reports it.
  const finish = async (sessionId, words = 'All done') => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      listener({ id: sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: words }] } } })
      listener({ id: sessionId }, { type: 'turn/end', data: { reason: { kind: 'end' } } })
    }
    await settle()
    return delivered.filter(entry => entry.taskSessionId === sessionId)
  }
  return { ctx, rt, home, made, call, presets, settle, toolCall, wish, finish, delivered, warnings, log }
}

// A task record without the report group: what the same call without the field records.
const withoutReport = ({ reportRoomId, at, ...rest }) => rest

test('without the field a task is as today: same record, same level, report in the Bot\'s own chat', async (t) => {
  const { rt, call, presets, settle, toolCall, wish, finish } = team(t, { bots: { m1: { permission: FULL } }, rooms: { r1: { permission: WRITE } } })
  await call('state', {})
  const direct = await wish()
  const grouped = await toolCall('g1', () => wish())
  const nulled = await toolCall('g1', () => wish('m1', { reportRoomId: null }))
  const undef = await toolCall('g1', () => wish('m1', { reportRoomId: undefined }))
  await settle()
  assert.deepEqual(presets(direct), [FULL])
  assert.deepEqual(Object.keys(rt.state.tasks[direct]).sort(), ['at', 'from', 'status', 'title'])
  for (const task of [grouped, nulled, undef]) {
    assert.deepEqual(presets(task), [WRITE], task)
    assert.deepEqual(Object.keys(rt.state.tasks[task]).sort(), ['at', 'from', 'levelRoomId', 'status', 'title'], task)
  }
  for (const task of [direct, grouped, nulled, undef]) {
    const [report] = await finish(task)
    assert.equal(report.toId, 'm1')
    assert.equal(report.role, 'task-done')
    assert.equal(report.sessionId, undefined)
    assert.equal(report.roomId, undefined)
  }
})

test('a report group the Bot is in gets the report, and the level stays the one without it', async (t) => {
  // A wide Bot asked in a narrower group: the group still narrows the task.
  const { rt, call, presets, settle, toolCall, wish, finish, log } = team(t, { bots: { m1: { permission: FULL } }, rooms: { r1: { permission: WRITE } } })
  await call('state', {})
  const task = await toolCall('g1', () => wish('m1', { reportRoomId: 'r1' }))
  await settle()
  assert.deepEqual(presets(task), [WRITE])
  assert.ok(log.indexOf(`${task} preset ${WRITE}`) < log.indexOf(`${task} first turn`), log.join(' | '))
  assert.equal(rt.taskLevelOf(task), WRITE)
  assert.equal(rt.state.tasks[task].reportRoomId, 'r1')
  assert.equal(rt.state.tasks[task].levelRoomId, 'r1')
  assert.equal(rt.state.tasks[task].roomId, undefined)
  assert.equal(rt.state.tasks[task].permissionCap, undefined)
  const [report] = await finish(task, 'The wish is granted')
  assert.equal(report.toId, 'm1')
  assert.equal(report.sessionId, 'g1')
  assert.equal(report.roomId, 'r1')
  assert.equal(report.role, 'task-done')
  assert.equal(report.text, 'The wish is granted')
  assert.equal(rt.state.tasks[task].status, 'done')
})

test('a wider report group never raises the task, and a narrower one never narrows it', async (t) => {
  // The Bot's level is narrower than the report group's: the task stays at the Bot's.
  const low = team(t, { bots: { m1: { permission: WRITE } }, rooms: { r1: { permission: FULL }, r2: { permission: FULL } } })
  await low.call('state', {})
  const fromGroup = await low.toolCall('g1', () => low.wish('m1', { reportRoomId: 'r2' }))
  const fromChat = await low.toolCall(low.rt.chatOf('m1'), () => low.wish('m1', { reportRoomId: 'r2' }))
  const direct = await low.wish('m1', { reportRoomId: 'r2' })
  await low.settle()
  for (const task of [fromGroup, fromChat, direct]) {
    assert.deepEqual(low.presets(task), [WRITE], task)
    assert.equal(low.rt.taskLevelOf(task), WRITE, task)
  }
  // The report group's narrower level gives a task started outside it nothing either.
  const high = team(t, { bots: { m1: { permission: FULL } }, rooms: { r2: { permission: READ_ONLY } } })
  await high.call('state', {})
  const wide = await high.toolCall(high.rt.chatOf('m1'), () => high.wish('m1', { reportRoomId: 'r2' }))
  await high.settle()
  assert.deepEqual(high.presets(wide), [FULL])
  assert.equal(high.rt.state.tasks[wide].levelRoomId, undefined)
  const [report] = await high.finish(wide)
  assert.equal(report.sessionId, 'h1')
  assert.equal(report.roomId, 'r2')
})

test('under any levels and any caller, the field gives the task the level and record of the call without it', async (t) => {
  const levels = [undefined, READ_ONLY, WRITE, 'auto', FULL]
  for (const botLevel of [WRITE, 'auto', FULL]) {
    for (const callLevel of levels) {
      for (const reportLevel of [undefined, READ_ONLY, FULL]) {
        const w = team(t, { bots: { m1: botLevel ? { permission: botLevel } : {} }, rooms: { r1: callLevel ? { permission: callLevel } : {}, r2: reportLevel ? { permission: reportLevel } : {} } })
        await w.call('state', {})
        // No tool call, one from the Bot's own chat, one from the group, one from the report group.
        for (const caller of [undefined, w.rt.chatOf('m1'), 'g1', 'h1']) {
          for (const reportRoomId of ['r1', 'r2']) {
            const start = extra => (caller === undefined ? w.wish('m1', extra) : w.toolCall(caller, () => w.wish('m1', extra)))
            const plain = await start({})
            const reported = await start({ reportRoomId })
            await w.settle()
            const where = `${botLevel}/${callLevel}/${reportLevel} from ${caller} to ${reportRoomId}`
            assert.deepEqual(w.presets(reported), w.presets(plain), where)
            assert.equal(w.rt.taskLevelOf(reported), w.rt.taskLevelOf(plain), where)
            assert.deepEqual(withoutReport(w.rt.state.tasks[reported]), withoutReport(w.rt.state.tasks[plain]), where)
            assert.equal(w.rt.state.tasks[reported].reportRoomId, reportRoomId, where)
          }
        }
      }
    }
  }
})

test('a group that is unknown, foreign or not a group id is refused, and nothing is made', async (t) => {
  const { rt, made, call, settle, toolCall, wish } = team(t, { bots: { m1: { permission: FULL } }, rooms: { r1: { permission: WRITE } } })
  await call('state', {})
  const before = { sessions: made.sessions, tasks: Object.keys(rt.state.tasks ?? {}).length }
  const refused = [
    [{ reportRoomId: 'nope' }, /There is no group nope to report to/],
    [{ reportRoomId: 'r3' }, /Main is not a member of "Elsewhere", so the task cannot report there/],
    [{ reportRoomId: '' }, /The report room must be a group id/],
    [{ reportRoomId: '   ' }, /The report room must be a group id/],
    [{ reportRoomId: 42 }, /The report room must be a group id/],
    [{ reportRoomId: { id: 'r1' } }, /The report room must be a group id/],
    [{ reportRoomId: ['r1'] }, /The report room must be a group id/],
    // A task asked for in one group reports there; it cannot be sent to another.
    [{ roomId: 'r1', reportRoomId: 'r2' }, /A task asked for in one group cannot report to another/],
  ]
  for (const [extra, message] of refused) {
    await assert.rejects(wish('m1', extra), message, JSON.stringify(extra))
    await assert.rejects(toolCall('g1', () => wish('m1', extra)), message, JSON.stringify(extra))
  }
  // No Bot asked for the task, or one the team does not know: there is no member to check.
  await assert.rejects(rt.startTask({ title: 'Wish', text: 'Do it', reportRoomId: 'r1' }), /A report room needs the Bot that asks for the task/)
  await assert.rejects(rt.startTask({ title: 'Wish', text: 'Do it', from: 'ghost', reportRoomId: 'r1' }), /A report room needs the Bot that asks for the task/)
  await settle()
  assert.equal(made.sessions, before.sessions)
  assert.equal(Object.keys(rt.state.tasks ?? {}).length, before.tasks)
  // The same Bot in the same group without the field still starts.
  const task = await toolCall('g1', () => wish())
  assert.ok(rt.state.tasks[task])
})

test('the same group as the roomId is the roomId alone, with no new key', async (t) => {
  const { rt, call, presets, settle, toolCall, wish, finish } = team(t, { bots: { m1: { permission: WRITE } }, rooms: { r1: { permission: FULL } } })
  await call('state', {})
  // From the group's own Session, as the start_task tool does: the group's level.
  const plain = await toolCall('g1', () => wish('m1', { roomId: 'r1' }))
  const same = await toolCall('g1', () => wish('m1', { roomId: 'r1', reportRoomId: 'r1' }))
  await settle()
  assert.deepEqual(presets(same), presets(plain))
  assert.deepEqual(presets(same), [FULL])
  assert.deepEqual(withoutReport(rt.state.tasks[same]), withoutReport(rt.state.tasks[plain]))
  assert.equal(Object.hasOwn(rt.state.tasks[same], 'reportRoomId'), false)
  const [report] = await finish(same)
  assert.equal(report.sessionId, 'g1')
  assert.equal(report.roomId, 'r1')
})

test('a member with no Session in the group yet is accepted; its report falls back to the Bot\'s own chat', async (t) => {
  const { rt, call, presets, settle, wish, finish, warnings } = team(t, { bots: { m1: { permission: FULL } } })
  await call('state', {})
  const task = await wish('m1', { reportRoomId: 'r4' })
  await settle()
  assert.deepEqual(presets(task), [FULL])
  assert.equal(rt.state.tasks[task].reportRoomId, 'r4')
  const [report] = await finish(task)
  assert.equal(report.toId, 'm1')
  assert.equal(report.sessionId, undefined)
  assert.equal(report.roomId, undefined)
  assert.ok(warnings.some(line => line.includes('goes to its Bot\'s own chat') && line.includes('r4')), warnings.join(' | '))
})

test('a report group that is gone, left or without the Bot\'s Session by the end falls back to the Bot\'s own chat', async (t) => {
  const { rt, call, settle, wish, finish, warnings } = team(t, { bots: { m1: { permission: FULL } } })
  await call('state', {})
  // The group is deleted.
  const deleted = await wish('m1', { reportRoomId: 'r2' })
  await settle()
  assert.equal((await call('delete-room', { id: 'r2' })).ok, true)
  // The Bot leaves the group.
  const left = await wish('m1', { reportRoomId: 'r1' })
  await settle()
  rt.state.rooms.r1.members = rt.state.rooms.r1.members.filter(id => id !== 'm1')
  // The Bot's Session there is set aside (as a Session DSH can no longer open is).
  const retired = await wish('m1', { reportRoomId: 'r5' })
  await settle()
  delete rt.state.rooms.r5.sessions.m1
  for (const task of [deleted, left, retired]) {
    const [report] = await finish(task)
    assert.equal(report.toId, 'm1', task)
    assert.equal(report.sessionId, undefined, task)
    assert.equal(report.roomId, undefined, task)
  }
  assert.equal(warnings.filter(line => line.includes('goes to its Bot\'s own chat')).length, 3, warnings.join(' | '))
  // The roomId path warns nothing new.
  const asked = await wish('m1', { roomId: 'r1' })
  await settle()
  const before = warnings.length
  await finish(asked)
  assert.equal(warnings.slice(before).some(line => line.includes('goes to its Bot\'s own chat')), false)
})

test('changing or deleting the report group leaves the level alone; the group of the call still narrows', async (t) => {
  const { rt, call, presets, settle, toolCall, wish } = team(t, { bots: { m1: { permission: FULL } }, rooms: { r1: { permission: FULL }, r2: { permission: FULL } } })
  await call('state', {})
  const task = await toolCall('g1', () => wish('m1', { reportRoomId: 'r2' }))
  await settle()
  assert.deepEqual(presets(task), [FULL])
  // The report group lowered: the task is not touched.
  assert.equal((await call('update-room', { id: 'r2', permission: READ_ONLY })).ok, true)
  await settle()
  assert.deepEqual(presets(task), [FULL])
  // The report group deleted: no cap, no change.
  assert.equal((await call('delete-room', { id: 'r2' })).ok, true)
  await settle()
  assert.equal(rt.state.tasks[task].permissionCap, undefined)
  assert.deepEqual(presets(task), [FULL])
  // The group of the call lowered: today's narrowing follows, live.
  assert.equal((await call('update-room', { id: 'r1', permission: WRITE })).ok, true)
  await settle()
  assert.deepEqual(presets(task), [FULL, WRITE])
  // And deleting it caps the task at the level it ran at there, as today.
  assert.equal((await call('delete-room', { id: 'r1' })).ok, true)
  await settle()
  assert.equal(rt.state.tasks[task].permissionCap, WRITE)
  assert.deepEqual(presets(task), [FULL, WRITE])
})

test('a task started from inside a task with a report group is bound by its parent as without it', async (t) => {
  const { rt, call, presets, settle, toolCall, wish, finish } = team(t, { bots: { m1: { permission: FULL } }, rooms: { r1: { permission: WRITE } } })
  await call('state', {})
  const parent = await toolCall('g1', () => wish())
  const plain = await toolCall(parent, () => wish())
  const reported = await toolCall(parent, () => wish('m1', { reportRoomId: 'r2' }))
  await settle()
  assert.deepEqual(presets(reported), presets(plain))
  assert.deepEqual(presets(reported), [WRITE])
  assert.deepEqual(withoutReport(rt.state.tasks[reported]), withoutReport(rt.state.tasks[plain]))
  assert.equal(rt.state.tasks[reported].levelTaskId, parent)
  assert.equal(rt.state.tasks[reported].levelRoomId, 'r1')
  // Lowering the parent's group lowers both alike.
  assert.equal((await call('update-room', { id: 'r1', permission: READ_ONLY })).ok, true)
  await settle()
  assert.deepEqual(presets(reported), presets(plain))
  assert.equal(presets(reported).at(-1), READ_ONLY)
  const [report] = await finish(reported)
  assert.equal(report.sessionId, 'h1')
  assert.equal(report.roomId, 'r2')
})

test('the report group is saved with the task, and a restart keeps its level and its report', async (t) => {
  const first = team(t, { bots: { m1: { permission: FULL } }, rooms: { r1: { permission: WRITE } } })
  await first.call('state', {})
  const task = await first.toolCall('g1', () => first.wish('m1', { reportRoomId: 'r2' }))
  await first.settle()
  await first.rt.save()
  const saved = JSON.parse(readFileSync(join(first.home, 'state.json'), 'utf8'))
  assert.equal(saved.tasks[task].reportRoomId, 'r2')
  assert.equal(saved.tasks[task].levelRoomId, 'r1')
  // A team that loads it gives the task the narrowed level and reports into the group.
  const tasks = { t1: { title: 'Wish', from: 'm1', at: 1, status: 'working', levelRoomId: 'r1', reportRoomId: 'r2' }, t2: { title: 'Wish', from: 'm1', at: 2, status: 'working', levelRoomId: 'r1' } }
  const again = team(t, { bots: { m1: { permission: FULL } }, rooms: { r1: { permission: WRITE } }, tasks })
  await again.rt.load()
  await again.rt.resolveAgent('t1')
  await again.rt.resolveAgent('t2')
  await again.settle()
  assert.deepEqual(again.presets('t1'), [WRITE])
  assert.deepEqual(again.presets('t1'), again.presets('t2'))
  const [report] = await again.finish('t1')
  assert.equal(report.sessionId, 'h1')
  assert.equal(report.roomId, 'r2')
  const [own] = await again.finish('t2')
  assert.equal(own.roomId, undefined)
})
