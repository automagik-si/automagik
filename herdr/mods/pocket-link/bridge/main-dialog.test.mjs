import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { registerHooks } from 'node:module'
import { all, textOf } from '../../../test/gpui-stub.mjs'

// Herdr's calls stay inside the fixture. Finding Node uses the bridge's recorded path.
const source = String.raw`
  let status
  let managed, pending, removedNode
  export const calls = []
  export const setOwnership = (value, changing = false) => { managed = value; pending = changing }
  export const removeNode = value => { removedNode = value }
  const store = '/home/ada/am home/parts/pocket.link'
  const bridge = store + '/current/link/bridge/bridge.mjs'
  const manager = store + '/current/pocket.mjs'
  export const managedBridge = bridge
  export const managedEntry = manager
  export const setStatus = value => { status = value }
  export const home = () => '/home/ada'
  export const appHome = () => home() + '/app'
  const root = appHome() + '/mods/pocket-link'
  const node = home() + '/bin/node'
  const replacement = home() + '/new node/bin/node'
  export const readTextFile = async path => {
    if (path === store + '/record.json' && managed) return JSON.stringify({ current: { dir: '3.1.0' }, node, state: '/home/ada/paired state' })
    if (path === store + '/pending.json' && pending) return '{}'
    if (path === bridge && managed === true) return '// installed bridge'
    return path === root + '/.node' ? node : null
  }
  export async function exec(path, args) {
    calls.push([path, ...args])
    if (path === 'printenv') return { code: 0, stdout: '/home/ada/am home\n' }
    if (path === 'sh' && removedNode) return { code: 0, stdout: replacement + '\n' }
    if (path === 'env') {
      const selected = args[2] === manager ? args[1] : args[2]
      if (removedNode && selected !== replacement) return { code: 127, stdout: '', stderr: 'No such file' }
      if (args[2] === manager) return { code: 0, stdout: '{"ok":true}' }
      if (args[3] !== bridge) throw new Error('Unexpected managed bridge')
      return { code: 0, stdout: JSON.stringify(args[4] === 'status' ? status : { ok: true, devices: [] }) }
    }
    if (path === replacement && args[0] === '--version') return { code: 0, stdout: 'v24.15.0\n' }
    if (path !== node) throw new Error('Unexpected executable')
    if (args[0] === root + '/bridge/bridge.mjs' && args[1] === 'install') return { code: 0, stdout: '{"ok":true}' }
    if (args[0] === '--version') return removedNode
      ? { code: 127, stdout: '' } : { code: 0, stdout: 'v22.15.0\n' }
    if (args[0] !== root + '/bridge/bridge.mjs' || args[1] !== 'status') {
      throw new Error('Unexpected bridge command')
    }
    return { code: 0, stdout: JSON.stringify(status) + '\n' }
  }
  export const theme = () => ({ dim: 'dim' })
  export const props = () => ({})
  export const notify = () => {}
  export const closeOverlay = () => {}
  export const watchFolder = () => new Promise(() => {})
`
const herdr = new URL(`data:text/javascript,${encodeURIComponent(source)}`)
const gpui = new URL('../../../test/gpui-stub.mjs', import.meta.url)
const stubs = { herdr, 'gpui-kit': gpui, 'gpui-base': gpui }
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return Object.hasOwn(stubs, specifier)
      ? { url: stubs[specifier].href, shortCircuit: true } : next(specifier, context)
  },
})
const { default: PocketLink } = await import('../main.js')
hooks.deregister()
const { setStatus, setOwnership, calls, managedBridge, managedEntry, removeNode } = await import(herdr.href)

const label = 'Computer key fingerprint'
const digits = '4f1c 9a07 de21'
const phoneDigits = '6d35 626d c129'

async function draw(extra = {}) {
  setStatus({
    running: true, fingerprint: digits, state: '/home/ada/state',
    devices: [{ name: 'ada', id: '6d35626dc129', fingerprint: phoneDigits }], ...extra,
  })
  const ready = Promise.withResolvers()
  const cx = {
    focus_handle: () => ({}),
    spawn: fn => fn(cx).catch(ready.reject),
    timer: { every() {} },
    notify: ready.resolve,
  }
  const view = new PocketLink()
  view.init({}, cx)
  // The folder watch stays open. The first redraw is enough to render the status.
  await ready.promise
  assert.equal(view.status?.running, extra.running ?? true)
  return view.render()
}

test('the on card shows the desktop fingerprint and keeps its digits visible', async () => {
  const tree = await draw()
  assert.match(textOf(tree), new RegExp(phoneDigits))
  const row = all(tree).find(node => node.kind === 'h_flex'
    && textOf(node.kids[0]) === label)
  assert.ok(row)
  assert.equal(textOf(row), `${label} ${digits}`)
  assert.deepEqual(row.kids[0].__node.calls, [['truncate']])
  assert.deepEqual(row.kids[1].__node.calls, [['flex_none']])
})

test('the off card hides the desktop fingerprint even if status still has digits', async () => {
  const text = textOf(await draw({ running: false }))
  assert.ok(!text.includes(label))
  assert.ok(!text.includes(digits))
})

test('the on card hides the desktop fingerprint while the key is changing', async () => {
  const text = textOf(await draw({ fingerprint: null }))
  assert.ok(!text.includes(label))
})

