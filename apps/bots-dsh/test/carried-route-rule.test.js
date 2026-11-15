import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install as installModels } from '../src/host/models.js'
import { install as installModelState } from '../src/host/model-state.js'
import { RemoteChatAdapter } from '../src/host/remote-chat-adapter.js'

// THE RULE: a chat already on a Remote Hermes route never takes the in-place model switch
// to the attach row, whatever came before. The decision reads the chat's ACTUAL route: the
// live Session's request header, or, for an unloaded chat, the last request/header in its
// stored log. This table keeps that route fixed while the pick's history changes around it.
const ATTACH = 'hermes-remote/attach'
const OLD = 'hermes-remote/nous:openai/gpt-6-astra'
const ROW = Object.freeze({ id: 'attach', name: 'gpt-6-astra (openai-codex)', provider: 'hermes-remote', model: 'gpt-6-astra', providerId: 'openai-codex', contextWindow: 200_000 })
const MESSAGES = Object.freeze(Array.from({ length: 400 }, (_, index) => Object.freeze({ role: 'user', id: `m-${index}`, content: `message ${index}` })))

function harness({ bots, stored = {}, live = {}, groups = {}, chats = {} } = {}) {
  const listeners = new Map()
  const selected = []
  const ctx = {
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) },
    get: name => (name === 'agentDefaultModel'
      ? { currentSelection: () => ({ provider: 'deepseek', model: 'v4' }), saveSelection: async () => {} }
      : undefined),
    llm: {
      listProviders: () => [{ id: 'hermes-remote', name: 'Remote Hermes' }, { id: 'deepseek', name: 'DeepSeek' }],
      listModels: async provider => provider === 'hermes-remote' ? [ROW] : [{ id: 'v4' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 200_000 }, defaultMaxTokens: 8000 }),
    },
    sessionController: {
      selectModel: async ({ sessionId, provider, model }) => { selected.push(`${sessionId}:${provider}/${model}`) },
    },
    sessions: { get: id => live[id] },
    sessionPersistence: {
      open: async (id) => {
        const config = stored[id]
        if (config === undefined) return undefined
        return {
          read: async () => ({ events: [{ type: 'request/header', data: { header: { config } } }] }),
          release: async () => {},
        }
      },
    },
  }
  const rt = {
    ctx,
    state: { bots },
    chatOf: id => chats[id] ?? id,
    groupSessionsOf: id => groups[id] ?? [],
    chatOwners: new Map(Object.keys(bots).map(id => [id, id])),
    botOf: id => bots[id],
    awaitingFirstAnswer: () => false,
    save: async () => {},
    warn() {},
  }
  installModels(rt)
  installModelState(rt)
  const event = (sessionId, type, data) => listeners.get('session/event')({ id: sessionId }, { type, data, time: 1 })
  const answer = (sessionId = 'b1', { interrupted = false } = {}) => event(sessionId, 'assistant/message', {
    interrupted,
    message: { source: { kind: 'model', provider: 'hermes-remote', model: 'nous:openai/gpt-6-astra' } },
  })
  const failure = (sessionId = 'b1') => event(sessionId, 'turn/end', {
    reason: { kind: 'error', error: { code: 'REMOTE_HERMES', message: 'Remote Hermes reported a turn failure.' } },
  })
  const stopped = (sessionId = 'b1') => event(sessionId, 'turn/end', { reason: { kind: 'aborted' } })
  const accepted = (sessionId, config = { provider: 'hermes-remote', model: 'nous:openai/gpt-6-astra' }) => {
    const agent = { id: sessionId, session: { requestHeader: () => ({ config }), deriveMessages: () => MESSAGES } }
    const request = Object.freeze({ provider: config.provider, model: config.model, sessionId, messages: MESSAGES })
    return RemoteChatAdapter.ownTurn(request, agent)
  }
  return { rt, selected, answer, failure, stopped, accepted }
}

const carries = (overrides = {}) => ({ id: 'b1', name: 'Sample Bot', model: ATTACH, appliedModel: ATTACH, previousModel: OLD, ...overrides })

function assertConfirmed(rt, bot) {
  const view = rt.modelStateView()[bot.id]
  assert.equal(view.answered, true, 'the answer counts for the attach pick')
  assert.equal(view.pending, false, 'the switch is confirmed')
  assert.equal(view.lastAnswer.ref, ATTACH, 'the answer names the running row')
  assert.equal(bot.previousModel, ATTACH)
}

