import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { setImmediate as immediate } from 'node:timers/promises'
import { runInContext } from 'node:vm'
import { build } from 'esbuild'
import { armUpdateReopen, endUpdateReopen, rememberOpen, takeReopen } from '../src/client/reopen.js'
import { createSource } from '../src/client/sources.js'

const requireHarness = createRequire(join(process.env.DSH_HARNESS, 'package.json'))
const { JSDOM } = requireHarness('jsdom')
const { outputFiles } = await build({
  stdin: {
    contents: `
      export * from './src/client/self-update.js'
      export { AboutPage, SelfUpdateRecoveryDetail } from './src/client/about.js'
      export { updatePopoverPlacement } from './src/client/sidebar.js'
    `,
    resolveDir: new URL('..', import.meta.url).pathname,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const tick = () => immediate()
const base = { available: true, problem: null, supervisor: { version: '1.0.0' }, startEnabled: true, startRefusal: null, rollback: true, run: null }
const offer = (checkedAt = Date.now()) => ({
  ...base, check: {
    checkedAt: new Date(checkedAt).toISOString(), laneVersion: '3.162.0', sequence: 162, state: 'available', newer: true,
    fresh: Date.now() >= checkedAt && Date.now() - checkedAt < 600_000,
    plugins: [
      { name: '@automagik/bots-dsh', from: '3.161.0', to: '3.162.0' },
      { name: '@automagik/welcome-dsh', from: '3.162.0', to: '3.162.0' },
    ],
  },
})
const live = (phase, rest = {}) => ({
  ...base, startRefusal: 'update-running',
  run: { runId: 'new-run-id', requestId: 'new-request', from: '3.161.0', to: '3.162.0', phase, reason: null,
    startedAt: new Date(Date.now() - 1000).toISOString(), updatedAt: new Date().toISOString(), ...rest },
})
const btn = (document, text) => [...document.querySelectorAll('button')].find(button => button.textContent === text)
const assertOneClose = modal => {
  const closes = [...modal.querySelectorAll('button')].filter(button => button.textContent === 'Close')
  assert.deepEqual(closes, [modal.querySelector('.su-head .su-close')])
}

function page(t, initial, { url = 'https://automagik.test/', desktop, startUpdate, storage, clock = false, hidden = false } = {}) {
  const dom = new JSDOM('<!doctype html><div class="lb-foot"><button>Account</button></div>', {
    url, runScripts: 'outside-only', pretendToBeVisual: true,
  })
  const { window } = dom
  const { document } = window
  let visibility = hidden ? 'hidden' : 'visible'
  Object.defineProperty(document, 'visibilityState', { get: () => visibility })
  const module = { exports: {} }
  const react = { Component: class {}, createContext: value => ({ value }), createElement() {} }
  Object.assign(window, { module, exports: module.exports, require: name => name === 'react' ? react : {} })
  if (clock) Object.assign(window, { Date, setTimeout, clearTimeout })
  runInContext(outputFiles[0].text, dom.getInternalVMContext())
  const { AboutPage, installSelfUpdate, SelfUpdateRecoveryDetail, updatePopoverPlacement } = module.exports
  let status = initial
  let connection = 'connected'
  const subscribers = new Set()
  const chat = []
  const source = createSource(null)
  const readStatus = t.mock.fn(async () => {
    if (status instanceof Error) throw status
    return typeof status === 'function' ? status() : status
  })
  const start = t.mock.fn(startUpdate ?? (async () => ({ started: true, requestId: 'new-request' })))
  const controls = new Set()
  const mount = () => {
    const control = installSelfUpdate({
      document, desktop, readStatus, startUpdate: start,
      onStatus: source.set,
      connection: {
        getSnapshot: () => connection,
        subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn) },
      },
      storage: storage ?? dom.window.localStorage,
      keepChat: (...args) => chat.push(args),
    })
    if (control) controls.add(control)
    return control
  }
  let control = mount()
  t.after(() => { for (const entry of controls) entry.dispose(); dom.window.close() })
  return {
    document, window, start, readStatus, chat, subscribers, updatePopoverPlacement,
    modal: () => document.querySelector('.su-modal'),
    nod: () => document.querySelector('.su-nod'),
    step: () => document.querySelector('.su-step[aria-current=step]')?.dataset.step,
    setStatus(next) { status = next },
    refresh() { return control?.refresh() },
    async set(next) { status = next; await control?.refresh({ force: true }) },
    setVisibility(next) { visibility = next; document.dispatchEvent(new window.Event('visibilitychange')) },
    async connect(next) { connection = next; for (const fn of subscribers) fn(); await tick() },
    async remount() { control?.dispose(); controls.delete(control); control = mount(); await tick() },
    dispose() { control.dispose(); controls.delete(control); control = null },
    escape() { document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) },
    openSettingsRecovery() {
      Object.assign(react, {
        useState: initial => [initial, () => {}],
        useEffect() {},
        useRef: current => ({ current }),
        useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
        createElement: (type, props, ...children) => ({ type, props, children }),
      })
      const about = AboutPage({
        useUpdate: () => ({ hostAnswered: true }), actions: { selfUpdateStatusSource: source }, Section: 'section', Row: 'row',
      })
      const updates = about.find(node => node?.props?.key === 'updates')
      const detail = updates.children.find(node => node?.type === SelfUpdateRecoveryDetail)
      assert.ok(detail, 'web About mounts the separate recovery detail')
      react.createElement = (...args) => args.slice(2).flat(Infinity).filter(Boolean).join(' ')
      return () => detail.type(detail.props)
    },
  }
}

