import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { TEAM_TOOLS } from '../src/host/constants.js'
import { fakeContext } from './fake-ctx.js'

const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() }

// Enough of the dsh services for the roster and the agents module; tool restrict
// calls and archived Sessions are recorded for the assertions.
let rt
function start(team, { config = {}, home = mkdtempSync(join(tmpdir(), 'ds-bot-agents-')) } = {}) {
  if (team !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const ctx = fakeContext()
  const workspaces = new Map()
  const created = []
  const archived = []
  const failArchive = { on: false }
  const restricted = []
  const scoped = []
  const renamed = []
  let sessions = 0
  ctx.tools.schemas = () => [...TEAM_TOOLS, 'read', 'write'].map(name => ({ name }))
  Object.assign(ctx, {
    workspaceRegistry: {
      get: id => workspaces.get(id),
      resolveByPath: async path => [...workspaces.values()].find(workspace => workspace.path === path),
      create: async (path) => {
        const workspace = { id: `w${workspaces.size + 1}`, path }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async (sessionId) => {
        if (failArchive.on) throw new Error('session is running')
        archived.push(sessionId)
      },
    },
    sessionController: {
      create: async (options) => {
        created.push(options)
        return { sessionId: options.sessionId ?? `s${++sessions}` }
      },
      resolveAgent: async (sessionId) => {
        const agent = {
          session: { id: sessionId },
          ctx: {
            tools: {
              register: (tool) => { scoped.push({ sessionId, name: tool.name }); return () => {} },
              restrict: (filter) => { restricted.push({ sessionId, filter }); return () => {} },
            },
            effect: execute => execute(),
          },
          followup() {},
        }
        return { agent }
      },
      selectModel: async () => {},
    },
    sessionTitle: { rename: async (session, title) => { renamed.push({ id: session.id, title }) } },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  apply(ctx, { home, ...config })
  rt = ctx.provided.get('omniTeam')
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/omni-ui', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const createdAgents = payload => (ctx.listeners.get('agent/created') ?? []).map(listener => listener(payload))
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return {
    call, stop, home, created, archived, failArchive, restricted, scoped, renamed, createdAgents, ctx,
  }
}

async function nativeTransition(t) {
  const bench = start(TEAM)
  t.after(bench.stop)
  await bench.call('state', {})
  const rt = bench.ctx.provided.get('omniTeam')
  bench.ctx.provided.set('agentPresets', { list: async () => [{ id: 'cordis' }] })
  const entry = (await bench.call('add-agent', { name: 'Brain', profile: 'cordis' })).value
  const botId = (await bench.call('agent-bot-adopt', { agentId: entry.id })).value.botId
  const bot = rt.state.bots[botId]
  Object.assign(bot, { workDir: '/original', model: 'native/chosen', effort: 'high', permissions: { mode: 'ask' } })
  await rt.save({ required: true })
  const target = { id: 'picked', session: { id: 'picked', header: { id: 'picked', cwd: '/selected', isSeeded: false } }, preset: 'standard', boundary: { openTurnStartSeq: null, lastTurn: 0 } }
  const resolve = rt.resolveAgent
  rt.resolveAgent = async id => id === 'picked' ? target : resolve(id)
  // dsh 0.2.2 reads the turn boundary and the preset through their owning services.
  bench.ctx.agents = { turnBoundaryOf: session => session.id === 'picked' ? target.boundary : undefined }
  const selected = []
  const presets = {
    list: async () => [{ id: 'cordis' }],
    select: async (live, preset) => { selected.push([live.session.id, preset]); live.preset = preset },
    // The owner reads the Session's recorded preset (the agent that carries it here).
    presetForSession: session => session?.id === 'picked' ? target.preset : undefined,
  }
  bench.ctx.provided.set('agentPresets', presets)
  return { ...bench, rt, bot, botId, entry, target, presets, selected, adopt: () => bench.call('bot-session-adopt', { botId, sessionId: 'picked', sourceSessionId: botId }) }
}

// The team records an adopt must leave as they were: the Bot and its parts, the DSH
// bots and their Sessions, the group chats' Sessions and segments, and the task records.
const teamState = rt => structuredClone({
  bots: rt.state.bots,
  agents: rt.state.agents,
  rooms: rt.state.rooms,
  tasks: rt.state.tasks,
  switching: rt.state.switching,
})

// The reason each eligibility refusal must name, with the exact code the UI receives.
const ADOPT_REFUSALS = {
  nonblank: ['bot/adopt-not-blank', /is neither blank nor a fork of the current part of Bot "Brain"/],
  subagent: ['bot/adopt-root', /is not a root Session.*cannot join Bot "Brain"/],
  depth: ['bot/adopt-root', /is not a root Session.*cannot join Bot "Brain"/],
  task: ['bot/adopt-in-team', /already belongs to the team.*cannot join Bot "Brain"/],
  'other-owner': ['bot/adopt-in-team', /already belongs to the team.*cannot join Bot "Brain"/],
  group: ['bot/adopt-in-team', /already belongs to the team.*cannot join Bot "Brain"/],
  'wrong-source': ['bot/adopt-changed', /changed while Session picked was joining it/],
  registration: ['bot/adopt-unknown', /Bot "Brain" is not an adopted DSH Bot, so Session picked cannot join it/],
  ordinary: ['bot/adopt-unknown', /Bot "Brain" is not an adopted DSH Bot, so Session picked cannot join it/],
}

test('native project association persists the exact selected root and stable adopted identity', async t => {
  const bench = await nativeTransition(t)
  const { rt, bot, botId, entry, home, created, archived, target } = bench
  const original = structuredClone(rt.state.agents[entry.id])
  const count = created.length
  const adopted = await bench.adopt()
  assert.equal(adopted.ok, true, adopted.error?.message)
  assert.equal(rt.chatOf(botId), 'picked')
  assert.equal(rt.selfOf('picked'), botId)
  assert.equal(rt.agentOf('picked'), undefined)
  assert.equal(bot.id, botId)
  assert.equal(bot.dshAgentId, entry.id)
  assert.equal(bot.kind, 'dsh')
  assert.equal(bot.profile, 'cordis')
  assert.equal(bot.workDir, '/original')
  assert.equal(target.session.header.cwd, '/selected')
  assert.equal(bot.model, 'native/chosen')
  assert.equal(bot.effort, 'high')
  assert.deepEqual(bot.permissions, { mode: 'ask' })
  assert.deepEqual(bench.selected, [['picked', 'cordis']])
  assert.deepEqual(rt.state.agents[entry.id], original)
  assert.equal((await bench.adopt()).ok, true)
  assert.equal(bot.segments.filter(part => part.sessionId === botId).length, 1)
  assert.equal(created.length, count)
  assert.deepEqual(archived, [])
  const stored = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(stored.bots[botId].sessionId, 'picked')
  const reload = start(undefined, { home })
  await reload.call('state', {})
  assert.equal(reload.ctx.provided.get('omniTeam').selfOf('picked'), botId)
  await reload.ctx.dispose()
})

for (const invalid of ['nonblank', 'subagent', 'depth', 'task', 'other-owner', 'group', 'wrong-source', 'registration', 'ordinary']) {
  test(`native project association refuses ${invalid}`, async t => {
    const bench = await nativeTransition(t)
    const { target, rt, bot, botId, entry } = bench
    if (invalid === 'nonblank') target.boundary.lastTurn = 1
    if (invalid === 'subagent') target.session.header.origin = 'subagent'
    if (invalid === 'depth') target.session.header.delegationDepth = 1
    if (invalid === 'subagent' || invalid === 'depth') {
      target.session.header.parentSession = 'loaded-parent'
      bench.ctx.agents.get = id => id === 'loaded-parent' ? { id } : undefined
      assert.equal(bench.ctx.agents.isOwnedBy, undefined, 'rc.2 has no isOwnedBy export')
    }
    if (invalid === 'task') rt.state.tasks = { ...rt.state.tasks, picked: { from: botId } }
    if (invalid === 'other-owner') rt.state.bots.other = { id: 'other', sessionId: 'picked', name: 'Other' }
    if (invalid === 'group') rt.state.rooms.room = { id: 'room', members: [botId], sessions: { [botId]: 'picked' } }
    if (invalid === 'wrong-source') bot.sessionId = 'newer'
    if (invalid === 'registration') rt.state.agents[entry.id].adoptedBotId = 'other'
    if (invalid === 'ordinary') delete bot.kind
    rt.indexSessions()
    const before = teamState(rt)
    const [code, reason] = ADOPT_REFUSALS[invalid]
    const result = await bench.adopt()
    assert.equal(result.ok, false)
    assert.equal(result.error.code, code)
    assert.match(result.error.message, reason)
    assert.match(result.error.message, /Session picked/)
    assert.match(result.error.message, /Bot "Brain"/)
    assert.notEqual(rt.chatOf(botId), 'picked')
    assert.deepEqual(teamState(rt), before, 'a refused adopt must not change the team')
    assert.deepEqual(bench.selected, [])
    const entries = await rt.diagnostics.entries()
    const noted = entries.find(item => item.code === code)
    assert.ok(noted, JSON.stringify(entries))
    assert.equal(noted.source, 'api')
    assert.equal(noted.bot, 'Brain')
    assert.equal(noted.sessionId, 'picked')
    assert.equal(noted.where, 'bot-session-adopt (Session picked)')
    assert.equal(noted.text, result.error.message)
    assert.equal(noted.stack, undefined)
    assert.equal(entries.filter(item => item.code === code).length, 1)
  })
}

test('a native association without a valid Session id is refused by name and code', async t => {
  const bench = await nativeTransition(t)
  const before = teamState(bench.rt)
  const payloads = [
    { sessionId: '', sourceSessionId: bench.botId },
    { sessionId: 42, sourceSessionId: bench.botId },
    { sessionId: 'picked' },
  ]
  for (const payload of payloads) {
    const result = await bench.call('bot-session-adopt', { botId: bench.botId, ...payload })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'bot/adopt-invalid-transition')
    assert.match(result.error.message, /Bot "Brain"/)
    assert.match(result.error.message, /Session/)
    assert.deepEqual(teamState(bench.rt), before)
  }
  const entries = await bench.rt.diagnostics.entries()
  assert.equal(entries.filter(item => item.code === 'bot/adopt-invalid-transition').length, 3)
  assert.ok(entries.every(item => item.code !== 'bot/adopt-invalid-transition'
    || (item.bot === 'Brain' && item.where.startsWith('bot-session-adopt (Session ') && item.stack === undefined)))
})

test('an unknown Bot and a pending transition are refused by name and code without changing state', async t => {
  const bench = await nativeTransition(t)
  const beforeUnknown = teamState(bench.rt)
  const unknown = await bench.call('bot-session-adopt', { botId: 'nope', sessionId: 'picked', sourceSessionId: 'nope' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'bot/adopt-unknown')
  assert.match(unknown.error.message, /Bot nope is not an adopted DSH Bot, so Session picked cannot join it/)
  assert.deepEqual(teamState(bench.rt), beforeUnknown)
  const before = teamState(bench.rt)
  let release
  bench.presets.list = () => new Promise(resolve => { release = () => resolve([{ id: 'cordis' }]) })
  const first = bench.rt.adoptBotSession(bench.botId, 'picked', bench.botId)
  await flush()
  assert.equal(typeof release, 'function')
  await assert.rejects(bench.rt.adoptBotSession(bench.botId, 'picked', bench.botId), error => {
    assert.equal(error.code, 'bot/adopt-pending')
    assert.match(error.message, /A Bot Session transition is already pending for Bot "Brain", so Session picked cannot join it yet/)
    return true
  })
  assert.deepEqual(teamState(bench.rt), before)
  release()
  assert.equal(await first, 'picked')
  const entries = await bench.rt.diagnostics.entries()
  for (const [code, bot] of [['bot/adopt-unknown', 'nope'], ['bot/adopt-pending', 'Brain']]) {
    const entry = entries.find(item => item.code === code)
    assert.ok(entry, JSON.stringify(entries))
    assert.equal(entry.bot, bot)
    assert.equal(entry.sessionId, 'picked')
    assert.equal(entry.where, 'bot-session-adopt (Session picked)')
    assert.equal(entry.stack, undefined)
  }
})

test('a native current-part fork retains its existing preset without replacing the selected Session', async t => {
  const bench = await nativeTransition(t)
  Object.assign(bench.target.session.header, { parentSession: bench.botId, isSeeded: true })
  bench.target.boundary.lastTurn = 3
  bench.target.preset = 'cordis'
  assert.equal((await bench.adopt()).ok, true)
  assert.deepEqual(bench.selected, [])
  assert.equal(bench.rt.chatOf(bench.botId), 'picked')
})

test('native chained nonblank forks require each actual parent to become the current part', async t => {
  const bench = await nativeTransition(t)
  assert.equal((await bench.adopt()).ok, true)
  const original = structuredClone(bench.rt.state.agents[bench.entry.id])
  const forks = new Map(['fork-b', 'fork-c'].map((id, index) => [id, {
    id, preset: 'cordis', boundary: { openTurnStartSeq: null, lastTurn: 3 },
    session: { id, header: { id, cwd: '/selected', parentSession: index === 0 ? 'picked' : 'fork-b', isSeeded: true } },
  }]))
  const resolve = bench.rt.resolveAgent
  bench.rt.resolveAgent = async id => forks.get(id) ?? resolve(id)
  bench.ctx.agents.turnBoundaryOf = session => (forks.get(session.id) ?? bench.target).boundary
  bench.presets.presetForSession = session => (forks.get(session.id) ?? bench.target).preset
  const associate = (sessionId, sourceSessionId) => bench.call('bot-session-adopt', { botId: bench.botId, sessionId, sourceSessionId })
  assert.equal((await associate('fork-c', 'picked')).ok, false, 'a skipped parent must never be accepted as a direct descendant')
  assert.equal((await associate('fork-b', 'picked')).ok, true)
  assert.equal((await associate('fork-c', 'fork-b')).ok, true)
  assert.equal(bench.rt.chatOf(bench.botId), 'fork-c')
  assert.equal(bench.rt.selfOf('fork-c'), bench.botId)
  assert.equal(bench.bot.profile, 'cordis')
  assert.deepEqual(bench.rt.state.agents[bench.entry.id], original)
  assert.deepEqual(bench.archived, [])
})

for (const phase of ['resolve', 'preset-list', 'preset-select']) {
  for (const change of ['source', 'registration']) test(`native association revalidates ${change} after ${phase}`, async t => {
    const bench = await nativeTransition(t)
    const mutate = () => change === 'source' ? bench.bot.sessionId = 'newer' : bench.rt.state.agents[bench.entry.id].profile = 'changed'
    if (phase === 'resolve') {
      const resolve = bench.rt.resolveAgent
      bench.rt.resolveAgent = async id => { const live = await resolve(id); mutate(); return live }
    } else if (phase === 'preset-list') bench.presets.list = async () => { mutate(); return [{ id: 'cordis' }] }
    else bench.presets.select = async live => { mutate(); live.preset = 'cordis' }
    assert.equal((await bench.adopt()).ok, false)
    assert.notEqual(bench.rt.chatOf(bench.botId), 'picked')
    assert.deepEqual(bench.archived, [])
  })
}

test('native association requires a durable save and rolls back ownership on disk failure', async t => {
  const bench = await nativeTransition(t)
  const save = bench.rt.save
  let failed = false
  bench.rt.save = async options => {
    assert.equal(options.required, true)
    if (!failed) { failed = true; throw new Error('disk full') }
    return save(options)
  }
  // The save's raw message stays out of the reply; only its kind does.
  assert.equal((await bench.adopt()).error.message, 'Something went wrong (Error).')
  assert.equal(bench.rt.selfOf('picked'), undefined)
  assert.equal(bench.rt.chatOf(bench.botId), bench.botId)
  assert.deepEqual(bench.archived, [])
  const noted = (await bench.rt.diagnostics.entries()).find(item => item.code === 'Error')
  assert.ok(noted)
  assert.equal(noted.text, 'bot-session-adopt: Error')
  assert.ok(noted.stack, 'an unclassified failure keeps its stack for the host log')
  assert.doesNotMatch(JSON.stringify(noted), /disk full/, 'a file-system message never reaches diagnostics')
  assert.equal((await bench.adopt()).ok, true)
})

test('a native target reservation prevents another Bot changing its preset during association', async t => {
  const bench = await nativeTransition(t)
  const other = { ...bench.bot, id: 'other', sessionId: 'other', dshAgentId: 'other-native', profile: 'standard' }
  bench.rt.state.bots.other = other
  bench.rt.state.agents['other-native'] = { ...bench.rt.state.agents[bench.entry.id], id: 'other-native', adoptedBotId: 'other', sessions: ['other'] }
  await bench.rt.save({ required: true })
  let release
  bench.presets.list = () => new Promise(resolve => { release = () => resolve([{ id: 'cordis' }, { id: 'standard' }]) })
  const first = bench.rt.adoptBotSession(bench.botId, 'picked', bench.botId)
  await flush()
  assert.equal(typeof release, 'function')
  await assert.rejects(bench.rt.adoptBotSession('other', 'picked', 'other'), /transition is already pending/)
  release()
  assert.equal(await first, 'picked')
  assert.equal(bench.target.preset, 'cordis')
  assert.equal(bench.rt.chatOf('other'), 'other')
})

test('native preset flush failure leaves the source and target ownership intact', async t => {
  const bench = await nativeTransition(t)
  bench.ctx.sessions.flush = async session => {
    assert.equal(session.id, 'picked')
    assert.equal(bench.target.preset, 'cordis')
    throw new Error('preset disk failure')
  }
  assert.equal((await bench.adopt()).error.message, 'Something went wrong (Error).')
  assert.equal(bench.rt.selfOf('picked'), undefined)
  assert.equal(bench.rt.chatOf(bench.botId), bench.botId)
  assert.deepEqual(bench.archived, [])
})

test('native eligibility and registration are revalidated after preset flush', async t => {
  const bench = await nativeTransition(t)
  bench.ctx.sessions.flush = async () => { bench.target.boundary.lastTurn = 1 }
  assert.equal((await bench.adopt()).ok, false)
  assert.equal(bench.rt.selfOf('picked'), undefined)
})

test('native association refuses missing presets instead of downgrading silently', async t => {
  const bench = await nativeTransition(t)
  const before = teamState(bench.rt)
  bench.presets.list = async () => []
  const result = await bench.adopt()
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'bot/adopt-preset-unavailable')
  assert.match(result.error.message, /preset cordis is not available/)
  assert.match(result.error.message, /Bot "Brain"/)
  assert.match(result.error.message, /Session picked/)
  assert.equal(bench.rt.selfOf('picked'), undefined)
  assert.deepEqual(teamState(bench.rt), before)
  const noted = (await bench.rt.diagnostics.entries()).find(item => item.code === 'bot/adopt-preset-unavailable')
  assert.ok(noted)
  assert.equal(noted.bot, 'Brain')
  assert.equal(noted.where, 'bot-session-adopt (Session picked)')
  assert.equal(noted.stack, undefined)
})

test('native association refuses an unavailable or unpersisted native preset by name and code', async t => {
  const cases = [
    {
      label: 'selection unavailable',
      code: 'bot/adopt-preset-unavailable',
      setup: bench => { delete bench.presets.select },
      reason: /native preset selection is unavailable/,
    },
    {
      label: 'selection did not persist',
      code: 'bot/adopt-preset-not-persisted',
      setup: bench => { bench.presets.presetForSession = () => undefined },
      reason: /could not keep the native preset "cordis" for Session picked/,
    },
  ]
  for (const { label, code, setup, reason } of cases) {
    await t.test(label, async t => {
      const bench = await nativeTransition(t)
      const before = teamState(bench.rt)
      setup(bench)
      const result = await bench.adopt()
      assert.equal(result.ok, false)
      assert.equal(result.error.code, code)
      assert.match(result.error.message, reason)
      assert.match(result.error.message, /Bot "Brain"/)
      assert.match(result.error.message, /Session picked/)
      assert.equal(bench.rt.selfOf('picked'), undefined)
      assert.equal(bench.rt.chatOf(bench.botId), bench.botId)
      assert.deepEqual(teamState(bench.rt), before)
      const noted = (await bench.rt.diagnostics.entries()).find(item => item.code === code)
      assert.ok(noted)
      assert.equal(noted.bot, 'Brain')
      assert.equal(noted.where, 'bot-session-adopt (Session picked)')
      assert.equal(noted.stack, undefined)
    })
  }
})

test('native association rolls back a Bot changed while its Session was saved', async t => {
  const bench = await nativeTransition(t)
  const before = teamState(bench.rt)
  const save = bench.rt.save
  let replaced = false
  bench.rt.save = async options => {
    const saved = await save(options)
    if (!replaced) {
      replaced = true
      // A value-equal replacement of the registration still fails the identity check.
      bench.rt.state.agents[bench.entry.id] = structuredClone(bench.rt.state.agents[bench.entry.id])
    }
    return saved
  }
  const result = await bench.adopt()
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'bot/adopt-changed-persisting')
  assert.match(result.error.message, /Bot "Brain" changed while Session picked was being saved/)
  assert.equal(bench.rt.chatOf(bench.botId), bench.botId)
  assert.equal(bench.rt.selfOf('picked'), undefined)
  assert.deepEqual(teamState(bench.rt), before)
  const noted = (await bench.rt.diagnostics.entries()).find(item => item.code === 'bot/adopt-changed-persisting')
  assert.ok(noted)
  assert.equal(noted.bot, 'Brain')
  assert.equal(noted.where, 'bot-session-adopt (Session picked)')
  assert.equal(noted.stack, undefined)
})

test('adoption is additive, retains registration, and rollback restores the original', async (t) => {
  const { call, stop, ctx, created, archived, createdAgents, restricted } = start(TEAM)
  t.after(stop)
  await call('state', {})
  ctx.provided.set('agentPresets', { serviceFor: () => undefined, list: async () => [{ id: 'standard' }, { id: 'cordis' }] })
  const rt = ctx.provided.get('omniTeam')
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'ds-bot-adoption-project-')))
  t.after(() => rmSync(project, { recursive: true, force: true }))
  const entry = (await call('add-agent', { name: 'Native', profile: 'cordis', workDir: project })).value
  const original = rt.state.agents[entry.id]
  Object.assign(original, { avatar: { shape: 'kitty' }, color: 'red', capabilities: ['native-skill'] })
  const snapshot = structuredClone(original)
  const second = (await call('agent-session', { agentId: entry.id })).value.sessionId
  snapshot.sessions.push(second)
  const resolve = rt.resolveAgent
  rt.resolveAgent = async id => {
    const live = await resolve(id)
    live.session.requestHeader = () => ({ config: { provider: 'native', model: 'chosen', reasoningEffort: 'high' } })
    return live
  }
  const before = created.length
  assert.equal((await call('agent-bot-adopt', { agentId: entry.id })).value.botId, second)
  const bot = rt.state.bots[second]
  assert.equal(created.length, before)
  assert.equal(rt.state.agents[entry.id], original)
  assert.equal(original.adoptedBotId, second)
  assert.equal(bot.kind, 'dsh')
  assert.equal(bot.model, 'native/chosen')
  assert.equal(bot.effort, 'high')
  assert.equal(bot.profile, 'cordis')
  assert.deepEqual(bot.avatar, snapshot.avatar)
  assert.deepEqual(bot.capabilities, snapshot.capabilities)
  assert.equal(rt.agentOf(second), undefined)
  assert.deepEqual(rt.dshBots.list(), [])
  assert.deepEqual((await call('state', {})).value.agents, [])
  const count = restricted.length
  createdAgents({ agent: { session: { id: second }, ctx: { effect: execute => execute(), tools: { restrict: () => { throw new Error('adopted session restricted') } } } } })
  await flush()
  assert.equal(restricted.length, count)
  assert.equal((await call('agent-bot-rollback', { agentId: entry.id })).ok, true)
  assert.deepEqual(original, snapshot)
  assert.equal(rt.state.bots[second], undefined)
  assert.equal(rt.agentOf(second), original)
  assert.equal(rt.dshBots.list()[0].id, entry.id)
  assert.deepEqual(archived, [])
  assert.equal(restricted.length, count + 2)
})

