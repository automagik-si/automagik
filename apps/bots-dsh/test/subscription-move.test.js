import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { CHECK_BACKOFF_MS, CONFIRM_AFTER_MS, RETRY_MS, SIGN_IN_RECHECK_MS, SUBSCRIPTION_MOVES, movedRef } from '../src/host/subscription-move.js'
import { fakeContext } from './fake-ctx.js'
import { immediate, until } from './until.js'

const bot = (id, model, extra = {}) => ({ id, sessionId: id, name: id, role: 'Work', instructions: '', createdAt: 1, model, ...extra })

const seed = (bots, extra = {}) => ({
  version: 1,
  mainBotIds: [],
  revision: 2,
  whaleStored: true,
  octopusStored: true,
  genieClayStored: true,
  claudeCodeMoved: true,
  bots: Object.fromEntries(bots.map(entry => [entry.id, entry])),
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  ...extra,
})

// DSH's settings with pi-ai's routes as given: `anthropic: {}` is the Claude Pro/Max sign-in's
// route, `anthropic: { apiKeyEnv }` the API key's.
const piSettings = providers => ({
  describe: () => [{ ns: 'llm-pi-ai', revision: 0, value: { providers }, user: { providers }, base: {} }],
})

// DSH's credential store, as descriptions only: `records` maps a record key to its kind,
// `keys` lists the references found (a stored key or one in the environment).
const fakeCredentials = ({ records, keys }) => ({
  describeRecord: async key => (Object.hasOwn(records, key) ? { configured: true, kind: records[key], writable: true } : { configured: false, writable: true }),
  describe: async ref => (keys.includes(ref) ? { configured: true, source: 'env', writable: true } : { configured: false, writable: true }),
})

// acp-dsh's `acpAgents`, as the move reads it: `status()` (spawns nothing) and `inspect(id)` (asks
// the CLI for its sign-in), counted. `rows` is each agent's state and can change while a test
// runs; a row's `onInspect` runs, and is waited for, while the CLI is being asked. No `bridge`,
// so acp-adoption.js behaves as it does with no service.
const READY = { on: true, connector: 'ready', cli: 'ready', signedIn: true }
function fakeAgents(rows = {}, { inspect = true } = {}) {
  const state = { 'acp-codex': { ...READY }, 'acp-claude': { ...READY }, ...rows }
  const calls = { status: 0, inspect: 0 }
  const rowOf = (id) => {
    const row = state[id]
    return {
      id,
      name: id === 'acp-codex' ? 'Codex' : 'Claude Code',
      on: row.on,
      cli: { found: row.cli === 'ready', state: row.cli },
      connector: { state: row.on === false ? 'off' : row.connector },
      ...(row.signedIn === undefined ? {} : { signedIn: row.signedIn }),
    }
  }
  const service = {
    // Historical shared-host restoration tests. Shipped ACP now declares only isolated.
    authScope: 'shared',
    status: async () => {
      calls.status += 1
      return { agents: Object.keys(state).map(rowOf) }
    },
    ...(inspect ? {
      inspect: async (id) => {
        calls.inspect += 1
        await state[id].onInspect?.()
        if (state[id].throws) throw new Error('the CLI did not answer')
        return rowOf(id)
      },
    } : {}),
  }
  return { state, calls, service }
}

async function start(team, {
  providers = ['deepseek', 'openai-codex', 'acp-codex', 'anthropic', 'acp-claude'],
  pi = { anthropic: {} },
  records = { 'llm-pi-ai/anthropic': 'grant' },
  keys = [],
  catalog = {},
  services = {},
  // null: no acp-dsh service at all.
  agents = fakeAgents(),
  // Runs between apply() and the first pass, which waits on the team file.
  prepare,
} = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-subs-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const ctx = fakeContext({
    services: {
      ...(pi === null ? {} : { settings: piSettings(pi), credentials: fakeCredentials({ records, keys }) }),
      ...(agents === null ? {} : { acpAgents: agents.service }),
      ...services,
    },
  })
  // The plugin's own route, for the state answer the client reads.
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/omni-ui', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const routes = { list: [...providers] }
  const models = Object.assign(Object.create(null), {
    deepseek: [{ id: 'deepseek-v4-flash' }],
    'openai-codex': [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-astra' }],
    'acp-codex': [{ id: 'default' }, { id: 'gpt-6.1-sol' }],
    anthropic: [{ id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }],
    'acp-claude': [{ id: 'default' }, { id: 'opus' }, { id: 'sonnet' }, { id: 'haiku' }],
    openai: [{ id: 'gpt-6.1-sol' }],
    ...catalog,
  })
  const selected = []
  Object.assign(ctx, {
    llm: {
      listProviders: () => routes.list.map(id => ({ id, name: id })),
      listModels: async provider => models[provider] ?? [],
      resolveModelInfo: async () => ({}),
      listConfigurableProviders: () => ['openai-codex', 'anthropic', 'openai']
        .map(id => ({ provider: id, displayName: id, settingsNs: 'llm-pi-ai', settingsPath: ['providers', id] })),
    },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup() {}, cancel() {} } }),
      selectModel: async request => { selected.push(request) },
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {}, list: () => [] },
  })
  apply(ctx, { home })
  const rt = ctx.provided.get('omniTeam')
  prepare?.(rt)
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  const saved = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const pass = () => rt.moveSubscriptionBots()
  // One turn of a Bot's own chat on the model its Session would run, as DSH reports it: an
  // answer from that route, or MODEL_ACCESS_REQUIRED from an agent whose CLI is signed out.
  const turn = async (botId) => {
    const ref = await rt.desiredModel(rt.botOf(botId))
    const [provider, ...rest] = ref.split('/')
    const signedOut = agents?.state[provider] !== undefined && agents.state[provider].signedIn !== true
    const event = signedOut
      ? { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'MODEL_ACCESS_REQUIRED', message: 'Sign in' } } } }
      : { type: 'assistant/message', data: { message: { source: { provider, model: rest.join('/') } } } }
    for (const listener of ctx.listeners.get('session/event') ?? []) listener({ id: rt.chatOf(botId) }, event)
    return rt.modelStateView()[botId]
  }
  return { ctx, rt, routes, models, saved, selected, stop, agents, home, pass, turn, call }
}

// What the Codex move may change in a team file: each Bot's model fields and record, and its flag.
// (The store's own start-up writes, such as a Bot's `capabilities`, are not the move's.)
const MOVE_FIELDS = ['model', 'effort', 'previousModel', 'appliedModel', 'appliedEffort', 'subscriptionMoved']
const moveState = team => ({
  bots: Object.fromEntries(Object.values(team.bots).map(entry => [entry.id, Object.fromEntries(MOVE_FIELDS.filter(key => entry[key] !== undefined).map(key => [key, entry[key]]))])),
  flag: team.subscriptionCliMoved?.['openai-codex'],
})
const selections = host => host.selected.map(request => `${request.sessionId}:${request.provider}/${request.model}`).sort()
// A team as the move leaves it, before any answer. v3.109.1 wrote no `subscriptionMovedAt`.
const movedRecord = (extra = {}) => ({ from: { model: 'openai-codex/gpt-6.1-sol' }, target: 'acp-codex/gpt-6.1-sol', ...extra })
const movedBot = (id, record = movedRecord(), extra = {}) => bot(id, record.target, { appliedModel: record.target, previousModel: record.target, subscriptionMoved: record, ...extra })
const MOVED = { subscriptionCliMoved: { 'openai-codex': true, anthropic: true } }

