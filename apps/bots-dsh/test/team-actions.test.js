import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSource } from '../src/client/sources.js'
import { teamActions } from '../src/client/team-actions.js'
import { CROSSING_DEADLINE_MS } from '../src/shared/routes.js'

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

// ---- PLAN-S6R S1 (#2061): the person's own crossing pick in this window hides the note
// turn's activity row from the host's answer until the host's `noting` takes over ----
const flush = () => new Promise(resolve => setImmediate(resolve))
// Bot b1 on `model`, its current part p1; Bot b2 on p2. `answer` is the host's answer to every
// call; `pulled` runs in after()'s pull (the state read), before the action resolves.
function pickBench({ model = 'acp-claude/haiku', answer = async () => ({ status: 'switching' }), pulled = () => {}, work: start = {} } = {}) {
  const b1 = { id: 'b1', name: 'A', model, sessionId: 'p1' }
  const b2 = { id: 'b2', name: 'B', model: 'acp-claude/haiku', sessionId: 'p2' }
  const roster = createSource({ ready: true, byId: { b1, p1: b1, b2, p2: b2 }, roomsById: {} })
  const work = createSource({ models: {}, ...start })
  const watch = { subscribed: 0, unsubscribed: 0 }
  const subscribe = work.subscribe
  work.subscribe = (listener) => {
    watch.subscribed += 1
    const stop = subscribe(listener)
    return () => { watch.unsubscribed += 1; stop() }
  }
  const sent = []
  const call = (name, body) => { sent.push([name, body]); return answer(name, body) }
  const after = promise => promise.then(async (value) => { await pulled(); return value })
  const opened = []
  const manager = { open: (options) => { opened.push(options); return Promise.resolve(true) } }
  const actions = teamActions({ call, after, partFor: id => roster.getSnapshot().byId[id]?.sessionId ?? id, roster, ui: createSource({}), work, openSession: () => {}, loginState: () => manager })
  let fired = 0
  actions.subscribePicks(() => { fired += 1 })
  const switching = { to: 'acp-codex/x', since: 1 }
  const lock = () => work.set(state => ({ ...state, models: { ...state.models, b1: { switching } } }))
  return { actions, work, watch, sent, opened, fired: () => fired, lock }
}

test('C2 a crossing pick marks its part when the host answers, before the pull; never before', async () => {
  const answered = Promise.withResolvers()
  const pull = Promise.withResolvers()
  let pulling = false
  const b = pickBench({ answer: () => answered.promise, pulled: () => { pulling = true; return pull.promise } })
  const done = b.actions.switchRoute('b1', 'acp-codex/x')
  await flush()
  assert.equal(b.actions.picking('p1'), false)
  assert.equal(b.fired(), 0)
  answered.resolve({ status: 'switching' })
  await flush()
  assert.equal(pulling, true)
  assert.equal(b.actions.picking('p1'), true)
  assert.equal(b.fired(), 1)
  // A state answer from before the switch lands now (no lock in it): the call is not done yet.
  b.work.set(state => ({ ...state, turns: {} }))
  assert.equal(b.actions.picking('p1'), true)
  b.lock()
  pull.resolve()
  assert.deepEqual(await done, { status: 'switching' })
  assert.equal(b.actions.picking('p1'), true)
  assert.equal(b.actions.picking('p2'), false)
  assert.equal(b.fired(), 1)
})

test('C3 the host\'s noting takes over: the mark drops and the work watch ends once', async () => {
  // The pull brings the switch's lock, as the host's answer does.
  const c = pickBench({ pulled: () => c.lock() })
  await c.actions.switchRoute('b1', 'acp-codex/x')
  assert.equal(c.actions.picking('p1'), true)
  assert.equal(c.watch.subscribed, 1)
  c.work.set(state => ({ ...state, noting: { p1: true } }))
  assert.equal(c.actions.picking('p1'), false)
  assert.equal(c.fired(), 2)
  assert.equal(c.watch.unsubscribed, 1)
  c.work.set(state => ({ ...state, noting: {} }))
  assert.equal(c.watch.unsubscribed, 1)
})

