import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assembleLlmStream, install } from '../src/host/models.js'
import { fakeContext } from './fake-ctx.js'

const policy = { mode: 'normal', maxRetries: 2, retryableCodes: ['TRANSPORT', 'TIMEOUT'], initialDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 }
const request = { provider: 'gateway', model: 'model', messages: [] }
const errorChunk = (code, extra = {}) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message: 'failed', ...extra } } })

for (const thrown of [false, true]) {
  test(`auxiliary retry caps ${thrown ? 'thrown' : 'streamed'} transient failures on the same request`, async () => {
    const requests = []
    const failure = Object.assign(new Error('temporary failure'), { code: 'TIMEOUT' })
    const ctx = { llm: {
      providerRetryPolicy: () => policy,
      async *stream(options) {
        requests.push(options)
        if (thrown) throw failure
        yield errorChunk('TIMEOUT')
      },
    } }
    if (thrown) await assert.rejects(assembleLlmStream(ctx, request), error => error === failure)
    else assert.equal((await assembleLlmStream(ctx, request)).finish.failure.code, 'TIMEOUT')
    assert.equal(requests.length, 3)
    assert.ok(requests.every(options => options === request))
  })
}

for (const code of ['AUTH', 'INVALID_REQUEST']) {
  test(`auxiliary retry does not repeat ${code}, even with an always policy`, async () => {
    let calls = 0
    const ctx = { llm: {
      providerRetryPolicy: () => ({ ...policy, mode: 'always' }),
      async *stream() {
        if (++calls > 1) throw new Error('a permanent failure was retried')
        yield errorChunk(code)
      },
    } }
    assert.equal((await assembleLlmStream(ctx, request)).finish.failure.code, code)
    assert.equal(calls, 1)
  })
}

test('auxiliary retry respects a provider delay above the normal policy cap', async () => {
  let calls = 0
  const ctx = { llm: {
    providerRetryPolicy: () => policy,
    async *stream() { calls++; yield errorChunk('TRANSPORT', { providerRetryAfterMs: 1000 }) },
  } }
  assert.equal((await assembleLlmStream(ctx, request)).finish.kind, 'error')
  assert.equal(calls, 1)
})

test('runtime disposal aborts an auxiliary retry backoff and admits no second request', async () => {
  const ctx = fakeContext()
  let calls = 0
  let reached
  const failed = new Promise(resolve => { reached = resolve })
  ctx.llm = {
    providerRetryPolicy: () => { reached(); return { ...policy, mode: 'always', initialDelayMs: 50, maxDelayMs: 50 } },
    async *stream() {
      if (++calls > 1) throw new Error('a request was admitted after disposal')
      yield errorChunk('TRANSPORT')
    },
  }
  const rt = { ctx, config: {}, state: { bots: {}, prefs: {} } }
  install(rt)
  const answer = rt.assembleLlm(request)
  await failed
  await ctx.dispose()
  assert.equal((await answer).finish.kind, 'aborted')
  assert.equal(calls, 1)
})
