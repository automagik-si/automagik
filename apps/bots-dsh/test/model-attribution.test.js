import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/model-state.js'
import { fakeContext } from './fake-ctx.js'

// The model a Bot really answered on, for a chat carried onto the attach row. The request
// keeps naming the old Hermes ref (models.js applyModel), while the Bot's pick is the attach
// row; the answer must count for the pick or the switch never confirms.
function bench({ model = 'hermes-remote/attach', previousModel = 'hermes-remote/nous:openai/gpt-6-astra' } = {}) {
  const ctx = fakeContext()
  const bot = { id: 'b1', name: 'Felipe', model, ...(previousModel === undefined ? {} : { previousModel }) }
  const saved = [], applied = []
  const rt = {
    ctx,
    state: { bots: { b1: bot } },
    botOf: id => rt.state.bots[id],
    chatOwners: new Map([['session-b1', 'b1']]),
    save: async () => { saved.push({ ...bot }) },
    warn() {},
    applyModel: async () => { applied.push(bot.model) },
    awaitingFirstAnswer: () => false,
  }
  install(rt)
  const session = { id: 'session-b1' }
  const listener = ctx.listeners.get('session/event')[0]
  const emit = (type, data, time) => listener(session, { type, data, time })
  return { rt, bot, saved, applied, emit }
}

const answer = ref => ({
  type: 'assistant/message',
  data: { message: { source: { kind: 'model', provider: ref.split('/')[0], model: ref.split('/').slice(1).join('/') } } },
})

test('an answer on the carried Hermes ref confirms the attach pick and is labelled attach', () => {
  const b = bench()
  b.emit('request/header', { header: { config: { provider: 'hermes-remote', model: 'nous:openai/gpt-6-astra' } } }, 1000)
  assert.equal(b.rt.modelStateView().b1.requestStarted.ref, 'hermes-remote/attach')
  const carried = answer('hermes-remote/nous:openai/gpt-6-astra')
  b.emit(carried.type, carried.data, 2000)
  const view = b.rt.modelStateView().b1
  assert.equal(view.lastAnswer.ref, 'hermes-remote/attach')
  assert.equal(view.answered, true)
  assert.equal(view.pending, false)
  assert.equal(b.bot.previousModel, 'hermes-remote/attach')
})

test('after that answer a switch-type failure no longer moves the pick back', () => {
  const b = bench()
  b.emit(answer('hermes-remote/nous:openai/gpt-6-astra').type, answer('hermes-remote/nous:openai/gpt-6-astra').data, 2000)
  b.emit('turn/end', { reason: { kind: 'error', error: { code: 'MODEL_SWITCH_COMPACTION_FAILED', message: 'Cannot switch to hermes-remote/attach' } } }, 3000)
  assert.equal(b.bot.model, 'hermes-remote/attach')
  assert.deepEqual(b.applied, [])
})

test('an address-and-token Hermes connection keeps its own answer attribution', () => {
  const b = bench({ model: 'hermes-remote/sample:model-b', previousModel: 'hermes-remote/sample:model-a' })
  const earlier = answer('hermes-remote/sample:model-a')
  b.emit(earlier.type, earlier.data, 2000)
  const view = b.rt.modelStateView().b1
  assert.equal(view.lastAnswer.ref, 'hermes-remote/sample:model-a')
  assert.equal(view.answered, false)
  assert.equal(view.pending, true)
  assert.equal(b.bot.previousModel, 'hermes-remote/sample:model-a')
})