test('C4 an answered switch that ends with no noting (native outgoing, go-back) ends the mark', async () => {
  const b = pickBench({ pulled: () => b.lock() })
  await b.actions.switchRoute('b1', 'acp-codex/x')
  assert.equal(b.actions.picking('p1'), true)
  b.work.set(state => ({ ...state, models: { b1: {} } }))
  assert.equal(b.actions.picking('p1'), false)
  assert.equal(b.watch.unsubscribed, 1)
})

test('C5 an answer with no switch under way (in place, nothing said) ends the mark at once', async () => {
  const b = pickBench({ answer: async () => ({ status: 'applied' }) })
  assert.deepEqual(await b.actions.switchRoute('b1', 'acp-codex/x'), { status: 'applied' })
  assert.equal(b.actions.picking('p1'), false)
  assert.equal(b.fired(), 2)
  assert.equal(b.watch.subscribed, 1)
  assert.equal(b.watch.unsubscribed, 1)
})

test('C6 a refused pick never marks: reply-running, busy, a sign-in row, any throw', async () => {
  const refusal = code => async () => { throw Object.assign(new Error(code), { code }) }
  for (const code of ['reply-running', 'bot/busy', 'bot/refused']) {
    const b = pickBench({ answer: refusal(code) })
    await assert.rejects(b.actions.switchRoute('b1', 'acp-codex/x'), { code })
    await assert.rejects(b.actions.updateBot('b1', { model: 'acp-codex/x' }), { code })
    assert.equal(b.actions.picking('p1'), false)
    assert.equal(b.fired(), 0)
    assert.equal(b.watch.subscribed, 0)
  }
  const signIn = pickBench({ answer: refusal('bot/sign-in-required') })
  assert.equal(await signIn.actions.switchRouteInChat('b1', 'acp-codex/x'), undefined)
  assert.equal(await signIn.actions.chooseModelInChat('b1', 'acp-codex/x'), undefined)
  assert.equal(signIn.opened.length, 2)
  assert.equal(signIn.actions.picking('p1'), false)
  assert.equal(signIn.fired(), 0)
  const plain = pickBench({ answer: () => Promise.reject(new Error('down')) })
  await assert.rejects(plain.actions.switchRouteInChat('b1', 'acp-codex/x'), /down/)
  assert.equal(plain.fired(), 0)
})

test('C7 every crossing entry marks; a non-crossing change, another Bot or a native outgoing model never does', async () => {
  for (const pick of [
    a => a.updateBot('b1', { model: 'acp-codex/x' }),
    a => a.chooseModelInChat('b1', 'acp-codex/x'),
    a => a.switchRouteInChat('b1', 'acp-codex/x'),
    a => a.switchRoute('b1', 'deepseek/v4'),
  ]) {
    const b = pickBench({ pulled: () => b.lock() })
    await pick(b.actions)
    assert.equal(b.actions.picking('p1'), true)
    assert.equal(b.actions.picking('p2'), false)
  }
  for (const pick of [
    a => a.updateBot('b1', { model: 'acp-claude/opus' }),
    a => a.updateBot('b1', { name: 'n' }),
    a => a.chooseModelInChat('b1', 'acp-claude/haiku'),
  ]) {
    const b = pickBench({ pulled: () => b.lock() })
    await pick(b.actions)
    assert.equal(b.fired(), 0)
    assert.equal(b.watch.subscribed, 0)
  }
  const native = pickBench({ model: 'deepseek/v4', pulled: () => native.lock() })
  await native.actions.switchRoute('b1', 'acp-codex/x')
  await native.actions.updateBot('b1', { model: 'acp-codex/x' })
  assert.equal(native.fired(), 0)
  assert.equal(native.actions.picking('p1'), false)
})

