import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { install } from '../src/host/permissions.js'
import { narrowerLevel, narrowestOffered, rankOf } from '../src/host/permission-rank.js'
import { fakeContext } from './fake-ctx.js'

const PRESETS = { 'workspace-write': {}, 'danger-full-access': {} }

function runtime({ presets = true, fail = false } = {}) {
  const writes = []
  const service = {
    catalog: () => ({ options: Object.keys(PRESETS).map(value => ({ value, name: value })), defaultOptions: [], defaultPreset: 'workspace-write' }),
    resolve: (name) => { if (!(name in PRESETS)) throw new Error(`permission: unknown preset "${name}"`); return PRESETS[name] },
    set: (session, name) => { if (fail) throw new Error('permission: rejected'); writes.push(`${session}=${name}`) },
  }
  const ctx = { get: name => (presets && name === 'permissionPresets' ? service : undefined), on() {} }
  const rt = {
    ctx,
    chatOf: id => `${id}-chat`,
    groupSessionsOf: id => [`${id}-group`],
    groupOwners: new Map(),
    roomOf: () => undefined,
    resolveAgent: async sessionId => ({ session: sessionId }),
    warn() {},
  }
  install(rt)
  return { rt, writes }
}

test('a Bot\'s preset is set on its chat and its group Sessions', async () => {
  const { rt, writes } = runtime()
  const bot = { id: 'b1', name: 'Ada' }
  await rt.setPermission(bot, 'danger-full-access')
  assert.equal(bot.permission, 'danger-full-access')
  assert.deepEqual(writes, ['b1-chat=danger-full-access', 'b1-group=danger-full-access'])
})

test('a fresh Session gets the Bot\'s preset, and a Bot without one keeps the default', async () => {
  const { rt, writes } = runtime()
  await rt.applyPermission({ id: 'b1' }, 'fresh')
  await rt.applyPermission({ id: 'b1', permission: 'workspace-write' }, 'fresh')
  assert.deepEqual(writes, ['fresh=workspace-write'])
})

test('an unknown preset is refused and the Bot keeps its own', async () => {
  const { rt, writes } = runtime()
  const bot = { id: 'b1', permission: 'workspace-write' }
  await assert.rejects(rt.setPermission(bot, 'everything'), /unknown preset/)
  assert.equal(bot.permission, 'workspace-write')
  assert.deepEqual(writes, [])
})

test('the catalog lists the presets DSH offers, or nothing without the presets service', () => {
  assert.deepEqual(runtime().rt.permissionCatalog(), { options: [{ value: 'workspace-write', name: 'workspace-write' }, { value: 'danger-full-access', name: 'danger-full-access' }], defaultPreset: 'workspace-write' })
  assert.equal(runtime({ presets: false }).rt.permissionCatalog(), undefined)
})

test('a preset the Bot\'s own chat refuses is not kept', async () => {
  const { rt } = runtime({ fail: true })
  const bot = { id: 'b1', permission: 'workspace-write' }
  await assert.rejects(rt.setPermission(bot, 'danger-full-access'), /rejected/)
  assert.equal(bot.permission, 'workspace-write')
})

// The whole team over a fake DSH presets service writing to one log. As in DSH, a Session's
// first open fires session/created inside the resolve ("announced" follows the listeners'
// synchronous part), and a preset that does not change appends nothing. A Session in
// `closed` holds Auto that DSH will not restore.
const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', name: 'Omni', role: '', instructions: '', createdAt: 1 },
    b2: { id: 'b2', name: 'Ada', role: '', instructions: '', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Launch', named: true, members: ['m1', 'b2'], mode: 'everyone', notice: '', sessions: { b2: 'g2' }, seq: 0, log: [] } },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

// DSH's stock catalog (dsh-permission-presets): workspace-write and danger-full-access, and
// Auto while its layer is loaded; no read-only. `custom` adds presets a profile configures.
const STOCK = {
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
}
const AUTO_SPEC = { sandbox: 'danger-full-access', approval: 'ask' }

function team(t, { auto = true, bots = {}, loaded = [], closed = [], tasks, rooms = {}, custom = {}, defaultPreset = 'workspace-write' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-permissions-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM, bots: { m1: { ...TEAM.bots.m1, ...bots.m1 }, b2: { ...TEAM.bots.b2, ...bots.b2 } }, rooms: { r1: { ...TEAM.rooms.r1, ...rooms.r1 } }, ...(tasks ? { tasks } : {}) }))
  const log = []
  const opened = []
  const open = new Set(loaded)
  const presetOf = new Map()
  const service = {
    auto,
    names: () => [...Object.keys(STOCK), ...Object.keys(custom), ...(service.auto ? ['auto'] : [])],
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
      create: async () => ({ sessionId: `s${++sessions}` }),
      async resolveAgent(sessionId) {
        opened.push(sessionId)
        if (closed.includes(sessionId)) return { error: { code: 'gateway/internal', message: `resume failed for session "${sessionId}": Error: permission: cannot restore preset "auto" without its active integration` } }
        const session = { id: sessionId }
        if (!open.has(sessionId)) {
          open.add(sessionId)
          for (const listener of ctx.listeners.get('session/created') ?? []) void listener(session)
          log.push(`${sessionId} announced`)
        }
        await new Promise(resolve => setTimeout(resolve, 1))
        return { agent: { session, followup() {} } }
      },
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async (session) => { log.push(`${session.id} first turn`) }, list: () => loaded.map(id => ({ id })) },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  apply(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const of = sessionId => log.filter(line => line.startsWith(`${sessionId} `))
  const presets = sessionId => of(sessionId).filter(line => line.includes(' preset ')).map(line => line.split(' preset ')[1])
  // Settles the session/created re-applies a step left queued.
  const settle = () => new Promise(resolve => setTimeout(resolve, 20))
  // As DSH does, a new Session is announced while it is made, before startTask knows it
  // as a task.
  const announceOnCreate = () => {
    const create = ctx.sessionController.create
    ctx.sessionController.create = async (options) => {
      const created = await create(options)
      open.add(created.sessionId)
      for (const listener of ctx.listeners.get('session/created') ?? []) void listener({ id: created.sessionId })
      log.push(`${created.sessionId} announced`)
      return created
    }
  }
  return { ctx, rt: ctx.provided.get('omniTeam'), service, call, of, presets, opened, settle, announceOnCreate }
}