test('adoption and rollback save failures restore both records without archiving', async (t) => {
  const { call, stop, ctx, archived } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const entry = (await call('add-agent', { name: 'Native' })).value
  const rt = ctx.provided.get('omniTeam')
  const original = rt.state.agents[entry.id]
  const save = rt.save
  let fail = true
  rt.save = async () => { if (fail) { fail = false; throw new Error('disk full') } return save() }
  assert.equal((await call('agent-bot-adopt', { agentId: entry.id })).error.message, 'Something went wrong (Error).')
  assert.equal(rt.state.agents[entry.id], original)
  assert.equal(original.adoptedBotId, undefined)
  assert.equal(rt.state.bots[entry.sessions[0]], undefined)
  assert.equal(rt.agentOf(entry.sessions[0]), original)
  assert.equal((await call('agent-bot-adopt', { agentId: entry.id })).ok, true)
  const bot = rt.state.bots[entry.sessions[0]]
  fail = true
  assert.equal((await call('agent-bot-rollback', { agentId: entry.id })).error.message, 'Something went wrong (Error).')
  assert.equal(original.adoptedBotId, bot.id)
  assert.equal(rt.state.bots[bot.id], bot)
  assert.equal(rt.agentOf(bot.id), undefined)
  rt.save = save
  assert.equal((await call('agent-bot-rollback', { agentId: entry.id })).ok, true)
  assert.deepEqual(archived, [])
})

