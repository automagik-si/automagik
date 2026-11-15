import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The pill's module as the browser gets it, with stand-ins for the platform it runs on.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/desktop-update.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
// What the app last sent (the hook's state) and the app's bridge, for a drawing of the pill.
const shown = { state: null }
const opened = []
const omniDesktop = { updates: { status: async () => shown.state, subscribe: () => () => {}, open: async () => { opened.push('open') }, applyPlugins: async () => { opened.push('plugins') } } }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports,
  require: (name) => {
    const platform = {
      react: { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }), useState: initial => [shown.state ?? initial, () => {}], useEffect: () => {}, useRef: initial => ({ current: initial }), useLayoutEffect: () => {}, useMemo: fn => fn(), useCallback: fn => fn, useSyncExternalStore: () => undefined, Fragment: 'fragment', forwardRef: fn => fn, memo: fn => fn, createContext: () => ({}), useContext: () => undefined },
      'react-dom': { createPortal: node => node },
      '@deepseek-ai/dsh-client-ui-primitives': {},
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
  document: undefined, window: undefined, omniDesktop, Date, Math, JSON, Intl, setTimeout, clearTimeout,
})
const { DesktopUpdate, appState, updatePill } = module.exports

// Issue #859: the app's download shows its bytes, a failure says what failed, and the pill is a
// row of the sidebar (never something over the page) that only the ready one asks a click of.
const MB = 1024 * 1024

test('the download says how much of it is here, when the app counts the bytes', () => {
  const pill = updatePill({ phase: 'downloading', version: '3.96.0', percent: 42, transferred: 41.24 * MB, total: 98.36 * MB })
  assert.equal(pill.label, 'Updating · 42% · 41.2 of 98.4 MB')
  // A narrow sidebar cuts the one line: the whole of it is the title.
  assert.equal(pill.title, pill.label)
  assert.equal(pill.busy, true)
  assert.equal(updatePill({ phase: 'downloading', percent: 100, transferred: 99 * MB, total: 98 * MB }).label, 'Updating · 100% · 98.0 of 98.0 MB')
  assert.equal(updatePill({ phase: 'downloading', percent: 0, transferred: 0, total: 5 * MB }).label, 'Updating · 0% · 0.0 of 5.0 MB')
})

test('an app that does not count the bytes gets the label it had', () => {
  for (const state of [{ percent: 42 }, { percent: 42, transferred: 5 }, { percent: 42, transferred: 5, total: 0 }, { percent: 42, transferred: '5', total: '9' }, { percent: 42, transferred: -1, total: 9 }]) {
    const pill = updatePill({ phase: 'downloading', ...state })
    assert.equal(pill.label, 'Updating · 42%')
    assert.equal(pill.title, undefined)
  }
})

test('a failure says what failed, and an app that does not say keeps the check\'s words', () => {
  assert.equal(updatePill({ phase: 'error', failure: 'download', version: '3.96.0' }).label, 'Update download failed · Retry')
  assert.equal(updatePill({ phase: 'error', failure: 'verify', version: '3.96.0' }).label, 'Update could not be verified · Retry')
  assert.equal(updatePill({ phase: 'error', failure: 'check' }).label, 'Update check failed · Retry')
  assert.equal(updatePill({ phase: 'error' }).label, 'Update check failed · Retry')
  assert.equal(updatePill({ phase: 'error', failure: 'other' }).label, 'Update check failed · Retry')
  // A failure is not busy: its click tries again.
  assert.equal(updatePill({ phase: 'error', failure: 'download' }).busy, undefined)
})

// The app's row as the sidebar draws it for one presentation: the button's element.
function drawn(app) {
  shown.state = { ...app, app, plugins: { phase: 'idle', changes: [], auto: true } }
  try {
    const rows = DesktopUpdate()
    assert.equal(rows.type, 'div')
    assert.equal(rows.props.className, 'bt-desk-updates')
    const [row] = rows.children.filter(Boolean)
    return row.type(row.props)
  } finally {
    shown.state = null
  }
}
const barOf = button => button.children.filter(Boolean).find(child => child.props.className === 'bt-desk-update-bar')

