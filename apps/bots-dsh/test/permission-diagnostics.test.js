// The permission section of the diagnostics page, host side (permission-diagnostics.js): what
// it tells of each open Session, and that telling it changes nothing: no set, no apply, no
// retry, no Session opened, no team load, no lock. acp-dsh is faked as a service; none of its
// code is used.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { acpView, CUSTOM, MAX_ROWS } from '../src/host/permission-diagnostics.js'

const FULL = 'danger-full-access'
const WRITE = 'workspace-write'
const STOCK = {
  [WRITE]: { sandbox: 'workspace-write', approval: 'ask' },
  [FULL]: { sandbox: 'danger-full-access', approval: 'never' },
}
const AUTO_SPEC = { sandbox: 'danger-full-access', approval: 'ask' }
const refused = level => ({ code: 'bot/refused', message: new RegExp(`^The ${level} permission level could not be set on this conversation, so no tool runs here until it is\\.`) })

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

// The whole team over a fake DSH presets service, as in permissions.test.js. `failing`
// holds the Sessions whose set throws; `sets` counts every set DSH was asked for.
function team(t, { auto = true, bots = {}, room = {}, tasks, closed = [], presets = true, levels = {}, failing: failingAtStart = [], services = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-permission-diagnostics-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM, bots: { m1: { ...TEAM.bots.m1, ...bots.m1 }, b2: { ...TEAM.bots.b2, ...bots.b2 } }, rooms: { r1: { ...TEAM.rooms.r1, ...room } }, ...(tasks ? { tasks } : {}) }))
  const presetOf = new Map(Object.entries(levels))
  const failing = new Set(failingAtStart)
  const sets = []
  const service = {
    auto,
    names: () => [...Object.keys(STOCK), ...(service.auto ? ['auto'] : [])],
    catalog: () => ({ options: service.names().map(value => ({ value, name: value })), defaultOptions: [], defaultPreset: WRITE }),
    resolve: (name) => {
      if (!service.names().includes(name)) throw new Error(`permission: unknown preset "${name}"`)
      return name === 'auto' ? AUTO_SPEC : STOCK[name]
    },
    current: session => presetOf.get(session.id),
    set: (session, name) => {
      service.resolve(name)
      sets.push(`${session.id}=${name}`)
      if (failing.has(session.id)) throw new Error('permission: the Session log refused the write')
      presetOf.set(session.id, name)
    },
  }
  const ctx = fakeContext({ services: { ...(presets ? { permissionPresets: service } : {}), ...services } })
  const open = new Set()
  const headers = {}
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
        if (closed.includes(sessionId)) return { error: { code: 'gateway/internal', message: `resume failed for session "${sessionId}": Error: permission: cannot restore preset "auto" without its active integration` } }
        const session = { id: sessionId }
        if (!open.has(sessionId)) {
          open.add(sessionId)
          for (const listener of ctx.listeners.get('session/created') ?? []) void Promise.resolve(listener(session)).catch(() => {})
        }
        await new Promise(resolve => setTimeout(resolve, 1))
        return { agent: { session, followup() {} } }
      },
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {}, list: () => [...open].map(id => ({ id })), get: id => (headers[id] ? { header: headers[id] } : undefined) },
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
  t.mock.method(rt, 'warn', () => {})
  // Every refused call tries the apply again, unless a test spaces the tries out.
  rt.levelRetryMs = 0
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const settle = () => new Promise(resolve => setTimeout(resolve, 20))
  // One tool call of a Session through the team's guard, the first tools/execute listener.
  // Resolves 'ran' when the tool's body was reached.
  const tool = (sessionId, { name = 'bash', header } = {}) => ctx.listeners.get('tools/execute')[0](
    { name, arguments: {}, agent: { id: sessionId, session: { id: sessionId, ...(header ? { header } : {}) } } },
    async () => 'ran',
  )
  // DSH opens a Session, which it then lists: its level is set again within the announce.
  const opens = async (sessionId) => {
    open.add(sessionId)
    for (const listener of ctx.listeners.get('session/created') ?? []) void Promise.resolve(listener({ id: sessionId })).catch(() => {})
    await settle()
  }
  return { ctx, rt, service, call, settle, failing, sets, headers, tool, opens, levelOf: id => presetOf.get(id) }
}

