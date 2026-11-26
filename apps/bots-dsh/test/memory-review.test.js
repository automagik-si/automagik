import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { install } from '../src/host/memory.js'
import { fakeContext } from './fake-ctx.js'

async function fixture(t, config = {}) {
  const home = await mkdtemp(join(tmpdir(), 'bot-memory-review-'))
  const ctx = fakeContext()
  const bots = { a: { id: 'a', name: 'A', memoryReview: false }, b: { id: 'b', name: 'B' } }
  const reads = []
  const rt = { ctx, config: { memoryReviewDelayMs: 10, ...config }, home,
    state: { bots, rooms: {}, prefs: {} }, botOf: id => bots[id], roomOf: () => undefined,
    chatOwners: new Map([['a', 'a'], ['b', 'b']]), groupOwners: new Map(), pastOwners: new Map(), chatOf: id => id,
    partsOf: id => [{ sessionId: id }], isBotSession: id => id in bots, readOnly: () => undefined, load: async () => {}, warn() {},
    async* partLines(id) { reads.push(id); yield* [] },
    // The memory tools are team tools, served to each Bot Session's own scope.
    teamTools: [],
    isMain: () => false,
  }
  install(rt)
  t.after(async () => { await ctx.dispose(); await rm(home, { recursive: true, force: true }) })
  const idle = id => { ctx.emit('agent/status', { agent: { id }, status: 'running' }); ctx.emit('agent/status', { agent: { id }, status: 'idle' }) }
  return { rt, ctx, bots, reads, idle }
}
const flush = async () => { for (let n = 0; n < 16; n++) await Promise.resolve() }

test('per-Bot memory review disables only own chat and rechecks pending work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { rt, bots, reads, idle } = await fixture(t)
  assert.equal(rt.memoryReviewStatus('a').enabled, false)
  assert.equal(rt.memoryReviewStatus('b').enabled, true)
  idle('a'); t.mock.timers.tick(10); await flush()
  assert.deepEqual(reads, [])
  idle('b')
  assert.equal(rt.memoryReviewStatus('b').pending, true)
  bots.b.memoryReview = false
  t.mock.timers.tick(10); await flush()
  assert.deepEqual(reads, [])
  bots.b.memoryReview = true
  idle('b'); t.mock.timers.tick(10); await flush()
  assert.deepEqual(reads, ['b'])
  assert.equal(rt.memoryReviewStatus('a').enabled, false)
  assert.equal(rt.memoryReviewStatus('b').running, false)
  assert.throws(() => rt.memoryReviewStatus('missing'), { code: 'bot/not-found' })
})

test('host memory-review off cannot be overridden by a Bot setting', async t => {
  const { rt, bots, idle, reads } = await fixture(t, { memoryReview: false })
  bots.a.memoryReview = true
  assert.deepEqual(rt.memoryReviewStatus('a'), {
    enabled: false, allowed: false, pending: false, running: false, failure: null,
  })
  idle('a'); await flush()
  assert.deepEqual(reads, [])
})

test('memory entirely off exposes truthful review status without enabling tools', async t => {
  const { rt } = await fixture(t, { memory: false })
  assert.deepEqual(rt.memoryReviewStatus('a'), {
    enabled: false, allowed: false, pending: false, running: false, failure: null,
  })
  assert.equal(rt.memoryEnabled, false)
})

test('T5 a thrown server failure shows without a hold and the next idle tries again', async t => {
  const { rt, idle } = await fixture(t, { memoryReviewDelayMs: 0 })
  rt.partLines = async function* () {
    yield { seq: 1, who: 'user', text: 'User: Likes the orange mug.' }
  }
  rt.isMain = () => false
  rt.memoryModel = async () => undefined
  rt.memoryBackground = async () => ({ ref: 'deepseek/v4' })
  rt.backgroundModel = async () => 'deepseek/v4'
  rt.desiredModel = async () => undefined
  rt.answersAside = () => false
  rt.quotaHeld = () => false
  rt.ctx.llm.resolveModelInfo = async () => undefined
  let calls = 0
  rt.assembleLlm = async () => {
    calls++
    throw Object.assign(new Error('Fictitious private details'), { code: 'SERVER', status: 503 })
  }
  for (const expected of [1, 2]) {
    idle('b')
    for (let tries = 0; tries < 100 && rt.memoryReviews(); tries++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const { failure } = rt.memoryReviewStatus('b')
    assert.equal(calls, expected)
    assert.deepEqual(failure, { reason: 'error', at: failure?.at })
    assert.equal(typeof failure.at, 'number')
  }
})

test('a part already queued for the same Bot cannot run through a new quota hold', async t => {
  const { rt, idle, reads } = await fixture(t, { memoryReviewDelayMs: 0 })
  rt.pastOwners.set('b-earlier', { botId: 'b' })
  rt.isBotSession = id => id === 'b' || id === 'b-earlier'
  rt.partLines = async function* (id) {
    reads.push(id)
    yield { seq: 1, who: 'user', text: 'User: Likes the orange mug.' }
  }
  let retryAt
  rt.memoryModel = async () => undefined
  rt.memoryBackground = async () => retryAt ? { retryAt } : { ref: 'deepseek/v4' }
  rt.quotaHeld = () => retryAt !== undefined
  rt.noteAsideQuota = () => { retryAt = Date.now() + 60 * 60_000 }
  rt.ctx.llm.resolveModelInfo = async () => undefined
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  rt.assembleLlm = async () => {
    entered.resolve()
    await release.promise
    throw Object.assign(new Error('fixture quota'), { code: 'QUOTA', status: 402 })
  }
  idle('b')
  await new Promise(resolve => setTimeout(resolve, 10))
  await entered.promise
  idle('b-earlier')
  try {
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(rt.memoryReviewStatus('b').pending, true)
  } finally { release.resolve() }
  for (let tries = 0; tries < 100 && rt.memoryReviews(); tries++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.deepEqual(reads, ['b'])
  assert.equal(rt.memoryReviewStatus('b').failure.reason, 'quota')
  assert.equal(rt.memoryReviewStatus('b').pending, false)
  assert.equal(rt.memoryReviews(), 0)
})
