// The explained permission choice: the select in Details, the card in a Bot's chat and the lines
// under the segmented picker, rendered with the React DSH ships in jsdom. The options are the
// host catalog's, in its order: three in the common install, four while Auto review is offered.
// Only a press by the person saves a level, through actions.updateBot.
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
const tick = () => new Promise(resolve => setTimeout(resolve, 10))
const act = async (fn = () => {}) => { flushSync(fn); await tick() }
const { outputFiles } = await build({
  stdin: { contents: [
    "export { PermissionPicker, PermissionList, PermissionExplanations, presetText, autoQuestion } from './src/client/permission-picker.js'",
    "export { PermissionChoiceDock, reopenPermissionChoice } from './src/client/permission-card.js'",
    "export { ComposerPermission } from './src/client/composer.js'",
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
const AUTO = { value: 'auto', name: 'Auto review', description: 'dsh auto' }
const FULL = { value: 'danger-full-access', name: 'Full access', description: 'dsh full' }
// The owner's install: three levels, read-only by default.
const THREE = { options: [READ, WORK, FULL], defaultPreset: 'read-only' }
// While DSH's Auto review layer is loaded, in DSH's order.
const FOUR = { options: [READ, WORK, AUTO, FULL], defaultPreset: 'workspace-write' }
const TEXT = {
  'read-only': 'It cannot change files unless you allow that one action. It can still run commands and use the network and its other tools.',
  'workspace-write': 'Changes files inside its folder and a temporary folder without asking. For other files it asks you first. It can still run commands and use the network and its other tools.',
  auto: 'A model reviews each action first. You are asked only about the ones it stops. The rest run with full access, and it can let a wrong one through.',
  'danger-full-access': 'Runs commands and changes files anywhere without asking you. Choose it only when you trust what you asked for.',
}

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
  const click = async (node, init = {}) => { assert.ok(node, 'the control to press is on the page'); await act(() => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, ...init }))) }
  const key = async (name, init = {}) => {
    const event = new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init })
    await act(() => (window.document.activeElement ?? window.document.body).dispatchEvent(event))
    return event
  }
  return { window, document: window.document, root, click, key, ...module.exports }
}

// Saves through updateBot only; every other action a component reaches for does nothing.
function recorder({ fail, hold } = {}) {
  const saves = []
  const other = []
  // `hold` keeps each save open until the test settles it (`held`).
  const held = []
  const actions = new Proxy({
    setBotAuto: (...args) => { other.push(['setBotAuto', args]); return Promise.resolve() },
    updateBot: (id, patch) => {
      saves.push(JSON.parse(JSON.stringify({ id, patch })))
      if (hold) return new Promise((resolve) => { held.push(resolve) })
      return fail ? Promise.reject(new Error(fail)) : Promise.resolve({})
    },
  }, { get: (known, name) => known[name] ?? ((...args) => { other.push([name, args]); return Promise.resolve() }) })
  return { saves, other, held, actions }
}
const rows = scope => [...scope.querySelectorAll('.bt-q-list .bt-q-opt')]
const rowOf = (scope, value) => scope.querySelector(`.bt-q-opt[data-permission="${value}"]`)
const button = (scope, label) => [...scope.querySelectorAll('button')].find(node => node.textContent.trim() === label)
const hook = value => select => select(value)
const BOT = { id: 'omni', name: 'Omni', sessionId: 'omni', model: 'deepseek/v3' }
const REMOTE_BOT = { ...BOT, model: 'hermes-remote/sample:model', appliedModel: 'hermes-remote/sample:model' }
const ASK_REMOTE = 'Automagik asks you before answering each Hermes approval question.'
const FULL_REMOTE = 'Automagik still asks you before answering each Hermes approval question. Full access does not answer for you.'
const AUTO_REMOTE = `${ASK_REMOTE} Auto review does not review Hermes approval questions.`
const remoteWords = scope => {
  assert.match(scope.textContent, /Hermes.*approval question/)
  assert.match(scope.textContent, /other computer/)
  assert.doesNotMatch(scope.textContent, /DSH|A model reviews Hermes|model to review Hermes|Changes files inside its folder|It cannot change files unless|Runs commands and changes files anywhere/)
}
const remoteList = scope => {
  remoteWords(scope)
  assert.equal(scope.querySelectorAll('.bt-remote-permission-note').length, 1)
  assert.equal(rowOf(scope, 'read-only').querySelector('.bt-q-desc').textContent, ASK_REMOTE)
  assert.equal(rowOf(scope, 'workspace-write').querySelector('.bt-q-desc').textContent, ASK_REMOTE)
  assert.equal(rowOf(scope, 'auto').querySelector('.bt-q-desc').textContent, AUTO_REMOTE)
  assert.equal(rowOf(scope, 'danger-full-access').querySelector('.bt-q-desc').textContent, FULL_REMOTE)
  for (const row of rows(scope)) assert.doesNotMatch(row.textContent, /own rules|sandbox|Remote chats do not use/)
  assert.match(scope.querySelector('.bt-remote-permission-note').textContent, /differ only for files on this computer.*Remote chats do not use those files.*own rules.*sandbox/)
}
const teamOf = (indexRoster, { bot = BOT, catalog = THREE, readOnly, rooms = [] } = {}) => ({
  ...indexRoster({ bots: [bot], rooms }), permissions: catalog, models: [{ ref: 'deepseek/v3', id: 'v3' }], exchangeTurns: {}, questions: {}, sideChats: {}, memory: false, prefs: {},
  ...(readOnly ? { readOnly } : {}),
})

// --- the list (Details) ------------------------------------------------------------

for (const [label, catalog] of [['three', THREE], ['four', FOUR]]) {
  test(`the list shows exactly the ${label} levels the catalog offers, in its order, each explained`, async (t) => {
    const { document, root, PermissionList } = mount(t)
    await act(() => root.render(React.createElement(PermissionList, { catalog, saved: catalog.defaultPreset, onPick: async () => true })))
    assert.deepEqual(rows(document).map(row => row.dataset.permission), catalog.options.map(option => option.value))
    for (const option of catalog.options) {
      const row = rowOf(document, option.value)
      assert.equal(row.querySelector('.bt-q-label').firstChild.textContent, option.name)
      assert.equal(row.querySelector('.bt-q-desc').textContent, TEXT[option.value], 'our words, not the catalog description')
      assert.equal(row.getAttribute('aria-pressed'), String(option.value === catalog.defaultPreset))
      assert.equal(row.querySelector('.bt-q-check') !== null, option.value === catalog.defaultPreset, 'only the current level carries the check')
      const danger = option.value === 'danger-full-access'
      assert.equal(row.querySelector('.bt-q-label').classList.contains('bt-danger'), danger)
      assert.equal(row.querySelector('.bt-q-desc').classList.contains('bt-danger'), danger)
      assert.equal(row.querySelector('.bt-perm-exp') !== null, option.value === 'auto', 'only Auto review is marked experimental')
    }
    assert.equal(document.querySelector('.bt-key'), null, 'no letter keys')
  })
}

