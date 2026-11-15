import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import { forceUpdate } from '../src/force-update.js'
import { forceText, versionsAnswer } from '../src/frame.js'
import { laneDecision } from '../src/lane.js'

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
function source(from, until) {
  const start = main.indexOf(from)
  const end = until === undefined ? main.length : main.indexOf(until, start)
  assert.ok(start >= 0 && end > start)
  return main.slice(start, end)
}
const plain = value => JSON.parse(JSON.stringify(value))
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

// Run the real main-process lookup and its Force adapter with fake lanes and no Electron.
function fixture({ reason = 'up-to-date', fail, staged = false, absent = false } = {}) {
  const calls = [], states = []
  const publisher = { publisher: 'automagik', plugins: ['@automagik/bots-dsh'] }
  const decision = { reason, plugins: [], line: '3.23', base: '3.23.0' }
  const context = vm.createContext({
    app: { isPackaged: true, getVersion: () => '3.22.0' },
    laneProfile: '/fake/profile', laneDsh: '0.2.3', laneTrial: null, laneApplying: null,
    laneReady: staged ? { version: '3.22.1' } : null, laneFailed: false, laneFetching: null,
    PUBLISHERS: [publisher], laneDecisions: new Map([[publisher.publisher, { reason: 'not-checked', plugins: [] }]]),
    home: '/fake/home', installedVersions: () => absent ? {} : { '@automagik/bots-dsh': '3.22.0' },
    laneMemory: () => ({}),
    checkLane: async ({ onDecision }) => {
      calls.push('check-lane')
      if (fail === 'check') throw Error('fetch or signature verification failed')
      const found = fail === 'stage' ? { version: '3.22.2', plugins: [] } : null
      onDecision({ ...decision, reason: found ? null : reason, update: found }, '3.23.1')
      return found
    },
    stagedVersion: () => staged ? '3.22.1' : null,
    stageLane: async () => { calls.push('stage'); throw Error('download or integrity verification failed') },
    changesOf: () => [], readStaged() {}, laneLog() {}, publishUpdate() {},
    readAutoApply: () => false, settingsFileOf: () => '/fake/settings', versionsAnswer,
  })
  const adapter = main.match(/  lookLanes: (async \(\) => \{[^\n]+\}),/)
  assert.ok(adapter, 'Force reads the lane reason after awaiting the lookup')
  vm.runInContext(`${source('async function lookOnce()', '// Start again into the staged plugins:')}
    ${source('function pluginReason()', "ipcMain.handle('automagik-updates-status'")}
    const lookAtLanes = lookOnce;
    globalThis.lookLanes = ${adapter[1]}`, context)
  const deps = {
    appReady: () => false, appMode: () => 'auto', check: async () => ({ result: 'latest' }),
    lookLanes: context.lookLanes, laneStaged: () => staged,
    applyLane: async () => { calls.push('apply'); return 'good' },
    restartDsh: async () => { calls.push('restart') },
    publish: state => states.push(state),
  }
  return { deps, calls, states, context }
}

test('caught lane lookup and staging failures survive Force, including an older staged update', async () => {
  for (const fail of ['check', 'stage']) {
    for (const staged of [false, true]) {
      const h = fixture({ fail, staged })
      const result = await forceUpdate(h.deps)
      assert.equal(result.phase, 'failed')
      assert.equal(result.code, 'check-failed')
      assert.equal(h.context.laneFailed, true)
      assert.deepEqual(h.calls, ['check-lane', ...(fail === 'stage' ? ['stage'] : []), staged ? 'apply' : 'restart'])
      assert.equal(h.states.at(-1), result)
      assert.equal(forceText(result).code, 'check-failed')
      assert.equal(versionsAnswer({ force: result }).force.code, 'check-failed')
    }
  }
})

test('a verified newer lane for another app line cannot end Force as up to date', async () => {
  const publisher = { publisher: 'automagik', plugins: ['@automagik/bots-dsh'] }
  const decision = laneDecision({ publisher: publisher.publisher, sequence: 2, base: '3.23.0',
    version: '3.23.1', plugins: [{ name: publisher.plugins[0], version: '3.23.1' }] },
  { publisher, appVersion: '3.22.0', dshVersion: '0.2.3', installed: { [publisher.plugins[0]]: '3.22.0' } })
  assert.equal(decision.reason, 'app-line')
  assert.equal(decision.update, null)
  const h = fixture({ reason: decision.reason })
  const result = await forceUpdate(h.deps)
  assert.deepEqual(plain(result), { phase: 'failed', code: 'app-line',
    params: { line: '3.23', base: '3.23.0', version: '3.23.1', app: '3.22.0' } })
  assert.deepEqual(h.calls, ['check-lane', 'restart'])
  assert.deepEqual(plain(versionsAnswer({ force: result }).force), plain(result))
})

