import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { allowlist, code, fixture, member, owners, serviceStub, stranger, workspace } from './caller-fixture.js'
import { bench as grantBench } from './grants-fixture.js'
import { AGY, CLAUDE, refusedSolverAgent, serve } from './fixtures/solver-agent-catalog.mjs'
import { solverInstructions } from '../src/shared/solver-method.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  whaleStored: true,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Omni', role: 'Channel orchestrator', model: 'deepseek/v4', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: '写作', model: 'deepseek/v4', instructions: '', createdAt: 2 },
    b3: { id: 'b3', sessionId: 'b3', name: 'Coder', role: '代码', instructions: '', createdAt: 3 },
  },
  rooms: {
    r1: {
      id: 'r1', name: 'Launch', named: true, members: ['b2', 'b3'], admin: 'b3', mode: 'everyone', notice: '', sessions: { b3: 'g3' },
      seq: 0,
      log: [],
    },
  },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

let rt
function start(team = TEAM) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-update-'))
  if (!existsSync(join(home, 'state.json'))) writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const ctx = fakeContext()
  const sent = []
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v4' }],
      resolveModelInfo: async () => ({}),
    },
    sessionController: {
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId, seq: 1 }, followup: message => sent.push({ sessionId, message }) } }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  rt = createRuntime(ctx, { home })
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/omni-ui', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const state = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, tool, call, state, sent, stop }
}

test('a Bot changes itself by leaving out bot, or by naming itself', async (t) => {
  const { tool, state, stop } = start()
  t.after(stop)
  assert.equal(await tool('update_bot', { name: 'King', instructions: 'Lead the team' }, 'b2'), 'Updated King.')
  const king = state().bots.b2
  assert.equal(king.name, 'King')
  assert.equal(king.instructions, 'Lead the team')
  // Its current name resolves to it again.
  assert.equal(await tool('update_bot', { bot: 'King', role: '掌门' }, 'b2'), 'Updated King.')
  assert.equal(state().bots.b2.role, '掌门')
})

test('a Bot cannot change another Bot; a Main Bot can', async (t) => {
  const { tool, state, stop } = start()
  t.after(stop)
  assert.match(await tool('update_bot', { bot: 'Omni', role: 'boss' }, 'b2'), /^Only a Main Bot can change another Bot/)
  assert.equal(state().bots.m1.role, 'Channel orchestrator')
  assert.equal(await tool('update_bot', { bot: 'Writer', role: '主笔' }, 'm1'), 'Updated Writer.')
  assert.equal(state().bots.b2.role, '主笔')
  assert.match(await tool('update_bot', { bot: 'Nobody' }, 'm1'), /^No Bot named Nobody/)
})

const solverPin = { id: 'solver', version: '1.0.0', attachedAt: '2026-01-01T00:00:00.000Z', grants: [] }
const written = { role: 'Solver', instructions: solverInstructions() }

async function solverEditFixture(t, savedBot) {
  const f = fixture(t, { service: serviceStub({ multiuser: false }), seed: state => {
    state.prefs.roles = false
    Object.assign(state.bots.b, savedBot)
  } })
  serve(f.ctx, [CLAUDE, AGY, 'deepseek/v4'])
  await f.start()
  return f
}

for (const [name, bot, patch] of [
  ['Q1 a written Solver model switch', { ...written, model: CLAUDE }, { model: AGY }],
  ['AN-2 combined role, instructions and model', { model: CLAUDE }, { role: '  Solver  ', instructions: solverInstructions(), model: AGY }],
  ['AN-2 a role-only transition', { model: AGY, instructions: solverInstructions() }, { role: 'Solver' }],
  ['AN-2 an instructions-only transition', { model: AGY, role: 'Solver' }, { instructions: solverInstructions() }],
  ['AN-2 a cleared model exposing appliedModel', { ...written, model: CLAUDE, appliedModel: AGY }, { model: null }],
  ['AN-2 a waiting Solver with edited text', { model: CLAUDE, waitingRole: { id: 'solver', instructions: 'old', role: 'Helper' } }, { model: AGY }],
  ['AN-2 a package-pinned Solver with a custom description', { model: CLAUDE, roles: [solverPin] }, { model: AGY }],
]) {
  test(`${name} refuses before changing its record or Session`, async t => {
    const f = await solverEditFixture(t, bot)
    const select = t.mock.method(f.ctx.sessionController, 'selectModel', async () => {})
    const before = f.saved().bots.b
    const result = await f.call('update-bot', { id: 'b', ...patch })
    assert.deepEqual(result, refusedSolverAgent)
    assert.deepEqual(f.saved().bots.b, before)
    assert.deepEqual(f.created, [])
    assert.equal(select.mock.callCount(), 0)
  })
}