const read = async (call) => {
  const answer = await call('diagnostics-permissions', {})
  assert.equal(answer.ok, true)
  return answer.value
}
const rowOf = (report, kind, botId) => report.sessions.find(row => row.kind === kind && row.botId === botId)
const AUTO = 'auto'
// A level leaves as its stock key alone.
const level = value => ({ value })
// A full record as acp-dsh's accessor gives it (version 1).
const record = (over = {}) => ({
  version: 1, agent: 'acp-claude', startedAt: 1000, active: true,
  bridge: { on: true, why: 'agent-default', at: 1000, open: true },
  modes: { wanted: ['bypassPermissions', 'default'], offered: ['default', 'plan'], chosen: 'default', fellToStrict: true, at: 1001, current: 'default', applied: true },
  lastCall: { path: 'dsh-bridge', kind: 'execute', at: 1002 },
  bridgeCall: { at: 1002 },
  reviewer: { provider: 'deepseek-official', model: 'deepseek-flash', ok: false, code: 'TIMEOUT', at: 1003 },
  review: { code: 'AUTO_REVIEW_TIMEOUT', at: 1004 },
  ...over,
})

test('before the team is loaded the answer is unavailable, and nothing is loaded for it', async (t) => {
  const { rt } = team(t)
  // Startup loads synchronously; exercise the unavailable state explicitly.
  t.mock.method(rt, 'teamLoaded', () => false)
  const load = t.mock.method(rt, 'load')
  assert.deepEqual(rt.permissionDiagnostics(), { version: 2, unavailable: true })
  assert.equal(load.mock.callCount(), 0)
})

test('the route answers from memory: no refresh, no load, no lock, no set, no Session opened', async (t) => {
  const { rt, ctx, call, settle, sets } = team(t, { bots: { b2: { permission: FULL } }, levels: { b2: FULL } })
  await call('state', {})
  await call('send', { botId: 'b2', text: 'hello' }).catch(() => {})
  await settle()
  const before = { sets: sets.length, state: JSON.stringify(rt.state) }
  const refresh = t.mock.method(rt, 'refresh')
  const load = t.mock.method(rt, 'load')
  const save = t.mock.method(rt, 'save')
  const resolve = t.mock.method(rt, 'resolveAgent')
  const opened = t.mock.method(ctx.sessionController, 'resolveAgent')
  const created = t.mock.method(ctx.sessionController, 'create')
  const first = await read(call)
  // The body is ignored: nothing in it selects or changes anything.
  const second = (await call('diagnostics-permissions', { sessionId: 'g2', permission: FULL, retry: true })).value
  assert.deepEqual(second, first)
  for (const spy of [refresh, load, save, resolve, opened, created]) assert.equal(spy.mock.callCount(), 0)
  assert.equal(sets.length, before.sets)
  assert.equal(JSON.stringify(rt.state), before.state)
})

test('a host that only reads the team answers too', async (t) => {
  const { rt, call, opens } = team(t, { bots: { b2: { permission: WRITE } } })
  await call('state', {})
  await opens('b2')
  t.mock.method(rt, 'readOnly', () => 'another DeepSeek Harness has this team open')
  const report = await read(call)
  assert.deepEqual(rowOf(report, 'chat', 'b2').saved, level(WRITE))
})

