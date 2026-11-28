import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { DecisionProviderError } from '../decisions.js'
import { classify } from '../src/decisions/classify.js'
import { answer, fakeProvider, KEY, model, mount, REF, routing } from './fixtures/decisions/fake-provider.js'

const http = (httpStatus, retryAfterMs) => new DecisionProviderError('server', { httpStatus, retryAfterMs })
const deferred = () => Promise.withResolvers()

test('classifies HTTP, typed provider, network and abort failures without raw details', () => {
  for (const [status, reason] of [
    [400, 'invalid-request'], [401, 'auth'], [402, 'quota'], [403, 'auth'], [404, 'invalid-request'],
    [413, 'too-large'], [415, 'invalid-request'], [422, 'invalid-request'], [429, 'rate-limited'],
    [500, 'server'], [502, 'server'], [503, 'server'], [524, 'timeout'], [529, 'overloaded'],
  ]) assert.deepEqual(classify(http(status, 12)), { reason, httpStatus: status, retryAfterMs: 12 })
  assert.deepEqual(classify({ status: 400, code: 'max_tokens_exceeded' }), { reason: 'too-large', httpStatus: 400 })
  for (const code of ['safety', 'prohibited_content', 'blocklist', 'image_safety', 'content_blocked']) {
    assert.deepEqual(classify({ status: 400, code }), { reason: 'refused', httpStatus: 400 })
  }
  const network = new TypeError(KEY, { cause: { code: 'ENOTFOUND', body: KEY } })
  assert.deepEqual(classify(network), { reason: 'unreachable' })
  const tls = new Error(KEY, { cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } })
  assert.deepEqual(classify(tls), { reason: 'unreachable' })
  assert.deepEqual(classify(new DecisionProviderError('refused', { cause: network })), { reason: 'refused' })
  assert.deepEqual(classify(new TypeError(KEY)), { reason: 'invalid-response' })
  assert.deepEqual(classify(http(429, Infinity)), { reason: 'rate-limited', httpStatus: 429 })
  const caller = AbortSignal.abort(new DecisionProviderError('timeout'))
  assert.deepEqual(classify(caller.reason, caller, caller), { reason: 'cancelled' })
  const deadline = AbortSignal.abort(new DecisionProviderError('timeout'))
  assert.deepEqual(classify(deadline.reason, deadline), { reason: 'timeout' })
})

test('retries only actual 429 and 529, honours Retry-After, and stops within three attempts', async t => {
  const { decisions } = await mount(t, { providerId: 'fake', model })
  let statuses = [429, 529]
  let retryAfter = 25
  const timestamps = []
  const fake = fakeProvider({ evaluate(call) {
    timestamps.push(performance.now())
    if (statuses.length) throw http(statuses.shift(), retryAfter)
    return answer(call)
  } })
  decisions.register(fake.provider)
  const ok = await decisions.decide(routing())
  assert.equal(ok.status, 'ok')
  assert.equal(ok.attempts, 3)
  assert.ok(timestamps[1] - timestamps[0] >= 24)
  assert.ok(timestamps[2] - timestamps[1] >= 24)
  assert.equal(new Set(fake.calls.map(({ call }) => call.model)).size, 1)
  assert.equal(new Set(fake.calls.map(({ call }) => JSON.stringify(call))).size, 1)

  statuses = [529, 529, 529, 529]
  retryAfter = 0
  const overloaded = await decisions.decide(routing())
  assert.equal(overloaded.reason, 'overloaded')
  assert.equal(overloaded.attempts, 3)
  assert.equal(statuses.length, 1)

  statuses = [429]
  retryAfter = 500
  const short = await decisions.decide(routing({ deadlineMs: 600 }))
  assert.equal(short.reason, 'rate-limited')
  assert.equal(short.attempts, 1)
  assert.equal(short.retryAfterMs, 500)

  for (const [status, reason] of [[503, 'server'], [402, 'quota'], [500, 'server']]) {
    statuses = [status]
    const result = await decisions.decide(routing())
    assert.equal(result.reason, reason)
    assert.equal(result.attempts, 1)
  }
})

test('backoff is cancellable and a pre-cancelled caller sends nothing', async t => {
  const { decisions } = await mount(t, { providerId: 'fake', model })
  const started = deferred()
  const fake = fakeProvider({ evaluate() {
    started.resolve()
    throw http(429, 600)
  } })
  decisions.register(fake.provider)
  const controller = new AbortController()
  const result = decisions.decide(routing({ signal: controller.signal, deadlineMs: 1500 }))
  await started.promise
  await setImmediate()
  controller.abort(http(429))
  assert.equal((await result).reason, 'cancelled')
  assert.equal((await decisions.decide(routing({ signal: controller.signal }))).attempts, 0)
  assert.equal(fake.calls.length, 1)
  assert.equal(decisions.snapshot().providers[0].health.breaker, 'closed')
})

