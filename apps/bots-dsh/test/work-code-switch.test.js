import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The row control's module as the browser gets it, with a minimal React: components run as plain
// functions, effects are collected for the test to run, and the store hook reads the snapshot.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/work-code-switch.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
let effects = []
const owners = new Map()
let mountedTree
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
  useEffect: effect => effects.push(effect), useState: make => {
    if (!owners.has(mountedTree)) owners.set(mountedTree, make())
    return [owners.get(mountedTree)]
  }, useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
}
const listeners = {}
const context = {
  module: { exports: {} },
  require: name => (name === 'react' ? react : {}),
  addEventListener: (name, listener) => { (listeners[name] ??= []).push(listener) },
  removeEventListener: (name, listener) => { listeners[name] = (listeners[name] ?? []).filter(other => other !== listener) },
  Promise, WeakMap, Set, Object,
}
context.exports = context.module.exports
runInNewContext(bundle.outputFiles[0].text, context)
const { createCodeSwitch, noteKindOf, showsSwitch, useCodeRowHerdr } = context.module.exports
// The module's arrays and objects are the sandbox's: compare them as plain values.
const plain = value => (value === undefined ? value : JSON.parse(JSON.stringify(value)))
const codeNotices = result => plain(context.module.exports.codeNotices(result))

// A stand-in for apps/desktop's preload bridge: it records each call and answers what the test says.
function fakeBridge(status, answers = []) {
  const calls = { status: 0, open: [] }
  return {
    calls,
    status: async () => { calls.status++; return status },
    open: async request => { calls.open.push(plain(request)); return answers.shift() ?? { ok: true, raised: true } },
  }
}

const WRITER = 'b-aaaaaaaaaa'
const BUILDER = 'b-bbbbbbbbbb'