test('the saved level and where it comes from: the Bot, the group, a task, none', async (t) => {
  const { call, opens } = team(t, {
    bots: { b2: { permission: FULL } },
    room: { permission: WRITE },
    tasks: { t1: { from: 'b2' }, t2: { from: 'b2', roomId: 'r1' } },
  })
  await call('state', {})
  for (const id of ['m1', 'b2', 'g1', 'g2', 't1', 't2']) await opens(id)
  const report = await read(call)
  assert.equal(report.version, 2)
  assert.deepEqual(report.sessions.map(row => row.kind), ['chat', 'chat', 'group', 'group', 'task', 'task'])
  const own = rowOf(report, 'chat', 'b2')
  assert.deepEqual([own.source, own.saved, own.effective, own.open], ['bot', level(FULL), level(FULL), true])
  // A Bot with no level of its own.
  const main = rowOf(report, 'chat', 'm1')
  assert.deepEqual([main.source, main.saved], ['none', undefined])
  // In the group the group's level stands in place of the Bot's own.
  const group = rowOf(report, 'group', 'b2')
  assert.deepEqual([group.source, group.saved, group.effective, group.roomId], ['group', level(WRITE), level(WRITE), 'r1'])
  const tasks = report.sessions.filter(row => row.kind === 'task')
  assert.deepEqual(tasks.map(row => [row.source, row.saved.value, row.roomId]), [['task', FULL, undefined], ['task', WRITE, 'r1']])
})

test('a group without a level leaves each member its own', async (t) => {
  const { call, opens } = team(t, { bots: { b2: { permission: FULL } } })
  await call('state', {})
  await opens('g1')
  await opens('g2')
  const report = await read(call)
  assert.deepEqual([rowOf(report, 'group', 'b2').source, rowOf(report, 'group', 'b2').saved], ['bot', level(FULL)])
  assert.equal(rowOf(report, 'group', 'm1').source, 'none')
})

test('a task started from a narrower group, and a capped one, show the level they run at', async (t) => {
  const { call, opens } = team(t, {
    bots: { b2: { permission: FULL } },
    room: { permission: WRITE },
    tasks: { t1: { from: 'b2', levelRoomId: 'r1' }, t2: { from: 'b2', permissionCap: WRITE } },
  })
  await call('state', {})
  await opens('t1')
  await opens('t2')
  const report = await read(call)
  assert.deepEqual(report.sessions.map(row => [row.kind, row.saved.value]), [['task', WRITE], ['task', WRITE]])
})

test('a Session that is not open shows nothing, and is not opened to be read', async (t) => {
  const { ctx, call } = team(t, { bots: { b2: { permission: FULL } } })
  await call('state', {})
  const opened = t.mock.method(ctx.sessionController, 'resolveAgent')
  const report = await read(call)
  assert.deepEqual(report.sessions, [])
  assert.equal(opened.mock.callCount(), 0)
})

test('a Session no Bot owns is not listed', async (t) => {
  const { call, opens } = team(t)
  await call('state', {})
  await opens('elsewhere')
  assert.deepEqual((await read(call)).sessions, [])
})

test('the fallback is told only where the Session reads Workspace, never inferred', async (t) => {
  // Auto is saved and DSH does not offer it: the Session took workspace-write.
  const held = team(t, { auto: false, bots: { b2: { permission: AUTO } } })
  await held.call('state', {})
  await held.opens('b2')
  const row = rowOf(await read(held.call), 'chat', 'b2')
  assert.deepEqual([row.saved, row.effective, row.fallback, row.unapplied], [{ value: AUTO }, level(WRITE), true, undefined])

  // The same, but the set failed: the Session still reads full access. No fallback is
  // claimed; the mark is.
  const failed = team(t, { auto: false, bots: { b2: { permission: AUTO } }, levels: { b2: FULL }, failing: ['b2'] })
  await failed.call('state', {})
  await failed.opens('b2')
  const left = rowOf(await read(failed.call), 'chat', 'b2')
  assert.equal(left.fallback, undefined)
  assert.deepEqual(left.effective, level(FULL))
  assert.deepEqual(left.unapplied.level, { value: AUTO })
  assert.equal(typeof left.unapplied.at, 'number')
})

