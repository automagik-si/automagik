import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { format } from 'node:util'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { SEAT_AGENTS } from '../src/shared/bot-types.js'
import { normalizeView } from 'deep-view/core'
import { createAdapter } from '../src/host/pocket-chat-adapter.js'

async function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'bot-type-refusals-'))
  const native = { id: 'a', sessionId: 'a', name: 'Main', instructions: '', role: '', model: 'deepseek/pro', createdAt: 1 }
  const seed = { version: 2, mainBotIds: ['a'], bots: {
    a: native,
    b: { id: 'b', name: 'Terminal', type: 'herdr', agent: 'codex', lead: 'a', instructions: 'old', role: '', createdAt: 2 },
    c: { ...native, id: 'c', sessionId: 'c', name: 'Native', appliedModel: 'deepseek/pro', effort: 'high', kickoff: { text: 'hello' } },
  }, rooms: { r: { id: 'r', name: 'Team', members: ['a', 'b', 'c'], admin: 'a', mode: 'admin', named: true, sessions: { b: 'gb' }, log: [], seen: {} } }, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0 }
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const ctx = fakeContext()
  const warnings = []
  ctx.logger.warn = (...args) => warnings.push(format(...args))
  const queued = []
  const created = []
  const resolved = []
  const models = []
  const agents = new Map()
  const agentOf = id => {
    if (!agents.has(id)) agents.set(id, {
      id, session: { id, deriveMessages: () => [], requestHeader: () => undefined }, status: 'idle',
      ctx: { tools: { restrict: () => () => {} }, effect() {}, on() {} },
      followup: message => queued.push(['followup', id, message]),
      steer: message => queued.push(['steer', id, message]),
      inject: message => queued.push(['inject', id, message]),
      cancel() {}, inbox: { nextStep: [], nextTurn: [] },
    })
    return agents.get(id)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }], listModels: async () => [{ id: 'pro' }], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w', path }), archiveSession: async () => {} },
    sessionController: {
      create: async request => { created.push(request); return { sessionId: `native-${created.length}` } },
      resolveAgent: async id => { resolved.push(id); return { agent: agentOf(id) } },
      selectModel: async request => { models.push(request) },
      prompt: async request => { queued.push(['prompt', request.sessionId]) },
      cancel: async () => {},
    },
    sessionTitle: { rename: async () => {} }, sessions: { flush: async () => {} },
  })
  let api
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => {
    if (options.path === '/api/omni-ui') api = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home })
  await rt.load()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const tool = (name, args, id = 'a') => rt.teamTools.find(tool => tool.name === name).execute(args, { agent: { id } })
  const call = async (endpoint, payload) => (await api.fetch(new Request('http://localhost/api/omni-ui', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  return { rt, ctx, home, call, warnings, queued, created, resolved, models, agentOf, tool, saved: id => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).bots[id] }
}
const terminalOnly = { code: 'bot/terminal-only', message: 'The Bot is terminal-only.' }

for (const role of ['request', 'reply', 'room', 'report', 'update', 'kickoff', 'continue', 'resume', 'task', 'task-done', 'secret', 'permission', 'stopped']) {
  test(`Herdr refuses ${role} delivery before native Session resolution`, async t => {
    const { rt, resolved, queued } = await fixture(t)
    await assert.rejects(rt.deliver({ fromId: 'a', toId: 'b', text: 'hello', role }), terminalOnly)
    assert.deepEqual(resolved, [], 'refusal must precede native Session resolution')
    assert.deepEqual(queued, [])
    assert.deepEqual(rt.state.exchanges, [])
    assert.deepEqual(rt.exchangesOf('a', 'b'), [], 'a refused delivery must not be recorded')
  })
}

test('Herdr refuses a delivery addressed through its group Session', async t => {
  const { rt, queued } = await fixture(t)
  await assert.rejects(rt.deliver({ toId: 'c', sessionId: 'gb', text: 'bypass', role: 'reply' }), terminalOnly)
  assert.deepEqual(queued, [])
})

test('message_bot refuses a terminal-only recipient', async t => {
  const { tool, queued, rt } = await fixture(t)
  await assert.rejects(tool('message_bot', { to: 'Terminal', message: 'hello' }), terminalOnly)
  assert.deepEqual(queued, [])
  assert.deepEqual(rt.state.works, {}, 'no work is opened for a refused request')
})

test('a group post refuses a terminal-only speaker', async t => {
  const { rt, queued, created } = await fixture(t)
  await assert.rejects(rt.postToRoom(rt.roomOf('r'), rt.botOf('a'), '@Terminal hello'), terminalOnly)
  assert.deepEqual(queued, [])
  assert.deepEqual(created, [])
})

test('an instructions edit refuses its terminal-only notification before changing the Bot', async t => {
  const { rt, queued, saved } = await fixture(t)
  await assert.rejects(rt.updateBot('b', { instructions: 'new instructions' }), terminalOnly)
  assert.equal(rt.botOf('b').instructions, 'old')
  assert.equal(saved('b').instructions, 'old')
  assert.deepEqual(queued, [])
})

test('a role edit refuses its terminal-only notification', async t => {
  const { rt, queued } = await fixture(t)
  await assert.rejects(rt.updateBot('b', { role: 'changed' }), terminalOnly)
  assert.equal(rt.botOf('b').role, '')
  assert.deepEqual(queued, [])
})

for (const method of ['followup', 'steer', 'inject']) {
  test(`a retained agent refuses native ${method} after its Bot becomes Herdr`, async t => {
    const { rt, queued } = await fixture(t)
    const agent = await rt.resolveAgent('c')
    await rt.updateBot('c', { type: 'herdr', agent: 'codex' })
    assert.throws(() => agent[method]({ role: 'user', content: [] }), terminalOnly)
    assert.deepEqual(queued, [])
  })
}

test('a newly created agent refuses native input for a Herdr Bot', async t => {
  const { ctx, agentOf, queued } = await fixture(t)
  const agent = agentOf('b')
  await ctx.emitAsync('agent/created', { agent })
  assert.throws(() => agent.followup({ role: 'user' }), terminalOnly)
  assert.deepEqual(queued, [])
})

test('the Session Controller refuses a native prompt for Herdr', async t => {
  const { ctx, queued } = await fixture(t)
  await assert.rejects(ctx.sessionController.prompt({ sessionId: 'b', content: [] }), terminalOnly)
  assert.deepEqual(queued, [])
})

test('sendUser refuses a native prompt for Herdr', async t => {
  const { rt, queued } = await fixture(t)
  await assert.rejects(rt.sendUser({ sessionId: 'b', content: [] }), terminalOnly)
  assert.deepEqual(queued, [])
})

test('Pocket prompts refuse a native turn for Herdr', async t => {
  const { ctx, queued } = await fixture(t)
  await assert.rejects(createAdapter(ctx.sessionController).prompt('b', { requestId: 'test', text: 'hello' }), terminalOnly)
  assert.deepEqual(queued, [])
})

test('pre-step admission refuses queued native work for a Herdr Bot', async t => {
  const { ctx, agentOf, queued } = await fixture(t)
  const admit = ctx.listeners.get('agent/pre-step').find(listener => listener.name === 'admitNativeStep')
  assert.equal(typeof admit, 'function')
  let entered = false
  await assert.rejects(admit({ agent: agentOf('b') }, () => { entered = true; return Promise.resolve({ kind: 'enter', messages: [] }) }), terminalOnly)
  assert.equal(entered, false)
  assert.deepEqual(queued, [])
})

test('host refuses creating a Herdr Main Bot before any native Session', async t => {
  const { rt, created } = await fixture(t)
  await assert.rejects(rt.createBot({ name: 'Bad Main', type: 'herdr', agent: 'codex', main: true }), /A Main Bot cannot be a Herdr Bot/)
  assert.deepEqual(created, [])
  assert.equal(rt.findBot('Bad Main'), undefined)
})

test('host refuses Main-to-Herdr conversion without changing type or model', async t => {
  const { rt, saved } = await fixture(t)
  const before = structuredClone(rt.botOf('a'))
  await assert.rejects(rt.updateBot('a', { type: 'herdr', model: null }), /A Main Bot cannot be a Herdr Bot/)
  assert.equal(rt.botOf('a').type, before.type, 'a refused Main switch must leave type unchanged')
  assert.equal(rt.botOf('a').model, before.model, 'a refused Main switch must leave model unchanged')
  assert.deepEqual(saved('a'), before)
})

test('host refuses promoting a Herdr member to Main', async t => {
  const { rt } = await fixture(t)
  await assert.rejects(rt.setMain('b', true), /A Main Bot cannot be a Herdr Bot/)
  assert.deepEqual(rt.state.mainBotIds, ['a'])
  assert.equal(rt.botOf('b').lead, 'a', 'Herdr remains an allowed member with a lead')
})

test('Herdr creation saves a member definition and creates no native Session', async t => {
  const { rt, created, resolved, queued, saved } = await fixture(t)
  const bot = await rt.createBot({ name: 'New Terminal', type: 'herdr', agent: 'codex', createdBy: 'a' })
  assert.equal(bot.type, 'herdr')
  assert.equal(bot.lead, 'a')
  assert.equal(bot.agent, 'codex')
  assert.equal(saved(bot.id).type, 'herdr')
  assert.deepEqual(created, [], 'creating Herdr must create no native Session')
  assert.deepEqual(resolved, [], 'creating Herdr must resolve no native Session')
  assert.deepEqual(queued, [])
})

test('host refuses an unknown terminal agent on create', async t => {
  const { rt, created } = await fixture(t)
  await assert.rejects(rt.createBot({ name: 'Unknown Agent', type: 'herdr', agent: 'unknown' }), /Unknown terminal agent/)
  assert.deepEqual(created, [])
})

test('host refuses an unknown terminal agent on update', async t => {
  const { rt, saved } = await fixture(t)
  await assert.rejects(rt.updateBot('b', { agent: 'unknown' }), /Unknown terminal agent/)
  assert.equal(saved('b').agent, 'codex')
})

test('known seat agents are bounded choices for a Herdr member', async t => {
  const { rt, created } = await fixture(t)
  for (const agent of SEAT_AGENTS) {
    const bot = await rt.createBot({ name: `Terminal ${agent}`, type: 'herdr', agent })
    assert.equal(bot.agent, agent)
    assert.equal(bot.lead, 'a')
  }
  assert.deepEqual(created, [])
})

test('native-to-Herdr conversion removes all native model and kickoff fields', async t => {
  const { rt, saved, queued } = await fixture(t)
  for (const key of ['model', 'appliedModel', 'effort', 'kickoff']) assert.ok(Object.hasOwn(rt.botOf('c'), key), `fixture must carry ${key}`)
  await rt.updateBot('c', { type: 'herdr', agent: 'codex' })
  for (const key of ['model', 'appliedModel', 'effort', 'kickoff']) {
    assert.equal(Object.hasOwn(rt.botOf('c'), key), false, `${key} must be removed in memory`)
    assert.equal(Object.hasOwn(saved('c'), key), false, `${key} must be removed on disk`)
  }
  assert.deepEqual(queued, [])
})

test('update type null clears Herdr and makes the Bot native again', async t => {
  const { rt, saved, created, queued } = await fixture(t)
  await rt.updateBot('b', { type: null })
  assert.equal(Object.hasOwn(rt.botOf('b'), 'type'), false)
  assert.equal(Object.hasOwn(saved('b'), 'type'), false)
  assert.equal(created.length, 1, 'a native Session is created only on the explicit conversion')
  assert.deepEqual(queued, [], 'conversion alone starts no turn')
  await rt.sendUser({ sessionId: 'b', content: [{ type: 'text', text: 'hello' }] })
  assert.deepEqual(queued, [['prompt', rt.chatOf('b')]], 'the cleared type behaves as native')
})


test('a group round refuses a Herdr member before creating its native group Session', async t => {
  const { rt, created, agentOf, warnings } = await fixture(t)
  delete rt.roomOf('r').sessions.b
  rt.roomInbox.set('r', [{ text: '@Terminal hello', time: Date.now() }])
  await rt.teamTools.find(tool => tool.name === 'group_relay').execute({}, { agent: agentOf('r'), callId: 'test-round', concludeTurn() {} })
  await Promise.all(rt.roomRounds('r'))
  assert.deepEqual(created, [], 'Herdr group participation must create no native Session')
  assert.ok(rt.groupRows('r', 0, Number.MAX_SAFE_INTEGER).some(row => /terminal-only/.test(row.text ?? '')), `the group must surface the terminal-only refusal: ${JSON.stringify(rt.groupRows('r', 0, Number.MAX_SAFE_INTEGER))}; ${warnings.join(';')}`)
})


test('an ask_user answer refuses a native turn for Herdr and preserves the question', async t => {
  const { rt, queued } = await fixture(t)
  const question = { id: 'q', question: 'Continue?', options: [{ label: 'Yes' }] }
  rt.state.questions.b = question
  await rt.save()
  await assert.rejects(rt.answerQuestion('b', 'q', { selected: ['Yes'] }), terminalOnly)
  assert.deepEqual(rt.state.questions.b, question)
  assert.deepEqual(queued, [])
})

test('a view reply refuses a native turn for Herdr and preserves the view', async t => {
  const { rt, call, queued } = await fixture(t)
  rt.state.views.b = { id: 'v', callId: 'v-call', title: 'Pick', view: normalizeView({ type: 'options', id: 'pick', options: [{ label: 'Yes' }] }) }
  await rt.save()
  const result = await call('view-reply', { sessionId: 'b', viewId: 'v', action: 'pick', values: { selected: ['Yes'] } })
  assert.equal(result.ok, false)
  assert.deepEqual(result.error, { ...terminalOnly, details: {} })
  assert.equal(rt.state.views.b.id, 'v')
  assert.deepEqual(queued, [])
})

test('browser give-back refuses a native turn for Herdr and preserves the hold', async t => {
  const { rt, call, queued } = await fixture(t)
  const hold = { callId: 'browser-call', reason: 'Help' }
  let current = hold
  rt.browserChannel = { holdOf: () => current, setHold: (_id, value) => { current = value } }
  const result = await call('browser-give-back', { botId: 'b', callId: 'browser-call', outcome: 'done' })
  assert.equal(result.ok, false)
  assert.deepEqual(result.error, { ...terminalOnly, details: {} })
  assert.deepEqual(current, hold)
  assert.deepEqual(queued, [])
})

test('a conversion to Herdr refuses an instructions edit in the same update', async t => {
  const { rt, queued } = await fixture(t)
  await assert.rejects(rt.updateBot('c', { type: 'herdr', instructions: 'a new job' }), terminalOnly)
  assert.equal(rt.botOf('c').type, undefined)
  assert.equal(rt.botOf('c').instructions, '')
  assert.deepEqual(queued, [])
})


test('the create endpoint refuses an explicit Herdr Main Bot request', async t => {
  const { call, created } = await fixture(t)
  const result = await call('create-bot', { name: 'Bad Main', type: 'herdr', main: true, agent: 'codex' })
  assert.equal(result.ok, false)
  assert.equal(result.error.message, 'A Main Bot cannot be a Herdr Bot.')
  assert.deepEqual(created, [])
})
