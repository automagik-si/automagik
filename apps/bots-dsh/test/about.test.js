import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// Settings → About (#90), as the browser gets it, with stand-ins for the platform. The page's
// state hooks are answered in the order it asks: the app's update presentation, the app's
// versions, then its own (checking, stars, cheer).
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/about.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
let states = []
let asked = 0
const sandbox = {
  module: { exports: {} },
  require: (name) => {
    const platform = {
      react: {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: (initial) => { const index = asked++; return [index in states ? states[index] : initial, () => {}] },
        useEffect: () => {}, useRef: initial => ({ current: initial }), useLayoutEffect: () => {}, useMemo: fn => fn(), useCallback: fn => fn,
        useSyncExternalStore: () => undefined, Fragment: 'fragment', forwardRef: fn => fn, memo: fn => fn, createContext: () => ({}), useContext: () => undefined,
      },
      'react-dom': { createPortal: node => node },
      '@deepseek-ai/dsh-client-ui-primitives': {},
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
  document: undefined, window: undefined, Date, Math, JSON, Intl, setTimeout, clearTimeout, URL,
}
sandbox.exports = sandbox.module.exports
sandbox.globalThis = sandbox
runInNewContext(bundle.outputFiles[0].text, sandbox)
const { AboutPage } = sandbox.module.exports

const Section = 'section'
const Row = 'row'
const walk = (node, visit) => {
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return }
  if (!node || typeof node !== 'object') return
  visit(node)
  walk(node.children, visit)
}
const textOf = (node) => {
  const parts = []
  const read = (value) => {
    if (Array.isArray(value)) return value.forEach(read)
    if (typeof value === 'string' || typeof value === 'number') return void parts.push(String(value))
    if (value && typeof value === 'object') read(value.children)
  }
  read(node)
  return parts.join('')
}

// The page as drawn: its hero, its sections' titles and each row as [label, hint, buttons].
function draw({ update = {}, bridge, state = null, versions = null }) {
  if (bridge) sandbox.omniDesktop = { updates: bridge }
  else delete sandbox.omniDesktop
  states = [state, versions]
  asked = 0
  const calls = []
  const actions = { repoStars: () => Promise.resolve(null), checkUpdate: () => { calls.push('checkUpdate'); return Promise.resolve() }, installUpdate: () => {}, openSettings: () => {} }
  const tree = AboutPage({ useUpdate: () => update, actions, run: () => Promise.resolve(true), Section, Row })
  const page = { name: null, version: null, sections: [], rows: {}, buttons: {}, calls }
  walk(tree, (node) => {
    if (node.props.className === 'bt-about-name') page.name = textOf(node)
    if (node.props.className === 'bt-about-version') page.version = textOf(node)
    if (node.type === Section) page.sections.push(node.props.title)
    if (node.type === Row) {
      page.rows[node.props.label] = node.props.hint ?? null
      page.buttons[node.props.label] = node.children.filter(child => child?.type === 'button')
    }
  })
  return page
}

// An app's bridge that records what the page asks of it.
function bridgeOf({ check = true } = {}) {
  const asked = []
  const answer = name => () => { asked.push(name); return Promise.resolve() }
  return {
    asked,
    status: () => Promise.resolve(null), subscribe: () => () => {},
    open: answer('open'), applyPlugins: answer('applyPlugins'), setAutoApply: answer('setAutoApply'),
    ...(check ? { check: answer('check'), versions: () => Promise.resolve(null) } : {}),
  }
}

// What the host answers inside the app, where the package's own check is off (cordis.patch.yml).
const HOST_IN_APP = { name: '@automagik/bots-dsh', current: '3.117.4', source: 'app', enabled: false, phase: 'idle', available: false, dsh: { current: null, phase: 'idle' } }
const VERSIONS = { app: '3.117.2', dsh: '0.2.3', plugins: [{ name: '@automagik/bots-dsh', version: '3.117.4' }, { name: '@automagik/genie-dsh', version: '1.4.0' }], updates: true }

test('inside the app, About names Automagik with the app\'s own version, not the Bot team\'s', () => {
  const page = draw({ update: HOST_IN_APP, bridge: bridgeOf(), state: { phase: 'idle' }, versions: VERSIONS })
  assert.equal(page.name, 'Automagik')
  assert.equal(page.version, 'Version 3.117.2')
  assert.deepEqual(page.sections, ['Updates', 'Plugins', 'Links'])
  // Each plugin under its own name and version; the runtime under its own.
  assert.equal(page.rows['Bot team'], 'Version 3.117.4')
  assert.equal(page.rows.Genie, 'Version 1.4.0')
  assert.equal(page.rows['DeepSeek Harness'], 'Version 0.2.3')
  assert.equal('Omni' in page.rows, false)
})

test('an app that does not say its version shows the Bot team\'s under its own name, never as the app\'s', () => {
  const page = draw({ update: HOST_IN_APP, bridge: bridgeOf({ check: false }), state: { phase: 'idle' } })
  assert.equal(page.name, 'Automagik')
  assert.equal(page.version, null)
  assert.deepEqual(page.sections, ['Updates', 'Plugins', 'Links'])
  assert.equal(page.rows['Bot team'], 'Version 3.117.4')
})

test('the plugin\'s own check being off never reads as "updates are off" inside the app', () => {
  for (const source of ['app', 'unknown']) {
    const page = draw({ update: { ...HOST_IN_APP, source }, bridge: bridgeOf(), state: { phase: 'idle' }, versions: VERSIONS })
    assert.equal(page.rows.Automagik, 'Updates come with the Automagik app.')
    const [button] = page.buttons.Automagik
    assert.equal(textOf(button), 'Check for updates')
    assert.notEqual(button.props.disabled, true)
  }
})

test('Check for updates only checks, also while plugins or an update wait', () => {
  // Plugins are staged: the app's own part is idle, and `open` would restart DSH.
  const staged = { phase: 'ready', kind: 'plugins', version: '3.117.5', app: { phase: 'idle' }, plugins: { phase: 'ready', auto: false, changes: [{ name: '@automagik/bots-dsh', from: '3.117.4', to: '3.117.5' }] } }
  for (const state of [staged, { phase: 'idle' }, { phase: 'error', failure: 'check' }]) {
    const bridge = bridgeOf()
    const page = draw({ update: HOST_IN_APP, bridge, state, versions: VERSIONS })
    const [button] = page.buttons.Automagik
    assert.equal(textOf(button), 'Check for updates')
    button.props.onClick()
    assert.deepEqual(bridge.asked, ['check'])
    assert.deepEqual(page.calls, [])
  }
})

test('a failed check says so, and a check under way disables the button', () => {
  const failed = draw({ update: HOST_IN_APP, bridge: bridgeOf(), state: { phase: 'error', failure: 'check' }, versions: VERSIONS })
  assert.equal(failed.rows.Automagik, 'Update check failed · Retry')
  const busy = draw({ update: HOST_IN_APP, bridge: bridgeOf(), state: { phase: 'checking' }, versions: VERSIONS })
  assert.equal(busy.buttons.Automagik[0].props.disabled, true)
  assert.equal(textOf(busy.buttons.Automagik[0]), 'Checking…')
})

test('a restart is asked only under the label that says so', () => {
  const bridge = bridgeOf()
  const page = draw({ update: HOST_IN_APP, bridge, state: { phase: 'ready', version: '3.118.0' }, versions: VERSIONS })
  const [button] = page.buttons.Automagik
  assert.equal(textOf(button), 'Restart to update to 3.118.0')
  button.props.onClick()
  assert.deepEqual(bridge.asked, ['open'])
})

test('a copy of the app that does not update says so and offers no check', () => {
  const page = draw({ update: HOST_IN_APP, bridge: bridgeOf(), state: { phase: 'idle' }, versions: { ...VERSIONS, updates: false } })
  assert.equal(page.rows.Automagik, 'Updates are off in this copy of Automagik.')
  assert.deepEqual(page.buttons.Automagik, [])
  assert.equal(page.version, 'Version 3.117.2')
})

test('an app from before the check has its button as it was', () => {
  const bridge = bridgeOf({ check: false })
  const page = draw({ update: HOST_IN_APP, bridge, state: { phase: 'idle' } })
  page.buttons.Automagik[0].props.onClick()
  assert.deepEqual(bridge.asked, ['open'])
})

test('the app\'s answer is read as data: only named plugins with a version are listed', () => {
  const versions = { app: '3.117.2', dsh: 7, plugins: [{ name: '@automagik/welcome-dsh', version: '3.117.2' }, { name: 5, version: '1.0.0' }, { name: '@automagik/acp-dsh' }, null], updates: true }
  const page = draw({ update: HOST_IN_APP, bridge: bridgeOf(), state: { phase: 'idle' }, versions })
  assert.equal(page.rows.Welcome, 'Version 3.117.2')
  assert.equal(Object.keys(page.rows).includes('ACP agents'), false)
  assert.equal('DeepSeek Harness' in page.rows, false)
  assert.equal(draw({ update: HOST_IN_APP, bridge: bridgeOf(), state: { phase: 'idle' }, versions: { app: '3.117.2', plugins: 'all' } }).sections.includes('Plugins'), false)
})

test('in a plain DSH the page is Automagik\'s and the Bot team\'s own update stays as it was', () => {
  const update = { name: '@automagik/bots-dsh', current: '3.117.2', latest: '3.118.0', source: 'registry', enabled: true, phase: 'idle', available: true, checkedAt: 1, dsh: { current: '0.2.3', verified: '0.2.3', kind: 'npm', phase: 'idle' } }
  const page = draw({ update })
  assert.equal(page.name, 'Automagik')
  assert.equal(page.version, 'Version 3.117.2')
  assert.deepEqual(page.sections, ['Updates', 'Links'])
  assert.equal(page.rows.Omni, 'Omni 3.118.0 is available')
  assert.equal(textOf(page.buttons.Omni[0]), 'Update')
  assert.equal(page.rows['DeepSeek Harness'], 'Version 0.2.3')
  // A check switched off there is still said, with its button disabled.
  const off = draw({ update: { ...update, available: false, latest: null, enabled: false, source: 'unknown' } })
  assert.equal(off.rows.Omni, 'Update checks are off.')
  assert.equal(off.buttons.Omni[0].props.disabled, true)
})

test('in the desktop environment without the app\'s bridge, updates still come with the app', () => {
  const page = draw({ update: HOST_IN_APP })
  assert.equal(page.rows.Automagik, 'Updates come with the Automagik app.')
  assert.deepEqual(page.buttons.Automagik, [])
  assert.equal(page.version, null)
  assert.equal(page.rows['Bot team'], 'Version 3.117.4')
})

test('alone on an app from before the check and the versions, the page is as that app had it: no dead button', () => {
  // The app's whole bridge then: status, open, applyPlugins, setAutoApply, subscribe.
  const staged = { phase: 'ready', kind: 'plugins', version: '3.117.5', app: { phase: 'idle' }, plugins: { phase: 'ready', auto: false, changes: [{ name: '@automagik/bots-dsh', from: '3.117.4', to: '3.117.5' }] } }
  for (const [state, label, hint] of [
    [{ phase: 'idle' }, 'Check for updates', 'Updates come with the Automagik app.'],
    [{ phase: 'error', failure: 'check' }, 'Check for updates', 'Update check failed · Retry'],
    [{ phase: 'ready', version: '3.118.0' }, 'Restart to update to 3.118.0', 'Restart to update to 3.118.0'],
    [{ phase: 'available', version: '3.118.0' }, 'Automagik 3.118.0 is out', 'Automagik 3.118.0 is out'],
  ]) {
    // The host of this Bot team says `app`; one that has not looked yet says `unknown`.
    for (const source of ['app', 'unknown']) {
      const bridge = bridgeOf({ check: false })
      assert.equal('check' in bridge || 'versions' in bridge, false)
      const page = draw({ update: { ...HOST_IN_APP, source }, bridge, state })
      assert.equal(page.rows.Automagik, hint)
      const [button] = page.buttons.Automagik
      assert.equal(textOf(button), label)
      assert.notEqual(button.props.disabled, true)
      // The one way in that app has: its `open`, as before this change.
      button.props.onClick()
      assert.deepEqual(bridge.asked, ['open'])
      // Nothing is claimed about the app that it did not say.
      assert.equal(page.version, null)
      assert.equal(page.rows['Bot team'], 'Version 3.117.4')
      assert.notEqual(page.rows.Automagik, 'Updates are off in this copy of Automagik.')
      assert.notEqual(page.rows.Automagik, 'Update checks are off.')
    }
  }
  // Staged with auto-apply off is held all the same: that app's `open` restarts DSH whatever the
  // setting says (#1029). The button keeps its plain words and asks nothing.
  for (const source of ['app', 'unknown']) {
    const bridge = bridgeOf({ check: false })
    const page = draw({ update: { ...HOST_IN_APP, source }, bridge, state: staged })
    assert.equal(page.rows.Automagik, 'Updates come with the Automagik app.')
    const [button] = page.buttons.Automagik
    assert.equal(textOf(button), 'Check for updates')
    assert.equal(button.props.disabled, true)
    button.props.onClick()
    assert.deepEqual(bridge.asked, [])
    assert.deepEqual(page.calls, [])
  }
  // The plugins that app staged still have their own row and button.
  const bridge = bridgeOf({ check: false })
  const page = draw({ update: HOST_IN_APP, bridge, state: staged })
  states = [staged, null]
  asked = 0
  const texts = []
  walk(AboutPage({ useUpdate: () => HOST_IN_APP, actions: { repoStars: () => Promise.resolve(null) }, run: () => Promise.resolve(true), Section, Row }), (node) => { if (node.type === 'button') texts.push(textOf(node)) })
  assert.equal(page.sections.includes('Updates'), true)
  assert.equal(texts.includes('Update now'), true)
})

// #1029: an app from before `check` has only `open`, and its `open` puts staged plugins in at once,
// restarting DSH without asking whether an agent is at work, whatever auto-apply says.
const CHANGES = [{ name: '@automagik/bots-dsh', from: '3.117.4', to: '3.117.5' }]
const stagedFor = plugins => ({ phase: 'ready', kind: 'plugins', version: '3.117.5', app: { phase: 'idle' }, plugins: { phase: 'ready', changes: CHANGES, ...plugins } })

test('#1029: on an app from before the check, staged plugins are never put in by Check for updates', () => {
  for (const [why, state] of [
    ['auto-apply on', stagedFor({ auto: true })],
    ['an app that does not say the setting', stagedFor({})],
    // Auto-apply says only who starts it: `open` restarts DSH all the same.
    ['auto-apply off', stagedFor({ auto: false })],
    // Staged as the whole says it, with no change named in the plugins' part.
    ['staged at the top only', { phase: 'ready', kind: 'plugins', version: '3.117.5', app: { phase: 'idle' }, plugins: { phase: 'idle', changes: [], auto: true } }],
    ['staged at the top only, auto-apply off', { phase: 'ready', kind: 'plugins', version: '3.117.5', app: { phase: 'idle' }, plugins: { phase: 'idle', changes: [], auto: false } }],
    // Still coming: they are staged a moment later, perhaps before the app hears the click.
    ['plugins downloading', { phase: 'downloading', kind: 'plugins', version: '3.117.5', percent: 40, app: { phase: 'idle' }, plugins: { phase: 'downloading', changes: CHANGES, percent: 40, auto: true } }],
    ['plugins downloading, auto-apply off', { phase: 'downloading', kind: 'plugins', version: '3.117.5', percent: 40, app: { phase: 'idle' }, plugins: { phase: 'downloading', changes: CHANGES, percent: 40, auto: false } }],
    ['downloading at the top only', { phase: 'downloading', kind: 'plugins', version: '3.117.5', percent: 40, app: { phase: 'idle' }, plugins: { phase: 'idle', changes: [], auto: true } }],
    ['downloading at the top only, auto-apply off', { phase: 'downloading', kind: 'plugins', version: '3.117.5', percent: 40, app: { phase: 'idle' }, plugins: { phase: 'idle', changes: [], auto: false } }],
    // The app has not said anything yet: what its `open` would do is not known.
    ['no presentation yet', null],
    ['a failed check beside them', { phase: 'ready', kind: 'plugins', version: '3.117.5', app: { phase: 'error', failure: 'check' }, plugins: { phase: 'ready', changes: CHANGES, auto: true } }],
    ['a failed check beside them, auto-apply off', { phase: 'ready', kind: 'plugins', version: '3.117.5', app: { phase: 'error', failure: 'check' }, plugins: { phase: 'ready', changes: CHANGES, auto: false } }],
  ]) {
    for (const source of ['app', 'unknown']) {
      const bridge = bridgeOf({ check: false })
      const page = draw({ update: { ...HOST_IN_APP, source }, bridge, state })
      const [button] = page.buttons.Automagik
      assert.equal(textOf(button), 'Check for updates', why)
      assert.equal(button.props.disabled, true, why)
      // The handler refuses by itself too: nothing is asked of the app.
      button.props.onClick()
      assert.deepEqual(bridge.asked, [], why)
      assert.deepEqual(page.calls, [], why)
    }
  }
})

test('#1029: with nothing staged, an app from before the check is still asked through its `open`', () => {
  for (const [why, state] of [
    ['plugins idle', { phase: 'idle', app: { phase: 'idle' }, plugins: { phase: 'idle', changes: [], auto: true } }],
    ['a failed check', { phase: 'error', failure: 'check', app: { phase: 'error', failure: 'check' }, plugins: { phase: 'idle', changes: [], auto: true } }],
    ['an app that does not split its plugins', { phase: 'idle' }],
    ['plugins going in', { phase: 'installing', kind: 'plugins', version: '3.117.5', app: { phase: 'idle' }, plugins: { phase: 'installing', changes: CHANGES, auto: true } }],
    // With nothing staged there is nothing `open` could put in, auto-apply off included.
    ['plugins idle, auto-apply off', { phase: 'idle', app: { phase: 'idle' }, plugins: { phase: 'idle', changes: [], auto: false } }],
    ['a failed check, auto-apply off', { phase: 'error', failure: 'check', app: { phase: 'error', failure: 'check' }, plugins: { phase: 'idle', changes: [], auto: false } }],
  ]) {
    const bridge = bridgeOf({ check: false })
    const page = draw({ update: HOST_IN_APP, bridge, state })
    const [button] = page.buttons.Automagik
    assert.equal(textOf(button), 'Check for updates', why)
    assert.notEqual(button.props.disabled, true, why)
    button.props.onClick()
    assert.deepEqual(bridge.asked, ['open'], why)
  }
})

test('#1029: an app with its own check is never held: staged plugins or not, the button only checks', () => {
  for (const state of [stagedFor({ auto: true }), stagedFor({}), stagedFor({ auto: false })]) {
    const bridge = bridgeOf()
    const page = draw({ update: HOST_IN_APP, bridge, state, versions: VERSIONS })
    const [button] = page.buttons.Automagik
    assert.equal(textOf(button), 'Check for updates')
    assert.notEqual(button.props.disabled, true)
    button.props.onClick()
    assert.deepEqual(bridge.asked, ['check'])
  }
})

test('#1029: the held button leaves the app\'s labelled buttons and the plugins\' own rows as they were', () => {
  // An app update that is ready or out keeps its own button, which says what it does.
  for (const [app, label] of [[{ phase: 'ready', version: '3.118.0' }, 'Restart to update to 3.118.0'], [{ phase: 'available', version: '3.118.0' }, 'Automagik 3.118.0 is out']]) {
    const bridge = bridgeOf({ check: false })
    const page = draw({ update: HOST_IN_APP, bridge, state: { ...app, app, plugins: { phase: 'ready', changes: CHANGES, auto: true } } })
    const [button] = page.buttons.Automagik
    assert.equal(textOf(button), label)
    assert.notEqual(button.props.disabled, true)
    button.props.onClick()
    assert.deepEqual(bridge.asked, ['open'])
  }
  // The plugins' row says when they go in, and the switch that decides it is still offered.
  const bridge = bridgeOf({ check: false })
  const page = draw({ update: HOST_IN_APP, bridge, state: stagedFor({ auto: true }) })
  assert.equal('Apply plugin updates automatically' in page.rows, true)
  // The Bot team has two rows (its update, its version): read every row of the page as drawn.
  states = [stagedFor({ auto: true }), null]
  asked = 0
  const hints = []
  const texts = []
  walk(AboutPage({ useUpdate: () => HOST_IN_APP, actions: { repoStars: () => Promise.resolve(null) }, run: () => Promise.resolve(true), Section, Row }), (node) => {
    if (node.type === Row) hints.push(node.props.hint)
    if (node.type === 'button') texts.push(textOf(node))
  })
  assert.equal(hints.includes('3.117.4 → 3.117.5 · Updates when no agent is at work'), true)
  // Applying by itself, the app offers no "Update now" there.
  assert.equal(texts.includes('Update now'), false)
})

test('#1029: the hold reads the app\'s own `check` and the plugins\' own part, each alone', () => {
  // A bridge with `check` and nothing else newer is never held.
  const checks = bridgeOf({ check: false })
  checks.check = () => { checks.asked.push('check'); return Promise.resolve() }
  const free = draw({ update: HOST_IN_APP, bridge: checks, state: stagedFor({ auto: true }) })
  assert.notEqual(free.buttons.Automagik[0].props.disabled, true)
  free.buttons.Automagik[0].props.onClick()
  assert.deepEqual(checks.asked, ['check'])
  // Staged only as the plugins' own part says it: held all the same.
  const bridge = bridgeOf({ check: false })
  const held = draw({ update: HOST_IN_APP, bridge, state: { phase: 'idle', app: { phase: 'idle' }, plugins: { phase: 'ready', changes: CHANGES, auto: true } } })
  assert.equal(held.buttons.Automagik[0].props.disabled, true)
  held.buttons.Automagik[0].props.onClick()
  assert.deepEqual(bridge.asked, [])
})