test('the offer names the verified changes, starts once and follows observed phases and recovery', async t => {
  const p = page(t, offer())
  await tick()
  p.nod().click()
  assert.match(p.modal().textContent, /3\.162\.0 is ready/)
  assert.match(p.modal().textContent, /3\.161\.0 → 3\.162\.0/)
  assert.match(p.modal().textContent, /already on 3\.162\.0/)
  assert.doesNotMatch(p.modal().textContent, /You have/)
  assert.match(p.modal().textContent, /Work in progress stops/)
  btn(p.document, 'Not now').click()
  assert.equal(p.start.mock.callCount(), 0)
  p.nod().click()
  const start = btn(p.document, 'Update now')
  start.click()
  start.click()
  await tick()
  assert.equal(p.start.mock.callCount(), 1)
  assert.equal(p.start.mock.calls[0].arguments.length, 0)
  assert.equal(p.step(), undefined)

  await p.set(live('healthy', { runId: 'old-run-id', requestId: 'old-request' }))
  assert.match(p.modal().textContent, /Waiting for/)
  for (const [phase, step] of [
    ['checking', 'checking'], ['downloading', 'downloading'], ['verifying', 'verifying'],
    ['switching', 'staging'], ['restarting', 'restarting'], ['health', 'restarting'],
  ]) {
    await p.set(live(phase))
    assert.equal(p.step(), step)
  }
  const healthy = { ...live('healthy'), current: { live: { version: '3.162.0' } }, check: { ...offer().check, newer: false } }
  await p.set(healthy)
  assert.match(p.modal().textContent, /Updated to Automagik 3\.162\.0/)
  assertOneClose(p.modal())
  assert.match(p.modal().textContent, /results are not available yet/)
  await p.set({
    ...healthy, recovery: {
      runId: 'new-run-id', requestId: 'new-request', complete: false,
      items: [
        { kind: 'turn', sessionId: 'bot-a', name: 'Ada', state: 'resumed' },
        { kind: 'input', sessionId: 'bot-b', name: 'Tess', state: 'failed' },
        { kind: 'delivery', sessionId: 'bot-c', name: 'Kai', state: 'pending' },
      ],
    },
  })
  assert.match(p.modal().textContent, /Ada \(Turn\) · Resumed/)
  assert.match(p.modal().textContent, /Tess \(Queued input\) · Could not resume/)
  assert.match(p.modal().textContent, /Kai \(Queued delivery\) · Pending/)
  p.escape()
  await p.remount()
  assert.equal(p.modal(), null)
  assert.equal(p.nod(), null)
  assert.deepEqual(p.chat, [[true], [false, false]])
})

