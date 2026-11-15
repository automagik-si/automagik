import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { CHECK_TIMEOUT_MS, DOWNLOAD_TIMEOUT_MS, forceUpdate } from '../src/force-update.js'
import { startUpdates } from '../src/update.js'

function fixture(overrides = {}) {
  const calls = [], states = []
  const deps = {
    appReady: () => false, appMode: () => 'auto',
    check: async () => { calls.push('check'); return { result: 'latest' } },
    waitAppReady: async options => { calls.push(['wait', options]); return false },
    installApp: async () => { calls.push('install') },
    lookLanes: async () => { calls.push('lanes') }, laneStaged: () => false,
    applyLane: async () => { calls.push('apply'); return 'good' },
    restartDsh: async () => { calls.push('restart') }, publish: state => states.push(state),
    ...overrides,
  }
  return { deps, calls, states }
}

test('a ready app installs first, without checking or staging old-line plugins', async () => {
  const h = fixture({ appReady: () => true })
  await forceUpdate(h.deps)
  assert.deepEqual(h.calls, ['install'])
  assert.deepEqual(h.states.map(s => s.phase), ['stopping', 'installing'])
})

test('a check finding an app waits for readiness and installs', async () => {
  let ready = false
  const h = fixture({ appReady: () => ready, check: async () => ({ result: 'found' }),
    waitAppReady: async ({ timeoutMs }) => { assert.equal(timeoutMs, DOWNLOAD_TIMEOUT_MS); ready = true; return true } })
  await forceUpdate(h.deps)
  assert.deepEqual(h.calls, ['lanes', 'install'])
  assert.deepEqual(h.states.map(s => s.phase), ['stopping', 'checking', 'downloading', 'installing'])
})

test('a bounded download timeout continues through a manual plugin apply', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = fixture({ check: async () => ({ result: 'found' }), laneStaged: () => true,
    waitAppReady: () => new Promise(() => {}), downloadTimeoutMs: 20 })
  const work = forceUpdate(h.deps)
  for (let i = 0; i < 20; i++) await Promise.resolve()
  assert.equal(h.states.at(-1).phase, 'downloading')
  t.mock.timers.tick(20)
  assert.deepEqual(await work, { phase: 'done', code: 'app-download-failed' })
  assert.deepEqual(h.calls, ['lanes', 'apply'])
})

test('notify and disabled modes restart with the package manager explanation', async () => {
  for (const mode of ['notify', null]) {
    const h = fixture({ appMode: () => mode, check: async () => ({ result: 'found' }) })
    assert.deepEqual(await forceUpdate(h.deps), { phase: 'done', code: 'app-manual' })
    assert.deepEqual(h.calls, ['lanes', 'restart'])
  }
})

test('staged plugins apply manually; a rollback or failed restart is reported', async () => {
  for (const [outcome, phase, code] of [['good', 'done', 'updated'], ['restored', 'failed', 'plugins-rolled-back'], ['rollback', 'failed', 'plugins-rolled-back'], ['down', 'failed', 'restart-failed']]) {
    const h = fixture({ laneStaged: () => true, applyLane: async () => outcome })
    assert.deepEqual(await forceUpdate(h.deps), { phase, code })
    assert.ok(!h.calls.includes('restart'))
  }
})

test('nothing new still restarts DSH; two calls join the same run', async () => {
  const h = fixture()
  const first = forceUpdate(h.deps)
  assert.equal(forceUpdate(h.deps), first)
  assert.deepEqual(await first, { phase: 'done', code: 'up-to-date' })
  assert.equal(h.calls.filter(c => c === 'restart').length, 1)
  assert.notEqual(forceUpdate(h.deps), first)
  await forceUpdate(h.deps)
})

test('checking is bounded and throws never leave progress stuck', async t => {
  assert.equal(CHECK_TIMEOUT_MS, 30_000)
  assert.equal(DOWNLOAD_TIMEOUT_MS, 300_000)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = fixture({ check: () => new Promise(() => {}), checkTimeoutMs: 25 })
  const work = forceUpdate(h.deps)
  for (let i = 0; i < 10; i++) await Promise.resolve()
  t.mock.timers.tick(25)
  assert.deepEqual(await work, { phase: 'done', code: 'app-download-failed' })
  assert.ok(h.calls.includes('restart'))
  const bad = fixture({ restartDsh: async () => { throw Error('failed') } })
  assert.deepEqual(await forceUpdate(bad.deps), { phase: 'failed', code: 'restart-failed' })
})

test('macOS readiness waits for Squirrel', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const updater = new EventEmitter()
  updater.nativeUpdater = new EventEmitter()
  updater.setFeedURL = () => {}
  updater.checkForUpdates = async () => {}
  const updates = startUpdates({ updater, current: '3.1.0', platform: 'darwin',
    env: { OMNI_DESKTOP_UPDATE_URL: 'https://example.test' },
    releases: async () => [], log: { info() {}, warn() {} }, onState() {} })
  t.after(() => updates.stop())
  const ready = updates.whenReady()
  let settled = false
  ready.then(() => { settled = true })
  updater.emit('update-downloaded', { version: '3.2.0' })
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(updates.ready, null)
  updater.nativeUpdater.emit('update-downloaded')
  assert.equal(await ready, true)
  assert.equal(updates.ready, '3.2.0')
})

test('ready waits settle on download failure, their deadline, or updater shutdown', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  for (const end of ['failure', 'deadline', 'stop']) {
    const updater = new EventEmitter()
    const updates = startUpdates({ updater, current: '3.1.0', platform: 'linux', env: {},
      releases: async () => [], log: { info() {}, warn() {} }, onState() {} })
    const work = updates.whenReady({ timeoutMs: 50 })
    if (end === 'failure') { updater.emit('update-available'); updater.emit('error', Error('bad download')) }
    else if (end === 'deadline') t.mock.timers.tick(50)
    else updates.stop()
    assert.equal(await work, false, end)
    updates.stop()
  }
})

test('a failed download wait still applies the staged lane', async () => {
  const h = fixture({ check: async () => ({ result: 'found' }), laneStaged: () => true,
    waitAppReady: async () => { throw Error('download') } })
  assert.deepEqual(await forceUpdate(h.deps), { phase: 'done', code: 'app-download-failed' })
  assert.ok(h.calls.includes('apply'))
})
