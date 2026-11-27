// A task started from inside another task's tool call (as another plugin's tool may do with
// rt.startTask) never runs wider than that task: the second hop of #974 (#1030). The parent
// is kept as `levelTaskId` and read live; narrowing only. The team runs over a fake DSH
// presets service, as in task-caller-group.test.js.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { HELD_NOT_SET } from '../src/shared/held.js'
import { fakeContext } from './fake-ctx.js'

const FULL = 'danger-full-access'
const WRITE = 'workspace-write'
const STOCK = {
  [WRITE]: { sandbox: 'workspace-write', approval: 'ask' },
  [FULL]: { sandbox: 'danger-full-access', approval: 'never' },
}
const AUTO_SPEC = { sandbox: 'danger-full-access', approval: 'ask' }
const READ = { 'read-only': { sandbox: 'read-only', approval: 'ask' } }
const ODD = { odd: { sandbox: 'elsewhere', approval: 'ask' } }

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
// A bounded wait for `check` to hold: no step of these tests leans on a fixed sleep.
async function until(check, what = 'the condition') {
  const end = Date.now() + 15_000
  for (;;) {
    if (check()) return
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}
const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index])
// Waits until `task` was set to exactly `expected`, in order, then asserts it.
async function setTo(presets, task, expected) {
  await until(() => same(presets(task), expected), `${task} to be set to ${expected.join(', ')}`).catch(() => {})
  assert.deepEqual(presets(task), expected, task)
}
// Waits until the last level set on `task` is `expected`, then asserts it.
async function last(presets, task, expected) {
  await until(() => presets(task).at(-1) === expected, `${task} to end at ${expected}`).catch(() => {})
  assert.equal(presets(task).at(-1), expected, task)
}
const record = (from, extra = {}) => ({ title: 'Task', ...(from ? { from } : {}), at: 1, status: 'working', ...extra })

