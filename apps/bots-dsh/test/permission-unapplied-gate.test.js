// A Session whose permission level was to be set and was not still runs at whatever it
// had, which may be wider than the level chosen. No tool runs there until the level
// holds: the team's tools/execute guard tries the apply again and refuses the call while
// it fails. It only ever refuses; a Session that is not marked is not looked at. The
// failure is injected in the fake presets service's `set`, as DSH would throw it.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
const refused = level => ({ code: 'bot/refused', message: new RegExp(`^The ${level} permission level could not be set on this conversation, so no tool runs here until it is\\.`) })
const unread = { code: 'bot/refused', message: /^DeepSeek Harness could not read where this conversation comes from while a permission level is not set, so no tool runs here until it can\./ }

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
function team(t, { auto = true, bots = {}, room = {}, tasks, closed = [], presets = true, levels = {}, failing: failingAtStart = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-unapplied-gate-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM, bots: { m1: { ...TEAM.bots.m1, ...bots.m1 }, b2: { ...TEAM.bots.b2, ...bots.b2 } }, rooms: { r1: { ...TEAM.rooms.r1, ...room } }, ...(tasks ? { tasks } : {}) }))
  const presetOf = new Map(Object.entries(levels))
  const failing = new Set(failingAtStart)
  const sets = []
  const policies = new Map()
  const modes = new Map()
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
      policies.set(session.id, service.resolve(name).approval)
      modes.set(session.id, service.resolve(name).sandbox)
    },
  }
  const ctx = fakeContext({ services: presets ? { permissionPresets: service, approval: { config: { policy: 'ask' }, overrideOf: session => policies.get(session.id) }, sandboxPolicy: { defaultMode: WRITE, overrideOf: session => modes.get(session.id) } } : {} })
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
    sessions: { flush: async () => {}, list: () => [...open].map(id => ({ id })), get: id => (headers[id] ? { id, header: headers[id] } : undefined) },
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
  const tool = (sessionId, { name = 'bash', header, next = async () => 'ran' } = {}) => ctx.listeners.get('tools/execute')[0](
    { name, arguments: {}, agent: { id: sessionId, session: { id: sessionId, ...(header ? { header } : {}) } } },
    next,
  )
  // DSH opens a Session: its level is set again within the announce.
  const opens = async (sessionId) => {
    for (const listener of ctx.listeners.get('session/created') ?? []) void Promise.resolve(listener({ id: sessionId })).catch(() => {})
    await settle()
  }
  return { ctx, rt, service, call, settle, failing, sets, headers, policies, modes, tool, opens, levelOf: id => presetOf.get(id) }
}

test('no tool runs on a Session that did not take a lowered level, until it does', async (t) => {
  const { rt, call, settle, failing, sets, headers, tool, levelOf } = team(t, { room: { permission: FULL }, levels: { g1: FULL, g2: FULL } })
  await call('state', {})
  failing.add('g2')
  await call('update-room', { id: 'r1', permission: WRITE })
  await settle()
  assert.deepEqual([levelOf('g1'), levelOf('g2')], [WRITE, FULL])
  // The Session still at full access is refused, with the level it was to take.
  await assert.rejects(tool('g2'), refused(WRITE))
  assert.equal(rt.stopsView().length, 1)
  assert.equal(rt.stopsView()[0].why, 'level')
  assert.equal(rt.stopsView()[0].count, 1)
  await assert.rejects(tool('g2', { name: 'read_file' }), refused(WRITE), 'every tool, a read-only one too')
  // Sessions that took the level and other ordinary Sessions can still run.
  headers.elsewhere = { id: 'elsewhere' }
  const before = sets.length
  assert.equal(await tool('g1'), 'ran')
  assert.equal(await tool('b2'), 'ran')
  assert.equal(await tool('elsewhere'), 'ran')
  assert.equal(sets.length, before, 'no set on a Session that is not marked')

  // Each refused call tried the apply again; once it holds, the call runs.
  failing.clear()
  assert.equal(await tool('g2'), 'ran')
  assert.equal(levelOf('g2'), WRITE)
  const after = sets.length
  assert.equal(await tool('g2'), 'ran')
  assert.equal(sets.length, after, 'nothing more is asked of a Session whose level holds')
})