test('adoption rejects a host shutdown during Session resolution and retains the original registration', async (t) => {
  const { call, stop, ctx, home } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const entry = (await call('add-agent', { name: 'Native' })).value
  const rt = ctx.provided.get('omniTeam')
  const original = structuredClone(rt.state.agents[entry.id])
  const resolve = rt.resolveAgent
  rt.resolveAgent = async id => {
    const live = await resolve(id)
    await ctx.dispose()
    return live
  }
  await assert.rejects(rt.adoptAsBot(entry.id), /host stopped/)
  assert.deepEqual(rt.state.agents[entry.id], original)
  assert.equal(rt.state.bots[entry.sessions[0]], undefined)
  assert.equal(rt.agentOf(entry.sessions[0]), rt.state.agents[entry.id])
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.deepEqual(saved.agents[entry.id], original)
  assert.equal(saved.bots[entry.sessions[0]], undefined)
})

test('rollback rejects skipped persistence after shutdown and restores adopted records and indexes', async (t) => {
  const { call, stop, ctx, home } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const entry = (await call('add-agent', { name: 'Native' })).value
  const rt = ctx.provided.get('omniTeam')
  await rt.adoptAsBot(entry.id)
  const original = structuredClone(rt.state.agents[entry.id])
  const bot = rt.state.bots[entry.sessions[0]]
  const save = rt.save
  rt.save = async options => {
    await ctx.dispose()
    return save(options)
  }
  await assert.rejects(rt.rollbackAdoption(entry.id), /host stopped/)
  assert.deepEqual(rt.state.agents[entry.id], original)
  assert.equal(rt.state.bots[bot.id], bot)
  assert.equal(rt.agentOf(bot.id), undefined)
  assert.equal(rt.selfOf(bot.id), bot.id)
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.deepEqual(saved.agents[entry.id], original)
  assert.deepEqual(saved.bots[bot.id], bot)
})

test('adoption refuses an original registration changed while its Session resolves', async (t) => {
  const { call, stop, ctx } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const entry = (await call('add-agent', { name: 'Native' })).value
  const rt = ctx.provided.get('omniTeam')
  const resolve = rt.resolveAgent
  rt.resolveAgent = async id => {
    const live = await resolve(id)
    delete rt.state.agents[entry.id]
    return live
  }
  assert.match((await call('agent-bot-adopt', { agentId: entry.id })).error.message, /changed during adoption/)
  assert.equal(rt.state.bots[entry.sessions[0]], undefined)
})

test('adopted preset backs new group/fresh Sessions and tasks; rollback refuses new team history', async (t) => {
  const { call, stop, ctx, created } = start(TEAM)
  t.after(stop)
  await call('state', {})
  ctx.provided.set('agentPresets', { serviceFor: () => undefined, list: async () => [{ id: 'standard' }, { id: 'cordis' }] })
  const rt = ctx.provided.get('omniTeam')
  const entry = (await call('add-agent', { name: 'Native', profile: 'cordis' })).value
  await call('agent-bot-adopt', { agentId: entry.id })
  const bot = rt.state.bots[entry.sessions[0]]
  await rt.createSession('Native · group', { profile: bot.profile })
  assert.equal(created.at(-1).agentPreset, 'cordis')
  await rt.startTask({ title: 'Native task', text: 'Do it', from: bot.id })
  assert.equal(created.at(-1).agentPreset, 'cordis')
  assert.match((await call('agent-bot-rollback', { agentId: entry.id })).error.message, /new team history/)
  assert.equal(rt.state.agents[entry.id].adoptedBotId, bot.id)
})

test('UI DSH creation adds native team membership usable by roster, messages, groups and browser', async (t) => {
  const { call, stop, ctx, created } = start(TEAM, { config: {
    browserPlugin: 'refs',
    browserPluginApi: { id: 'refs', tools: [{ name: 'browser_native_test', needsBrowser: false, execute: async () => 'native browser ready' }] },
  } })
  t.after(stop)
  await call('state', {})
  const rt = ctx.provided.get('omniTeam')
  const entry = (await call('add-agent', { name: 'Native newcomer', teamMember: true })).value
  const bot = rt.findBot('Native newcomer')
  assert.ok(bot)
  assert.equal(bot.kind, 'dsh')
  assert.equal(bot.pendingCreation, undefined)
  assert.equal(entry.pendingCreation, undefined)
  assert.equal(entry.adoptedBotId, bot.id)
  assert.equal(rt.selfOf(entry.sessions[0]), bot.id)
  assert.equal(created.length, 1)
  assert.deepEqual((await call('state', {})).value.agents, [])
  assert.match(await rt.teamTools.find(d => d.name === 'list_bots').execute({}, { agent: { id: 'm1' } }), /Native newcomer/)
  const delivered = []
  rt.deliver = async message => { delivered.push(message) }
  await rt.teamTools.find(d => d.name === 'message_bot').execute({ to: bot.name, message: 'Welcome' }, { agent: { id: 'm1' } })
  assert.equal(delivered[0].toId, bot.id)
  const room = await rt.createRoom({ members: ['m1', bot.id], name: 'Native team' })
  assert.ok(room.members.includes(bot.id))
  assert.equal(await rt.teamTools.find(d => d.name === 'browser_native_test').execute({}, { agent: { id: bot.id }, signal: new AbortController().signal }), 'native browser ready')
})

