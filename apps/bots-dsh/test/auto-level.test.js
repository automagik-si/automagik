// The "level not applied" rule for a Bot on an ACP agent (Claude Code, Codex). The agent runs
// its own tools under its own mode, which the team's tools/execute guard never reaches, so the
// team also answers acp-dsh's turn gate (`acpAgents.holdTurns`) from the same mark, and ends
// the agent session of a Session the moment it is marked (`acpAgents.endSession`). Both only
// ever refuse. acp-dsh is a fake here: the gates it was given and the sessions it was told to end.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const FULL = 'danger-full-access'
const WRITE = 'workspace-write'
const STOCK = {
  [WRITE]: { sandbox: 'workspace-write', approval: 'ask' },
  [FULL]: { sandbox: 'danger-full-access', approval: 'never' },
}
const AUTO_SPEC = { sandbox: 'danger-full-access', approval: 'ask' }

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
function team(t, { acp = true, auto = true, bots = {}, room = {}, tasks, closed = [], presets = true, levels = {}, failing: failingAtStart = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-unapplied-agents-'))
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
  // acp-dsh's service, as the team sees it: the gates it registered, the sessions it ended.
  const gates = []
  const ended = []
  let answerer
  const acpAgents = {
    ownMode: answer => { answerer = answer; return () => { answerer = undefined } },
    ownModeOf: () => ({ mode: 'agent', bridged: false, answerer: answerer !== undefined }),
    ownModeIn: () => true,
    holdTurns: (gate) => { gates.push(gate); return () => { gates.splice(gates.indexOf(gate), 1) } },
    endSession: (sessionId, why) => { ended.push([sessionId, why]); return true },
  }
  const ctx = fakeContext({ services: { ...(presets ? { permissionPresets: service } : {}), ...(acp === true ? { acpAgents } : acp ? { acpAgents: acp } : {}) } })
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
  // DSH opens a Session: its level is set again within the announce.
  const opens = async (sessionId) => {
    for (const listener of ctx.listeners.get('session/created') ?? []) void Promise.resolve(listener({ id: sessionId })).catch(() => {})
    await settle()
  }
  // acp-dsh asking the team before an agent acts for a Session.
  // Bounded: a gate that never answers fails its test, it does not hang the run.
  const turn = (sessionId, header) => {
    let timer
    const late = new Promise((_, fail) => { timer = setTimeout(() => fail(new Error('the gate did not answer in 10 s')), 10_000) })
    const answer = Promise.resolve().then(() => gates[0]({ sessionId, provider: 'acp-claude', agent: { id: sessionId, session: { id: sessionId, ...(header ? { header } : {}) } } }))
    return Promise.race([answer, late]).finally(() => clearTimeout(timer))
  }
  return { home, acpAgents, answer: id => answerer({ sessionId: id, agent: { session: { id } }, provider: 'acp-codex' }), ctx, rt, service, call, settle, failing, sets, headers, tool, opens, gates, ended, turn, levelOf: id => presetOf.get(id) }
}

const codex = { model: 'acp-codex/default', appliedModel: 'acp-codex/default' }
for (const permission of [undefined, 'read-only']) test(`Auto persists before publication from ${permission}`, async t => {
  const w = team(t, { bots: { m1: { ...codex, permission } } })
  await w.rt.load()
  await w.rt.setBotAuto('m1', 0)
  const bot = w.rt.botOf('m1')
  assert.equal(bot.permissionAuto, 'acp-codex')
  assert.equal(bot.permission, WRITE)
  assert.equal(bot.permissionRev, 1)
  const disk = JSON.parse(readFileSync(join(w.home, 'state.json'), 'utf8'))
  assert.equal(disk.bots.m1.permissionAuto, 'acp-codex')
  assert.equal(disk.autoStamp, disk.revision)
  assert.equal(w.answer(w.rt.chatOf('m1')), true)
  assert.equal(w.answer('unowned'), false)
  await assert.rejects(w.rt.setBotAuto('m1', 0), /changed meanwhile/)
})
test('Auto failed copy never publishes a mark', async t => {
  const w = team(t, { bots: { m1: codex } }); await w.rt.load()
  t.mock.method(w.rt, 'saveCopy', async () => { throw new Error('disk failed') })
  await assert.rejects(w.rt.setBotAuto('m1', 0), /disk failed/)
  assert.equal(w.rt.botOf('m1').permissionAuto, undefined)
  assert.equal(w.answer(w.rt.chatOf('m1')), false)
  await w.rt.save()
  assert.equal(JSON.parse(readFileSync(join(w.home, 'state.json'), 'utf8')).bots.m1.permissionAuto, undefined)
})
test('Auto clear ends the session even when the write fails', async t => {
  const w = team(t, { bots: { m1: codex } }); await w.rt.load(); await w.rt.setBotAuto('m1', 0)
  t.mock.method(w.rt, 'save', async () => { throw new Error('disk failed') })
  await assert.rejects(w.rt.clearAuto(w.rt.botOf('m1')), /disk failed/)
  assert.equal(w.rt.botOf('m1').permissionAuto, undefined)
  assert.ok(w.ended.some(([id]) => id === w.rt.chatOf('m1')))
  assert.equal(w.answer(w.rt.chatOf('m1')), false)
})

const diskOf = w => JSON.parse(readFileSync(join(w.home, 'state.json'), 'utf8'))
const enabled = async t => { const w = team(t, { bots: { m1: codex, b2: codex } }); await w.rt.load(); await w.rt.setBotAuto('m1', 0); return w }
test('Auto refuses unrelated Sessions, held presets, other routes, deny lists and lost ownership', async t => {
  const w = await enabled(t); const bot = w.rt.botOf('m1'); const id = w.rt.chatOf('m1')
  for (const other of ['g1', 'old-part', 'task', 'child']) assert.equal(w.answer(other), false)
  const current = w.service.current
  w.service.current = () => FULL; assert.equal(w.answer(id), false); w.service.current = current
  const held = t.mock.method(w.rt, 'levelHeld', () => true); assert.equal(w.answer(id), false); held.mock.restore()
  bot.model = 'acp-claude/default'; assert.equal(w.answer(id), false); bot.model = codex.model
  // #1092: Auto and deny lists coexist; the deny is still enforced.
  bot.denyTools = ['bash']; assert.equal(w.answer(id), true); delete bot.denyTools
  bot.permission = 'read-only'; assert.equal(w.answer(id), false); bot.permission = WRITE
  t.mock.method(w.rt, 'holdsLock', () => false); assert.equal(w.answer(id), false)
})
test('Auto cannot be written by update-bot and stale window revisions write nothing', async t => {
  const w = team(t, { bots: { m1: codex } }); await w.rt.load()
  const before = readFileSync(join(w.home, 'state.json'), 'utf8')
  await assert.rejects(w.rt.updateBot('m1', { permissionAuto: 'acp-codex' }), /Only the person/)
  assert.equal(readFileSync(join(w.home, 'state.json'), 'utf8'), before)
  await w.rt.setPermission(w.rt.botOf('m1'), WRITE)
  await assert.rejects(w.rt.setBotAuto('m1', 0), /changed meanwhile/)
  assert.equal(diskOf(w).bots.m1.permissionAuto, undefined)
})
test('Auto tasks inherit only from the current own-mode chat and end with its level', async t => {
  const w = await enabled(t); const id = w.rt.chatOf('m1')
  const invoke = (sessionId, body) => {
    const hooks = w.ctx.listeners.get('tools/execute') ?? []
    const exec = { name: 'start_task', arguments: {}, agent: { session: { id: sessionId } } }
    const next = i => () => i < hooks.length ? hooks[i](exec, next(i + 1)) : body()
    return next(0)()
  }
  assert.deepEqual(await invoke(id, () => w.rt.autoOpener()), { botId: 'm1', route: 'acp-codex', rev: 1 })
  assert.equal(await invoke('g1', () => w.rt.autoOpener()), undefined)
  w.acpAgents.ownModeIn = () => false
  assert.equal(await invoke(id, () => w.rt.autoOpener()), undefined)
  w.rt.state.tasks ??= {}
  w.rt.state.tasks.inherited = { from: 'm1', status: 'working', auto: 'acp-codex', autoRev: 1 }
  w.service.set({ id: 'inherited' }, WRITE)
  assert.equal(w.answer('inherited'), true)
  await w.rt.setPermission(w.rt.botOf('m1'), WRITE)
  assert.equal(w.answer('inherited'), false)
  assert.ok(w.ended.some(([ended]) => ended === 'inherited'))
})
for (const patch of [{ permission: WRITE }]) test(`Auto ends before saving ${JSON.stringify(patch)}`, async t => {
  const w = await enabled(t)
  await w.rt.updateBot('m1', patch)
  assert.equal(diskOf(w).bots.m1.permissionAuto, undefined)
  assert.ok(w.ended.some(([id]) => id === w.rt.chatOf('m1')))
})
// #1092: Auto and deny lists coexist; the deny is still enforced.
test('Auto keeps its mark and ends the session when its deny list changes', async t => {
  const w = await enabled(t); const bot = w.rt.botOf('m1'); const rev = bot.permissionRev
  taskAt(w, 'inherited', { ...inheritedTask })
  const save = w.rt.save
  t.mock.method(w.rt, 'save', async (...args) => { assert.ok(bot.permissionRev > rev); return save(...args) })
  const drop = t.mock.method(w.rt, 'dropAutoGrants')
  await w.rt.updateBot('m1', { denyTools: ['bash'] })
  assert.equal(bot.permissionAuto, 'acp-codex')
  assert.equal(diskOf(w).bots.m1.permissionAuto, 'acp-codex')
  assert.ok(bot.permissionRev > rev)
  assert.equal(diskOf(w).bots.m1.permissionRev, bot.permissionRev)
  assert.ok(w.ended.some(([id]) => id === w.rt.chatOf('m1')))
  assert.ok(drop.mock.calls.some(call => call.arguments[0].includes(w.rt.chatOf('m1'))))
  assert.equal(w.answer('inherited'), false)
  await assert.rejects(w.rt.setBotAuto('m1', rev), /changed meanwhile/)
})
test('Auto concurrent copies and ordinary saves publish both marks with current stamps', async t => {
  const w = team(t, { bots: { m1: codex, b2: codex } }); await w.rt.load()
  const copy = w.rt.saveCopy
  t.mock.method(w.rt, 'saveCopy', change => { const writing = copy(change); void w.rt.save(); return writing })
  await Promise.all(['m1', 'b2'].map(id => w.rt.setBotAuto(id, 0)))
  const disk = diskOf(w)
  for (const id of ['m1', 'b2']) assert.equal(disk.bots[id].permissionAuto, 'acp-codex')
  assert.equal(disk.autoStamp, disk.revision)
})
test('Auto catch-up failure revokes memory and ends the chat', async t => {
  const w = team(t, { bots: { m1: codex } }); await w.rt.load()
  const copy = w.rt.saveCopy
  t.mock.method(w.rt, 'saveCopy', async change => { await copy(change); w.rt.state.revision += 1 })
  t.mock.method(w.rt, 'save', async () => { throw new Error('catch-up failed') })
  await assert.rejects(w.rt.setBotAuto('m1', 0), /catch-up failed/)
  assert.equal(w.rt.botOf('m1').permissionAuto, undefined)
  assert.ok(w.ended.some(([id]) => id === w.rt.chatOf('m1')))
})
test('Auto old stamps are removed by the load migration', async t => {
  const w = team(t, { bots: { m1: { ...codex, permission: WRITE, permissionAuto: 'acp-codex' } } })
  await w.rt.load()
  assert.equal(w.rt.botOf('m1').permissionAuto, undefined)
  assert.equal(diskOf(w).bots.m1.permissionAuto, undefined)
})
test('Auto offer and fallback follow bridge availability and change the permission key', async t => {
  const w = await enabled(t); const bot = w.rt.botOf('m1')
  assert.equal(w.rt.autoViewOf(bot).autoOffered, true)
  const key = w.rt.autoKey()
  w.acpAgents.ownModeOf = () => ({ mode: 'agent', bridged: true, answerer: true })
  assert.equal(w.rt.autoViewOf(bot).autoOffered, true)
  assert.equal(w.rt.autoViewOf(bot).permissionFallback, undefined)
  assert.notEqual(w.rt.autoKey(), key)
})

test('Auto key counts a Bot as false when the session list throws', async t => {
  const w = await enabled(t)
  const key = w.rt.autoKey()
  t.mock.method(w.ctx.sessions, 'list', () => { throw new Error('session list unavailable') })
  assert.doesNotThrow(() => w.rt.autoKey())
  assert.notEqual(w.rt.autoKey(), key)
  assert.ok(w.rt.autoKey().split(',').includes('m1:truefalse:codex'))
})

test('Auto waiters settle a rejected enable: clear continues and the second enable is stale', async t => {
  const w = team(t, { bots: { m1: codex } }); await w.rt.load()
  let reject
  t.mock.method(w.rt, 'saveCopy', () => new Promise((_, fail) => { reject = fail }))
  const first = w.rt.setBotAuto('m1', 0)
  const again = w.rt.setBotAuto('m1', 0)
  const clearing = w.rt.clearAuto(w.rt.botOf('m1'))
  const failed = assert.rejects(first, /write failed/)
  const stale = assert.rejects(again, /changed meanwhile/)
  reject(new Error('write failed'))
  await Promise.all([failed, stale, clearing])
  assert.equal(w.rt.botOf('m1').permissionRev, 1)
})
test('Auto apply failure ends the chat and inherited task even if cleanup save fails', async t => {
  const w = team(t, { bots: { m1: codex }, tasks: { task: { from: 'm1', status: 'working', auto: 'acp-codex', autoRev: 1 } } }); await w.rt.load()
  // The migration drops old marks, so this working task is marked by the current opener.
  Object.assign(w.rt.state.tasks.task, { auto: 'acp-codex', autoRev: 1 })
  t.mock.method(w.rt, 'levelTo', async () => { throw new Error('apply failed') })
  t.mock.method(w.rt, 'save', async () => { throw new Error('cleanup failed') })
  await assert.rejects(w.rt.setBotAuto('m1', 0), /cleanup failed/)
  assert.equal(w.rt.botOf('m1').permissionAuto, undefined)
  for (const id of [w.rt.chatOf('m1'), 'task']) assert.ok(w.ended.some(([ended]) => ended === id))
  assert.equal(w.answer(w.rt.chatOf('m1')), false)
})

// Real task records: only a working task the chat started on Auto, at the mark's current rev,
// with no group or parent task and no cap, counts.
const taskAt = (w, id, record) => {
  w.rt.state.tasks ??= {}
  w.rt.state.tasks[id] = record
  w.service.set({ id }, WRITE)
}
const inheritedTask = { from: 'm1', status: 'working', auto: 'acp-codex', autoRev: 1 }
for (const [what, record, expected] of [
  ['an inherited task at the current rev', { ...inheritedTask }, true],
  ['a working task without the mark', { from: 'm1', status: 'working' }, false],
  ['a done inherited task', { ...inheritedTask, status: 'done' }, false],
  ['a group-asked inherited task', { ...inheritedTask, roomId: 'r1' }, false],
  ['an inherited task held to a group level', { ...inheritedTask, levelRoomId: 'r1' }, false],
  ['a subagent child', { ...inheritedTask, levelTaskId: 'x' }, false],
  ['a capped inherited task', { ...inheritedTask, permissionCap: WRITE }, false],
]) test(`Auto answers ${expected} for ${what}`, async t => {
  const w = await enabled(t)
  taskAt(w, 'task', record)
  assert.equal(w.answer('task'), expected)
})
test('Auto: a task inherited under an earlier Auto answers false after a re-enable', async t => {
  const w = await enabled(t); const bot = w.rt.botOf('m1')
  taskAt(w, 'old', { ...inheritedTask })
  assert.equal(w.answer('old'), true)
  await w.rt.setPermission(bot, WRITE)
  await w.rt.setBotAuto('m1', bot.permissionRev)
  assert.equal(bot.permissionRev, 3)
  assert.equal(w.rt.state.tasks.old.status, 'working')
  assert.equal(w.answer(w.rt.chatOf('m1')), true)
  assert.equal(w.answer('old'), false)
})

// A tool call of `sessionId`, as DSH dispatches it: every tools/execute listener around the body.
const inCall = (w, sessionId, name, body) => {
  const exec = { name, arguments: {}, agent: { id: sessionId, session: { id: sessionId } } }
  const hooks = [...(w.ctx.listeners.get('tools/execute') ?? [])]
  const next = i => () => (i < hooks.length ? hooks[i](exec, next(i + 1)) : body())
  return next(0)()
}
const codexLlm = { listProviders: () => [{ id: 'acp-codex', name: 'Codex' }, { id: 'deepseek', name: 'DeepSeek' }], listModels: async provider => (provider === 'acp-codex' ? [{ id: 'default' }] : [{ id: 'deepseek-v4-flash' }]), resolveModelInfo: async () => ({}) }
test('Auto: start_task from the own-mode chat records the mark; from a group or a strict prompt it does not', async t => {
  const w = await enabled(t); const id = w.rt.chatOf('m1')
  const start = sessionId => inCall(w, sessionId, 'start_task', () => w.rt.startTask({ title: 'x', text: 'Do x', from: 'm1' }))
  const task = await start(id)
  await w.settle()
  assert.equal(w.rt.state.tasks[task].auto, 'acp-codex')
  assert.equal(w.rt.state.tasks[task].autoRev, 1)
  assert.equal(w.answer(task), true)
  const grouped = await start('g1')
  assert.equal(w.rt.state.tasks[grouped].auto, undefined)
  w.acpAgents.ownModeIn = () => false
  const strict = await start(id)
  assert.equal(w.rt.state.tasks[strict].auto, undefined)
  await w.rt.setPermission(w.rt.botOf('m1'), WRITE)
  assert.equal(w.answer(task), false)
  assert.ok(w.ended.some(([ended]) => ended === task))
})
test('Auto: create_bot from the own-mode chat marks a new Codex Bot on disk; a deny list inherits too; another model or a strict prompt does not', async t => {
  const w = team(t, { bots: { m1: codex, b2: codex } })
  w.ctx.llm = codexLlm
  await w.rt.load(); await w.rt.setBotAuto('m1', 0)
  const id = w.rt.chatOf('m1')
  const create = (sessionId, args) => inCall(w, sessionId, 'create_bot', () => w.ctx.registeredTools.get('create_bot').execute(args, { agent: { id: sessionId, session: { id: sessionId } }, callId: 'x', signal: new AbortController().signal }))
  const byName = name => Object.values(w.rt.state.bots).find(bot => bot.name === name)
  assert.match(await create(id, { name: 'Someone', role: 'x', instructions: 'x' }), /\(Auto\)/)
  const someone = byName('Someone')
  assert.equal(someone.permissionAuto, 'acp-codex')
  assert.equal(someone.permissionRev, 1)
  assert.equal(diskOf(w).bots[someone.id].permissionAuto, 'acp-codex')
  // #1092: Auto and deny lists coexist; the deny is still enforced.
  await create(id, { name: 'X1', role: 'x', instructions: 'x', deny_tools: ['bash'] })
  const x1 = byName('X1')
  assert.equal(x1.permissionAuto, 'acp-codex')
  assert.equal(diskOf(w).bots[x1.id].permissionAuto, 'acp-codex')
  assert.deepEqual(x1.denyTools, ['bash'])
  assert.deepEqual(diskOf(w).bots[x1.id].denyTools, ['bash'])
  for (const [name, args, setup] of [
    ['X2', { model: 'deepseek/deepseek-v4-flash' }],
    // Undeclared arguments change nothing.
    ['X3', { permissionAuto: 'acp-codex', inheritAuto: { route: 'acp-codex' } }, () => { w.acpAgents.ownModeIn = () => false }],
  ]) {
    setup?.()
    await create(id, { name, role: 'x', instructions: 'x', ...args })
    // Read right after the call: a later save's sweep would hide a mark the inheritance must never write.
    const bot = byName(name)
    assert.ok(bot, name)
    assert.equal(bot.permissionAuto, undefined, name)
    assert.equal(diskOf(w).bots[bot.id].permissionAuto, undefined, name)
  }
})

// The refusals, word for word: the window words them by these templates (i18n.js HOST_TEMPLATES).
test('Auto: set-bot-auto refuses, writing nothing, wherever Auto is not offered', async t => {
  const cases = [
    ['a retired Claude Code route', { model: 'claude-code/x', appliedModel: 'claude-code/x' }],
    ['a bridged Codex without an answerer', codex, w => { w.acpAgents.ownModeOf = () => ({ mode: 'agent', bridged: true, answerer: false }) }],
    ['no answerer', codex, w => { w.acpAgents.ownModeOf = () => ({ mode: 'agent', bridged: false, answerer: false }) }],
    ['a lost lock', codex, w => { t.mock.method(w.rt, 'holdsLock', () => false) }],
  ]
  for (const [what, bot, setup] of cases) {
    const w = team(t, { bots: { m1: bot } }); await w.rt.load()
    setup?.(w)
    await assert.rejects(w.rt.setBotAuto('m1', 0), { message: 'Auto is not offered for Omni here.' }, what)
    assert.equal(w.rt.botOf('m1').permissionAuto, undefined, what)
    assert.equal(diskOf(w).bots.m1.permissionAuto, undefined, what)
  }
})
test('Auto: update-bot refuses every Auto key, writing nothing', async t => {
  const w = team(t, { bots: { m1: codex } }); await w.rt.load()
  const before = readFileSync(join(w.home, 'state.json'), 'utf8')
  for (const patch of [{ permissionAuto: 'acp-codex' }, { permissionRev: 5 }, { autoStamp: 1 }]) await assert.rejects(w.rt.updateBot('m1', patch), { message: "Only the person turns Auto on, from the Bot's permission choice." })
  assert.equal(readFileSync(join(w.home, 'state.json'), 'utf8'), before)
})
test('Auto: a stale enable is refused in so many words', async t => {
  const w = team(t, { bots: { m1: codex } }); await w.rt.load()
  await w.rt.setPermission(w.rt.botOf('m1'), WRITE)
  await assert.rejects(w.rt.setBotAuto('m1', 0), { message: "Omni's permissions changed meanwhile, so nothing was saved. Look again and choose." })
})
test('Auto: a failed catch-up save from Read only puts Read only back', async t => {
  const w = team(t, { bots: { m1: { ...codex, permission: 'read-only' } } }); await w.rt.load()
  const copy = w.rt.saveCopy
  t.mock.method(w.rt, 'saveCopy', async change => { await copy(change); w.rt.state.revision += 1 })
  t.mock.method(w.rt, 'save', async () => { throw new Error('catch-up failed') })
  await assert.rejects(w.rt.setBotAuto('m1', 0), /catch-up failed/)
  assert.equal(w.rt.botOf('m1').permission, 'read-only')
})

// #1092: Auto and deny lists coexist; the deny is still enforced.
test('set-bot-auto accepts a Codex Bot with a deny list', async t => {
  const w = team(t, { bots: { m1: { ...codex, denyTools: ['bash'] } } }); await w.rt.load()
  await w.rt.setBotAuto('m1', 0)
  assert.equal(w.rt.botOf('m1').permissionAuto, 'acp-codex')
  assert.equal(diskOf(w).bots.m1.permissionAuto, 'acp-codex')
  assert.deepEqual(diskOf(w).bots.m1.denyTools, ['bash'])
})
