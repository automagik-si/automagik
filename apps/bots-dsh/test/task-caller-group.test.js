// A task started for a Bot from inside a group Session's tool call, without a `roomId`
// (as another plugin's tool may do), takes that group into account, narrowing only: its
// level is never wider than without the group. The team runs over a fake DSH presets
// service, as in permissions.test.js; a tool call is the `tools/execute` waterfall DSH
// runs around a tool's body.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { POLICY_UNAVAILABLE_TEXT } from '../src/host/review-guard.js'
import { fakeContext } from './fake-ctx.js'

const FULL = 'danger-full-access'
const WRITE = 'workspace-write'
const STOCK = {
  [WRITE]: { sandbox: 'workspace-write', approval: 'ask' },
  [FULL]: { sandbox: 'danger-full-access', approval: 'never' },
}
const AUTO_SPEC = { sandbox: 'danger-full-access', approval: 'ask' }
const READ = { 'read-only': { sandbox: 'read-only', approval: 'ask' } }

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', name: 'Omni', role: '', instructions: '', createdAt: 1 },
    b2: { id: 'b2', name: 'Ada', role: '', instructions: '', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Launch', named: true, members: ['m1', 'b2'], mode: 'everyone', notice: '', sessions: { m1: 'g1', b2: 'g2' }, seq: 0, log: [] } },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

function team(t, { auto = true, bots = {}, room = {}, tasks, custom = {}, defaultPreset = WRITE } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-caller-group-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM, bots: { m1: { ...TEAM.bots.m1, ...bots.m1 }, b2: { ...TEAM.bots.b2, ...bots.b2 } }, rooms: { r1: { ...TEAM.rooms.r1, ...room } }, ...(tasks ? { tasks } : {}) }))
  const log = []
  const instructions = new Map()
  const open = new Set()
  const presetOf = new Map()
  const service = {
    auto,
    stale: new Set(),
    names: () => [...Object.keys(STOCK), ...Object.keys(custom), ...(service.auto ? ['auto'] : [])].filter(name => !service.stale.has(name)),
    catalog: () => ({ options: service.names().map(value => ({ value, name: value })), defaultOptions: [], defaultPreset }),
    resolve: (name) => {
      if (!service.names().includes(name)) throw new Error(`permission: unknown preset "${name}"`)
      return name === 'auto' ? AUTO_SPEC : STOCK[name] ?? custom[name]
    },
    current: session => presetOf.get(session.id),
    set: (session, name) => {
      service.resolve(name)
      if (presetOf.get(session.id) !== name) log.push(`${session.id} preset ${name}`)
      presetOf.set(session.id, name)
    },
  }
  const ctx = fakeContext({ services: { permissionPresets: service } })
  let sessions = 0
  Object.assign(ctx, {
    workspaceRegistry: {
      get: () => ({ id: 'w1', path: home }),
      resolveByPath: async path => ({ id: 'w1', path }),
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      // As DSH does, a new Session is announced while it is made, before startTask knows
      // it as a task.
      async create(options) {
        const sessionId = options?.sessionId ?? `s${++sessions}`
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
        return { agent: { session, followup(message) { instructions.set(sessionId, message.id) } } }
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
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const presets = sessionId => log.filter(line => line.startsWith(`${sessionId} preset `)).map(line => line.split(' preset ')[1])
  const settle = () => new Promise(resolve => setTimeout(resolve, 20))
  // One tool call of `sessionId`, as DSH dispatches it: every tools/execute listener
  // around the body, first registered outermost.
  const toolCall = (sessionId, body, name = 'grant_wish') => {
    const exec = { name, arguments: {}, agent: { id: sessionId, session: { id: sessionId } } }
    const hooks = [...(ctx.listeners.get('tools/execute') ?? [])]
    const next = index => () => (index < hooks.length ? hooks[index](exec, next(index + 1)) : body())
    return next(0)()
  }
  // As Genie's grant_wish does: no roomId.
  const wish = (from = 'm1', extra = {}) => rt.startTask({ title: 'Wish', text: 'Do it', from, ...extra })
  return { ctx, rt, home, service, call, presets, settle, toolCall, wish, log, instructions }
}

test('a task started from a group Session without a roomId runs no wider than that group', async (t) => {
  const { rt, call, presets, settle, toolCall, wish, log } = team(t, { bots: { m1: { permission: FULL } }, room: { permission: WRITE } })
  await call('state', {})
  const task = await toolCall('g1', () => wish())
  await settle()
  assert.deepEqual(presets(task), [WRITE])
  assert.ok(log.indexOf(`${task} preset ${WRITE}`) < log.indexOf(`${task} first turn`), log.join(' | '))
  // The group is kept for the level only: the report still goes to the Bot's own chat.
  assert.equal(rt.state.tasks[task].levelRoomId, 'r1')
  assert.equal(rt.state.tasks[task].roomId, undefined)

  // Auto sits between the two: a full-access Bot's task in an Auto group runs on Auto.
  const auto = team(t, { bots: { m1: { permission: FULL } }, room: { permission: 'auto' } })
  await auto.call('state', {})
  const reviewed = await auto.toolCall('g1', () => auto.wish())
  await auto.settle()
  assert.deepEqual(auto.presets(reviewed), ['auto'])
})

test('a wider group never widens the task: it runs at its Bot\'s level', async (t) => {
  const { rt, call, presets, settle, toolCall, wish } = team(t, { bots: { m1: { permission: WRITE } }, room: { permission: FULL } })
  await call('state', {})
  const task = await toolCall('g1', () => wish())
  await settle()
  assert.deepEqual(presets(task), [WRITE])
  assert.equal(rt.state.tasks[task].roomId, undefined)

  // A Bot without a level of its own keeps the catalog default there.
  const plain = team(t, { room: { permission: FULL } })
  await plain.call('state', {})
  const chore = await plain.toolCall('g1', () => plain.wish())
  await plain.settle()
  assert.deepEqual(plain.presets(chore), [WRITE])

  // A group without a level of its own changes nothing.
  const free = team(t, { bots: { m1: { permission: FULL } } })
  await free.call('state', {})
  const own = await free.toolCall('g1', () => free.wish())
  await free.settle()
  assert.deepEqual(free.presets(own), [FULL])
})

test('outside a group tool call only the verified Bot opener adds private skill provenance', async (t) => {
  const { ctx, rt, home, call, presets, settle, toolCall, wish, instructions } = team(t, { bots: { m1: { permission: FULL } }, room: { permission: WRITE } })
  await call('state', {})
  ctx.sessions.get = id => id === 'elsewhere' ? { id, header: { id } } : undefined
  // No tool call at all.
  const direct = await wish()
  // A tool call from the Bot's own chat, and one from a Session that is no group's.
  const ownChat = await toolCall(rt.chatOf('m1'), () => wish())
  const stranger = await toolCall('elsewhere', () => wish())
  await settle()
  for (const task of [direct, ownChat, stranger]) {
    assert.deepEqual(presets(task), [FULL], task)
  }
  for (const task of [direct, stranger]) {
    assert.deepEqual(Object.keys(rt.state.tasks[task]).sort(), ['at', 'from', 'status', 'title'], task)
  }
  const own = rt.state.tasks[ownChat]
  assert.match(own.skillsInstructionsId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
  assert.equal(own.skillsInstructionsId, instructions.get(ownChat))
  assert.ok(Number.isFinite(own.at))
  const card = { at: own.at, from: 'm1', status: 'working', title: 'Wish' }
  assert.deepEqual(own, { ...card, skills: [], skillsInstructionsId: instructions.get(ownChat), skillsOwner: 'm1' })
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).tasks[ownChat], own)
  const roster = await call('state', {})
  assert.equal(roster.ok, true)
  assert.deepEqual(roster.value.tasks[ownChat], card)
})

test('an explicit roomId wins over the group of the call', async (t) => {
  // The task asked for in the group takes the group's level, wider than its Bot's, as today.
  const { rt, call, presets, settle, toolCall, wish } = team(t, { bots: { m1: { permission: WRITE } }, room: { permission: FULL } })
  await call('state', {})
  const task = await toolCall('g1', () => wish('m1', { roomId: 'r1' }))
  await settle()
  assert.deepEqual(presets(task), [FULL])
  assert.equal(rt.state.tasks[task].roomId, 'r1')
  assert.equal(rt.state.tasks[task].levelRoomId, undefined)
})

test('the group of a tool call ends with the call', async (t) => {
  const { rt, call, presets, settle, toolCall, wish } = team(t, { bots: { m1: { permission: FULL } }, room: { permission: WRITE } })
  await call('state', {})
  // A timer set during the call fires after it returned: the Bot's own level.
  let late
  await toolCall('g1', async () => { setTimeout(() => { late = wish() }, 5) })
  await settle()
  const afterwards = await late
  // A promise chain the call left behind, too.
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let chained
  await toolCall('g1', async () => { chained = gate.then(() => wish()) })
  release()
  const trailing = await chained
  // A body that throws ends it as one that returns does.
  let thrown
  await assert.rejects(toolCall('g1', async () => {
    setTimeout(() => { thrown = wish() }, 5)
    throw new Error('the tool failed')
  }), /the tool failed/)
  await settle()
  const afterThrow = await thrown
  await settle()
  for (const task of [afterwards, trailing, afterThrow]) {
    assert.deepEqual(presets(task), [FULL], task)
    assert.equal(rt.state.tasks[task].levelRoomId, undefined, task)
  }
  // Inside the call it holds, even for a startTask the tool does not wait for.
  let unawaited
  await toolCall('g1', async () => { unawaited = wish() })
  const inside = await unawaited
  await settle()
  assert.deepEqual(presets(inside), [WRITE])
})

test('two tool calls at once each carry their own Session', async (t) => {
  const { rt, call, presets, settle, toolCall, wish } = team(t, { bots: { m1: { permission: FULL }, b2: { permission: FULL } }, room: { permission: WRITE } })
  await call('state', {})
  const pause = () => new Promise(resolve => setTimeout(resolve, 3))
  const [inGroup, inChat] = await Promise.all([
    toolCall('g2', async () => { await pause(); return wish('b2') }),
    toolCall(rt.chatOf('m1'), async () => { await pause(); return wish('m1') }),
  ])
  await settle()
  assert.deepEqual(presets(inGroup), [WRITE])
  assert.deepEqual(presets(inChat), [FULL])
  // A tool call nested in another reads its own Session, not the outer one.
  const nested = await toolCall('g1', () => toolCall(rt.chatOf('m1'), () => wish()))
  const outer = await toolCall(rt.chatOf('m1'), () => toolCall('g1', () => wish()))
  await settle()
  assert.deepEqual(presets(nested), [FULL])
  assert.deepEqual(presets(outer), [WRITE])
})

test('the task follows the group it was started from, and never passes its Bot\'s level', async (t) => {
  const { call, presets, settle, toolCall, wish } = team(t, { bots: { m1: { permission: FULL } }, room: { permission: FULL } })
  await call('state', {})
  const task = await toolCall('g1', () => wish())
  await settle()
  assert.deepEqual(presets(task), [FULL])
  // Lowering the group lowers the task.
  assert.equal((await call('update-room', { id: 'r1', permission: WRITE })).ok, true)
  await settle()
  assert.deepEqual(presets(task), [FULL, WRITE])
  // Lowering the Bot under the group lowers it too; raising the group then gives nothing.
  assert.equal((await call('update-room', { id: 'r1', permission: 'auto' })).ok, true)
  await settle()
  assert.equal(presets(task).at(-1), 'auto')
  assert.equal((await call('update-bot', { id: 'm1', permission: WRITE })).ok, true)
  await settle()
  assert.equal(presets(task).at(-1), WRITE)
  assert.equal((await call('update-room', { id: 'r1', permission: FULL })).ok, true)
  await settle()
  assert.equal(presets(task).at(-1), WRITE)
  // A group that goes back to each member's own level leaves the task at its Bot's.
  assert.equal((await call('update-bot', { id: 'm1', permission: FULL })).ok, true)
  assert.equal((await call('update-room', { id: 'r1', permission: WRITE })).ok, true)
  await settle()
  assert.equal(presets(task).at(-1), WRITE)
  assert.equal((await call('update-room', { id: 'r1', permission: null })).ok, true)
  await settle()
  assert.equal(presets(task).at(-1), FULL)
})

test('deleting the group caps the task at the level it ran at there', async (t) => {
  const { rt, call, presets, settle, toolCall, wish } = team(t, { bots: { m1: { permission: FULL } }, room: { permission: WRITE } })
  await call('state', {})
  const task = await toolCall('g1', () => wish())
  await settle()
  assert.deepEqual(presets(task), [WRITE])
  assert.equal((await call('delete-room', { id: 'r1' })).ok, true)
  await settle()
  assert.equal(rt.state.tasks[task].permissionCap, WRITE)
  assert.deepEqual(presets(task), [WRITE])
  // Its Bot's level changing afterwards can lower it, never raise it.
  assert.equal((await call('update-bot', { id: 'm1', permission: 'auto' })).ok, true)
  await settle()
  assert.deepEqual(presets(task), [WRITE])
})

test('a restart gives the task the narrowed level again', async (t) => {
  const tasks = { t1: { title: 'Wish', from: 'm1', at: 1, status: 'working', levelRoomId: 'r1' }, t2: { title: 'Chore', from: 'm1', at: 2, status: 'working' } }
  const { rt, presets, settle } = team(t, { bots: { m1: { permission: FULL } }, room: { permission: WRITE }, tasks })
  await rt.load()
  await rt.resolveAgent('t1')
  await rt.resolveAgent('t2')
  await settle()
  assert.deepEqual(presets('t1'), [WRITE])
  assert.deepEqual(presets('t2'), [FULL])
})

test('a level that cannot be ranked never widens the task', async (t) => {
  // The group's saved level left the catalog: the narrowest offered, when that allows less.
  const stale = team(t, { bots: { m1: { permission: FULL } }, room: { permission: 'gone' } })
  await stale.call('state', {})
  const narrowed = await stale.toolCall('g1', () => stale.wish())
  await stale.settle()
  assert.deepEqual(stale.presets(narrowed), [WRITE])
  // And nothing when the task already runs at the narrowest.
  const low = team(t, { bots: { m1: { permission: WRITE } }, room: { permission: 'gone' } })
  await low.call('state', {})
  const kept = await low.toolCall('g1', () => low.wish())
  await low.settle()
  assert.deepEqual(low.presets(kept), [WRITE])

  // A saved Auto that DSH does not offer runs as workspace-write, on either side.
  const botAuto = team(t, { auto: false, bots: { m1: { permission: 'auto' } }, room: { permission: 'read-only' }, custom: READ })
  await botAuto.call('state', {})
  const read = await botAuto.toolCall('g1', () => botAuto.wish())
  await botAuto.settle()
  assert.deepEqual(botAuto.presets(read), ['read-only'])
  const roomAuto = team(t, { auto: false, bots: { m1: { permission: FULL } }, room: { permission: 'auto' } })
  await roomAuto.call('state', {})
  const fallback = await roomAuto.toolCall('g1', () => roomAuto.wish())
  await roomAuto.settle()
  assert.deepEqual(roomAuto.presets(fallback), [WRITE])
  // By that name, not as `auto`: a layer that loads before a later apply must not turn the
  // task into Auto, which is wider than the workspace-write the group runs as.
  assert.equal(roomAuto.rt.taskLevelOf(fallback), WRITE)
  const both = team(t, { auto: false, bots: { m1: { permission: WRITE } }, room: { permission: 'auto' } })
  await both.call('state', {})
  const same = await both.toolCall('g1', () => both.wish())
  await both.settle()
  assert.deepEqual(both.presets(same), [WRITE])

  // The task's own level cannot be ranked: it is left as without the group.
  const odd = team(t, { bots: { m1: { permission: 'odd' } }, room: { permission: FULL }, custom: { odd: { sandbox: 'elsewhere', approval: 'ask' } } })
  await odd.call('state', {})
  const own = await odd.toolCall('g1', () => odd.wish())
  await odd.settle()
  assert.deepEqual(odd.presets(own), ['odd'])
})

test('a cap still holds under the group, and the group under a cap', async (t) => {
  const tasks = {
    t1: { title: 'Capped', from: 'm1', at: 1, status: 'working', levelRoomId: 'r1', permissionCap: WRITE },
    t2: { title: 'Grouped', from: 'm1', at: 2, status: 'working', levelRoomId: 'r1', permissionCap: FULL },
  }
  const wide = team(t, { bots: { m1: { permission: FULL } }, room: { permission: FULL }, tasks })
  await wide.rt.load()
  await wide.rt.resolveAgent('t1')
  await wide.settle()
  assert.deepEqual(wide.presets('t1'), [WRITE])
  const narrow = team(t, { bots: { m1: { permission: FULL } }, room: { permission: WRITE }, tasks })
  await narrow.rt.load()
  await narrow.rt.resolveAgent('t2')
  await narrow.settle()
  assert.deepEqual(narrow.presets('t2'), [WRITE])
})

test('a tool that works before it starts the task still carries the group, as grant_wish does', async (t) => {
  const { rt, call, presets, settle, toolCall, wish } = team(t, { bots: { m1: { permission: FULL } }, room: { permission: WRITE } })
  await call('state', {})
  const task = await toolCall('g1', async () => {
    await rt.load()
    await new Promise(resolve => setTimeout(resolve, 5))
    await new Promise(resolve => setImmediate(resolve))
    return wish('m1', { cwd: tmpdir(), agentPreset: 'standard' })
  })
  await settle()
  assert.deepEqual(presets(task), [WRITE])
})

test('a call the Bot\'s deny list refuses is still refused, and its body never runs', async (t) => {
  const { call, toolCall, wish } = team(t, { bots: { m1: { permission: FULL, denyTools: ['grant_wish'] } }, room: { permission: WRITE } })
  await call('state', {})
  let ran = false
  await assert.rejects(toolCall('g1', () => { ran = true; return wish() }), /does not have the grant_wish tool/)
  assert.equal(ran, false)
})

test('deleting the Bot caps its task at the narrowed level, not at the Bot\'s own', async (t) => {
  const { rt, call, presets, settle, toolCall, wish } = team(t, { bots: { b2: { permission: FULL } }, room: { permission: WRITE }, defaultPreset: FULL })
  await call('state', {})
  const task = await toolCall('g2', () => wish('b2'))
  await settle()
  assert.deepEqual(presets(task), [WRITE])
  assert.equal((await call('delete-bot', { id: 'b2' })).ok, true)
  await settle()
  assert.equal(rt.state.tasks[task].permissionCap, WRITE)
  assert.deepEqual(presets(task), [WRITE])
})

test('a forgotten task is left at the narrowed level it ran at', async (t) => {
  // 60 remembered tasks; the oldest was started from the group, under a wide default.
  const tasks = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`t${i}`, { title: 'Old', from: 'm1', at: i + 1, status: 'done', ...(i === 0 ? { levelRoomId: 'r1' } : {}) }]))
  const { rt, call, presets, settle, wish } = team(t, { bots: { m1: { permission: FULL } }, room: { permission: WRITE }, tasks, defaultPreset: FULL })
  await call('state', {})
  await rt.resolveAgent('t0')
  await settle()
  assert.deepEqual(presets('t0'), [WRITE])
  await wish()
  await settle()
  assert.equal(rt.state.tasks.t0, undefined)
  assert.deepEqual(presets('t0'), [WRITE])
})