test('a level the app does not know shows its name and what the catalog says, or nothing', async (t) => {
  const { document, root, PermissionList, presetText } = mount(t)
  const catalog = { options: [READ, { value: 'team-custom', name: 'Careful', description: 'Asks about deploys.' }, { value: 'bare' }], defaultPreset: 'read-only' }
  await act(() => root.render(React.createElement(PermissionList, { catalog, saved: 'read-only', onPick: async () => true })))
  assert.equal(rowOf(document, 'team-custom').querySelector('.bt-q-label').textContent, 'Careful')
  assert.equal(rowOf(document, 'team-custom').querySelector('.bt-q-desc').textContent, 'Asks about deploys.')
  assert.equal(rowOf(document, 'bare').querySelector('.bt-q-label').textContent, 'bare')
  assert.equal(rowOf(document, 'bare').querySelector('.bt-q-desc'), null, 'no explanation is made up')
  assert.equal(presetText('bare', catalog), '')
  assert.equal(presetText('constructor', catalog), '', 'an inherited name is not a level')
})

test('a press on a row saves that level once; Full access asks first and Cancel sends nothing', async (t) => {
  const { document, root, click, PermissionList } = mount(t)
  const picks = []
  let saved = 'read-only'
  const render = () => root.render(React.createElement(PermissionList, { catalog: THREE, saved, onPick: async (value) => { picks.push(value); return true } }))
  await act(render)
  await click(rowOf(document, 'workspace-write'))
  assert.deepEqual(picks, ['workspace-write'])
  saved = 'workspace-write'
  await act(render)
  await click(rowOf(document, 'workspace-write'))
  assert.deepEqual(picks, ['workspace-write'], 'the level already saved is not sent again')

  await click(rowOf(document, 'danger-full-access'))
  assert.deepEqual(picks, ['workspace-write'], 'Full access is not sent by the first press')
  assert.equal(rowOf(document, 'danger-full-access').getAttribute('aria-pressed'), 'false', 'and is not shown as chosen')
  const confirm = document.querySelector('.bt-perm-confirm')
  assert.equal(confirm.getAttribute('role'), 'alert')
  assert.match(confirm.textContent, /Runs commands and changes files anywhere without asking you\./)
  assert.ok(confirm.querySelector('.bt-danger'), 'the warning is in the danger ink')
  await click(button(confirm, 'Cancel'))
  assert.equal(document.querySelector('.bt-perm-confirm'), null)
  assert.deepEqual(picks, ['workspace-write'])

  await click(rowOf(document, 'danger-full-access'))
  await click(button(document.querySelector('.bt-perm-confirm'), 'Give full access'))
  assert.deepEqual(picks, ['workspace-write', 'danger-full-access'])
  assert.equal(document.querySelector('.bt-perm-confirm'), null)
})

test('Auto review keeps its own question in the list', async (t) => {
  const { document, root, click, PermissionList } = mount(t)
  const picks = []
  await act(() => root.render(React.createElement(PermissionList, { catalog: FOUR, saved: 'workspace-write', onPick: async (value) => { picks.push(value); return true } })))
  await click(rowOf(document, 'auto'))
  assert.deepEqual(picks, [])
  assert.match(document.querySelector('.bt-perm-confirm').textContent, /Auto review runs tools without a sandbox/)
  await click(button(document, 'Use Auto review'))
  assert.deepEqual(picks, ['auto'])
})

test('a Bot with no level of its own: the default is marked and a press on it still saves it', async (t) => {
  const { document, root, click, PermissionList } = mount(t)
  const picks = []
  await act(() => root.render(React.createElement(PermissionList, { catalog: THREE, saved: 'read-only', repick: true, onPick: async (value) => { picks.push(value); return true } })))
  assert.equal(rowOf(document, 'read-only').getAttribute('aria-pressed'), 'true')
  await click(rowOf(document, 'read-only'))
  assert.deepEqual(picks, ['read-only'])
})

test('a list that is disabled has no live row and never saves', async (t) => {
  const { document, root, PermissionList, window } = mount(t)
  const picks = []
  await act(() => root.render(React.createElement(PermissionList, { catalog: FOUR, saved: 'workspace-write', disabled: true, onPick: async (value) => { picks.push(value); return true } })))
  assert.equal(rows(document).length, 4)
  for (const row of rows(document)) {
    assert.equal(row.disabled, true)
    row.click()
    row.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  }
  await act()
  assert.deepEqual(picks, [])
  assert.equal(document.querySelector('.bt-perm-confirm'), null)
})

// --- the segmented picker (Settings, group settings) ----------------------------------

test('the segmented picker is as it was unless asked to confirm Full access', async (t) => {
  const { document, root, click, PermissionPicker } = mount(t)
  const picks = []
  const onPick = async (value) => { picks.push(value); return true }
  await act(() => root.render(React.createElement(PermissionPicker, { catalog: THREE, saved: 'read-only', onPick })))
  await click(button(document, 'Full access'))
  assert.deepEqual(picks, ['danger-full-access'], 'without confirmFull the pick is sent at once, as before')
  await act(() => root.render(null))

  picks.length = 0
  await act(() => root.render(React.createElement(PermissionPicker, { key: 'asks', catalog: THREE, saved: 'read-only', confirmFull: true, onPick })))
  await click(button(document, 'Full access'))
  assert.deepEqual(picks, [])
  assert.equal(button(document, 'Full access').getAttribute('aria-pressed'), 'false')
  await click(button(document, 'Workspace'))
  assert.deepEqual(picks, ['workspace-write'], 'another pick goes as before')
  assert.equal(document.querySelector('.bt-perm-confirm'), null, 'and drops the open question')
  await click(button(document, 'Full access'))
  await click(button(document, 'Give full access'))
  assert.deepEqual(picks, ['workspace-write', 'danger-full-access'])
})

for (const [label, catalog] of [['three', THREE], ['four', FOUR]]) {
  test(`the lines under a segmented picker explain all ${label} levels`, async (t) => {
    const { document, root, PermissionExplanations } = mount(t)
    await act(() => root.render(React.createElement(PermissionExplanations, { catalog })))
    const lines = [...document.querySelectorAll('.bt-note')].map(line => line.textContent)
    assert.deepEqual(lines, catalog.options.map(option => `${option.name}: ${TEXT[option.value]}`))
    assert.equal(document.querySelectorAll('.bt-danger').length, 1)
    assert.equal(document.querySelector('.bt-danger').textContent, 'Full access')
    assert.equal(document.querySelector('button'), null, 'the lines are text only')
  })
}

test('a group\'s shared level asks before Full access and explains every level', async (t) => {
  const { document, root, click, GroupSettingsForm, indexRoster } = mount(t)
  const room = { id: 'group', name: 'Team', members: ['omni'], permission: 'read-only' }
  const roster = teamOf(indexRoster, { rooms: [room] })
  const { actions, other } = recorder()
  await act(() => root.render(React.createElement(GroupSettingsForm, { room, roster, actions, run: promise => Promise.resolve(promise).then(() => true, () => false), onClose() {} })))
  const section = document.querySelector('.bt-gs-perm')
  assert.ok(section, 'the group keeps its segmented picker')
  assert.equal([...section.querySelectorAll('.bt-note')].filter(line => Object.values(TEXT).some(text => line.textContent.endsWith(text))).length, 3)
  const sent = () => other.filter(([, args]) => args.some(arg => arg && typeof arg === 'object' && 'permission' in arg))
  await click(button(section, 'Full access'))
  assert.deepEqual(sent(), [], 'Full access for the whole group is asked about first')
  await click(button(section, 'Cancel'))
  assert.deepEqual(sent(), [])
})

// --- Details --------------------------------------------------------------------------

// `room` is the width the layout gives the panel and the conversation (overlays.js
// measures it); the window here is 1200 wide.
const panelProps = { room: 1200, useSessions: hook({ byId: {} }), useSessionStatus: hook(new Map()), useActivity: hook({}), useWork: hook({}), useBrowserTabs: hook({}), useBrowserPages: hook({}) }