function team(t, { auto = true, bots = {}, room = {}, tasks, custom = {}, defaultPreset = WRITE, acp, born = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-task-in-task-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM, bots: { m1: { ...TEAM.bots.m1, ...bots.m1 }, b2: { ...TEAM.bots.b2, ...bots.b2 } }, rooms: { r1: { ...TEAM.rooms.r1, ...room } }, ...(tasks ? { tasks } : {}) }))
  const log = []
  const instructions = new Map()
  const open = new Set()
  const presetOf = new Map()
  const service = {
    auto,
    // `<session>` or `<session>:<level>`: a set that fails there.
    failing: new Set(),
    names: () => [...Object.keys(STOCK), ...Object.keys(custom), ...(service.auto ? ['auto'] : [])],
    defaultPreset,
    catalog: () => ({ options: service.names().map(value => ({ value, name: value })), defaultOptions: [], defaultPreset: service.defaultPreset }),
    resolve: (name) => {
      if (!service.names().includes(name)) throw new Error(`permission: unknown preset "${name}"`)
      return name === 'auto' ? AUTO_SPEC : STOCK[name] ?? custom[name]
    },
    current: session => presetOf.get(session.id),
    set: (session, name) => {
      service.resolve(name)
      if (service.failing.has(session.id) || service.failing.has(`${session.id}:${name}`)) throw new Error('permission: not ready')
      if (presetOf.get(session.id) !== name) log.push(`${session.id} preset ${name}`)
      presetOf.set(session.id, name)
    },
  }
  const ctx = fakeContext({ services: { permissionPresets: service, ...(acp ? { acpAgents: acp } : {}) } })
  let sessions = 0
  Object.assign(ctx, {
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
        // `born`: as DSH does, a new Session reads the default level, set by no one.
        if (born) presetOf.set(sessionId, service.defaultPreset)
        for (const listener of ctx.listeners.get('session/created') ?? []) void listener({ id: sessionId })
        return { sessionId }
      },
      async resolveAgent(sessionId) {
        const session = { id: sessionId }
        if (!open.has(sessionId)) {
          open.add(sessionId)
          for (const listener of ctx.listeners.get('session/created') ?? []) void Promise.resolve(listener(session)).catch(() => {})
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
  // A task started from `sessionId`'s tool call.
  const from = (sessionId, ...args) => toolCall(sessionId, () => wish(...args))
  return { ctx, rt, service, call, presets, toolCall, wish, from, log, instructions, made: () => sessions }
}

test('a task started from inside a narrowed task runs no wider than the group', async (t) => {
  const { rt, call, presets, from, log } = team(t, { bots: { m1: { permission: FULL } }, room: { permission: WRITE } })
  await call('state', {})
  const first = await from('g1')
  const second = await from(first)
  await setTo(presets, first, [WRITE])
  await setTo(presets, second, [WRITE])
  assert.ok(log.indexOf(`${second} preset ${WRITE}`) < log.indexOf(`${second} first turn`), log.join(' | '))
  assert.equal(rt.state.tasks[second].levelRoomId, 'r1')
  assert.equal(rt.state.tasks[second].levelTaskId, first)
  // For the level only: the report still goes to the Bot's own chat.
  assert.equal(rt.state.tasks[second].roomId, undefined)
})

test('the whole chain is bound, and a subagent child of a task is that task', async (t) => {
  const { ctx, rt, call, presets, from, wish } = team(t, { bots: { m1: { permission: FULL } }, room: { permission: WRITE } })
  await call('state', {})
  const a = await from('g1')
  const b = await from(a)
  const c = await from(b)
  const headers = { child: { origin: 'subagent', parentSession: c }, grandchild: { origin: 'subagent', parentSession: 'child' } }
  ctx.sessions.get = id => (headers[id] ? { header: headers[id] } : undefined)
  const guard = ctx.listeners.get('tools/execute')[0]
  const d = await guard({ name: 'grant_wish', arguments: {}, agent: { id: 'grandchild', session: { id: 'grandchild' } } }, () => wish())
  for (const task of [b, c, d]) await setTo(presets, task, [WRITE])
  assert.equal(rt.state.tasks[c].levelTaskId, b)
  assert.equal(rt.state.tasks[d].levelTaskId, c)
  assert.equal(rt.state.tasks[d].levelRoomId, 'r1')
})

test('a parent asked for in a group gives its child that group for the level', async (t) => {
  const { rt, call, presets, toolCall, wish, from } = team(t, { bots: { m1: { permission: FULL } }, room: { permission: WRITE } })
  await call('state', {})
  const parent = await toolCall(rt.chatOf('m1'), () => wish('m1', { roomId: 'r1' }))
  const child = await from(parent)
  await setTo(presets, child, [WRITE])
  assert.equal(rt.state.tasks[child].levelRoomId, 'r1')
  assert.equal(rt.state.tasks[child].roomId, undefined)
})

test('it only narrows: a wide parent or group never raises the child', async (t) => {
  const low = team(t, { bots: { m1: { permission: WRITE } }, room: { permission: FULL } })
  await low.call('state', {})
  const kept = await low.from(await low.from('g1'))
  await setTo(low.presets, kept, [WRITE])

  // A wide parent of another Bot gives a narrow Bot's task nothing.
  const mixed = team(t, { bots: { m1: { permission: FULL }, b2: { permission: WRITE } } })
  await mixed.call('state', {})
  const mixedParent = await mixed.from(mixed.rt.chatOf('m1'))
  const own = await mixed.from(mixedParent, 'b2')
  await setTo(mixed.presets, own, [WRITE])
  const mismatched = mixed.rt.state.tasks[own]
  assert.deepEqual(mismatched, { title: 'Wish', from: 'b2', at: mismatched.at, status: 'working', levelTaskId: mixedParent })

  // No group and the same Bot: the level is the Bot's, as before.
  const free = team(t, { bots: { m1: { permission: FULL } } })
  await free.call('state', {})
  const parent = await free.from(free.rt.chatOf('m1'))
  const child = await free.from(parent)
  await setTo(free.presets, child, [FULL])
  for (const [id, lineage] of [[parent, {}], [child, { levelTaskId: parent }]]) {
    const task = free.rt.state.tasks[id]
    assert.match(task.skillsInstructionsId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
    assert.equal(task.skillsInstructionsId, free.instructions.get(id))
    assert.ok(Number.isFinite(task.at))
    assert.deepEqual(task, {
      title: 'Wish', from: 'm1', at: task.at, status: 'working', ...lineage,
      skills: [], skillsInstructionsId: free.instructions.get(id), skillsOwner: 'm1',
    })
  }
  assert.notEqual(free.instructions.get(parent), free.instructions.get(child))
})

test('a child of a wider Bot is bound by its parent, live', async (t) => {
  const { rt, call, presets, from } = team(t, { bots: { m1: { permission: WRITE }, b2: { permission: FULL } }, custom: READ })
  await call('state', {})
  const parent = await from(rt.chatOf('m1'))
  const child = await from(parent, 'b2')
  await setTo(presets, child, [WRITE])
  // Lowering the parent's Bot lowers the child, which is another Bot's.
  assert.equal((await call('update-bot', { id: 'm1', permission: 'read-only' })).ok, true)
  await last(presets, parent, 'read-only')
  await last(presets, child, 'read-only')
  // Raising it gives the child no more than the parent has, and never more than its own.
  assert.equal((await call('update-bot', { id: 'm1', permission: WRITE })).ok, true)
  await last(presets, child, WRITE)
  assert.equal((await call('update-bot', { id: 'm1', permission: FULL })).ok, true)
  await last(presets, child, FULL)
  assert.equal((await call('update-bot', { id: 'b2', permission: WRITE })).ok, true)
  await last(presets, child, WRITE)
})

test('the chain follows the group it came from', async (t) => {
  const { call, presets, from } = team(t, { bots: { m1: { permission: FULL } }, room: { permission: FULL } })
  await call('state', {})
  const a = await from('g1')
  const b = await from(a)
  await setTo(presets, b, [FULL])
  assert.equal((await call('update-room', { id: 'r1', permission: WRITE })).ok, true)
  await setTo(presets, a, [FULL, WRITE])
  await setTo(presets, b, [FULL, WRITE])
  assert.equal((await call('update-room', { id: 'r1', permission: null })).ok, true)
  await last(presets, b, FULL)
})

test('a parent capped by a deleted group or Bot still binds its children', async (t) => {
  const { rt, call, presets, from } = team(t, { bots: { m1: { permission: FULL }, b2: { permission: FULL } }, room: { permission: WRITE }, defaultPreset: FULL })
  await call('state', {})
  const a = await from('g1')
  const b = await from(a, 'b2')
  assert.equal((await call('delete-room', { id: 'r1' })).ok, true)
  assert.equal(rt.state.tasks[a].permissionCap, WRITE)
  await setTo(presets, b, [WRITE])
  // One started after the group went.
  const c = await from(a, 'b2')
  await setTo(presets, c, [WRITE])
  assert.equal(rt.state.tasks[c].levelRoomId, 'r1')
  // The parent's Bot goes: under a wide default, the children stay.
  assert.equal((await call('delete-bot', { id: 'b2' })).ok, true)
  await last(presets, b, WRITE)
  await last(presets, c, WRITE)

  // After a restart, from the saved records alone.
  const tasks = { t1: record('m1', { permissionCap: WRITE }), t2: record('b2', { levelTaskId: 't1' }), t3: record('b2', { levelTaskId: 't2' }) }
  const again = team(t, { bots: { m1: { permission: FULL }, b2: { permission: FULL } }, tasks })
  await again.rt.load()
  await again.rt.resolveAgent('t3')
  await setTo(again.presets, 't3', [WRITE])
})

test('a child\'s own stricter cap holds under a wider parent', async (t) => {
  const tasks = { t1: record('m1'), t2: record('m1', { levelTaskId: 't1', permissionCap: WRITE }), t3: record('m1') }
  const { rt, presets } = team(t, { bots: { m1: { permission: FULL } }, tasks })
  await rt.load()
  for (const id of ['t1', 't2', 't3']) await rt.resolveAgent(id)
  await setTo(presets, 't1', [FULL])
  await setTo(presets, 't2', [WRITE])
  // The same record without a parent, as before.
  await setTo(presets, 't3', [FULL])
})

test('an ended task is kept past the cap only while a working task descends from it', async (t) => {
  // 60 ended tasks; the two oldest are a chain a working task hangs from. The default is
  // narrower than the level they run at, which a forgotten task would be reset to.
  const tasks = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`t${i}`, { title: 'Old', from: 'm1', at: i + 1, status: 'done', ...(i === 1 ? { levelTaskId: 't0' } : {}) }]))
  tasks.live = record('b2', { levelTaskId: 't1' })
  // An ended task's own forebear is not kept for it.
  tasks.t5.levelTaskId = 't4'
  const { rt, call, presets, wish } = team(t, { bots: { m1: { permission: FULL }, b2: { permission: FULL } }, tasks })
  await call('state', {})
  await rt.resolveAgent('live')
  await setTo(presets, 'live', [FULL])
  for (let i = 0; i < 4; i += 1) await wish()
  assert.ok(rt.state.tasks.t0 && rt.state.tasks.t1, 'the chain is kept')
  for (const id of ['t2', 't3', 't4']) assert.equal(rt.state.tasks[id], undefined, id)
  await setTo(presets, 'live', [FULL])
  // Still live: lowering the forebear's Bot reaches it.
  assert.equal((await call('update-bot', { id: 'm1', permission: WRITE })).ok, true)
  await last(presets, 'live', WRITE)
  // Once the working task has ended its forebears go as any other ended task.
  rt.state.tasks.live.status = 'done'
  rt.state.tasks.live.endedAt = Date.now()
  await wish()
  await wish()
  assert.equal(rt.state.tasks.t0, undefined)
  assert.equal(rt.state.tasks.t1, undefined)
})

