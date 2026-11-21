import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browser, bundle, load, refusal, reply, tick, viewerReply } from './viewer-fixture.js'

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
    const f = fixture({ boot, fetch: call => fail ?? (call.body.endpoint === 'whoami' ? viewerReply('member') : reply({})) })
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
      fail = viewerReply(trigger === 'role' ? 'guest' : 'member', 'new-id')
      f.window.emit('focus')
      await tick()
      assert.deepEqual(f.calls.at(-1).body, { endpoint: 'whoami', payload: null, viewer: viewer.id })
    } else {
      fail = Number.isInteger(Number(trigger)) ? { ok: false, status: Number(trigger) } : refusal(trigger, 'Your sign-in changed; reload this page.')
      await assert.rejects(f.api.call('state'))
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
  let response = viewerReply('owner')
  const f = fixture({ boot: owner, fetch: () => response })
  await f.api.startViewer(owner)
  f.localStorage.setItem('dsh.conversation.a', 'current draft')
  response = { ok: false, status: 401, headers: new Headers({ 'x-automagik-dsh-refresh': '1' }) }
  await assert.rejects(f.api.call('state'), { code: 'HTTP_401' })
  assert.equal(f.api.isRetired(), false)
  assert.equal(f.localStorage.getItem('dsh.conversation.a'), 'current draft')
  response = reply('refreshed')
  assert.equal(await f.api.call('state'), 'refreshed')
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