test('a retry takes the level saved now, not the one that failed', async (t) => {
  const { rt, call, settle, failing, tool, levelOf } = team(t, { bots: { b2: { permission: FULL } }, levels: { b2: FULL, g2: FULL } })
  await call('state', {})
  failing.add('g2')
  await call('update-bot', { id: 'b2', permission: WRITE })
  await settle()
  await assert.rejects(tool('g2'), refused(WRITE))
  // The group takes a level of its own meanwhile.
  rt.roomOf('r1').permission = 'auto'
  await assert.rejects(tool('g2'), refused('auto'))
  failing.clear()
  assert.equal(await tool('g2'), 'ran')
  assert.equal(levelOf('g2'), 'auto')
})

test('a restart marks the Session again when its level still does not hold', async (t) => {
  // A new runtime: nothing is remembered; DSH opens the Session with the level its log
  // held, and the level saved for it cannot be set.
  const { call, failing, tool, opens, levelOf } = team(t, { room: { permission: WRITE }, levels: { g2: FULL }, failing: ['g2'] })
  await call('state', {})
  await opens('g2')
  assert.equal(levelOf('g2'), FULL)
  await assert.rejects(tool('g2'), refused(WRITE))
  failing.clear()
  assert.equal(await tool('g2'), 'ran')
  assert.equal(levelOf('g2'), WRITE)
})

test('a task whose level was not set at its start runs no tool', async (t) => {
  const { rt, call, settle, failing, tool, levelOf } = team(t, { bots: { m1: { permission: WRITE } } })
  await call('state', {})
  // Its Session is made and then refuses the set.
  const create = rt.ctx.sessionController.create
  rt.ctx.sessionController.create = async (options) => {
    const made = await create(options)
    failing.add(made.sessionId)
    return made
  }
  let task
  try {
    task = await rt.startTask({ title: 'Wish', text: 'Do it', from: 'm1' })
  } catch {
    // A start that refuses instead leaves the task ended; its Session is refused all the same.
    task = Object.keys(rt.state.tasks)[0]
  }
  await settle()
  assert.equal(levelOf(task), undefined)
  await assert.rejects(tool(task), refused(WRITE))
  failing.clear()
  assert.equal(await tool(task), 'ran')
  assert.equal(levelOf(task), WRITE)
})

test('a subagent child of a marked Session is refused too', async (t) => {
  const { call, settle, failing, headers, tool } = team(t, { room: { permission: FULL }, levels: { g1: FULL, g2: FULL } })
  await call('state', {})
  failing.add('g2')
  await call('update-room', { id: 'r1', permission: WRITE })
  await settle()
  headers.g1 = { id: 'g1' }
  headers.g2 = { id: 'g2' }
  headers.child = { id: 'child', origin: 'subagent', parentSession: 'g2' }
  headers.grandchild = { id: 'grandchild', origin: 'subagent', parentSession: 'child' }
  headers.other = { id: 'other', origin: 'subagent', parentSession: 'g1' }
  await assert.rejects(tool('child', { header: headers.child }), refused(WRITE))
  await assert.rejects(tool('grandchild'), refused(WRITE))
  assert.equal(await tool('other', { header: headers.other }), 'ran')
  // The parent's level holding frees the child.
  failing.clear()
  assert.equal(await tool('child', { header: headers.child }), 'ran')
})

