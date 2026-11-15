import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCliLogin } from '../src/client/cli-login-state.js'
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const provider = 'acp-codex'
function fixture(t, overrides = {}) {
  const calls = []
  let model = `${provider}/default`, exists = true
  const actions = {
    cliLoginReset: async () => { calls.push('reset') },
    cliLoginCurrent: async () => { calls.push('open'); return {} },
    cliLoginStart: async (...args) => { calls.push(['start', ...args]); return { status: 'waiting', attemptId: 'fresh' } },
    cliLoginCancel: async () => { calls.push('cancel'); assert.fail('view invalidation must not cancel a host attempt') },
    ...overrides,
  }
  const login = createCliLogin({ actions, modelOf: () => model, botOf: () => exists ? { id: 'a' } : undefined })
  t.after(() => login.dispose())
  return { login, calls, model: value => { model = value }, remove: () => { exists = false } }
}

test('confirmed recovery discards a preexisting row and awaits reset then fresh open then ordinary start', async t => {
  const reset = deferred(), open = deferred()
  let opens = 0
  const h = fixture(t, { cliLoginReset: () => { h.calls.push('reset'); return reset.promise },
    cliLoginCurrent: () => { h.calls.push('open'); return ++opens === 1 ? {} : open.promise } })
  await h.login.open({ botId: 'a', provider })
  const old = h.login.getSnapshot().rows.a.seq
  const recovering = h.login.recover({ botId: 'a', provider })
  await tick()
  assert.deepEqual(h.calls, ['open', 'reset'])
  reset.resolve({})
  await tick()
  assert.deepEqual(h.calls, ['open', 'reset', 'open'])
  assert.notEqual(h.login.getSnapshot().rows.a.seq, old)
  open.resolve({})
  assert.equal(await recovering, true)
  assert.deepEqual(h.calls, ['open', 'reset', 'open', ['start', 'a', provider, undefined]])
})

test('failed Reset cannot open or start and leaves the original row intact', async t => {
  const h = fixture(t, { cliLoginReset: async () => { throw new Error('reset refused') } })
  await h.login.open({ botId: 'a', provider })
  const row = h.login.getSnapshot().rows.a
  await assert.rejects(h.login.recover({ botId: 'a', provider }), /reset refused/)
  assert.equal(h.login.getSnapshot().rows.a, row)
  assert.deepEqual(h.calls, ['open'])
})

for (const phase of ['reset', 'open']) for (const change of ['model', 'provider', 'deleted', 'disposed', 'superseded']) {
  test(`recovery stops after deferred ${phase} when ${change}`, async t => {
    const gate = deferred()
    const h = fixture(t, phase === 'reset'
      ? { cliLoginReset: () => gate.promise }
      : { cliLoginCurrent: () => gate.promise })
    const pending = h.login.recover({ botId: 'a', provider })
    await tick()
    if (change === 'model') h.model(`${provider}/other`)
    if (change === 'provider') h.model('acp-claude/other')
    if (change === 'deleted') h.remove()
    if (change === 'disposed') h.login.dispose()
    if (change === 'superseded') h.login.dismiss('a')
    gate.resolve({})
    assert.equal(await pending, false)
    assert.equal(h.calls.some(call => Array.isArray(call) && call[0] === 'start'), false)
    assert.equal(h.login.getSnapshot().rows.a, undefined, 'no abandoned busy offer')
  })
}

for (const kind of ['account', 'attempt']) {
  test(`fresh open with an existing ${kind} retains ordinary confirmation/join without an automatic new start`, async t => {
    const current = kind === 'account' ? { account: { ref: 'confirmation-needed' } }
      : { attempt: { status: 'waiting', attemptId: 'already-live' } }
    const h = fixture(t, { cliLoginCurrent: async () => current })
    assert.equal(await h.login.recover({ botId: 'a', provider }), true)
    assert.equal(h.login.getSnapshot().rows.a.stage, kind)
    assert.deepEqual(h.calls, ['reset'])
  })
}