test('deadline includes credential lookup and ignores late credential completion', async t => {
  const resolving = deferred()
  t.after(() => resolving.resolve())
  const entered = deferred()
  const { decisions } = await mount(t, { providerId: 'fake', model }, {
    describe: async () => ({ configured: true, writable: true }),
    resolve() { entered.resolve(); return resolving.promise },
  })
  const fake = fakeProvider({ info: { credential: { ref: REF, header: 'bearer' } } })
  const remove = decisions.register(fake.provider)
  const result = decisions.decide(routing({ deadlineMs: 60 }))
  await entered.promise
  const outcome = await result
  assert.equal(outcome.reason, 'timeout')
  assert.equal(outcome.attempts, 0)
  let removed = false
  const draining = remove().then(() => { removed = true })
  try {
    await setImmediate()
    assert.equal(removed, false)
  } finally {
    resolving.resolve({ value: KEY })
  }
  await draining
  assert.equal(fake.calls.length, 0)
})

test('the eight-slot provider cap includes running cancellations and queue deadlines are busy', async t => {
  const hold = deferred()
  t.after(() => hold.resolve())
  const { decisions } = await mount(t, { providerId: 'fake', model })
  const eight = deferred()
  let active = 0
  let peak = 0
  const fake = fakeProvider({ async evaluate(call) {
    active++
    peak = Math.max(active, peak)
    if (active === 8) eight.resolve()
    try { await hold.promise } finally { active-- }
    return answer(call)
  } })
  const other = fakeProvider({ id: 'other' })
  decisions.register(fake.provider)
  decisions.register(other.provider)
  const controller = new AbortController()
  const running = Array.from({ length: 8 }, (_, i) => decisions.decide(routing({
    ...(i === 0 && { signal: controller.signal }), deadlineMs: 1500,
  })))
  await eight.promise
  controller.abort()
  assert.equal((await running[0]).reason, 'cancelled')
  const expired = await decisions.decide(routing({ deadlineMs: 75 }))
  assert.equal(expired.reason, 'busy')
  assert.equal(expired.attempts, 0)
  const queuedCaller = new AbortController()
  const cancelQueued = decisions.decide(routing({ signal: queuedCaller.signal }))
  await setImmediate()
  queuedCaller.abort(new DecisionProviderError('timeout'))
  assert.equal((await cancelQueued).reason, 'cancelled')
  assert.equal((await decisions.test({ providerId: 'other' })).status, 'ok')
  const admitted = decisions.decide(routing())
  assert.equal(fake.calls.length, 8)
  hold.resolve()
  assert.equal((await admitted).status, 'ok')
  assert.ok((await Promise.all(running)).slice(1).every(outcome => outcome.status === 'ok'))
  assert.equal(peak, 8)
  assert.equal(fake.calls.length, 9)
})

test('a provider ignoring abort keeps its slot, and late success cannot overwrite a timeout', async t => {
  const hold = deferred()
  t.after(() => hold.resolve())
  const { decisions } = await mount(t, { providerId: 'fake', model, maxConcurrent: 1, breaker: { failures: 1 } })
  const entered = deferred()
  const fake = fakeProvider({ async evaluate(call) { entered.resolve(); await hold.promise; return answer(call) } })
  decisions.register(fake.provider)
  const result = decisions.decide(routing({ deadlineMs: 100 }))
  await entered.promise
  const queued = decisions.decide(routing({ deadlineMs: 50 }))
  assert.equal((await queued).reason, 'busy')
  assert.equal((await result).reason, 'timeout')
  hold.resolve()
  await setImmediate()
  assert.equal(decisions.snapshot().providers[0].health.breaker, 'open')
  assert.equal((await decisions.decide(routing())).reason, 'breaker-open')
  assert.equal(fake.calls.length, 1)
})

test('five counted failures open the breaker, and one half-open probe closes it', async t => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const probe = deferred()
  t.after(() => probe.resolve())
  const { decisions } = await mount(t, { providerId: 'fake', model })
  const entered = deferred()
  let status = 503
  let hold = false
  const fake = fakeProvider({ async evaluate(call) {
    if (status) throw http(status, 40_000)
    if (hold) { entered.resolve(); await probe.promise }
    return answer(call)
  } })
  decisions.register(fake.provider)
  for (let i = 0; i < 4; i++) assert.equal((await decisions.decide(routing())).reason, 'server')
  status = 402
  assert.equal((await decisions.decide(routing())).reason, 'quota')
  assert.equal(decisions.snapshot().providers[0].health.breaker, 'closed')
  status = 503
  assert.equal((await decisions.decide(routing())).reason, 'server')
  assert.deepEqual(decisions.snapshot().providers[0].health, { breaker: 'open', openUntil: now + 40_000, last: 'server' })
  now += 39_999
  assert.equal((await decisions.decide(routing())).reason, 'breaker-open')
  now++
  assert.equal(decisions.snapshot().providers[0].health.breaker, 'half-open')
  status = 503
  assert.equal((await decisions.decide(routing())).reason, 'server')
  assert.equal(decisions.snapshot().providers[0].health.breaker, 'open')
  now += 40_000
  status = undefined
  hold = true
  const halfOpen = decisions.decide(routing())
  await entered.promise
  assert.equal((await decisions.decide(routing())).reason, 'breaker-open')
  probe.resolve()
  assert.equal((await halfOpen).status, 'ok')
  assert.deepEqual(decisions.snapshot().providers[0].health, { breaker: 'closed' })
  assert.equal((await decisions.decide(routing())).status, 'ok')
})