test('movedRef keeps the same id when the agent lists it, else the family, else default', () => {
  const [codex, claude] = SUBSCRIPTION_MOVES
  assert.equal(movedRef('openai-codex/gpt-6.1-sol', codex, ['default', 'gpt-6.1-sol']), 'acp-codex/gpt-6.1-sol')
  assert.equal(movedRef('openai-codex/gpt-6.1-sol', codex, ['default', 'gpt-6.1-sol/high']), 'acp-codex/gpt-6.1-sol/high')
  assert.equal(movedRef('openai-codex/gpt-6-astra', codex, ['default', 'gpt-6.1-sol']), 'acp-codex/default')
  assert.equal(movedRef('openai-codex/gpt-6', codex, ['gpt-6.1-sol']), 'acp-codex/default')
  assert.equal(movedRef('anthropic/claude-opus-5-5', claude, ['default', 'opus', 'sonnet']), 'acp-claude/opus')
  assert.equal(movedRef('anthropic/claude-sonnet-5-5', claude, ['claude-sonnet-5-5', 'sonnet']), 'acp-claude/claude-sonnet-5-5')
  assert.equal(movedRef('anthropic/claude-haiku-4-5', claude, ['default', 'opus']), 'acp-claude/default')
  assert.equal(movedRef('openai/gpt-6.1-sol', codex, ['gpt-6.1-sol']), undefined)
  assert.equal(movedRef('deepseek/deepseek-v4-flash', claude, []), undefined)
  assert.equal(movedRef(undefined, codex, []), undefined)
})

test('subscription Bots move once to their CLI; key and other Bots stay; the Session selects the target', async (t) => {
  const team = seed([
    bot('c1', 'openai-codex/gpt-6.1-sol', { effort: 'high', appliedModel: 'openai-codex/gpt-6.1-sol', previousModel: 'openai-codex/gpt-6.1-sol' }),
    bot('c2', 'openai-codex/gpt-6-astra'),
    bot('a1', 'anthropic/claude-opus-5-5', { previousModel: 'deepseek/deepseek-v4-flash' }),
    bot('k1', 'openai/gpt-6.1-sol'),
    bot('d1', 'deepseek/deepseek-v4-flash', { previousModel: 'openai-codex/gpt-6-astra' }),
  ])
  const host = await start(team)
  t.after(host.stop)
  await until(() => host.saved().subscriptionCliMoved?.anthropic === true && host.saved().subscriptionCliMoved?.['openai-codex'] === true, { label: 'the move ran' })
  await until(() => host.saved().bots.c1.appliedModel === 'acp-codex/gpt-6.1-sol', { label: 'the target was applied' })
  const { bots } = host.saved()
  assert.equal(bots.c1.model, 'acp-codex/gpt-6.1-sol')
  assert.equal(bots.c1.effort, 'high')
  assert.deepEqual(bots.c1.subscriptionMoved, { from: { model: 'openai-codex/gpt-6.1-sol', effort: 'high' }, target: 'acp-codex/gpt-6.1-sol' })
  // A confirmed Bot stays confirmed: no switch back to a route that no longer answers.
  assert.equal(bots.c1.previousModel, 'acp-codex/gpt-6.1-sol')
  assert.equal(bots.c2.model, 'acp-codex/default')
  assert.equal(bots.a1.model, 'acp-claude/opus')
  // A pending switch keeps the model it came from.
  assert.equal(bots.a1.previousModel, 'deepseek/deepseek-v4-flash')
  assert.equal(bots.k1.model, 'openai/gpt-6.1-sol')
  assert.equal(bots.k1.subscriptionMoved, undefined)
  assert.equal(bots.d1.model, 'deepseek/deepseek-v4-flash')
  assert.equal(bots.d1.previousModel, 'acp-codex/default')
  await until(() => host.selected.length >= 3, { label: 'the Sessions selected the targets' })
  assert.deepEqual(
    host.selected.map(request => `${request.sessionId}:${request.provider}/${request.model}`).sort(),
    ['a1:acp-claude/opus', 'c1:acp-codex/gpt-6.1-sol', 'c2:acp-codex/default'],
  )
})