test('late old-provider poll results cannot replace a fresh recovery offer', async t => {
  const poll = deferred(), reset = deferred(), current = deferred()
  let interval
  const h = fixture(t, { cliLoginReset: () => reset.promise, cliLoginCurrent: async () => ({}), cliLoginStatus: () => poll.promise })
  h.login.dispose()
  const actions = {
    cliLoginReset: () => reset.promise,
    cliLoginCurrent: () => current.promise,
    cliLoginStart: async () => ({ status: 'waiting', attemptId: 'new' }),
    cliLoginStatus: () => poll.promise,
  }
  const login = createCliLogin({ actions, botOf: () => ({ id: 'a' }), modelOf: () => null,
    timers: { setInterval: fn => { interval = fn; return 1 }, clearInterval() {}, setTimeout() {}, clearTimeout() {} } })
  t.after(() => login.dispose())
  current.resolve({ attempt: { status: 'waiting', attemptId: 'old' } })
  await login.open({ botId: 'a', provider })
  interval()
  const recovered = login.recover({ botId: 'a', provider })
  reset.resolve({})
  await recovered
  poll.resolve({ status: 'ready', attemptId: 'old' })
  await tick()
  assert.equal(login.getSnapshot().rows.a.stage, 'attempt')
})

for (const phase of ['open', 'start']) for (const outcome of ['success', 'error']) {
  for (const change of ['model', 'provider', 'deleted', 'disposed', 'superseded']) {
    test(`deferred recovery ${phase} ${outcome} retires its busy row after ${change}`, async t => {
      const gate = deferred()
      const h = fixture(t, phase === 'open'
        ? { cliLoginCurrent: () => gate.promise }
        : { cliLoginStart: () => gate.promise })
      const pending = h.login.recover({ botId: 'a', provider })
      await tick()
      assert.equal(h.login.getSnapshot().rows.a.busy, true)
      if (change === 'model') h.model(`${provider}/other`)
      if (change === 'provider') h.model('acp-claude/other')
      if (change === 'deleted') h.remove()
      if (change === 'disposed') h.login.dispose()
      // A newer intent elsewhere must also release this operation's pending view.
      if (change === 'superseded') h.login.dismiss('another-bot')
      if (outcome === 'error') gate.reject(new Error('deferred RPC failed'))
      else gate.resolve(phase === 'open' ? {} : { status: 'waiting', attemptId: 'host-live' })
      assert.equal(await pending, false)
      assert.equal(h.login.getSnapshot().rows.a, undefined)
      assert.equal(h.calls.includes('cancel'), false)
      if (phase === 'open') assert.equal(h.calls.some(call => Array.isArray(call) && call[0] === 'start'), false)
    })
  }
}

for (const change of ['model', 'provider', 'deleted']) {
  test(`following ${change} retires a pending recovery before its RPC resolves`, async t => {
    const gate = deferred()
    const h = fixture(t, { cliLoginCurrent: () => gate.promise })
    const pending = h.login.recover({ botId: 'a', provider })
    await tick()
    if (change === 'model') h.model(`${provider}/other`)
    if (change === 'provider') h.model('acp-claude/other')
    if (change === 'deleted') h.remove()
    h.login.followModels()
    assert.equal(h.login.getSnapshot().rows.a, undefined)
    gate.resolve({})
    assert.equal(await pending, false)
  })
}