test('UI DSH creation fails without leaving a plain orphan if membership cannot be saved', async (t) => {
  const { call, stop, ctx, archived, home } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const rt = ctx.provided.get('omniTeam')
  const save = rt.save
  let failed = false
  rt.save = async options => {
    if (!failed && Object.values(rt.state.bots).some(bot => bot.kind === 'dsh')) {
      failed = true
      throw new Error('membership disk failure')
    }
    return save(options)
  }
  const result = await call('add-agent', { name: 'Native newcomer', teamMember: true })
  assert.equal(result.ok, false)
  assert.equal(result.error.message, 'Something went wrong (Error).')
  assert.equal(failed, true)
  assert.deepEqual(rt.state.agents, {})
  assert.equal(rt.findBot('Native newcomer'), undefined)
  assert.equal(archived.length, 1)
  assert.match(archived[0], /^session-/)
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.deepEqual(saved.agents, {})
  assert.equal(Object.values(saved.bots).some(bot => bot.name === 'Native newcomer'), false)
})

test('failed membership archive retains a pending owned Session and restart cleans it up', async (t) => {
  const first = start(TEAM)
  t.after(first.stop)
  await first.call('state', {})
  const rt = first.ctx.provided.get('omniTeam')
  const save = rt.save
  let failed = false
  rt.save = async options => {
    if (!failed && Object.values(rt.state.bots).some(bot => bot.kind === 'dsh')) {
      failed = true
      throw new Error('membership disk failure')
    }
    return save(options)
  }
  first.failArchive.on = true
  const result = await first.call('add-agent', { name: 'Pending newcomer', teamMember: true })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /membership disk failure/)
  assert.match(result.error.message, /session is running/)
  const [pending] = Object.values(rt.state.agents)
  assert.ok(pending)
  assert.equal(pending.pendingCreation, true)
  assert.equal(rt.agentOf(pending.sessions[0]), pending)
  assert.equal(rt.findBot('Pending newcomer'), undefined)
  assert.deepEqual(first.archived, [])
  const disk = JSON.parse(readFileSync(join(first.home, 'state.json'), 'utf8'))
  assert.deepEqual(disk.agents[pending.id], pending)
  // A later agent resolution must still receive the standalone restriction.
  const before = first.restricted.length
  first.createdAgents({ agent: { session: { id: pending.sessions[0] }, ctx: { effect: execute => execute(), tools: { restrict: filter => { first.restricted.push({ sessionId: pending.sessions[0], filter }); return () => {} } } } } })
  await rt.load()
  await flush()
  assert.ok(first.restricted.length > before)
  await first.ctx.dispose()
  const restarted = start(undefined, { home: first.home })
  t.after(restarted.stop)
  await restarted.call('state', {})
  const recovered = restarted.ctx.provided.get('omniTeam')
  assert.deepEqual(restarted.archived, [pending.sessions[0]])
  assert.deepEqual(recovered.state.agents, {})
  assert.deepEqual(JSON.parse(readFileSync(join(first.home, 'state.json'), 'utf8')).agents, {})
})

test('failed membership after real disposal keeps durable pending ownership until restart cleanup', async (t) => {
  const first = start(TEAM)
  t.after(first.stop)
  await first.call('state', {})
  const rt = first.ctx.provided.get('omniTeam')
  const resolve = rt.resolveAgent
  let resolutions = 0
  rt.resolveAgent = async id => {
    const live = await resolve(id)
    if (++resolutions === 2) await first.ctx.dispose()
    return live
  }
  const result = await first.call('add-agent', { name: 'Stopped newcomer', teamMember: true })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /host stopped/)
  const [pending] = Object.values(rt.state.agents)
  assert.ok(pending)
  assert.equal(pending.pendingCreation, true)
  assert.equal(rt.agentOf(pending.sessions[0]), pending)
  assert.deepEqual(first.archived, [])
  const disk = JSON.parse(readFileSync(join(first.home, 'state.json'), 'utf8'))
  assert.deepEqual(disk.agents[pending.id], pending)
  assert.equal(Object.values(disk.bots).some(bot => bot.kind === 'dsh'), false)
  const restarted = start(undefined, { home: first.home })
  t.after(restarted.stop)
  await restarted.call('state', {})
  assert.deepEqual(restarted.archived, [pending.sessions[0]])
  assert.deepEqual(restarted.ctx.provided.get('omniTeam').state.agents, {})
  assert.deepEqual(JSON.parse(readFileSync(join(first.home, 'state.json'), 'utf8')).agents, {})
})

test('disposal during allocation preserves the reserved Session for restart cleanup', async (t) => {
  const first = start(TEAM)
  t.after(first.stop)
  await first.call('state', {})
  const rt = first.ctx.provided.get('omniTeam')
  const create = first.ctx.sessionController.create
  first.ctx.sessionController.create = async options => {
    const created = await create(options)
    await first.ctx.dispose()
    return created
  }
  const result = await first.call('add-agent', { name: 'Allocation stop', teamMember: true })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /Cleanup pending.*host stopped/)
  const [pending] = Object.values(rt.state.agents)
  assert.equal(pending.pendingCreation, true)
  assert.equal(rt.agentOf(pending.sessions[0]), pending)
  assert.deepEqual(first.archived, [])
  assert.deepEqual(JSON.parse(readFileSync(join(first.home, 'state.json'), 'utf8')).agents[pending.id], pending)
  const restarted = start(undefined, { home: first.home })
  t.after(restarted.stop)
  await restarted.call('state', {})
  assert.deepEqual(restarted.archived, pending.sessions)
  assert.deepEqual(restarted.ctx.provided.get('omniTeam').state.agents, {})
})

test('writer loss preserves pending ownership and writer restoration retries cleanup', async (t) => {
  const first = start(TEAM)
  t.after(first.stop)
  await first.call('state', {})
  const rt = first.ctx.provided.get('omniTeam')
  const resolve = rt.resolveAgent
  let resolutions = 0
  rt.resolveAgent = async id => {
    const live = await resolve(id)
    if (++resolutions === 2) writeFileSync(join(first.home, 'state.lock'), JSON.stringify({ pid: process.pid, host: 'other-test-host', token: 'other-test-writer' }))
    return live
  }
  const result = await first.call('add-agent', { name: 'Lost writer', teamMember: true })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /Cleanup pending.*cannot save/)
  const [pending] = Object.values(rt.state.agents)
  assert.equal(pending.pendingCreation, true)
  assert.equal(rt.agentOf(pending.sessions[0]), pending)
  assert.deepEqual(first.archived, [])
  assert.deepEqual(rt.dshBots.list(), [])
  assert.deepEqual((await first.call('state', {})).value.agents, [])
  await assert.rejects(rt.adoptAsBot(pending.id), /another dsh|cleanup is pending/)
  // Only the test's own temporary foreign lock is removed to restore authority.
  rmSync(join(first.home, 'state.lock'))
  await rt.refresh()
  await rt.load()
  assert.deepEqual(first.archived, pending.sessions)
  assert.deepEqual(rt.state.agents, {})
  assert.deepEqual(JSON.parse(readFileSync(join(first.home, 'state.json'), 'utf8')).agents, {})
})

test('post-archive persistence failure retains intent and restart retries idempotently', async (t) => {
  const first = start(TEAM)
  t.after(first.stop)
  await first.call('state', {})
  const rt = first.ctx.provided.get('omniTeam')
  const save = rt.save
  let failed = false
  rt.save = async options => {
    if (!failed && Object.values(rt.state.bots).some(bot => bot.kind === 'dsh')) {
      failed = true
      throw new Error('membership disk failure')
    }
    if (first.archived.length > 0) throw new Error('cleanup disk failure')
    return save(options)
  }
  const result = await first.call('add-agent', { name: 'Archive saved first', teamMember: true })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /membership disk failure.*Cleanup pending.*cleanup disk failure/)
  const [pending] = Object.values(rt.state.agents)
  assert.equal(pending.pendingCreation, true)
  assert.deepEqual(first.archived, pending.sessions)
  assert.deepEqual(JSON.parse(readFileSync(join(first.home, 'state.json'), 'utf8')).agents[pending.id], pending)
  await first.ctx.dispose()
  const restarted = start(undefined, { home: first.home })
  t.after(restarted.stop)
  // Match DSH's real archive contract: an already archived identity succeeds.
  restarted.ctx.workspaceRegistry.archiveSession = async id => { assert.ok(first.archived.includes(id)) }
  await restarted.call('state', {})
  assert.deepEqual(restarted.ctx.provided.get('omniTeam').state.agents, {})
  assert.deepEqual(JSON.parse(readFileSync(join(first.home, 'state.json'), 'utf8')).agents, {})
})

test('unallocated reservation cleanup accepts only a matching native unknown-session error', async (t) => {
  for (const matching of [true, false]) {
    const first = start(TEAM)
    t.after(first.stop)
    await first.call('state', {})
    const rt = first.ctx.provided.get('omniTeam')
    first.ctx.sessionController.create = async () => { throw new Error('allocation refused') }
    first.ctx.workspaceRegistry.archiveSession = async sessionId => {
      const error = new Error('session is unknown')
      error.name = 'WorkspaceUnknownSessionError'
      error.sessionId = matching ? sessionId : 'unrelated'
      throw error
    }
    const result = await first.call('add-agent', { name: 'Never allocated', teamMember: true })
    assert.equal(result.ok, false)
    if (matching) {
      // Nothing cleaned up after the raw allocation failure, so its message is hidden.
      assert.equal(result.error.message, 'Something went wrong (Error).')
      assert.doesNotMatch(result.error.message, /Cleanup pending/)
      assert.deepEqual(rt.state.agents, {})
      assert.deepEqual(JSON.parse(readFileSync(join(first.home, 'state.json'), 'utf8')).agents, {})
    } else {
      assert.match(result.error.message, /Cleanup pending.*session is unknown/)
      assert.equal(Object.values(rt.state.agents)[0].pendingCreation, true)
    }
  }
})

