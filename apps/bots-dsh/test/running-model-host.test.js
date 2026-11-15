import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const saved = 'deepseek/saved'
function start(savedModel = saved, extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-running-model-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, mainBotIds: ['m1'], revision: 1,
    bots: { m1: { id: 'm1', sessionId: 'part-current', name: 'Test Bot', role: 'Orchestrator', instructions: '', createdAt: 1, model: savedModel, appliedModel: savedModel, ...extra } },
    rooms: {}, exchanges: [], exchangeTurns: {}, questions: {},
  }))
  const agents = new Map()
  const services = { agents }
  const ctx = fakeContext({ services })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => { route = options; return register(options) }
  apply(ctx, { home })
  const call = async (endpoint, payload = {}) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    const answer = await response.json()
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    return answer.value
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { call, stop, home, ctx, services, agents, rt: ctx.provided.get('omniTeam') }
}
const botOf = view => view.bots.find(bot => bot.id === 'm1')
const poll = (call, view) => call('state', { since: view.revision, models: view.modelsKey })
const noRunning = bot => {
  assert.equal(Object.hasOwn(bot, 'runningModel'), false)
  assert.equal(Object.hasOwn(bot, 'runningEffort'), false)
}

test('a carried chat reports the attach row it runs on, not the ref it still carries', async t => {
  const attach = 'hermes-remote/attach'
  const { call, stop, agents } = start(attach, { previousModel: 'hermes-remote/nous:openai/gpt-6-astra' })
  t.after(stop)
  const before = await call('state')
  assert.equal(botOf(before).model, attach)
  // The Session's own selection is the carried-over ref the attach transport serves.
  agents.set(botOf(before).sessionId, { model: { current: () => ({ provider: 'hermes-remote', model: 'nous:openai/gpt-6-astra' }) } })
  const view = await poll(call, before)
  assert.equal(botOf(view).runningModel, attach)
  assert.equal(botOf(view).model, attach)
  assert.equal(botOf(view).previousModel, 'hermes-remote/nous:openai/gpt-6-astra')
})

test('live selections update the poll view without changing or persisting the saved model', async t => {
  const { call, stop, agents, home, rt, ctx } = start()
  t.after(stop)
  const before = await call('state')
  noRunning(botOf(before))
  assert.equal((await poll(call, before)).unchanged, true)
  let selection = { provider: 'local', model: 'first', reasoningEffort: 'high' }
  agents.set(botOf(before).sessionId, { model: { current: () => selection } })
  // Display reads must never resolve an Agent or select a model.
  ctx.sessionController = {
    resolveAgent: () => assert.fail('state must not resolve an Agent'),
    selectModel: () => assert.fail('state must not select a model'),
  }
  const first = await poll(call, before)
  assert.equal(first.unchanged, undefined)
  assert.equal(first.revision, before.revision)
  assert.equal(botOf(first).runningModel, 'local/first')
  assert.equal(botOf(first).runningEffort, 'high')
  assert.equal(botOf(first).model, saved)
  assert.equal(botOf(first).appliedModel, saved)
  // The live selection changes as on model/selection; no event listener or save is needed.
  selection = { provider: 'local', model: 'second', reasoningEffort: 'low' }
  const second = await poll(call, first)
  assert.equal(second.unchanged, undefined)
  assert.equal(second.revision, first.revision)
  assert.notEqual(second.modelsKey, first.modelsKey)
  assert.equal(botOf(second).runningModel, 'local/second')
  assert.equal(botOf(second).runningEffort, 'low')
  selection = { ...selection, reasoningEffort: 'high' }
  const effortChanged = await poll(call, second)
  assert.equal(effortChanged.unchanged, undefined)
  assert.equal(effortChanged.revision, second.revision)
  assert.equal(botOf(effortChanged).runningEffort, 'high')
  selection = { provider: 'deepseek', model: 'saved' }
  const back = await poll(call, effortChanged)
  assert.equal(back.unchanged, undefined)
  assert.equal(botOf(back).runningModel, saved)
  assert.equal(Object.hasOwn(botOf(back), 'runningEffort'), false)
  noRunning(rt.botOf('m1'))
  // Exercise a real save after the views: derived fields must never enter state.json.
  await rt.save()
  const persisted = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).bots.m1
  noRunning(persisted)
  assert.equal(persisted.model, saved)
  assert.equal(persisted.appliedModel, saved)
  const savedView = await call('state')
  agents.clear()
  const gone = await poll(call, savedView)
  assert.equal(gone.unchanged, undefined)
  assert.equal(gone.revision, savedView.revision)
  noRunning(botOf(gone))
  assert.notEqual(gone.modelsKey, back.modelsKey)
})

test('a loaded Session supplies its next selection only while no live Agent exists', async t => {
  const { call, stop, ctx, services, agents } = start()
  t.after(stop)
  const before = await call('state')
  const session = { id: botOf(before).sessionId }
  ctx.sessions = { list: () => [session] }
  services.sessionProjections = { snapshot: (loaded, names) => {
    assert.equal(loaded, session)
    assert.deepEqual(names, ['modelSelection'])
    return { values: { modelSelection: { next: { provider: 'local', model: 'projected', reasoningEffort: '' } } } }
  } }
  const projected = await poll(call, before)
  assert.equal(botOf(projected).runningModel, 'local/projected')
  assert.equal(Object.hasOwn(botOf(projected), 'runningEffort'), false)
  agents.set(session.id, { model: { current: () => ({ provider: 'local', model: 'live' }) } })
  assert.equal(botOf(await poll(call, projected)).runningModel, 'local/live')
  agents.set(session.id, { model: { current: () => ({ provider: 42, model: 'invalid' }) } })
  noRunning(botOf(await call('state')))
})

test('failed live and projection reads omit running fields', async t => {
  const { call, stop, ctx, services, agents } = start()
  t.after(stop)
  const session = { id: botOf(await call('state')).sessionId }
  agents.set(session.id, { model: { current: () => { throw new Error('unavailable') } } })
  noRunning(botOf(await call('state')))
  agents.clear()
  ctx.sessions = { list: () => { throw new Error('unavailable') } }
  noRunning(botOf(await call('state')))
  ctx.sessions.list = () => [session]
  services.sessionProjections = { snapshot: () => { throw new Error('unavailable') } }
  noRunning(botOf(await call('state')))
})

test('plugin-owned model menus receive no DSH running fields', async t => {
  const { call, stop, rt, agents } = start()
  t.after(stop)
  await call('state')
  rt.botOf('m1').kind = 'hosted-test'
  t.after(rt.hooks.botModels('hosted-test', { snapshot: () => ({ entries: [] }), pick: () => {} }))
  let reads = 0
  agents.set(rt.chatOf('m1'), { model: { current: () => { reads++; return { provider: 'local', model: 'unused' } } } })
  const view = await call('state')
  noRunning(botOf(view))
  assert.ok(view.hostModels.m1)
  assert.equal(reads, 0)
})