test('a long chain of tasks does not grow the remembered list, and stops at 32 deep', async (t) => {
  const tasks = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`t${i}`, { title: 'Old', from: 'm1', at: i + 1, status: 'done' }]))
  const { rt, call, wish, from, made } = team(t, { bots: { m1: { permission: FULL } }, tasks })
  await call('state', {})
  const end = (id) => { Object.assign(rt.state.tasks[id], { status: 'done', endedAt: Date.now() }) }
  const working = () => Object.values(rt.state.tasks).filter(task => task.status === 'working').length
  let tip = await wish()
  const chain = [tip]
  // Each task starts the next and ends: only the working one's forebears are kept.
  for (let i = 1; i < 32; i += 1) {
    const next = await from(tip)
    end(tip)
    tip = next
    chain.push(tip)
    assert.ok(Object.keys(rt.state.tasks).length <= 60 + chain.length, `${Object.keys(rt.state.tasks).length} records at depth ${chain.length}`)
  }
  assert.equal(working(), 1)
  for (const id of chain) assert.ok(rt.state.tasks[id], id)
  // The 33rd is refused before a Session is made for it.
  const before = Object.keys(rt.state.tasks).length
  const sessions = made()
  await assert.rejects(from(tip), /32 tasks deep at most, so nothing was started/)
  assert.equal(Object.keys(rt.state.tasks).length, before)
  assert.equal(made(), sessions, 'no Session was made for it')
  // The chain ended: the next start brings the list back to the cap.
  end(tip)
  await wish()
  assert.equal(Object.keys(rt.state.tasks).length, 60)
})

