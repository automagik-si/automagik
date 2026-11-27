// Work a Bot opens takes its opening Session's effective level, narrowing only.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { DENY_MAX } from '../src/host/tool-deny.js'
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

function team(t, { auto = true, bots = {}, room = {}, tasks, runs, services = {}, custom = {}, defaultPreset = WRITE, acp, born = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-opener-level-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM, bots: { m1: { ...TEAM.bots.m1, ...bots.m1 }, b2: { ...TEAM.bots.b2, ...bots.b2 } }, rooms: { r1: { ...TEAM.rooms.r1, ...room } }, ...(tasks ? { tasks } : {}), ...(runs ? { subscriptionRuns: runs } : {}) }))
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
  const ctx = fakeContext({ services: { permissionPresets: service, ...services, ...(acp ? { acpAgents: acp } : {}) } })
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

// An in-memory stand-in for DSH 0.2.2's schedule service: typed timing, target-based
// create, and edit({ action: 'delete' }) — the API apps/bots-dsh/src/host/schedules.js uses.
function scheduleService() {
  const tasks = new Map()
  let next = 1
  return {
    tasks,
    async create(request, actorSessionId) {
      const id = `schedule-${next++}`
      const timing = request.timing
      const entry = {
        id,
        kind: timing.kind,
        title: request.title,
        prompt: request.prompt,
        scheduledAt: timing.kind === 'at' ? timing.at : '2030-01-01T01:00:00.000Z',
        everySeconds: timing.every_seconds,
        time: timing.daily?.time ?? timing.weekly?.time,
        timeZone: timing.daily?.time_zone ?? timing.weekly?.time_zone ?? timing.cron?.time_zone,
        weekdays: timing.weekly?.weekdays,
        expression: timing.cron?.expression,
        rrule: timing.rrule,
        request,
        target: request.target,
        // DSH records the acting Session and the named target as involved.
        involvedSessionIds: [...new Set([
          ...(actorSessionId === undefined ? [] : [actorSessionId]),
          ...(request.target?.kind === 'new' ? [] : [request.target?.sessionId]),
        ])],
        status: 'active',
      }
      tasks.set(id, entry)
      return entry
    },
    async catalog() { return [...tasks.values()].map(entry => ({ ...entry })) },
    async edit({ id, action, patch }) {
      if (!tasks.has(id)) return { id, deleted: false, code: 'schedule_not_found' }
      if (action === 'delete') {
        tasks.delete(id)
        return { id, deleted: true }
      }
      if (action !== 'update') throw new Error(`unexpected edit ${action}`)
      const entry = tasks.get(id)
      if (patch?.active === false) entry.status = 'paused'
      else if (patch?.active === true) entry.status = 'active'
      return entry
    },
  }
}