test('closing progress keeps it closed until a real rollback verdict', async t => {
  const details = {
    failed: 'page', trialFrom: '2026-11-20T12:00:00.000Z', trialTo: '2026-11-20T12:00:05.000Z',
    data: { restored: true, trialKept: true },
  }
  const p = page(t, live('health'))
  await tick()
  p.escape()
  await p.set(live('rollingBack', { rollback: details }))
  assert.equal(p.modal(), null)
  assert.equal(p.nod().title, 'Updating Automagik')
  p.nod().click()
  assert.match(p.modal().textContent, /going back to the previous version/)
  assert.match(p.modal().textContent, /web page or its scripts did not load/)
  await p.set(live('rolledBack', { rollback: details }))
  assert.match(p.modal().textContent, /previous plugin set passed/)
  assertOneClose(p.modal())
  assert.match(p.modal().textContent, /snapshot was restored/)
  assert.match(p.modal().textContent, /A copy of the trial team data was kept/)
  assert.match(p.modal().textContent, /team change between .* may have been replaced/)
  assert.equal(btn(p.document, 'See the announcement again'), undefined)
  await p.set(live('rolledBack', { rollback: { ...details, data: { restored: true, trialKept: false } } }))
  assert.match(p.modal().textContent, /No copy of the trial team data was kept/)
  await p.set(live('rolledBack', { rollback: { ...details, data: { restored: true } } }))
  assert.match(p.modal().textContent, /did not record whether a copy of the trial team data was kept/)
  await p.set(live('rolledBack', { rollback: { ...details, data: { restored: false, why: 'same-format' } } }))
  assert.match(p.modal().textContent, /snapshot was skipped.*previous version can read the team data format/)
  await p.set(live('rolledBack', { rollback: { ...details, data: null } }))
  assert.match(p.modal().textContent, /no team snapshot outcome/)
  await p.set({ ...offer(), run: live('rolledBack', { rollback: details }).run })
  btn(p.document, 'See the announcement again').click()
  assert.match(p.modal().textContent, /What changes/)
  assert.equal(p.start.mock.callCount(), 0)
})

