import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

// preload.cjs in a context of its own (as preload.test.js runs it), with a page's localStorage,
// a clock the test turns, and a fake Electron that records what main is asked and sent.
function storageOf(initial = {}, { failing = false } = {}) {
  const map = new Map(Object.entries(initial))
  const fail = () => { if (failing) throw new Error('storage unavailable') }
  return {
    map,
    get length() { fail(); return map.size },
    key: (i) => { fail(); return [...map.keys()][i] ?? null },
    getItem: (key) => { fail(); return map.has(key) ? map.get(key) : null },
    setItem: (key, value) => { fail(); map.set(String(key), String(value)) },
    removeItem: (key) => { map.delete(key) },
  }
}

function loadPreload({ storage, take = () => ({ moved: false, entries: {} }), sendSync = true } = {}) {
  const exposed = {}
  const sync = []
  const sent = []
  const ticks = []
  const listeners = {}
  const ipcRenderer = {
    invoke: () => Promise.resolve(null), on: () => {}, off: () => {},
    send: (...args) => { sent.push(JSON.parse(JSON.stringify(args))) },
  }
  if (sendSync) ipcRenderer.sendSync = (...args) => { sync.push(args); return take() }
  const context = vm.createContext({
    require: (name) => { if (name === 'electron') return { contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value } }, ipcRenderer }; throw new Error(`no ${name} in a sandboxed preload`) },
    process: { platform: 'linux' },
    document: { documentElement: { dataset: {} }, addEventListener: () => {} },
    navigator: {},
    console,
    ...(storage ? { localStorage: storage } : {}),
    setInterval: (run, ms) => { ticks.push({ run, ms }) },
    addEventListener: (name, run) => { listeners[name] = run },
  })
  vm.runInContext(readFileSync(new URL('../src/preload.cjs', import.meta.url), 'utf8'), context)
  return { exposed, sync, sent, tick: () => ticks.forEach(t => t.run()), ticks, listeners }
}

const entry = draft => JSON.stringify({ draft, view: null, viewRequest: null })

test('as the page starts, the drafts kept on another origin are put back under DSH\'s keys, then the copy is sent', () => {
  const storage = storageOf({ 'dsh.conversation.s9': entry('stale here'), 'omni-ui:prefs': '{"theme":"dark"}' })
  const back = { 'dsh.conversation.s1': entry('unsent'), 'dsh.conversation.s9': entry('newer') }
  const { sync, sent, ticks, listeners } = loadPreload({ storage, take: () => ({ moved: true, entries: back }) })
  assert.deepEqual(sync, [['automagik-drafts-take']])
  assert.equal(storage.map.get('dsh.conversation.s1'), entry('unsent'))
  assert.equal(storage.map.get('dsh.conversation.s9'), entry('newer'), 'the copy is the newer state of a Session it holds')
  assert.equal(storage.map.get('omni-ui:prefs'), '{"theme":"dark"}')
  assert.deepEqual(sent, [['automagik-drafts-keep', back]])
  assert.deepEqual(ticks.map(t => t.ms), [2000])
  assert.equal(typeof listeners.pagehide, 'function')
})

test('on the same origin the copy only fills in keys the page lost: what the page has is never replaced', () => {
  const storage = storageOf({ 'dsh.conversation.s1': entry(''), 'dsh.conversation.s2': entry('newer here') })
  const copy = { 'dsh.conversation.s1': entry('sent since'), 'dsh.conversation.s2': entry('older'), 'dsh.conversation.s3': entry('lost by the storage') }
  const { sent } = loadPreload({ storage, take: () => ({ moved: false, entries: copy }) })
  assert.equal(storage.map.get('dsh.conversation.s1'), entry(''), 'a sent draft stays sent')
  assert.equal(storage.map.get('dsh.conversation.s2'), entry('newer here'))
  assert.equal(storage.map.get('dsh.conversation.s3'), entry('lost by the storage'))
  assert.deepEqual(sent, [['automagik-drafts-keep', Object.fromEntries(storage.map)]])
})