test('a parent that is no longer known gives the narrowest level, and a loop of links ends', async (t) => {
  const tasks = { t1: record('m1', { levelTaskId: 'gone' }), t2: record('m1', { levelTaskId: 't3' }), t3: record('m1', { levelTaskId: 't2' }) }
  const { rt, presets } = team(t, { bots: { m1: { permission: FULL } }, tasks })
  await rt.load()
  await rt.resolveAgent('t1')
  await rt.resolveAgent('t2')
  await setTo(presets, 't1', [WRITE])
  await setTo(presets, 't2', [WRITE])
})

test('an explicit roomId keeps its routing and its level, under the parent\'s', async (t) => {
  const { ctx, rt, call, presets, toolCall, wish, from } = team(t, { bots: { m1: { permission: WRITE }, b2: { permission: FULL } }, room: { permission: FULL } })
  await call('state', {})
  const parent = await from(rt.chatOf('m1'))
  const child = await toolCall(parent, () => wish('b2', { roomId: 'r1' }))
  // The control: the same start from the Bot's own chat takes the group's level, as before.
  const control = await toolCall(rt.chatOf('b2'), () => wish('b2', { roomId: 'r1' }))
  await setTo(presets, child, [WRITE])
  await setTo(presets, control, [FULL])
  assert.deepEqual([rt.state.tasks[child].roomId, rt.state.tasks[child].levelRoomId, rt.state.tasks[child].levelTaskId], ['r1', undefined, parent])
  assert.equal(rt.state.tasks[control].levelTaskId, undefined)
  // Its report still goes to the group it named.
  const deliver = t.mock.method(rt, 'deliver', async () => {})
  for (const listener of ctx.listeners.get('session/event') ?? []) listener({ id: child }, { type: 'turn/end', data: { reason: { kind: 'done' } } })
  await until(() => deliver.mock.calls.length > 0, 'the report to be delivered')
  assert.equal(deliver.mock.calls.length, 1)
  assert.deepEqual([deliver.mock.calls[0].arguments[0].toId, deliver.mock.calls[0].arguments[0].roomId, deliver.mock.calls[0].arguments[0].sessionId], ['b2', 'r1', 'g2'])
})