test('a terminal first read distinguishes ordinary refusal, the one-time upgrade and manual recovery', async t => {
  const p = page(t, live('notUpdated', { reason: 'stage-failed' }))
  await tick()
  assert.match(p.modal().textContent, /was not updated.*could not be installed beside/)
  assertOneClose(p.modal())
  await p.set(live('notUpdated', { runId: 'unsupported', reason: 'profile-invalid', detail: 'previous-unsupported' }))
  assert.match(p.modal().textContent, /update it once by hand/)
  await p.set(live('manualRecovery', {
    runId: 'manual-run', reason: 'rollback-failed',
    rollback: {
      failed: 'plugins', previousFailed: 'port', step: 'health', tried: ['rename-back', 'restart', 'health'],
      location: { modules: { previous: 'live', candidate: 'staging' }, lockfile: { previous: 'kept', candidate: 'missing' } },
    },
  }))
  assert.match(p.modal().textContent, /Manual recovery required/)
  assertOneClose(p.modal())
  assert.match(p.modal().textContent, /local web listener did not answer/)
  assert.match(p.modal().textContent, /Last rollback step: Check health/)
  assert.match(p.modal().textContent, /pnpm-lock.yaml: previous — Kept version; candidate — Missing/)
  assert.match(p.modal().querySelector('a').href, /docs\/upgrade.md#in-app-updates/)
  await p.set(live('manualRecovery', { runId: 'manual-without-rollback', reason: 'health-failed' }))
  assert.match(p.modal().textContent, /Manual recovery required/)
  assert.match(p.modal().textContent, /The supervisor could not confirm a healthy running instance\./)
  assert.doesNotMatch(p.modal().textContent, /the new version did not answer/)
  assert.doesNotMatch(p.modal().textContent, /Rollback actions tried/)
})

test('notUpdated with an all-equal signed release does not claim a downgrade', async t => {
  const p = page(t, live('notUpdated', { from: '3.162.0', to: '3.162.0', reason: 'not-newer' }))
  await tick()
  assert.match(p.modal().textContent, /The signed release did not offer a newer compatible plugin set\./)
  assert.doesNotMatch(p.modal().textContent, /downgrade/)
})

test('unreadable recovery notes are unconfirmed in the verdict and Settings', async t => {
  const status = live('healthy')
  const recovery = { runId: status.run.runId, requestId: status.run.requestId, complete: true, items: [] }
  const p = page(t, { ...status, recovery })
  await tick()
  const detail = p.openSettingsRecovery()
  assert.match(p.modal().textContent, /There was no stopped work to recover\./)
  assert.match(detail(), /There was no stopped work to recover\./)
  await p.set({ ...status, recovery: { ...recovery, inventoryUnconfirmed: true } })
  for (const text of [p.modal().textContent, detail()]) {
    assert.match(text, /Work recovery is unconfirmed because the saved notes could not be read\./)
    assert.doesNotMatch(text, /There was no stopped work to recover/)
  }
})

test('a lost reply requires status and is never replayed, including after reconnect', async t => {
  const request = Promise.withResolvers()
  const p = page(t, offer(), { startUpdate: () => request.promise })
  await tick()
  p.nod().click()
  btn(p.document, 'Update now').click()
  await tick()
  const before = p.readStatus.mock.callCount()
  request.reject(new Error('lost reply'))
  await tick()
  assert.ok(p.readStatus.mock.callCount() > before)
  assert.equal(p.nod(), null)
  assert.match(p.modal().textContent, /Waiting for/)
  await p.connect('disconnected')
  assert.match(p.modal().textContent, /status is unconfirmed/)
  await p.set(live('health'))
  assert.equal(p.step(), undefined)
  await p.connect('connected')
  assert.equal(p.step(), 'restarting')
  await p.connect('disconnected')
  assert.equal(p.step(), 'restarting')
  assert.doesNotMatch(p.modal().textContent, /Manual recovery required/)
  await p.set(live('healthy'))
  await p.connect('connected')
  assert.match(p.modal().textContent, /Updated to Automagik/)
  assert.equal(p.start.mock.callCount(), 1)
  assert.deepEqual(p.chat, [[true], [false, true]])
})

for (const [phase, step, verdict, message] of [
  ['staging', 'staging', 'healthy', /Updated to Automagik 3\.162\.0/],
  ['verifying', 'verifying', 'rolledBack', /Back to the previous version/],
]) {
  test(`connection loss during ${phase} shows unconfirmed restart until ${verdict}`, async t => {
    const p = page(t, live(phase))
    await tick()
    assert.equal(p.step(), step)
    const reads = p.readStatus.mock.callCount()
    await p.connect('disconnected')
    await p.set(live(verdict))
    assert.equal(p.readStatus.mock.callCount(), reads)
    assert.equal(p.step(), 'restarting')
    const rows = [...p.modal().querySelectorAll('.su-step')]
    assert.deepEqual(rows.map(row => row.dataset.state), ['done', 'done', 'done', 'done', 'active'])
    assert.deepEqual(rows.map(row => row.querySelector('.su-mark').textContent), ['✓', '✓', '✓', '✓', '•'])
    assert.match(rows[4].textContent, /Restarting and checking health/)
    assert.match(p.modal().textContent, /The update status is unconfirmed\./)
    assert.equal(p.modal().querySelector('.su-result'), null)

    await p.connect('connected')
    assert.match(p.modal().textContent, message)
    assert.doesNotMatch(p.modal().textContent, /The update status is unconfirmed\./)
    assert.equal(p.step(), undefined)
  })
}

test('a network failure can show unconfirmed restart and the next live phase replaces it', async t => {
  const p = page(t, live('checking'))
  await tick()
  await p.set(Object.assign(new Error('connection lost'), { code: 'NETWORK' }))
  assert.equal(p.step(), 'restarting')
  assert.match(p.modal().textContent, /The update status is unconfirmed\./)
  await p.set(live('downloading'))
  assert.equal(p.step(), 'downloading')
  assert.doesNotMatch(p.modal().textContent, /The update status is unconfirmed\./)
  await p.set(live('rollingBack'))
  assert.match(p.modal().textContent, /going back to the previous version/)
  assert.equal(p.step(), undefined)
})

test('connection loss without an active run leaves the idle window alone', async t => {
  const p = page(t, base)
  await tick()
  await p.connect('disconnected')
  assert.equal(p.modal(), null)
  assert.equal(p.nod(), null)
})

test('the switching modal survives the reconnecting shell and a Bots remount with one layer', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  const p = page(t, live('switching'), { clock: true })
  await tick()
  const { document } = p
  const layer = document.querySelector('.su-layer')
  const assertLayer = () => {
    assert.deepEqual([...document.querySelectorAll('.su-layer')], [layer])
    assert.equal(layer.parentNode, document.body)
    assert.equal(p.window.getComputedStyle(layer).display, 'flex')
  }
  const assertRestarting = () => {
    assertLayer()
    assert.equal(p.step(), 'restarting')
    assert.match(p.modal().textContent, /Restarting and checking health/)
    assert.match(p.modal().textContent, /The update status is unconfirmed\./)
    assert.equal(p.modal().querySelector('.su-result'), null)
  }

  assertLayer()
  assert.equal(p.step(), 'staging')
  await p.connect('connecting')
  assertRestarting()
  p.setStatus(() => new Promise(() => {}))
  p.dispose()
  assertRestarting()
  const shell = document.createElement('main')
  shell.textContent = 'Reconnecting.'
  document.body.replaceChildren(shell)
  await tick()
  assertRestarting()
  const reads = p.readStatus.mock.callCount()
  t.mock.timers.tick(1500)
  assert.equal(p.readStatus.mock.callCount(), reads + 1)
  t.mock.timers.tick(10_000)
  await tick()
  assertRestarting()

  await p.remount()
  assertRestarting()
  p.setStatus(live('healthy'))
  await p.connect('connected')
  assertLayer()
  assert.match(p.modal().textContent, /Updated to Automagik 3\.162\.0/)
  assert.doesNotMatch(p.modal().textContent, /status is unconfirmed/)
  assertOneClose(p.modal())
  p.modal().querySelector('.su-close').click()
  assert.equal(document.querySelector('.su-layer'), null)
})