test('Auto is DSH\'s own Auto on every Session of the Bot or group; a lower level replaces it', async (t) => {
  const { rt, call, presets, settle } = team(t)
  assert.equal((await call('update-bot', { id: 'b2', permission: 'auto' })).ok, true)
  assert.equal((await call('update-room', { id: 'r1', permission: 'auto' })).ok, true)
  await rt.applyPermission(rt.botOf('b2'), 'fresh')
  // A new Bot takes the team default.
  assert.equal((await call('set-prefs', { permission: 'auto' })).ok, true)
  const created = await call('create-bot', { name: 'Nova' })
  assert.equal(created.value.permission, 'auto')
  await settle()
  for (const id of ['b2', 'g2', 'fresh', created.value.id]) assert.deepEqual(presets(id), ['auto'], id)
  await call('update-bot', { id: 'b2', permission: 'workspace-write' })
  await settle()
  assert.deepEqual(presets('b2'), ['auto', 'workspace-write'])

  // An idle Auto Bot: opening a Session sets its first preset within the announce, and
  // lowering the Bot opens its chat, whose session/created re-apply finds the new level.
  const idle = team(t, { bots: { b2: { permission: 'auto' } } })
  await idle.call('state', {})
  await idle.rt.resolveAgent('g2')
  assert.deepEqual(idle.of('g2').slice(0, 2), ['g2 preset auto', 'g2 announced'])
  assert.equal((await idle.call('update-bot', { id: 'b2', permission: 'workspace-write' })).ok, true)
  await idle.settle()
  assert.deepEqual(idle.presets('b2'), ['workspace-write'])

  // Applies to one Session run in turn: a lower level picked meanwhile lands last.
  const racing = team(t)
  await racing.call('state', {})
  await Promise.all([racing.call('update-bot', { id: 'b2', permission: 'auto' }), racing.call('update-bot', { id: 'b2', permission: 'workspace-write' })])
  await racing.settle()
  assert.equal(racing.service.current({ id: 'b2' }), 'workspace-write')
})

test('a saved Auto that cannot hold runs as workspace-write and says so', async (t) => {
  const runsAsFallback = async (setup, act) => {
    const { call, presets, rt, settle } = team(t, setup)
    await act({ call, rt })
    await settle()
    assert.deepEqual(presets('b2'), ['workspace-write'])
    const { value } = await call('state', {})
    const bot = value.bots.find(entry => entry.id === 'b2')
    assert.equal(bot.permission, 'auto')
    assert.equal(bot.permissionFallback, 'workspace-write')
  }
  // Without the layer DSH offers no Auto; a Bot saved on it before runs below it.
  await runsAsFallback({ auto: false, bots: { b2: { permission: 'auto' } } }, async ({ rt }) => {
    await rt.load()
    await rt.applyPermission(rt.botOf('b2'), 'b2')
  })
  // DSH refuses its own Auto when it comes to set it.
  const refusing = team(t)
  const set = refusing.service.set
  refusing.service.set = (session, name) => {
    if (name === 'auto') throw new Error('permission: Auto is not ready')
    set(session, name)
  }
  assert.equal((await refusing.call('update-bot', { id: 'b2', permission: 'auto' })).ok, true)
  await refusing.settle()
  assert.deepEqual(refusing.presets('b2'), ['workspace-write'])
  assert.equal((await refusing.call('state', {})).value.bots.find(entry => entry.id === 'b2').permissionFallback, 'workspace-write')
  // The layer unloads: every loaded Auto Session moves to workspace-write at once, and no
  // Session is opened. The windows learn of it through modelsKey, with no save.
  const { ctx, call, service, presets, opened, settle } = team(t, { bots: { b2: { permission: 'auto' } }, loaded: ['b2', 'g2'] })
  const before = (await call('state', {})).value
  service.auto = false
  for (const listener of ctx.listeners.get('permission-presets/catalog-changed')) void listener()
  await settle()
  assert.deepEqual(presets('b2'), ['workspace-write'])
  assert.deepEqual(presets('g2'), ['workspace-write'])
  assert.deepEqual(opened, [])
  const after = (await call('state', {})).value
  assert.equal(after.revision, before.revision)
  assert.notEqual(after.modelsKey, before.modelsKey)
  // Lowering a Bot whose chat DSH will not reopen keeps the new level for when it opens.
  const shut = team(t, { auto: false, bots: { b2: { permission: 'auto' } }, closed: ['b2'] })
  assert.equal((await shut.call('update-bot', { id: 'b2', permission: 'workspace-write' })).ok, true)
  assert.equal(shut.rt.botOf('b2').permission, 'workspace-write')
})

