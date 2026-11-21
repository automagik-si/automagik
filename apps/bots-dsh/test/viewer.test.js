import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browser, bundle, httpRefusal, load, manualTimeouts, refusal, reply, stalledResponse, tick, viewerReply } from './viewer-fixture.js'

const code = await bundle(`
export { bootView, isRetired, mountedViewer, onRetire, startViewer } from './src/client/viewer.js'
export { call } from './src/client/api.js'
export { clientErrors } from './src/client/diagnostics.js'
export { toCodex } from './src/client/character-select.js'
export const publishedViewer = () => globalThis.__AUTOMAGIK_MOUNTED_VIEWER__
`)
function fixture(options) {
  const f = browser(options)
  return { ...f, api: load(code, f.globals) }
}
const boot = { version: 1, role: 'member' }

test('VW1 absent boot is desktop, recognized roles are preserved and invalid data holds closed', () => {
  assert.equal(fixture().api.bootView(), undefined)
  for (const role of ['owner', 'member', 'guest', 'none']) {
    const value = { version: 1, role }
    assert.equal(fixture({ boot: value }).api.bootView(), value)
  }
  for (const value of [null, true, { role: 'owner' }, { version: 2, role: 'member' }, { version: 1, role: 'admin' }]) {
    assert.equal(fixture({ boot: value }).api.bootView().role, 'none')
  }
})

test('VW2 nothing runs before whoami confirms the role, and a mismatch reloads once', async () => {
  const pending = Promise.withResolvers()
  const session = new Map()
  const f = fixture({ boot, fetch: () => pending.promise, session })
  const starting = f.api.startViewer(f.api.bootView())
  assert.deepEqual(f.calls.map(call => call.body), [{ endpoint: 'whoami', payload: null }])
  assert.equal(f.api.mountedViewer(), undefined)
  assert.equal(f.api.publishedViewer(), undefined)
  await assert.rejects(f.api.call('state'), { code: 'bot/retired' })
  assert.equal(f.calls.length, 1)
  pending.resolve(viewerReply('guest'))
  await assert.rejects(starting)
  assert.deepEqual(f.reloads, [true])
  const restarted = fixture({ boot, fetch: () => viewerReply('guest'), session })
  await assert.rejects(restarted.api.startViewer(restarted.api.bootView()))
  assert.equal(restarted.api.mountedViewer(), undefined)
  assert.equal(restarted.document.body.inert, true)
  assert.deepEqual(restarted.reloads, [])
})

test('VW3 storage changes, mismatched whoami, viewer error and 401/403 retire before another fetch', async () => {
  for (const trigger of ['storage', 'clear', 'whoami', 'role', 'bot/viewer-changed', '401', '403']) {
    let fail
    const clock = manualTimeouts()
    const f = fixture({ boot, timers: clock.timers, fetch: call => fail ?? (call.body.endpoint === 'whoami' ? viewerReply('member') : reply({})) })
    const viewer = await f.api.startViewer(f.api.bootView())
    const published = f.api.publishedViewer()
    assert.equal(published.id, viewer.id)
    let cleanup = 0
    f.api.onRetire(() => { cleanup++; assert.equal(f.api.isRetired(), true) })
    await f.api.call('state', { health: true })
    assert.deepEqual(f.calls.at(-1).body, { endpoint: 'state', payload: { health: true }, viewer: viewer.id })
    assert.deepEqual(f.writes, [['automagik.viewer', viewer.id]])
    for (const key of ['dsh.conversation.a', 'dsh.conversation.b']) f.localStorage.setItem(key, 'draft from this tab')
    if (trigger === 'storage' || trigger === 'clear') {
      f.window.emit('storage', { key: trigger === 'clear' ? null : 'automagik.viewer', newValue: 'new-id' })
    } else if (trigger === 'whoami' || trigger === 'role') {
      fail = trigger === 'role' ? viewerReply('guest', viewer.id) : viewerReply('member', 'new-id')
      f.window.emit('focus')
      await tick()
      assert.deepEqual(f.calls.at(-1).body, { endpoint: 'whoami', payload: null, viewer: viewer.id })
    } else {
      fail = Number.isInteger(Number(trigger)) ? { ok: false, status: Number(trigger) } : refusal(trigger, 'Your sign-in changed; reload this page.')
      await assert.rejects(f.api.call('state'))
      if (trigger === '401' || trigger === '403') {
        assert.deepEqual(f.calls.at(-1).body, { endpoint: 'whoami', payload: null, viewer: viewer.id })
        await tick()
        clock.advance(750)
        await tick()
      }
    }
    const requests = f.calls.length
    await assert.rejects(f.api.call('state'), { code: 'bot/retired' })
    await assert.rejects(f.api.call('whoami'), { code: 'bot/retired' })
    assert.throws(() => published.id, { code: 'bot/retired' })
    assert.throws(() => published.check(), { code: 'bot/retired' })
    assert.equal(f.calls.length, requests)
    assert.equal(f.api.isRetired(), true)
    assert.equal(f.document.body.inert, true)
    assert.deepEqual([...f.localStorage.values], [['keep', 'yes'], ['automagik.viewer', viewer.id]])
    assert.deepEqual(f.reloads, [true])
    assert.equal(cleanup, 1)
  }
})