test('row a: the first turn after the update keeps the carried route and answers', async () => {
  const h = harness({ bots: { b1: carries() }, stored: { b1: { provider: 'hermes-remote', model: 'nous:openai/gpt-6-astra' } } })
  await h.rt.applyModel(h.rt.state.bots.b1, { force: true })
  assert.deepEqual(h.selected, [])
  assert.equal(h.accepted('b1'), true, 'the 400-message turn is the Session own turn')
  h.answer()
  assertConfirmed(h.rt, h.rt.state.bots.b1)
})

test('row b/c: the second turn and an unload/reload keep the carried route', async () => {
  const h = harness({ bots: { b1: carries({ previousModel: ATTACH }) }, stored: { b1: { provider: 'hermes-remote', model: 'nous:openai/gpt-6-astra' } } })
  await h.rt.applyModel(h.rt.state.bots.b1, { force: true })
  assert.deepEqual(h.selected, [])
  h.answer()
  assertConfirmed(h.rt, h.rt.state.bots.b1)
  // Unloaded again: the live header is gone, the stored route is still the old ref.
  await h.rt.applyModel(h.rt.state.bots.b1, { force: true })
  assert.deepEqual(h.selected, [])
  assert.equal(h.accepted('b1'), true)
})

test('row d: an app restart forces an apply before the chat opens', async () => {
  const h = harness({ bots: { b1: carries({ previousModel: ATTACH, appliedModel: ATTACH }) }, stored: { b1: { provider: 'hermes-remote', model: 'nous:openai/gpt-6-astra' } } })
  await h.rt.applyModel(h.rt.state.bots.b1, { force: true })
  assert.deepEqual(h.selected, [])
  h.answer()
  assertConfirmed(h.rt, h.rt.state.bots.b1)
})

test('row e: a pick of another Bot changes nothing for the carried chat', async () => {
  const other = { id: 'b2', name: 'Other', model: 'deepseek/v4' }
  const h = harness({ bots: { b1: carries(), b2: other }, stored: { b1: { provider: 'hermes-remote', model: 'nous:openai/gpt-6-astra' } } })
  await h.rt.applyModel(other, { force: true })
  assert.deepEqual(h.selected, ['b2:deepseek/v4'])
  h.selected.length = 0
  await h.rt.applyModel(h.rt.state.bots.b1, { force: true })
  assert.deepEqual(h.selected, [])
  h.answer()
  assertConfirmed(h.rt, h.rt.state.bots.b1)
})

test('row f: a failed turn before the answer does not change the carried-route rule', async () => {
  const h = harness({ bots: { b1: carries() }, stored: { b1: { provider: 'hermes-remote', model: 'nous:openai/gpt-6-astra' } } })
  h.failure()
  await h.rt.applyModel(h.rt.state.bots.b1, { force: true })
  assert.deepEqual(h.selected, [])
  h.answer()
  assertConfirmed(h.rt, h.rt.state.bots.b1)
})

test('row 3: an effort-only change keeps the carried route', async () => {
  const h = harness({ bots: { b1: carries({ effort: 'high', appliedEffort: 'low' }) }, stored: { b1: { provider: 'hermes-remote', model: 'nous:openai/gpt-6-astra' } } })
  await h.rt.applyModel(h.rt.state.bots.b1, { force: true })
  assert.deepEqual(h.selected, [])
  assert.equal(h.rt.state.bots.b1.appliedEffort, undefined)
  h.answer()
  assertConfirmed(h.rt, h.rt.state.bots.b1)
})

test('row 7: an interrupted answer leaves the rule to the stored route, then a real answer confirms', async () => {
  const h = harness({ bots: { b1: carries() }, stored: { b1: { provider: 'hermes-remote', model: 'nous:openai/gpt-6-astra' } } })
  h.answer('b1', { interrupted: true })
  await h.rt.applyModel(h.rt.state.bots.b1, { force: true })
  assert.deepEqual(h.selected, [])
  h.answer()
  assertConfirmed(h.rt, h.rt.state.bots.b1)
})

test('earlier part and back: each unloaded part keeps the route its own log carries', async () => {
  const h = harness({
    bots: { b1: carries({ sessionId: 'part-0' }) },
    stored: {
      'part-0': { provider: 'hermes-remote', model: 'nous:openai/gpt-6-astra' },
      b1: { provider: 'hermes-remote', model: 'nous:openai/gpt-6-astra' },
    },
    chats: { b1: 'part-0' },
  })
  h.rt.chatOwners.set('part-0', 'b1')
  await h.rt.applyModel(h.rt.state.bots.b1, { force: true })
  assert.deepEqual(h.selected, [])
  h.answer('part-0')
  assertConfirmed(h.rt, h.rt.state.bots.b1)
  // Back to the current part: its stored route is the same carried ref.
  h.rt.chatOf = id => id
  await h.rt.applyModel(h.rt.state.bots.b1, { force: true })
  assert.deepEqual(h.selected, [])
})