// Draw the row's notices with the same owner held across renders.
function render(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (typeof node.type === 'function') return render(node.type(node.props))
  return { ...node, props: { ...node.props, children: node.props.children.map(render) } }
}
function mount(bridge, tree = 'one') {
  context.omniDesktop = bridge === undefined ? undefined : { herdr: bridge }
  effects = []
  mountedTree = tree
  const herdr = useCodeRowHerdr()
  for (const effect of effects.splice(0)) effect()
  return { ...herdr, notices: render(herdr.notices) }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const all = (node, found = []) => {
  if (node && typeof node === 'object') {
    found.push(node)
    for (const child of node.props?.children ?? []) all(child, found)
  }
  return found
}
const textOf = node => all(node).flatMap(n => n.props.children.filter(c => typeof c === 'string')).join(' ')
const button = (tree, label) => all(tree).find(n => n.type === 'button' && n.props.children.includes(label))

test('the row action shows only with the app bridge and a herdr-app that is set up', async () => {
  assert.equal(mount(undefined).visible(), false)
  assert.equal(mount({ status: async () => ({ state: 'open' }) }).visible(), false, 'a bridge without open() is not one')
  for (const state of ['missing', 'unsupported']) {
    const bridge = fakeBridge({ state })
    mount(bridge)
    await settle()
    assert.equal(mount(bridge).visible(), false, state)
    assert.equal(bridge.calls.status > 0, true)
  }
  for (const state of ['open', 'closed']) {
    const bridge = fakeBridge({ state, source: 'path' })
    assert.equal(mount(bridge).visible(), false, 'nothing shows before status() answers')
    await settle()
    assert.equal(mount(bridge).visible(), true, state)
  }
  assert.equal(showsSwitch({ state: 'error', source: 'path', message: 'boom' }), true)
  assert.equal(showsSwitch(null), false)
  const failing = { status: async () => { throw new Error('ipc') }, open: async () => ({}) }
  mount(failing)
  await settle()
  assert.equal(mount(failing).visible(), false)
})

test('mount, focus and pointer entry only refresh; a row click opens the chosen Bot', async () => {
  const bridge = fakeBridge({ state: 'closed', source: 'path' })
  const rows = []
  bridge.openCodeRow = (...args) => { rows.push(plain(args)); return { ok: true, raised: true } }
  mount(bridge)
  await settle()
  assert.equal(bridge.calls.status, 1)
  for (const listener of listeners.focus ?? []) listener()
  await settle()
  assert.equal(bridge.calls.status, 2)
  mount(bridge).refresh()
  await settle()
  assert.equal(bridge.calls.status, 3)
  assert.deepEqual(bridge.calls.open, [])
  assert.deepEqual(rows, [])
  assert.equal(listeners.keydown, undefined)
  mount(bridge).openRow(WRITER)
  await settle()
  assert.deepEqual(rows, [[WRITER]])
})

test('an offer of a newer Herdr asks first: yes updates, no opens the installed one', async () => {
  const offer = { ok: false, reason: 'update', installed: '0.9.0', latest: '1.0.0', message: 'Herdr 1.0.0 is available' }
  const bridge = fakeBridge({ state: 'open', source: 'path' }, [offer, offer, { ok: true, raised: true }, offer])
  mount(bridge)
  await settle()
  mount(bridge).openRow(WRITER)
  await settle()
  let tree = mount(bridge).notices
  assert.match(textOf(tree), /Herdr 1\.0\.0 is out/)
  button(tree, 'Update and open').props.onClick()
  await settle()
  tree = mount(bridge).notices
  button(tree, 'Open this version').props.onClick()
  await settle()
  assert.deepEqual(bridge.calls.open, [{ botId: null }, { botId: null, update: true }, { botId: null, update: false }])
  mount(bridge).openRow(WRITER)
  await settle()
  button(mount(bridge).notices, 'Dismiss').props.onClick()
  assert.equal(button(mount(bridge).notices, 'Update and open'), undefined)
  assert.equal(bridge.calls.open.length, 4)
})

test('each answer from the app shows its label', () => {
  const labels = result => codeNotices(result).map(notice => notice.label)
  assert.deepEqual(codeNotices({ ok: true, raised: true }), [])
  assert.deepEqual(labels({ ok: true, raised: true, version: '1.0.0', space: { action: 'select', id: 's1' } }), [])
  assert.deepEqual(labels({ ok: false, reason: 'update', latest: '1.0.0' }), ['Herdr 1.0.0 is out'])
  assert.deepEqual(labels({ ok: false, reason: 'missing', message: 'Herdr is not set up' }), ['Herdr is not set up'])
  assert.deepEqual(labels({ ok: false, reason: 'unsupported' }), ['Herdr has no build for this computer'])
  for (const reason of ['timeout', 'start', 'error']) {
    const [notice] = codeNotices({ ok: false, reason, message: "Herdr didn't open", detail: 'last stderr' })
    assert.equal(notice.label, "Herdr didn't open")
    assert.equal(notice.retry, true)
    assert.equal(notice.title, 'last stderr')
  }
  assert.deepEqual(labels({ ok: true, raised: false, message: 'Herdr is open in another window' }), ['Herdr is open in another window'])
  assert.deepEqual(labels({ ok: true, raised: null }), ['Herdr is open in another window'], 'the OS could not tell')
  const offline = "Herdr couldn't check for updates (no connection); this is the installed one"
  const unusable = "Herdr couldn't check for updates (the feed has no linux-x86_64 build); this is the installed one"
  const failed = "Herdr couldn't update to 1.0.0 (disk full); this is the installed 0.9.0"
  const restart = 'Herdr 1.0.0 is installed; it starts when Herdr restarts'
  const notes = [
    ['offline', offline, 'No connection: Herdr opened on the installed version'],
    ['check-failed', unusable, "Herdr couldn't check for updates: it opened on the installed version"],
    ['update-failed', failed, "Herdr couldn't update: it opened on the installed version"],
    ['updated-restart', restart, 'Herdr 1.0.0 is installed: it starts when Herdr restarts'],
  ]
  for (const [noteKind, note, label] of notes) {
    // The app names the kind; an older one sends the note alone, and its text tells the kind.
    for (const result of [{ ok: true, raised: true, version: '1.0.0', note, noteKind }, { ok: true, raised: true, version: '1.0.0', note }]) {
      assert.equal(noteKindOf(result), noteKind, note)
      const [notice] = codeNotices(result)
      assert.equal(notice.label, label)
      assert.equal(notice.title, note)
    }
  }
  // A successful update is never reported as a failure, whatever the note says.
  assert.deepEqual(labels({ ok: true, raised: true, version: '1.0.0', note: 'anything', noteKind: 'updated-restart' }), ['Herdr 1.0.0 is installed: it starts when Herdr restarts'])
  // A note of a kind or wording this page does not know: Herdr's own words.
  assert.deepEqual(labels({ ok: true, raised: true, note: 'Something new', noteKind: 'later-kind' }), ['Herdr says: Something new'])
  assert.deepEqual(labels({ ok: true, raised: true, space: { action: 'new', error: 'box is offline' } }), ['Herdr says: box is offline'])
  assert.deepEqual(labels({ ok: true, raised: false, note: offline }), ['Herdr is open in another window', 'No connection: Herdr opened on the installed version'])
  assert.deepEqual(labels(null), ["Herdr didn't open"], 'an app that refused the page')
})

test('a failed or refused open shows its label and can be dismissed', async () => {
  const refused = { status: async () => ({ state: 'open', source: 'path' }), open: () => Promise.reject(new Error('Herdr opens only on a click')) }
  const control = createCodeSwitch(refused)
  await control.refresh()
  const result = await control.open({ botId: WRITER })
  assert.equal(result.reason, 'error')
  assert.equal(control.snapshot().busy, false)
  assert.deepEqual(codeNotices(control.snapshot().result).map(n => n.label), ["Herdr didn't open"])
  control.dismiss()
  assert.equal(control.snapshot().result, null)
  // An app that refused the page answers null: a failed open, not silence.
  const silent = createCodeSwitch({ status: async () => ({ state: 'open' }), open: async () => null })
  await silent.open({ botId: WRITER })
  assert.deepEqual(codeNotices(silent.snapshot().result).map(n => n.label), ["Herdr didn't open"])
  // One open at a time: a second click while the first runs does not reach the bridge again.
  const slow = fakeBridge({ state: 'open', source: 'path' })
  const twice = createCodeSwitch(slow)
  const first = twice.open({ botId: WRITER })
  void twice.open({ botId: WRITER })
  await first
  assert.equal(slow.calls.open.length, 1)
})

test('Retry repeats the modern Code row without invoking the legacy open', async () => {
  const bridge = fakeBridge({ state: 'open' })
  const calls = []
  bridge.openCodeRow = (...args) => {
    calls.push(plain(args))
    return { ok: false, reason: 'start' }
  }
  mount(bridge)
  await settle()
  mount(bridge).openRow(WRITER)
  assert.deepEqual(calls, [[WRITER]])
  await settle()
  button(mount(bridge).notices, 'Retry').props.onClick()
  assert.deepEqual(calls, [[WRITER], [WRITER]])
  assert.deepEqual(bridge.calls.open, [])
  await settle()
})

test('a second Code row retargets the offer and Retry to its own Bot', async () => {
  const offer = { ok: false, reason: 'update', latest: '2.0.0' }
  const answers = [offer, offer, { ok: false, reason: 'start' }, { ok: true, raised: true }]
  const bridge = fakeBridge({ state: 'open' })
  const calls = []
  bridge.openCodeRow = (...args) => { calls.push(plain(args)); return answers.shift() }
  mount(bridge)
  await settle()
  mount(bridge).openRow(WRITER)
  await settle()
  mount(bridge).openRow(BUILDER)
  await settle()
  button(mount(bridge).notices, 'Update and open').props.onClick()
  await settle()
  button(mount(bridge).notices, 'Retry').props.onClick()
  await settle()
  assert.deepEqual(calls, [[WRITER], [BUILDER], [BUILDER, { update: true }], [BUILDER]])
  assert.deepEqual(bridge.calls.open, [])
})

test('missing or unsupported Herdr refreshes availability without hiding the row notice', async () => {
  for (const reason of ['missing', 'unsupported']) {
    let statusReads = 0
    const bridge = {
      status: async () => ({ state: ++statusReads === 1 ? 'open' : reason }),
      open: async () => ({ ok: false, reason }),
    }
    const control = createCodeSwitch(bridge)
    await control.refresh()
    assert.equal(showsSwitch(control.snapshot().status), true)
    await control.open({ botId: WRITER })
    await settle()
    assert.equal(statusReads, 2)
    assert.equal(showsSwitch(control.snapshot().status), false)
    assert.equal(codeNotices(control.snapshot().result)[0].kind, reason)
  }
})
