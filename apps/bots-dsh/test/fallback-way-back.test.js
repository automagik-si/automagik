import assert from 'node:assert/strict'
import { test } from 'node:test'
import { format } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { AgentModel, modelSelectionProjectionDefinition } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { fallbackLeftOn, fallbackNotice, install as installFallback } from '../src/host/fallback.js'
import { install as installModels } from '../src/host/models.js'
import { install as installParts } from '../src/host/parts.js'

const own = { provider: 'openai', model: 'gpt-5.4-mini', reasoningEffort: 'high' }
const fallback = { provider: 'deepseek-official', model: 'deepseek-flash' }
const other = { provider: 'openai', model: 'gpt-5.4' }
const levels = { efforts: [{ id: 'high', name: 'High' }, { id: 'low', name: 'Low' }] }
const failure = { code: 'SERVER_ERROR', message: 'Fixture quota reached' }
const failed = { kind: 'error', error: failure }
const completed = { kind: 'completed' }
const chatId = 'bot-chat'
const timeout = 10_000
const ref = ({ provider, model }) => `${provider}/${model}`
const selections = session => session.snapshotEvents().filter(event => event.type === 'model/selection')
const header = (session, route) => session.append('request/header', { header: { config: route }, reason: 'initial' })
const start = (session, turn) => session.append('turn/start', { turn })
const end = (session, turn, reason = completed) => session.append('turn/end', { turn, reason })

function agentOf(session) {
  const fold = modelSelectionProjectionDefinition
  const readState = () => session.snapshotEvents().reduce(fold.apply, fold.init())
  return { id: session.id, session, model: new AgentModel(readState, session, {}), status: 'idle' }
}

function runtime(ctx, { sessionId = chatId, model = ref(own), effort, fallbackRoute = fallback } = {}) {
  const bot = { id: 'bot', kind: 'dsh', name: 'Ops', model, effort }
  const state = { bots: { [bot.id]: bot } }
  const warnings = []
  const chatOwners = new Map([[sessionId, bot.id]])
  const rt = {
    ctx, state, config: { fallbackModel: ref(fallbackRoute) },
    chatOwners, pastOwners: new Map(), groupOwners: new Map(), roomOwners: new Map(),
    isBotSession: id => chatOwners.has(id), selfOf: id => chatOwners.get(id),
    botOf: id => state.bots[id], chatOf: () => sessionId, roomOf: () => undefined,
    workDirOf: () => undefined, isFolder: async () => true,
    load: async () => {}, readOnly: () => undefined, ownRequest: () => true,
    warn: (...args) => warnings.push(format(...args)),
  }
  installModels(rt)
  installFallback(rt)
  return { rt, bot, warnings }
}

async function bench(t, { served = [own, fallback, other], ...options } = {}) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const models = {
    listProviders: () => [...new Set(served.map(route => route.provider))].map(id => ({ id })),
    listModels: async provider => served.filter(route => route.provider === provider).map(route => ({ id: route.model })),
    resolveModelInfo: async () => ({ reasoning: levels }),
  }
  ctx.provide('llm', models)
  const agents = []
  ctx.provide('agents', { list: () => agents })
  const { rt, bot, warnings } = runtime(ctx, options)
  const session = ctx.sessions.create(chatId)
  const agent = agentOf(session)
  agents.push(agent)
  return { ctx, models, rt, bot, warnings, session, agent }
}

function recordFailure(agent, { on = own, backup = fallback, reason = failed, notice = false } = {}) {
  const { session, model } = agent
  model.select(on)
  start(session, 1)
  header(session, on)
  model.select(backup)
  const selection = selections(session).at(-1)
  if (reason === null) return selection
  end(session, 1, reason)
  if (notice) {
    start(session, 2)
    session.append('user/message', fallbackNotice(on, backup, failure), { surfaceOp: 'append' })
    header(session, backup)
    end(session, 2)
  }
  return selection
}