// Native allocation is shared by both temporary runtimes, but its promise may
// remain pending after the Session becomes known. No real service is started.
async function overlapCreation(t, { disposed = false, reject = false, known = false, different = false, stale = false, claimed = false } = {}) {
  const first = start(TEAM)
  let next, release, operation
  t.after(async () => { release?.(); await operation; if (next) await next.stop(); await first.stop() })
  await first.call('state', {})
  const rt = first.ctx.provided.get('omniTeam')
  let enter
  const entered = new Promise(resolve => { enter = resolve })
  const gate = new Promise(resolve => { release = resolve })
  t.after(() => release())
  let allocated = false, reserved, actual
  first.ctx.sessionController.create = async options => {
    reserved = options.sessionId
    actual = different ? 'native-different-session' : reserved
    allocated = known
    enter()
    await gate
    if (reject) throw new Error('native allocation rejected')
    allocated = true
    return { sessionId: actual }
  }
  operation = first.call('add-agent', { name: 'Overlapping newcomer', teamMember: true })
  await entered
  if (disposed) await first.ctx.dispose()
  else rmSync(join(first.home, 'state.lock'))
  next = start(undefined, { home: first.home })
  next.ctx.workspaceRegistry.archiveSession = async id => {
    if (!allocated || id !== actual) {
      const error = new Error('native Session is absent')
      error.name = 'WorkspaceUnknownSessionError'
      error.sessionId = id
      throw error
    }
    next.archived.push(id)
  }
  await next.call('state', {})
  const successor = next.ctx.provided.get('omniTeam')
  assert.equal(Object.values(successor.state.agents)[0]?.pendingCreation, true, 'an unfinished producer must retain durable ownership even when absent')
  assert.deepEqual(next.archived, [], 'known Session must not archive before native create fully settles')
  const lock = JSON.parse(readFileSync(join(first.home, 'state.lock'), 'utf8'))
  writeFileSync(join(first.home, 'state.lock'), JSON.stringify({ ...lock, host: 'other-test-host' }))
  if (claimed) {
    const save = successor.save
    let failed = false
    successor.save = async options => {
      if (!failed && next.archived.length > 0 && Object.keys(successor.state.agents).length === 0) {
        failed = true
        throw new Error('successor post-archive save failed')
      }
      return save(options)
    }
  }
  if (stale) {
    // The successor consumes the terminal receipt while the old producer enters
    // its canonical refresh, then releases authority. The old producer must not
    // resurrect or adopt the now-cleaned operation after reclaiming the lock.
    const refresh = rt.refresh
    rt.refresh = async () => {
      await successor.refresh()
      await next.ctx.dispose()
      return refresh()
    }
  }
  release()
  const result = await operation
  assert.equal(result.ok, false)
  if (!stale) await successor.refresh()
  if (claimed) {
    assert.equal(Object.values(successor.state.agents)[0]?.creationCleanup, true)
    assert.deepEqual(rt.state.agents, {})
    assert.deepEqual(first.archived, [actual])
  } else assert.deepEqual(successor.state.agents, {})
  assert.deepEqual(next.archived, reject ? [] : [actual])
  const saved = JSON.parse(readFileSync(join(first.home, 'state.json'), 'utf8'))
  assert.deepEqual(saved.agents, {})
  assert.equal(Object.values(saved.bots).some(bot => bot.name === 'Overlapping newcomer'), false)
}

test('terminal receipt protects takeover before late native allocation succeeds', async t => overlapCreation(t))
test('terminal receipt protects takeover before late native allocation rejects', async t => overlapCreation(t, { reject: true }))
test('terminal receipt protects real disposal overlapping late allocation', async t => overlapCreation(t, { disposed: true }))
test('terminal receipt waits for known Session native creation tail', async t => overlapCreation(t, { known: true }))
test('terminal receipt recovers a returned identity different from its reservation', async t => overlapCreation(t, { different: true }))
test('terminal receipt prevents a stale producer from resurrecting consumed creation', async t => overlapCreation(t, { stale: true }))
test('terminal receipt cleanup claim prevents readoption after successor post-archive save failure', async t => overlapCreation(t, { stale: true, claimed: true }))

test('terminal receipt publication failure fails closed and remains explicitly pending', async (t) => {
  const first = start(TEAM)
  t.after(first.stop)
  await first.call('state', {})
  writeFileSync(join(first.home, 'agent-creations'), 'not a directory')
  const result = await first.call('add-agent', { name: 'Receipt unavailable', teamMember: true })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /receipt|ENOTDIR|EEXIST/)
  assert.match(result.error.message, /Cleanup pending/)
  assert.equal(Object.values(first.ctx.provided.get('omniTeam').state.agents)[0]?.pendingCreation, true)
  assert.deepEqual(first.archived, [])
})

test('terminal receipt mismatch or malformed data cannot authorize cleanup', async (t) => {
  for (const contents of ['{', JSON.stringify({ version: 1, token: 'unrelated', agentId: 'unrelated', reservedSessionId: 'unrelated', outcome: 'created', sessionId: 'm1' })]) {
    const first = start(TEAM)
    t.after(first.stop)
    await first.call('state', {})
    first.failArchive.on = true
    const rt = first.ctx.provided.get('omniTeam')
    const save = rt.save
    let failed = false
    rt.save = async options => {
      if (!failed && Object.values(rt.state.bots).some(bot => bot.kind === 'dsh')) {
        failed = true
        throw new Error('membership refused')
      }
      return save(options)
    }
    await first.call('add-agent', { name: 'Invalid receipt', teamMember: true })
    const [pending] = Object.values(rt.state.agents)
    assert.ok(pending.creationToken)
    const path = join(first.home, 'agent-creations', `${pending.creationToken}.json`)
    const valid = readFileSync(path, 'utf8')
    writeFileSync(path, contents)
    first.failArchive.on = false
    await rt.refresh()
    assert.equal(rt.state.agents[pending.id], pending)
    assert.deepEqual(first.archived, [])
    writeFileSync(path, valid)
    await rt.refresh()
    assert.deepEqual(rt.state.agents, {})
    assert.deepEqual(first.archived, pending.sessions)
  }
})

test('terminal receipt unlink failure cannot turn durable membership into failed creation', async (t) => {
  const first = start(TEAM)
  t.after(first.stop)
  await first.call('state', {})
  const rt = first.ctx.provided.get('omniTeam')
  const save = rt.save
  let receiptPath, replaced = false
  rt.save = async options => {
    const pending = Object.values(rt.state.agents).find(agent => agent.pendingCreation === true)
    if (typeof pending?.creationToken === 'string') receiptPath = join(first.home, 'agent-creations', `${pending.creationToken}.json`)
    const result = await save(options)
    if (!replaced && receiptPath !== undefined && rt.findBot('Durable member') !== undefined) {
      replaced = true
      assert.ok(receiptPath.startsWith(`${first.home}/agent-creations/`))
      rmSync(receiptPath)
      mkdirSync(receiptPath)
    }
    return result
  }
  const result = await first.call('add-agent', { name: 'Durable member', teamMember: true })
  assert.equal(result.ok, true)
  assert.equal(replaced, true)
  assert.ok(rt.findBot('Durable member'))
  for (const key of ['pendingCreation', 'creationToken', 'creationSessionId', 'creationCleanup']) {
    assert.equal(result.value[key], undefined)
    assert.equal(rt.findBot('Durable member')[key], undefined)
  }
  assert.deepEqual(first.archived, [])
})

test('terminal receipt cannot associate or archive another team identity', async (t) => {
  const first = start(TEAM)
  t.after(first.stop)
  await first.call('state', {})
  first.ctx.sessionController.create = async () => ({ sessionId: 'm1' })
  const result = await first.call('add-agent', { name: 'Identity collision', teamMember: true })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /already belongs to another team identity/)
  assert.deepEqual(first.archived, [])
  const rt = first.ctx.provided.get('omniTeam')
  assert.equal(rt.state.bots.m1.name, 'Omni')
  assert.equal(Object.values(rt.state.agents)[0].pendingCreation, true)
})

test('terminal failed receipt preserves structured native allocated identity', async (t) => {
  const first = start(TEAM)
  t.after(first.stop)
  await first.call('state', {})
  first.ctx.sessionController.create = async () => {
    const error = new Error('workspace attach failed')
    error.code = 'session/workspace-attach-failed'
    error.details = { sessionId: 'native-allocated-before-attach-failed' }
    throw error
  }
  const result = await first.call('add-agent', { name: 'Native attach failure', teamMember: true })
  assert.equal(result.ok, false)
  assert.equal(result.error.message, 'Something went wrong (session/workspace-attach-failed).')
  assert.deepEqual(first.archived, ['native-allocated-before-attach-failed'])
  assert.deepEqual(first.ctx.provided.get('omniTeam').state.agents, {})
})

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 2,
  bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Omni', role: 'Channel orchestrator', instructions: '', createdAt: 1 } },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

test('add-agent creates a DSH bot with a first Session in the Omni workspace', async (t) => {
  const { call, stop, created } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const agent = (await call('add-agent', { name: 'Notes' })).value
  assert.equal(agent.name, 'Notes')
  assert.equal(agent.sessions.length, 1)
  const view = (await call('state', {})).value
  assert.deepEqual(view.agents.map(entry => entry.id), [agent.id])
  // The Session was created in the workspace the Bots live in.
  const workspaceId = view.workspaceId
  assert.equal(created.at(-1).workspaceId, workspaceId)
})