test('VW4 desktop calls keep their body and install no watcher or storage entry', async () => {
  const f = fixture({ fetch: () => reply({ state: true }) })
  assert.deepEqual(await f.api.call('state'), { state: true })
  assert.deepEqual(f.calls.map(call => call.body), [{ endpoint: 'state', payload: null }])
  assert.equal(f.api.publishedViewer(), undefined)
  assert.deepEqual(f.writes, [])
  assert.equal(f.window.listeners.size, 0)
  assert.equal(f.document.listeners.size, 0)
  assert.equal(f.intervals.size, 0)
})

test('VW5 startup whoami retries rate limits, unavailability and network failure while the page stays closed', async () => {
  const timeouts = []
  const delays = []
  const responses = [
    () => ({ ok: false, status: 429 }),
    () => ({ ok: false, status: 503 }),
    () => { throw new TypeError('network failure') },
    () => viewerReply('member'),
  ]
  const f = fixture({ boot, fetch: () => responses.shift()(), timers: {
    setTimeout(run, delay) { timeouts.push(run); delays.push(delay); return run },
  } })
  const starting = f.api.startViewer(f.api.bootView())
  void starting.catch(() => {})
  for (const count of [1, 2, 3]) {
    await tick()
    assert.equal(f.calls.length, count)
    assert.equal(f.api.mountedViewer(), undefined)
    assert.equal(f.document.body.inert, true)
    assert.equal(f.document.body.style.getPropertyValue('display'), 'none')
    await assert.rejects(f.api.call('state'), { code: 'bot/retired' })
    assert.equal(f.calls.length, count)
    timeouts.shift()()
  }
  assert.equal((await starting).role, 'member')
  assert.deepEqual(delays, [250, 500, 1000])
  assert.equal(f.document.body.inert, false)
  assert.equal(f.document.body.style.getPropertyValue('display'), '')
  assert.deepEqual(f.reloads, [])
})

test('VW6 a stale image retains API diagnostics while a stale sharing save goes to the People card', async () => {
  const f = fixture({ fetch: () => refusal('bot/stale', 'Stale fixture') })
  await assert.rejects(f.api.call('send', { sessionId: 'b', images: ['expired'] }), { code: 'bot/stale' })
  await assert.rejects(f.api.call('update-bot', { id: 'b', people: { mode: 'owners' } }), { code: 'bot/stale' })
  const entries = f.api.clientErrors()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].text, 'send: Stale fixture')
})