test('only DSH\'s draft entries are put back or sent: no other key, and not the width kept under the same prefix', () => {
  const storage = storageOf({
    'dsh.conversation.s1': entry('mine'), 'dsh.conversation.contentWidth': '720', 'dsh.keybindings.v1': '{"draft":1}',
    'automagik:secret': 'x', 'dsh.conversation.bad': 'not json',
  })
  const { sent } = loadPreload({ storage, take: () => ({ moved: true, entries: { 'dsh.layout.widths': '{"draft":"x"}', 'dsh.conversation.n': 5, 'dsh.conversation.w': '9', 'dsh.conversation.s2': entry('back') } }) })
  assert.equal(storage.map.has('dsh.layout.widths'), false)
  assert.equal(storage.map.has('dsh.conversation.n'), false)
  assert.equal(storage.map.has('dsh.conversation.w'), false)
  assert.equal(storage.map.get('dsh.conversation.contentWidth'), '720')
  assert.deepEqual(sent, [['automagik-drafts-keep', { 'dsh.conversation.s1': entry('mine'), 'dsh.conversation.s2': entry('back') }]])
})

test('the copy follows the page: sent when a draft changes, is cleared or removed, and not otherwise', () => {
  const storage = storageOf({ 'dsh.conversation.s1': entry('a') })
  const { sent, tick, listeners } = loadPreload({ storage })
  assert.equal(sent.length, 1)
  tick(); tick()
  assert.equal(sent.length, 1, 'nothing changed, nothing sent')
  storage.setItem('dsh.conversation.s1', entry('ab'))
  storage.setItem('other', 'ignored')
  tick()
  assert.deepEqual(sent.at(-1), ['automagik-drafts-keep', { 'dsh.conversation.s1': entry('ab') }])
  storage.setItem('dsh.conversation.s1', entry(''))
  tick()
  assert.deepEqual(sent.at(-1), ['automagik-drafts-keep', { 'dsh.conversation.s1': entry('') }])
  storage.removeItem('dsh.conversation.s1')
  storage.setItem('dsh.conversation.s2', entry('last words'))
  listeners.pagehide()
  assert.deepEqual(sent.at(-1), ['automagik-drafts-keep', { 'dsh.conversation.s2': entry('last words') }])
  assert.equal(sent.length, 4)
})

test('main refusing the page (null), a failing take, or no storage: nothing is put back and nothing is ever sent', () => {
  const cases = [
    { storage: storageOf({ 'dsh.conversation.s1': entry('a') }), take: () => null },
    { storage: storageOf({ 'dsh.conversation.s1': entry('a') }), take: () => 'drafts' },
    { storage: storageOf({ 'dsh.conversation.s1': entry('a') }), take: () => { throw new Error('ipc') } },
    { storage: storageOf({ 'dsh.conversation.s1': entry('a') }), take: () => ({ moved: true }) },
    { storage: storageOf({}, { failing: true }), take: () => ({ moved: true, entries: { 'dsh.conversation.s1': entry('a') } }) },
    { storage: undefined, take: () => ({ moved: true, entries: { 'dsh.conversation.s1': entry('a') } }) },
    { storage: storageOf({ 'dsh.conversation.s1': entry('a') }), sendSync: false },
  ]
  for (const [index, options] of cases.entries()) {
    const { exposed, sent, ticks, listeners } = loadPreload(options)
    assert.deepEqual(sent, [], `case ${index}`)
    assert.deepEqual(ticks, [], `case ${index}`)
    assert.equal(listeners.pagehide, undefined, `case ${index}`)
    // The rest of the preload is in place whatever the drafts did.
    assert.equal(exposed.omniDesktop.app, 'omni-desktop')
    assert.equal(typeof exposed.dsBotApp.browser.views.create, 'function')
  }
})

test('a storage that stops answering later sends nothing more, and the page goes on', () => {
  const storage = storageOf({ 'dsh.conversation.s1': entry('a') })
  const { sent, tick } = loadPreload({ storage })
  storage.setItem('dsh.conversation.s1', entry('ab'))
  Object.defineProperty(storage, 'length', { get() { throw new Error('gone') } })
  assert.doesNotThrow(tick)
  assert.equal(sent.length, 1)
})

test('the drafts add nothing to what the page can reach', () => {
  const { exposed } = loadPreload({ storage: storageOf() })
  assert.deepEqual(Object.keys(exposed).sort(), ['dsBotApp', 'omniDesktop'])
  assert.deepEqual(Object.keys(exposed.omniDesktop).sort(), ['account', 'app', 'herdr', 'platform', 'updates'])
  assert.deepEqual(Object.keys(exposed.dsBotApp), ['browser'])
})