test('each state is one quiet row; only ready and a failure take a click, and the click is the person\'s', () => {
  const lane = { phase: 'idle', changes: [], auto: true }
  const states = {
    downloading: { phase: 'downloading', version: '3.96.0', percent: 30, transferred: 30 * MB, total: 100 * MB },
    ready: { phase: 'ready', version: '3.96.0' },
    installing: { phase: 'installing', version: '3.96.0' },
    failed: { phase: 'error', failure: 'download', version: '3.96.0' },
  }
  const pills = Object.fromEntries(Object.entries(states).map(([name, app]) => [name, updatePill(appState({ ...app, app, plugins: lane }))]))
  assert.deepEqual(
    Object.fromEntries(Object.entries(pills).map(([name, pill]) => [name, { busy: pill.busy === true, primary: pill.primary === true }])),
    {
      downloading: { busy: true, primary: false },
      ready: { busy: false, primary: true },
      installing: { busy: true, primary: false },
      failed: { busy: false, primary: false },
    },
  )
  assert.equal(pills.ready.label, 'Restart to update to 3.96.0')
  assert.equal(pills.installing.label, 'Installing the update…')
})

test('the row draws the bar while it downloads, and nothing but the person\'s click restarts', () => {
  opened.length = 0
  const downloading = drawn({ phase: 'downloading', version: '3.96.0', percent: 30, transferred: 30 * MB, total: 100 * MB })
  assert.equal(downloading.type, 'button')
  assert.equal(downloading.props.className, 'bt-desk-update')
  assert.equal(downloading.props.title, 'Updating · 30% · 30.0 of 100.0 MB')
  assert.equal(barOf(downloading).children[0].props.style.width, '30%')
  // A download takes no click, and asks for none.
  assert.equal(downloading.props.disabled, true)

  const ready = drawn({ phase: 'ready', version: '3.96.0' })
  assert.equal(ready.props.disabled, false)
  assert.equal(ready.props.className, 'bt-desk-update bt-desk-update-go')
  assert.equal(barOf(ready), undefined)
  // Drawing any of it restarts nothing: only the click reaches the app.
  drawn({ phase: 'installing', version: '3.96.0' })
  const failed = drawn({ phase: 'error', failure: 'verify', version: '3.96.0' })
  assert.equal(failed.props.disabled, false)
  assert.deepEqual(opened, [])
  ready.props.onClick()
  assert.deepEqual(opened, ['open'])
  // No presentation, or an idle one, draws nothing at all.
  shown.state = { phase: 'idle', app: { phase: 'idle' }, plugins: { phase: 'idle', changes: [], auto: true } }
  assert.equal(DesktopUpdate(), null)
  shown.state = null
  assert.equal(DesktopUpdate(), null)
})

test('against an app that sends none of the new fields, every state reads and draws as it did', () => {
  // The presentations a desktop before #859 sends: no bytes, and a failure only of the check.
  const older = {
    checking: [{ phase: 'checking' }, 'Checking for updates…'],
    available: [{ phase: 'available', version: '3.96.0' }, 'Automagik 3.96.0 is out'],
    downloading: [{ phase: 'downloading', version: '3.96.0', percent: 42 }, 'Updating · 42%'],
    ready: [{ phase: 'ready', version: '3.96.0' }, 'Restart to update to 3.96.0'],
    installing: [{ phase: 'installing', version: '3.96.0' }, 'Installing the update…'],
    error: [{ phase: 'error', failure: 'check' }, 'Update check failed · Retry'],
  }
  for (const [name, [app, label]] of Object.entries(older)) {
    const pill = updatePill(app)
    assert.equal(pill.label, label, name)
    assert.equal(pill.title, undefined, name)
    const button = drawn(app)
    assert.equal(button.props.title, undefined, name)
    assert.equal(button.props.disabled, ['checking', 'downloading', 'installing'].includes(name), name)
    assert.equal(button.props.className, `bt-desk-update${['available', 'ready'].includes(name) ? ' bt-desk-update-go' : ''}`, name)
    assert.equal(barOf(button) !== undefined, name === 'downloading', name)
  }
  assert.equal(barOf(drawn(older.downloading[0])).children[0].props.style.width, '42%')
  // One that sends a single presentation for the app and the plugins (before the split).
  shown.state = { phase: 'downloading', version: '3.96.0', percent: 42 }
  const [row] = DesktopUpdate().children.filter(Boolean)
  assert.equal(row.type(row.props).children.filter(Boolean)[1].children[0], 'Updating · 42%')
  shown.state = null
})