test('the unapplied mark is shown first and reading it neither lifts it nor tries again', async (t) => {
  const { call, settle, failing, sets, tool, opens, levelOf } = team(t, { room: { permission: FULL }, levels: { g1: FULL, g2: FULL } })
  await call('state', {})
  await opens('g1')
  await opens('g2')
  failing.add('g2')
  await call('update-room', { id: 'r1', permission: WRITE })
  await settle()
  const before = sets.length
  for (let i = 0; i < 3; i += 1) {
    const report = await read(call)
    assert.equal(report.sessions[0].botId, 'b2', 'the marked Session leads')
    assert.deepEqual(report.sessions[0].unapplied.level, level(WRITE))
    assert.equal(report.sessions[0].differs, true, 'it runs at a level that is not the saved one')
    assert.deepEqual(report.sessions[0].effective, level(FULL))
    assert.equal(rowOf(report, 'group', 'm1').unapplied, undefined)
  }
  assert.equal(sets.length, before, 'no set was asked of DSH')
  assert.equal(levelOf('g2'), FULL)
  // The gate still refuses, and still lifts once the level holds.
  await assert.rejects(tool('g2'), refused(WRITE))
  failing.clear()
  assert.equal(await tool('g2'), 'ran')
  assert.equal((await read(call)).sessions.some(row => row.unapplied !== undefined), false)
})

test('a marked Session is listed when it is not open, and when no Bot owns it any more', async (t) => {
  const { rt, ctx, call, settle, failing } = team(t, { room: { permission: FULL }, levels: { g1: FULL, g2: FULL } })
  await call('state', {})
  failing.add('g2')
  await call('update-room', { id: 'r1', permission: WRITE })
  await settle()
  ctx.sessions.list = () => []
  const closed = (await read(call)).sessions
  assert.deepEqual(closed.map(row => [row.kind, row.botId, row.open, row.effective]), [['group', 'b2', false, undefined]])
  assert.deepEqual(closed[0].unapplied.level, level(WRITE))
  // The Session's owner is forgotten: the mark is still told, with no owner.
  rt.groupOwners.delete('g2')
  const orphan = (await read(call)).sessions
  assert.deepEqual(orphan.map(row => [row.kind, row.botId, row.roomId]), [['other', undefined, undefined]])
  assert.deepEqual(orphan[0].unapplied.level, level(WRITE))
})

test('the cap keeps the marked Sessions', async (t) => {
  const { ctx, call, settle, failing } = team(t, { room: { permission: FULL }, levels: { g1: FULL, g2: FULL }, tasks: Object.fromEntries(Array.from({ length: MAX_ROWS + 5 }, (_, i) => [`t${i}`, { from: 'm1' }])) })
  await call('state', {})
  failing.add('g2')
  await call('update-room', { id: 'r1', permission: WRITE })
  await settle()
  ctx.sessions.list = () => [...Array.from({ length: MAX_ROWS + 5 }, (_, i) => ({ id: `t${i}` })), { id: 'g2' }]
  const report = await read(call)
  assert.equal(report.sessions.length, MAX_ROWS)
  assert.equal(report.more, true)
  assert.equal(report.sessions[0].unapplied !== undefined, true)
})

test('without DSH\'s levels the saved level is still told, and a task\'s is unknown', async (t) => {
  const { call, opens } = team(t, { presets: false, bots: { b2: { permission: FULL } }, tasks: { t1: { from: 'b2' } } })
  await call('state', {})
  await opens('b2')
  await opens('t1')
  const report = await read(call)
  const own = rowOf(report, 'chat', 'b2')
  // Never as "none": the Bot has a level, DSH's levels are what is missing.
  assert.deepEqual([own.presets, own.source, own.saved, own.effective], [false, 'bot', level(FULL), undefined])
  const task = rowOf(report, 'task', 'b2')
  assert.deepEqual([task.presets, task.source, task.saved], [false, 'unknown', undefined])
})

