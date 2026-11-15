// A saved permission level DeepSeek Harness no longer offers (#1001), window side: Details and
// the group's settings name the saved level, say what the conversation runs as now and how it
// is settled, in the page's own note lines; the diagnostics row says what became of the
// conversation. Showing it saves nothing: only a press by the person picks a level.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

const plugin = dirname(dirname(fileURLToPath(import.meta.url)))
const harness = process.env.DSH_HARNESS
const require = createRequire(join(harness, 'package.json'))
const { JSDOM } = require('jsdom')
const assets = join(harness, 'node_modules/@deepseek-ai/dsh-web-frontend/dist/assets')
const frontend = readFileSync(join(assets, readdirSync(assets).find(name => /^index-.*\.js$/.test(name))), 'utf8')
const seed = /function (\w+)\(\)\{return\{react:[\s\S]*?\}\}/.exec(frontend)
assert.ok(seed, 'the declared native harness supplies its React seed factory')
const seedsBuild = await build({ stdin: { contents: `${frontend.slice(0, seed.index + seed[0].length)}; globalThis.nativeSeeds = ${seed[1]}();`, resolveDir: assets }, bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent' })
const seedDom = new JSDOM('<!doctype html><html><body></body></html>')
const seedContext = { window: seedDom.window, document: seedDom.window.document, navigator: seedDom.window.navigator, MutationObserver: seedDom.window.MutationObserver, fetch: async () => { throw new Error('seed bootstrap must not fetch') }, console, setTimeout, clearTimeout, performance, TextEncoder, TextDecoder }
runInNewContext(seedsBuild.outputFiles[0].text, seedContext)
const nativeRequire = name => seedContext.nativeSeeds[name] ?? require(name)
const React = nativeRequire('react')
const { createRoot } = nativeRequire('react-dom/client')
const { flushSync } = nativeRequire('react-dom')
// Flushes the render and its effects; a second flush runs what the effects scheduled. No sleep.
const act = async (fn = () => {}) => { flushSync(fn); flushSync(() => {}); await Promise.resolve(); flushSync(() => {}) }
const { outputFiles } = await build({
  stdin: { contents: [
    "export { PermissionPicker, PermissionList, PermissionFallback } from './src/client/permission-picker.js'",
    "export { permissionRows } from './src/client/permission-diagnostics.js'",
    "export { PermissionChoiceDock, reopenPermissionChoice } from './src/client/permission-card.js'",
    "export { BotPanel } from './src/client/browser-pane.js'",
    "export { GroupSettingsForm } from './src/client/group-settings.js'",
    "export { indexRoster } from './src/client/sources.js'",
    "export { STORAGE } from './src/client/storage.js'",
  ].join('\n'), resolveDir: plugin },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const READ = { value: 'read-only', name: 'Read only', description: 'dsh read' }
const WORK = { value: 'workspace-write', name: 'Workspace', description: 'dsh workspace' }
const FULL = { value: 'danger-full-access', name: 'Full access', description: 'dsh full' }
const THREE = { options: [READ, WORK, FULL], defaultPreset: 'read-only' }
const NONE = { options: [], defaultPreset: undefined }
const GONE = 'legacy-level'
const SAVED = `Saved level: ${GONE}. DeepSeek Harness no longer offers it.`
const RUNS = 'This conversation runs as Workspace now.'
const EACH = 'Each conversation keeps the level it has now, or a narrower one. Settings → Feedback lists them.'
const SETTLE = 'Pick a level to settle it. If DeepSeek Harness offers the saved level again, it is used again by itself.'

function mount(t) {
  const dom = new JSDOM('<body><div id="mount"></div></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const { window } = dom
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  window.innerWidth = 1200
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, require: name => name === '@deepseek-ai/dsh-client-ui-primitives' ? { MarkdownText: () => null } : nativeRequire(name),
    window, document: window.document, navigator: window.navigator, localStorage: window.localStorage, matchMedia: window.matchMedia, ResizeObserver: window.ResizeObserver,
    MutationObserver: window.MutationObserver, Element: window.Element, HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, HTMLTextAreaElement: window.HTMLTextAreaElement, HTMLSelectElement: window.HTMLSelectElement,
    CSS: { escape: name => name }, getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    queueMicrotask, setTimeout, clearTimeout, setInterval, clearInterval, console, performance, URL,
  })
  const root = createRoot(window.document.querySelector('#mount'))
  t.after(async () => { try { await act(() => root.unmount()) } catch {} dom.window.close() })
  const click = async (node) => { assert.ok(node, 'the control to press is on the page'); await act(() => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))) }
  return { window, document: window.document, root, click, ...module.exports }
}

// A bounded wait for `check` to hold, with no fixed sleep an assertion leans on.
async function until(check, what) {
  const end = Date.now() + 15_000
  for (;;) {
    if (check()) return
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}
// Every action a component reaches for is recorded. The saves are the object's own, as the
// panels may copy the actions they are given; any other name is recorded through the proxy.
function recorder() {
  const calls = []
  const record = name => (...args) => { calls.push([name, JSON.parse(JSON.stringify(args))]); return Promise.resolve({}) }
  const own = Object.fromEntries(['updateBot', 'updateRoom', 'updatePrefs', 'setPermission'].map(name => [name, record(name)]))
  const actions = new Proxy(own, { get: (known, name) => known[name] ?? record(name) })
  const writes = () => calls.filter(([name]) => /^(update|set|save|create|delete|remove)/i.test(String(name)))
  return { calls, writes, actions }
}
const hook = value => select => select(value)
const notes = scope => [...scope.querySelectorAll('.bt-note')].map(node => node.textContent)
const BOT = { id: 'omni', name: 'Omni', sessionId: 'omni', model: 'deepseek/v3', permission: GONE, permissionNotOffered: true, permissionRuns: 'workspace-write' }
const teamOf = (indexRoster, { bot = BOT, catalog = THREE, rooms = [] } = {}) => ({
  ...indexRoster({ bots: [bot], rooms }), permissions: catalog, models: [{ ref: 'deepseek/v3', id: 'v3' }], exchangeTurns: {}, questions: {}, sideChats: {}, memory: false, prefs: {},
})
// `room` is the width the layout gives the panel and the conversation (overlays.js
// measures it); the window here is 1200 wide.
const panelProps = { room: 1200, useSessions: hook({ byId: {} }), useSessionStatus: hook(new Map()), useActivity: hook({}), useWork: hook({}), useBrowserTabs: hook({}), useBrowserPages: hook({}) }

test('the note names the saved level, what the conversation runs as, and how it is settled', async (t) => {
  const { document, root, PermissionFallback } = mount(t)
  await act(() => root.render(React.createElement(PermissionFallback, { owner: BOT, catalog: THREE })))
  assert.deepEqual(notes(document), [SAVED, RUNS, SETTLE])
  // Text in the page's own note lines only: no control, no other class.
  assert.equal(document.querySelector('button, input, a, select'), null)
  assert.deepEqual([...new Set([...document.querySelectorAll('#mount *')].flatMap(node => [...node.classList]))], ['bt-note'])
  // A group, or a Bot whose conversation is not open, names no running level.
  await act(() => root.render(React.createElement(PermissionFallback, { owner: { ...BOT, permissionRuns: undefined }, catalog: THREE })))
  assert.deepEqual(notes(document), [SAVED, EACH, SETTLE])
  // A level it runs as that is not among the choices shows by its own name.
  await act(() => root.render(React.createElement(PermissionFallback, { owner: { ...BOT, permissionRuns: 'team-custom' }, catalog: THREE })))
  assert.equal(notes(document)[1], 'This conversation runs as team-custom now.')
})

test('without the flag the note is as before', async (t) => {
  const { document, root, PermissionFallback } = mount(t)
  await act(() => root.render(React.createElement(PermissionFallback, { fallback: 'workspace-write', owner: { permission: 'auto' }, catalog: THREE })))
  assert.deepEqual(notes(document), ['Runs as Workspace here'])
  await act(() => root.render(React.createElement(PermissionFallback, { owner: { permission: 'read-only' }, catalog: THREE })))
  assert.deepEqual(notes(document), [])
  // The flag in any other form is not the flag.
  await act(() => root.render(React.createElement(PermissionFallback, { owner: { permission: GONE, permissionNotOffered: 'yes' }, catalog: THREE })))
  assert.deepEqual(notes(document), [])
})

test('Details shows the saved level though it is no choice, marks none, and saves nothing by itself', async (t) => {
  const { document, root, click, BotPanel, indexRoster } = mount(t)
  const { actions, writes } = recorder()
  const render = roster => act(() => root.render(React.createElement(BotPanel, { pane: { id: 'omni', view: 'details' }, leaving: false, roster, actions, ...panelProps })))
  await render(teamOf(indexRoster))
  const section = document.querySelector('.bt-drawer-permission')
  const trigger = section.querySelector('.bt-model-trigger')
  assert.equal(trigger.textContent, GONE)
  assert.equal(section.querySelector('.bt-q-opt'), null)
  await click(trigger)
  const popup = document.querySelector('.bt-permission-menu')
  assert.deepEqual([...popup.querySelectorAll('.bt-q-opt')].map(row => row.dataset.permission), ['read-only', 'workspace-write', 'danger-full-access'])
  assert.deepEqual([...popup.querySelectorAll('.bt-q-opt')].map(row => row.getAttribute('aria-pressed')), ['false', 'false', 'false'], 'no offered level is shown as the saved one')
  assert.equal(document.activeElement, popup, 'without a current row focus stays on the popup')
  assert.deepEqual(notes(section).filter(text => [SAVED, RUNS, SETTLE].includes(text)), [SAVED, RUNS, SETTLE])
  assert.deepEqual(writes(), [], 'opening Details saves nothing')
  // The catalog loses its levels, then the panel goes: still nothing saved.
  await render(teamOf(indexRoster, { catalog: NONE }))
  const bare = document.querySelector('.bt-drawer-permission')
  assert.ok(bare, 'with no level to choose from the section still shows')
  assert.equal(bare.querySelector('.bt-section-title').textContent, 'Permissions')
  assert.deepEqual(notes(bare), [SAVED, RUNS, SETTLE])
  assert.equal(document.querySelector('.bt-permission-menu'), null)
  assert.equal(document.querySelector('.bt-q-opt'), null)
  assert.equal(bare.querySelector('.bt-model-trigger'), null)
  await render(teamOf(indexRoster, { bot: { ...BOT, permissionNotOffered: undefined, permissionRuns: undefined }, catalog: NONE }))
  assert.equal(document.querySelector('.bt-drawer-permission'), null, 'and without the flag an empty catalog shows no section, as before')
  await act(() => root.render(null))
  assert.deepEqual(writes(), [])
  // Only a press picks a level.
  await render(teamOf(indexRoster))
  await click(document.querySelector('.bt-drawer-permission .bt-model-trigger'))
  await click(document.querySelector('.bt-q-opt[data-permission="workspace-write"]'))
  await until(() => writes().length > 0, 'the press to be saved')
  assert.deepEqual(writes().map(([name, args]) => [name, args[0], args[1]]), [['updateBot', 'omni', { permission: 'workspace-write' }]])
})

test('Details names a gone stock level without claiming its former powers', async (t) => {
  const { document, root, BotPanel, indexRoster } = mount(t)
  const { actions, writes } = recorder()
  const bot = { ...BOT, permission: 'danger-full-access' }
  const catalog = { options: [READ, WORK], defaultPreset: 'read-only' }
  await act(() => root.render(React.createElement(BotPanel, { pane: { id: 'omni', view: 'details' }, leaving: false, roster: teamOf(indexRoster, { bot, catalog }), actions, ...panelProps })))
  const section = document.querySelector('.bt-drawer-permission')
  assert.equal(section.querySelector('.bt-model-trigger').textContent, 'Full access')
  assert.deepEqual(notes(section), ['Saved level: Full access. DeepSeek Harness no longer offers it.', RUNS, SETTLE])
  assert.ok(notes(section).every(text => !text.includes('Runs commands and changes files anywhere without asking you.')))
  assert.deepEqual(writes(), [])
})

test('the card in the chat does not come back for it, and nothing is saved on mount or dismiss', async (t) => {
  const { document, root, PermissionChoiceDock, indexRoster } = mount(t)
  const { actions, writes } = recorder()
  const render = roster => act(() => root.render(React.createElement(PermissionChoiceDock, { sessionId: 'omni', useRoster: select => select({ ...roster, ready: true }), actions })))
  await render(teamOf(indexRoster))
  assert.equal(document.querySelector('form.bt-q'), null, 'a Bot with a saved level is not asked again by itself')
  await render(teamOf(indexRoster, { catalog: NONE }))
  await act(() => root.render(null))
  assert.deepEqual(writes(), [])
})

test('the pickers mark nothing and write nothing when the saved level is no choice', async (t) => {
  const { document, root, PermissionList, PermissionPicker } = mount(t)
  let picks = 0
  const onPick = async () => { picks += 1; return true }
  await act(() => root.render(React.createElement(PermissionList, { catalog: THREE, saved: GONE, onPick })))
  assert.deepEqual([...document.querySelectorAll('.bt-q-opt')].map(row => row.getAttribute('aria-pressed')), ['false', 'false', 'false'])
  await act(() => root.render(React.createElement(PermissionList, { catalog: { options: [READ], defaultPreset: 'read-only' }, saved: GONE, onPick })))
  await act(() => root.render(React.createElement(PermissionPicker, { catalog: THREE, saved: GONE, onPick })))
  assert.deepEqual([...document.querySelectorAll('button[aria-pressed]')].map(node => node.getAttribute('aria-pressed')), ['false', 'false', 'false'])
  await act(() => root.render(null))
  assert.equal(picks, 0)
})

test('a group\'s settings tell it too, with levels to choose from and with none', async (t) => {
  const { document, root, GroupSettingsForm, indexRoster } = mount(t)
  const room = { id: 'group', name: 'Team', members: ['omni'], permission: GONE, permissionNotOffered: true }
  const { actions, writes } = recorder()
  const render = roster => act(() => root.render(React.createElement(GroupSettingsForm, { room, roster, actions, run: promise => Promise.resolve(promise).then(() => true, () => false), onClose() {} })))
  await render(teamOf(indexRoster, { rooms: [room] }))
  const section = document.querySelector('.bt-gs-perm')
  assert.deepEqual(notes(section).filter(text => [SAVED, EACH, SETTLE].includes(text)), [SAVED, EACH, SETTLE])
  assert.deepEqual([...section.querySelectorAll('button[aria-pressed]')].map(node => node.getAttribute('aria-pressed')), ['false', 'false', 'false'])
  await render(teamOf(indexRoster, { rooms: [room], catalog: NONE }))
  assert.deepEqual(notes(document).filter(text => [SAVED, EACH, SETTLE].includes(text)), [SAVED, EACH, SETTLE])
  assert.deepEqual(writes(), [], 'showing it saves nothing')
})

test('the diagnostics row says what became of the conversation, for the four outcomes only', (t) => {
  const { permissionRows } = mount(t)
  const roster = { bots: [{ id: 'omni', name: 'Omni' }], rooms: [] }
  const row = notOffered => ({ kind: 'chat', botId: 'omni', open: true, source: 'bot', saved: { value: 'custom' }, effective: { value: 'workspace-write' }, differs: true, notOffered })
  const told = notOffered => permissionRows({ version: 2, sessions: [row(notOffered)] }, roster)[0].level
  const base = told(undefined)
  assert.equal(told('narrowed'), base.replace(' · The level in force', ' · The saved level is no longer offered: this conversation was lowered to the narrowest level that is. · The level in force'))
  assert.match(told('kept'), /already ran no wider than the narrowest level that is, so it was left as it is\./)
  assert.match(told('unknown'), /cannot be compared with those that are: it was left as it is\./)
  assert.match(told('held'), /and the narrower level could not be set here\./)
  for (const other of ['gone', 'toString', '', 7, true, null, {}]) assert.equal(told(other), base, String(other))
})

test('every new line has its Chinese and its pt-BR text', () => {
  const ptBR = JSON.parse(readFileSync(join(plugin, '../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json'), 'utf8'))
  const zh = /const ZH = \{([\s\S]*?)\n\}\n/.exec(readFileSync(join(plugin, 'src/client/i18n.js'), 'utf8'))[1]
  const keys = [
    'Saved level: {level}. DeepSeek Harness no longer offers it.',
    'This conversation runs as {level} now.',
    EACH, SETTLE,
    'The saved level is no longer offered: this conversation was lowered to the narrowest level that is.',
    'The saved level is no longer offered: this conversation already ran no wider than the narrowest level that is, so it was left as it is.',
    'The saved level is no longer offered, and the level this conversation has cannot be compared with those that are: it was left as it is.',
    'The saved level is no longer offered, and the narrower level could not be set here.',
  ]
  for (const key of keys) {
    assert.equal(typeof ptBR[key], 'string', `pt-BR: ${key}`)
    assert.notEqual(ptBR[key], key)
    assert.equal(ptBR[key].includes('{level}'), key.includes('{level}'), key)
    const line = zh.split('\n').find(text => text.includes(JSON.stringify(key)))
    assert.ok(line, `zh: ${key}`)
    assert.equal(line.split(JSON.stringify(key))[1].includes('{level}'), key.includes('{level}'), key)
  }
})