async function liveFallback(t) {
  const b = await bench(t)
  const { agent, ctx, session } = b
  agent.followup = t.mock.fn()
  agent.model.select(own)
  start(session, 1)
  header(session, own)
  await ctx.waterfall('agent/request-error', { agent, turn: 1, failure }, async () => undefined)
  assert.equal(agent.followup.mock.callCount(), 1)
  assert.deepEqual(agent.model.current(), fallback)
  end(session, 1, failed)
  start(session, 2)
  header(session, fallback)
  return b
}

for (const [name, pick] of [
  ['R1: an explicit Bot pick of the fallback stays even when DSH deduplicates it', ({ bot, agent }) => {
    bot.model = ref(fallback)
    agent.model.select(fallback)
  }],
  ['R2: an effort-only pick on the fallback stays', ({ agent }) => {
    agent.model.select({ ...fallback, reasoningEffort: 'low' })
  }],
]) {
  test(name, { timeout }, async t => {
    const b = await liveFallback(t)
    pick(b)
    const before = selections(b.session)
    end(b.session, 2)
    await Promise.resolve()
    assert.deepEqual(selections(b.session), before)
    assert.equal(b.warnings.some(warning => warning.includes('not restored')), false)
  })
}

test('R3: a selection made before the restore microtask stays', { timeout }, async t => {
  const { session, agent, warnings } = await liveFallback(t)
  const select = t.mock.method(agent.model, 'select')
  end(session, 2)
  assert.equal(select.mock.callCount(), 1, 'tried synchronously inside publication')
  agent.model.select(other)
  await Promise.resolve()
  assert.equal(select.mock.callCount(), 2, 'no retry after the new selection')
  assert.deepEqual(agent.model.current(), other)
  assert.equal(warnings.some(warning => warning.includes('not restored')), false)
})

test('L-err: a different selection error warns once without a retry', { timeout }, async t => {
  const { session, agent, warnings } = await liveFallback(t)
  const select = t.mock.method(agent.model, 'select', () => { throw new Error('fixture selection refusal') })
  const before = selections(session)
  end(session, 2)
  await Promise.resolve()
  assert.equal(select.mock.callCount(), 1)
  assert.deepEqual(selections(session), before)
  const restoreWarnings = warnings.filter(warning => warning.includes('not restored'))
  assert.equal(restoreWarnings.length, 1)
  assert.match(restoreWarnings[0], /fixture selection refusal/)
})

async function leavesSelectionAlone({ rt, agent, session }) {
  const before = selections(session)
  await rt.resumeFallbackWayBack(agent)
  assert.deepEqual(selections(session), before)
}

test('R1: recovery preserves the saved fallback even when it is unserved', { timeout }, async t => {
  const b = await bench(t, { model: ref(fallback), served: [other] })
  recordFailure(b.agent)
  assert.equal(await b.rt.desiredModel(b.bot), ref(other))
  await leavesSelectionAlone(b)
})

test('R4: a Session without a current owner is left alone', { timeout }, async t => {
  const b = await bench(t)
  recordFailure(b.agent)
  b.rt.chatOwners.delete(chatId)
  await leavesSelectionAlone(b)
  b.rt.isBotSession = () => true
  await leavesSelectionAlone(b)
})

test('R5: a Bot with no saved model leaves the Session alone', { timeout }, async t => {
  const b = await bench(t)
  recordFailure(b.agent)
  delete b.bot.model
  await leavesSelectionAlone(b)
})

test('R6: resolution to the same fallback route leaves the Session alone', { timeout }, async t => {
  const b = await bench(t, { served: [fallback], effort: 'high' })
  recordFailure(b.agent)
  assert.equal(await b.rt.desiredModel(b.bot), ref(fallback))
  await leavesSelectionAlone(b)
})

test('R7: the legacy Claude to DeepSeek failover does not return across harnesses', { timeout }, async t => {
  const legacy = { provider: 'acp-claude', model: 'opus', reasoningEffort: 'medium' }
  const b = await bench(t, { model: ref(legacy), served: [legacy, fallback] })
  recordFailure(b.agent, { on: legacy, notice: true })
  const before = b.session.snapshotEvents()
  assert.ok(fallbackLeftOn(before))
  await leavesSelectionAlone(b)
  assert.deepEqual(b.session.snapshotEvents(), before)
})