for (const phase of ['open', 'start']) for (const outcome of ['success', 'error']) {
  test(`late recovery ${phase} ${outcome} preserves the exact busy replacement row and its model intent`, async t => {
    const old = deferred(), replacement = deferred()
    let opens = 0
    const h = fixture(t, {
      cliLoginCurrent: () => ++opens === 1 ? (phase === 'open' ? old.promise : {}) : replacement.promise,
      cliLoginStart: () => old.promise,
    })
    const pending = h.login.recover({ botId: 'a', provider })
    await tick()
    const oldSeq = h.login.getSnapshot().rows.a.seq
    const normal = h.login.open({ botId: 'a', provider, ref: `${provider}/new-choice` })
    const row = h.login.getSnapshot().rows.a
    assert.notEqual(row.seq, oldSeq)
    assert.equal(row.busy, true)
    assert.equal(row.ref, `${provider}/new-choice`)
    if (outcome === 'error') old.reject(new Error('old operation failed'))
    else old.resolve(phase === 'open' ? {} : { status: 'waiting', attemptId: 'old-host-attempt' })
    assert.equal(await pending, false)
    assert.equal(h.login.getSnapshot().rows.a, row, 'old cleanup cannot patch or retire the new row')
    replacement.resolve({})
    assert.equal(await normal, true)
    assert.equal(h.login.getSnapshot().rows.a.seq, row.seq)
    assert.equal(h.login.getSnapshot().rows.a.busy, false)
    assert.equal(h.login.getSnapshot().rows.a.ref, `${provider}/new-choice`)
    assert.equal(h.calls.includes('cancel'), false)
  })
}

test('a normal open joins the host attempt after deferred recovery start loses authority', async t => {
  const gate = deferred()
  let hostAttempt, starts = 0
  const h = fixture(t, {
    cliLoginCurrent: async () => ({ attempt: hostAttempt }),
    cliLoginStart: async () => { starts++; hostAttempt = await gate.promise; return hostAttempt },
  })
  const pending = h.login.recover({ botId: 'a', provider })
  await tick()
  h.model(`${provider}/other`)
  gate.resolve({ status: 'waiting', attemptId: 'still-at-work' })
  assert.equal(await pending, false)
  assert.equal(h.login.getSnapshot().rows.a, undefined)
  assert.equal(await h.login.open({ botId: 'a', provider }), true)
  assert.equal(h.login.getSnapshot().rows.a.stage, 'attempt')
  assert.equal(h.login.getSnapshot().rows.a.attempt.attemptId, 'still-at-work')
  assert.equal(h.login.getSnapshot().rows.a.busy, false)
  assert.equal(starts, 1)
  assert.equal(h.calls.includes('cancel'), false)
})

test('a current recovery start error settles its own offer so Sign in and Not now remain available', async t => {
  const h = fixture(t, { cliLoginStart: async () => { throw new Error('host refused') } })
  assert.equal(await h.login.recover({ botId: 'a', provider }), false)
  const row = h.login.getSnapshot().rows.a
  assert.equal(row.stage, 'offer')
  assert.equal(row.busy, false)
  assert.equal(row.error, 'host refused')
  h.login.dismiss('a')
  assert.equal(h.login.getSnapshot().rows.a, undefined)
})

test('a newer start owns a reused settled offer even before the old recovery continuation resumes', async t => {
  const gate = deferred()
  const h = fixture(t, { cliLoginStart: () => gate.promise })
  let normal, seq
  const unsubscribe = h.login.subscribe(() => {
    const row = h.login.getSnapshot().rows.a
    if (seq !== undefined || row?.stage !== 'offer' || row.busy) return
    seq = row.seq
    normal = h.login.start('a')
  })
  t.after(unsubscribe)
  assert.equal(await h.login.recover({ botId: 'a', provider }), false)
  const replacement = h.login.getSnapshot().rows.a
  assert.equal(replacement.seq, seq)
  assert.equal(replacement.busy, true, 'the newer start still owns its pending view')
  gate.resolve({ status: 'waiting', attemptId: 'new-intent' })
  assert.equal(await normal, true)
  assert.equal(h.login.getSnapshot().rows.a.seq, seq)
  assert.equal(h.login.getSnapshot().rows.a.attempt.attemptId, 'new-intent')
  assert.equal(h.login.getSnapshot().rows.a.busy, false)
  assert.equal(h.calls.includes('cancel'), false)
})