test('an open update can reach its real verdict before the Bots interface is mounted again', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  const p = page(t, live('staging'), { clock: true })
  await tick()
  const modal = p.modal()
  p.dispose()
  assert.equal(p.step(), 'staging')
  assert.match(modal.textContent, /status is unconfirmed/)
  p.setStatus(live('healthy'))
  t.mock.timers.tick(1500)
  await tick()
  assert.equal(p.modal(), modal)
  assert.match(modal.textContent, /Updated to Automagik/)
  await p.remount()
  assert.deepEqual([...p.document.querySelectorAll('.su-modal')], [modal])
  assert.deepEqual(p.chat, [[true], [false, true]])
})

test('an unanswered start expires on the status cadence and reconciles a real not-updated verdict', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  const p = page(t, offer(), { clock: true, startUpdate: () => new Promise(() => {}) })
  await tick()
  p.nod().click()
  btn(p.document, 'Update now').click()
  await tick()
  const verdict = live('notUpdated', { reason: 'stage-failed' })
  await p.set(verdict)
  assert.match(p.modal().textContent, /Waiting for/)
  t.mock.timers.tick(75_000)
  await p.set(verdict)
  assert.match(p.modal().textContent, /Automagik was not updated/)
  assert.equal(p.start.mock.callCount(), 1)
  assert.deepEqual(p.chat, [[true], [false, false]])
})

test('a late start reply cannot overwrite an already reconciled verdict', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  const reply = Promise.withResolvers()
  const p = page(t, offer(), { clock: true, startUpdate: () => reply.promise })
  await tick()
  p.nod().click()
  btn(p.document, 'Update now').click()
  await tick()
  t.mock.timers.tick(75_000)
  await p.set(live('notUpdated', { reason: 'stage-failed' }))
  const reads = p.readStatus.mock.callCount()
  reply.resolve({ started: false, reason: 'request-unanswered' })
  await tick()
  assert.match(p.modal().textContent, /Automagik was not updated/)
  assert.equal(p.readStatus.mock.callCount(), reads)
})