test('an Auto that fails to set is not replaced by a level wider than its fallback', async (t) => {
  // The group's level sits between workspace-write and Auto. Without the group a failed
  // Auto runs as workspace-write, so the task takes that, whether Auto would hold or not.
  const custom = { trusting: { sandbox: 'workspace-write', approval: 'never' } }
  const { call, service, presets, settle, toolCall, wish } = team(t, { bots: { m1: { permission: 'auto' } }, room: { permission: 'trusting' }, custom })
  await call('state', {})
  const set = service.set
  service.set = (session, name) => {
    if (name === 'auto') throw new Error('permission: Auto is not ready')
    set(session, name)
  }
  const task = await toolCall('g1', () => wish())
  await settle()
  assert.deepEqual(presets(task), [WRITE])
  // A group below the fallback still narrows an Auto task.
  const low = team(t, { bots: { m1: { permission: 'auto' } }, room: { permission: 'read-only' }, custom: READ })
  await low.call('state', {})
  const read = await low.toolCall('g1', () => low.wish())
  await low.settle()
  assert.deepEqual(low.presets(read), ['read-only'])
})

test('a subagent child of a group Session carries that group; a child of the own chat does not', async (t) => {
  const { ctx, rt, call, presets, settle, wish } = team(t, { bots: { m1: { permission: FULL } }, room: { permission: WRITE } })
  await call('state', {})
  const ownChat = rt.chatOf('m1')
  const headers = {
    g1: { id: 'g1' },
    [ownChat]: { id: ownChat },
    child: { id: 'child', origin: 'subagent', parentSession: 'g1' },
    grandchild: { id: 'grandchild', origin: 'subagent', parentSession: 'child' },
    aside: { id: 'aside', origin: 'subagent', parentSession: ownChat },
    elsewhere: { id: 'elsewhere' },
    lost: { id: 'lost', origin: 'subagent', parentSession: 'nowhere' },
  }
  ctx.sessions.get = id => (headers[id] ? { id, header: headers[id] } : undefined)
  // The tool deny guard is the first listener; the child's agent carries its own header.
  const guard = ctx.listeners.get('tools/execute')[0]
  const from = (id, withHeader = true) => guard({ name: 'grant_wish', arguments: {}, agent: { id, session: { id, ...(withHeader ? { header: headers[id] } : {}) } } }, () => wish())
  const tasks = { child: await from('child'), grandchild: await from('grandchild', false), aside: await from('aside'), elsewhere: await from('elsewhere') }
  await settle()
  assert.deepEqual(presets(tasks.child), [WRITE])
  assert.deepEqual(presets(tasks.grandchild), [WRITE])
  assert.deepEqual(presets(tasks.aside), [FULL])
  assert.deepEqual(presets(tasks.elsewhere), [FULL])
  assert.equal(rt.state.tasks[tasks.elsewhere].levelRoomId, undefined)
  const taskIds = Object.keys(rt.state.tasks)
  const create = t.mock.method(ctx.sessionController, 'create')
  await assert.rejects(from('lost'), { code: 'bot/refused', message: POLICY_UNAVAILABLE_TEXT })
  assert.equal(create.mock.callCount(), 0)
  assert.deepEqual(Object.keys(rt.state.tasks), taskIds)
})

test('a group Session indexed during the call is found when the task starts', async (t) => {
  const { ctx, rt, call, presets, settle, toolCall, wish } = team(t, { bots: { m1: { permission: FULL } }, room: { permission: WRITE } })
  await call('state', {})
  ctx.sessions.get = id => id === 'g9' ? { id, header: { id } } : undefined
  assert.equal(rt.groupOwners.has('g9'), false)
  const task = await toolCall('g9', async () => {
    rt.groupOwners.set('g9', { botId: 'm1', roomId: 'r1' })
    return wish()
  })
  await settle()
  assert.deepEqual(presets(task), [WRITE])
})