function details(t, options = {}) {
  const page = mount(t)
  const calls = recorder(options)
  let roster = teamOf(page.indexRoster, options)
  const render = () => page.root.render(React.createElement(page.BotPanel, { pane: { id: 'omni', view: 'details' }, leaving: false, roster, actions: calls.actions, ...panelProps }))
  const setTeam = async (patch) => { roster = teamOf(page.indexRoster, { ...options, ...patch }); await act(render) }
  const section = () => page.document.querySelector('.bt-drawer-permission')
  const trigger = () => section().querySelector('.bt-model-trigger')
  const popup = () => page.document.querySelector('.bt-permission-menu:not([data-leaving])')
  const open = async () => { await page.click(trigger()); assert.ok(popup()); assert.equal(trigger().getAttribute('aria-expanded'), 'true'); return popup() }
  const closed = () => {
    assert.equal(trigger().getAttribute('aria-expanded'), 'false')
    assert.equal(popup(), null)
    assert.equal(page.document.activeElement, trigger())
  }
  return { ...page, ...calls, render, setTeam, section, trigger, popup, open, closed }
}

for (const [label, catalog] of [['three', THREE], ['four', FOUR]]) {
  test(`Details selects among ${label} explained levels and opens on the catalog default without saving`, async (t) => {
    const { document, render, section, trigger, open, saves } = details(t, { catalog })
    await act(render)
    assert.equal(section().querySelector('.bt-seg, .bt-q-opt'), null)
    assert.equal(button(section(), 'Choose in the chat').style.textDecoration, '', 'native Details keeps its existing appearance')
    assert.equal(trigger().getAttribute('aria-haspopup'), 'dialog')
    assert.equal(trigger().getAttribute('aria-expanded'), 'false')
    const current = catalog.options.find(option => option.value === catalog.defaultPreset)
    assert.equal(trigger().textContent, current.name)
    assert.equal(trigger().getAttribute('aria-label'), `Permissions: ${current.name}`)
    assert.equal(section().querySelector('.bt-note').textContent, TEXT[current.value])
    assert.equal(section().querySelector('.bt-danger'), null, 'Read only and Workspace have no danger ink while closed')
    const menu = await open()
    assert.equal(menu.parentElement, document.body, 'the menu is portalled outside Details')
    assert.equal(menu.getAttribute('role'), 'dialog')
    assert.equal(menu.getAttribute('aria-label'), 'Permissions')
    assert.deepEqual(rows(menu).map(row => row.dataset.permission), catalog.options.map(option => option.value))
    assert.deepEqual(rows(menu).map(row => row.querySelector('.bt-q-desc').textContent), catalog.options.map(option => TEXT[option.value]))
    assert.deepEqual(rows(menu).map(row => row.getAttribute('aria-pressed')), catalog.options.map(option => String(option.value === current.value)))
    assert.equal(document.activeElement, menu, 'a Bot without its own level opens on the popup')
    assert.deepEqual(saves, [], 'opening Details and its menu saves nothing')
  })
}

test('Details shows Full access and its own explanation in danger ink while closed', async (t) => {
  const { render, section, trigger, saves } = details(t, { bot: { ...BOT, permission: 'danger-full-access' } })
  await act(render)
  assert.equal(trigger().querySelector('.bt-model-name.bt-danger').textContent, 'Full access')
  assert.equal(section().querySelector('.bt-note > .bt-danger').textContent, TEXT['danger-full-access'])
  assert.equal(section().querySelector('.bt-q-opt, .bt-seg'), null)
  assert.deepEqual(saves, [])
})

test('Details shows a pick before the save resolves and queues a second pick across reopening', async (t) => {
  const { render, click, open, popup, closed, trigger, saves, held, setTeam } = details(t, { hold: true, bot: { ...BOT, permission: 'read-only' } })
  await act(render)
  await click(rowOf(await open(), 'workspace-write'))
  closed()
  assert.equal(trigger().textContent, 'Workspace', 'the optimistic pick survives closing the menu')
  assert.deepEqual(saves, [{ id: 'omni', patch: { permission: 'workspace-write' } }])
  await click(rowOf(await open(), 'danger-full-access'))
  assert.equal(saves.length, 1)
  await click(button(popup(), 'Give full access'))
  closed()
  assert.equal(trigger().textContent, 'Full access')
  assert.equal(saves.length, 1, 'the second save waits for the first')
  held[0]({})
  await setTeam({ bot: { ...BOT, permission: 'workspace-write' } })
  assert.deepEqual(saves, [{ id: 'omni', patch: { permission: 'workspace-write' } }, { id: 'omni', patch: { permission: 'danger-full-access' } }])
  assert.equal(trigger().textContent, 'Full access', 'the first reply cannot replace the later pick')
  held[1]({})
  await setTeam({ bot: { ...BOT, permission: 'danger-full-access' } })
  assert.equal(saves.length, 2)
})

for (const [value, confirm, warning] of [
  ['danger-full-access', 'Give full access', /Give Omni full access\? Omni will run commands and change files anywhere without asking you first\./],
  ['auto', 'Use Auto review', /Auto review runs tools without a sandbox/],
]) {
  test(`Details asks once for ${value} inside the popup; Cancel saves nothing`, async (t) => {
    const { document, render, click, open, popup, closed, saves } = details(t, { catalog: FOUR })
    await act(render)
    await click(rowOf(await open(), value))
    assert.match(popup().querySelector('.bt-perm-confirm').textContent, warning)
    assert.notEqual(document.activeElement, button(popup(), confirm), 'focus never moves itself to the answer')
    assert.deepEqual(saves, [])
    await click(button(popup(), 'Cancel'))
    assert.equal(document.activeElement, rowOf(popup(), value))
    assert.equal(popup().querySelector('.bt-perm-confirm'), null)
    assert.deepEqual(saves, [])
    await click(rowOf(popup(), value))
    await click(button(popup(), confirm), { detail: 2 })
    assert.deepEqual(saves, [], 'a double click cannot answer the question')
    assert.ok(popup().querySelector('.bt-perm-confirm'))
    await click(button(popup(), confirm))
    closed()
    assert.deepEqual(saves, [{ id: 'omni', patch: { permission: value } }])
  })
}

test('Details ignores the second click on a row after Cancel, then saves a single click once', async (t) => {
  const catalog = { ...THREE, options: [READ, FULL, WORK] }
  const { render, click, open, popup, closed, saves } = details(t, { catalog })
  await act(render)
  await click(rowOf(await open(), 'danger-full-access'))
  await click(button(popup(), 'Cancel'))
  assert.equal(popup().querySelector('.bt-perm-confirm'), null)
  const row = rowOf(popup(), 'workspace-write')
  await click(row.querySelector('.bt-q-label'), { detail: 2 })
  assert.deepEqual(saves, [])
  assert.ok(popup())
  await click(row)
  closed()
  assert.deepEqual(saves, [{ id: 'omni', patch: { permission: 'workspace-write' } }])
})

for (const own of [false, true]) {
  test(`Details pressing the current level ${own ? 'saves nothing' : 'saves the default as the Bot\'s own level'}`, async (t) => {
    const { render, click, open, closed, saves } = details(t, { bot: { ...BOT, permission: own ? 'read-only' : undefined } })
    await act(render)
    await click(rowOf(await open(), 'read-only'))
    closed()
    assert.deepEqual(saves, own ? [] : [{ id: 'omni', patch: { permission: 'read-only' } }])
  })
}