test('AN-1 switch-route resolves the destination before it stops a reply or allocates a part', async t => {
  const f = await solverEditFixture(t, { ...written, model: CLAUDE })
  const agent = f.agentOf('b')
  agent.status = 'running'
  agent.session.deriveMessages = () => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Fixture chat' }] }]
  const cancel = t.mock.method(agent, 'cancel', () => {})
  const select = t.mock.method(f.ctx.sessionController, 'selectModel', async () => {})
  const before = f.saved().bots.b
  const parts = f.readable()
  const result = await f.call('switch-route', { id: 'b', model: 'Antigravity Fixture', stopReply: true })
  assert.deepEqual(result, refusedSolverAgent)
  assert.equal(cancel.mock.callCount(), 0)
  assert.equal(select.mock.callCount(), 0)
  assert.deepEqual(f.created, [])
  assert.deepEqual(f.readable(), parts)
  assert.deepEqual(f.saved().bots.b, before)
})

test('AN-2 a grandfathered Solver permits unrelated edits and a switch away', async t => {
  const f = await solverEditFixture(t, { ...written, model: AGY, appliedModel: AGY })
  const edit = await f.call('update-bot', { id: 'b', name: 'Grandfathered Fixture' })
  assert.equal(edit.ok, true, JSON.stringify(edit))
  assert.equal(f.saved().bots.b.model, AGY)
  const switched = await f.call('switch-route', { id: 'b', model: CLAUDE })
  assert.equal(switched.ok, true, JSON.stringify(switched))
  assert.equal(f.saved().bots.b.model, CLAUDE)
  assert.equal(f.saved().bots.b.instructions, written.instructions)
})

test('a group Session changes its own Bot; a Session outside the team changes nothing', async (t) => {
  const { tool, state, stop } = start()
  t.after(stop)
  assert.equal(await tool('update_bot', { instructions: 'Ship the fix' }, 'g3'), 'Updated Coder.')
  assert.equal(state().bots.b3.instructions, 'Ship the fix')
  assert.equal(await tool('update_bot', { name: 'King' }, 'stranger'), 'Only Bots on the team can use update_bot.')
})

test('every Bot sees the update_bot rule in its identity section', async (t) => {
  const { ctx, tool, stop } = start()
  t.after(stop)
  // The first load indexes the Sessions; without it selfOf finds no Bot.
  await tool('list_bots', {}, 'b2')
  const text = ctx.sections.get('bot-identity').text({ agent: { id: 'b2' } })
  assert.match(text, /update_bot changes your own settings/)
  assert.match(ctx.sections.get('bot-identity').text({ agent: { id: 'm1' } }), /update_bot changes your own settings/)
})

test('a role is one short line of plain text', async (t) => {
  const { cleanRole, ROLE_MAX } = await import('../src/host/roster.js')
  assert.equal(cleanRole('  Orchestrator '), 'Orchestrator')
  assert.equal(cleanRole('Chief\nof\tstaff‮'), 'Chief of staff')
  assert.equal(cleanRole(undefined), '')
  assert.equal(cleanRole('x'.repeat(40)).length, ROLE_MAX)
  assert.throws(() => cleanRole(42), /a few words of text/)
  const { tool, state, stop } = start()
  t.after(stop)
  assert.equal(await tool('update_bot', { role: 'Lead\nwriter' }, 'b2'), 'Updated Writer.')
  assert.equal(state().bots.b2.role, 'Lead writer')
})

test('an instructions change lands as a message in the Bot chat', async (t) => {
  const { call, tool, sent, stop } = start()
  t.after(stop)
  assert.equal((await call('update-bot', { id: 'b2', instructions: 'Ship the fix' })).ok, true)
  // The notice goes out as a follow-up; let the queued delivery run.
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].sessionId, 'b2')
  const text = sent[0].message.content[0].text
  assert.match(text, /profile was updated/)
  assert.match(text, /Ship the fix/)
  // A patch that changes nothing sends no message.
  await call('update-bot', { id: 'b2', instructions: 'Ship the fix' })
  await call('update-bot', { id: 'b2', color: 'red' })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(sent.length, 1)

  // A Bot editing itself in its own chat just got the tool result; no second
  // turn queues for it. The same edit from a group Session still reaches it.
  assert.equal(await tool('update_bot', { instructions: 'Own fix' }, 'b2'), 'Updated Writer.')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(sent.length, 1)
  assert.equal(await tool('update_bot', { instructions: 'From the group' }, 'g3'), 'Updated Coder.')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(sent.length, 2)
  assert.equal(sent[1].sessionId, 'b3')
})

