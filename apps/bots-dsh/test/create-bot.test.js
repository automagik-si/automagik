import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fixture, serviceStub } from './caller-fixture.js'
import { createPayload, freshBotName, startModel } from '../src/client/bot-draft.js'

const models = [
  { ref: 'ollama/ds-flash', name: 'DS Flash', providerName: 'Ollama' },
  { ref: 'cloud/qwen-max', name: 'Qwen Max', providerName: 'Cloud' },
]

test('the form starts on the team default model, then the DSH default, else the first served one', () => {
  assert.equal(startModel({ models, defaultModel: 'cloud/qwen-max' }), 'cloud/qwen-max')
  assert.equal(startModel({ models, defaultModel: 'gone/model' }), 'ollama/ds-flash')
  assert.equal(startModel({ models, defaultModel: null }), 'ollama/ds-flash')
  assert.equal(startModel({ models: [], defaultModel: 'cloud/qwen-max' }), '')
  // The team's pick from settings comes first; one that is not served falls through.
  assert.equal(startModel({ models, defaultModel: 'cloud/qwen-max', prefs: { defaultBotModel: 'ollama/ds-flash' } }), 'ollama/ds-flash')
  assert.equal(startModel({ models, defaultModel: 'cloud/qwen-max', prefs: { defaultBotModel: 'gone/model' } }), 'cloud/qwen-max')
})

test('the form never starts on a model whose provider has no key, and starts on none when no model is usable', () => {
  const keyless = [{ ...models[0], needsKey: true }, models[1]]
  assert.equal(startModel({ models: keyless, defaultModel: 'ollama/ds-flash' }), 'cloud/qwen-max')
  assert.equal(startModel({ models: keyless, defaultModel: null }), 'cloud/qwen-max')
  const none = models.map(model => ({ ...model, needsKey: true }))
  assert.equal(startModel({ models: none, defaultModel: null }), '')
  assert.equal(startModel({ models: none, defaultModel: 'cloud/qwen-max' }), '')
  // With no model the payload leaves it out, and the host lets the new Bot wait for a pick.
  assert.equal('model' in createPayload({ name: 'A', look: { shape: 'star', color: 'blue' }, model: startModel({ models: none, defaultModel: null }) }), false)
})

test('the payload carries the look, the chosen model, and the brief', () => {
  const look = { shape: 'star', color: 'blue' }
  assert.deepEqual(createPayload({ name: 'A', look, model: 'cloud/qwen-max' }), { name: 'A', color: 'blue', avatar: { shape: 'star' }, model: 'cloud/qwen-max' })
  assert.deepEqual(createPayload({ name: 'A', look, model: '', brief: 'hi', image: 'data:image/png;base64,AA' }),
    { name: 'A', color: 'blue', avatar: { shape: 'star', image: 'data:image/png;base64,AA' }, brief: 'hi' })
})

test('the suggested name skips taken names', () => {
  const roster = { bots: [{ name: 'New Bot' }, { name: 'Kimi' }] }
  assert.equal(freshBotName(roster), 'New Bot 2')
  assert.equal(freshBotName(roster, 'Kimi'), 'Kimi 2')
  assert.equal(freshBotName(roster, 'Writer'), 'Writer')
})

test('a new Bot\'s form never starts on a model that is not set up or offered twice', () => {
  const lineup = [
    { ref: 'acp-claude/default', name: 'Claude Code', needsSignIn: true },
    { ref: 'openai-codex/gpt-5.6-sol', name: '5.6 Sol', covered: true },
    { ref: 'openai/gpt-5.6', name: 'GPT-5.6', needsKey: true },
    { ref: 'acp-codex/gpt-5.6-sol', name: '5.6 Sol' },
  ]
  assert.equal(startModel({ models: lineup, defaultModel: 'acp-claude/default' }), 'acp-codex/gpt-5.6-sol')
  assert.equal(startModel({ models: lineup.slice(0, 3), defaultModel: null }), '')
})

test('D2 C1 create-bot derives the wait marker from the stored text and the Solver description', async t => {
  const f = fixture(t, { service: serviceStub({ multiuser: false }), seed: state => { state.prefs.roles = false } })
  await f.start()
  const answer = await f.call('create-bot', {
    name: 'Wait fixture', role: 'Solver', instructions: '  Method.  ', waitingRole: 'solver', instructionsDigest: 'ignored',
  })
  assert.equal(answer.ok, true, JSON.stringify(answer))
  const stored = f.saved().bots[answer.value.id]
  assert.deepEqual(stored.waitingRole, {
    id: 'solver', instructions: createHash('sha256').update('Method.').digest('hex'), role: 'Solver',
  })
  for (const [index, options] of [
    { waitingRole: { id: 'solver', instructions: 'untrusted' } },
    { waitingRole: 'other' }, { role: 'Researcher' }, { instructions: '  ' },
  ].entries()) {
    const other = await f.call('create-bot', {
      name: `Other fixture ${index}`, role: 'Solver', instructions: 'Method.', waitingRole: 'solver', ...options,
    })
    assert.equal(other.ok, true, JSON.stringify(other))
    assert.equal(Object.hasOwn(f.saved().bots[other.value.id], 'waitingRole'), false)
  }
})

test('D2 C2 only a kept reviewer can be dedicated and both stored fields stay internal', async t => {
  const f = fixture(t, { service: serviceStub({ multiuser: false }), seed: state => { state.prefs.roles = false } })
  await f.start()
  const response = await f.call('create-bot', {
    name: 'Dedicated fixture', role: 'Solver', instructions: 'Method.', waitingRole: 'solver', reviewerId: 'b', reviewerMade: true,
  })
  assert.equal(response.ok, true, JSON.stringify(response))
  const { id } = response.value
  assert.equal(f.saved().bots[id].reviewerMade, true)
  const responseWithout = await f.call('create-bot', { name: 'Fresh fixture', role: 'Solver', reviewerId: 'gone', reviewerMade: true })
  assert.equal(responseWithout.ok, true, JSON.stringify(responseWithout))
  assert.equal(Object.hasOwn(f.saved().bots[responseWithout.value.id], 'reviewerMade'), false)
  const roster = (await f.call('state')).value
  const updated = await f.call('update-bot', { id, color: 'blue' })
  assert.equal(updated.ok, true, JSON.stringify(updated))
  for (const bot of [response.value, roster.bots.find(bot => bot.id === id), updated.value]) {
    assert.equal(Object.hasOwn(bot, 'waitingRole'), false)
    assert.equal(Object.hasOwn(bot, 'reviewerMade'), false)
  }
})