test('a task starts at the level of the Bot that asked, before its first turn', async (t) => {
  const { rt, call, of, presets, settle, announceOnCreate } = team(t, { bots: { m1: { permission: 'danger-full-access' } } })
  await call('state', {})
  announceOnCreate()
  const sessionId = await rt.startTask({ title: 'Wish', text: 'Do it', from: 'm1' })
  await settle()
  assert.deepEqual(presets(sessionId), ['danger-full-access'])
  const lines = of(sessionId)
  assert.ok(lines.indexOf(`${sessionId} preset danger-full-access`) < lines.indexOf(`${sessionId} first turn`), lines.join(' | '))

  // A Bot without a level of its own gives its task the catalog default.
  const plain = team(t)
  await plain.call('state', {})
  plain.announceOnCreate()
  const task = await plain.rt.startTask({ title: 'Chore', text: 'Do it', from: 'm1' })
  await plain.settle()
  assert.deepEqual(plain.presets(task), ['workspace-write'])

  // A task asked for in a group takes the group's level over the Bot's own, as the Bot's
  // Session in that group does.
  const grouped = team(t, { bots: { m1: { permission: 'workspace-write' } }, rooms: { r1: { permission: 'danger-full-access' } } })
  await grouped.call('state', {})
  grouped.announceOnCreate()
  const inGroup = await grouped.rt.startTask({ title: 'Wish', text: 'Do it', from: 'm1', roomId: 'r1' })
  await grouped.settle()
  assert.deepEqual(grouped.presets(inGroup), ['danger-full-access'])
})

test('a task gets its Bot\'s level again when DSH reopens it after a restart', async (t) => {
  const tasks = { t1: { title: 'Wish', from: 'm1', at: 1, status: 'working' }, t2: { title: 'Chore', from: 'b2', at: 2, status: 'working' } }
  const { rt, of, presets, settle } = team(t, { bots: { m1: { permission: 'danger-full-access' } }, tasks })
  await rt.load()
  await rt.resolveAgent('t1')
  await rt.resolveAgent('t2')
  await settle()
  // Once the team is loaded the level lands within DSH's announce, before anything runs.
  assert.deepEqual(of('t1').slice(0, 2), ['t1 preset danger-full-access', 't1 announced'])
  assert.deepEqual(presets('t2'), ['workspace-write'])
  // A loaded task of an Auto Bot runs as workspace-write when Auto review's layer unloads.
  const { ctx, service, call, presets: presetsOf, settle: settled } = team(t, { bots: { m1: { permission: 'auto' } }, tasks, loaded: ['t1'] })
  await call('state', {})
  service.auto = false
  for (const listener of ctx.listeners.get('permission-presets/catalog-changed')) void listener()
  await settled()
  assert.deepEqual(presetsOf('t1'), ['workspace-write'])
})

test('a running task follows its Bot when the Bot\'s level is lowered', async (t) => {
  const { rt, call, presets, settle, announceOnCreate } = team(t, { bots: { m1: { permission: 'danger-full-access' } } })
  await call('state', {})
  announceOnCreate()
  const task = await rt.startTask({ title: 'Wish', text: 'Do it', from: 'm1' })
  await settle()
  assert.deepEqual(presets(task), ['danger-full-access'])
  assert.equal((await call('update-bot', { id: 'm1', permission: 'workspace-write' })).ok, true)
  await settle()
  assert.equal(presets(task).at(-1), 'workspace-write', `task still at ${presets(task).join(' -> ')}`)

  // A task asked for in a group with a level of its own keeps the group's.
  const grouped = team(t, { bots: { m1: { permission: 'danger-full-access' } }, rooms: { r1: { permission: 'danger-full-access' } } })
  await grouped.call('state', {})
  grouped.announceOnCreate()
  const inGroup = await grouped.rt.startTask({ title: 'Wish', text: 'Do it', from: 'm1', roomId: 'r1' })
  assert.equal((await grouped.call('update-bot', { id: 'm1', permission: 'workspace-write' })).ok, true)
  await grouped.settle()
  assert.deepEqual(grouped.presets(inGroup), ['danger-full-access'])
})

test('a running group task follows the group when the group\'s level is lowered or cleared', async (t) => {
  const { rt, call, presets, settle, announceOnCreate } = team(t, { bots: { m1: { permission: 'workspace-write' } }, rooms: { r1: { permission: 'danger-full-access' } } })
  await call('state', {})
  announceOnCreate()
  const task = await rt.startTask({ title: 'Wish', text: 'Do it', from: 'm1', roomId: 'r1' })
  await settle()
  assert.deepEqual(presets(task), ['danger-full-access'])
  assert.equal((await call('update-room', { id: 'r1', permission: null })).ok, true)
  await settle()
  assert.equal(presets(task).at(-1), 'workspace-write', `task still at ${presets(task).join(' -> ')}`)
})