test('the managed dialog drives the retained entry, and uninstall disables fallback in an open dialog', async () => {
  const view = new PocketLink()
  const tasks = []
  const cx = { notify() {}, spawn(fn) { tasks.push(fn(cx)) } }
  try {
    setOwnership(true)
    setStatus({ running: false, devices: [], state: '/home/ada/paired state' })
    calls.length = 0
    await view.reload()
    assert.match(textOf(view.render()), /Managed by am/)
    assert.deepEqual(calls.at(-1), ['env', 'POCKET_LINK_STATE_DIR=/home/ada/paired state', `POCKET_LINK_SERVICE_ENTRY=${managedBridge}`, '/home/ada/bin/node', managedBridge, 'status'])
    await view.turnOn(cx)
    await Promise.all(tasks)
    assert.ok(calls.some(call => call.includes(managedEntry) && call.includes('on')))
    assert.equal((await view.bridge(['stop'])).ok, true)
    assert.ok(calls.at(-1).includes('off'))
    await view.setup(cx)
    assert.ok(calls.every(call => call[0] !== 'sh' && !call.includes('start')))
    setOwnership(false)
    await view.reload()
    const text = textOf(view.render())
    assert.match(text, /Off/)
    assert.doesNotMatch(text, /Turn on|Install the bridge|Reset key/)
    assert.equal((await view.bridge(['install'])).ok, false)
  } finally { setOwnership(false) }
})

test('a delayed standalone fallback rechecks the pending am install and never calls start', async () => {
  const view = new PocketLink()
  const tasks = []
  const timer = Promise.withResolvers()
  const cx = { notify() {}, sleep: () => timer.promise, spawn(fn) { tasks.push(fn(cx)) } }
  try {
    setOwnership(false)
    setStatus({ running: false, devices: [] })
    calls.length = 0
    await view.reload()
    await view.turnOn(cx)
    await tasks[0]
    assert.ok(calls.some(call => call.includes('install')))
    setOwnership(false, true)
    timer.resolve()
    await Promise.all(tasks)
    assert.ok(calls.every(call => !call.includes('start')))
  } finally { setOwnership(false) }
})

test('closing cancels only the displayed code, including a pair response that arrived late', async () => {
  const view = new PocketLink()
  try {
    setOwnership(true)
    view.status = { pairing: { expires: 123 }, devices: [] }
    calls.length = 0
    await view.close()
    assert.deepEqual(calls, [])
    const late = 'the-late-code', shown = 'the-shown-code'
    const id = code => createHash('sha256').update(code).digest('hex')
    await view.showCode({ code: late, challengeId: id(late) })
    assert.deepEqual(calls.at(-1).slice(-2), ['cancel', id(late)])
    view.closed = false
    view.pairing = { code: shown, challengeId: id(shown) }
    await view.close()
    assert.deepEqual(calls.at(-1).slice(-2), ['cancel', id(shown)])
    assert.ok(calls.every(args => !args.includes(late) && !args.includes(shown)))
  } finally { setOwnership(false) }
})

test('Copy link sends only the challenge hash to the bridge and copies the live link', async () => {
  const view = new PocketLink()
  const code = 'the-live-code'
  const challengeId = createHash('sha256').update(code).digest('hex')
  const link = `herdr-pocket://pair?v=1&c=${code}`
  let task, clipboard
  const cx = { notify() {}, spawn(fn) { task = fn(cx) }, write_to_clipboard(value) { clipboard = value } }
  try {
    setOwnership(true)
    setStatus({ running: true, devices: [] })
    await view.reload()
    await view.showCode({ code, challengeId, link, expires: Date.now() + 60_000 })
    calls.length = 0
    view.copyLink(cx)
    await task
    assert.deepEqual(calls.find(args => args.includes('copied')).slice(-2), ['copied', challengeId])
    assert.ok(calls.every(args => !args.includes(code) && !args.includes(link)))
    assert.equal(clipboard, link)
  } finally { setOwnership(false) }
})

test('a fresh dialog keeps a broken managed slot unavailable', async () => {
  const view = new PocketLink()
  try {
    setOwnership('broken')
    setStatus({ running: false, devices: [] })
    calls.length = 0
    await view.reload()
    const text = textOf(view.render())
    assert.match(text, /Managed by am/)
    assert.doesNotMatch(text, /Turn on|Install the bridge|Reset key/)
    assert.match((await view.bridge(['install'])).error, /am pocket link on/)
    assert.deepEqual(calls, [['printenv', 'AM_HOME']])
  } finally { setOwnership(false) }
})

test('managed status, power and pairing use a discovered Node when the recorded one disappears', async () => {
  const view = new PocketLink()
  const replacement = '/home/ada/new node/bin/node'
  try {
    setOwnership(true)
    removeNode(true)
    setStatus({ running: true, devices: [] })
    calls.length = 0
    await view.reload()
    assert.equal(view.status?.running, true)
    for (const operation of ['install', 'stop', 'pair', 'reset', 'forget']) {
      assert.equal((await view.bridge([operation])).ok, true)
    }
    const selected = calls.filter(([command, ...args]) => command === 'env' && args.includes(replacement))
    assert.deepEqual(selected.map(call => call.includes(managedEntry) ? call.at(-2) : call.at(-1)),
      ['status', 'on', 'off', 'pair', 'reset', 'forget'])
    assert.deepEqual(calls.filter(([command]) => command === 'sh').length, 1)
    assert.ok(selected.some(call => call.includes(managedBridge)))
  } finally {
    setOwnership(false)
    removeNode(false)
  }
})