test('Settings shows a matching recovery failure after the owner closes the verdict', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const status = live('healthy')
  const recovery = {
    runId: status.run.runId, requestId: status.run.requestId, complete: false,
    items: [{ kind: 'turn', sessionId: 'task-1', name: 'Build the chart', state: 'pending' }],
    omitted: { pending: 2, resumed: 0, failed: 0, unconfirmed: 0 },
  }
  const p = page(t, { ...status, recovery }, { clock: true })
  await tick()
  assert.match(p.modal().textContent, /More work items.*2 pending/)
  p.escape()
  const draws = p.openSettingsRecovery()
  assert.match(draws(), /Build the chart \(Turn\) · Pending/)
  await p.set({ ...status, recovery: { ...recovery, requestId: 'another-request' } })
  assert.match(draws(), /results are not available yet/)
  const failed = { ...recovery, complete: true, items: [{ ...recovery.items[0], state: 'failed' }],
    omitted: { pending: 0, resumed: 1, failed: 1, unconfirmed: 0 } }
  await p.set({ ...status, recovery: failed })
  assert.match(draws(), /Build the chart \(Turn\) · Could not resume/)
  assert.match(draws(), /More work items.*1 resumed, 1 could not resume/)
  assert.equal(p.modal(), null)
  const reopened = p.openSettingsRecovery()
  assert.match(reopened(), /Build the chart \(Turn\) · Could not resume/)
  const reads = p.readStatus.mock.callCount()
  t.mock.timers.tick(10_000)
  await tick()
  assert.equal(p.readStatus.mock.callCount(), reads)
  await p.set(Object.assign(new Error('read-only'), { code: 'bot/read-only' }))
  assert.equal(reopened(), null)
})

test('an older supervisor has no automatic-rollback promise and its start refusal is honored', async t => {
  const older = { ...offer(), rollback: undefined }
  const p = page(t, older)
  await tick()
  p.nod().click()
  assert.match(p.modal().textContent, /Your previous version stays kept\./)
  assert.doesNotMatch(p.modal().textContent, /goes back by itself/)
  p.setStatus({ ...older, startRefusal: 'rollback-missing' })
  btn(p.document, 'Update now').click()
  await tick()
  assert.equal(p.start.mock.callCount(), 0)
  assert.equal(p.nod(), null)
  assert.equal(p.modal(), null)
  await p.set(offer())
  p.nod().click()
  assert.match(p.modal().textContent, /goes back by itself/)
})

test('a hidden owner tab cannot acknowledge another tab’s verdict and rechecks on visibility change', async t => {
  const values = new Map()
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }
  const hidden = page(t, live('healthy'), { storage, hidden: true })
  await tick()
  assert.equal(hidden.modal(), null)
  assert.equal(values.size, 0)
  const foreground = page(t, live('healthy'), { storage })
  await tick()
  assert.match(foreground.modal().textContent, /Updated to Automagik/)
  assert.equal(values.size, 1)
  hidden.setVisibility('visible')
  await tick()
  assert.equal(hidden.modal(), null)

  hidden.setVisibility('hidden')
  await hidden.set(live('rolledBack', { runId: 'second-run', requestId: 'second-request' }))
  assert.equal(hidden.modal(), null)
  assert.equal(values.size, 1)
  hidden.setVisibility('visible')
  assert.equal(hidden.modal(), null)
  await tick()
  assert.match(hidden.modal().textContent, /Back to the previous version/)
  assert.equal(values.size, 2)
})

test('a tab returning to visibility revalidates ownership and the setting before acknowledging a verdict', async t => {
  for (const refusal of [Object.assign(new Error('read-only'), { code: 'bot/read-only' }),
    { ...live('healthy'), startEnabled: false }]) {
    const values = new Map()
    const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }
    const p = page(t, live('healthy'), { storage, hidden: true })
    await tick()
    p.setStatus(refusal)
    p.setVisibility('visible')
    assert.equal(p.modal(), null)
    assert.equal(values.size, 0)
    await tick()
    assert.equal(p.readStatus.mock.callCount(), 2)
    assert.equal(p.modal(), null)
    assert.equal(values.size, 0)
  }
})

test('an unanswered ordinary status read expires and a later poll shows the verdict without reconnecting', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  const p = page(t, live('switching'), { clock: true })
  await tick()
  const old = Promise.withResolvers()
  p.setStatus(() => old.promise)
  const waiting = p.refresh()
  t.mock.timers.tick(10_000)
  await waiting
  assert.equal(p.step(), 'staging')
  assert.match(p.modal().textContent, /The update status is unconfirmed\./)
  p.setStatus(live('healthy'))
  await p.refresh()
  assert.match(p.modal().textContent, /Updated to Automagik/)
  old.resolve(live('verifying'))
  await tick()
  assert.match(p.modal().textContent, /Updated to Automagik/)
})