test('every lane block remains visible after restart and through the versions bridge', async () => {
  for (const reason of ['app-minimum', 'trial-failed', 'dsh-range', 'older-sequence', 'invalid-lane', 'not-checked']) {
    const h = fixture({ reason })
    const result = await forceUpdate(h.deps)
    assert.equal(result.phase, 'failed', reason)
    assert.equal(result.code, reason)
    assert.equal(forceText(result).code, reason)
    assert.equal(versionsAnswer({ force: result }).force.code, reason)
    assert.ok(h.calls.includes('restart'))
  }
})

test('a failed plugin check is not hidden by an app download failure or manual mode', async () => {
  for (const mode of ['auto', 'notify']) {
    const h = fixture({ fail: 'check' })
    h.deps.appMode = () => mode
    h.deps.check = async () => ({ result: 'error' })
    const result = await forceUpdate(h.deps)
    assert.equal(result.phase, 'failed')
    assert.equal(result.code, 'check-failed')
    assert.ok(h.calls.includes('restart'))
  }
})

test('a rejected lookup still restarts DSH and reports the plugin check failure', async () => {
  const h = fixture()
  h.deps.lookLanes = async () => { throw Error('lookup') }
  assert.deepEqual(await forceUpdate(h.deps), { phase: 'failed', code: 'check-failed' })
  assert.deepEqual(h.calls, ['restart'])
})

test('a skipped lookup with no previous decision cannot claim plugins are current', async () => {
  const h = fixture()
  h.context.laneTrial = 'trial'
  const result = await forceUpdate(h.deps)
  assert.equal(result.phase, 'failed')
  assert.equal(result.code, 'not-checked')
  assert.deepEqual(h.calls, ['restart'])
})

test('the lane reason is sanitized before Force publishes or returns it', async () => {
  const h = fixture()
  h.context.checkLane = async ({ onDecision }) => {
    onDecision({ reason: 'app-line', line: '3.23', base: '/private/base', plugins: [] }, '/private/version')
    return null
  }
  const result = await forceUpdate(h.deps)
  assert.deepEqual(result, { phase: 'failed', code: 'app-line', params: { line: '3.23', app: '3.22.0' } })
  assert.equal(h.states.at(-1), result)
  assert.doesNotMatch(JSON.stringify(h.states), /private/)
})

test('a successful current lane and an uninstalled publisher keep their existing outcomes', async () => {
  for (const options of [{}, { fail: 'check', absent: true }]) {
    const h = fixture(options)
    assert.deepEqual(await forceUpdate(h.deps), { phase: 'done', code: 'up-to-date' })
    assert.equal(h.context.laneFailed, false)
    assert.deepEqual(h.calls, ['check-lane', 'restart'])
  }
})

test('a rollback still outranks a lane check failure', async () => {
  const h = fixture({ fail: 'check', staged: true })
  h.deps.applyLane = async () => 'restored'
  assert.deepEqual(await forceUpdate(h.deps), { phase: 'failed', code: 'plugins-rolled-back' })
})

test('quit awaits drafts and preparation, then the current process stop, then app.quit', async () => {
  const calls = []
  const drafts = deferred(), preparation = deferred(), stopped = deferred()
  const child = {}
  const context = vm.createContext({
    quitting: false, window: {}, dsh: null,
    dshProcess: { child, stop: () => assert.fail('must stop the current process') },
    fade: async () => { calls.push('fade') }, lessMotion: () => false,
    leave: () => ({ mark() {} }), laneLog() {},
    keepPageDrafts: () => { calls.push('drafts'); return drafts.promise },
    prepareRestart: (actual, options) => {
      assert.equal(actual, child)
      assert.equal(options.reason, 'quit')
      calls.push('prepare')
      return preparation.promise
    },
    app: { quit: () => { calls.push('quit') } },
  })
  vm.runInContext(`${source('async function prepareAndStop(', "// About's Force update")}
    ${source('function stopAndQuit()')}`, context)
  const work = context.stopAndQuit()
  await tick()
  assert.deepEqual(calls, ['fade', 'drafts'])
  drafts.resolve()
  await tick()
  assert.deepEqual(calls, ['fade', 'drafts', 'prepare'])
  context.dshProcess = { child, stop: () => { calls.push('stop'); return stopped.promise } }
  preparation.resolve({ ok: true })
  await tick()
  assert.deepEqual(calls, ['fade', 'drafts', 'prepare', 'stop'])
  stopped.resolve()
  await work
  assert.deepEqual(calls, ['fade', 'drafts', 'prepare', 'stop', 'quit'])
})