test('a start made after the task\'s tool call returned is not bound, as with a group', async (t) => {
  const { rt, call, presets, toolCall, wish, from } = team(t, { bots: { m1: { permission: WRITE }, b2: { permission: FULL } } })
  await call('state', {})
  const parent = await from(rt.chatOf('m1'))
  // A timer the call set fires after it returned: the Bot's own level.
  let late
  await toolCall(parent, async () => { setTimeout(() => { late = wish('b2') }, 5) })
  // A queue made during the call, drained after it with a start that is no one's.
  const queue = []
  let open
  const gate = new Promise((resolve) => { open = resolve })
  let drained
  await toolCall(parent, async () => { void gate.then(() => { drained = queue.shift()() }) })
  queue.push(() => wish('b2'))
  open()
  await until(() => late !== undefined && drained !== undefined, 'both put-off starts to be made')
  for (const task of [await late, await drained]) {
    await setTo(presets, task, [FULL])
    assert.deepEqual(Object.keys(rt.state.tasks[task]).sort(), ['at', 'from', 'status', 'title'], task)
  }
  // Inside the call it holds, even for a start the tool does not wait for.
  let unawaited
  await toolCall(parent, async () => { unawaited = wish('b2') })
  const inside = await unawaited
  await setTo(presets, inside, [WRITE])
  assert.equal(rt.state.tasks[inside].levelTaskId, parent)
})

test('levels that cannot be compared start nothing; the same level by name runs', async (t) => {
  // The child's own level cannot be ranked, the parent's can: nothing proves it allows less.
  const odd = team(t, { bots: { m1: { permission: WRITE }, b2: { permission: 'odd' } }, custom: ODD })
  await odd.call('state', {})
  const parent = await odd.from(odd.rt.chatOf('m1'))
  await assert.rejects(odd.from(parent, 'b2'), /could not be set, so nothing was started/)
  const refused = Object.entries(odd.rt.state.tasks).find(([, task]) => task.from === 'b2')
  assert.equal(refused[1].status, 'failed')
  assert.deepEqual(odd.presets(refused[0]), [])
  assert.ok(!odd.log.includes(`${refused[0]} first turn`))
  assert.ok(odd.log.includes(`${refused[0]} archived`))
  // The control: the same Bot's task with no parent runs at its level, as before.
  const alone = await odd.from(odd.rt.chatOf('b2'), 'b2')
  await setTo(odd.presets, alone, ['odd'])
  // And under a parent that runs at that very level.
  const same = await odd.from(alone, 'b2')
  await setTo(odd.presets, same, ['odd'])
  // The parent's level cannot be ranked, the child's can.
  await assert.rejects(odd.from(alone, 'm1'), /could not be set, so nothing was started/)

  // A saved Auto DSH does not offer is workspace-write on either side.
  const noAuto = team(t, { auto: false, bots: { m1: { permission: 'auto' }, b2: { permission: FULL } } })
  await noAuto.call('state', {})
  const fallback = await noAuto.from(await noAuto.from(noAuto.rt.chatOf('m1')), 'b2')
  await setTo(noAuto.presets, fallback, [WRITE])
  assert.equal(noAuto.rt.taskLevelOf(fallback), WRITE)
})