test('an unanswered confirmation releases the button after a successful poll', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  const p = page(t, offer(), { clock: true })
  await tick()
  p.nod().click()
  p.setStatus(() => new Promise(() => {}))
  btn(p.document, 'Update now').click()
  assert.equal(btn(p.document, 'Update now').disabled, true)
  t.mock.timers.tick(10_000)
  await tick()
  p.setStatus(offer())
  await p.refresh()
  assert.equal(btn(p.document, 'Update now').disabled, false)
  assert.equal(p.start.mock.callCount(), 0)
})

test('opening and confirming use the browser clock, even when host freshness is still true', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  const first = page(t, offer(Date.now() - 599_999), { clock: true })
  await tick()
  assert.ok(first.nod())
  t.mock.timers.tick(1)
  first.nod().click()
  assert.equal(first.modal(), null)
  assert.equal(first.nod(), null)

  const nearExpiry = offer(Date.now() - 599_999)
  const second = page(t, nearExpiry, { clock: true })
  await tick()
  second.nod().click()
  const validation = Promise.withResolvers()
  second.setStatus(() => validation.promise)
  const update = btn(second.document, 'Update now')
  update.click()
  update.click()
  assert.equal(second.readStatus.mock.callCount(), 2)
  assert.equal(btn(second.document, 'Update now').disabled, true)
  t.mock.timers.tick(1)
  validation.resolve(nearExpiry)
  await tick()
  assert.equal(second.start.mock.callCount(), 0)
  assert.equal(second.nod(), null)
})

test('confirmation rereads the same verified candidate before sending one bodyless start', async t => {
  const status = offer()
  const p = page(t, status)
  await tick()
  p.nod().click()
  const changed = { ...status, check: { ...status.check, sequence: 163, laneVersion: '3.163.0' } }
  p.setStatus(changed)
  btn(p.document, 'Update now').click()
  await tick()
  assert.equal(p.start.mock.callCount(), 0)
  assert.match(p.modal().textContent, /3\.163\.0 is ready/)
  const validation = Promise.withResolvers()
  p.setStatus(() => validation.promise)
  btn(p.document, 'Update now').click()
  p.escape()
  validation.resolve(changed)
  await tick()
  assert.equal(p.start.mock.callCount(), 0)
  assert.equal(p.modal(), null)
  p.setStatus(changed)
  p.nod().click()
  btn(p.document, 'Update now').click()
  await tick()
  assert.equal(p.start.mock.callCount(), 1)
  assert.equal(p.start.mock.calls[0].arguments.length, 0)
})

test('a change to advertised rollback support requires a second confirmation', async t => {
  const status = offer()
  const p = page(t, status)
  await tick()
  p.nod().click()
  assert.match(p.modal().textContent, /goes back by itself/)
  p.setStatus({ ...status, rollback: undefined })
  btn(p.document, 'Update now').click()
  await tick()
  assert.equal(p.start.mock.callCount(), 0)
  assert.match(p.modal().textContent, /Your previous version stays kept\./)
  assert.doesNotMatch(p.modal().textContent, /goes back by itself/)
  btn(p.document, 'Update now').click()
  await tick()
  assert.equal(p.start.mock.callCount(), 1)
  assert.equal(p.start.mock.calls[0].arguments.length, 0)
})

test('the browser clock fires a control timer without advancing progress, and reconnect ignores an old read', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  const p = page(t, live('downloading'), { clock: true })
  await tick()
  assert.equal(p.step(), 'downloading')
  const before = p.window.Date.now()
  let firedAt
  p.window.setTimeout(() => { firedAt = p.window.Date.now() }, 60_000)
  t.mock.timers.tick(60_000)
  assert.equal(firedAt, before + 60_000)
  assert.equal(p.step(), 'downloading')
  assert.equal(p.readStatus.mock.callCount(), 1)
  const old = Promise.withResolvers()
  const late = p.set(() => old.promise)
  await p.connect('disconnected')
  await p.set(live('health'))
  await p.connect('connected')
  old.resolve(live('checking'))
  await late
  assert.equal(p.step(), 'restarting')
})