test('VW7 a resumed owner cannot erase or persist over the next owner’s draft', async () => {
  const owner = { version: 1, role: 'owner' }
  const shared = new Map()
  // Both Storage objects are per-document views of the same origin data.
  const a = fixture({ boot: owner, local: shared, fetch: () => viewerReply('owner', 'owner-a') })
  const b = fixture({ boot: owner, local: shared, fetch: () => viewerReply('owner', 'owner-b') })
  await a.api.startViewer(owner)
  a.localStorage.setItem('dsh.conversation.a', 'draft A')
  shared.clear() // Clear-Site-Data from the new sign-in.
  await b.api.startViewer(owner)
  b.localStorage.setItem('dsh.conversation.a', 'draft B')
  b.localStorage.setItem('dsh.conversation.b', 'another draft B')
  a.api.onRetire(() => a.localStorage.setItem('dsh.conversation.a', ''))
  a.window.emit('storage', { key: 'automagik.viewer', newValue: 'owner-b' })
  a.localStorage.setItem('dsh.conversation.a', 'late draft A')
  assert.equal(a.document.body.inert, true)
  assert.equal(shared.get('dsh.conversation.a'), 'draft B')
  assert.equal(shared.get('dsh.conversation.b'), 'another draft B')
})

test('VW8 a gate-marked DSH 401 refresh does not retire the current owner or erase the draft', async () => {
  const owner = { version: 1, role: 'owner' }
  let response = reply('refreshed')
  const f = fixture({ boot: owner, fetch: ({ body }) => body.endpoint === 'whoami' ? viewerReply('owner') : response })
  await f.api.startViewer(owner)
  f.localStorage.setItem('dsh.conversation.a', 'current draft')
  response = { ok: false, status: 401, headers: new Headers({ 'x-automagik-dsh-refresh': '1' }) }
  await assert.rejects(f.api.call('state'), { code: 'HTTP_401' })
  assert.deepEqual(f.calls.at(-1).body, { endpoint: 'whoami', payload: null, viewer: 'viewer-id' })
  assert.equal(f.api.isRetired(), false)
  assert.equal(f.localStorage.getItem('dsh.conversation.a'), 'current draft')
  response = reply('refreshed')
  assert.equal(await f.api.call('state'), 'refreshed')
})

test('VW10 a gated chunk that fails twice closes both pages and reloads only once', async () => {
  const session = new Map()
  const prepare = async () => { throw new Error('gated chunk unavailable') }
  for (const role of ['owner', 'member']) {
    session.clear()
    const boot = { version: 1, role }
    for (const reloads of [[true], []]) {
      const f = fixture({ boot, session, fetch: () => viewerReply(role) })
      await assert.rejects(f.api.startViewer(boot, undefined, prepare), /gated chunk unavailable/)
      assert.equal(f.api.isRetired(), true)
      assert.equal(f.api.mountedViewer(), undefined)
      assert.equal(f.document.body.inert, true)
      assert.equal(f.document.body.style.getPropertyValue('display'), 'none')
      assert.deepEqual(f.reloads, reloads)
    }
    const recovered = fixture({ boot, session, fetch: () => viewerReply(role) })
    await recovered.api.startViewer(boot, undefined, async () => {})
    assert.equal(recovered.document.body.inert, false)
    assert.equal(session.has('automagik.retired'), false)
  }
})

test('VW9 an asynchronous Codex atlas export checks its mounted viewer before the PUT', async () => {
  const sheet = Promise.withResolvers()
  const owner = { version: 1, role: 'owner' }
  const f = fixture({ boot: owner, fetch: call => {
    if (call.body?.endpoint === 'whoami') return viewerReply('owner', 'owner-a')
    if (call.method === 'GET') return sheet.promise
    assert.fail('A retired owner sent a pet PUT')
  } })
  await f.api.startViewer(owner)
  const exporting = f.api.toCodex({ name: 'Fixture' }, { pet: { source: 'builtin', id: 'fixture' } })
  f.localStorage.setItem('automagik.viewer', 'owner-b')
  sheet.resolve({ blob: () => new Blob() })
  await assert.rejects(exporting, { code: 'bot/retired' })
  assert.equal(f.calls.some(call => call.method === 'PUT'), false)
})