test('a Session that reads the level saved for it is not refused', async (t) => {
  // A raise the Bot's own chat refuses is not kept: the chat is at the saved level.
  const { rt, call, failing, tool, levelOf } = team(t, { bots: { b2: { permission: WRITE } }, levels: { b2: WRITE, g2: WRITE } })
  await call('state', {})
  failing.add('b2')
  assert.equal((await call('update-bot', { id: 'b2', permission: FULL })).ok, false)
  assert.equal(rt.botOf('b2').permission, WRITE)
  assert.equal(levelOf('b2'), WRITE)
  assert.equal(await tool('b2'), 'ran')
})

test('a Session DSH will not open and a team without presets are left alone; a cleared level still has to land', async (t) => {
  // Not opened while Auto review is off: nothing runs there, and nothing is marked.
  const shut = team(t, { auto: false, bots: { b2: { permission: 'auto' } }, closed: ['g2'] })
  await shut.call('state', {})
  assert.equal((await shut.call('update-bot', { id: 'b2', permission: WRITE })).ok, true)
  await shut.settle()
  assert.equal(await shut.tool('g2'), 'ran')
  // No presets service: no level is ever set, so none is missed.
  const none = team(t, { presets: false })
  await none.call('state', {})
  assert.equal(await none.tool('g2'), 'ran')
  assert.deepEqual(none.sets, [])
  // A level cleared after a failure: nothing is left to set.
  const cleared = team(t, { room: { permission: FULL }, levels: { g1: FULL, g2: FULL } })
  await cleared.call('state', {})
  cleared.failing.add('g2')
  await cleared.call('update-room', { id: 'r1', permission: WRITE })
  await cleared.settle()
  await assert.rejects(cleared.tool('g2'), refused(WRITE))
  // The group's level is cleared: the Session still holds full access, so it goes to the
  // default its member started on before a tool runs.
  delete cleared.rt.roomOf('r1').permission
  await assert.rejects(cleared.tool('g2'), refused(WRITE))
  assert.equal(cleared.levelOf('g2'), FULL)
  cleared.failing.clear()
  assert.equal(await cleared.tool('g2'), 'ran')
  assert.equal(cleared.levelOf('g2'), WRITE)
})

test('the deny list still refuses its tools, and a marked Session is refused whatever the tool', async (t) => {
  const { call, settle, failing, tool } = team(t, { bots: { b2: { denyTools: ['bash'] } }, room: { permission: FULL }, levels: { g2: FULL } })
  await call('state', {})
  await assert.rejects(tool('g2'), /Ada does not have the bash tool/)
  assert.equal(await tool('g2', { name: 'read_file' }), 'ran')
  failing.add('g2')
  await call('update-room', { id: 'r1', permission: WRITE })
  await settle()
  await assert.rejects(tool('g2', { name: 'read_file' }), refused(WRITE))
  await assert.rejects(tool('g2'), refused(WRITE))
  // Once the level holds, the deny list is what refuses again.
  failing.clear()
  await assert.rejects(tool('g2'), /Ada does not have the bash tool/)
  assert.equal(await tool('g2', { name: 'read_file' }), 'ran')
})

test('the tries are spaced out, and calls that arrive together share one', async (t) => {
  const { rt, call, settle, failing, sets, tool } = team(t, { room: { permission: FULL }, levels: { g1: FULL, g2: FULL } })
  await call('state', {})
  failing.add('g2')
  await call('update-room', { id: 'r1', permission: WRITE })
  await settle()
  // Just failed: refused without another set.
  rt.levelRetryMs = 60_000
  const before = sets.length
  await assert.rejects(tool('g2'), refused(WRITE))
  await assert.rejects(tool('g2'), refused(WRITE))
  assert.equal(sets.length, before)
  // Due: three calls at once make one try.
  rt.levelRetryMs = 0
  await settle()
  rt.levelRetryMs = 10
  const all = await Promise.allSettled([tool('g2'), tool('g2'), tool('g2')])
  assert.deepEqual(all.map(result => result.status), ['rejected', 'rejected', 'rejected'])
  assert.equal(sets.length, before + 1)
})