test('a preset of the person\'s own leaves as custom: neither its key nor its label', async (t) => {
  const OWN = { '/home/alice/client-x': 'Client X (alice)', 'alice@example.com': 'alice@example.com' }
  const { service, call, opens, settle, failing } = team(t, { bots: { m1: { permission: '/home/alice/client-x' }, b2: { permission: 'alice@example.com' } }, levels: { g2: FULL } })
  const stock = service.names
  service.names = () => [...stock(), ...Object.keys(OWN)]
  service.catalog = () => ({ options: service.names().map(value => ({ value, name: OWN[value] ?? value })), defaultOptions: [], defaultPreset: WRITE })
  service.resolve = () => STOCK[WRITE]
  await call('state', {})
  for (const id of ['m1', 'b2', 'g1']) await opens(id)
  // And one that could not be set, so the mark carries it too.
  failing.add('g2')
  await opens('g2')
  await settle()
  const report = await read(call)
  for (const botId of ['m1', 'b2']) assert.deepEqual([rowOf(report, 'chat', botId).saved, rowOf(report, 'chat', botId).effective], [{ value: CUSTOM }, { value: CUSTOM }])
  assert.deepEqual(rowOf(report, 'group', 'b2').unapplied.level, { value: CUSTOM })
  const text = JSON.stringify(report)
  for (const hidden of ['alice', 'client-x', 'Client X', 'example.com', '/home']) assert.equal(text.includes(hidden), false, hidden)
  // A level DSH does not offer and this code does not name is custom too.
  const gone = team(t, { bots: { b2: { permission: 'my-secret-preset' } } })
  await gone.call('state', {})
  await gone.opens('b2')
  const left = await read(gone.call)
  assert.deepEqual(rowOf(left, 'chat', 'b2').saved, { value: CUSTOM })
  assert.equal(JSON.stringify(left).includes('my-secret-preset'), false)
})

test('the mark is told as it is, with no word on whether tools are held back', async (t) => {
  const { ctx, call, settle, failing, tool, opens } = team(t, { room: { permission: FULL }, levels: { g1: FULL, g2: FULL } })
  await call('state', {})
  await opens('g2')
  failing.add('g2')
  await call('update-room', { id: 'r1', permission: WRITE })
  await settle()
  const held = (await read(call)).sessions[0]
  assert.deepEqual(held.unapplied, { level: level(WRITE), at: held.unapplied.at })
  await assert.rejects(tool('g2'), refused(WRITE))
  // The presets service goes away: the mark is still held, yet nothing is refused for it.
  // The answer is the same mark, and says DSH's levels are missing.
  const get = ctx.get
  ctx.get = name => (name === 'permissionPresets' ? undefined : get(name))
  const loose = (await read(call)).sessions[0]
  assert.equal(loose.presets, false)
  assert.deepEqual(Object.keys(loose.unapplied).sort(), ['at', 'level'])
  assert.equal(await tool('g2'), 'ran')
})

test('a level in force that is not the saved one is told, between two custom presets too', async (t) => {
  const { service, call, opens, settle, failing } = team(t, { bots: { m1: { permission: '/home/alice/client-x' }, b2: { permission: '/home/alice/client-x' } }, levels: { b2: 'alice@example.com' }, failing: ['b2'] })
  const stock = service.names
  service.names = () => [...stock(), '/home/alice/client-x', 'alice@example.com']
  service.resolve = () => STOCK[WRITE]
  await call('state', {})
  await opens('m1')
  await opens('b2')
  await settle()
  const report = await read(call)
  // Both leave as custom on both rows; only the comparison made before tells them apart.
  const [same, other] = [rowOf(report, 'chat', 'm1'), rowOf(report, 'chat', 'b2')]
  assert.deepEqual([same.saved, same.effective, same.differs], [{ value: CUSTOM }, { value: CUSTOM }, false])
  assert.deepEqual([other.saved, other.effective, other.differs], [{ value: CUSTOM }, { value: CUSTOM }, true])
  assert.equal(JSON.stringify(report).includes('alice'), false)
  failing.clear()
})