test('roll-over to a new part selects attach on the new Session, never in place', async () => {
  const h = harness({ bots: { b1: carries({ previousModel: ATTACH }) }, stored: { b1: { provider: 'hermes-remote', model: 'nous:openai/gpt-6-astra' } }, chats: { b1: 'part-2' } })
  await h.rt.applyModel(h.rt.state.bots.b1, { force: true })
  assert.deepEqual(h.selected, ['part-2:hermes-remote/attach'])
  assert.equal(h.accepted('part-2', { provider: 'hermes-remote', model: 'attach' }), true)
})

test('detach and re-attach: the stored carried route still decides', async () => {
  const bot = carries({ previousModel: ATTACH })
  const h = harness({ bots: { b1: bot }, stored: { b1: { provider: 'hermes-remote', model: 'nous:openai/gpt-6-astra' } } })
  // Detach clears the live view; re-attach returns the same stored Session.
  h.rt.ctx.sessions.get = () => undefined
  await h.rt.applyModel(bot, { force: true })
  assert.deepEqual(h.selected, [])
  h.answer()
  assertConfirmed(h.rt, bot)
})

test('row 4: a group room Session unloaded keeps its Hermes route under the same rule', async () => {
  const h = harness({
    bots: { b1: carries({ previousModel: ATTACH }) },
    stored: { b1: { provider: 'hermes-remote', model: 'nous:openai/gpt-6-astra' }, room: { provider: 'hermes-remote', model: 'nous:openai/gpt-6-astra' } },
    groups: { b1: ['room'] },
  })
  await h.rt.applyModel(h.rt.state.bots.b1, { force: true })
  assert.deepEqual(h.selected, [])
})

test('a stopped answer before the confirm leaves the rule to the stored route', async () => {
  const h = harness({ bots: { b1: carries() }, stored: { b1: { provider: 'hermes-remote', model: 'nous:openai/gpt-6-astra' } } })
  // A stopped turn is not an answer and not a switch failure.
  h.stopped()
  await h.rt.applyModel(h.rt.state.bots.b1, { force: true })
  assert.deepEqual(h.selected, [])
  h.answer()
  assertConfirmed(h.rt, h.rt.state.bots.b1)
})

test('answer then force before load, with no stored route available, keeps the route', async () => {
  const h = harness({ bots: { b1: carries() } })
  h.answer()
  assertConfirmed(h.rt, h.rt.state.bots.b1)
  // No stored log is readable here: the last answer on the attach row is the carried fact.
  await h.rt.applyModel(h.rt.state.bots.b1, { force: true })
  assert.deepEqual(h.selected, [])
  assert.equal(h.accepted('b1'), true)
})

test('row 9: two carried Bots on the same attach serve both keep their routes', async () => {
  const h = harness({
    bots: { b1: carries(), b2: carries({ id: 'b2', name: 'Second' }) },
    stored: {
      b1: { provider: 'hermes-remote', model: 'nous:openai/gpt-6-astra' },
      b2: { provider: 'hermes-remote', model: 'nous:anthropic/claude-fable-5.2' },
    },
  })
  await h.rt.applyModel(h.rt.state.bots.b1, { force: true })
  await h.rt.applyModel(h.rt.state.bots.b2, { force: true })
  assert.deepEqual(h.selected, [])
  h.answer('b1')
  h.answer('b2')
  assertConfirmed(h.rt, h.rt.state.bots.b1)
  assertConfirmed(h.rt, h.rt.state.bots.b2)
})

test('controls: another provider still takes attach, and moving off Hermes and back is a real switch', async () => {
  const h = harness({ bots: { b1: carries() }, stored: { b1: { provider: 'deepseek', model: 'v4' } } })
  await h.rt.applyModel(h.rt.state.bots.b1, { force: true })
  assert.deepEqual(h.selected, ['b1:hermes-remote/attach'])
  // Off Hermes: a real selection away. Back on attach from that route: a real selection.
  h.selected.length = 0
  const bot = h.rt.state.bots.b1
  bot.model = 'deepseek/v4'
  await h.rt.applyModel(bot, { force: true })
  assert.deepEqual(h.selected, ['b1:deepseek/v4'])
  h.selected.length = 0
  bot.model = ATTACH
  await h.rt.applyModel(bot, { force: true })
  assert.deepEqual(h.selected, ['b1:hermes-remote/attach'])
})