test('a saved Auto that DSH does not offer holds as workspace-write and is not refused', async (t) => {
  const { call, settle, failing, tool, levelOf, opens } = team(t, { auto: false, bots: { b2: { permission: 'auto' } }, levels: { b2: FULL }, failing: ['b2'] })
  await call('state', {})
  await opens('b2')
  // The refusal names the level saved for it.
  await assert.rejects(tool('b2'), refused('auto'))
  failing.clear()
  assert.equal(await tool('b2'), 'ran')
  assert.equal(levelOf('b2'), WRITE)
  await settle()
  assert.equal(await tool('b2'), 'ran')
})

test('a read-only team does not try again, and still refuses', async (t) => {
  const { rt, call, settle, failing, sets, tool } = team(t, { room: { permission: FULL }, levels: { g1: FULL, g2: FULL } })
  await call('state', {})
  failing.add('g2')
  await call('update-room', { id: 'r1', permission: WRITE })
  await settle()
  failing.clear()
  t.mock.method(rt, 'readOnly', () => 'another DeepSeek Harness has this team open')
  const before = sets.length
  await assert.rejects(tool('g2'), refused(WRITE))
  assert.equal(sets.length, before)
})

test('a try never sets a level its owner does not have now: a raise taken back is not applied', async (t) => {
  // Ada has no level of her own and her chat holds workspace-write; the catalog default
  // is wider. A raise her chat refuses is taken back.
  const { call, service, settle, failing, sets, tool, levelOf } = team(t, { levels: { b2: WRITE } })
  const catalog = service.catalog
  service.catalog = () => ({ ...catalog(), defaultPreset: FULL })
  await call('state', {})
  failing.add('b2')
  assert.equal((await call('update-bot', { id: 'b2', permission: FULL })).ok, false)
  await settle()
  failing.clear()
  const before = sets.length
  // Neither the raise nor the wider default is set: the chat is as it was, and is let go.
  assert.equal(await tool('b2'), 'ran')
  assert.equal(levelOf('b2'), WRITE)
  assert.deepEqual(sets.slice(before), [])
})

test('a saved level DSH no longer offers does not take the tools away', async (t) => {
  // No try could ever set it: the Session is left as before, until a level is picked again.
  const { call, opens, tool } = team(t, { bots: { m1: { permission: 'gone' } } })
  await call('state', {})
  await opens('m1')
  assert.equal(await tool('m1'), 'ran')
})

test('an error from DSH during a try that fails does not unlock the Session', async (t) => {
  const { call, service, settle, failing, tool, levelOf } = team(t, { room: { permission: FULL }, levels: { g1: FULL, g2: FULL } })
  await call('state', {})
  failing.add('g2')
  await call('update-room', { id: 'r1', permission: WRITE })
  await settle()
  await assert.rejects(tool('g2'), refused(WRITE))
  // DSH's catalog throws once, while the next try is still refused its set: nothing
  // shows that DSH stopped offering the level, so the Session stays marked.
  const catalog = service.catalog
  let threw = 0
  service.catalog = () => {
    service.catalog = catalog
    threw += 1
    throw new Error('permission: the catalog could not be read')
  }
  await assert.rejects(tool('g2'), refused(WRITE))
  assert.equal(threw, 1, 'the catalog threw during that try')
  assert.equal(levelOf('g2'), FULL)
  await assert.rejects(tool('g2'), refused(WRITE), 'and it is still refused afterwards')
  // Only a set that holds lets it go.
  failing.clear()
  assert.equal(await tool('g2'), 'ran')
  assert.equal(levelOf('g2'), WRITE)
})