const owner = { version: 1, role: 'owner' }
const pet = { pet: { source: 'builtin', id: 'fixture', sleep: false } }

for (const [name, operation, response] of [
  ['Bot success status', 'state', refusal('bot/viewer-changed')],
  ['Bot error status', 'state', httpRefusal(503, { error: { code: 'bot/viewer-changed' } })],
  ['pet PUT 403', 'pet', httpRefusal(403, { code: 'bot/viewer-changed', error: 'Your sign-in changed' })],
]) {
  test(`H2 ${name} retires immediately on explicit viewer-changed`, async () => {
    const f = fixture({ boot: owner, fetch: ({ body, method }) => {
      if (body?.endpoint === 'whoami') return viewerReply('owner')
      if (method === 'GET') return { blob: () => new Blob() }
      return response
    } })
    await f.api.startViewer(owner)
    let retired = 0
    f.api.onRetire(() => retired++)
    const request = operation === 'pet' ? f.api.toCodex({ name: 'Fixture' }, pet) : f.api.call(operation)
    await assert.rejects(request, { code: 'bot/viewer-changed' })
    assert.equal(f.api.isRetired(), true)
    assert.equal(f.document.body.inert, true)
    assert.deepEqual(f.reloads, [true])
    assert.equal(retired, 1)
    assert.equal(f.calls.filter(call => call.body?.endpoint === 'whoami').length, 1)
    if (operation === 'pet') {
      assert.equal(f.calls.at(-1).method, 'PUT')
      assert.equal(f.calls.at(-1).headers['x-automagik-viewer'], 'viewer-id')
    }
  })
}

for (const end of ['deadline', 'disposal']) {
  test(`H2 ${end} cancels and unlocks a stalled pet PUT 403 body`, async t => {
    const timeouts = new Map()
    const timers = {
      setTimeout(run, delay) { timeouts.set(run, delay); return run },
      clearTimeout(run) { timeouts.delete(run) },
    }
    let cancelled = 0
    const response = new Response(new ReadableStream({ cancel() { cancelled++ } }), { status: 403 })
    const f = fixture({ boot: owner, timers, fetch: ({ body, method }) => {
      if (body?.endpoint === 'whoami') return viewerReply('owner')
      if (method === 'GET') return { blob: () => new Blob() }
      return response
    } })
    const lifetime = new AbortController()
    t.after(() => lifetime.abort())
    await f.api.startViewer(owner, lifetime.signal)
    f.localStorage.setItem('dsh.conversation.a', 'current draft')
    const rejected = assert.rejects(f.api.toCodex({ name: 'Fixture' }, pet), /pets folder/)
    await tick()
    assert.equal(response.body.locked, true)
    assert.equal(f.document.body.inert, false)
    assert.deepEqual([...timeouts.values()], [5_000])
    if (end === 'deadline') timeouts.keys().next().value()
    else lifetime.abort()
    await rejected
    assert.equal(cancelled, 1)
    assert.equal(response.body.locked, false)
    assert.equal(timeouts.size, 0)
    assert.equal(f.api.isRetired(), false)
    assert.equal(f.document.body.inert, end === 'disposal')
    assert.equal(f.localStorage.getItem('dsh.conversation.a'), 'current draft')
    assert.deepEqual(f.reloads, [])
    const whoami = f.calls.filter(call => call.body?.endpoint === 'whoami')
    assert.deepEqual(whoami.map(call => call.body.viewer), end === 'deadline' ? [undefined, 'viewer-id'] : [undefined])
  })
}

test('H2 desktop 401 keeps the original error and makes one unbound request', async () => {
  const f = fixture({ fetch: () => httpRefusal(401, { code: 'bot/viewer-changed' }) })
  assert.equal(f.api.bootView(), undefined)
  await assert.rejects(f.api.call('state', { health: true }), { code: 'HTTP_401', message: 'HTTP 401' })
  assert.deepEqual(f.calls.map(call => call.body), [{ endpoint: 'state', payload: { health: true } }])
  assert.equal(f.window.listeners.size + f.document.listeners.size + f.intervals.size, 0)
  assert.equal(f.api.publishedViewer(), undefined)
  assert.equal(f.document.body.inert, false)
})