test('a part that cannot be read is said, never passed off as nothing to show', async (t) => {
  const acpAgents = { permissionDiagnostics: () => { throw new Error('boom') } }
  const { rt, ctx, call, opens, settle, failing } = team(t, { bots: { b2: { permission: FULL } }, room: { permission: FULL }, levels: { g2: FULL }, services: { acpAgents } })
  await call('state', {})
  await opens('b2')
  const noted = t.mock.method(rt, 'noteFailure')
  // The other plugin's accessor throws: the row is told without its record, and whole.
  const whole = await read(call)
  assert.equal(rowOf(whole, 'chat', 'b2').acp, undefined)
  assert.equal(whole.partial, undefined)

  // One Session's facts cannot be read: the others are told, and the gap is said.
  await opens('m1')
  const facts = rt.permissionFactsOf
  rt.permissionFactsOf = (id, session) => (id === 'm1' ? { kind: 'other', source: 'none', failed: true } : facts(id, session))
  const gap = await read(call)
  assert.deepEqual([gap.sessions.map(row => row.botId), gap.partial], [['b2'], true])
  rt.permissionFactsOf = () => { throw new Error('/home/alice/secret') }
  assert.deepEqual(await read(call), { version: 2, sessions: [], partial: true })
  rt.permissionFactsOf = facts

  // The marks cannot be listed: the open Sessions are told, and the gap is said.
  const marks = rt.unappliedSessions
  rt.unappliedSessions = () => { throw new Error('boom') }
  const unmarked = await read(call)
  assert.deepEqual([unmarked.sessions.map(row => row.botId).sort(), unmarked.partial], [['b2', 'm1'], true])
  rt.unappliedSessions = marks

  // The Session list alone throws, with everything else reading: not "nothing is open".
  const list = ctx.sessions.list
  ctx.sessions.list = () => { throw new Error('boom') }
  assert.deepEqual(await read(call), { version: 2, sessions: [], partial: true })
  // A marked Session is still told from its mark.
  ctx.sessions.list = list
  failing.add('g2')
  await opens('g2')
  await call('update-room', { id: 'r1', permission: WRITE })
  await settle()
  ctx.sessions.list = () => { throw new Error('boom') }
  const marked = await read(call)
  assert.deepEqual([marked.sessions.map(row => [row.kind, row.botId, row.open]), marked.partial], [[['group', 'b2', false]], true])

  // Anything else that throws: the whole answer is unavailable, which the page says.
  ctx.sessions.list = () => ({ filter: () => { throw new Error('boom') } })
  assert.deepEqual(await call('diagnostics-permissions', {}), { ok: true, value: { version: 2, unavailable: true } })
  assert.equal(noted.mock.callCount(), 0)
})

test('no name, Session id or folder leaves: only the Bot\'s and the group\'s ids', async (t) => {
  const { call, opens } = team(t, { bots: { b2: { permission: FULL } }, room: { permission: WRITE }, tasks: { 'task-session-9': { from: 'b2', roomId: 'r1', title: 'Secret plan' } } })
  await call('state', {})
  for (const id of ['b2', 'g2', 'task-session-9']) await opens(id)
  const text = JSON.stringify(await read(call))
  for (const hidden of ['Ada', 'Omni', 'Launch', 'Secret plan', 'task-session-9', 'g2', tmpdir()]) assert.equal(text.includes(hidden), false, hidden)
  const allowed = new Set(['kind', 'botId', 'roomId', 'open', 'source', 'saved', 'effective', 'fallback', 'differs', 'unapplied', 'presets', 'acp'])
  for (const row of JSON.parse(text).sessions) for (const key of Object.keys(row)) assert.ok(allowed.has(key), key)
})