test('a Session whose parents cannot be read is refused while a Session is marked', async (t) => {
  const { ctx, rt, call, settle, failing, headers, tool } = team(t, { room: { permission: FULL }, levels: { g1: FULL, g2: FULL } })
  await call('state', {})
  headers.g2 = { id: 'g2' }
  headers.child = { id: 'child', origin: 'subagent', parentSession: 'g2' }
  headers.grandchild = { id: 'grandchild', origin: 'subagent', parentSession: 'child' }
  headers.elsewhere = { id: 'elsewhere' }
  const read = ctx.sessions.get
  const unreadable = t.mock.fn(() => { throw new Error('sessions: the store could not be read') })
  const next = t.mock.fn(async () => 'ran')
  const checkWithoutLevelMark = async () => {
    const reads = unreadable.mock.callCount()
    const agent = { id: 'child', session: { id: 'child' } }
    assert.equal(await rt.levelHolds({ agent }), undefined)
    assert.equal(unreadable.mock.callCount(), reads, 'the seat level check skips lineage when no level is marked')
    await assert.rejects(tool('child', { header: headers.child, next }), { code: 'bot/refused', message: POLICY_UNAVAILABLE_TEXT })
    assert.ok(unreadable.mock.callCount() > reads, 'composed dispatch tried to read provenance')
    assert.equal(next.mock.callCount(), 0)
  }
  ctx.sessions.get = unreadable
  await checkWithoutLevelMark()
  ctx.sessions.get = read
  failing.add('g2')
  await call('update-room', { id: 'r1', permission: WRITE })
  await settle()
  await assert.rejects(tool('child'), refused(WRITE))
  // DSH cannot say whose child a Session is: it may be the marked one's, so it runs no tool.
  ctx.sessions.get = unreadable
  await assert.rejects(tool('child'), unread)
  await assert.rejects(tool('grandchild', { header: headers.grandchild }), unread, 'a parent that cannot be read, too')
  await assert.rejects(tool('elsewhere'), unread, 'and a Session the team does not know')
  // The marked Session needs no read, and neither does a child that names it.
  await assert.rejects(tool('g2'), refused(WRITE))
  await assert.rejects(tool('child', { header: headers.child }), refused(WRITE))
  // Readable again: only the marked Session's children are refused.
  ctx.sessions.get = read
  await assert.rejects(tool('grandchild'), refused(WRITE))
  assert.equal(await tool('elsewhere'), 'ran')
  // Recovery clears the seat mark. Composed dispatch still needs readable provenance.
  failing.clear()
  assert.equal(await tool('g2'), 'ran')
  ctx.sessions.get = unreadable
  await checkWithoutLevelMark()
  ctx.sessions.get = read
  assert.equal(await tool('child', { header: headers.child, next }), 'ran')
  assert.equal(next.mock.callCount(), 1)
})

test('a child switched to Workspace still obeys its Bot deny list and its seat level hold', async t => {
  const b = team(t, { bots: { b2: { denyTools: ['bash'] } }, room: { permission: WRITE }, levels: { g2: WRITE, child: 'custom' } })
  await b.call('state', {})
  b.headers.g2 = { id: 'g2' }
  b.headers.child = { id: 'child', origin: 'subagent', parentSession: 'g2' }
  b.policies.set('g2', 'ask')
  b.policies.set('child', 'never')
  b.modes.set('child', WRITE)
  for (const listener of b.ctx.listeners.get('agent/created') ?? []) await listener({ agent: { id: 'child', session: { id: 'child', header: b.headers.child } }, source: 'startup' })
  assert.ok(b.sets.includes('child=workspace-write'))
  assert.equal(b.policies.get('child'), 'ask')
  await assert.rejects(b.tool('child'), /Ada does not have the bash tool/)
  assert.equal(await b.tool('child', { name: 'read_file' }), 'ran')
  b.failing.add('g2')
  await b.call('update-room', { id: 'r1', permission: 'auto' })
  await b.settle()
  await assert.rejects(b.tool('child'), refused('auto'))
  await assert.rejects(b.tool('child', { name: 'read_file' }), refused('auto'))
})