test('only a fresh eligible saved check offers the update', async t => {
  const p = page(t, base)
  await tick()
  for (const status of [
    base, { ...offer(), startEnabled: undefined }, { ...offer(), supervisor: null },
    { ...offer(), available: false, reason: 'desktop-app' }, { ...offer(), startRefusal: 'check-stale' },
    { ...offer(), staleRun: live('healthy').run, check: null },
    { ...offer(), check: { ...offer().check, state: 'interrupted' } },
    offer(Date.now() + 60_000), offer(Date.now() - 10 * 60_000),
    { ...offer(), current: { live: { version: '3.162.0' } }, check: { ...offer().check, newer: false } },
    { ...live('healthy'), supervisor: null }, { ...live('health'), startEnabled: false },
    Object.assign(new Error('read-only'), { code: 'bot/read-only' }),
  ]) {
    await p.set(status)
    assert.equal(p.nod(), null)
    assert.equal(p.modal(), null)
  }
  const desktop = page(t, offer(), { desktop: true })
  await tick()
  assert.equal(desktop.readStatus.mock.callCount(), 0)
  assert.equal(desktop.nod(), null)
})

test('the classic Agent footer nod gets the round button and both palette fallbacks', async t => {
  const p = page(t, offer())
  p.document.querySelector('.lb-foot').outerHTML = '<div class="native_footArea"><div class="native_footerActions"><div></div></div></div>'
  await tick()
  const nod = p.nod()
  assert.ok(nod?.closest('.native_footerActions'))
  const light = p.window.getComputedStyle(nod)
  assert.equal(light.width, '36px')
  assert.equal(light.borderRadius, '50%')
  assert.ok(light.getPropertyValue('--bt-accent'))
  const lightBackground = light.getPropertyValue('--bt-main')
  p.document.body.dataset.dsDarkTheme = ''
  const dark = p.window.getComputedStyle(nod)
  assert.ok(dark.getPropertyValue('--bt-accent'))
  assert.notEqual(dark.getPropertyValue('--bt-main'), lightBackground)
})

test('the old query and fragment are ordinary URLs; a replaced footer keeps its siblings and one nod', async t => {
  for (const suffix of ['', '?mock-1540', '#mock-1540']) {
    const p = page(t, base, { url: 'https://automagik.test/' + suffix })
    await tick()
    assert.equal(p.nod(), null)
    assert.equal(p.modal(), null)
    await p.set(offer())
    const footer = p.document.createElement('div')
    footer.className = 'lb-foot'
    footer.innerHTML = '<button>Account</button><button>Toggle</button>'
    p.document.querySelector('.lb-foot').replaceWith(footer)
    await tick()
    assert.equal(footer.querySelectorAll('button').length, 3)
    p.nod().focus()
    p.nod().click()
    assert.equal(p.document.activeElement.textContent, 'Close')
    p.escape()
    assert.equal(p.document.activeElement, p.nod())
    p.dispose()
    assert.equal(footer.querySelectorAll('button').length, 2)
    assert.equal(p.subscribers.size, 0)
  }
})

test('an armed web update keeps the chat through reload and same-tab reconnection', () => {
  const dom = new JSDOM('', { url: 'https://automagik.test' })
  const store = dom.window.sessionStorage
  rememberOpen('first', store)
  assert.equal(takeReopen(store), null)
  armUpdateReopen('updating', store)
  rememberOpen('fallback', store)
  assert.equal(takeReopen(store), 'updating')
  assert.equal(takeReopen(store), null)
  armUpdateReopen('reconnecting', store)
  assert.equal(endUpdateReopen(true, store), 'reconnecting')
  armUpdateReopen('refused', store)
  assert.equal(endUpdateReopen(false, store), null)
  assert.equal(takeReopen(store), null)
  dom.window.close()
})

test('the cloud popover stays in view from the footer, rail and a short visual viewport', t => {
  const { updatePopoverPlacement } = page(t, base, { desktop: true })
  const viewport = { width: 500, height: 600, top: 0, bottom: 600 }
  const footer = updatePopoverPlacement({ left: 400, top: 546, bottom: 582 }, viewport)
  assert.deepEqual({ ...footer }, { left: 212, bottom: 60, maxHeight: 532, maxWidth: 484 })
  const rail = updatePopoverPlacement({ left: 0, top: 20, bottom: 56 }, viewport)
  assert.deepEqual({ ...rail }, { left: 8, top: 62, maxHeight: 530, maxWidth: 484 })
  const drawer = updatePopoverPlacement({ left: 100, top: 221, bottom: 257 }, {
    width: 236, height: 560, left: 15, top: 120, bottom: 260,
  })
  assert.deepEqual({ ...drawer }, { left: 23, bottom: 345, maxHeight: 87, maxWidth: 220 })
})