test('Details falls back to the saved level and shows the error when updateBot rejects', async (t) => {
  const { document, render, click, open, closed, trigger, section, saves } = details(t, { bot: { ...BOT, permission: 'read-only' }, fail: 'Only the user can do that' })
  await act(render)
  await click(rowOf(await open(), 'workspace-write'))
  await act()
  closed()
  assert.equal(trigger().textContent, 'Read only')
  assert.equal(section().querySelector('.bt-note').textContent, TEXT['read-only'])
  assert.equal(document.querySelector('.bt-drawer-body .bt-error[role="alert"]').textContent, 'Only the user can do that')
  assert.equal(saves.length, 1)
})

for (const dismiss of ['Escape', 'outside', 'scroll']) {
  test(`Details drops its unanswered question on ${dismiss}`, async (t) => {
    const { window, document, render, click, key, open, popup, trigger, saves, other } = details(t)
    await act(render)
    await click(rowOf(await open(), 'danger-full-access'))
    assert.ok(popup().querySelector('.bt-perm-confirm'))
    if (dismiss === 'Escape') await key('Escape')
    else await act(() => document.body.dispatchEvent(new window.Event(dismiss === 'outside' ? 'mousedown' : 'scroll', { bubbles: true })))
    assert.equal(popup(), null)
    assert.equal(document.activeElement, trigger())
    assert.equal(other.some(([name]) => name === 'closeOverlay'), false, 'Details stays open')
    assert.equal((await open()).querySelector('.bt-perm-confirm'), null)
    assert.deepEqual(saves, [])
  })
}

test('Details in a view-only window opens explained disabled rows with focus on the popup', async (t) => {
  const { document, render, click, key, open, popup, closed, trigger, section, saves } = details(t, { catalog: FOUR, readOnly: 'This window can only view the team' })
  await act(render)
  assert.equal(trigger().disabled, false)
  assert.deepEqual([...section().querySelectorAll('button:not(:disabled)')], [trigger()])
  const menu = await open()
  assert.equal(menu.tabIndex, -1)
  assert.equal(document.activeElement, menu)
  assert.deepEqual(rows(menu).map(row => row.querySelector('.bt-q-desc').textContent), FOUR.options.map(option => TEXT[option.value]))
  assert.ok(rows(menu).every(row => row.disabled))
  for (const row of rows(menu)) await click(row)
  assert.equal(popup().querySelector('.bt-perm-confirm'), null)
  assert.deepEqual(saves, [])
  await key('Escape')
  closed()
})

test('Details becoming view-only drops the question and disables every row', async (t) => {
  const { document, render, click, open, popup, setTeam, saves } = details(t)
  await act(render)
  await click(rowOf(await open(), 'danger-full-access'))
  assert.ok(popup().querySelector('.bt-perm-confirm'))
  button(popup(), 'Cancel').focus()
  await setTeam({ readOnly: 'This window can only view the team' })
  assert.equal(document.activeElement, popup())
  assert.equal(popup().querySelector('.bt-perm-confirm'), null)
  assert.ok(rows(popup()).every(row => row.disabled))
  await setTeam({ readOnly: undefined })
  assert.equal(popup().querySelector('.bt-perm-confirm'), null, 'the question was dropped, not just hidden')
  assert.deepEqual(saves, [])
})

test('the list ignores a double click on Give full access, then saves a single answer once', async (t) => {
  const { document, root, click, PermissionList } = mount(t)
  const picks = []
  await act(() => root.render(React.createElement(PermissionList, { catalog: THREE, saved: 'read-only', onPick: async value => { picks.push(value); return true } })))
  await click(rowOf(document, 'danger-full-access'))
  await click(button(document, 'Give full access'), { detail: 2 })
  assert.deepEqual(picks, [])
  assert.ok(document.querySelector('.bt-perm-confirm'))
  await click(button(document, 'Give full access'))
  assert.deepEqual(picks, ['danger-full-access'])
})

for (const permission of ['read-only', 'danger-full-access', 'no-longer-offered']) {
  test(`Details opening with saved ${permission} focuses only a row that cannot save`, async (t) => {
    const { document, render, open, key, saves } = details(t, { bot: { ...BOT, permission } })
    await act(render)
    const menu = await open()
    assert.equal(document.activeElement, rowOf(menu, permission) ?? menu)
    await key('Enter')
    await key('Enter', { repeat: true })
    assert.deepEqual(saves, [])
  })
}

test('Details pressing Full access already in force closes without a question or save', async (t) => {
  const { render, open, click, closed, saves } = details(t, { bot: { ...BOT, permission: 'danger-full-access' } })
  await act(render)
  await click(rowOf(await open(), 'danger-full-access'))
  closed()
  assert.equal((await open()).querySelector('.bt-perm-confirm'), null)
  assert.deepEqual(saves, [])
})

for (const missing of [false, true]) {
  test(`Details Cancel focuses the popup when the asking row is ${missing ? 'gone' : 'disabled'}`, async (t) => {
    const { document, render, open, click, popup, setTeam, saves } = details(t, { catalog: FOUR })
    await act(render)
    await click(rowOf(await open(), 'danger-full-access'))
    if (missing) await setTeam({ catalog: { ...FOUR, options: [READ, WORK, AUTO] } })
    else rowOf(popup(), 'danger-full-access').disabled = true
    button(popup(), 'Cancel').focus()
    await click(button(popup(), 'Cancel'))
    assert.equal(document.activeElement, popup())
    assert.deepEqual(saves, [])
  })
}

test('Details focuses the popup when the focused row leaves the catalog without taking focus elsewhere', async (t) => {
  const { document, render, open, popup, setTeam, trigger, saves } = details(t, { catalog: FOUR })
  await act(render)
  rowOf(await open(), 'auto').focus()
  assert.equal(document.activeElement, rowOf(popup(), 'auto'))
  await setTeam({ catalog: THREE })
  assert.equal(rowOf(popup(), 'auto'), null)
  assert.equal(document.activeElement, popup())
  rowOf(popup(), 'workspace-write').focus()
  await setTeam({ catalog: FOUR })
  assert.equal(document.activeElement, rowOf(popup(), 'workspace-write'))
  trigger().focus()
  await setTeam({ catalog: THREE })
  assert.equal(document.activeElement, trigger())
  assert.deepEqual(saves, [])
})

test('Details outside scroll restores focus without scrolling the trigger', async (t) => {
  const { window, document, render, open, trigger, popup, saves } = details(t)
  await act(render)
  const menu = await open()
  rowOf(menu, 'workspace-write').focus()
  const calls = []
  const focus = trigger().focus.bind(trigger())
  trigger().focus = options => { calls.push(options?.preventScroll); focus(options) }
  await act(() => document.body.dispatchEvent(new window.Event('scroll', { bubbles: true })))
  assert.equal(popup(), null)
  assert.equal(document.activeElement, trigger())
  assert.deepEqual(calls, [true])
  assert.deepEqual(saves, [])
})