test('the task of a deleted Bot goes to the catalog default, now and after a restart', async (t) => {
  const tasks = { t1: { title: 'Wish', from: 'b2', at: 1, status: 'working' } }
  const { rt, call, presets, settle } = team(t, { bots: { b2: { permission: 'danger-full-access' } }, tasks })
  await rt.load()
  await rt.resolveAgent('t1')
  await settle()
  assert.deepEqual(presets('t1'), ['danger-full-access'])
  assert.equal((await call('delete-bot', { id: 'b2' })).ok, true)
  await settle()
  assert.deepEqual(presets('t1'), ['danger-full-access', 'workspace-write'])
  // Its task record outlives the Bot: a restart reopens it at the default too.
  const restarted = team(t, { tasks })
  await restarted.rt.load()
  delete restarted.rt.state.bots.b2
  await restarted.rt.resolveAgent('t1')
  await restarted.settle()
  assert.deepEqual(restarted.presets('t1'), ['workspace-write'])
})

test('a task startTask no longer remembers goes to the catalog default', async (t) => {
  // 60 remembered tasks; the oldest ran at its Bot's full access.
  const tasks = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`t${i}`, { title: 'Old', from: 'm1', at: i + 1, status: 'done' }]))
  const { rt, call, presets, settle, announceOnCreate } = team(t, { bots: { m1: { permission: 'danger-full-access' } }, tasks })
  await call('state', {})
  await rt.resolveAgent('t0')
  await settle()
  assert.deepEqual(presets('t0'), ['danger-full-access'])
  announceOnCreate()
  await rt.startTask({ title: 'New', text: 'Do it', from: 'm1' })
  await settle()
  assert.equal(rt.state.tasks.t0, undefined)
  assert.deepEqual(presets('t0'), ['danger-full-access', 'workspace-write'])
})

test('levels rank by what their preset allows, and what cannot be ranked gives the narrowest offered', () => {
  const custom = {
    builder: { sandbox: 'danger-full-access', approval: 'never' },
    careful: { sandbox: 'read-only', approval: 'ask' },
    odd: { sandbox: 'container', approval: 'ask' },
  }
  const catalogOf = names => ({
    catalog: () => ({ options: names.map(value => ({ value, name: value })), defaultPreset: 'workspace-write' }),
    resolve: (name) => {
      if (!names.includes(name)) throw new Error(`permission: unknown preset "${name}"`)
      return name === 'auto' ? AUTO_SPEC : STOCK[name] ?? custom[name]
    },
  })
  const stock = catalogOf(['workspace-write', 'danger-full-access', 'auto', 'builder', 'odd'])
  // Sandbox first, then approval: workspace-write < Auto < full access.
  assert.equal(narrowerLevel(stock, 'danger-full-access', 'workspace-write'), 'workspace-write')
  assert.equal(narrowerLevel(stock, 'auto', 'workspace-write'), 'workspace-write')
  assert.equal(narrowerLevel(stock, 'auto', 'danger-full-access'), 'auto')
  assert.equal(narrowerLevel(stock, 'builder', 'auto'), 'auto')
  assert.equal(narrowerLevel(stock, 'danger-full-access', 'danger-full-access'), 'danger-full-access')
  // Unknown, unresolvable or unrankable: the narrowest level this catalog offers.
  assert.equal(narrowerLevel(stock, 'read-only', 'danger-full-access'), 'workspace-write')
  assert.equal(narrowerLevel(stock, 'odd', 'danger-full-access'), 'workspace-write')
  assert.equal(narrowerLevel(stock, undefined, 'workspace-write'), 'workspace-write')
  assert.equal(narrowestOffered(stock), 'workspace-write')
  // A catalog with a narrower preset of its own offers that one.
  assert.equal(narrowerLevel(catalogOf(['workspace-write', 'careful', 'odd']), 'odd', 'workspace-write'), 'careful')
})

test('deleting a Bot never widens its running task, on the stock catalog', async (t) => {
  // A profile whose default is full access: the Bot's narrower level stays.
  const tasks = { t1: { title: 'Wish', from: 'b2', at: 1, status: 'working' } }
  const { rt, call, presets, settle } = team(t, { defaultPreset: 'danger-full-access', bots: { b2: { permission: 'workspace-write' } }, tasks, loaded: ['t1'] })
  await rt.load()
  await rt.applyTaskPermission('t1', { id: 't1' })
  await settle()
  assert.deepEqual(presets('t1'), ['workspace-write'])
  assert.equal((await call('delete-bot', { id: 'b2' })).ok, true)
  await settle()
  assert.deepEqual(presets('t1'), ['workspace-write'])
  // The cap is kept with the task: a re-apply (as after a restart) does not raise it.
  assert.equal(rt.state.tasks.t1.permissionCap, 'workspace-write')
  await rt.reapplyTasks(() => true)
  assert.deepEqual(presets('t1'), ['workspace-write'])
})