for (const first of ['chunk', 'whoami']) {
  test(`H2 startup reveals the body only after whoami and the gated chunk (${first} ready first)`, async () => {
    const whoami = Promise.withResolvers()
    const chunk = Promise.withResolvers()
    const f = fixture({ boot, fetch: () => whoami.promise })
    f.sessionStorage.setItem('automagik.retired', '1')
    const starting = f.api.startViewer(boot, undefined, () => chunk.promise)
    const finishWhoami = () => whoami.resolve(viewerReply('member'))
    const finishChunk = () => chunk.resolve()
    const finish = first === 'chunk' ? [finishChunk, finishWhoami] : [finishWhoami, finishChunk]
    finish[0]()
    await tick()
    assert.equal(f.document.body.inert, true)
    assert.equal(f.document.body.style.getPropertyValue('display'), 'none')
    assert.equal(f.sessionStorage.getItem('automagik.retired'), '1')
    finish[1]()
    await starting
    assert.equal(f.document.body.inert, false)
    assert.equal(f.document.body.style.getPropertyValue('display'), '')
    assert.equal(f.sessionStorage.getItem('automagik.retired'), null)
  })
}

test('H2 storage clear retires once while a matching revalidation is in flight', async () => {
  const pending = Promise.withResolvers()
  const f = fixture({ boot: owner, fetch: ({ body }) => {
    if (body.endpoint !== 'whoami') return httpRefusal(401)
    return body.viewer ? pending.promise : viewerReply('owner')
  } })
  await f.api.startViewer(owner)
  let retired = 0
  f.api.onRetire(() => retired++)
  await assert.rejects(f.api.call('state'), { code: 'HTTP_401' })
  f.localStorage.values.clear()
  f.window.emit('storage', { key: null, newValue: null })
  pending.resolve(viewerReply('owner'))
  await tick()
  await assert.rejects(f.api.call('state'), { code: 'bot/retired' })
  assert.equal(f.document.body.inert, true)
  assert.deepEqual(f.reloads, [true])
  assert.equal(retired, 1)
})

for (const [name, answer] of [
  ['another person', () => viewerReply('owner', 'owner-b')],
  ['another role', () => viewerReply('member', 'owner-a')],
]) {
  test(`H2 a stale refusal revalidates the original viewer and retires once on ${name}`, async () => {
    const pending = Promise.withResolvers()
    const lifetime = new AbortController()
    const f = fixture({ boot: owner, fetch: ({ body }) => {
      if (body.endpoint !== 'whoami') return httpRefusal(401)
      return body.viewer ? pending.promise : viewerReply('owner', 'owner-a')
    } })
    await f.api.startViewer(owner, lifetime.signal)
    let retired = 0
    f.api.onRetire(() => retired++)
    const key = 'dsh.conversation.a'
    f.localStorage.setItem(key, 'current draft')
    await assert.rejects(f.api.call('state'), { code: 'HTTP_401' })
    assert.deepEqual(f.calls.at(-1).body, { endpoint: 'whoami', payload: null, viewer: 'owner-a' })
    assert.equal(f.document.body.inert, false)
    assert.equal(f.localStorage.getItem(key), 'current draft')
    pending.resolve(answer())
    await tick()
    assert.equal(f.document.body.inert, true)
    assert.equal(f.localStorage.getItem(key), null)
    assert.deepEqual(f.reloads, [true])
    assert.equal(retired, 1)
    await assert.rejects(f.api.call('state'), { code: 'bot/retired' })
    assert.equal(f.calls.length, 3)
    lifetime.abort()
  })
}

