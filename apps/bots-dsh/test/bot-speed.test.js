// Standard / Fast on the Bot record (roster.js): one choice per model ref, cleared by a new model,
// refused when malformed or with no model, and rolled back with the model fields.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const saved = 'acp-codex/gpt-5.5'
const other = 'acp-codex/gpt-5.4'

function start(t, bot = {}, services = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-speed-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, mainBotIds: ['m1'], revision: 1,
    bots: { m1: {
      id: 'm1', sessionId: 'part-current', name: 'Test Bot', role: 'Orchestrator',
      instructions: '', createdAt: 1, model: saved, appliedModel: saved, ...bot,
    } },
    rooms: {}, exchanges: [], exchangeTurns: {}, questions: {},
  }))
  const agents = new Map()
  const ctx = fakeContext({ services: { agents, ...services } })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => { route = options; return register(options) }
  apply(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const call = async (endpoint, payload = {}) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', {
      method: 'POST', body: JSON.stringify({ endpoint, payload }),
    }))
    return response.json()
  }
  const rt = ctx.provided.get('omniTeam')
  const agent = {
    id: 'part-current', session: { id: 'part-current', deriveMessages: () => [] },
    model: { current: () => ({ provider: 'acp-codex', model: 'gpt-5.5' }) },
  }
  agents.set(agent.id, agent)
  rt.resolveModel = async ref => ref
  rt.resolveEffort = async (_ref, effort) => effort
  rt.resolveAgent = async id => agents.get(id)
  return { call, rt }
}

test('Fast then Standard is saved for the model the Bot is on, and null clears it', async t => {
  const { call, rt } = start(t)
  const bot = () => rt.state.bots.m1
  assert.equal(Object.hasOwn(bot(), 'speed'), false, 'an old Bot has none')
  assert.equal((await call('update-bot', { id: 'm1', speed: 'fast' })).ok, true)
  assert.deepEqual(bot().speed, { model: saved, value: 'fast' })
  assert.equal((await call('update-bot', { id: 'm1', speed: 'standard' })).ok, true)
  assert.deepEqual(bot().speed, { model: saved, value: 'standard' })
  const view = (await call('state', {})).value.bots.find(entry => entry.id === 'm1')
  assert.deepEqual(view.speed, { model: saved, value: 'standard' }, 'the menu reads it back')
  assert.equal((await call('update-bot', { id: 'm1', speed: null })).ok, true)
  assert.equal(Object.hasOwn(bot(), 'speed'), false)
})

test('a new model drops the speed unless the same edit sets one for it', async t => {
  const { call, rt } = start(t, { speed: { model: saved, value: 'fast' } })
  assert.equal((await call('update-bot', { id: 'm1', model: other })).ok, true)
  assert.equal(Object.hasOwn(rt.state.bots.m1, 'speed'), false)
  assert.equal((await call('update-bot', { id: 'm1', model: saved, speed: 'fast' })).ok, true)
  assert.deepEqual(rt.state.bots.m1.speed, { model: saved, value: 'fast' })
  assert.equal((await call('update-bot', { id: 'm1', effort: 'high' })).ok, true)
  assert.deepEqual(rt.state.bots.m1.speed, { model: saved, value: 'fast' }, 'an effort keeps it')
})

test('a malformed speed, or one with no model, is refused and nothing changes', async t => {
  const { call, rt } = start(t, { model: undefined, appliedModel: undefined })
  const none = await call('update-bot', { id: 'm1', speed: 'fast' })
  assert.equal(none.ok, false)
  assert.match(none.error.message, /Pick a model before choosing a speed/)
  rt.state.bots.m1.model = saved
  const bad = await call('update-bot', { id: 'm1', speed: 'turbo' })
  assert.equal(bad.ok, false)
  assert.match(bad.error.message, /A speed is Standard or Fast/)
  assert.equal(Object.hasOwn(rt.state.bots.m1, 'speed'), false)
})

test('the menu asks whether a model offers Standard / Fast, as acp-dsh read it', async t => {
  const asked = []
  const acpAgents = { offersFast: (provider, model) => {
    asked.push(`${provider}/${model}`)
    return { 'gpt-5.5': true, 'gpt-5.4': false }[model]
  } }
  const { call } = start(t, {}, { acpAgents })
  assert.deepEqual((await call('speed', { ref: saved })).value, { offered: true })
  assert.deepEqual((await call('speed', { ref: other })).value, { offered: false })
  assert.deepEqual((await call('speed', { ref: 'acp-codex/unread' })).value, { offered: null })
  assert.deepEqual((await call('speed', { ref: 'no-slash' })).value, { offered: null })
  assert.deepEqual(asked, [saved, other, 'acp-codex/unread'])
})

test('with no acp-dsh, no model offers a speed it could not set', async t => {
  const { call } = start(t)
  assert.deepEqual((await call('speed', { ref: saved })).value, { offered: null })
})

test('a failed speed save cannot undo a concurrent model selection', async t => {
  const { rt } = start(t)
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const apply = rt.applyModel
  let held = false
  rt.applyModel = async (...args) => {
    if (held) return apply(...args)
    held = true
    entered.resolve()
    await release.promise
    throw new Error('speed save refused')
  }
  const first = assert.rejects(rt.updateBot('m1', { speed: 'fast' }), error => error.cause?.message === 'speed save refused')
  await entered.promise
  const next = rt.updateBot('m1', { model: other })
  await new Promise(resolve => setImmediate(resolve))
  release.resolve()
  await Promise.all([first, next])
  assert.equal(rt.state.bots.m1.model, other)
  assert.equal(rt.state.bots.m1.speed, undefined)
})

test('a queued speed choice refuses if its model changed while it waited', async t => {
  const { rt } = start(t)
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const resolve = rt.resolveModel
  rt.resolveModel = async (...args) => {
    entered.resolve()
    await release.promise
    return resolve(...args)
  }
  const change = rt.updateBot('m1', { model: other })
  await entered.promise
  const speed = assert.rejects(rt.updateBot('m1', { speed: 'fast' }), /changed during model selection/)
  release.resolve()
  await Promise.all([change, speed])
  assert.equal(rt.state.bots.m1.model, other)
  assert.equal(rt.state.bots.m1.speed, undefined)
})

test('a read-only host can report speed availability but refuses speed changes', async t => {
  const { call, rt } = start(t, {}, { acpAgents: { offersFast: () => true } })
  rt.readOnly = () => 'Read-only team.'
  assert.deepEqual((await call('speed', { ref: saved })).value, { offered: true })
  assert.equal((await call('update-bot', { id: 'm1', speed: 'fast' })).error.code, 'bot/read-only')
})
