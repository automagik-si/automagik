import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSource } from '../src/client/sources.js'
import { teamActions } from '../src/client/team-actions.js'

// The requests the actions send, and how many of them read the team again after.
function bench() {
  const sent = []
  let pulls = 0
  const call = async (name, body) => { sent.push([name, body]); return { ok: name } }
  const after = promise => promise.then((value) => { pulls++; return value })
  const ui = createSource({ settings: null, menu: 'open', palette: null, newChat: null })
  const actions = teamActions({ call, after, partFor: id => id, roster: createSource({}), ui })
  return { actions, sent, ui, pulls: () => pulls }
}

test('every window reaches the host model providers, and key changes read the team again', async () => {
  const { actions, sent, pulls } = bench()
  await actions.providers()
  await actions.setProviderKey('deepseek-official', 'sk-test-ok')
  await actions.setProviderKey('deepseek-official', null)
  await actions.addProvider({ provider: 'router', key: 'k' })
  await actions.providerModels({ baseURL: 'https://gateway.example/v1', api: 'openai-completions', key: '' })
  await actions.removeProvider('router')
  assert.deepEqual(sent, [
    ['providers', undefined],
    ['provider-key', { provider: 'deepseek-official', value: 'sk-test-ok' }],
    ['provider-key', { provider: 'deepseek-official', value: null }],
    ['provider-add', { provider: 'router', key: 'k' }],
    ['provider-models', { baseURL: 'https://gateway.example/v1', api: 'openai-completions', key: '' }],
    ['provider-remove', { provider: 'router' }],
  ])
  // Reads (the list and a model discovery) leave the team as it is.
  assert.equal(pulls(), 4)
})

test('Retry after a failed turn asks the host to resume the Bot, with nothing but its id', async () => {
  const { actions, sent, pulls } = bench()
  await actions.resume('chief')
  assert.deepEqual(sent, [['resume', { botId: 'chief' }]])
  assert.equal(pulls(), 1)
})

test('openModels opens Omni settings on the Models page and closes the menus', () => {
  const { actions, ui } = bench()
  actions.openModels()
  assert.deepEqual(ui.getSnapshot().settings, { page: 'models', id: null })
  assert.equal(ui.getSnapshot().menu, null)
  actions.openSettings()
  assert.deepEqual(ui.getSnapshot().settings, { page: 'general', id: null })
})

// #2048 (parity): Antigravity's sign-in row opens from every sign-in surface; the gates read
// SIGN_IN_NAMES (G6-1), so a refused pick, a refused route switch and the menu all reach it.
test('a refused Antigravity pick or route switch opens its sign-in row; openCliLogin takes it', async () => {
  const roster = createSource({ ready: true, byId: { a: { id: 'a', name: 'A', model: 'deepseek/flash' } } })
  const opened = []
  const sessions = []
  let refusal = 'bot/sign-in-required'
  const call = async () => { throw Object.assign(new Error('Sign in'), { code: refusal }) }
  const manager = { open: (options) => { opened.push(options); return Promise.resolve(true) } }
  const actions = teamActions({ call, after: value => value, partFor: id => id, roster, ui: createSource({}), openSession: id => sessions.push(id), loginState: () => manager })
  assert.equal(await actions.chooseModelInChat('a', 'acp-antigravity/default'), undefined)
  assert.equal(await actions.switchRouteInChat('a', 'acp-antigravity/other'), undefined)
  assert.equal(actions.openCliLogin('a', 'acp-antigravity'), true)
  assert.deepEqual(opened, [
    { botId: 'a', provider: 'acp-antigravity', ref: 'acp-antigravity/default' },
    { botId: 'a', provider: 'acp-antigravity', ref: undefined },
    { botId: 'a', provider: 'acp-antigravity', ref: undefined },
  ])
  assert.deepEqual(sessions, ['a', 'a', 'a'])
  // Another refusal still throws; an unknown agent opens nothing.
  refusal = 'bot/refused'
  await assert.rejects(actions.chooseModelInChat('a', 'acp-antigravity/default'), { code: 'bot/refused' })
  assert.equal(actions.openCliLogin('a', 'acp-hermes'), false)
  assert.equal(opened.length, 3)
})