test('a Bot whose greeting is still held gets no notice before its model pick', async (t) => {
  const team = JSON.parse(JSON.stringify(TEAM))
  delete team.bots.b3.model
  team.bots.b3.kickoff = { text: 'Greet the user.', from: null }
  const { call, sent, stop } = start(team)
  t.after(stop)
  assert.equal((await call('update-bot', { id: 'b3', instructions: 'Ship the fix' })).ok, true)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(sent.length, 0)
})

test('U1 only the owner settings write can change people, and write failures leave access intact', async t => {
  const f = fixture(t)
  await f.start()
  assert.ok((await f.call('people-seen')).value.some(row => row.subject === member.person.subject))
  const before = Object.keys(f.rt.state.bots)
  for (const [endpoint, payload] of [
    ['update-bot', { id: 'b', name: 'Different', people: allowlist }],
    ['create-bot', { name: 'Injected', people: allowlist }],
    ['duplicate-bot', { id: 'b', people: allowlist }],
  ]) {
    const result = await f.call(endpoint, payload)
    assert.equal(result.error.code, 'bot/refused', endpoint)
    assert.deepEqual(Object.keys(f.rt.state.bots), before)
    assert.equal(f.rt.botOf('b').name, 'Writer')
  }
  const tool = f.rt.teamTools.find(item => item.name === 'update_bot')
  await assert.rejects(tool.execute({ people: allowlist, name: 'Injected' }, { agent: { id: 'b' } }), code('refused'))
  await assert.rejects(f.rt.updateBot('b', { name: 'Injected', people: workspace }, 'a'), code('refused'))
  const result = await f.call('update-bot', { id: 'b', people: { ...workspace, allow: allowlist.allow } })
  assert.equal(result.ok, true)
  await f.finishSwitch()
  assert.deepEqual(f.saved().bots.b.people, result.value.people)
  const duplicate = await f.call('duplicate-bot', { id: 'b' })
  assert.equal(duplicate.ok, true)
  assert.equal(f.saved().bots[duplicate.value.id].people, undefined)
  assert.equal((await f.call('set-main', { id: 'b', main: true })).ok, true)
  assert.deepEqual(f.saved().bots.b.people, allowlist)
  assert.equal(f.rt.callerBots(stranger).length, 0)
  const losses = []
  const unsubscribe = f.rt.onAccessLoss(id => losses.push(id))
  t.mock.method(f.rt, 'saveCopy', () => Promise.reject(new Error('disk failure')))
  await assert.rejects(f.rt.setPeople('b', owners), /disk failure/)
  assert.deepEqual(f.rt.botOf('b').people, allowlist)
  assert.deepEqual(f.rt.callerBots(member).map(bot => bot.id), ['b'])
  assert.deepEqual(losses, [])
  unsubscribe()
})

test('U1 the off-mode agent route rejects a people argument at the schema boundary', async t => {
  const f = fixture(t, { service: null })
  await f.start()
  const token = 'fixture-agent-token'
  writeFileSync(join(f.rt.home, 'agent-tokens.json'), JSON.stringify([{
    id: 'fixture', hash: createHash('sha256').update(token).digest('hex'), name: 'Test agent',
  }]))
  const request = new Request('http://localhost/api/omni-mcp', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'update_bot', arguments: { id: 'b', people: allowlist },
    } }),
  })
  const response = await f.routes.get('/api/omni-mcp').fetch(request)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).error.code, -32602)
  assert.equal(f.rt.botOf('b').people, undefined)
})