test('the ACP record: absent, old, failing or of another shape gives a row without it', async (t) => {
  const answers = [undefined, {}, { permissionDiagnostics: () => undefined }, { permissionDiagnostics: () => { throw new Error('boom') } }, { permissionDiagnostics: () => record({ version: 3 }) }, { permissionDiagnostics: () => 'text' }, { permissionDiagnostics: () => [record()] }]
  for (const acpAgents of answers) {
    const { call, opens } = team(t, { bots: { b2: { permission: FULL } }, services: acpAgents === undefined ? {} : { acpAgents } })
    await call('state', {})
    await opens('b2')
    const row = rowOf(await read(call), 'chat', 'b2')
    assert.equal(row.acp, undefined)
    assert.deepEqual(row.saved, level(FULL))
  }
})

test('the ACP record is read per Session and rebuilt from fixed values', async (t) => {
  const asked = []
  const acpAgents = { permissionDiagnostics: (id) => { asked.push(id); return id === 'b2' ? record() : undefined } }
  const { call, opens } = team(t, { bots: { b2: { permission: FULL } }, services: { acpAgents } })
  await call('state', {})
  await opens('b2')
  await opens('m1')
  const report = await read(call)
  assert.deepEqual(asked.sort(), ['b2', 'm1'])
  assert.equal(rowOf(report, 'chat', 'm1').acp, undefined)
  assert.deepEqual(rowOf(report, 'chat', 'b2').acp, {
    agent: 'acp-claude', active: true,
    bridge: { on: true, why: 'agent-default', open: true },
    modes: { wanted: ['bypassPermissions', 'default'], offered: ['default', 'plan'], chosen: 'default', current: 'default', applied: true, fellToStrict: true },
    lastCall: { path: 'dsh-bridge', at: 1002 },
    reviewer: { route: 'built-in', ok: false, code: 'TIMEOUT', at: 1003 },
    review: { code: 'AUTO_REVIEW_TIMEOUT', at: 1004 },
  })
})

test('acpView keeps the states that say a mode or a bridge does not hold now', () => {
  const stopped = acpView(record({ active: false, bridge: { on: true, why: 'setting', at: 1, open: false }, modes: { wanted: ['auto'], offered: [], fellToStrict: false, at: 1 } }))
  assert.equal(stopped.active, false)
  assert.deepEqual(stopped.bridge, { on: true, why: 'setting', open: false })
  assert.deepEqual(stopped.modes, { wanted: ['auto'], offered: [], fellToStrict: false })
  const rejected = acpView(record({ modes: { wanted: ['auto', 'default'], offered: ['default', 'auto'], chosen: 'auto', current: 'default', applied: false, fellToStrict: false, at: 1 } }))
  assert.deepEqual([rejected.modes.chosen, rejected.modes.current, rejected.modes.applied], ['auto', 'default', false])
  assert.deepEqual(acpView(record({ bridge: { on: false, why: 'no-backchannel', at: 1, open: true } })).bridge, { on: false, why: 'no-backchannel' })
  // The strict mode was asked for and refused: the wide one stays current, and nothing says
  // the strict one was taken.
  const stays = acpView(record({ modes: { wanted: ['bypassPermissions', 'default'], offered: ['default', 'bypassPermissions'], chosen: 'default', current: 'bypassPermissions', applied: false, fellToStrict: true, at: 1 } }))
  assert.deepEqual([stays.modes.chosen, stays.modes.current, stays.modes.applied, stays.modes.fellToStrict], ['default', 'bypassPermissions', false, false])
  assert.equal(acpView(record({ modes: { wanted: ['auto', 'default'], offered: ['default'], chosen: 'default', fellToStrict: true, at: 1 } })).modes.fellToStrict, false, 'not confirmed: not said')
  assert.equal(acpView(record({ reviewer: { provider: 'custom', model: 'custom', ok: true, at: 5 } })).reviewer.route, 'custom')
  assert.equal(acpView(record({ reviewer: { provider: 'acp-codex', model: 'default', ok: true, at: 5 } })).reviewer.route, 'agent')
})