test('R8: the Bot runner refusal is rechecked at the write', { timeout }, async t => {
  // The legacy CLI provider counts as command-capable while sharing the DSH harness.
  const cli = { provider: 'codex-cli', model: 'default' }
  const b = await bench(t, { model: ref(cli), served: [cli, fallback] })
  recordFailure(b.agent)
  let required = false
  b.rt.botRunnerRequired = () => required
  const listModels = b.models.listModels
  b.models.listModels = async provider => {
    required = true
    return listModels(provider)
  }
  await leavesSelectionAlone(b)
  assert.equal(required, true)
})

test('R9: Full access stays on an unserved coding CLI', { timeout }, async t => {
  const b = await bench(t, { model: 'acp-codex/default', served: [other] })
  recordFailure(b.agent)
  b.rt.sessionWide = (id, session) => id === chatId && session === b.session
  await leavesSelectionAlone(b)
  assert.ok(b.warnings.some(warning => warning.includes('stays on it where it has Full access')))
})

test('R10: a carried Hermes route stays on its model', { timeout }, async t => {
  const attach = { provider: 'hermes-remote', model: 'attach' }
  const carried = { provider: 'hermes-remote', model: 'carried' }
  const b = await bench(t, { model: ref(attach), served: [attach, carried] })
  recordFailure(b.agent, { on: attach, backup: carried, notice: true })
  assert.equal(await b.rt.keepsCarriedRoute(chatId, ref(attach)), true)
  await leavesSelectionAlone(b)
})

test('R11: an existing live return is found by Session id', { timeout }, async t => {
  const b = await bench(t)
  recordFailure(b.agent)
  const liveAgent = { ...b.agent, id: 'distinct-agent', followup: t.mock.fn() }
  b.rt.isBotSession = id => id === chatId || id === liveAgent.id
  // Without the turn number the request-error hook tracks the restore alone.
  await b.ctx.waterfall('agent/request-error', { agent: liveAgent, failure }, async () => undefined)
  assert.equal(liveAgent.followup.mock.callCount(), 1)
  assert.equal(b.rt.fallbackArmed(chatId), false)
  await leavesSelectionAlone(b)
})

for (const [name, makeHistory] of [
  ['an aborted turn', b => recordFailure(b.agent, { reason: { kind: 'aborted' } })],
  ['a turn with no end', b => recordFailure(b.agent, { reason: null })],
  ['a request already on the fallback', b => {
    b.agent.model.select(own)
    start(b.session, 1)
    header(b.session, fallback)
    b.agent.model.select(fallback)
    end(b.session, 1, failed)
  }],
  ['a later selection', b => {
    recordFailure(b.agent)
    b.agent.model.select({ ...fallback, reasoningEffort: 'low' })
  }],
]) {
  test(`R12: ${name} is not evidence of a fallback to undo`, { timeout }, async t => {
    const b = await bench(t)
    makeHistory(b)
    assert.equal(fallbackLeftOn(b.session.snapshotEvents()), undefined)
    await leavesSelectionAlone(b)
  })
}

test('R12: changed evidence during model resolution prevents the write', { timeout }, async t => {
  const b = await bench(t)
  recordFailure(b.agent)
  const listModels = b.models.listModels
  const pick = { ...fallback, reasoningEffort: 'low' }
  b.models.listModels = async provider => {
    b.agent.model.select(pick)
    return listModels(provider)
  }
  await b.rt.resumeFallbackWayBack(b.agent)
  assert.equal(selections(b.session).length, 3)
  assert.deepEqual(b.agent.model.current(), pick)
})

for (const owner of [undefined, 'new-owner']) {
  test(`R-owner: ownership changing to ${owner ?? 'a past part'} during resolution prevents the write`, { timeout }, async t => {
    const b = await bench(t)
    recordFailure(b.agent)
    const listModels = b.models.listModels
    b.rt.state.bots['new-owner'] = { id: 'new-owner', name: 'New owner', model: ref(other) }
    b.models.listModels = async provider => {
      if (owner === undefined) {
        // An archived part still has an owner via selfOf.
        b.rt.isBotSession = () => false
      } else b.rt.chatOwners.set(chatId, owner)
      return listModels(provider)
    }
    await leavesSelectionAlone(b)
  })
}