// #1240: the pills are the second way into the same `open`/`applyPlugins` About's Check for
// updates holds. The rule is shared (update-hold.js), so the hold, the labels and the ordinary
// behaviour are read here through the pill as the sidebar draws it.
const CHANGES = [{ name: '@automagik/bots-dsh', from: '3.117.4', to: '3.117.5' }]
const pump = { phase: 'ready', changes: CHANGES, auto: true }
const plugLabel = 'Bot team 3.117.4 → 3.117.5 · updates when no agent is at work'
const downloadingPlug = 'Downloading Bot team 3.117.4 → 3.117.5 · 40%'

// The pills as the sidebar draws them, rendered to their buttons (the app's first, the plugins').
function drawnPills(state) {
  shown.state = state
  try {
    const tree = DesktopUpdate()
    assert.equal(tree?.type, 'div')
    return tree.children.filter(Boolean).map(row => row.type(row.props))
  } finally {
    shown.state = null
  }
}
const labelOf = button => button.children.filter(Boolean).find(child => child.props.className === 'bt-desk-update-label').children[0]

test('#1240: on an app from before the check, every pill is held while plugins are staged', () => {
  const staged = (app, plugins = pump) => ({ ...app, app, plugins })
  const appStates = [
    ['checking', staged({ phase: 'checking' }), ['Checking for updates…', plugLabel]],
    ['downloading', staged({ phase: 'downloading', version: '3.96.0', percent: 30 }), ['Updating · 30%', plugLabel]],
    ['installing', staged({ phase: 'installing', version: '3.96.0' }), ['Installing the update…']],
    // The Retry states: a failed check, download or verification.
    ['a failed check', staged({ phase: 'error', failure: 'check' }), ['Update check failed · Retry', plugLabel]],
    ['a failed download', staged({ phase: 'error', failure: 'download', version: '3.96.0' }), ['Update download failed · Retry', plugLabel]],
    ['a failed verify', staged({ phase: 'error', failure: 'verify', version: '3.96.0' }), ['Update could not be verified · Retry', plugLabel]],
    // Still coming: they are staged a moment later, perhaps before the click is heard.
    ['a failed check while plugins download', staged({ phase: 'error', failure: 'check' }, { phase: 'downloading', changes: CHANGES, percent: 40, auto: true }), ['Update check failed · Retry', downloadingPlug]],
    // Staged only as the whole says it, with no change named in the plugins' part.
    ['staged at the top only', { phase: 'ready', kind: 'plugins', app: { phase: 'error', failure: 'check' }, plugins: { phase: 'idle', changes: [], auto: true } }, ['Update check failed · Retry']],
  ]
  for (const [why, state, labels] of appStates) {
    opened.length = 0
    const buttons = drawnPills(state)
    assert.deepEqual(buttons.map(labelOf), labels, why)
    for (const button of buttons) {
      assert.equal(button.props.disabled, true, why)
      // The handler refuses by itself too: no click reaches the app, busy pill or not.
      button.props.onClick()
    }
    assert.deepEqual(opened, [], why)
  }
})

test('#1240: on an app from before the check, the plugins\' pill is held in each of its states', () => {
  const plugins = [
    ['downloading', { phase: 'downloading', changes: CHANGES, percent: 30, auto: true }, 'Downloading Bot team 3.117.4 → 3.117.5 · 30%'],
    ['ready, auto-apply on', { phase: 'ready', changes: CHANGES, auto: true }, plugLabel],
    ['ready, auto-apply off', { phase: 'ready', changes: CHANGES, auto: false }, 'Update Bot team 3.117.4 → 3.117.5 now'],
    ['installing', { phase: 'installing', changes: CHANGES, auto: true }, 'Updating Bot team 3.117.4 → 3.117.5…'],
  ]
  for (const [why, lane, label] of plugins) {
    opened.length = 0
    const [button] = drawnPills({ ...lane, app: { phase: 'idle' }, plugins: lane })
    assert.equal(labelOf(button), label, why)
    assert.equal(button.props.disabled, true, why)
    button.props.onClick()
    assert.deepEqual(opened, [], why)
  }
})