test('DSH bots: several, each in its own folder with its own preset, listed for other plugins', async (t) => {
  const { call, stop, created, ctx, renamed } = start(TEAM)
  t.after(stop)
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'ds-bot-project-')))
  t.after(() => rmSync(project, { recursive: true, force: true }))
  await call('state', {})
  ctx.provided.set('agentPresets', { list: async () => [{ id: 'standard', name: 'Standard' }, { id: 'cordis', name: 'Creator' }, { id: 'broken', broken: 'no tools' }] })
  assert.deepEqual((await call('agent-presets')).value.map(preset => preset.id), ['standard', 'cordis'])
  const rt = ctx.provided.get('omniTeam')
  const changes = []
  rt.dshBots.onChange(list => changes.push(list.map(bot => bot.name)))
  const site = (await call('add-agent', { name: 'Site', workDir: project, profile: 'cordis' })).value
  assert.deepEqual(created.at(-1), { cwd: project, agentPreset: 'cordis' })
  const scratch = (await call('add-agent', { name: 'Scratch' })).value
  assert.deepEqual(Object.keys(created.at(-1)), ['workspaceId'])
  assert.equal((await call('add-agent', { name: 'site' })).error.message, 'A DSH bot named site already exists')
  assert.equal((await call('add-agent', { name: 'Odd', profile: 'broken' })).error.message, 'The preset broken is not available in this DSH')
  // A task is not a DSH bot: it never shows in the list.
  await rt.startTask({ title: 'Wish', text: 'Do it', from: 'm1' })
  assert.deepEqual(rt.dshBots.list(), [
    { id: site.id, name: 'Site', workDir: project, profile: 'cordis' },
    { id: scratch.id, name: 'Scratch', workDir: null, profile: null },
  ])
  // Settings apply to the Sessions made after them.
  await call('update-agent', { agentId: scratch.id, name: 'Scratch', workDir: project, profile: 'standard' })
  const { sessionId } = await rt.dshBots.createSession(scratch.id, { title: 'Fix the build', firstMessage: 'Run the tests' })
  assert.deepEqual(created.at(-1), { cwd: project, agentPreset: 'standard' })
  assert.deepEqual(renamed.at(-1), { id: sessionId, title: 'Fix the build' })
  assert.deepEqual(changes, [['Site'], ['Site', 'Scratch'], ['Site', 'Scratch']])
  await assert.rejects(rt.dshBots.createSession(rt.agentOf(Object.keys(rt.state.tasks)[0]).id, {}), /Unknown DSH bot/)
})

test('the single DSH Agent of an older team becomes a DSH bot and the tasks record', async (t) => {
  const team = {
    ...TEAM,
    agents: { old: { id: 'old', name: 'Tasks', sessions: ['mine', 'handed', 'run'], createdAt: 5 } },
    tasks: { handed: { title: 'Wish', from: 'm1', at: 6, status: 'done' } },
    subscriptionRuns: [{ id: 'r', sessionId: 'run', task: 'Check', status: 'done' }],
  }
  const { call, stop, ctx, home } = start(team)
  t.after(stop)
  const view = (await call('state', {})).value
  assert.deepEqual(view.agents.map(agent => [agent.id, agent.kind, agent.sessions]), [['old', 'dsh', ['mine']], ['old:tasks', 'tasks', ['handed', 'run']]])
  assert.deepEqual(ctx.provided.get('omniTeam').dshBots.list().map(bot => bot.name), ['Tasks'])
  assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).agents.old.kind, 'dsh')
})

test('agent-session appends Sessions; agent-archive removes one and archives it', async (t) => {
  const { call, stop, archived } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const agent = (await call('add-agent', { name: 'Notes' })).value
  const second = (await call('agent-session', { agentId: agent.id })).value
  assert.equal((await call('state', {})).value.agents[0].sessions.length, 2)
  assert.equal((await call('agent-archive', { agentId: agent.id, sessionId: second.sessionId })).ok, true)
  const view = (await call('state', {})).value
  assert.deepEqual(view.agents[0].sessions, agent.sessions)
  assert.deepEqual(archived, [second.sessionId])
})

test('a failed archive keeps the Session in the DSH bot and answers with the error', async (t) => {
  const { call, stop, archived, failArchive } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const agent = (await call('add-agent', { name: 'Notes' })).value
  const second = (await call('agent-session', { agentId: agent.id })).value
  failArchive.on = true
  const failed = await call('agent-archive', { agentId: agent.id, sessionId: second.sessionId })
  assert.equal(failed.ok, false)
  // The Session stays with the Agent, so the restriction and the retry stay.
  assert.deepEqual((await call('state', {})).value.agents[0].sessions, [agent.sessions[0], second.sessionId])
  assert.deepEqual(archived, [])
  failArchive.on = false
  assert.equal((await call('agent-archive', { agentId: agent.id, sessionId: second.sessionId })).ok, true)
})

test('agent-rename retitles an owned Session and refuses others', async (t) => {
  const { call, stop, renamed } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const agent = (await call('add-agent', { name: 'Notes' })).value
  assert.equal((await call('agent-rename', { agentId: agent.id, sessionId: agent.sessions[0], title: '  Scratch  ' })).ok, true)
  assert.deepEqual(renamed.at(-1), { id: agent.sessions[0], title: 'Scratch' })
  assert.equal((await call('agent-rename', { agentId: agent.id, sessionId: agent.sessions[0], title: '   ' })).ok, false)
  // A Bot's Session cannot be renamed through the agent endpoint.
  assert.equal((await call('agent-rename', { agentId: agent.id, sessionId: 'm1', title: 'x' })).ok, false)
})

test('remove-agent keeps the DSH bot with the Sessions it could not archive', async (t) => {
  const { call, stop, archived, failArchive } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const agent = (await call('add-agent', { name: 'Notes' })).value
  const second = (await call('agent-session', { agentId: agent.id })).value
  failArchive.on = true
  const failed = await call('remove-agent', { agentId: agent.id })
  assert.equal(failed.ok, false)
  // Nothing archived, so the Agent stays whole; the retry then removes it.
  assert.deepEqual((await call('state', {})).value.agents[0].sessions, [agent.sessions[0], second.sessionId])
  assert.deepEqual(archived, [])
  failArchive.on = false
  assert.equal((await call('remove-agent', { agentId: agent.id })).ok, true)
  assert.equal((await call('state', {})).value.agents.length, 0)
})

test('remove-agent archives every Session and drops the record', async (t) => {
  const { call, stop, archived } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const agent = (await call('add-agent', { name: 'Notes' })).value
  const second = (await call('agent-session', { agentId: agent.id })).value
  assert.equal((await call('remove-agent', { agentId: agent.id })).ok, true)
  assert.deepEqual((await call('state', {})).value.agents, [])
  assert.deepEqual([...archived].sort(), [agent.sessions[0], second.sessionId].sort())
})

test('remove-agent drops missing Session references and still archives the remaining Sessions', async (t) => {
  const { call, stop, ctx, archived, home } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const agent = (await call('add-agent', { name: 'Notes' })).value
  const second = (await call('agent-session', { agentId: agent.id })).value
  const missing = agent.sessions[0]
  const archive = ctx.workspaceRegistry.archiveSession
  ctx.workspaceRegistry.archiveSession = async sessionId => {
    if (sessionId === missing) throw Object.assign(new Error('Session is gone'), { name: 'WorkspaceUnknownSessionError', sessionId })
    await archive(sessionId)
  }
  assert.equal((await call('remove-agent', { agentId: agent.id })).ok, true)
  assert.deepEqual(archived, [second.sessionId])
  assert.deepEqual((await call('state', {})).value.agents, [])
  assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).agents[agent.id], undefined)
})

test('agent-archive drops an owned reference when DSH confirms that Session no longer exists', async (t) => {
  const { call, stop, ctx } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const agent = (await call('add-agent', { name: 'Notes' })).value
  ctx.workspaceRegistry.archiveSession = async sessionId => {
    throw Object.assign(new Error('Session is gone'), { name: 'WorkspaceUnknownSessionError', sessionId })
  }
  assert.equal((await call('agent-archive', { agentId: agent.id, sessionId: agent.sessions[0] })).ok, true)
  assert.deepEqual((await call('state', {})).value.agents[0].sessions, [])
})

test('missing Sessions do not mask archive failures or unknown errors for a different Session', async (t) => {
  for (const failure of [
    new Error('storage unavailable'),
    Object.assign(new Error('Session is active'), { name: 'WorkspaceActiveSessionError' }),
    Object.assign(new Error('another Session is gone'), { name: 'WorkspaceUnknownSessionError', sessionId: 'another' }),
  ]) {
    await t.test(failure.message, async (t) => {
      const { call, stop, ctx } = start(TEAM)
      t.after(stop)
      await call('state', {})
      const agent = (await call('add-agent', { name: 'Notes' })).value
      const second = (await call('agent-session', { agentId: agent.id })).value
      ctx.workspaceRegistry.archiveSession = async sessionId => {
        if (sessionId === agent.sessions[0]) throw Object.assign(new Error('Session is gone'), { name: 'WorkspaceUnknownSessionError', sessionId })
        throw failure
      }
      assert.equal((await call('remove-agent', { agentId: agent.id })).ok, false)
      assert.deepEqual((await call('state', {})).value.agents[0].sessions, [second.sessionId])
      assert.equal((await call('agent-archive', { agentId: agent.id, sessionId: second.sessionId })).ok, false)
      assert.deepEqual((await call('state', {})).value.agents[0].sessions, [second.sessionId])
      ctx.workspaceRegistry.archiveSession = async () => {}
      assert.equal((await call('remove-agent', { agentId: agent.id })).ok, true)
      assert.deepEqual((await call('state', {})).value.agents, [])
    })
  }
})

test('a corrupt agents field resets instead of crashing the view', async (t) => {
  const { call, stop } = start({ ...TEAM, agents: 'junk' })
  t.after(stop)
  const view = (await call('state', {})).value
  assert.deepEqual(view.agents, [])
})

// The Omni channels and canvas plugins register these for the team; TEAM_TOOLS names them
// too, so a DSH Agent's Sessions never get them. The canvas plugin's tests check the whole
// list with all three installed.
const CHANNEL_TOOLS = ['find_chats', 'list_automations', 'save_automation', 'pause_automation', 'delete_automation', 'omni_endpoints', 'omni_call', 'omni_channels', 'omni_chats', 'omni_messages', 'omni_send', 'omni_react', 'omni_media', 'omni_delete', 'omni_connect', 'show_canvas']

