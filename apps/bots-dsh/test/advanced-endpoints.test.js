import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { teamActions } from '../src/client/team-actions.js'

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'bot-advanced-route-'))
  await writeFile(join(home, 'state.json'), JSON.stringify({ version: 1, revision: 1, mainBotIds: ['b'], bots: { b: { id: 'b', name: 'B', sessionId: 'part' } }, rooms: {}, questions: {}, exchanges: [] }))
  const ctx = fakeContext()
  ctx.llm = { listProviders: () => [], listModels: async () => [] }
  ctx.sessions = { flush: async () => {} }
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home, memory: false, browser: false, updateCheck: false })
  await rt.load()
  const seen = []
  rt.contextStatus = async id => { seen.push(['context', id]); return { id, sessionId: 'part', readOnly: false } }
  rt.usageStats = async (id, options) => { seen.push(['stats', id, options]); return { botId: id, sessionId: options.sessionId } }
  rt.memoryReviewStatus = id => { seen.push(['memory', id]); return { enabled: false, allowed: false, pending: false, running: false } }
  rt.checkpointBot = async (id, options) => { seen.push(['checkpoint', id, options]); if (typeof options.sessionId !== 'string') throw Object.assign(new Error('Expected Session required'), { code: 'bot/invalid' }); return { id, sessionId: options.sessionId, status: 'checkpointed' } }
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://fixture.invalid/api/omni-ui', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  t.after(async () => { await ctx.dispose(); await rm(home, { recursive: true, force: true }) })
  return { rt, call, seen }
}

test('Advanced read routes work read-only while checkpoint remains a mutation', async t => {
  const { rt, call, seen } = await fixture(t)
  rt.readOnly = () => 'Fixture state lock'
  assert.equal((await call('context-status', { botId: 'b' })).value.sessionId, 'part')
  assert.equal((await call('usage-stats', { botId: 'b', sessionId: 'part' })).value.botId, 'b')
  assert.equal((await call('memory-review-status', { botId: 'b' })).value.allowed, false)
  // The same call carries the Bot's daily tidy switch.
  assert.deepEqual((await call('memory-review-status', { botId: 'b' })).value.tidy, { enabled: false, allowed: false, always: false })
  assert.equal((await call('checkpoint-bot', { botId: 'b', sessionId: 'part' })).error.code, 'bot/read-only')
  assert.equal(seen.some(entry => entry[0] === 'checkpoint'), false)
})

test('checkpoint route forwards exact expected Session and invalid requests do not get a replacement', async t => {
  const { call, seen } = await fixture(t)
  assert.equal((await call('checkpoint-bot', { botId: 'b' })).error.code, 'bot/invalid')
  const result = await call('checkpoint-bot', { botId: 'b', sessionId: 'part' })
  assert.equal(result.value.status, 'checkpointed')
  assert.deepEqual(seen.at(-1), ['checkpoint', 'b', { sessionId: 'part' }])
  assert.equal((await call('memory-review-status', { botId: 'missing' })).error.code, 'bot/not-found')
})

test('client actions keep scope and expected Session explicit without canonical remapping', async () => {
  const calls = []
  const actions = teamActions({ call: async (...args) => { calls.push(args); return 'ok' }, after: promise => promise })
  await actions.contextStatus('b')
  await actions.usageStats('b', 'old-part')
  await actions.memoryReviewStatus('b')
  await actions.checkpointBot('b', 'expected-part')
  assert.deepEqual(calls, [['context-status', { botId: 'b' }], ['usage-stats', { botId: 'b', sessionId: 'old-part' }], ['memory-review-status', { botId: 'b' }], ['checkpoint-bot', { botId: 'b', sessionId: 'expected-part' }]])
})