test('#1240: a modern app keeps every pill\'s ordinary behaviour', () => {
  // `check` is what makes an app modern (v3.120.0+): the hold never applies to it.
  omniDesktop.updates.check = async () => { opened.push('check') }
  try {
    // The plugins' own pill still applies them when asked, auto-apply off included.
    opened.length = 0
    let [button] = drawnPills({ app: { phase: 'idle' }, plugins: { phase: 'ready', changes: CHANGES, auto: false } })
    assert.equal(labelOf(button), 'Update Bot team 3.117.4 → 3.117.5 now')
    assert.equal(button.props.disabled, false)
    button.props.onClick()
    assert.deepEqual(opened, ['plugins'])
    // Restart, open and Retry still ask the app's `open`.
    for (const app of [{ phase: 'ready', version: '3.96.0' }, { phase: 'available', version: '3.96.0' }, { phase: 'error', failure: 'check' }]) {
      opened.length = 0
      ;[button] = drawnPills({ ...app, app, plugins: pump })
      assert.equal(button.props.disabled, false, app.phase)
      button.props.onClick()
      assert.deepEqual(opened, ['open'], app.phase)
    }
    // The plugins' pill beside a Retry is not held either.
    opened.length = 0
    const buttons = drawnPills({ phase: 'error', failure: 'check', app: { phase: 'error', failure: 'check' }, plugins: pump })
    assert.deepEqual(buttons.map(labelOf), ['Update check failed · Retry', plugLabel])
    for (const each of buttons) {
      each.props.onClick()
    }
    assert.deepEqual(opened, ['open', 'plugins'])
  } finally {
    delete omniDesktop.updates.check
  }
})

test('#1240: on an app from before the check, the labelled app pill stays live with plugins staged', () => {
  const staged = (app, plugins = pump) => ({ ...app, app, plugins })
  for (const [why, app, label, count] of [
    ['an update is out', { phase: 'available', version: '3.96.0' }, 'Automagik 3.96.0 is out', 2],
    ['an update is ready', { phase: 'ready', version: '3.96.0' }, 'Restart to update to 3.96.0', 1],
  ]) {
    opened.length = 0
    const buttons = drawnPills(staged(app))
    assert.equal(buttons.length, count, why)
    // The app's labelled pill is not the plugin path, and About keeps it live: its click restarts
    // into the app update or opens its release page, with staged plugins untouched.
    assert.equal(labelOf(buttons[0]), label, why)
    assert.equal(buttons[0].props.className, 'bt-desk-update bt-desk-update-go', why)
    assert.equal(buttons[0].props.disabled, false, why)
    buttons[0].props.onClick()
    assert.deepEqual(opened, ['open'], why)
    // The plugins' pill beside it (shown while the app update is out) is still held.
    if (count === 2) {
      assert.equal(labelOf(buttons[1]), plugLabel, why)
      assert.equal(buttons[1].props.disabled, true, why)
      buttons[1].props.onClick()
      assert.deepEqual(opened, ['open'], why)
    }
  }
})

test('#1240: with nothing staged, an old app\'s pills are not held, and no pill exists before it says', () => {
  const idle = { phase: 'idle', changes: [], auto: true }
  for (const [why, app] of [['a failed check', { phase: 'error', failure: 'check' }], ['a restart', { phase: 'ready', version: '3.96.0' }]]) {
    opened.length = 0
    const [button] = drawnPills({ ...app, app, plugins: idle })
    assert.equal(button.props.disabled, false, why)
    button.props.onClick()
    assert.deepEqual(opened, ['open'], why)
  }
  // Before the app has said anything there is no pill at all, so nothing can ask it to update.
  shown.state = null
  assert.equal(DesktopUpdate(), null)
})