test('TEAM_TOOLS names exactly the tools ds-bot registers, and those of the other Omni plugins', async (t) => {
  // read_browser registers only in the Desktop profile; the flag stands in for it.
  const { stop, ctx } = start(TEAM, { config: { browser: true } })
  t.after(stop)
  const browser = name => name.startsWith('browser_')
  // The team's own tools, and the ones still registered for every Session (start_task).
  const named = new Set([...rt.teamTools.map(d => d.name), ...ctx.registeredTools.keys()])
  assert.deepEqual([...named].filter(name => !browser(name)).sort(), TEAM_TOOLS.filter(name => !CHANNEL_TOOLS.includes(name)).sort())
  for (const name of CHANNEL_TOOLS) assert.ok(TEAM_TOOLS.includes(name), name)
})

test('agent-session honors a known workspace and falls back to the team workspace', async (t) => {
  const { call, stop, created, ctx } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const agent = (await call('add-agent', { name: 'Notes' })).value
  // An unknown workspace id falls back; a real one is used as given.
  await call('agent-session', { agentId: agent.id, workspaceId: 'nope' })
  assert.equal(created.at(-1).workspaceId, (await call('state', {})).value.workspaceId)
  const other = await ctx.workspaceRegistry.create('/tmp/elsewhere')
  await call('agent-session', { agentId: agent.id, workspaceId: other.id })
  assert.equal(created.at(-1).workspaceId, other.id)
})

test('agent-adopt takes an unowned Session and refuses team-owned ones', async (t) => {
  const { call, stop, restricted, scoped } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const agent = (await call('add-agent', { name: 'Notes' })).value
  // A plain root Session (the workspace picker's blank, or a fork) joins the Agent.
  const adopted = (await call('agent-adopt', { agentId: agent.id, sessionId: 'fresh' })).value
  assert.equal(adopted.sessionId, 'fresh')
  assert.deepEqual((await call('state', {})).value.agents[0].sessions, [...agent.sessions, 'fresh'])
  // It gets the mask for the tools every Session is offered, and no team tool of its own.
  assert.equal(restricted.at(-1).sessionId, 'fresh')
  assert.equal(scoped.some(entry => entry.sessionId === 'fresh'), false)
  // Adopting again is a no-op.
  assert.equal((await call('agent-adopt', { agentId: agent.id, sessionId: 'fresh' })).ok, true)
  // A Bot's Session and an unknown Agent are refused.
  assert.equal((await call('agent-adopt', { agentId: agent.id, sessionId: 'm1' })).ok, false)
  assert.equal((await call('agent-adopt', { agentId: 'none', sessionId: 'fresh2' })).error.message, 'Unknown DSH bot')
})

test('a Bot Session gets the team tools in its own scope; a DSH Agent Session gets none', async (t) => {
  const { call, stop, restricted, scoped, createdAgents } = start(TEAM)
  t.after(stop)
  await call('state', {})
  // A Bot resolving its agent gets every team tool scoped to it and no mask.
  createdAgents({
    agent: {
      session: { id: 'm1' },
      ctx: {
        tools: {
          register: tool => { scoped.push({ sessionId: 'm1', name: tool.name }) },
          restrict: filter => { restricted.push({ sessionId: 'm1', filter }) },
        },
        effect: execute => execute(),
      },
    },
  })
  await flush()
  // Every tool the team defines itself; the channel tools and start_task are registered for
  // every Session, and read_browser only in the Desktop profile.
  const own = name => !CHANNEL_TOOLS.includes(name) && !['start_task', 'read_browser'].includes(name)
  assert.deepEqual(scoped.filter(entry => entry.sessionId === 'm1').map(entry => entry.name).filter(name => !name.startsWith('browser_')).sort(),
    TEAM_TOOLS.filter(own).sort())
  assert.equal(restricted.length, 0)
  // A DSH bot Session gets no team tool in its scope, and the mask for the ones every
  // Session is offered (start_task, the channel tools).
  const agent = (await call('add-agent', { name: 'Notes' })).value
  assert.equal(restricted.length, 1)
  assert.equal(restricted[0].sessionId, agent.sessions[0])
  assert.deepEqual([...restricted[0].filter.deny].sort(), [...TEAM_TOOLS].sort())
  createdAgents({
    agent: {
      session: { id: agent.sessions[0] },
      ctx: {
        tools: {
          register: tool => { scoped.push({ sessionId: agent.sessions[0], name: tool.name }) },
          restrict: filter => { restricted.push({ sessionId: agent.sessions[0], filter }) },
        },
        effect: execute => execute(),
      },
    },
  })
  await flush()
  assert.equal(restricted.every(entry => entry.sessionId === agent.sessions[0]), true)
  assert.equal(scoped.some(entry => entry.sessionId === agent.sessions[0]), false)
})

test('a task started with a folder of its own runs there, with a preset this DSH serves', async (t) => {
  const { call, stop, created, home, ctx } = start(TEAM)
  t.after(stop)
  await call('state', {})
  ctx.provided.set('agentPresets', { list: async () => [{ id: 'standard' }, { id: 'broken', broken: 'no tools' }] })
  const rt = ctx.provided.get('omniTeam')
  await rt.startTask({ title: 'Wish', text: 'Do it', from: 'm1', cwd: home, agentPreset: 'standard' })
  assert.deepEqual(created.at(-1), { cwd: home, agentPreset: 'standard' })
  // A path that is not a folder, or a preset DSH does not serve unbroken, falls back.
  await rt.startTask({ title: 'Wish 2', text: 'Do it', from: 'm1', cwd: join(home, 'missing'), agentPreset: 'broken' })
  assert.deepEqual(Object.keys(created.at(-1)), ['workspaceId'])
  await rt.startTask({ title: 'Wish 3', text: 'Do it', from: 'm1', cwd: 'relative/path' })
  assert.deepEqual(Object.keys(created.at(-1)), ['workspaceId'])
  const view = (await call('state', {})).value
  assert.equal(Object.values(view.tasks).filter(task => task.status === 'working').length, 3)
})

test('a task thinks with the model of the Bot that asked, chosen before its first message', async (t) => {
  const team = { ...TEAM, bots: { m1: { ...TEAM.bots.m1, model: 'keyed/flash' } } }
  const { call, stop, ctx } = start(team)
  t.after(stop)
  // Only the Bot's own provider is served: DSH's default route would have no key here.
  ctx.llm = { listProviders: () => [{ id: 'keyed' }], listModels: async () => [{ id: 'flash' }] }
  await call('state', {})
  const steps = []
  ctx.sessionController.selectModel = async ({ sessionId, provider, model }) => { steps.push(['model', sessionId, `${provider}/${model}`]) }
  const resolve = ctx.sessionController.resolveAgent
  ctx.sessionController.resolveAgent = async (sessionId) => {
    const { agent } = await resolve(sessionId)
    return { agent: { ...agent, followup: () => steps.push(['message', sessionId]) } }
  }
  const rt = ctx.provided.get('omniTeam')
  const sessionId = await rt.startTask({ title: 'Wish', text: 'Do it', from: 'm1' })
  assert.deepEqual(steps.filter(step => step[1] === sessionId), [['model', sessionId, 'keyed/flash'], ['message', sessionId]])
  // A task no Bot asked for keeps DSH's default.
  const plain = await rt.startTask({ title: 'Chore', text: 'Do it' })
  assert.deepEqual(steps.filter(step => step[1] === plain), [['message', plain]])
})

test('a task that ends on an error is failed with its reason; one stopped is stopped, not done', async (t) => {
  const { call, stop, ctx } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const rt = ctx.provided.get('omniTeam')
  const reports = []
  rt.deliver = async message => { reports.push(message) }
  const end = (sessionId, reason) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) listener({ id: sessionId }, { type: 'turn/end', data: { turn: 1, reason } })
  }
  const failed = await rt.startTask({ title: 'Wish', text: 'Do it', from: 'm1' })
  end(failed, { kind: 'error', error: { message: 'the provider refused the key', code: 'AUTH' } })
  const stopped = await rt.startTask({ title: 'Wish 2', text: 'Do it', from: 'm1' })
  end(stopped, { kind: 'aborted', reason: { kind: 'user' } })
  await flush()
  const { tasks } = (await call('state', {})).value
  assert.deepEqual([tasks[failed].status, tasks[failed].summary], ['failed', 'the provider refused the key'])
  assert.equal(tasks[stopped].status, 'stopped')
  assert.deepEqual(reports.map(report => [report.taskSessionId, report.text]), [
    [failed, 'It failed: the provider refused the key'],
    [stopped, 'It was stopped before it finished.'],
  ])
})

// #164: 60 ended tasks, as a team that has run many, and one more record of the caller's.
const endedTasks = count => Object.fromEntries(Array.from({ length: count }, (_, i) => [`d${i}`, { title: `Done ${i}`, from: 'm1', at: 10 + i, status: 'done', endedAt: 10 + i }]))

test('the task cap never forgets a wish still working, so its stop is still written down', async (t) => {
  // The wish started before the 60 others and is still at work when the next task starts.
  const tasks = { wish: { title: 'Wish: Fix Claude wish permission denial reporting', from: 'm1', at: 1, status: 'working' }, ...endedTasks(60) }
  const { call, stop, ctx } = start({ ...TEAM, tasks })
  t.after(stop)
  await call('state', {})
  const rt = ctx.provided.get('omniTeam')
  rt.deliver = async () => {}
  await rt.startTask({ title: 'Next', text: 'Do it', from: 'm1' })
  // The ended task that ended longest ago is the one forgotten; the count stays at 60.
  assert.equal(rt.state.tasks.wish?.status, 'working')
  assert.equal(rt.state.tasks.d0, undefined)
  assert.equal(Object.keys(rt.state.tasks).length, 60)
  // The user stops the wish: its record says so, for the Live rail and its Bot's chat.
  for (const listener of ctx.listeners.get('session/event') ?? []) listener({ id: 'wish' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } })
  await flush()
  const { tasks: view } = (await call('state', {})).value
  assert.equal(view.wish.status, 'stopped')
  assert.equal(typeof view.wish.endedAt, 'number')
})

test('the task cap forgets the task that ended longest ago, not the one started first', async (t) => {
  // A long wish started first and was stopped a moment ago: the freshest end of all.
  const tasks = { long: { title: 'Wish: a long one', from: 'm1', at: 1, status: 'stopped', endedAt: Date.now() }, ...endedTasks(60) }
  const { call, stop, ctx } = start({ ...TEAM, tasks })
  t.after(stop)
  await call('state', {})
  const rt = ctx.provided.get('omniTeam')
  await rt.startTask({ title: 'Next', text: 'Do it', from: 'm1' })
  assert.equal(rt.state.tasks.long?.status, 'stopped')
  assert.equal(rt.state.tasks.d0, undefined)
  assert.equal(Object.keys(rt.state.tasks).length, 60)
})