test('a deleted Bot on a custom preset leaves its task at a level the catalog offers', async (t) => {
  // A custom full-access preset ranks as what it allows: the default is narrower.
  const tasks = { t1: { title: 'Wish', from: 'b2', at: 1, status: 'working' } }
  const builder = team(t, { custom: { builder: { sandbox: 'danger-full-access', approval: 'never' } }, bots: { b2: { permission: 'builder' } }, tasks, loaded: ['t1'] })
  await builder.rt.load()
  await builder.rt.applyTaskPermission('t1', { id: 't1' })
  assert.equal((await builder.call('delete-bot', { id: 'b2' })).ok, true)
  await builder.settle()
  assert.deepEqual(builder.presets('t1'), ['builder', 'workspace-write'])
  // One that cannot be ranked fails closed to the narrowest offered, even with a wide default.
  const odd = team(t, { defaultPreset: 'danger-full-access', custom: { odd: { sandbox: 'container', approval: 'ask' } }, bots: { b2: { permission: 'odd' } }, tasks, loaded: ['t1'] })
  await odd.rt.load()
  await odd.rt.applyTaskPermission('t1', { id: 't1' })
  assert.equal((await odd.call('delete-bot', { id: 'b2' })).ok, true)
  await odd.settle()
  assert.deepEqual(odd.presets('t1'), ['odd', 'workspace-write'])
})

test('pruning an old task never widens it, on the stock catalog', async (t) => {
  const tasks = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`t${i}`, { title: 'Old', from: 'm1', at: i + 1, status: 'done' }]))
  const pruned = async (options, expected) => {
    const { rt, call, presets, settle, announceOnCreate } = team(t, { ...options, tasks })
    await call('state', {})
    await rt.resolveAgent('t0')
    await settle()
    announceOnCreate()
    await rt.startTask({ title: 'New', text: 'Do it', from: 'm1' })
    await settle()
    assert.equal(rt.state.tasks.t0, undefined)
    assert.deepEqual(presets('t0'), expected)
  }
  // A full-access default does not raise a workspace-write task.
  await pruned({ defaultPreset: 'danger-full-access', bots: { m1: { permission: 'workspace-write' } } }, ['workspace-write'])
  // A custom level that cannot be ranked goes to the narrowest offered.
  await pruned({ defaultPreset: 'danger-full-access', custom: { odd: { sandbox: 'container', approval: 'ask' } }, bots: { m1: { permission: 'odd' } } }, ['odd', 'workspace-write'])
})

test('deleting a group moves its running task to its Bot\'s own level, never above the group\'s', async (t) => {
  const tasks = { t1: { title: 'Wish', from: 'm1', at: 1, status: 'working', roomId: 'r1' } }
  const { rt, call, presets, settle } = team(t, { bots: { m1: { permission: 'workspace-write' } }, rooms: { r1: { permission: 'danger-full-access' } }, tasks, loaded: ['t1'] })
  await rt.load()
  await rt.applyTaskPermission('t1', { id: 't1' })
  await settle()
  assert.deepEqual(presets('t1'), ['danger-full-access'])
  const res = await call('delete-room', { id: 'r1' })
  assert.equal(res.ok, true, JSON.stringify(res))
  await settle()
  assert.equal(presets('t1').at(-1), 'workspace-write', `task after group deleted: ${presets('t1').join(' -> ')}`)

  // A group narrower than its Bot: the task stays at the group's level, and still follows
  // the Bot down.
  const narrow = team(t, { bots: { m1: { permission: 'danger-full-access' } }, rooms: { r1: { permission: 'auto' } }, tasks, loaded: ['t1'] })
  await narrow.rt.load()
  await narrow.rt.applyTaskPermission('t1', { id: 't1' })
  assert.equal((await narrow.call('delete-room', { id: 'r1' })).ok, true)
  await narrow.settle()
  assert.deepEqual(narrow.presets('t1'), ['auto'])
  assert.equal((await narrow.call('update-bot', { id: 'm1', permission: 'workspace-write' })).ok, true)
  await narrow.settle()
  assert.deepEqual(narrow.presets('t1'), ['auto', 'workspace-write'])

  // A custom group level: ranked as what it allows, or failed closed when it cannot be.
  const customRoom = async (custom, expected) => {
    const room = team(t, { defaultPreset: 'danger-full-access', custom, bots: { m1: { permission: 'danger-full-access' } }, rooms: { r1: { permission: Object.keys(custom)[0] } }, tasks, loaded: ['t1'] })
    await room.rt.load()
    await room.rt.applyTaskPermission('t1', { id: 't1' })
    assert.equal((await room.call('delete-room', { id: 'r1' })).ok, true)
    await room.settle()
    assert.deepEqual(room.presets('t1'), expected)
  }
  await customRoom({ reviewed: { sandbox: 'workspace-write', approval: 'ask' } }, ['reviewed'])
  await customRoom({ odd: { sandbox: 'container', approval: 'ask' } }, ['odd', 'workspace-write'])
})