test('Details Tab wraps through enabled rows and question buttons, or stays on an empty popup', async (t) => {
  const { document, render, open, click, key, popup, setTeam, saves } = details(t)
  await act(render)
  const menu = await open()
  const first = rowOf(menu, 'read-only')
  const last = rowOf(menu, 'danger-full-access')
  rowOf(menu, 'workspace-write').focus()
  assert.equal((await key('Tab')).defaultPrevented, false)
  last.focus()
  assert.equal((await key('Tab')).defaultPrevented, true)
  assert.equal(document.activeElement, first)
  assert.equal((await key('Tab', { shiftKey: true })).defaultPrevented, true)
  assert.equal(document.activeElement, last)
  menu.focus()
  assert.equal((await key('Tab', { shiftKey: true })).defaultPrevented, true)
  assert.equal(document.activeElement, last)
  await click(last)
  const answerButtons = [...popup().querySelectorAll('.bt-perm-confirm button')]
  answerButtons.at(-1).focus()
  assert.equal((await key('Tab')).defaultPrevented, true)
  assert.equal(document.activeElement, first)
  assert.equal((await key('Tab', { shiftKey: true })).defaultPrevented, true)
  assert.equal(document.activeElement, answerButtons.at(-1))
  await setTeam({ readOnly: 'This window can only view the team' })
  for (const shiftKey of [false, true]) {
    assert.equal((await key('Tab', { shiftKey })).defaultPrevented, true)
    assert.equal(document.activeElement, popup())
  }
  assert.deepEqual(saves, [])
})

test('Details on Claude Code explains Full access in the note, row and question', async (t) => {
  const bot = { ...BOT, model: 'acp-claude/opus', appliedModel: 'acp-claude/opus', permission: 'danger-full-access' }
  const text = 'Claude Code decides by itself and runs commands and changes files anywhere without asking you. Automagik asks it for its own "bypass permissions" mode, and does not review or ask. This holds while the Bot runs on Claude Code.'
  const { render, section, open, click, popup, setTeam, saves } = details(t, { bot })
  await act(render)
  assert.equal(section().querySelector('.bt-note > .bt-danger').textContent, text)
  await setTeam({ bot: { ...bot, permission: 'read-only' } })
  const row = rowOf(await open(), 'danger-full-access')
  assert.equal(row.querySelector('.bt-q-desc').textContent, text)
  await click(row)
  assert.match(popup().querySelector('.bt-perm-confirm').textContent, /Claude Code will decide by itself and run without asking you\. Automagik will ask it for its own "bypass permissions" mode, and will not review or ask\. This holds while the Bot runs on Claude Code\./)
  assert.ok(button(popup(), 'Give full access'))
  assert.deepEqual(saves, [])
})

test('a group\'s level in Details carries its explanation', async (t) => {
  const { document, root, BotPanel, indexRoster } = mount(t)
  const room = { id: 'group', name: 'Team', members: ['omni'], permission: 'danger-full-access' }
  const { actions } = recorder()
  await act(() => root.render(React.createElement(BotPanel, { pane: { id: 'group', view: 'details' }, leaving: false, roster: teamOf(indexRoster, { rooms: [room] }), actions, ...panelProps })))
  assert.ok([...document.querySelectorAll('.bt-note')].some(line => line.textContent === TEXT['danger-full-access']))
})

// --- the card in the chat ---------------------------------------------------------------

const card = document => document.querySelector('form.bt-q')
function dock(t, options = {}) {
  const page = mount(t)
  const calls = recorder(options)
  let roster = teamOf(page.indexRoster, options)
  const render = () => page.root.render(React.createElement(page.PermissionChoiceDock, { sessionId: options.sessionId ?? 'omni', useRoster: select => select(roster), actions: calls.actions }))
  const setBot = async (bot) => { roster = teamOf(page.indexRoster, { ...options, bot }); await act(render) }
  const setTeam = async (patch) => { roster = { ...teamOf(page.indexRoster, { ...options, ...patch }), ...(patch.extra ?? {}) }; await act(render) }
  return { ...page, ...calls, render, setBot, setTeam }
}

for (const [label, catalog] of [['three', THREE], ['four', FOUR]]) {
  test(`the card lists the ${label} levels of the catalog with every explanation at once`, async (t) => {
    const { document, render, saves, other } = dock(t, { catalog })
    await act(render)
    const form = card(document)
    assert.ok(form, 'a Bot with no level chosen gets the card')
    assert.equal(form.querySelector('.bt-q-title').textContent, 'Permissions · What may Omni do on its own?')
    assert.equal(form.querySelector('.bt-q-detail').textContent, 'You choose. Nothing changes until you save.')
    assert.deepEqual(rows(form).map(row => row.dataset.permission), catalog.options.map(option => option.value))
    assert.deepEqual(rows(form).map(row => row.querySelector('.bt-q-desc').textContent), catalog.options.map(option => TEXT[option.value]))
    assert.equal(rowOf(form, catalog.defaultPreset).getAttribute('aria-pressed'), 'true', 'the level in force is the one marked')
    assert.equal(form.querySelectorAll('.bt-q-opt[aria-pressed="true"]').length, 1)
    assert.ok(rowOf(form, 'danger-full-access').querySelector('.bt-q-desc.bt-danger'))
    assert.match(form.textContent, /You can change this any time in Details\./)
    assert.ok(button(form, 'Not now') && button(form, 'Save'))
    assert.deepEqual(saves, [], 'showing the card saves nothing')
    assert.deepEqual(other, [], 'and calls nothing else')
  })
}

test('picking a row only marks it; Save sends that level once', async (t) => {
  const { document, render, click, saves, setBot } = dock(t)
  await act(render)
  await click(rowOf(document, 'workspace-write'))
  assert.equal(rowOf(document, 'workspace-write').getAttribute('aria-pressed'), 'true')
  assert.deepEqual(saves, [], 'a marked row is not a saved level')
  await click(button(card(document), 'Save'))
  assert.deepEqual(saves, [{ id: 'omni', patch: { permission: 'workspace-write' } }])
  await setBot({ ...BOT, permission: 'workspace-write' })
  assert.equal(card(document), null, 'the card leaves once the level is saved')
})

test('Save with nothing picked keeps the level in force, never a wider one', async (t) => {
  const { document, render, click, saves } = dock(t)
  await act(render)
  await click(button(card(document), 'Save'))
  assert.deepEqual(saves, [{ id: 'omni', patch: { permission: 'read-only' } }])
})

test('Not now and Dismiss send nothing and the card does not come back on its own', async (t) => {
  for (const label of ['Not now', 'Dismiss']) {
    const { document, render, click, saves, other, window, STORAGE } = dock(t)
    await act(render)
    await click(rowOf(document, 'danger-full-access'))
    await click(label === 'Dismiss' ? card(document).querySelector('.bt-q-x') : button(card(document), label))
    assert.equal(card(document), null)
    assert.deepEqual(saves, [], `${label} saves no level, even with Full access marked`)
    assert.deepEqual(other, [])
    assert.deepEqual(JSON.parse(window.localStorage.getItem(STORAGE.permissionAsked)), { omni: true })
    await act(render)
    assert.equal(card(document), null)
  }
})

test('Full access from the card asks once more, and a double click on Save cannot answer it', async (t) => {
  const { document, render, click, saves } = dock(t)
  await act(render)
  await click(rowOf(document, 'danger-full-access'))
  await click(button(card(document), 'Save'))
  assert.deepEqual(saves, [], 'Save does not send Full access')
  const form = card(document)
  assert.equal(form.getAttribute('role'), 'alert')
  assert.equal(form.querySelector('.bt-q-title').textContent, 'Give Omni full access?')
  assert.equal(form.querySelector('.bt-q-detail .bt-danger').textContent, 'Omni will run commands and change files anywhere without asking you first.')
  assert.match(form.textContent, /Choose it only when you trust what you asked for\./)
  await click(button(form, 'Give full access'), { detail: 2 })
  assert.deepEqual(saves, [], 'the second press of a double click is not an answer')
  await click(button(form, 'Cancel'))
  assert.deepEqual(saves, [])
  assert.equal(rowOf(document, 'danger-full-access').getAttribute('aria-pressed'), 'true', 'back on the list, the row is still only marked')
  await click(button(card(document), 'Save'))
  await click(button(card(document), 'Give full access'))
  assert.deepEqual(saves, [{ id: 'omni', patch: { permission: 'danger-full-access' } }])
})