test('auth rejection leaves the breaker alone and a credential update clears it', async t => {
  let value = KEY
  const { decisions, root, rows } = await mount(t, { providerId: 'fake', model, breaker: { failures: 2 } }, {
    describe: async () => ({ configured: !!value, writable: true }),
    resolve: async () => ({ value }),
  })
  const fake = fakeProvider({ info: { credential: { ref: REF, header: 'bearer' } }, evaluate(call, key) {
    if (key === KEY) throw new DecisionProviderError('auth', { httpStatus: 401, cause: new Error(KEY) })
    return answer(call)
  } })
  decisions.register(fake.provider)
  const rejected = await decisions.decide(routing())
  assert.equal(rejected.reason, 'auth')
  assert.equal(rejected.attempts, 1)
  for (let i = 0; i < 5; i++) {
    const outcome = await decisions.decide(routing())
    assert.equal(outcome.reason, 'auth')
    assert.equal(outcome.attempts, 0)
  }
  assert.equal(fake.calls.length, 1)
  assert.equal(decisions.snapshot().notReady, 'auth')
  assert.equal(decisions.snapshot().providers[0].key.rejected, true)
  assert.equal(decisions.snapshot().providers[0].health.breaker, 'closed')
  root.emit('credentials/reference-updated', 'UNRELATED_REF')
  assert.equal((await decisions.decide(routing())).attempts, 0)
  value = 'synthetic-rotated-key'
  root.emit('credentials/reference-updated', REF)
  assert.equal((await decisions.decide(routing())).status, 'ok')
  assert.equal(fake.calls[1].key, value)
  assert.equal(decisions.snapshot().providers[0].key.rejected, undefined)
  assert.equal(JSON.stringify(rows()).includes(KEY), false)
})

test('a stale auth response cannot reject a rotated credential', async t => {
  let value = KEY
  const entered = deferred()
  const complete = deferred()
  t.after(() => complete.resolve())
  const { decisions, root } = await mount(t, { providerId: 'fake', model }, {
    describe: async () => ({ configured: true, writable: true }),
    resolve: async () => ({ value }),
  })
  const fake = fakeProvider({ info: { credential: { ref: REF, header: 'bearer' } }, async evaluate(call, key) {
    if (key === KEY) {
      entered.resolve()
      await complete.promise
      throw http(401)
    }
    return answer(call)
  } })
  decisions.register(fake.provider)
  const stale = decisions.decide(routing())
  await entered.promise
  value = 'synthetic-rotated-key'
  root.emit('credentials/reference-updated', REF)
  complete.resolve()
  assert.equal((await stale).reason, 'auth')
  assert.equal(decisions.snapshot().ready, true)
  assert.equal((await decisions.decide(routing())).status, 'ok')
})

test('provider and service disposal abort, refuse new work and join pending provider cleanup', async t => {
  for (const disposeService of [false, true]) {
    const cleanup = deferred()
    t.after(() => cleanup.resolve())
    const entered = deferred()
    const aborted = deferred()
    const { decisions, root } = await mount(t, { providerId: 'fake', model, maxConcurrent: 1 })
    const fake = fakeProvider({ async evaluate(call, _key, signal) {
      signal.addEventListener('abort', aborted.resolve, { once: true })
      entered.resolve()
      await cleanup.promise
      return answer(call)
    } })
    const other = fakeProvider({ id: 'other' })
    const unregister = decisions.register(fake.provider)
    decisions.register(other.provider)
    const running = decisions.decide(routing())
    await entered.promise
    const queued = decisions.decide(routing())
    let disposed = false
    const stopping = disposeService ? root.loader.resolve('decisions').fiber.dispose() : unregister()
    if (!disposeService) assert.equal(unregister(), stopping)
    const draining = stopping.then(() => { disposed = true })
    try {
      await aborted.promise
      await setImmediate()
      assert.equal(disposed, false)
      const expected = disposeService ? 'cancelled' : 'provider-gone'
      assert.equal((await running).reason, expected)
      assert.equal((await queued).reason, expected)
      assert.equal((await decisions.decide(routing())).reason, expected)
      assert.equal(other.calls.length, 0)
      assert.equal(fake.calls.length, 1)
    } finally { cleanup.resolve() }
    await draining
    assert.equal(disposed, true)
  }
})