test('acpView preserves either coding agent usage limit as a reviewer failure code', () => {
  for (const code of ['ACP_CLAUDE_USAGE_LIMIT', 'ACP_CODEX_USAGE_LIMIT']) {
    const view = acpView(record({ reviewer: { provider: 'acp-codex', model: 'default', ok: false, code, at: 5 } }))
    assert.deepEqual(view.reviewer, { route: 'agent', ok: false, code, at: 5 })
  }
})

test('acpView lets nothing free-form through, whatever the record holds', () => {
  const SECRETS = ['sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', '/home/someone/project/.env', 'someone@example.com', 'my-own-provider/my-model', 'please delete every file']
  for (const secret of SECRETS) {
    const out = acpView({
      version: 1, agent: secret, startedAt: secret, active: secret, [secret]: secret, extra: { secret },
      bridge: { on: true, why: secret, at: secret, open: secret, url: secret, credential: secret },
      modes: { wanted: [secret, 'default', { secret }], offered: [secret], chosen: secret, current: secret, applied: secret, fellToStrict: secret, at: secret },
      lastCall: { path: secret, kind: secret, at: 7, title: secret, rawInput: secret },
      bridgeCall: { at: secret },
      reviewer: { provider: secret, model: secret, ok: false, code: secret, at: 8, message: secret },
      review: { code: secret, at: 9, text: secret },
    })
    assert.equal(JSON.stringify(out).includes(secret), false, secret)
    assert.deepEqual(out, {
      agent: 'other', active: false,
      bridge: { on: true, why: 'other' },
      modes: { wanted: ['other', 'default', 'other'], offered: ['other'], chosen: 'other', current: 'other', fellToStrict: false },
      lastCall: { path: 'other', at: 7 },
      reviewer: { route: 'other', ok: false, code: 'other', at: 8 },
      review: { code: 'other', at: 9 },
    })
  }
})

test('acpView never throws: wrong types, hostile getters and long lists', () => {
  for (const raw of [undefined, null, 0, 'v1', [], [{ version: 1 }], { version: '1' }, { version: 3, agent: 'acp-claude' }, () => {}]) assert.equal(acpView(raw), undefined)
  const hostile = { version: 1, get agent() { throw new Error('no') } }
  assert.equal(acpView(hostile), undefined)
  assert.deepEqual(acpView({ version: 1, bridge: 'on', modes: [], lastCall: 4, reviewer: null, review: 'x' }), { agent: 'other', active: false })
  assert.deepEqual(acpView({ version: 1, bridge: { on: 'yes' }, lastCall: { path: 'cli' }, reviewer: { ok: 'yes', at: 1 }, review: { code: 'AUTO_REVIEW_DENIED', at: Infinity } }), { agent: 'other', active: false })
  assert.equal(acpView({ version: 1, modes: { wanted: Array.from({ length: 500 }, () => 'default'), offered: 'default' } }).modes.wanted.length, 16)
})

test('acpView reads both versions and only version 2 carries bounded ownMode', () => {
  assert.equal(acpView(record()).agent, 'acp-claude')
  assert.deepEqual(acpView(record({ version: 2, ownMode: { answer: 'changed', taken: false, at: 123 } })).ownMode, { answer: 'changed', taken: false, at: 123 })
  assert.equal(acpView(record({ ownMode: { answer: 'yes', taken: true } })).ownMode, undefined)
})
test('permission diagnostics version 2 includes Auto facts for a chat', async t => {
  const { rt, opens } = team(t)
  await rt.load()
  await opens(rt.chatOf('m1'))
  t.mock.method(rt, 'autoFactsOf', () => ({ counts: false, why: 'judge', by: 'team' }))
  const report = rt.permissionDiagnostics()
  assert.equal(report.version, 2)
  assert.deepEqual(rowOf(report, 'chat', 'm1').auto, { counts: false, why: 'judge', by: 'team' })
})