test('Auto review from the card asks with its own warning', async (t) => {
  const { document, render, click, saves } = dock(t, { catalog: FOUR })
  await act(render)
  await click(rowOf(document, 'auto'))
  await click(button(card(document), 'Save'))
  assert.deepEqual(saves, [])
  assert.match(card(document).textContent, /Auto review runs tools without a sandbox/)
  await click(button(card(document), 'Use Auto review'))
  assert.deepEqual(saves, [{ id: 'omni', patch: { permission: 'auto' } }])
})

test('keys and time never answer the card', async (t) => {
  const { document, render, key, saves, other, window } = dock(t, { catalog: FOUR })
  await act(render)
  for (const name of ['a', 'b', 'c', 'd', 'A', 'D', '1', '4', 'Enter', ' ', 'Escape', 'y']) await key(name)
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(rowOf(document, 'workspace-write').getAttribute('aria-pressed'), 'true', 'the mark did not move')
  assert.ok(card(document), 'the card is still there')
  assert.deepEqual(saves, [])
  assert.deepEqual(other, [])
  assert.equal(window.localStorage.length, 0)
})

test('a refused save says why, keeps the card and sends nothing more', async (t) => {
  const { document, render, click, saves } = dock(t, { fail: 'Only the user can do that' })
  await act(render)
  await click(rowOf(document, 'workspace-write'))
  await click(button(card(document), 'Save'))
  assert.equal(saves.length, 1)
  assert.equal(card(document).querySelector('[role="alert"]').textContent, 'Only the user can do that')
  assert.equal(rowOf(document, 'workspace-write').getAttribute('aria-pressed'), 'true')
})

test('no card: a level already chosen, a view-only window, no catalog, no model, an earlier part, a group', async (t) => {
  const cases = {
    'a Bot with its own level': { bot: { ...BOT, permission: 'workspace-write' } },
    'a window that can only view the team': { readOnly: 'This window can only view the team' },
    'a DSH with no presets': { catalog: null },
    'an empty catalog': { catalog: { options: [] } },
    'a Bot still waiting for its model': { bot: { id: 'omni', name: 'Omni', sessionId: 'omni' } },
    'an earlier part of the chat': { bot: { ...BOT, sessionId: 'part-2', parts: ['omni', 'part-2'] } },
    'a Session that is no Bot chat': { sessionId: 'group-session' },
  }
  for (const [label, options] of Object.entries(cases)) {
    const { document, render, saves } = dock(t, options)
    await act(render)
    assert.equal(card(document), null, label)
    assert.deepEqual(saves, [], label)
  }
})

test('Details opens the card again, for a Bot that already has a level too; closing it changes nothing', async (t) => {
  const { document, render, click, saves, reopenPermissionChoice } = dock(t, { bot: { ...BOT, permission: 'workspace-write' }, catalog: FOUR })
  await act(render)
  assert.equal(card(document), null)
  await act(() => reopenPermissionChoice('omni'))
  assert.equal(rowOf(card(document), 'workspace-write').getAttribute('aria-pressed'), 'true', 'the saved level is the one marked')
  await click(button(card(document), 'Not now'))
  assert.equal(card(document), null)
  assert.deepEqual(saves, [])
  await act(() => reopenPermissionChoice('omni'))
  await click(rowOf(card(document), 'read-only'))
  await click(button(card(document), 'Save'))
  assert.deepEqual(saves, [{ id: 'omni', patch: { permission: 'read-only' } }])
  assert.equal(card(document), null)
})

test('a view-only window shows no card even when it was opened again', async (t) => {
  const { document, render, reopenPermissionChoice } = dock(t, { readOnly: 'This window can only view the team' })
  await act(() => reopenPermissionChoice('omni'))
  await act(render)
  assert.equal(card(document), null)
})

test('the mark follows a level saved elsewhere until the person picks one', async (t) => {
  const { document, render, click, setBot, reopenPermissionChoice } = dock(t, { bot: { ...BOT, permission: 'workspace-write' } })
  await act(() => reopenPermissionChoice('omni'))
  await act(render)
  await setBot({ ...BOT, permission: 'read-only' })
  assert.equal(rowOf(card(document), 'read-only').getAttribute('aria-pressed'), 'true')
  await click(rowOf(card(document), 'workspace-write'))
  await setBot({ ...BOT, permission: 'danger-full-access' })
  assert.equal(rowOf(card(document), 'workspace-write').getAttribute('aria-pressed'), 'true', 'the person\'s own pick is kept')
})

test('Save with nothing picked on a Bot that has a level sends nothing, so a level narrowed elsewhere stays', async (t) => {
  const { document, render, click, saves, setBot, reopenPermissionChoice } = dock(t, { bot: { ...BOT, permission: 'danger-full-access' } })
  await act(() => reopenPermissionChoice('omni'))
  await act(render)
  await setBot({ ...BOT, permission: 'read-only' })
  await click(button(card(document), 'Save'))
  assert.deepEqual(saves, [], 'neither the old wider level nor a repeat of the saved one is sent')
  assert.equal(card(document), null)
})

test('a second Save while the first is still open sends nothing more', async (t) => {
  const { document, render, click, saves, held } = dock(t, { hold: true })
  await act(render)
  await click(rowOf(document, 'workspace-write'))
  const save = button(card(document), 'Save')
  await click(save)
  assert.equal(save.disabled, true, 'Save waits for the answer')
  await click(save)
  card(document).dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }))
  await act()
  assert.deepEqual(saves, [{ id: 'omni', patch: { permission: 'workspace-write' } }])
  held[0]({})
  await act()
})

test('the question in the card ends when DSH stops offering the level it asked about', async (t) => {
  const { document, render, click, saves, setTeam } = dock(t, { catalog: FOUR })
  await act(render)
  await click(rowOf(document, 'auto'))
  await click(button(card(document), 'Save'))
  assert.ok(button(card(document), 'Use Auto review'))
  await setTeam({ catalog: THREE })
  assert.equal(button(card(document), 'Use Auto review'), undefined, 'no button is left to give a level that is gone')
  assert.deepEqual(rows(card(document)).map(row => row.dataset.permission), ['read-only', 'workspace-write', 'danger-full-access'])
  assert.equal(button(card(document), 'Save').disabled, true, 'nothing offered is marked, so there is nothing to save')
  await click(button(card(document), 'Save'))
  assert.deepEqual(saves, [])
})

test('the question in the card is for one level: marking another row drops it', async (t) => {
  const { document, render, click, saves, setBot, reopenPermissionChoice } = dock(t, { bot: { ...BOT, permission: 'read-only' }, catalog: FOUR })
  await act(() => reopenPermissionChoice('omni'))
  await act(render)
  await click(rowOf(document, 'danger-full-access'))
  await click(button(card(document), 'Save'))
  assert.ok(button(card(document), 'Give full access'))
  await setBot({ ...BOT, permission: 'workspace-write' })
  assert.ok(button(card(document), 'Give full access'), 'the person\'s own pick is still the one asked about')
  await click(button(card(document), 'Cancel'))
  await click(rowOf(document, 'auto'))
  assert.equal(button(card(document), 'Give full access'), undefined)
  assert.equal(button(card(document), 'Use Auto review'), undefined, 'a newly marked level is asked about only after Save')
  assert.deepEqual(saves, [])
})