test('the task cap never forgets a working task, even with no ended record to drop', async (t) => {
  // A full list of working records does not push the oldest out: its record is the lineage
  // the tool deny guard and the permission re-apply resolve (#584, L4). The cap gives way.
  const tasks = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`w${i}`, { title: `Stuck ${i}`, from: 'm1', at: 10 + i, status: 'working' }]))
  const { call, stop, ctx } = start({ ...TEAM, tasks })
  t.after(stop)
  await call('state', {})
  const rt = ctx.provided.get('omniTeam')
  const next = await rt.startTask({ title: 'Next', text: 'Do it', from: 'm1' })
  assert.equal(Object.keys(rt.state.tasks).length, 61)
  assert.equal(rt.state.tasks.w0?.status, 'working')
  assert.equal(rt.state.tasks[next]?.status, 'working')
})

test('a task started in a group reports back to that group, not the Bot\'s own chat', async (t) => {
  const team = {
    ...TEAM,
    rooms: { r1: { id: 'r1', name: 'Demo', members: ['m1'], admin: 'm1', mode: 'admin', notice: '', createdAt: 2, createdBy: null, sessions: { m1: 'g1' } } },
  }
  const { call, stop, ctx } = start(team)
  t.after(stop)
  await call('state', {})
  const rt = ctx.provided.get('omniTeam')
  const reports = []
  rt.deliver = async message => { reports.push(message) }
  const end = (sessionId) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) listener({ id: sessionId }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  }
  // The tool is called from the Bot's Session in the group, which is what start_task sees.
  const said = await ctx.registeredTools.get('start_task').execute({ title: 'Clone it', instructions: 'Clone the repo' }, { agent: { id: 'g1' } })
  assert.match(said, /^Started task "Clone it"/)
  const [inGroup] = Object.keys((await call('state', {})).value.tasks)
  end(inGroup)
  // A task from the Bot's own chat keeps going to its own chat.
  await ctx.registeredTools.get('start_task').execute({ title: 'Private', instructions: 'Do it' }, { agent: { id: 'm1' } })
  const own = Object.keys((await call('state', {})).value.tasks).find(id => id !== inGroup)
  end(own)
  await flush()
  assert.deepEqual(reports.map(report => [report.taskSessionId, report.sessionId, report.roomId]), [
    [inGroup, 'g1', 'r1'],
    [own, undefined, undefined],
  ])
})

// #164, the cap's boundary: exactly TASK_CAP records are kept; a start past it forgets as
// many records as the overflow, never a working one while an ended one is there to go.
const TASK_CAP = 60

test('the task cap forgets nothing at exactly 60 tasks', async (t) => {
  const { call, stop, ctx } = start({ ...TEAM, tasks: endedTasks(TASK_CAP - 1) })
  t.after(stop)
  await call('state', {})
  const rt = ctx.provided.get('omniTeam')
  const next = await rt.startTask({ title: 'Next', text: 'Do it', from: 'm1' })
  assert.equal(Object.keys(rt.state.tasks).length, TASK_CAP)
  for (let index = 0; index < TASK_CAP - 1; index += 1) assert.ok(rt.state.tasks[`d${index}`], `d${index} is kept`)
  assert.equal(rt.state.tasks[next].status, 'working')
})

test('the 61st task evicts exactly one record, the ended task that ended longest ago', async (t) => {
  const { call, stop, ctx } = start({ ...TEAM, tasks: endedTasks(TASK_CAP) })
  t.after(stop)
  await call('state', {})
  const rt = ctx.provided.get('omniTeam')
  const seeded = Object.keys(rt.state.tasks)
  const next = await rt.startTask({ title: 'Next', text: 'Do it', from: 'm1' })
  assert.equal(Object.keys(rt.state.tasks).length, TASK_CAP)
  assert.deepEqual(seeded.filter(id => rt.state.tasks[id] === undefined), ['d0'])
  assert.equal(rt.state.tasks[next].status, 'working')
})

test('a working wish older than 59 ended tasks keeps its record at the 61st start', async (t) => {
  const tasks = { wish: { title: 'Wish: still at work', from: 'm1', at: 1, status: 'working' }, ...endedTasks(TASK_CAP - 1) }
  const { call, stop, ctx } = start({ ...TEAM, tasks })
  t.after(stop)
  await call('state', {})
  const rt = ctx.provided.get('omniTeam')
  await rt.startTask({ title: 'Next', text: 'Do it', from: 'm1' })
  assert.equal(rt.state.tasks.wish?.status, 'working')
  assert.equal(rt.state.tasks.d0, undefined)
  assert.equal(Object.keys(rt.state.tasks).length, TASK_CAP)
})

test('ended tasks are forgotten before any working one, even the oldest', async (t) => {
  // 61 records seeded, one of them the oldest start of all: two go at the next start, and
  // both must be ended records, though the working one is the oldest.
  const tasks = { wish: { title: 'Wish: still at work', from: 'm1', at: 1, status: 'working' }, ...endedTasks(TASK_CAP) }
  const { call, stop, ctx } = start({ ...TEAM, tasks })
  t.after(stop)
  await call('state', {})
  const rt = ctx.provided.get('omniTeam')
  await rt.startTask({ title: 'Next', text: 'Do it', from: 'm1' })
  assert.equal(rt.state.tasks.wish?.status, 'working')
  assert.equal(rt.state.tasks.d0, undefined)
  assert.equal(rt.state.tasks.d1, undefined)
  assert.equal(rt.state.tasks.d2?.status, 'done')
  assert.equal(Object.keys(rt.state.tasks).length, TASK_CAP)
})

test('a working task keeps its record past the cap, and the guard still binds', async (t) => {
  // All sixty are at work; their records are the lineage the executor guard resolves. The
  // cap must give way rather than drop a working record (#584, L4).
  const stuck = index => ({
    title: `Stuck ${index}`, from: 'm1', at: 10 + index, status: 'working',
  })
  const tasks = Object.fromEntries(
    Array.from({ length: TASK_CAP }, (_, index) => [`w${index}`, stuck(index)]),
  )
  const restrictedBot = { ...TEAM.bots.m1, denyTools: ['read'] }
  const team = { ...TEAM, bots: { ...TEAM.bots, m1: restrictedBot }, tasks }
  const bench = start(team)
  t.after(bench.stop)
  await bench.call('state', {})
  const rt = bench.ctx.provided.get('omniTeam')
  await rt.startTask({ title: 'Next', text: 'Do it', from: 'm1' })
  assert.equal(Object.keys(rt.state.tasks).length, TASK_CAP + 1)
  assert.equal(rt.state.tasks.w0?.status, 'working')
  const guard = (bench.ctx.listeners.get('tools/execute') ?? [])[0]
  await assert.rejects(
    () => guard({ name: 'read', agent: { id: 'w0' } }, async () => 'ran'),
    /does not have the read tool/,
  )
})

test('the cap forgets by when a task ended, not when it started', async (t) => {
  const endedSince = count => Object.fromEntries(Array.from({ length: count }, (_, index) => [`e${index}`, { title: `Ended ${index}`, from: 'm1', at: 10 + index, status: 'done', endedAt: 1_000 + index }]))
  const tasks = {
    long: { title: 'Wish: started first, stopped just now', from: 'm1', at: 1, status: 'stopped', endedAt: 5_000 },
    earlyEnd: { title: 'Started late, ended first', from: 'm1', at: 900, status: 'done', endedAt: 100 },
    ...endedSince(TASK_CAP - 2),
  }
  const { call, stop, ctx } = start({ ...TEAM, tasks })
  t.after(stop)
  await call('state', {})
  const rt = ctx.provided.get('omniTeam')
  await rt.startTask({ title: 'Next', text: 'Do it', from: 'm1' })
  // The one that ended first is the one forgotten; the first started but freshest end stays.
  assert.equal(rt.state.tasks.earlyEnd, undefined)
  assert.equal(rt.state.tasks.long?.status, 'stopped')
  assert.equal(rt.state.tasks.e0?.status, 'done')
  assert.equal(Object.keys(rt.state.tasks).length, TASK_CAP)
})

test('a task list already past the cap is trimmed by its overflow on the next start', async (t) => {
  const { call, stop, ctx } = start({ ...TEAM, tasks: endedTasks(TASK_CAP + 1) })
  t.after(stop)
  await call('state', {})
  const rt = ctx.provided.get('omniTeam')
  await rt.startTask({ title: 'Next', text: 'Do it', from: 'm1' })
  assert.equal(Object.keys(rt.state.tasks).length, TASK_CAP)
  assert.deepEqual([rt.state.tasks.d0, rt.state.tasks.d1, rt.state.tasks.d2?.status], [undefined, undefined, 'done'])
})

test('a stop after an eviction is written down and reported to the Bot that asked', async (t) => {
  const tasks = { wish: { title: 'Wish: still at work', from: 'm1', at: 1, status: 'working' }, ...endedTasks(TASK_CAP - 1) }
  const { call, stop, ctx } = start({ ...TEAM, tasks })
  t.after(stop)
  await call('state', {})
  const rt = ctx.provided.get('omniTeam')
  const reports = []
  rt.deliver = async message => { reports.push(message) }
  await rt.startTask({ title: 'Next', text: 'Do it', from: 'm1' })
  assert.equal(rt.state.tasks.wish?.status, 'working')
  for (const listener of ctx.listeners.get('session/event') ?? []) listener({ id: 'wish' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } })
  await flush()
  const { tasks: view } = (await call('state', {})).value
  assert.equal(view.wish.status, 'stopped')
  assert.equal(typeof view.wish.endedAt, 'number')
  assert.deepEqual(reports.map(report => [report.taskSessionId, report.text]), [['wish', 'It was stopped before it finished.']])
})

// The cap now bounds ended history only: a working record is never evicted, so a list of
// tasks that never sent their end keeps every record. That cost is the point of #584 L4 —
// the record is the lineage the tools/execute guard resolves. Its stop still lands when the
// Session reports one; a Session DSH never reopens keeps a record nobody reads.