test('a Claude Bot on an Anthropic API key never moves', async (t) => {
  const team = seed([bot('a1', 'anthropic/claude-opus-5-5'), bot('c1', 'openai-codex/gpt-6.1-sol')])
  const host = await start(team, { pi: { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' } } })
  t.after(host.stop)
  await until(() => host.saved().subscriptionCliMoved?.['openai-codex'] === true, { label: 'the codex move ran' })
  const state = host.saved()
  assert.equal(state.bots.a1.model, 'anthropic/claude-opus-5-5')
  assert.equal(state.bots.a1.subscriptionMoved, undefined)
  assert.equal(state.subscriptionCliMoved.anthropic, undefined)
  assert.equal(state.bots.c1.model, 'acp-codex/gpt-6.1-sol')
})

test('a Claude route on a key with no apiKeyEnv never moves: an environment key or a stored api-key record', async (t) => {
  for (const [label, options] of [
    ['an ANTHROPIC_API_KEY pi-ai finds', { keys: ['ANTHROPIC_API_KEY'] }],
    ['a stored api-key record', { records: { 'llm-pi-ai/anthropic': 'api-key' } }],
    ['nothing signed in', { records: {} }],
  ]) {
    const team = seed([bot('a1', 'anthropic/claude-opus-5-5'), bot('c1', 'openai-codex/gpt-6.1-sol')])
    const host = await start(team, options)
    t.after(host.stop)
    await until(() => host.saved().subscriptionCliMoved?.['openai-codex'] === true, { label: `the codex move ran (${label})` })
    await host.rt.moveSubscriptionBots()
    const state = host.saved()
    assert.equal(state.bots.a1.model, 'anthropic/claude-opus-5-5', label)
    assert.equal(state.bots.a1.subscriptionMoved, undefined, label)
    assert.equal(state.subscriptionCliMoved.anthropic, undefined, label)
  }
})

test('a Codex catalog not read yet (only its default) moves no one and marks nothing; the real catalog moves to the same model', async (t) => {
  const team = seed([bot('c1', 'openai-codex/gpt-6.1-sol', { effort: 'high' })])
  const host = await start(team, { catalog: { 'acp-codex': [{ id: 'default' }] } })
  t.after(host.stop)
  await host.rt.moveSubscriptionBots()
  assert.equal(host.saved().bots.c1.model, 'openai-codex/gpt-6.1-sol')
  assert.equal(host.saved().bots.c1.subscriptionMoved, undefined)
  assert.equal(host.saved().subscriptionCliMoved?.['openai-codex'], undefined)
  host.models['acp-codex'] = [{ id: 'default' }, { id: 'gpt-6.1-sol' }]
  host.ctx.emit('llm/adapters-updated', {})
  await until(() => host.saved().subscriptionCliMoved?.['openai-codex'] === true, { label: 'the move ran once the catalog was read' })
  assert.equal(host.saved().bots.c1.model, 'acp-codex/gpt-6.1-sol')
  assert.equal(host.saved().bots.c1.effort, 'high')
})

// The subscription move already ran for this team (it marks a route done even when no Bot is
// on it), so only the ACP rollback can still change these Bots.
const DONE = { subscriptionCliMoved: { anthropic: true, 'openai-codex': true } }

test('the Claude Code route gone: the ACP rollback never puts a Claude plan Bot back on the anthropic sign-in route', async (t) => {
  const record = { from: { model: 'anthropic/claude-opus-5-5' }, target: 'acp-claude/opus' }
  const team = seed([bot('a1', 'acp-claude/opus', { claudeCodeModel: 'claude-code/opus', acpMoved: record })], { claudeAcpMoved: true, ...DONE })
  // No acpAgents service and no loader entry: acp-adoption reads the route as gone.
  const host = await start(team, { providers: ['deepseek', 'anthropic', 'acp-claude'] })
  t.after(host.stop)
  await until(() => host.saved().claudeAcpMoved === undefined, { label: 'the rollback ran' })
  const { bots } = host.saved()
  assert.equal(bots.a1.model, 'acp-claude/opus')
  assert.equal(bots.a1.acpMoved, undefined)
})

test('dshTools off: a Claude plan Bot the subscription move took stays on Claude Code', async (t) => {
  const team = seed([bot('a1', 'acp-claude/opus', {
    claudeCodeModel: 'claude-code/opus',
    subscriptionMoved: { from: { model: 'anthropic/claude-opus-5-5' }, target: 'acp-claude/opus' },
  })], { claudeAcpMoved: true, ...DONE })
  const acpAgents = { bridge: async () => ({ on: false }), status: async () => ({ agents: [] }) }
  const host = await start(team, { services: { acpAgents } })
  t.after(host.stop)
  await until(() => host.saved().claudeAcpMoved === undefined, { label: 'the rollback ran' })
  const { bots } = host.saved()
  assert.equal(bots.a1.model, 'acp-claude/opus')
  assert.equal(bots.a1.acpMoved, undefined)
})

test('with a key on the anthropic route, the ACP rollback still restores the key model', async (t) => {
  const record = { from: { model: 'anthropic/claude-opus-5-5' }, target: 'acp-claude/opus' }
  const team = seed([bot('a1', 'acp-claude/opus', { claudeCodeModel: 'claude-code/opus', acpMoved: record })], { claudeAcpMoved: true })
  const host = await start(team, { providers: ['deepseek', 'anthropic', 'acp-claude'], pi: { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' } } })
  t.after(host.stop)
  await until(() => host.saved().bots.a1.model === 'anthropic/claude-opus-5-5', { label: 'the rollback restored the key model' })
  assert.equal(host.saved().subscriptionCliMoved?.anthropic, undefined)
})

test('a Claude route DSH settings cannot show is left alone', async (t) => {
  const team = seed([bot('a1', 'anthropic/claude-opus-5-5')])
  const host = await start(team, { pi: null })
  t.after(host.stop)
  await host.rt.moveSubscriptionBots()
  assert.equal(host.saved().bots.a1.model, 'anthropic/claude-opus-5-5')
  assert.equal(host.saved().subscriptionCliMoved?.anthropic, undefined)
})

test('nothing moves until the CLI route is registered, then it moves on the adapters event', async (t) => {
  const team = seed([bot('c1', 'openai-codex/gpt-6.1-sol')])
  const host = await start(team, { providers: ['deepseek', 'openai-codex'] })
  t.after(host.stop)
  await host.rt.moveSubscriptionBots()
  assert.equal(host.saved().bots.c1.model, 'openai-codex/gpt-6.1-sol')
  assert.equal(host.saved().subscriptionCliMoved, undefined)
  host.routes.list.push('acp-codex')
  host.ctx.emit('llm/adapters-updated', {})
  await until(() => host.saved().bots.c1.model === 'acp-codex/gpt-6.1-sol', { label: 'the move ran once the route came' })
})

test('the move is done once: a team already moved keeps a later subscription pick', async (t) => {
  const team = seed([bot('c1', 'openai-codex/gpt-6.1-sol')], { subscriptionCliMoved: { 'openai-codex': true, anthropic: true } })
  const host = await start(team)
  t.after(host.stop)
  await host.rt.moveSubscriptionBots()
  await host.rt.moveSubscriptionBots()
  assert.equal(host.saved().bots.c1.model, 'openai-codex/gpt-6.1-sol')
  assert.equal(host.saved().bots.c1.subscriptionMoved, undefined)
})

test('a second pass changes nothing after the first', async (t) => {
  const team = seed([bot('c1', 'openai-codex/gpt-6.1-sol')])
  const host = await start(team)
  t.after(host.stop)
  await until(() => host.saved().subscriptionCliMoved?.['openai-codex'] === true, { label: 'the move ran' })
  const before = host.saved()
  await host.rt.moveSubscriptionBots()
  const after = host.saved()
  assert.equal(after.bots.c1.model, 'acp-codex/gpt-6.1-sol')
  assert.deepEqual(after.subscriptionCliMoved, before.subscriptionCliMoved)
  assert.deepEqual(after.bots.c1.subscriptionMoved, before.bots.c1.subscriptionMoved)
})

// The move, the model menu (providers.js routeAuth) and Connect AI (through
// omniTeam.anthropicSubscription) read anthropic's route by one rule: they never disagree.
test('the move and the model menu agree on whether anthropic\'s route is the Claude plan', async () => {
  const { anthropicSubscription } = await import('../src/host/subscription-move.js')
  const { install: installProviders } = await import('../src/host/providers.js')
  for (const [records, keys, plan] of [
    [{ 'llm-pi-ai/anthropic': 'grant' }, [], true],
    [{ 'llm-pi-ai/anthropic': 'grant' }, ['ANTHROPIC_API_KEY'], false],
    [{ 'llm-pi-ai/anthropic': 'api-key' }, [], false],
    [{}, ['ANTHROPIC_API_KEY'], false],
  ]) {
    const services = { settings: piSettings({ anthropic: {} }), credentials: fakeCredentials({ records, keys }) }
    const ctx = {
      get: name => services[name],
      llm: { listConfigurableProviders: () => [{ provider: 'anthropic', displayName: 'Anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], nativeAuth: { env: ['ANTHROPIC_API_KEY'], oauth: true } }] },
    }
    const rt = { ctx, state: { bots: {} } }
    installProviders(rt)
    const why = JSON.stringify([records, keys])
    assert.equal(await anthropicSubscription(ctx), plan, why)
    assert.equal((await rt.routeAuth(['anthropic'])).get('anthropic').via, plan ? 'signin' : 'key', why)
  }
})

// #868: the move waits for the CLI's sign-in, and Codex has a way back.
// These tests start a team whose DSH still holds the ChatGPT grant: the way back needs it.
const gated = (team, options = {}) => start(team, { records: { 'llm-pi-ai/anthropic': 'grant', 'llm-pi-ai/openai-codex': 'grant' }, ...options })
// A test that mocks the clock gets its own ceiling: `until` reads that clock, so a wait that
// never holds would not end by itself.
const MOCKED_CLOCK_MS = 30_000
const SOL = 'openai-codex/gpt-6.1-sol'
const ON_CODEX = 'acp-codex/gpt-6.1-sol'
const signedOutCodex = () => fakeAgents({ 'acp-codex': { ...READY, signedIn: false } })

test('Codex signed out: no Bot moves, nothing is written or selected, and the Bot still answers on its model', async (t) => {
  const team = seed([
    bot('c1', SOL, { effort: 'high', appliedModel: SOL, previousModel: SOL }),
    bot('d1', 'deepseek/deepseek-v4-flash', { previousModel: 'openai-codex/gpt-6-astra' }),
  ])
  // No Claude route here, so no pass has anything to mark for it either.
  const host = await gated(team, { agents: signedOutCodex(), providers: ['deepseek', 'openai-codex', 'acp-codex'] })
  t.after(host.stop)
  await host.pass()
  assert.deepEqual(moveState(host.saved()), moveState(team))
  assert.equal(host.saved().subscriptionCliMoved, undefined)
  assert.deepEqual(host.selected, [])
  assert.deepEqual(host.rt.subscriptionWaitingView(), { subscriptionWaiting: { 'openai-codex': { to: 'acp-codex', cli: 'Codex', reason: 'sign-in' } } })
  // The client reads it from the state answer, changed or not.
  const answer = (await host.call('state')).value
  assert.deepEqual(answer.subscriptionWaiting, { 'openai-codex': { to: 'acp-codex', cli: 'Codex', reason: 'sign-in' } })
  assert.deepEqual((await host.call('state', { since: answer.revision, models: answer.modelsKey })).value.subscriptionWaiting, answer.subscriptionWaiting)
  // One turn of the Bot's chat: it runs on the route that still answers, never on Codex.
  const after = await host.turn('c1')
  assert.equal(after.lastAnswer.ref, SOL)
  assert.equal(after.answered, true)
  assert.equal(after.lastFailure, undefined)
  assert.equal(host.saved().bots.c1.model, SOL)
})

test('a Codex whose sign-in or CLI cannot be read moves no one and marks nothing', async (t) => {
  for (const [label, agents, reason] of [
    ['sign-in unknown', fakeAgents({ 'acp-codex': { ...READY, signedIn: undefined } }), 'checking'],
    ['the check fails', fakeAgents({ 'acp-codex': { ...READY, throws: true } }), 'checking'],
    ['an acp-dsh with no inspect', fakeAgents({}, { inspect: false }), 'checking'],
    ['the CLI missing', fakeAgents({ 'acp-codex': { on: true, connector: 'no-cli', cli: 'missing' } }), 'cli'],
    ['the CLI installing', fakeAgents({ 'acp-codex': { on: true, connector: 'no-cli', cli: 'installing' } }), 'cli'],
    ['the connector installing', fakeAgents({ 'acp-codex': { ...READY, connector: 'installing' } }), 'cli'],
    ['Codex turned off', fakeAgents({ 'acp-codex': { ...READY, on: false } }), 'cli'],
  ]) {
    const team = seed([bot('c1', SOL)])
    const host = await gated(team, { agents })
    t.after(host.stop)
    await host.pass()
    await host.pass()
    assert.deepEqual(moveState(host.saved()), moveState(team), label)
    assert.deepEqual(host.selected, [], label)
    assert.equal(host.rt.subscriptionWaitingView().subscriptionWaiting['openai-codex'].reason, reason, label)
  }
})

test('a sign-in acp-dsh announces moves the waiting Bots with no timer; another agent\'s does not', async (t) => {
  const agents = signedOutCodex()
  const host = await gated(seed([bot('c1', SOL)]), { agents })
  t.after(host.stop)
  await host.pass()
  agents.state['acp-codex'].signedIn = true
  const asked = agents.calls.inspect
  // An agent that is not a plan's CLI: nothing is asked and nothing moves.
  host.ctx.emit('acp-dsh/login-ready', { id: 'acp-other' })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(agents.calls.inspect, asked)
  assert.equal(host.saved().bots.c1.model, SOL)
  // Only this event can move the Bot here: no pass is asked for and no timer is due.
  host.ctx.emit('acp-dsh/login-ready', { id: 'acp-codex' })
  await until(() => host.saved().bots.c1.model === ON_CODEX, { label: 'the move ran on the sign-in' })
  assert.ok(agents.calls.inspect > asked)
  assert.equal(host.saved().subscriptionCliMoved['openai-codex'], true)
  assert.deepEqual(host.rt.subscriptionWaitingView(), {})
  assert.equal('subscriptionWaiting' in (await host.call('state')).value, false)
})

// A team the move took and an answer confirmed, with a group seat for c1 and a Bot whose
// `previousModel` alone moved.
const settledTeam = () => seed([
  movedBot('c1', movedRecord({ from: { model: SOL, effort: 'high', previousModel: SOL }, previousTarget: ON_CODEX, confirmed: true }), { effort: 'high', appliedEffort: 'high' }),
  bot('d1', 'deepseek/deepseek-v4-flash', {
    previousModel: 'acp-codex/default',
    subscriptionMoved: { previousOnly: true, from: { previousModel: 'openai-codex/gpt-6-astra' }, previousTarget: 'acp-codex/default', confirmed: true },
  }),
], { ...MOVED, rooms: { r1: { id: 'r1', name: 'Room', members: ['c1'], sessions: { c1: 'g-c1' }, createdAt: 1 } } })

test('a settled team with Codex ready asks the CLI nothing; Codex read gone again a minute later restores it, and a ready Codex moves it again', { timeout: MOCKED_CLOCK_MS }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const turns = async () => { for (let turn = 0; turn < 50; turn += 1) await immediate() }
  const agents = fakeAgents()
  const team = settledTeam()
  const host = await gated(team, { agents })
  t.after(host.stop)
  await host.pass()
  await host.pass()
  assert.equal(agents.calls.inspect, 0)
  assert.ok(agents.calls.status > 0)
  assert.deepEqual(moveState(host.saved()), moveState(team))
  assert.deepEqual(host.selected, [])

  // Turned off: its route goes too. One reading is not enough, and neither is the burst of
  // passes one settings write sets off (the write, then acp-dsh publishing its routes).
  agents.state['acp-codex'].on = false
  host.routes.list = host.routes.list.filter(id => id !== 'acp-codex')
  await host.pass()
  host.ctx.emit('settings/document-updated', {})
  host.ctx.emit('llm/adapters-updated', {})
  await turns()
  await host.pass()
  t.mock.timers.tick(RETRY_MS - 1)
  await turns()
  await host.pass()
  assert.deepEqual(moveState(host.saved()), moveState(team))
  assert.deepEqual(host.selected, [])
  // Still gone a minute after the first reading: the pass the move scheduled restores.
  t.mock.timers.tick(1)
  await until(() => host.saved().bots.c1.appliedModel === SOL, { label: 'the restored model was applied', poll: immediate })
  let { bots, subscriptionCliMoved } = host.saved()
  assert.equal(bots.c1.model, SOL)
  assert.equal(bots.c1.effort, 'high')
  assert.equal(bots.c1.previousModel, SOL)
  assert.equal(bots.c1.subscriptionMoved, undefined)
  assert.equal(bots.d1.previousModel, 'openai-codex/gpt-6-astra')
  assert.equal(bots.d1.subscriptionMoved, undefined)
  assert.equal(subscriptionCliMoved['openai-codex'], undefined)
  assert.equal(subscriptionCliMoved.anthropic, true)
  // The Bot's chat and its group seat both select the restored model.
  assert.deepEqual(selections(host), [`c1:${SOL}`, `g-c1:${SOL}`])
  assert.equal(agents.calls.inspect, 0)
  assert.equal(host.rt.subscriptionWaitingView().subscriptionWaiting['openai-codex'].reason, 'cli')
  assert.equal((await host.turn('c1')).lastAnswer.ref, SOL)

  agents.state['acp-codex'].on = true
  host.routes.list.push('acp-codex')
  host.selected.length = 0
  host.ctx.emit('llm/adapters-updated', {})
  await until(() => host.saved().bots.c1.appliedModel === ON_CODEX, { label: 'the move ran again', poll: immediate })
  ;({ bots, subscriptionCliMoved } = host.saved())
  assert.equal(bots.c1.model, ON_CODEX)
  assert.equal(bots.c1.subscriptionMoved.confirmed, undefined)
  assert.equal(bots.d1.previousModel, 'acp-codex/default')
  assert.equal(subscriptionCliMoved['openai-codex'], true)
  assert.deepEqual(selections(host), [`c1:${ON_CODEX}`, `g-c1:${ON_CODEX}`])
})

test('Codex gone at the first pass after a start restores at once; a failed CLI install is gone too', async (t) => {
  for (const [label, row] of [
    ['turned off', { ...READY, on: false }],
    ['its CLI install failed', { on: true, connector: 'no-cli', cli: 'failed' }],
  ]) {
    const host = await gated(settledTeam(), { agents: fakeAgents({ 'acp-codex': row }) })
    t.after(host.stop)
    await until(() => host.saved().bots.c1.model === SOL, { label: `restored (${label})` })
    assert.equal(host.saved().subscriptionCliMoved['openai-codex'], undefined, label)
  }
  // Without a host positively declaring shared scope there is no legacy restoration.
  const host = await gated(settledTeam(), { agents: null, providers: ['deepseek', 'openai-codex'] })
  t.after(host.stop)
  for (let pass = 0; pass < 3; pass++) await host.pass()
  assert.equal(host.saved().bots.c1.model, settledTeam().bots.c1.model)
})

test('isolated sign-out keeps an unconfirmed Bot on its chosen model and history', async t => {
  const agents = fakeAgents({ 'acp-codex': { ...READY, signedIn: false } })
  agents.service.authScope = 'isolated'
  const team = seed([movedBot('c1', movedRecord({ confirmed: false }))], MOVED)
  const host = await gated(team, { agents,
    records: { 'llm-pi-ai/openai-codex': 'grant' } })
  t.after(host.stop)
  for (let pass = 0; pass < 3; pass++) await host.pass()
  assert.equal(host.saved().bots.c1.model, team.bots.c1.model)
  assert.equal(host.saved().bots.c1.sessionId, team.bots.c1.sessionId)
  assert.deepEqual(host.selected, [])
})

test('a CLI that is missing, installing or not yet read never restores a confirmed Bot', async (t) => {
  for (const [label, row] of [
    ['the CLI missing', { on: true, connector: 'no-cli', cli: 'missing' }],
    ['the CLI installing', { on: true, connector: 'no-cli', cli: 'installing' }],
    ['the connector installing', { ...READY, connector: 'installing' }],
    ['the connector failed', { ...READY, connector: 'failed' }],
    ['signed out', { ...READY, signedIn: false }],
  ]) {
    const agents = fakeAgents({ 'acp-codex': row })
    const team = settledTeam()
    const host = await gated(team, { agents })
    t.after(host.stop)
    for (let pass = 0; pass < 3; pass += 1) await host.pass()
    assert.deepEqual(moveState(host.saved()), moveState(team), label)
    assert.deepEqual(host.selected, [], label)
    assert.equal(agents.calls.inspect, 0, label)
  }
})

test('the way back keeps a person\'s pick: a re-pointed Bot stays, a changed level is kept', async (t) => {
  const team = seed([
    bot('c1', 'deepseek/deepseek-v4-flash', { subscriptionMoved: movedRecord({ confirmed: true }) }),
    movedBot('c2', movedRecord({ from: { model: SOL, effort: 'high' }, confirmed: true }), { effort: 'low' }),
  ], MOVED)
  const host = await gated(team, { agents: fakeAgents({ 'acp-codex': { ...READY, on: false } }) })
  t.after(host.stop)
  await until(() => host.saved().bots.c2.model === SOL, { label: 'restored' })
  const { bots } = host.saved()
  assert.equal(bots.c1.model, 'deepseek/deepseek-v4-flash')
  assert.equal(bots.c1.subscriptionMoved, undefined)
  assert.equal(bots.c2.effort, 'low')
  assert.equal(bots.c2.previousModel, SOL)
})

test('a team v3.109.1 moved onto a signed-out Codex is repaired at the first pass, and keeps its model through later edits', async (t) => {
  const host = await gated(seed([movedBot('c1')], MOVED), { agents: signedOutCodex() })
  t.after(host.stop)
  await until(() => host.saved().bots.c1.appliedModel === SOL, { label: 'the repair ran' })
  let state = host.saved()
  assert.equal(state.bots.c1.model, SOL)
  assert.equal(state.bots.c1.previousModel, SOL)
  assert.equal(state.bots.c1.subscriptionMoved, undefined)
  assert.equal(state.subscriptionCliMoved['openai-codex'], undefined)
  assert.equal(host.rt.subscriptionWaitingView().subscriptionWaiting['openai-codex'].reason, 'sign-in')
  assert.equal((await host.turn('c1')).lastFailure, undefined)
  // The exception to "a plan runs only through its CLI": the Bot's own model is kept.
  await host.rt.updateBot('c1', { name: 'Renamed' })
  await host.rt.updateBot('c1', { model: SOL })
  state = host.saved()
  assert.equal(state.bots.c1.name, 'Renamed')
  assert.equal(state.bots.c1.model, SOL)
})

test('no repair without a route to go back to: the ChatGPT grant or its route gone', async (t) => {
  for (const [label, options] of [
    ['no grant', { records: {} }],
    ['an api-key record', { records: { 'llm-pi-ai/openai-codex': 'api-key' } }],
    ['the route not registered', { providers: ['deepseek', 'acp-codex'] }],
  ]) {
    const host = await gated(seed([movedBot('c1')], MOVED), { agents: signedOutCodex(), ...options })
    t.after(host.stop)
    await host.pass()
    await host.pass()
    const state = host.saved()
    assert.equal(state.bots.c1.model, ON_CODEX, label)
    assert.deepEqual(state.bots.c1.subscriptionMoved, movedRecord(), label)
    assert.equal(state.subscriptionCliMoved['openai-codex'], true, label)
  }
})

test('a record is confirmed by a sign-in read newer than the move, never by one that may be older', async (t) => {
  // v3.109.1 wrote no time: that move was made by an earlier process.
  const old = await gated(seed([movedBot('c1')], MOVED))
  t.after(old.stop)
  await until(() => old.saved().bots.c1.subscriptionMoved.confirmed === true, { label: 'the older record was confirmed' })
  const { revision } = old.saved()
  await old.pass()
  assert.equal(old.saved().revision, revision)
  assert.equal(old.saved().bots.c1.model, ON_CODEX)

  const late = await gated(seed([movedBot('c1')], { ...MOVED, subscriptionMovedAt: { 'openai-codex': Date.now() - CONFIRM_AFTER_MS - 1 } }))
  t.after(late.stop)
  await until(() => late.saved().bots.c1.subscriptionMoved.confirmed === true, { label: 'the late read confirmed' })

  const early = await gated(seed([movedBot('c1')], { ...MOVED, subscriptionMovedAt: { 'openai-codex': Date.now() } }))
  t.after(early.stop)
  await early.pass()
  await early.pass()
  assert.equal(early.saved().bots.c1.subscriptionMoved.confirmed, undefined)
  assert.equal(early.saved().bots.c1.model, ON_CODEX)
})

test('ready at the check, signed out before the first turn: the move is undone', async (t) => {
  const agents = fakeAgents()
  const host = await gated(seed([bot('c1', SOL, { previousModel: SOL })]), { agents })
  t.after(host.stop)
  await until(() => host.saved().bots.c1.appliedModel === ON_CODEX, { label: 'the move ran' })
  assert.equal(host.saved().bots.c1.subscriptionMoved.confirmed, undefined)
  // The person signs out in a terminal; acp-dsh's kept answer then expires or is dropped.
  agents.state['acp-codex'].signedIn = false
  host.ctx.emit('llm/adapters-updated', {})
  await until(() => host.saved().bots.c1.appliedModel === SOL, { label: 'the move was undone' })
  const state = host.saved()
  assert.equal(state.bots.c1.model, SOL)
  assert.equal(state.bots.c1.previousModel, SOL)
  assert.equal(state.subscriptionCliMoved['openai-codex'], undefined)
  const after = await host.turn('c1')
  assert.equal(after.lastAnswer.ref, SOL)
  assert.equal(after.lastFailure, undefined)
})

test('an answer on Codex confirms the move: a later sign-out leaves the Bot there', async (t) => {
  const agents = fakeAgents()
  const host = await gated(seed([bot('c1', SOL, { previousModel: SOL })]), { agents })
  t.after(host.stop)
  await until(() => host.saved().bots.c1.appliedModel === ON_CODEX, { label: 'the move ran' })
  assert.equal((await host.turn('c1')).lastAnswer.ref, ON_CODEX)
  // The next pass reads that answer before it reads the sign-in, which is gone by then.
  agents.state['acp-codex'].signedIn = false
  const asked = agents.calls.inspect
  await host.pass()
  assert.equal(host.saved().bots.c1.subscriptionMoved.confirmed, true)
  await host.pass()
  assert.equal(host.saved().bots.c1.model, ON_CODEX)
  assert.equal(host.saved().subscriptionCliMoved['openai-codex'], true)
  assert.equal(agents.calls.inspect, asked)
})

test('an answer on Codex from before the move confirms nothing', async (t) => {
  // Codex's sign-in cannot be read yet, so the first pass moves no one.
  const agents = fakeAgents({ 'acp-codex': { ...READY, signedIn: undefined } })
  const host = await gated(seed([bot('c1', SOL)]), { agents })
  t.after(host.stop)
  await host.pass()
  // The last answer in the Bot's chat is from Codex, from when the person had it there.
  const event = { type: 'assistant/message', data: { message: { source: { provider: 'acp-codex', model: 'gpt-6.1-sol' } } } }
  for (const listener of host.ctx.listeners.get('session/event') ?? []) listener({ id: host.rt.chatOf('c1') }, event)
  assert.equal(host.rt.modelStateView().c1.lastAnswer.ref, ON_CODEX)
  await new Promise(resolve => setTimeout(resolve, 5))
  agents.state['acp-codex'].signedIn = true
  await host.pass()
  assert.equal(host.saved().bots.c1.model, ON_CODEX)
  assert.equal(host.saved().bots.c1.subscriptionMoved.confirmed, undefined)
  agents.state['acp-codex'].signedIn = false
  await host.pass()
  await until(() => host.saved().bots.c1.model === SOL, { label: 'the unconfirmed move was undone' })
})

test('the move records what the way back needs, and no more for Claude', async (t) => {
  const team = seed([
    // A pending switch from another ChatGPT model: what it would go back to is not its model.
    bot('c1', SOL, { previousModel: 'openai-codex/gpt-6-astra' }),
    bot('c2', SOL, { previousModel: SOL }),
    bot('d1', 'deepseek/deepseek-v4-flash', { previousModel: 'openai-codex/gpt-6-astra' }),
    bot('a1', 'anthropic/claude-opus-5-5', { previousModel: 'anthropic/claude-sonnet-5-5' }),
  ])
  const agents = fakeAgents()
  const host = await gated(team, { agents })
  t.after(host.stop)
  await until(() => host.saved().subscriptionCliMoved?.['openai-codex'] === true && host.saved().subscriptionCliMoved.anthropic === true, { label: 'both routes moved' })
  const state = host.saved()
  assert.deepEqual(state.bots.c1.subscriptionMoved, { from: { model: SOL, previousModel: 'openai-codex/gpt-6-astra' }, target: ON_CODEX, previousTarget: 'acp-codex/default' })
  assert.deepEqual(state.bots.c2.subscriptionMoved, { from: { model: SOL }, target: ON_CODEX })
  assert.deepEqual(state.bots.d1.subscriptionMoved, { previousOnly: true, from: { previousModel: 'openai-codex/gpt-6-astra' }, previousTarget: 'acp-codex/default' })
  assert.deepEqual(state.bots.a1.subscriptionMoved, { from: { model: 'anthropic/claude-opus-5-5' }, target: 'acp-claude/opus' })
  assert.equal(typeof state.subscriptionMovedAt['openai-codex'], 'number')
  assert.equal(state.subscriptionMovedAt.anthropic, undefined)
  // Signed out before any answer: every Bot is back on exactly what it had.
  agents.state['acp-codex'].signedIn = false
  await host.pass()
  await until(() => host.saved().bots.c2.model === SOL, { label: 'the move was undone' })
  const back = host.saved()
  for (const id of ['c1', 'c2', 'd1']) {
    assert.equal(back.bots[id].model, team.bots[id].model, id)
    assert.equal(back.bots[id].previousModel, team.bots[id].previousModel, id)
    assert.equal(back.bots[id].subscriptionMoved, undefined, id)
  }
  assert.equal(back.subscriptionMovedAt['openai-codex'], undefined)
  assert.equal(back.bots.a1.model, 'acp-claude/opus')
})

test('Claude Code signed out: no Claude plan Bot moves and nothing is marked', async (t) => {
  const team = seed([bot('a1', 'anthropic/claude-opus-5-5')])
  const agents = fakeAgents({ 'acp-claude': { ...READY, signedIn: false } })
  const host = await gated(team, { agents })
  t.after(host.stop)
  await until(() => host.saved().subscriptionCliMoved?.['openai-codex'] === true, { label: 'the codex route was marked' })
  await host.pass()
  const state = host.saved()
  assert.deepEqual(moveState(state).bots, moveState(team).bots)
  assert.equal(state.subscriptionCliMoved.anthropic, undefined)
  assert.deepEqual(host.rt.subscriptionWaitingView(), { subscriptionWaiting: { anthropic: { to: 'acp-claude', cli: 'Claude Code', reason: 'sign-in' } } })
  agents.state['acp-claude'].signedIn = true
  host.ctx.emit('acp-dsh/login-ready', { id: 'acp-claude' })
  await until(() => host.saved().bots.a1.model === 'acp-claude/opus', { label: 'the move ran on the sign-in' })
})

test('a team with no Bot on the route, or only Bots a plugin answers for, is marked done with nothing asked', async (t) => {
  const agents = signedOutCodex()
  const team = seed([bot('d1', 'deepseek/deepseek-v4-flash'), bot('h1', SOL)])
  const host = await gated(team, { agents, prepare: (rt) => { rt.hostOwned = entry => entry?.id === 'h1' } })
  t.after(host.stop)
  await until(() => host.saved().subscriptionCliMoved?.['openai-codex'] === true, { label: 'the route was marked' })
  await host.pass()
  assert.equal(agents.calls.inspect, 0)
  assert.equal(agents.calls.status, 0)
  assert.equal(host.saved().bots.h1.model, SOL)
  assert.deepEqual(host.rt.subscriptionWaitingView(), {})
})

test('a sign-in that cannot be read is asked again after 1, 5 and 30 minutes, then not until something changes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const agents = fakeAgents({ 'acp-codex': { ...READY, signedIn: undefined } })
  const host = await gated(seed([bot('c1', SOL)]), { agents })
  t.after(host.stop)
  const asked = count => until(() => agents.calls.inspect === count, { label: `${count} checks`, poll: immediate })
  await asked(1)
  await host.pass()
  let count = agents.calls.inspect
  for (const ms of CHECK_BACKOFF_MS) {
    t.mock.timers.tick(ms - 1)
    for (let turn = 0; turn < 20; turn += 1) await immediate()
    assert.equal(agents.calls.inspect, count)
    t.mock.timers.tick(1)
    await asked(count += 1)
    await host.rt.load()
  }
  t.mock.timers.tick(24 * 60 * 60_000)
  for (let turn = 0; turn < 20; turn += 1) await immediate()
  assert.equal(agents.calls.inspect, count)
  // An event looks once and does not start the three again: frequent events never turn into
  // a look every minute.
  host.ctx.emit('settings/document-updated', {})
  await asked(count += 1)
  await host.rt.load()
  t.mock.timers.tick(24 * 60 * 60_000)
  for (let turn = 0; turn < 20; turn += 1) await immediate()
  assert.equal(agents.calls.inspect, count)
  // A definite answer does: the next sign-in that cannot be read gets its three looks.
  agents.state['acp-codex'].signedIn = false
  host.ctx.emit('settings/document-updated', {})
  await asked(count += 1)
  await host.rt.load()
  agents.state['acp-codex'].signedIn = undefined
  host.ctx.emit('settings/document-updated', {})
  await asked(count += 1)
  t.mock.timers.tick(CHECK_BACKOFF_MS[0])
  await asked(count + 1)
  assert.equal(host.saved().bots.c1.model, SOL)
})

test('a signed-out Codex is asked again every ten minutes while Bots wait, so a terminal sign-in is found', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const agents = signedOutCodex()
  const host = await gated(seed([bot('c1', SOL)]), { agents })
  t.after(host.stop)
  await until(() => agents.calls.inspect === 1, { label: 'the first check', poll: immediate })
  for (let turn = 0; turn < 20; turn += 1) await immediate()
  t.mock.timers.tick(SIGN_IN_RECHECK_MS)
  await until(() => agents.calls.inspect === 2, { label: 'the second check', poll: immediate })
  for (let turn = 0; turn < 20; turn += 1) await immediate()
  agents.state['acp-codex'].signedIn = true
  t.mock.timers.tick(SIGN_IN_RECHECK_MS)
  await until(() => host.saved().bots.c1.model === ON_CODEX, { label: 'the move ran', poll: immediate })
})

test('an acp-dsh that publishes its routes from inside inspect cannot loop the move', async (t) => {
  const agents = signedOutCodex()
  let host
  // Capped, so a loop fails the count below instead of never ending.
  const CAP = 50
  agents.state['acp-codex'].onInspect = () => { if (agents.calls.inspect < CAP) host?.ctx.emit('llm/adapters-updated', {}) }
  host = await gated(seed([bot('c1', SOL)]), { agents })
  t.after(host.stop)
  await host.pass()
  await new Promise(resolve => setTimeout(resolve, 150))
  const settled = agents.calls.inspect
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(agents.calls.inspect, settled)
  assert.ok(settled < CAP, `asked ${settled} times`)
  // Each pass asked for gets at most one more for the echo.
  await host.pass()
  assert.ok(agents.calls.inspect - settled <= 2, `asked ${agents.calls.inspect - settled} times`)
  assert.equal(host.saved().bots.c1.model, SOL)
})

test('a lock lost during the restore\'s save leaves the file as it was and selects nothing', async (t) => {
  const team = settledTeam()
  let home
  const host = await gated(team, {
    agents: fakeAgents({ 'acp-codex': { ...READY, on: false } }),
    prepare: (rt) => {
      const save = rt.save
      rt.save = (...args) => {
        // Another dsh takes the team between the restore in memory and its save.
        if (rt.state.bots?.c1?.model === SOL) writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other' }))
        return save(...args)
      }
    },
  })
  home = host.home
  t.after(host.stop)
  await until(() => host.rt.readOnly() !== undefined, { label: 'the lock was lost' })
  await host.pass()
  assert.deepEqual(moveState(host.saved()), moveState(team))
  assert.deepEqual(host.selected, [])
})

test('a model the person picks while the pass asks the CLI is kept: the way back reads the Bot again', async (t) => {
  const agents = signedOutCodex()
  let team
  let picked = false
  // The pick lands while `inspect` runs, after the pass read c1's record as still the move's.
  agents.state['acp-codex'].onInspect = async () => {
    if (picked) return
    picked = true
    await team.updateBot('c1', { model: 'deepseek/deepseek-v4-flash' })
  }
  const host = await gated(seed([movedBot('c1'), movedBot('c2')], MOVED), { agents, prepare: (rt) => { team = rt } })
  t.after(host.stop)
  await until(() => host.saved().bots.c2.appliedModel === SOL, { label: 'the other Bot went back' })
  await host.pass()
  const { bots, subscriptionCliMoved } = host.saved()
  assert.equal(bots.c1.model, 'deepseek/deepseek-v4-flash')
  assert.equal(bots.c1.subscriptionMoved, undefined)
  assert.equal(bots.c2.model, SOL)
  assert.equal(subscriptionCliMoved['openai-codex'], undefined)
  assert.deepEqual(selections(host).filter(entry => entry.startsWith('c1:')), ['c1:deepseek/deepseek-v4-flash'])
})

test('when every Bot was re-pointed while the pass asked the CLI, nothing goes back and the route stays done', async (t) => {
  const agents = signedOutCodex()
  let team
  agents.state['acp-codex'].onInspect = () => { team.state.bots.c1.model = 'deepseek/deepseek-v4-flash' }
  const host = await gated(seed([movedBot('c1')], MOVED), { agents, prepare: (rt) => { team = rt } })
  t.after(host.stop)
  await until(() => host.saved().bots.c1.subscriptionMoved === undefined, { label: 'the record was dropped' })
  await host.pass()
  assert.equal(host.saved().bots.c1.model, 'deepseek/deepseek-v4-flash')
  assert.equal(host.saved().subscriptionCliMoved['openai-codex'], true)
  assert.deepEqual(host.selected, [])
})

test('a model picked while the restore is being saved is not selected over', async (t) => {
  const host = await gated(seed([movedBot('c1'), movedBot('c2')], MOVED), {
    agents: signedOutCodex(),
    prepare: (rt) => {
      const save = rt.save
      rt.save = async (...args) => {
        const restored = rt.state.bots?.c1?.model === SOL
        await save(...args)
        if (restored) rt.state.bots.c1.model = 'deepseek/deepseek-v4-flash'
      }
    },
  })
  t.after(host.stop)
  await until(() => host.saved().bots.c2.appliedModel === SOL, { label: 'the other Bot went back' })
  assert.deepEqual(selections(host), [`c2:${SOL}`])
})

test('a v3.109.1 record whose other previous model went to Codex unrecorded leaves no switch back to Codex', async (t) => {
  // v3.109.1 moved `previousModel` (here from gpt-6-astra) and recorded only the model.
  const team = seed([movedBot('c1', movedRecord(), { previousModel: 'acp-codex/default' })], MOVED)
  const host = await gated(team, { agents: signedOutCodex() })
  t.after(host.stop)
  await until(() => host.saved().bots.c1.appliedModel === SOL, { label: 'the repair ran' })
  assert.equal(host.saved().bots.c1.model, SOL)
  assert.equal(host.saved().bots.c1.previousModel, SOL)
  // No switch is pending, so a failed turn has no signed-out Codex to send the Bot back to.
  assert.equal(host.rt.revertModel(host.rt.botOf('c1'), { code: 'SWITCH_FAILED' }), false)
  assert.equal(host.rt.botOf('c1').model, SOL)
})

test('an unconfirmed move is looked at again by its own timer: a sign-out by then undoes it, a sign-in confirms it', { timeout: MOCKED_CLOCK_MS }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  for (const [label, signedIn] of [['signed out', false], ['still signed in', true]]) {
    const agents = fakeAgents()
    const host = await gated(seed([bot('c1', SOL, { previousModel: SOL })]), { agents })
    t.after(host.stop)
    await until(() => host.saved().bots.c1.appliedModel === ON_CODEX, { label: `the move ran (${label})`, poll: immediate })
    assert.equal(host.saved().bots.c1.subscriptionMoved.confirmed, undefined, label)
    for (let turn = 0; turn < 50; turn += 1) await immediate()
    // No event and no pass asked for: only the look the move scheduled.
    agents.state['acp-codex'].signedIn = signedIn
    const asked = agents.calls.inspect
    t.mock.timers.tick(CONFIRM_AFTER_MS - 1)
    for (let turn = 0; turn < 50; turn += 1) await immediate()
    assert.equal(agents.calls.inspect, asked, label)
    t.mock.timers.tick(1)
    if (signedIn) await until(() => host.saved().bots.c1.subscriptionMoved?.confirmed === true, { label: 'the move was confirmed', poll: immediate })
    else await until(() => host.saved().bots.c1.appliedModel === SOL, { label: 'the move was undone', poll: immediate })
    assert.equal(host.saved().bots.c1.model, signedIn ? ON_CODEX : SOL, label)
  }
})

test('an acp-dsh whose status cannot be read is not a Codex that is gone: no Bot goes back', async (t) => {
  const agents = fakeAgents()
  agents.service.status = async () => { throw new Error('acp-dsh did not answer') }
  const team = settledTeam()
  const host = await gated(team, { agents })
  t.after(host.stop)
  for (let pass = 0; pass < 3; pass += 1) await host.pass()
  assert.deepEqual(moveState(host.saved()), moveState(team))
  assert.deepEqual(host.selected, [])
})

test('why the Bots wait is logged once per reason, not once per pass', async (t) => {
  const agents = signedOutCodex()
  const lines = []
  const host = await gated(seed([bot('c1', SOL)]), { agents, prepare: (rt) => { rt.warn = (...line) => { lines.push(line) } } })
  t.after(host.stop)
  const waits = () => lines.filter(line => String(line[0]).includes('stay there'))
  for (let pass = 0; pass < 3; pass += 1) await host.pass()
  assert.equal(waits().length, 1)
  assert.deepEqual(waits()[0].slice(1), ['openai-codex', 'Codex', 'is not signed in'])
  agents.state['acp-codex'].signedIn = undefined
  for (let pass = 0; pass < 2; pass += 1) await host.pass()
  assert.equal(waits().length, 2)
  assert.equal(waits()[1][3], 'could not be checked')
})

test('a Bot removed while the pass asks the CLI is not restored or selected', async (t) => {
  const agents = signedOutCodex()
  let team
  agents.state['acp-codex'].onInspect = () => { delete team.state.bots.c1 }
  const host = await gated(seed([movedBot('c1'), movedBot('c2')], MOVED), { agents, prepare: (rt) => { team = rt } })
  t.after(host.stop)
  await until(() => host.saved().bots.c2.appliedModel === SOL, { label: 'the other Bot went back' })
  await host.pass()
  assert.equal(host.saved().bots.c1, undefined)
  assert.deepEqual(selections(host), [`c2:${SOL}`])
})

test('a move made just before a restart is looked at again once its sign-in read can be newer than it', { timeout: MOCKED_CLOCK_MS }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const agents = fakeAgents()
  const host = await gated(seed([movedBot('c1')], { ...MOVED, subscriptionMovedAt: { 'openai-codex': Date.now() } }), { agents })
  t.after(host.stop)
  await until(() => agents.calls.inspect > 0, { label: 'the first check', poll: immediate })
  for (let turn = 0; turn < 50; turn += 1) await immediate()
  assert.equal(host.saved().bots.c1.subscriptionMoved.confirmed, undefined)
  agents.state['acp-codex'].signedIn = false
  t.mock.timers.tick(CONFIRM_AFTER_MS)
  await until(() => host.saved().bots.c1.appliedModel === SOL, { label: 'the move was undone', poll: immediate })
})
