import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browser, bundle, load, refusal, reply, tick, viewerReply } from './viewer-fixture.js'

const code = await bundle(`
export { bootView, isRetired, mountedViewer, onRetire, startViewer } from './src/client/viewer.js'
export { call } from './src/client/api.js'
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
    let cleanup = 0
    f.api.onRetire(() => { cleanup++; assert.equal(f.api.isRetired(), true) })
    await f.api.call('state', { health: true })
    assert.deepEqual(f.calls.at(-1).body, { endpoint: 'state', payload: { health: true }, viewer: viewer.id })
    assert.deepEqual(f.writes, [['automagik.viewer', viewer.id]])
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
  assert.deepEqual(f.writes, [])
  assert.equal(f.window.listeners.size, 0)
  assert.equal(f.document.listeners.size, 0)
  assert.equal(f.intervals.size, 0)
})