test('when no level ranks, deleting a Bot leaves its task\'s level as it is and warns', async (t) => {
  const tasks = { t1: { title: 'Wish', from: 'b2', at: 1, status: 'working' } }
  const { rt, call, service, presets, settle } = team(t, { bots: { b2: { permission: 'danger-full-access' } }, tasks, loaded: ['t1'] })
  await rt.load()
  await rt.applyTaskPermission('t1', { id: 't1' })
  assert.deepEqual(presets('t1'), ['danger-full-access'])
  // A catalog whose presets resolve to nothing this ranking knows.
  const resolve = service.resolve
  service.resolve = (name) => { resolve(name); return {} }
  const warnings = []
  const warn = rt.warn
  rt.warn = (...args) => { warnings.push(args.join(' ')); return warn(...args) }
  assert.equal((await call('delete-bot', { id: 'b2' })).ok, true)
  await settle()
  assert.deepEqual(presets('t1'), ['danger-full-access'])
  assert.ok(warnings.some(line => line.includes('can be ranked') && line.includes('t1')), warnings.join(' | '))
})

// #315: a Bot made by another Bot starts at its creator's level, never the team default
// and never above the creator; the user's own create keeps the team default.
const createBotTool = (ctx, args) => ctx.registeredTools.get('create_bot').execute({ role: 'Help', instructions: 'Help', ...args }, { agent: { id: 'm1' } })
const botNamed = async (call, name) => (await call('state', {})).value.bots.find(bot => bot.name === name)

test('a Bot made by a full-access Bot starts at full access and is told so', async (t) => {
  const { ctx, call, presets, settle } = team(t, { bots: { m1: { permission: 'danger-full-access' } } })
  assert.equal((await call('set-prefs', { permission: 'workspace-write' })).ok, true)
  const answer = await createBotTool(ctx, { name: 'Writer' })
  assert.equal(answer, 'Created Writer. Permission inherited from Omni (danger-full-access). It is greeting the user now.')
  const writer = await botNamed(call, 'Writer')
  assert.equal(writer.permission, 'danger-full-access')
  await settle()
  assert.deepEqual(presets(writer.id), ['danger-full-access'])
})

test('a Bot made by a read-only Bot starts read-only, and one by a Bot without a level at the default', async (t) => {
  const custom = { careful: { sandbox: 'read-only', approval: 'ask' } }
  const { ctx, call, presets, settle } = team(t, { custom, bots: { m1: { permission: 'careful' } } })
  assert.equal(await createBotTool(ctx, { name: 'Reader' }), 'Created Reader. Permission inherited from Omni (careful). It is greeting the user now.')
  const reader = await botNamed(call, 'Reader')
  assert.equal(reader.permission, 'careful')
  await settle()
  assert.deepEqual(presets(reader.id), ['careful'])

  // A creator on no level of its own runs at the catalog default: so does its Bot, even
  // where the team default is wider.
  const plain = team(t)
  assert.equal((await plain.call('set-prefs', { permission: 'danger-full-access' })).ok, true)
  assert.equal(await createBotTool(plain.ctx, { name: 'Helper' }), 'Created Helper. Permission inherited from Omni (workspace-write). It is greeting the user now.')
  assert.equal((await botNamed(plain.call, 'Helper')).permission, 'workspace-write')
})

test('a Bot the user creates keeps the team default, or none', async (t) => {
  const { call } = team(t, { bots: { m1: { permission: 'careful' } }, custom: { careful: { sandbox: 'read-only', approval: 'ask' } } })
  assert.equal((await call('create-bot', { name: 'Free' })).value.permission, undefined)
  assert.equal((await call('set-prefs', { permission: 'danger-full-access' })).ok, true)
  assert.equal((await call('create-bot', { name: 'Wide' })).value.permission, 'danger-full-access')
})

test('a made Bot is never above its creator: unrankable levels and asked-for ones fail closed', async (t) => {
  const custom = { careful: { sandbox: 'read-only', approval: 'ask' }, odd: { sandbox: 'container', approval: 'ask' } }
  // A creator on a level DSH cannot rank gives the narrowest offered level, not the wider default.
  const odd = team(t, { custom, bots: { m1: { permission: 'odd' } } })
  assert.equal((await odd.call('set-prefs', { permission: 'danger-full-access' })).ok, true)
  await createBotTool(odd.ctx, { name: 'Odd', permission: 'danger-full-access' })
  const made = await botNamed(odd.call, 'Odd')
  const ranks = odd.service.catalog().options.map(({ value }) => rankOf(odd.service, value)).filter(rank => rank !== undefined)
  assert.equal(rankOf(odd.service, made.permission), Math.min(...ranks))

  // A stale level (a preset the catalog no longer offers) likewise.
  const stale = team(t, { bots: { m1: { permission: 'gone' } } })
  await createBotTool(stale.ctx, { name: 'Stale' })
  assert.equal(rankOf(stale.service, (await botNamed(stale.call, 'Stale')).permission), rankOf(stale.service, 'workspace-write'))

  // A level the model passes to create_bot is not one it can grant.
  const careful = team(t, { custom, bots: { m1: { permission: 'careful' } } })
  await createBotTool(careful.ctx, { name: 'Asker', permission: 'danger-full-access' })
  const asker = await botNamed(careful.call, 'Asker')
  assert.ok(rankOf(careful.service, asker.permission) <= rankOf(careful.service, 'careful'))

  // When no offered level ranks, the create fails instead of starting at DSH's default.
  const { rt } = runtime()
  assert.throws(() => rt.inheritedPermission({ name: 'Omni', permission: 'danger-full-access' }), /no permission level of Omni/)
  assert.equal(runtime({ presets: false }).rt.inheritedPermission({ name: 'Omni' }), undefined)
})