test('C8 a reply running at the pick is never marked before the answer; an accepted answer marks', async () => {
  for (const turns of [{ p1: { since: 1 } }, {}]) {
    for (const stopReply of [true, false]) {
      const answered = Promise.withResolvers()
      const b = pickBench({ answer: () => answered.promise, work: { turns } })
      b.lock()
      const done = b.actions.switchRoute('b1', 'acp-codex/x', {}, { stopReply })
      await flush()
      assert.equal(b.actions.picking('p1'), false, JSON.stringify({ turns, stopReply }))
      answered.resolve({ status: 'switching' })
      await done
      assert.equal(b.actions.picking('p1'), true, JSON.stringify({ turns, stopReply }))
    }
  }
})

test('C9 a mark ends at its own deadline; a dropped one\'s timer never ends a newer mark', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const b = pickBench({ pulled: () => b.lock() })
  await b.actions.switchRoute('b1', 'acp-codex/x')
  t.mock.timers.tick(CROSSING_DEADLINE_MS - 1)
  assert.equal(b.actions.picking('p1'), true)
  t.mock.timers.tick(1)
  assert.equal(b.actions.picking('p1'), false)
  assert.equal(b.watch.unsubscribed, 1)
  // A first mark dropped by noting halfway, then a new pick: the first deadline passes.
  await b.actions.switchRoute('b1', 'acp-codex/x')
  t.mock.timers.tick(CROSSING_DEADLINE_MS / 2)
  b.work.set(state => ({ ...state, noting: { p1: true } }))
  assert.equal(b.actions.picking('p1'), false)
  b.work.set(state => ({ ...state, noting: {} }))
  await b.actions.switchRoute('b1', 'acp-codex/x')
  assert.equal(b.actions.picking('p1'), true)
  t.mock.timers.tick(CROSSING_DEADLINE_MS / 2)
  assert.equal(b.actions.picking('p1'), true)
  t.mock.timers.tick(CROSSING_DEADLINE_MS / 2)
  assert.equal(b.actions.picking('p1'), false)
})

// A deleted Bot's composer state (DSH's `dsh.conversation.<part>`) leaves the page's storage
// only once the host answered that the Bot is deleted.
function draftBench(answer) {
  const removed = []
  const storage = { removeItem: key => removed.push(key) }
  let pulls = 0
  const call = async (name) => {
    if (answer instanceof Error) throw answer
    return name === 'delete-bot' ? answer : { ok: name }
  }
  const after = promise => promise.then((value) => { pulls++; return value })
  const actions = teamActions({ call, after, partFor: id => id, roster: createSource({}), ui: createSource({}), storage })
  return { actions, removed, pulls: () => pulls }
}

test('Delete removes the deleted Bot\'s composer keys after the team is read again', async () => {
  const { actions, removed, pulls } = draftBench({ ok: 'delete-bot', deletedParts: ['b', 'b-next'] })
  const value = await actions.deleteBot('b')
  assert.deepEqual(removed, ['dsh.conversation.b', 'dsh.conversation.b-next'])
  assert.equal(pulls(), 1)
  assert.deepEqual(value.deletedParts, ['b', 'b-next'])
})

test('a refused Delete removes no composer key', async () => {
  const { actions, removed, pulls } = draftBench(Object.assign(new Error('Unknown Bot'), { code: 'bot/refused' }))
  await assert.rejects(actions.deleteBot('b'), /Unknown Bot/)
  assert.deepEqual(removed, [])
  assert.equal(pulls(), 0)
})

test('an answer without part ids removes nothing and still resolves', async () => {
  for (const answer of [{ ok: 'delete-bot' }, { deletedParts: 'b' }, { deletedParts: [3, null, ''] }, undefined]) {
    const { actions, removed } = draftBench(answer)
    assert.deepEqual(await actions.deleteBot('b'), answer)
    assert.deepEqual(removed, [])
  }
})