test('a task no Bot asked for keeps what its Session has, and its parent can only lower that', async (t) => {
  const { rt, service, call, presets, toolCall, from } = team(t, { bots: { m1: { permission: WRITE } }, defaultPreset: FULL, born: true })
  await call('state', {})
  const parent = await from(rt.chatOf('m1'))
  const start = () => rt.startTask({ title: 'Chore', text: 'Do it' })
  const child = await toolCall(parent, start)
  // The control: outside a task it keeps DSH's default, set by no one.
  const control = await toolCall(rt.chatOf('m1'), start)
  await setTo(presets, child, [WRITE])
  assert.deepEqual(presets(control), [])
  assert.equal(service.current({ id: control }), FULL)
  assert.deepEqual(Object.keys(rt.state.tasks[control]).sort(), ['at', 'from', 'status', 'title'])
  // Raising the parent raises nothing there: no one chose a level for this task.
  assert.equal((await call('update-bot', { id: 'm1', permission: FULL })).ok, true)
  await setTo(presets, child, [WRITE])

  // A wide parent sets nothing on it, even when the default is raised while the parent's
  // tool call runs and every Session takes its level again.
  const wide = team(t, { bots: { m1: { permission: FULL } }, born: true })
  await wide.call('state', {})
  const top = await wide.from(wide.rt.chatOf('m1'))
  let low
  await wide.toolCall(top, async () => {
    low = await wide.rt.startTask({ title: 'Chore', text: 'Do it' })
    wide.service.defaultPreset = FULL
    await wide.rt.applyTaskPermission(low)
    await wide.rt.reapplyTasks(() => true)
  })
  assert.deepEqual(wide.presets(low), [])
  assert.equal(wide.service.current({ id: low }), WRITE)
})
test('a task no Bot asked for whose level cannot be read is held under its parent, never set', async (t) => {
  // DSH reports no level for the new Session: its start under a task is refused.
  const blind = team(t, { bots: { m1: { permission: WRITE } }, defaultPreset: FULL })
  await blind.call('state', {})
  const start = rt => () => rt.startTask({ title: 'Chore', text: 'Do it' })
  const top = await blind.from(blind.rt.chatOf('m1'))
  await assert.rejects(blind.toolCall(top, start(blind.rt)), /nothing was started/)
  const refused = Object.entries(blind.rt.state.tasks).find(([, task]) => task.from === undefined)
  assert.equal(refused[1].status, 'failed')
  assert.deepEqual(blind.presets(refused[0]), [])
  assert.ok(!blind.log.includes(`${refused[0]} first turn`))
  // The control: not started inside a task, it starts and nothing is set, as before.
  const free = await blind.toolCall(blind.rt.chatOf('m1'), start(blind.rt))
  assert.deepEqual(blind.presets(free), [])
  assert.ok(blind.log.includes(`${free} first turn`))
  assert.equal(await blind.toolCall(free, () => 'ran', 'shell'), 'ran')

  // A running one: the parent is at workspace-write, the child's Session at full access,
  // and DSH stops telling its level.
  let gate
  const acp = { endSession() {}, holdTurns: (held) => { gate = held; return () => {} } }
  const { rt, service, call, presets, toolCall, from } = team(t, { bots: { m1: { permission: FULL } }, defaultPreset: FULL, born: true, acp })
  await call('state', {})
  const turn = sessionId => gate({ agent: { id: sessionId, session: { id: sessionId } } })
  const parent = await from(rt.chatOf('m1'))
  const child = await toolCall(parent, start(rt))
  assert.deepEqual(presets(child), [])
  assert.equal(await toolCall(child, () => 'ran', 'shell'), 'ran')
  const current = service.current
  service.current = (session) => {
    if (session.id === child) throw new Error('permission: not readable')
    return current(session)
  }
  const answer = await call('update-bot', { id: 'm1', permission: WRITE })
  assert.equal(answer.ok, false)
  // Its preset was not touched; no tool and no turn runs there.
  assert.deepEqual(presets(child), [])
  let ran = false
  await assert.rejects(toolCall(child, () => { ran = true }, 'shell'), /so no tool runs here/)
  assert.equal(ran, false)
  assert.equal(await turn(child), HELD_NOT_SET)
  // Readable again and wider than the parent: lowered, and it runs.
  service.current = current
  rt.levelRetryMs = 0
  assert.equal(await toolCall(child, () => 'ran', 'shell'), 'ran')
  await setTo(presets, child, [WRITE])
  assert.equal(await turn(child), undefined)
  // Held again, then readable and no wider than the parent: it runs, and nothing is set.
  service.current = (session) => {
    if (session.id === child) throw new Error('permission: not readable')
    return current(session)
  }
  await rt.applyTaskPermission(child).catch(() => {})
  await assert.rejects(toolCall(child, () => 'ran', 'shell'), /so no tool runs here/)
  service.current = current
  assert.equal(await toolCall(child, () => 'ran', 'shell'), 'ran')
  await setTo(presets, child, [WRITE])

  // Parent and child both at full access; the child cannot be read, then can: the hold is
  // lifted, its tools run, and nothing was set on it.
  const even = team(t, { bots: { m1: { permission: FULL } }, defaultPreset: FULL, born: true })
  await even.call('state', {})
  const top2 = await even.from(even.rt.chatOf('m1'))
  const kid = await even.toolCall(top2, start(even.rt))
  const told = even.service.current
  even.service.current = (session) => {
    if (session.id === kid) throw new Error('permission: not readable')
    return told(session)
  }
  await even.rt.applyTaskPermission(kid).catch(() => {})
  // Without waiting for the next try of a set: there is nothing to set.
  even.rt.levelRetryMs = 3_600_000
  await assert.rejects(even.toolCall(kid, () => 'ran', 'shell'), /so no tool runs here/)
  assert.notEqual(even.rt.permissionFactsOf(kid, { id: kid }).unapplied, undefined)
  even.service.current = told
  assert.equal(await even.toolCall(kid, () => 'ran', 'shell'), 'ran')
  assert.equal(even.rt.permissionFactsOf(kid, { id: kid }).unapplied, undefined)
  assert.deepEqual(even.presets(kid), [])
  assert.equal(told({ id: kid }), FULL)
})