test('R13: creation after restart restores the current Bot choice without a notice', { timeout }, async t => {
  const { ctx, rt, agent, session } = await bench(t, { model: ref(other), effort: 'Low' })
  const selection = recordFailure(agent)
  installParts(rt)
  assert.deepEqual(fallbackLeftOn(session.snapshotEvents()), { B: fallback, selectionSeq: selection.seq, failedTurn: 1 })
  await ctx.serial('agent/created', { agent, source: 'resume' })
  assert.deepEqual(agent.model.current(), { ...other, reasoningEffort: 'low' })
  assert.equal(selections(session).length, 3)
})

test('R14: a completed fallback turn with a notice is restored exactly once', { timeout }, async t => {
  const { rt, agent, session } = await bench(t, { effort: 'high' })
  recordFailure(agent, { notice: true })
  await rt.resumeFallbackWayBack(agent)
  assert.deepEqual(agent.model.current(), own)
  const before = session.snapshotEvents()
  await rt.resumeFallbackWayBack(agent)
  assert.deepEqual(session.snapshotEvents(), before)
})

test('R15: the reload scan waits for the running Agent before writing', { timeout }, async t => {
  const { rt, agent, session } = await bench(t, { effort: 'high' })
  recordFailure(agent, { notice: true })
  const waiting = Promise.withResolvers()
  const idle = Promise.withResolvers()
  agent.status = 'running'
  agent.whenIdle = () => {
    waiting.resolve()
    return idle.promise
  }
  const scan = rt.resumeFallbackWayBacks()
  await waiting.promise
  assert.equal(selections(session).length, 2)
  agent.status = 'idle'
  idle.resolve()
  await scan
  assert.deepEqual(agent.model.current(), own)
})

test('R16: a fork inherits the evidence and restores only its own route', { timeout }, async t => {
  const { ctx, rt, agent, session } = await bench(t, { sessionId: 'fork', model: ref(other) })
  recordFailure(agent)
  const fork = ctx.sessions.fork(session, undefined, 'fork')
  const forkAgent = agentOf(fork)
  installParts(rt)
  assert.equal(fork.inheritedEventCount, session.snapshotEvents().length)
  await ctx.serial('agent/created', { agent: forkAgent, source: 'compaction' })
  assert.deepEqual(forkAgent.model.current(), other)
  assert.deepEqual(agent.model.current(), fallback)
})

test('R17: followup during real Agent creation uses the restored model and effort', { timeout }, async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  const requests = []
  class Adapter extends LlmAdapter {
    async resolveModel(provider, id) {
      return { provider, id, name: id, context: { contextWindow: 100_000 }, reasoning: levels }
    }
    async listModels(provider) {
      return [await this.resolveModel(provider, provider === own.provider ? own.model : fallback.model)]
    }
    async *stream(options) {
      requests.push(options)
      yield { type: 'text-delta', index: 0, text: 'Fixture reply' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter([own.provider, fallback.provider], new Adapter())
  await mountAgentLoopTestHarness(ctx)
  const history = ctx.sessions.create('history')
  recordFailure(agentOf(history))
  const { rt, warnings } = runtime(ctx, { effort: 'high' })
  installParts(rt)
  ctx.on('agent/created', ({ agent }) => {
    assert.equal(agent.phase.kind, 'maintenance')
    assert.deepEqual(agent.model.current(), fallback)
    agent.followup(createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: 'Queued during creation' }],
    }))
  }, { prepend: true })

  const { agent } = await ctx.agentLoop.createAgent(ctx, {
    sessionId: chatId,
    seed: history.snapshotEvents(),
    agentOptions: fallback,
  })
  await agent.whenIdle()
  assert.equal(requests.length, 1, JSON.stringify({
    warnings, ends: agent.session.snapshotEvents().filter(event => event.type === 'turn/end'),
  }))
  const { provider, model, reasoningEffort } = requests[0]
  assert.deepEqual({ provider, model, reasoningEffort }, own)
})