test('the user can still change an inherited level', async (t) => {
  const { ctx, call, presets, settle } = team(t, { bots: { m1: { permission: 'danger-full-access' } } })
  await createBotTool(ctx, { name: 'Writer' })
  const writer = await botNamed(call, 'Writer')
  assert.equal((await call('update-bot', { id: writer.id, permission: 'workspace-write' })).ok, true)
  assert.equal((await botNamed(call, 'Writer')).permission, 'workspace-write')
  await settle()
  assert.deepEqual(presets(writer.id), ['danger-full-access', 'workspace-write'])
})

// #315: the level buildBot stores is what every later Session reads: its chat, a part
// opened afterwards, and the tasks the Bot asks for.
test('a made Bot\'s inherited level reaches its chat, a group Session, a fresh part and its tasks', async (t) => {
  const { ctx, rt, call, of, presets, settle, announceOnCreate } = team(t, { bots: { m1: { permission: 'danger-full-access' } } })
  assert.equal((await call('set-prefs', { permission: 'workspace-write' })).ok, true)
  await call('state', {})
  assert.match(await createBotTool(ctx, { name: 'Writer' }), /Permission inherited from Omni \(danger-full-access\)/)
  const writer = await botNamed(call, 'Writer')
  await settle()
  const chatPresets = of(writer.id).filter(line => line.includes(' preset '))
  assert.deepEqual(chatPresets, [`${writer.id} preset danger-full-access`])

  // A group Session the Bot speaks in reads the same level (groups.js); the group has none
  // of its own, so the Bot's stands.
  await rt.applyPermission(writer, 'writer-group', { id: 'r2', name: 'Later' })
  assert.deepEqual(presets('writer-group'), ['danger-full-access'])
  // A fresh part goes through applyPermission (parts.js), which reads the stored level.
  await rt.applyPermission(writer, 'writer-part')
  assert.deepEqual(presets('writer-part'), ['danger-full-access'])
  // So does a task the Bot starts.
  announceOnCreate()
  const task = await rt.startTask({ title: 'Wish', text: 'Do it', from: writer.id })
  await settle()
  assert.deepEqual(presets(task), ['danger-full-access'])
  const taskLines = of(task)
  assert.ok(taskLines.indexOf(`${task} preset danger-full-access`) < taskLines.indexOf(`${task} first turn`), taskLines.join(' | '))
})

// #315: the user's create and a copy keep the team default; create_bot has no level
// parameter, and one passed in its arguments is not read.
test('a copy and a user create keep the team default, and create_bot ignores a level argument', async (t) => {
  const { ctx, call } = team(t, { bots: { m1: { permission: 'danger-full-access' }, b2: { permission: 'danger-full-access' } } })
  assert.equal((await call('set-prefs', { permission: 'workspace-write' })).ok, true)
  assert.equal((await call('duplicate-bot', { id: 'b2' })).value.permission, 'workspace-write')
  assert.equal(ctx.registeredTools.get('create_bot').parameters.properties.permission, undefined)
  // The creator's level wins over the one handed in with the call.
  assert.match(await createBotTool(ctx, { name: 'Ignored', permission: 'workspace-write' }), /\(danger-full-access\)/)
  assert.equal((await botNamed(call, 'Ignored')).permission, 'danger-full-access')
})

// #315: when nothing rankable is offered, the create fails before any Session is made,
// never starting the Bot at DSH's default.
test('a create with no rankable level refuses before making a Session', async (t) => {
  const { ctx, call, service, opened } = team(t, { bots: { m1: { permission: 'odd' } } })
  service.catalog = () => ({ options: [{ value: 'odd', name: 'odd' }], defaultOptions: [], defaultPreset: 'odd' })
  service.resolve = () => ({ sandbox: 'container', approval: 'ask' })
  const answer = await createBotTool(ctx, { name: 'Doomed' })
  assert.equal(answer, 'Could not create the Bot: no permission level of Omni can be given to a new Bot')
  assert.deepEqual(opened, [])
  assert.equal((await call('state', {})).value.bots.some(bot => bot.name === 'Doomed'), false)
})

// #315: a Session adopted from a host keeps the level it already runs at.
test('an adopted Session keeps its own level', async (t) => {
  const { rt, call, service, presets, settle } = team(t, { bots: { m1: { permission: 'danger-full-access' } } })
  assert.equal((await call('set-prefs', { permission: 'workspace-write' })).ok, true)
  service.set({ id: 'adopted' }, 'danger-full-access')
  const bot = await rt.createBot({ name: 'Adopted', existingSessionId: 'adopted', createdBy: 'm1', pickModel: true })
  assert.equal(bot.permission, undefined)
  await settle()
  assert.deepEqual(presets('adopted'), ['danger-full-access'])
  await rt.applyPermission(bot, 'adopted')
  assert.deepEqual(presets('adopted'), ['danger-full-access'])
  assert.equal(service.current({ id: 'adopted' }), 'danger-full-access')
})