test('the question in the card puts focus on Cancel, never on the button that gives access', async (t) => {
  const { document, render, click } = dock(t)
  await act(render)
  await click(rowOf(document, 'danger-full-access'))
  await click(button(card(document), 'Save'))
  assert.equal(document.activeElement, button(card(document), 'Cancel'))
})

test('a Bot whose plugin runs its own engine gets no card', async (t) => {
  const { document, render, setTeam, saves } = dock(t)
  await setTeam({ extra: { hostModels: { omni: { id: 'own' } } } })
  assert.equal(card(document), null)
  assert.deepEqual(saves, [])
  await act(render)
})

test('in the list, Full access confirmed while another save is open waits its turn and is sent once', async (t) => {
  const { document, root, click, PermissionList } = mount(t)
  const open = []
  let saved = 'read-only'
  const render = () => root.render(React.createElement(PermissionList, { catalog: THREE, saved, onPick: value => new Promise((resolve) => { open.push({ value, resolve }) }) }))
  await act(render)
  await click(rowOf(document, 'workspace-write'))
  await click(rowOf(document, 'danger-full-access'))
  assert.deepEqual(open.map(entry => entry.value), ['workspace-write'], 'the unanswered question queues nothing')
  await click(button(document, 'Give full access'))
  assert.deepEqual(open.map(entry => entry.value), ['workspace-write'], 'one save at a time')
  open[0].resolve(true)
  saved = 'workspace-write'
  await act(render)
  assert.deepEqual(open.map(entry => entry.value), ['workspace-write', 'danger-full-access'])
  open[1].resolve(true)
  saved = 'danger-full-access'
  await act(render)
  assert.equal(open.length, 2)
  assert.equal(rowOf(document, 'danger-full-access').getAttribute('aria-pressed'), 'true')
})

test('Remote Hermes chat levels and both confirmations describe remote approvals, preserving explicit saves', async t => {
  const { document, render, click, saves } = dock(t, { bot: REMOTE_BOT, catalog: FOUR })
  await act(render)
  remoteList(card(document))
  await click(rowOf(document, 'danger-full-access'))
  await click(button(card(document), 'Save'))
  remoteWords(card(document))
  assert.match(card(document).textContent, /still asks you before answering each Hermes approval question\. Full access does not answer for you/)
  assert.deepEqual(saves, [])
  await click(button(card(document), 'Cancel'))
  await click(rowOf(document, 'auto'))
  await click(button(card(document), 'Save'))
  remoteWords(card(document))
  assert.match(card(document).textContent, /Auto review does not review Hermes approval questions/ )
  assert.match(card(document).textContent, /asks you before answering each/ )
  await click(button(card(document), 'Use Auto review'))
  assert.deepEqual(saves, [{ id: BOT.id, patch: { permission: 'auto' } }])
})

test('Remote Hermes Details explains remote limits and its full-access confirmation without local file promises', async t => {
  const { document, render, section, open, popup, click, saves } = details(t, { bot: { ...REMOTE_BOT, permission: 'workspace-write' }, catalog: FOUR })
  await act(render)
  remoteWords(section())
  assert.equal(section().querySelector('.bt-note').textContent, ASK_REMOTE)
  assert.equal(section().querySelectorAll('.bt-remote-permission-note').length, 1)
  await open()
  remoteList(popup())
  assert.equal(section().querySelectorAll('.bt-remote-permission-note').length, 0, 'the open dropdown owns the shared warning')
  assert.equal(document.querySelectorAll('.bt-remote-permission-note').length, 1)
  await click(rowOf(popup(), 'danger-full-access'))
  remoteWords(popup())
  assert.match(popup().textContent, /still asks you before answering each Hermes approval question\. Full access does not answer for you/)
  await click(button(popup(), 'Give full access'))
  assert.deepEqual(saves, [{ id: BOT.id, patch: { permission: 'danger-full-access' } }])
  assert.equal(document.querySelectorAll('.bt-perm-confirm').length, 0)
})

test('Remote Hermes composer levels use the remote explanation for known and custom restrictive levels', async t => {
  const { document, root, click, ComposerPermission, indexRoster } = mount(t)
  const catalog = { ...FOUR, options: [...FOUR.options, { value: 'no-ask-custom', name: 'Careful', description: 'Changes files inside its folder.' }] }
  const roster = teamOf(indexRoster, { bot: REMOTE_BOT, catalog })
  const { actions, saves } = recorder()
  await act(() => root.render(React.createElement(ComposerPermission, { sessionId: BOT.id, useRoster: hook(roster), actions })))
  await click(document.querySelector('.bt-perm-chip'))
  remoteWords(document.querySelector('.bt-permission-menu'))
  remoteList(document.querySelector('.bt-permission-menu'))
  assert.match(rowOf(document, 'no-ask-custom').textContent, /asks you before answering each Hermes approval question/)
  assert.doesNotMatch(document.querySelector('.bt-permission-menu').textContent, /answers yes|according to this level/)
  assert.deepEqual(saves, [])
})


for (const [direction, bot] of [
  ['away from Remote Hermes', { ...REMOTE_BOT, model: BOT.model }],
  ['toward Remote Hermes', { ...REMOTE_BOT, appliedModel: BOT.model }],
]) {
  test(`permission card during a handoff ${direction} explains both routes before confirming Full access`, async t => {
    const { document, render, click, saves } = dock(t, { bot, catalog: FOUR })
    await act(render)
    remoteWords(card(document))
    assert.equal(card(document).querySelectorAll('.bt-remote-permission-note').length, 1)
    assert.doesNotMatch(card(document).textContent, /Remote chats do not use those files/)
    assert.match(card(document).textContent, /On a local route, this level’s file rules apply/)
    assert.match(card(document).textContent, /changes routes|changing routes/)
    await click(rowOf(document, 'danger-full-access'))
    await click(button(card(document), 'Save'))
    remoteWords(card(document))
    assert.match(card(document).textContent, /still asks you before answering each Hermes approval question\. A local route runs commands and changes files without asking/)
    assert.match(card(document).textContent, /still asks you before answering each Hermes approval question/)
    await click(button(card(document), 'Cancel'))
    await click(rowOf(document, 'auto'))
    await click(button(card(document), 'Save'))
    remoteWords(card(document))
    assert.match(card(document).textContent, /On a local route, a model reviews each action first/)
    assert.match(card(document).textContent, /Auto review does not review Hermes approval questions/)
    assert.deepEqual(saves, [])
  })

  test(`Details during a handoff ${direction} retains the remote warning and conditional confirmation`, async t => {
    const { render, section, open, popup, click, saves } = details(t, { bot: { ...bot, permission: 'workspace-write' }, catalog: FOUR })
    await act(render)
    remoteWords(section())
    assert.equal(button(section(), 'Choose in the chat').style.textDecoration, 'underline', 'mixed routes retain the remote affordance')
    await open()
    remoteWords(popup())
    await click(rowOf(popup(), 'danger-full-access'))
    assert.match(popup().textContent, /still asks you before answering each Hermes approval question\. A local route runs commands and changes files without asking/)
    assert.match(popup().textContent, /still asks you before answering each Hermes approval question/)
    assert.deepEqual(saves, [])
  })

  test(`composer during a handoff ${direction} retains the remote warning`, async t => {
    const { document, root, click, ComposerPermission, indexRoster } = mount(t)
    const roster = teamOf(indexRoster, { bot, catalog: FOUR })
    const { actions, saves } = recorder()
    await act(() => root.render(React.createElement(ComposerPermission, { sessionId: BOT.id, useRoster: hook(roster), actions })))
    await click(document.querySelector('.bt-perm-chip'))
    remoteWords(document.querySelector('.bt-permission-menu'))
    assert.match(document.querySelector('.bt-permission-menu').textContent, /changes routes|changing routes/)
    assert.deepEqual(saves, [])
  })
}