// #2056 D1.5: the review guard is the person's alone, set or cleared on its own; a Bot's update_bot
// never carries it, and a Bot's own change is refused.
test('the review guard: only the person turns it on or off, on its own, with a reviewer Bot on the team', async (t) => {
  const team = structuredClone({ ...TEAM, rooms: { r1: { ...TEAM.rooms.r1, members: ['b3'] } } })
  team.bots.b2 = { ...team.bots.b2, role: 'Solver', reviewerId: 'b3', reviewGuard: true }
  team.bots.m1 = { ...team.bots.m1, role: 'Solver' }
  team.reviewGuardMigrated = true
  const { tool, call, state, stop } = start(team)
  t.after(stop)
  await rt.load()
  // The tool drops an extra key, and a Bot's own change is refused.
  assert.match(await tool('update_bot', { role: 'Solver', reviewGuard: false }, 'b2'), /Updated/)
  assert.equal(rt.botOf('b2').reviewGuard, true)
  await assert.rejects(rt.updateBot('b2', { reviewGuard: false }, 'b2'), /Only the user can turn the review guard on or off for Writer/)
  // The person's switch, on its own.
  const mixed = await call('update-bot', { id: 'b2', reviewGuard: true, role: 'x' })
  assert.match(mixed.error.message, /Change the review guard on its own/)
  assert.equal((await call('update-bot', { id: 'b2', reviewGuard: 'yes' })).error.code, 'bot/invalid')
  assert.equal((await call('update-bot', { id: 'b2', reviewGuard: false })).ok, true)
  assert.equal(state().bots.b2.reviewGuard, undefined)
  assert.equal((await call('update-bot', { id: 'b2', reviewGuard: true })).ok, true)
  assert.equal(state().bots.b2.reviewGuard, true)
  // ON with no reviewer Bot is refused.
  const none = await call('update-bot', { id: 'm1', reviewGuard: true })
  assert.match(none.error.message, /Omni has no reviewer Bot on the team, so there is no verdict to wait for\./)
  assert.equal(state().bots.m1.reviewGuard, undefined)
})

const SOLVER_ONLY = 'Only a Solver wears the Solver characters. Choose another character.'
const SOLVER_WEARS = 'A Solver wears one of the Solver characters. Choose one of those characters.'
const solverProfile = () => ({ role: 'Solver', instructions: solverInstructions() })
const lookImage = 'data:image/png;base64,AA=='
const lookPet = { source: 'team', id: 'fixture', version: 1 }
const lookTeam = fields => ({ ...structuredClone(TEAM), bots: { ...structuredClone(TEAM.bots),
  b2: { ...TEAM.bots.b2, ...fields } } })

async function refuseLook(host, id, patch, message) {
  await rt.load()
  await rt.save()
  const disk = host.state().bots[id]
  const live = structuredClone(rt.botOf(id))
  const result = await host.call('update-bot', { id, ...patch })
  await rt.save()
  assert.deepEqual(host.state().bots[id], disk)
  assert.deepEqual(rt.botOf(id), live)
  assert.equal(result.error?.code, 'bot/refused')
  assert.equal(result.error.message, message)
}

test('an ordinary Bot refuses a mixed name, colour and Solver shape update', async t => {
  const host = start()
  t.after(host.stop)
  await refuseLook(host, 'b2', { name: 'Changed', color: 'red', avatar: { shape: 'frog' } }, SOLVER_ONLY)
})

for (const [name, look] of [['photo', { image: lookImage }], ['pet', { pet: lookPet }]]) {
  test(`a Solver refuses a mixed update keeping a ${name} alongside a Solver shape`, async t => {
    const host = start(lookTeam({ ...solverProfile(), avatar: look }))
    t.after(host.stop)
    await refuseLook(host, 'b2', { name: 'Changed', color: 'red', avatar: { shape: 'frog', ...look } }, SOLVER_WEARS)
  })
}

test('a Solver refuses both kinds of Default look removal', async t => {
  const host = start(lookTeam({ ...solverProfile(), avatar: { shape: 'cactus' } }))
  t.after(host.stop)
  for (const avatar of [null, {}]) await refuseLook(host, 'b2', { avatar }, SOLVER_WEARS)
})

test('an ordinary Bot can still clear its avatar', async t => {
  const host = start(lookTeam({ avatar: { shape: 'star' } }))
  t.after(host.stop)
  assert.equal((await host.call('update-bot', { id: 'b2', avatar: null })).ok, true)
  assert.equal(host.state().bots.b2.avatar, undefined)
})

test('a Solver can choose a Solver shape and colour together', async t => {
  const host = start(lookTeam({ ...solverProfile(), avatar: { shape: 'cactus' } }))
  t.after(host.stop)
  assert.equal((await host.call('update-bot', { id: 'b2', avatar: { shape: 'frog' }, color: 'red' })).ok, true)
  assert.deepEqual(host.state().bots.b2.avatar, { shape: 'frog' })
  assert.equal(host.state().bots.b2.color, 'red')
})