// #343 F1: create_bot passes createBot only the parameters it declares. An undeclared
// argument a model adds is dropped, so it never reaches the host's own options.
const READ_ONLY = { careful: { sandbox: 'read-only', approval: 'ask' } }

test('an undeclared existingSessionId cannot adopt a live Session: the Bot gets its own', async (t) => {
  const { ctx, rt, call, service, presets, opened, settle } = team(t, { custom: READ_ONLY, bots: { m1: { permission: 'careful' } } })
  service.set({ id: 'live' }, 'danger-full-access')
  assert.match(await createBotTool(ctx, { name: 'Sneak', existingSessionId: 'live' }), /^Created Sneak\. Permission inherited from Omni \(careful\)\./)
  const sneak = await botNamed(call, 'Sneak')
  assert.notEqual(sneak.id, 'live')
  assert.equal(sneak.sessionPinned, undefined)
  assert.equal(rt.botOf('live'), undefined)
  assert.equal(opened.includes('live'), false)
  await settle()
  // The live Session is untouched, and the Bot's fresh one runs at its creator's level.
  assert.deepEqual(presets('live'), ['danger-full-access'])
  assert.deepEqual(presets(sneak.id), ['careful'])
})

test('an undeclared main cannot make the created Bot a Main Bot', async (t) => {
  const { ctx, rt, call } = team(t)
  assert.match(await createBotTool(ctx, { name: 'Boss', main: true }), /^Created Boss\./)
  const boss = await botNamed(call, 'Boss')
  assert.deepEqual((await call('state', {})).value.mainBotIds, ['m1'])
  assert.equal(rt.isMain(boss.id), false)
})

test('an undeclared pickModel cannot alter the model choice', async (t) => {
  const { ctx, call } = team(t)
  Object.assign(ctx.llm, {
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
    listModels: async () => [{ id: 'v4' }],
    resolveModelInfo: async () => ({}),
  })
  await createBotTool(ctx, { name: 'Plain' })
  await createBotTool(ctx, { name: 'Picky', pickModel: true })
  const plain = await botNamed(call, 'Plain')
  const picky = await botNamed(call, 'Picky')
  // Without pickModel the Bot takes the served default and greets at once; with it read,
  // it would have no model and hold its greeting for a pick.
  assert.equal(plain.model, 'deepseek/v4')
  assert.equal(picky.model, plain.model)
  assert.equal(picky.waiting, undefined)
})

// The Reviewer's probe: a read-only creator hands every undeclared option at once, a live
// full-access Session among them. The Bot still starts read-only, on a Session of its own.
test('a read-only creator\'s create_bot yields a read-only Bot whatever else it passes', async (t) => {
  const { ctx, rt, call, service, presets, settle } = team(t, { custom: READ_ONLY, bots: { m1: { permission: 'careful' } } })
  service.set({ id: 'live' }, 'danger-full-access')
  const answer = await createBotTool(ctx, {
    name: 'Probe', existingSessionId: 'live', main: true, copyOf: 'b2', pickModel: true,
    kind: 'omni', color: 'red', permission: 'danger-full-access', createdBy: 'b2',
  })
  assert.equal(answer, 'Created Probe. Permission inherited from Omni (careful). It is greeting the user now.')
  const probe = await botNamed(call, 'Probe')
  assert.equal(probe.permission, 'careful')
  assert.notEqual(probe.id, 'live')
  assert.equal(probe.createdBy, 'm1')
  assert.equal(probe.kind, undefined)
  assert.equal(probe.color, undefined)
  assert.equal(rt.isMain(probe.id), false)
  await settle()
  assert.deepEqual(presets(probe.id), ['careful'])
  assert.equal(presets(probe.id).includes('danger-full-access'), false)
  assert.equal(service.current({ id: probe.id }), 'careful')
})

// #343 F1: the declared parameters are the whole of what createBot receives. An
// undeclared option a model adds — an adoption, a Main Bot, a held model, a copy, a level,
// a color, a kind — is dropped at the boundary, alone and all at once.
test('create_bot hands createBot only its declared parameters', async (t) => {
  const { ctx, rt } = team(t, { custom: READ_ONLY, bots: { m1: { permission: 'careful' } } })
  const calls = []
  const create = rt.createBot
  rt.createBot = async options => { calls.push(options); return create(options) }
  const declared = ['avatar', 'brief', 'createdBy', 'effort', 'instructions', 'model', 'name', 'role', 'section', 'workDir']
  const undeclared = {
    existingSessionId: 'live', main: true, pickModel: true, copyOf: 'b2',
    permission: 'danger-full-access', color: 'red', kind: 'omni',
  }
  for (const [index, [key, value]] of Object.entries(undeclared).entries()) {
    await createBotTool(ctx, { name: `Alone ${index}`, [key]: value })
  }
  await createBotTool(ctx, { name: 'Together', ...undeclared })
  assert.equal(calls.length, Object.keys(undeclared).length + 1)
  for (const options of calls) assert.deepEqual(Object.keys(options).sort(), declared)
})