test('a task started while an old one was being forgotten keeps that one', async (t) => {
  // 60 ended tasks of a Bot with a deny list, so forgetting one waits on its schedules.
  const tasks = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`t${i}`, { title: 'Old', from: 'm1', at: i + 1, status: 'done' }]))
  const { rt, call, presets, wish, from } = team(t, { bots: { m1: { permission: FULL, denyTools: ['never_there'] } }, tasks })
  await call('state', {})
  let release
  const held = new Promise((resolve) => { release = resolve })
  let waits = 0
  rt.revokeNewSchedules = async () => { if (++waits === 1) await held }
  // The first start picks t0 to forget and waits; t0's tool call starts a task meanwhile.
  const first = wish()
  await until(() => waits === 1, 'the first start to wait on the schedules')
  assert.ok(rt.state.tasks.t0)
  const child = await from('t0')
  release()
  await first
  assert.ok(rt.state.tasks.t0, 'the task a working one was started from is kept')
  assert.equal(rt.state.tasks[child].levelTaskId, 't0')
  await setTo(presets, child, [FULL])
  // No level was reset on it as on a forgotten task, and it still binds, live.
  assert.deepEqual(presets('t0'), [])
  assert.equal((await call('update-bot', { id: 'm1', permission: WRITE })).ok, true)
  await last(presets, child, WRITE)
})

test('a parent at Auto binds its child as workspace-write, whether its Auto holds or not', async (t) => {
  const { rt, service, call, presets, from } = team(t, { bots: { m1: { permission: 'auto' }, b2: { permission: FULL } } })
  await call('state', {})
  const parent = await from(rt.chatOf('m1'))
  const wide = await from(parent, 'b2')
  const same = await from(parent)
  await setTo(presets, parent, ['auto'])
  await setTo(presets, wide, [WRITE])
  await setTo(presets, same, [WRITE])
  // Auto stops holding on the parent, then holds again: the child was never above it.
  service.failing.add(`${parent}:auto`)
  await rt.applyTaskPermission(parent)
  service.failing.clear()
  await rt.applyTaskPermission(parent)
  await rt.applyTaskPermission(wide)
  await setTo(presets, wide, [WRITE])
  // After a restart, with nothing in memory, a child opened before its parent.
  const tasks = { t1: record('m1'), t2: record('b2', { levelTaskId: 't1' }), t3: record('m1') }
  const again = team(t, { bots: { m1: { permission: 'auto' }, b2: { permission: FULL } }, tasks })
  await again.rt.load()
  await again.rt.resolveAgent('t2')
  await again.rt.resolveAgent('t3')
  await setTo(again.presets, 't2', [WRITE])
  // The control: an Auto task with no parent runs on Auto, as before.
  await setTo(again.presets, 't3', ['auto'])
})

test('a parent with no level of its own binds by what its Session reads, never by the default', async (t) => {
  const { rt, service, call, presets, toolCall, from } = team(t, { bots: { m1: { permission: FULL } }, defaultPreset: FULL })
  await call('state', {})
  const parent = await toolCall(rt.chatOf('m1'), () => rt.startTask({ title: 'Chore', text: 'Do it' }))
  // Nothing set its level, and DSH reports none: the narrowest level offered.
  const unread = await from(parent)
  await setTo(presets, unread, [WRITE])
  // It reads workspace-write under a default that is now full access.
  service.set({ id: parent }, WRITE)
  const narrow = await from(parent)
  await setTo(presets, narrow, [WRITE])
  // It reads full access: the child has its Bot's level.
  service.set({ id: parent }, FULL)
  const wide = await from(parent)
  await setTo(presets, wide, [FULL])
  // A level that cannot be ranked there is not taken: the narrowest again.
  const odd = team(t, { bots: { m1: { permission: FULL } }, defaultPreset: FULL, custom: ODD })
  await odd.call('state', {})
  const strange = await odd.toolCall(odd.rt.chatOf('m1'), () => odd.rt.startTask({ title: 'Chore', text: 'Do it' }))
  odd.service.set({ id: strange }, 'odd')
  const child = await odd.from(strange)
  await setTo(odd.presets, child, [WRITE])
})