test('an ordinary Bot can carry its stored Solver shape but cannot choose a different one', async t => {
  const host = start(lookTeam({ avatar: { shape: 'frog' } }))
  t.after(host.stop)
  assert.equal((await host.call('update-bot', { id: 'b2', name: 'Changed' })).ok, true)
  assert.deepEqual(host.state().bots.b2.avatar, { shape: 'frog' })
  assert.equal((await host.call('update-bot', { id: 'b2', avatar: { shape: 'frog', image: lookImage } })).ok, true)
  assert.deepEqual(host.state().bots.b2.avatar, { shape: 'frog', image: lookImage })
  await refuseLook(host, 'b2', { avatar: { shape: 'cactus' } }, SOLVER_ONLY)
})

test('an unrelated edit preserves a Solver’s grandfathered ordinary shape', async t => {
  const host = start(lookTeam({ ...solverProfile(), avatar: { shape: 'star' } }))
  t.after(host.stop)
  assert.equal((await host.call('update-bot', { id: 'b2', name: 'Changed' })).ok, true)
  assert.deepEqual(host.state().bots.b2.avatar, { shape: 'star' })
})

test('a queued model and avatar edit checks the identity after the model slot opens', async t => {
  const host = start(lookTeam({ ...solverProfile(), avatar: { shape: 'cactus' } }))
  t.after(host.stop)
  await rt.load()
  const gate = Promise.withResolvers()
  const held = rt.withModelChange('b2', () => gate.promise, true)
  const queued = rt.updateBot('b2', { model: 'deepseek/v4', avatar: { shape: 'frog' } })
  const refused = queued.then(value => ({ value }), error => ({ error }))
  let disk
  let live
  try {
    assert.equal((await host.call('update-bot', { id: 'b2', instructions: '' })).ok, true)
    await rt.save()
    disk = host.state().bots.b2
    live = structuredClone(rt.botOf('b2'))
  } finally {
    gate.resolve()
    await held
  }
  const { error } = await refused
  await rt.save()
  assert.deepEqual(host.state().bots.b2, disk)
  assert.deepEqual(rt.botOf('b2'), live)
  assert.equal(error?.message, SOLVER_ONLY)
})

test('a mixed look refusal precedes the grant hold and keeps the scoped grant', async t => {
  const host = await grantBench(t, { models: [{ id: 'v4' }] })
  const id = await host.grant()
  const hold = t.mock.method(host.rt, 'holdGrants')
  await host.rt.save()
  const state = () => JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8'))
  const disk = state().bots.a
  const live = structuredClone(host.rt.botOf('a'))
  const response = await host.request('update-bot', { id: 'a', model: 'deepseek/v4', avatar: { shape: 'frog' } })
  await host.rt.save()
  assert.deepEqual(state().bots.a, disk)
  assert.deepEqual(host.rt.botOf('a'), live)
  assert.equal(response.error?.message, SOLVER_ONLY)
  assert.equal(hold.mock.callCount(), 0)
  assert.ok(host.rt.grantsView().some(grant => grant.id === id && grant.botId === 'a'))
})

test('the person can make a Bot a Solver in Settings', async t => {
  const host = start()
  t.after(host.stop)
  const profile = solverProfile()
  assert.equal((await host.call('update-bot', { id: 'b2', ...profile })).ok, true)
  assert.equal(host.state().bots.b2.role, profile.role)
  assert.equal(host.state().bots.b2.instructions, profile.instructions)
})

test('a model update refuses to acquire the slot from inside the look hold', async t => {
  const host = start()
  t.after(host.stop)
  await rt.load()
  await rt.save()
  const disk = host.state().bots.b2
  const live = structuredClone(rt.botOf('b2'))
  assert.equal(typeof rt.withLookHold, 'function')
  await assert.rejects(rt.withLookHold('b2', () => rt.updateBot('b2', { model: 'deepseek/v4' })),
    /lock order: model change inside a look hold/)
  await rt.save()
  assert.deepEqual(host.state().bots.b2, disk)
  assert.deepEqual(rt.botOf('b2'), live)
})

test('a Solver’s colour-only save keeps the current Solver shape', async t => {
  const host = start(lookTeam({ ...solverProfile(), avatar: { shape: 'frog' }, color: 'blue' }))
  t.after(host.stop)
  assert.equal((await host.call('update-bot', { id: 'b2', color: 'red' })).ok, true)
  assert.deepEqual(host.state().bots.b2.avatar, { shape: 'frog' })
  assert.equal(host.state().bots.b2.color, 'red')
})

test('a colour-only save refuses an ordinary Bot’s stored Solver shape', async t => {
  const host = start(lookTeam({ avatar: { shape: 'frog' }, color: 'blue' }))
  t.after(host.stop)
  await refuseLook(host, 'b2', { color: 'red' }, SOLVER_ONLY)
})
