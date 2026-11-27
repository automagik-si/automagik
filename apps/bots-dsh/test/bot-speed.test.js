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

function start(t, bot = {}) {
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
  const ctx = fakeContext({ services: { agents } })
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