test('H2 a same-owner remount keeps its transcript while an old revalidation is pending', async () => {
  const pending = Promise.withResolvers()
  const f = fixture({ boot: owner, fetch: ({ body }) => {
    if (body.endpoint !== 'whoami') return httpRefusal(401)
    return body.viewer ? pending.promise : viewerReply('owner', 'owner-a')
  } })
  const lifetime = new AbortController()
  await f.api.startViewer(owner, lifetime.signal)
  const key = 'dsh.conversation.a'
  f.localStorage.setItem(key, 'current draft')
  f.document.body.replaceChildren({ text: 'current transcript' })
  await assert.rejects(f.api.call('state'), { code: 'HTTP_401' })
  assert.equal(f.calls.at(-1).body.viewer, 'owner-a')

  lifetime.abort()
  await f.api.startViewer(owner)
  pending.resolve(viewerReply('guest', 'owner-a'))
  await tick()
  assert.equal(f.document.body.inert, false)
  assert.equal(f.localStorage.getItem(key), 'current draft')
  assert.deepEqual(f.document.body.children, [{ text: 'current transcript' }])
  assert.deepEqual(f.reloads, [])
  assert.equal(f.api.publishedViewer().id, 'owner-a')
})

test('R8 stalled first 401 body starts the retry at the normal delay and is cancelled at the deadline', async () => {
  const clock = manualTimeouts()
  let checks = 0
  let cancelled = 0
  const f = fixture({ boot: owner, timers: clock.timers, fetch: ({ body }) => {
    if (!body.viewer) return viewerReply('owner', 'owner-a')
    if (++checks === 1) return stalledResponse(401, () => { cancelled++ })
    return viewerReply('owner', 'owner-a')
  } })
  await f.api.startViewer(owner)
  f.window.emit('focus')
  const request = f.calls.at(-1)
  await tick()
  assert.equal(checks, 1)
  clock.advance(750)
  await tick()
  assert.equal(checks, 2)
  assert.equal(request.signal.aborted, false)
  assert.equal(cancelled, 0)
  clock.advance(5_000)
  await tick()
  assert.equal(request.signal.aborted, true)
  assert.equal(cancelled, 1)
  assert.equal(clock.pending.size, 0)
  assert.equal(f.document.body.inert, false)
  assert.deepEqual(f.reloads, [])
})

test('a revalidation refusal body can confirm the viewer changed before the retry', async () => {
  const clock = manualTimeouts()
  const f = fixture({ boot: owner, timers: clock.timers, fetch: ({ body }) => body.viewer
    ? httpRefusal(401, { code: 'bot/viewer-changed' }, { 'x-automagik-dsh-refresh': '1' })
    : viewerReply('owner', 'owner-a') })
  await f.api.startViewer(owner)
  f.window.emit('focus')
  await tick()
  assert.equal(f.api.isRetired(), true)
  assert.equal(f.document.body.inert, true)
  assert.deepEqual(f.reloads, [true])
  assert.equal(clock.pending.size, 0)
  assert.equal(f.calls.length, 2)
})

test('H2 a stalled 200 is aborted at the revalidation deadline and a later check sees revocation', async () => {
  const clock = manualTimeouts()
  const stalled = Promise.withResolvers()
  let checks = 0
  const f = fixture({ boot: owner, timers: clock.timers, fetch: ({ body }) => {
    if (!body.viewer) return viewerReply('owner', 'owner-a')
    if (++checks === 1) return { ok: true, json: () => stalled.promise }
    return httpRefusal(401)
  } })
  await f.api.startViewer(owner)
  f.window.emit('focus')
  await tick()
  const request = f.calls.at(-1)
  clock.advance(5_000)
  await tick()
  assert.equal(request.signal?.aborted, true)
  assert.equal(f.api.isRetired(), false)

  f.window.emit('focus')
  await tick()
  assert.equal(checks, 2)
  assert.equal(f.api.isRetired(), false)
  clock.advance(750)
  await tick()
  assert.equal(checks, 3)
  assert.equal(f.api.isRetired(), true)
  assert.deepEqual(f.reloads, [true])
  assert.equal(clock.pending.size, 0)
  stalled.resolve({ ok: true, value: {} })
})
