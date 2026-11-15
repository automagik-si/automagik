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
  const rt = { ctx, config: { memoryReviewDelayMs: 10, ...config }, home, state: { bots, rooms: {} }, botOf: id => bots[id], roomOf: () => undefined,
    chatOwners: new Map([['a', 'a'], ['b', 'b']]), groupOwners: new Map(), pastOwners: new Map(), chatOf: id => id,
    partsOf: id => [{ sessionId: id }], isBotSession: id => id in bots, readOnly: () => undefined, load: async () => {}, warn() {},
    async* partLines(id) { reads.push(id); yield* [] },
    // The memory tools are team tools, served to each Bot Session's own scope.
    teamTools: [],
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
  assert.deepEqual(rt.memoryReviewStatus('a'), { enabled: false, allowed: false, pending: false, running: false })
  idle('a'); await flush()
  assert.deepEqual(reads, [])
})

test('memory entirely off exposes truthful review status without enabling tools', async t => {
  const { rt } = await fixture(t, { memory: false })
  assert.deepEqual(rt.memoryReviewStatus('a'), { enabled: false, allowed: false, pending: false, running: false })
  assert.equal(rt.memoryEnabled, false)
})
