// Details and group surfaces explain Auto availability without writing permissions.
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
const BOT = { id: 'omni', name: 'Omni', sessionId: 'omni', model: 'deepseek/v3', permission: 'read-only' }
const teamOf = (indexRoster, { bot = BOT, catalog = THREE, rooms = [] } = {}) => ({
  ...indexRoster({ bots: [bot], rooms }), permissions: catalog, models: [{ ref: 'deepseek/v3', id: 'v3' }], exchangeTurns: {}, questions: {}, sideChats: {}, memory: false, prefs: {},
})
const panelProps = { useSessions: hook({ byId: {} }), useSessionStatus: hook(new Map()), useActivity: hook({}), useWork: hook({}), useBrowserTabs: hook({}), useBrowserPages: hook({}) }

const S3 = "Auto does not count in group chats. A member on Auto works here as Workspace, or at the group's shared level when one is set."
const R1 = "This Bot runs on its plugin's own engine, so Auto is not offered."
const R2 = "Auto needs a model chosen for this Bot."
const R3 = "Auto is not offered on Remote Hermes."
const R4 = "Auto is not offered for this Bot's model."
const R5 = "Auto is offered once this Bot's chat runs on the model saved for it."
const R6 = "On this model, Auto needs a background model, and no connected model can be one. Connect a model with an API key to turn it on."
const R7 = "Auto is not available for this Bot right now."
const REASONS = [R1, R2, R3, R4, R5, R6, R7]

test('Details explains a model not applied yet, offers no Auto and writes nothing', async (t) => {
  const { document, root, click, BotPanel, indexRoster } = mount(t)
  const { actions, writes } = recorder()
  await act(() => root.render(React.createElement(BotPanel, { pane: { id: 'omni', view: 'details' }, leaving: false, roster: teamOf(indexRoster), actions, ...panelProps })))
  const section = document.querySelector('.bt-drawer-permission')
  assert.ok(section)
  assert.ok(notes(section).includes(R5))
  await click(section.querySelector('.bt-model-trigger'))
  await until(() => document.querySelector('.bt-permission-menu'), 'permission menu')
  assert.equal(document.querySelector('[data-permission="workspace-write:auto"]'), null)
  assert.deepEqual(writes(), [])
})

test('Details offers Auto without a missing reason for an eligible Bot', async (t) => {
  const { document, root, click, BotPanel, indexRoster } = mount(t)
  const { actions, writes } = recorder()
  const bot = { ...BOT, model: 'acp-codex/x', appliedModel: 'acp-codex/x', autoOffered: true, autoJudge: { by: 'codex' }, permission: 'workspace-write' }
  await act(() => root.render(React.createElement(BotPanel, { pane: { id: 'omni', view: 'details' }, leaving: false, roster: teamOf(indexRoster, { bot }), actions, ...panelProps })))
  const section = document.querySelector('.bt-drawer-permission')
  assert.ok(section)
  assert.deepEqual(notes(section).filter(text => REASONS.includes(text)), [])
  await click(section.querySelector('.bt-model-trigger'))
  await until(() => document.querySelector('[data-permission="workspace-write:auto"]'), 'Auto choice')
  assert.deepEqual(writes(), [])
})

test('view-only Details has no missing Auto reason', async (t) => {
  const { document, root, BotPanel, indexRoster } = mount(t)
  const { actions, writes } = recorder()
  const roster = { ...teamOf(indexRoster), readOnly: true }
  await act(() => root.render(React.createElement(BotPanel, { pane: { id: 'omni', view: 'details' }, leaving: false, roster, actions, ...panelProps })))
  const section = document.querySelector('.bt-drawer-permission')
  assert.ok(section)
  assert.deepEqual(notes(section).filter(text => REASONS.includes(text)), [])
  assert.deepEqual(writes(), [])
})

for (const shared of [false, true]) {
  const room = { id: 'group', name: 'Team', members: ['omni'], ...(shared ? { permission: 'read-only' } : {}) }
  test('group Details explains Auto only alongside a shared level: shared=' + shared, async (t) => {
    const { document, root, BotPanel, indexRoster } = mount(t)
    const { actions, writes } = recorder()
    await act(() => root.render(React.createElement(BotPanel, { pane: { id: 'group', view: 'details' }, leaving: false, roster: teamOf(indexRoster, { rooms: [room] }), actions, ...panelProps })))
    assert.equal(notes(document).includes(S3), shared)
    assert.equal(document.body.textContent.includes(S3), shared)
    assert.deepEqual(writes(), [])
  })
  test('group settings explains Auto with either switch state and writes nothing: shared=' + shared, async (t) => {
    const { document, root, GroupSettingsForm, indexRoster } = mount(t)
    const { actions, writes } = recorder()
    const roster = teamOf(indexRoster, { rooms: [room] })
    await act(() => root.render(React.createElement(GroupSettingsForm, { room, roster, actions, run: promise => Promise.resolve(promise).then(() => true, () => false), onClose() {} })))
    assert.ok(notes(document).includes(S3))
    const section = document.querySelector('.bt-gs-perm')
    if (!shared) assert.equal(section, null)
    else {
      assert.deepEqual([...section.querySelectorAll('button[aria-pressed]')].map(node => node.textContent), ['Read only', 'Workspace', 'Full access'])
      assert.ok(!notes(section).includes(S3), 'the explanation sits outside the shared-level picker')
    }
    assert.deepEqual(writes(), [])
  })
}