test('Choose in the chat is a visible link that reopens the real permission card from Details', async t => {
  const page = mount(t)
  const bot = { ...REMOTE_BOT, permission: 'workspace-write' }
  const roster = teamOf(page.indexRoster, { bot, catalog: FOUR })
  const { actions, saves } = recorder()
  await act(() => page.root.render(React.createElement(React.Fragment, null,
    React.createElement(page.BotPanel, { pane: { id: bot.id, view: 'details' }, leaving: false, roster, actions, ...panelProps }),
    React.createElement(page.PermissionChoiceDock, { sessionId: bot.id, useRoster: hook(roster), actions }))))
  assert.equal(Boolean(card(page.document)), false, 'a saved level has no card until requested')
  const choose = button(page.document.querySelector('.bt-drawer-permission'), 'Choose in the chat')
  assert.equal(choose.style.textDecoration, 'underline')
  await page.click(choose)
  remoteList(card(page.document))
  await page.click(button(card(page.document), 'Not now'))
  assert.equal(Boolean(card(page.document)), false)
  await page.click(choose)
  assert.ok(card(page.document), 'the Details control also reopens a dismissed card')
  assert.deepEqual(saves, [], 'reopening never changes the saved level')
})

test('Remote Hermes Details Auto review note matches its row and asks for explicit confirmation', async t => {
  const { document, render, section, open, popup, click, saves } = details(t, { bot: { ...REMOTE_BOT, permission: 'auto' }, catalog: FOUR })
  await act(render)
  assert.equal(section().querySelector('.bt-note').textContent, AUTO_REMOTE)
  await open()
  assert.equal(rowOf(popup(), 'auto').querySelector('.bt-q-desc').textContent, AUTO_REMOTE)
  await click(rowOf(popup(), 'workspace-write'))
  await open()
  await click(rowOf(popup(), 'auto'))
  assert.match(document.querySelector('.bt-perm-confirm').textContent, /asks you before answering each Hermes approval question.*does not review Hermes/)
  assert.deepEqual(saves, [{ id: BOT.id, patch: { permission: 'workspace-write' } }])
  await click(button(popup(), 'Use Auto review'))
  assert.deepEqual(saves, [{ id: BOT.id, patch: { permission: 'workspace-write' } }, { id: BOT.id, patch: { permission: 'auto' } }])
})

test('Auto question explains the reviewer and retains the revision at opening across renders', async t => {
  const { document, root, click, PermissionList } = mount(t)
  const catalog = { ...THREE, options: [READ, WORK, { value: 'workspace-write:auto', name: 'Auto' }, FULL] }
  const picks = []
  let rev = 3
  const render = () => root.render(React.createElement(PermissionList, { catalog, saved: 'read-only', name: 'Ada', replaced: 'Read only', askedOf: () => ({ id: 'ada', rev }), onPick: async (value, asked) => { picks.push([value, asked]); return true } }))
  await act(render)
  await click(rowOf(document, 'workspace-write:auto'))
  for (const words of ['Codex', 'reviewer', 'outside', 'Automagik does not review', 'another Bot', 'schedule', 'Read only']) assert.ok(document.body.textContent.includes(words), words)
  await click(button(document, 'Cancel'))
  assert.deepEqual(picks, [])
  await click(rowOf(document, 'workspace-write:auto'))
  rev = 9; await act(render)
  await click(button(document, 'Use Auto'))
  assert.equal(JSON.stringify(picks), JSON.stringify([['workspace-write:auto', { id: 'ada', rev: 3 }]]))
})

test('Auto questions explain each route and preserve Codex wording', t => {
  const w = mount(t)
  const own = w.autoQuestion('ada', 'Workspace', { by: 'own', model: 'x' }).join(' ')
  for (const word of ['x', 'separate request', 'sandbox', 'plugin']) assert.ok(own.includes(word))
  const claude = w.autoQuestion('ada', 'Workspace', { by: 'claude', bridged: true, model: 'x' }).join(' ')
  for (const word of ['auto mode', 'x', 'sandbox']) assert.ok(claude.includes(word))
  const team = w.autoQuestion('ada', 'Workspace', { by: 'team', agent: 'acp-hermes', model: 'x' }).join(' ')
  assert.match(team, /Hermes/); assert.match(team, /x/); assert.doesNotMatch(team, /sandbox/)
  const codex = w.autoQuestion('ada', 'Workspace')
  assert.equal(codex.length, 3)
  assert.match(codex[2], /Codex 0.167.0/)
  assert.equal(w.autoQuestion('ada', 'Workspace', { by: 'codex', bridged: true, model: 'x' }).length, 5)
})

for (const surface of ['chat', 'Details', 'composer']) {
  test(`${surface} keeps Auto separate from Auto review and sends the revision confirmed before a roster update`, async t => {
    const page = mount(t)
    const { document, root, click } = page
    const { actions, saves, other } = recorder()
    const bot = { ...BOT, permission: 'read-only', permissionRev: 3, autoOffered: true, autoJudge: { by: 'own', model: 'Test reviewer' } }
    let roster = teamOf(page.indexRoster, { bot, catalog: FOUR })
    const render = () => root.render(surface === 'Details'
      ? React.createElement(page.BotPanel, { pane: { id: bot.id, view: 'details' }, leaving: false, roster, actions, ...panelProps })
      : React.createElement(surface === 'chat' ? page.PermissionChoiceDock : page.ComposerPermission, { sessionId: bot.id, useRoster: select => select(roster), actions }))
    if (surface === 'chat') page.reopenPermissionChoice(bot.id)
    await act(render)
    if (surface !== 'chat') await click(document.querySelector(surface === 'Details' ? '.bt-drawer-permission .bt-model-trigger' : '.bt-perm-chip'))
    const auto = rowOf(document, 'workspace-write:auto')
    assert.ok(auto)
    assert.match(auto.querySelector('.bt-q-desc').textContent, /Test reviewer, this Bot's own model/)
    assert.ok(rowOf(document, 'auto'), 'Auto review remains a separate offered level')
    await click(auto)
    if (surface === 'chat') await click(button(card(document), 'Save'))
    assert.match(document.body.textContent, /Test reviewer.*separate request/)
    assert.deepEqual(saves, [])
    const autoCalls = () => other.filter(([name]) => name === 'setBotAuto')
    assert.deepEqual(autoCalls(), [])
    roster = teamOf(page.indexRoster, { bot: { ...bot, permissionRev: 9 }, catalog: FOUR })
    await act(render)
    await click(button(document, 'Use Auto'))
    assert.deepEqual(saves, [], 'Auto is never persisted as an ordinary permission preset')
    assert.deepEqual(autoCalls(), [['setBotAuto', [bot.id, 3]]], 'the host receives the original revision fence')
  })
}