const taskArgs = { title: 'Task', instructions: 'Check' }
const execOf = sessionId => ({ agent: { id: sessionId, session: { id: sessionId } } })
const start = (h, sessionId = 'm1') => h.toolCall(sessionId, () => h.ctx.registeredTools.get('start_task').execute(taskArgs, execOf(sessionId)), 'start_task')
const create = (h, sessionId = 'm1', args = {}) => {
  // These cases need only Omni as the existing Bot; leave Ada's name for the new one.
  delete h.rt.state.bots.b2
  return h.toolCall(sessionId, () => h.ctx.registeredTools.get('create_bot').execute({ name: 'Ada', role: 'Help', instructions: 'Help', ...args }, execOf(sessionId)), 'create_bot')
}
const newBot = h => Object.values(h.rt.state.bots).find(bot => !['m1', 'b2'].includes(bot.id))
function assertOwnedTask({ rt, instructions }, id, cap = {}) {
  const task = rt.state.tasks[id]
  assert.match(task.skillsInstructionsId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
  assert.equal(task.skillsInstructionsId, instructions.get(id))
  assert.ok(Number.isFinite(task.at))
  assert.deepEqual(task, {
    at: task.at, from: 'm1', status: 'working', title: 'Wish', ...cap,
    skills: [], skillsInstructionsId: instructions.get(id), skillsOwner: 'm1',
  })
}
const arm = (schedule, target, actor) => schedule.create({ title: 'Nightly', prompt: 'Check', timing: { kind: 'every', every_seconds: 3600 }, target }, actor)
function recordDelivery(schedule, id, sessionId) {
  const entry = schedule.tasks.get(id)
  entry.lastDelivery = { scheduledAt: '2030-01-01T01:00:00.000Z', deliveredAt: '2030-01-01T01:00:00.000Z', messageId: 'x', targetSessionId: sessionId }
  if (entry.target.kind !== 'new') entry.involvedSessionIds = [...new Set([...entry.involvedSessionIds, sessionId])]
}
function retarget(schedule, id, target, actor) {
  const entry = schedule.tasks.get(id)
  entry.target = target
  entry.involvedSessionIds = [...new Set([
    ...entry.involvedSessionIds,
    ...(actor === undefined ? [] : [actor]),
    ...(target.kind === 'new' ? [] : [target.sessionId]),
  ])]
}
async function guardOf(h) {
  await h.rt.load()
  await h.rt.revokeNewSchedules()
  return h.ctx.listeners.get('schedule/resolve-agent')[0]
}
async function delivery(h, guard, id, level = FULL) {
  const agent = { session: { id } }
  h.service.set(agent.session, level)
  assert.equal(await guard(id, async () => agent), agent)
  return agent
}

test('a lowered chat caps its wish before the first turn and after a Bot level change', async (t) => {
  const h = team(t, { bots: { m1: { permission: WRITE } }, custom: READ })
  await h.rt.load()
  h.service.set({ id: 'm1' }, 'read-only')
  const id = await h.toolCall('m1', () => h.wish())
  await setTo(h.presets, id, ['read-only'])
  assert.ok(h.log.indexOf(`${id} preset read-only`) < h.log.indexOf(`${id} first turn`))
  assert.equal(h.rt.state.tasks[id].permissionCap, 'read-only')
  assert.equal((await h.call('update-bot', { id: 'm1', permission: FULL })).ok, true)
  await last(h.presets, id, 'read-only')
})

test('start_task names a cap and keeps the exact old reply without one', async (t) => {
  for (const level of ['read-only', WRITE]) {
    const h = team(t, { bots: { m1: { permission: WRITE } }, custom: READ })
    await h.rt.load()
    h.service.set({ id: 'm1' }, level)
    const reply = await start(h)
    const id = Object.keys(h.rt.state.tasks)[0]
    const sentence = level === WRITE ? '' : ' It runs at the read-only permission level, no wider than this conversation.'
    assert.equal(reply, `Started task "Task" (${id}) under your row.${sentence} Its result comes back to you as a message; do not wait or poll.`)
  }
})

test('a read-only automation run opens a read-only task', async (t) => {
  const h = team(t, { bots: { m1: { permission: WRITE } }, custom: READ, runs: [{ id: 'r', sessionId: 'run', botId: 'm1', task: 'Check' }] })
  await h.rt.load()
  h.service.set({ id: 'run' }, 'read-only')
  assert.match(await start(h, 'run'), /It runs at the read-only permission level/)
  await setTo(h.presets, Object.keys(h.rt.state.tasks)[0], ['read-only'])
})

test('an unrankable opener gives the narrowest offered and only saves a narrower cap', async (t) => {
  for (const read of [true, false]) {
    const h = team(t, { bots: { m1: { permission: WRITE } }, custom: { ...ODD, ...(read ? READ : {}) } })
    await h.rt.load()
    h.service.set({ id: 'm1' }, 'odd')
    const id = await h.toolCall('m1', () => h.wish())
    await setTo(h.presets, id, [read ? 'read-only' : WRITE])
    if (read) assert.equal(h.rt.state.tasks[id].permissionCap, 'read-only')
    assertOwnedTask(h, id, read ? { permissionCap: 'read-only' } : {})
  }
})

test('an opener no narrower saves no cap and follows later Bot levels', async (t) => {
  const h = team(t, { bots: { m1: { permission: WRITE } }, custom: READ })
  await h.rt.load()
  h.service.set({ id: 'm1' }, WRITE)
  const id = await h.toolCall('m1', () => h.wish())
  assertOwnedTask(h, id)
  assert.equal((await h.call('update-bot', { id: 'm1', permission: FULL })).ok, true)
  await last(h.presets, id, FULL)
})

test('create_bot in a narrower group inherits that level and says so', async (t) => {
  const h = team(t, { bots: { m1: { permission: FULL } }, room: { permission: 'read-only' }, custom: READ })
  await h.rt.load()
  const reply = await create(h, 'g1')
  assert.match(reply, /Permission inherited from Omni \(read-only\), no wider than this conversation\./)
  const bot = newBot(h)
  assert.equal(bot.permission, 'read-only')
  await setTo(h.presets, bot.id, ['read-only'])
})

test('create_bot takes a lowered or unrankable opener, and a missing saved level never exceeds the default', async (t) => {
  for (const { own, chat, caller, expected } of [
    { own: FULL, chat: 'read-only', caller: 'm1', expected: 'read-only' },
    { chat: 'read-only', caller: 'g1', expected: 'read-only' },
    { chat: FULL, caller: 'g1', expected: WRITE },
    { own: FULL, chat: 'odd', caller: 'm1', expected: 'read-only' },
  ]) {
    const h = team(t, { bots: { m1: { permission: own } }, custom: { ...READ, ...ODD } })
    await h.rt.load()
    await h.ctx.sessionController.resolveAgent('m1')
    h.service.set({ id: 'm1' }, chat)
    assert.match(await create(h, caller), /Created Ada/)
    const bot = newBot(h)
    assert.equal(bot.permission, expected)
    await setTo(h.presets, bot.id, [expected])
  }
})

test('create_bot joins deny lists, checks only named tools, and omits an absent list', async (t) => {
  const h = team(t, { bots: { m1: { denyTools: ['bash'] } } })
  await h.rt.load()
  const checked = []
  h.rt.assertDenyTools = async (id, names) => { checked.push(names) }
  const reply = await create(h, 'm1', { deny_tools: ['write'] })
  assert.deepEqual(newBot(h).denyTools, ['bash', 'write'])
  assert.deepEqual(checked, [['write']])
  assert.ok(reply.endsWith('It never gets the tools Omni does not have: bash. It is greeting the user now.'), reply)
  const plain = team(t)
  await plain.rt.load()
  assert.match(await create(plain), /Created Ada/)
  assert.equal(Object.hasOwn(newBot(plain), 'denyTools'), false)
})

test('a full deny list deduplicates before its limit and refuses a larger union before creation', async (t) => {
  const names = Array.from({ length: DENY_MAX }, (_, i) => `t${i}`)
  const h = team(t, { bots: { m1: { denyTools: names } } })
  await h.rt.load()
  const checked = []
  h.rt.assertDenyTools = async (id, named) => { checked.push(named) }
  assert.match(await create(h, 'm1', { deny_tools: ['t0'] }), /Created Ada/)
  assert.deepEqual(newBot(h).denyTools, names)
  assert.deepEqual(checked, [['t0']])
  const larger = team(t, { bots: { m1: { denyTools: names } } })
  await larger.rt.load()
  const before = larger.made()
  assert.match(await create(larger, 'm1', { deny_tools: ['x'] }), /denyTools holds at most 64 tool names/)
  assert.equal(larger.made(), before)
})

test('a scheduled new_once Session is lowered before delivery', async (t) => {
  const schedule = scheduleService()
  const h = team(t, { bots: { b2: { permission: 'read-only' } }, custom: READ, services: { schedule } })
  await arm(schedule, { kind: 'new_once', sessionId: 'fresh-1' }, 'b2')
  const guard = await guardOf(h)
  await delivery(h, guard, 'fresh-1')
  assert.equal(h.presets('fresh-1').at(-1), 'read-only')
})

test('anonymous new deliveries count paused tasks and fold every Bot but keep their level when a person may have armed them', async (t) => {
  const schedule = scheduleService()
  const h = team(t, { bots: { b2: { permission: 'read-only' }, m1: { permission: WRITE } }, custom: READ, services: { schedule } })
  const paused = await arm(schedule, { kind: 'new' }, 'b2')
  await schedule.edit({ id: paused.id, action: 'update', patch: { active: false } })
  await arm(schedule, { kind: 'new' }, 'm1')
  const guard = await guardOf(h)
  await delivery(h, guard, 'fresh-2')
  assert.equal(h.presets('fresh-2').at(-1), 'read-only')
  const own = await arm(schedule, { kind: 'new' })
  await schedule.edit({ id: own.id, action: 'update', patch: { active: false } })
  const warnings = []
  h.rt.warn = (...args) => warnings.push(args.join(' '))
  await delivery(h, guard, 'fresh-3')
  assert.deepEqual(h.presets('fresh-3'), [FULL])
  assert.ok(warnings.some(line => line.includes('a task no Bot armed may be the one it is for')))
})

test('scheduled work never raises a Session or touches a person\'s or an existing Session', async (t) => {
  for (const { actor, kind, saved, initial } of [
    { actor: 'b2', kind: 'new_once', saved: FULL, initial: WRITE },
    { kind: 'new_once', saved: 'read-only', initial: FULL },
    { actor: 'b2', kind: 'session', saved: 'read-only', initial: FULL },
    { kind: 'session', saved: 'read-only', initial: FULL },
  ]) {
    const schedule = scheduleService()
    const h = team(t, { bots: { b2: { permission: saved } }, custom: READ, services: { schedule } })
    await arm(schedule, { kind, sessionId: 'mine' }, actor)
    if (kind === 'session') await arm(schedule, { kind: 'new' }, 'b2')
    const guard = await guardOf(h)
    await delivery(h, guard, 'mine', initial)
    assert.deepEqual(h.presets('mine'), [initial])
  }
})

test('a scheduled delivery is held when the required lowering fails', async (t) => {
  const schedule = scheduleService()
  const h = team(t, { bots: { b2: { permission: 'read-only' } }, custom: READ, services: { schedule } })
  await arm(schedule, { kind: 'new_once', sessionId: 'fresh-1' }, 'b2')
  const guard = await guardOf(h)
  h.service.set({ id: 'fresh-1' }, FULL)
  h.service.failing.add('fresh-1')
  await assert.rejects(guard('fresh-1', async () => ({ session: { id: 'fresh-1' } })), /held until its Session runs no wider/)
  assert.deepEqual(h.presets('fresh-1'), [FULL])
})

test('a Session a task already delivered to keeps its level, the person\'s own included', async (t) => {
  {
    const schedule = scheduleService()
    const h = team(t, { bots: { b2: { permission: 'read-only' } }, custom: READ, services: { schedule } })
    const own = await arm(schedule, { kind: 'session', sessionId: 'mine' }, 'mine')
    const guard = await guardOf(h)
    const agent = await delivery(h, guard, 'mine')
    recordDelivery(schedule, own.id, 'mine')
    retarget(schedule, own.id, { kind: 'new', create: {} }, 'b2')
    assert.equal(await guard('mine', async () => agent), agent)
    assert.deepEqual(h.presets('mine'), [FULL])
  }
  {
    const schedule = scheduleService()
    const h = team(t, { bots: { b2: { permission: 'read-only' } }, custom: READ, services: { schedule } })
    const task = await arm(schedule, { kind: 'new' }, 'b2')
    const guard = await guardOf(h)
    const agent = await delivery(h, guard, 'fresh-2')
    assert.equal(h.presets('fresh-2').at(-1), 'read-only')
    recordDelivery(schedule, task.id, 'fresh-2')
    h.service.set({ id: 'fresh-2' }, FULL)
    assert.equal(await guard('fresh-2', async () => agent), agent)
    assert.deepEqual(h.presets('fresh-2'), [FULL, 'read-only', FULL])
    await delivery(h, guard, 'fresh-3')
    assert.equal(h.presets('fresh-3').at(-1), 'read-only')
  }
  {
    const schedule = scheduleService()
    const h = team(t, { bots: { b2: { permission: 'read-only' } }, custom: READ, services: { schedule } })
    await arm(schedule, { kind: 'new' }, 'b2')
    const own = await arm(schedule, { kind: 'session', sessionId: 'mine' }, 'mine')
    const guard = await guardOf(h)
    const agent = await delivery(h, guard, 'mine')
    recordDelivery(schedule, own.id, 'mine')
    retarget(schedule, own.id, { kind: 'session', sessionId: 'other' }, 'other')
    assert.equal(await guard('mine', async () => agent), agent)
    assert.deepEqual(h.presets('mine'), [FULL])
  }
})

test('a stuck pause still lowers a Bot\'s fresh Session', async (t) => {
  const schedule = scheduleService()
  const h = team(t, { bots: { m1: { denyTools: ['bash'] }, b2: { permission: 'read-only' } }, custom: READ, services: { schedule } })
  schedule.edit = async () => { throw new Error('store busy') }
  await arm(schedule, { kind: 'new' }, 'm1')
  await arm(schedule, { kind: 'new_once', sessionId: 'fresh-1' }, 'b2')
  const guard = await guardOf(h)
  await delivery(h, guard, 'fresh-1')
  assert.equal(h.presets('fresh-1').at(-1), 'read-only')
  await assert.rejects(delivery(h, guard, 'fresh-9'), /blocked until its task can be paused/)
})

test('a schedule armed from a lowered chat opens no wider than that chat', async (t) => {
  const schedule = scheduleService()
  const h = team(t, { bots: { m1: { permission: WRITE } }, custom: READ, services: { schedule } })
  await arm(schedule, { kind: 'new_once', sessionId: 'fresh-1' }, 'm1')
  const guard = await guardOf(h)
  await h.ctx.sessionController.resolveAgent('m1')
  h.service.set({ id: 'm1' }, 'read-only')
  await delivery(h, guard, 'fresh-1')
  assert.equal(h.presets('fresh-1').at(-1), 'read-only')
})

test('a schedule armed from an unloaded group Session keeps its group\'s narrower level', async (t) => {
  const schedule = scheduleService()
  const h = team(t, { bots: { b2: { permission: FULL } }, room: { permission: 'read-only' }, custom: READ, services: { schedule } })
  await arm(schedule, { kind: 'new' }, 'g2')
  const guard = await guardOf(h)
  assert.equal(h.ctx.sessions.list().some(session => session.id === 'g2'), false)
  await delivery(h, guard, 'fresh-1')
  assert.equal(h.presets('fresh-1').at(-1), 'read-only')
})

test('a scheduled delivery is held when its current level cannot be compared', async (t) => {
  const schedule = scheduleService()
  const h = team(t, { bots: { b2: { permission: 'read-only' } }, custom: { ...READ, ...ODD }, services: { schedule } })
  await arm(schedule, { kind: 'new_once', sessionId: 'fresh-1' }, 'b2')
  const guard = await guardOf(h)
  h.service.set({ id: 'fresh-1' }, 'odd')
  await assert.rejects(guard('fresh-1', async () => ({ session: { id: 'fresh-1' } })), /held until its Session runs no wider/)
  assert.deepEqual(h.presets('fresh-1'), ['odd'])
})

test('a scheduled delivery is held when its catalog cannot be read', async (t) => {
  const schedule = scheduleService()
  const h = team(t, { bots: { b2: { permission: 'read-only' } }, custom: READ, services: { schedule } })
  await arm(schedule, { kind: 'new_once', sessionId: 'fresh-1' }, 'b2')
  const guard = await guardOf(h)
  h.service.set({ id: 'fresh-1' }, FULL)
  schedule.catalog = async () => { throw new Error('catalog unavailable') }
  await assert.rejects(guard('fresh-1', async () => ({ session: { id: 'fresh-1' } })), /catalog unavailable/)
  assert.deepEqual(h.presets('fresh-1'), [FULL])
})

test('an unreadable opener still narrows a task and a new Bot', async (t) => {
  for (const makeBot of [false, true]) {
    const h = team(t, { bots: { m1: { permission: makeBot ? FULL : WRITE } }, custom: READ })
    await h.rt.load()
    const current = h.service.current
    h.service.current = session => {
      if (session.id === 'm1') throw new Error('permissions projection missing')
      return current(session)
    }
    try {
      if (makeBot) {
        assert.match(await create(h), /Created Ada/)
        assert.equal(newBot(h).permission, 'read-only')
      } else {
        assert.match(await start(h), /It runs at the read-only permission level/)
        const id = Object.keys(h.rt.state.tasks)[0]
        await setTo(h.presets, id, ['read-only'])
        assert.equal(h.rt.state.tasks[id].permissionCap, 'read-only')
      }
    } finally {
      h.service.current = current
    }
  }
})

test('a schedule armed by an unloaded task child or earlier group part keeps its owner\'s narrower level', async (t) => {
  for (const child of [true, false]) {
    const schedule = scheduleService()
    const h = team(t, {
      bots: { m1: { permission: FULL }, b2: { permission: FULL } }, custom: READ, services: { schedule },
      ...(child ? { tasks: { t1: { title: 'Task', from: 'm1', at: 1, status: 'done', permissionCap: 'read-only' } } }
        : { room: { permission: 'read-only', segments: { b2: [{ sessionId: 'old-g2' }] } } }),
    })
    h.ctx.sessionPersistence = { stat: async id => id === 'kid' ? { header: { origin: 'subagent', parentSession: 't1' } } : undefined }
    await arm(schedule, { kind: 'new' }, child ? 'kid' : 'old-g2')
    const guard = await guardOf(h)
    assert.equal(h.ctx.sessions.list().some(session => session.id === 'kid'), false)
    await delivery(h, guard, 'fresh-1')
    assert.equal(h.presets('fresh-1').at(-1), 'read-only')
  }
})

test('a queued lowering lands before a scheduled comparison and is never undone', async (t) => {
  const h = team(t, { custom: READ })
  await h.rt.load()
  h.service.set({ id: 'fresh-1' }, FULL)
  const resolve = h.rt.resolveAgent
  let release
  let resolving
  const entered = new Promise(done => { resolving = done })
  const wait = new Promise(done => { release = done })
  h.rt.resolveAgent = async id => {
    if (id === 'fresh-1') { resolving(); await wait }
    return resolve(id)
  }
  const first = h.rt.applyPermission({ id: 'x', name: 'x', permission: 'read-only' }, 'fresh-1')
  await entered
  const scheduled = h.rt.lowerScheduledSession({ id: 'fresh-1' }, [WRITE])
  release()
  await Promise.all([first, scheduled])
  assert.equal(h.service.current({ id: 'fresh-1' }), 'read-only')
  assert.deepEqual(h.presets('fresh-1'), [FULL, 'read-only'])
})