test('a child that cannot take the lower level runs no tool and no agent turn until it does', async (t) => {
  const ended = []
  let gate
  const acp = { endSession: (sessionId) => { ended.push(sessionId) }, holdTurns: (held) => { gate = held; return () => {} } }
  const { rt, service, call, presets, toolCall, from } = team(t, { bots: { m1: { permission: FULL }, b2: { permission: FULL } }, acp })
  await call('state', {})
  const turn = sessionId => gate({ agent: { id: sessionId, session: { id: sessionId } } })
  const parent = await from(rt.chatOf('m1'))
  const child = await from(parent, 'b2')
  // The control: a task of the same Bot that hangs from no one.
  const control = await from(rt.chatOf('b2'), 'b2')
  service.failing.add(child)
  const answer = await call('update-bot', { id: 'm1', permission: WRITE })
  assert.equal(answer.ok, false)
  assert.match(JSON.stringify(answer), /some conversations could not take it/)
  assert.equal(rt.state.bots.m1.permission, WRITE)
  await setTo(presets, child, [FULL])
  assert.ok(ended.includes(child))
  let ran = false
  await assert.rejects(toolCall(child, () => { ran = true }, 'shell'), /could not be set on this conversation, so no tool runs here/)
  assert.equal(ran, false)
  assert.equal(await turn(child), HELD_NOT_SET)
  // The diagnostics facts only read: the level it should run at, and the mark.
  const facts = rt.permissionFactsOf(child, { id: child })
  assert.deepEqual([facts.kind, facts.saved, facts.effective, facts.unapplied?.level], ['task', WRITE, FULL, WRITE])
  await setTo(presets, child, [FULL])
  // The control is untouched, and runs its tools and its turns.
  await setTo(presets, control, [FULL])
  assert.equal(await toolCall(control, () => 'ran', 'shell'), 'ran')
  assert.equal(await turn(control), undefined)
  assert.ok(!ended.includes(control))
  // The set works again: the next call tries it, and the tool runs at the lower level.
  service.failing.clear()
  rt.levelRetryMs = 0
  assert.equal(await toolCall(child, () => 'ran', 'shell'), 'ran')
  await last(presets, child, WRITE)
  assert.equal(await turn(child), undefined)
})

test('a running task whose level can no longer be compared with its parent\'s is held', async (t) => {
  const ended = []
  let gate
  const acp = { endSession: (sessionId) => { ended.push(sessionId) }, holdTurns: (held) => { gate = held; return () => {} } }
  const { rt, service, call, presets, toolCall, from } = team(t, { bots: { m1: { permission: WRITE }, b2: { permission: FULL } }, custom: ODD, acp })
  await call('state', {})
  const turn = sessionId => gate({ agent: { id: sessionId, session: { id: sessionId } } })
  const parent = await from(rt.chatOf('m1'))
  const child = await from(parent, 'b2')
  const control = await from(rt.chatOf('b2'), 'b2')
  await setTo(presets, child, [WRITE])
  assert.equal(await toolCall(child, () => 'ran', 'shell'), 'ran')
  // Its Bot takes a level DSH cannot rank: nothing proves it allows no more than the parent.
  const answer = await call('update-bot', { id: 'b2', permission: 'odd' })
  assert.equal(answer.ok, false)
  assert.match(JSON.stringify(answer), /some conversations could not take it/)
  // The level was never set there, the agent was ended, and no tool or turn runs.
  await setTo(presets, child, [WRITE])
  assert.ok(ended.includes(child))
  let ran = false
  await assert.rejects(toolCall(child, () => { ran = true }, 'shell'), /so no tool runs here/)
  assert.equal(ran, false)
  assert.equal(await turn(child), HELD_NOT_SET)
  assert.notEqual(rt.permissionFactsOf(child, { id: child }).unapplied, undefined)
  // Not even when the Session comes to read that level: reading it proves nothing.
  service.set({ id: child }, 'odd')
  rt.levelRetryMs = 0
  await assert.rejects(toolCall(child, () => { ran = true }, 'shell'), /so no tool runs here/)
  assert.equal(ran, false)
  // The control, with no parent, took the level and runs.
  await last(presets, control, 'odd')
  assert.equal(await toolCall(control, () => 'ran', 'shell'), 'ran')
  assert.ok(!ended.includes(control))
  // A level that can be compared again lifts it.
  assert.equal((await call('update-bot', { id: 'b2', permission: FULL })).ok, true)
  await last(presets, child, WRITE)
  assert.equal(await toolCall(child, () => 'ran', 'shell'), 'ran')
  assert.equal(await turn(child), undefined)
})
