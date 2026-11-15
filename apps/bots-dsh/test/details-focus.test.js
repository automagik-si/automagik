import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

// The existing BotPanel rendered with the React DSH ships (its module-loader seeds, as in
// brain-navigation.test.js) in jsdom: focus in and back out, the narrow modal and its Tab
// containment, and the drawer's Escape stack.
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
const { createPortal, flushSync } = nativeRequire('react-dom')
const tick = () => new Promise(resolve => setTimeout(resolve, 10))
const act = async fn => { flushSync(fn); await tick() }
const { outputFiles } = await build({
  stdin: { contents: [
    "export { BotPanel } from './src/client/browser-pane.js'; export { useEscape } from './src/client/overlay-hooks.js'",
    "export { HeaderPill } from './src/client/header.js'; export { teamActions } from './src/client/team-actions.js'",
    "export { createSource, indexRoster } from './src/client/sources.js'",
    "export { frameLayout } from './src/client/frame-layout.js'",
  ].join('\n'), resolveDir: plugin },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  // ISSUE89_BASELINE=<dir> bundles <dir>/browser-pane.js instead, to show these tests fail on it.
  plugins: process.env.ISSUE89_BASELINE ? [{ name: 'baseline', setup(build) {
    build.onLoad({ filter: /src\/client\/browser-pane\.js$/ }, args => ({ contents: readFileSync(join(process.env.ISSUE89_BASELINE, 'browser-pane.js'), 'utf8'), resolveDir: dirname(args.path), loader: 'js' }))
  } }] : [],
})

// overlays.js gives the panel the room it shares with the conversation and says when
// it covers the chat (frameLayout). This stands in for it: no left column, the
// window's width, measured again when the window resizes.
const framed = (window, { BotPanel, frameLayout }) => function Framed(props) {
  const [viewport, setViewport] = React.useState(window.innerWidth)
  React.useEffect(() => {
    const measure = () => setViewport(window.innerWidth)
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])
  const layout = frameLayout({ viewport, sidebarWidth: 0, pref: 'hidden', panel: { view: props.pane.view, yielded: true } })
  return React.createElement(BotPanel, { ...props, room: layout.room, overlay: layout.panel === 'overlay' })
}

function mount(t) {
  const dom = new JSDOM('<body><button data-details-subject="group">Details</button><button data-details-subject="other">Other Details</button><button id="composer">Composer</button><div id="mount"></div></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const { window } = dom
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  window.innerWidth = 1200
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, require: name => name === '@deepseek-ai/dsh-client-ui-primitives' ? { MarkdownText: () => null } : nativeRequire(name),
    window, document: window.document, navigator: window.navigator, localStorage: window.localStorage, matchMedia: window.matchMedia, ResizeObserver: window.ResizeObserver,
    MutationObserver: window.MutationObserver, Element: window.Element, CSS: { escape: name => name }, getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    queueMicrotask, setTimeout, clearTimeout, setInterval, clearInterval, console, performance, URL,
  })
  const root = createRoot(window.document.querySelector('#mount'))
  t.after(async () => { try { await act(() => root.unmount()) } catch {} dom.window.close() })
  const key = (name, shiftKey = false) => window.document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true, cancelable: true }))
  const focused = (node, message) => assert.ok(window.document.activeElement === node, message)
  return { window, document: window.document, root, key, focused, ...module.exports, BotPanel: framed(window, module.exports) }
}

const hook = value => select => select(value)
const panelProps = { useSessions: hook({ byId: {} }), useSessionStatus: hook(new Map()), useActivity: hook({}), useWork: hook({}), useBrowserTabs: hook({}), useBrowserPages: hook({}) }
const roster = { byId: {}, roomsById: { group: { id: 'group', name: 'Team', members: [] }, other: { id: 'other', name: 'Other team', members: [] } }, bots: [], rooms: [], exchangeTurns: {}, questions: {}, sideChats: {}, permissions: [], memory: false }

test('Details takes focus on open and gives it back to its trigger on close', async (t) => {
  const { document, root, key, focused, BotPanel } = mount(t)
  let pane = { id: 'group', view: 'details' }, leaving = false
  const render = () => root.render(React.createElement(BotPanel, { pane, leaving, roster, actions: { closeOverlay: () => { leaving = true; render() } }, ...panelProps }))
  const trigger = document.querySelector('[data-details-subject="group"]')
  trigger.focus()
  await act(render)
  const panel = document.querySelector('.bt-panel')
  assert.match(panel.textContent, /Team/)
  focused(panel, 'opening moves focus into the panel')
  assert.equal(panel.id, 'bt-conversation-panel', 'the header\'s aria-controls names the existing panel')
  assert.equal(panel.getAttribute('role'), null, 'a wide panel beside the chat is not modal')
  assert.equal(panel.hasAttribute('inert'), false)

  await act(() => key('Escape'))
  assert.equal(leaving, true, 'the drawer\'s Escape closes the panel')
  assert.equal(panel.getAttribute('aria-hidden'), 'true')
  assert.equal(panel.hasAttribute('inert'), true, 'a leaving panel takes no focus or clicks')
  focused(trigger, 'closing returns focus to the matching Details trigger')

  await act(() => { leaving = false; pane = { id: 'other', view: 'details' }; render() })
  assert.match(panel.textContent, /Other team/)
  focused(panel, 'opening another subject focuses its details')
  await act(() => { leaving = true; render() })
  focused(document.querySelector('[data-details-subject="other"]'), 'close returns to the current subject\'s trigger, not the old one')

  await act(() => { leaving = false; render() })
  await act(() => {
    flushSync(() => { leaving = true; render() })
    flushSync(() => { leaving = false; pane = { ...pane, renaming: true }; render() })
  })
  focused(panel.querySelector('input[aria-label="Group name"]'), 'a queued return never steals a rapid reopen\'s rename focus')
})

test('over a narrow window Details is a modal that contains Tab and focus, and newer layers win', async (t) => {
  const { window, document, root, key, focused, BotPanel, useEscape } = mount(t)
  const h = React.createElement
  let pane = { id: 'group', view: 'details' }, leaving = false, layer = null
  function Layer() {
    useEscape(() => { layer = null; render() })
    return createPortal(h('div', { role: layer }, h('input', { autoFocus: true, 'aria-label': 'Layer input' })), document.body)
  }
  const render = () => root.render(h(React.Fragment, null,
    h(BotPanel, { pane, leaving, roster, actions: { closeOverlay: () => { leaving = true; render() } }, ...panelProps }),
    layer ? h(Layer) : null))
  const composer = document.querySelector('#composer')
  document.querySelector('[data-details-subject="group"]').focus()
  await act(render)
  const panel = document.querySelector('.bt-panel')
  composer.focus()
  await act(() => { window.innerWidth = 390; window.dispatchEvent(new window.Event('resize')) })
  assert.equal(panel.getAttribute('role'), 'dialog')
  assert.equal(panel.getAttribute('aria-modal'), 'true')
  focused(panel, 'becoming a full-window overlay takes focus at once')
  // A group with no admin shows its goal button disabled, and Tab passes over it.
  const buttons = [...panel.querySelectorAll('button')].filter(node => !node.disabled)
  assert.ok(buttons.length > 1)
  await act(() => key('Tab'))
  focused(buttons[0], 'Tab from the panel goes to its first control')
  await act(() => key('Tab', true))
  focused(buttons.at(-1), 'Shift+Tab wraps to the last control')
  await act(() => key('Tab'))
  focused(buttons[0], 'Tab wraps to the first control')
  composer.focus()
  focused(panel, 'focus moved outside is brought back')

  for (const role of ['dialog', 'menu', 'listbox']) {
    await act(() => { layer = role; render() })
    focused(document.querySelector('[aria-label="Layer input"]'), `a portalled ${role} keeps its autofocus`)
    await act(() => key('Escape'))
    assert.equal(layer, null, `Escape closes the newer ${role}`)
    assert.equal(leaving, false, `Escape on the ${role} leaves the details open`)
  }
  const stale = document.createElement('div')
  stale.setAttribute('role', 'menu')
  stale.hidden = true
  document.body.append(stale)
  composer.focus()
  focused(panel, 'a hidden stale menu does not switch containment off')
  stale.remove()

  await act(() => { pane = { ...pane, renaming: true }; render() })
  const input = panel.querySelector('input[aria-label="Group name"]')
  focused(input, 'the rename field keeps its autofocus')
  await act(() => key('Escape'))
  assert.equal(leaving, false, 'Escape in the rename field cancels editing, not the details')
  await act(() => { layer = 'dialog'; render() })
  const dialogInput = document.querySelector('[aria-label="Layer input"]')
  await act(() => { leaving = true; render() })
  assert.equal(panel.getAttribute('aria-modal'), null, 'a leaving panel is no longer modal')
  focused(dialogInput, 'closing the details never takes focus from a dialog over them')
  await act(() => root.unmount())
  composer.focus()
  focused(composer, 'unmounting removes the containment listeners')
})

test('narrow Details mounts a focused dialog, and a view switch never yanks focus', async (t) => {
  const { window, document, root, focused, BotPanel } = mount(t)
  window.innerWidth = 390
  const bot = { id: 'omni', name: 'Omni', sessionId: 'omni' }
  const withBot = {
    ...roster, byId: { omni: bot }, bots: [bot], browser: true,
    sideChats: { omni: [{ id: 'side-1' }] },
  }
  let pane = { id: 'omni', view: 'details' }, leaving = false
  const actions = new Proxy({ closeOverlay() {} },
    { get: (known, name) => known[name] ?? (async () => {}) })
  const render = () => root.render(React.createElement(BotPanel, {
    pane, leaving, roster: withBot, actions, ...panelProps,
  }))
  document.querySelector('#composer').focus()
  await act(render)
  const panel = document.querySelector('.bt-panel')
  assert.equal(panel.getAttribute('tabindex'), '-1', 'the panel is programmatically focusable')
  assert.equal(panel.getAttribute('role'), 'dialog', 'a narrow Details pane starts modal')
  assert.equal(panel.getAttribute('aria-modal'), 'true')
  focused(panel, 'opening on a narrow window moves focus into the dialog')

  await act(() => { pane = { id: 'omni', view: 'browser' }; render() })
  assert.equal(panel.dataset.view, 'browser')
  assert.equal(panel.getAttribute('role'), null, 'the browser view is not the Details dialog')
  assert.equal(panel.getAttribute('aria-modal'), null)
  focused(panel, 'changing the pane view does not return focus to the Details trigger')

  await act(() => { pane = { id: 'omni', view: 'side', side: 'side-1' }; render() })
  assert.equal(panel.dataset.view, 'side')
  assert.equal(panel.getAttribute('role'), null, 'a side chat is not the Details dialog either')
  assert.equal(panel.getAttribute('aria-modal'), null)
  focused(panel, 'the side chat keeps the panel focus')
})

test('the browser and a native thread keep their own panels: no modal Details, no parent Bot', async (t) => {
  const { window, document, root, focused, BotPanel } = mount(t)
  window.innerWidth = 390
  const bots = { omni: { id: 'omni', name: 'Omni', sessionId: 'omni' } }
  const withBot = { ...roster, byId: bots, bots: [bots.omni], browser: true }
  const render = pane => root.render(React.createElement(BotPanel, { pane, leaving: false, roster: withBot, actions: new Proxy({ closeOverlay() {} }, { get: (known, name) => known[name] ?? (async () => {}) }), ...panelProps }))
  const composer = document.querySelector('#composer')
  composer.focus()
  await act(() => render({ id: 'omni', view: 'browser' }))
  const panel = document.querySelector('.bt-panel')
  assert.equal(panel.dataset.view, 'browser')
  assert.equal(panel.getAttribute('role'), null, 'the browser view is not the Details dialog')
  focused(composer, 'the browser view does not take focus as Details does')
  await act(() => render({ id: 'native-thread', view: 'details' }))
  assert.equal(panel.dataset.view, 'details')
  assert.doesNotMatch(panel.textContent, /Omni/, 'a native thread never shows its parent Bot\'s details')
})

// A multi-part Bot: its header names the current part's Session id, while Rename (the
// context menu) opens the Bot id. The real header, actions and panel share one ui store.
function partsApp(t) {
  const env = mount(t)
  const { document, root, BotPanel, HeaderPill, teamActions, createSource, indexRoster } = env
  const h = React.createElement
  const team = indexRoster({ bots: [{ id: 'bot', name: 'Omni', sessionId: 'part-2', parts: ['bot', 'part-2'] }], rooms: [] })
  const shown = { ...roster, ...team }
  const ui = createSource({ details: null, view: 'details', renaming: false, tab: null })
  const base = teamActions({ ui, roster: createSource(shown), live: createSource({}) })
  // The real Details actions; the panel's server calls do nothing here.
  const real = new Set(['toggleDetails', 'renameBot', 'showDetails', 'closeOverlay', 'closePanel'])
  const actions = new Proxy(base, { get: (known, name) => (real.has(name) ? known[name] : async () => {}) })
  const useUi = select => React.useSyncExternalStore(ui.subscribe, () => select(ui.getSnapshot()))
  let last = null
  function App() {
    const state = useUi(value => value)
    if (state.details) last = { id: state.details, view: state.view, renaming: state.renaming, tab: state.tab }
    return h(React.Fragment, null,
      h(HeaderPill, {
        sessionId: 'part-2', useRoster: hook(shown), useSessions: hook({ byId: {} }), useSessionStatus: hook(new Map()),
        useSession: hook({}), useActivity: hook({}), useMemoryNews: hook({}), useTurnClock: hook({}), useUi,
        useLive: hook({}), useWork: hook({}), actions,
      }),
      last ? h(BotPanel, { pane: last, leaving: !state.details, roster: shown, actions, ...panelProps }) : null)
  }
  const render = () => root.render(h(App))
  // overlays.js keeps a closed pane for PANEL_LINGER_MS, then unmounts it.
  const settle = () => { last = null; render() }
  return { ...env, ui, actions, team, render, settle, toggle: () => document.querySelector('[aria-controls="bt-conversation-panel"]') }
}

test('a multi-part Bot\'s Details opened from its part header expands it and returns focus to it', async (t) => {
  const { document, ui, render, settle, toggle, key, focused } = partsApp(t)
  await act(render)
  assert.equal(toggle().dataset.detailsSubject, 'part-2', 'the header names the current part')
  assert.equal(toggle().getAttribute('aria-expanded'), 'false')
  await act(() => toggle().click())
  assert.equal(ui.getSnapshot().details, 'part-2')
  const panel = document.querySelector('.bt-panel')
  assert.equal(toggle().getAttribute('aria-expanded'), 'true', 'the part header shows its Bot\'s details open')
  focused(panel, 'opening moves focus into the panel')
  await act(() => toggle().click())
  assert.equal(ui.getSnapshot().details, null, 'a second press closes the details')
  assert.equal(toggle().getAttribute('aria-expanded'), 'false')
  focused(toggle(), 'closing by the toggle returns focus to it')

  await act(settle)
  await act(() => toggle().click())
  focused(document.querySelector('.bt-panel'), 'reopening focuses the panel again')
  await act(() => key('Escape'))
  assert.equal(ui.getSnapshot().details, null, 'Escape closes the details')
  assert.equal(toggle().getAttribute('aria-expanded'), 'false')
  focused(toggle(), 'closing by Escape returns focus to the part\'s toggle, not <body>')
})

test('a multi-part Bot\'s Details opened via Rename expands the part header, and closing returns focus to it', async (t) => {
  const { document, ui, actions, team, render, settle, toggle, key, focused } = partsApp(t)
  await act(render)
  // The context menu's Rename item has focus, then closes as it opens the Bot id's details.
  const item = document.createElement('button')
  document.body.append(item)
  item.focus()
  await act(() => { item.remove(); actions.renameBot('bot') })
  assert.equal(ui.getSnapshot().details, 'bot', 'Rename opens the Bot id, not the part\'s Session id')
  assert.equal(toggle().dataset.detailsSubject, 'part-2', 'the header names its own part')
  assert.equal(team.byId[toggle().dataset.detailsSubject].id, ui.getSnapshot().details,
    'the part id normalizes to the Bot id the details opened')
  const panel = document.querySelector('.bt-panel')
  assert.equal(toggle().getAttribute('aria-expanded'), 'true', 'the part header shows its Bot\'s details open')
  focused(panel.querySelector('input[aria-label="Bot name"]'), 'the rename field takes focus')
  await act(() => toggle().click())
  assert.equal(ui.getSnapshot().details, null, 'the expanded part toggle closes the Bot\'s details')
  assert.equal(toggle().getAttribute('aria-expanded'), 'false')
  focused(toggle(), 'closing by the toggle returns focus to it')

  await act(settle)
  await act(() => actions.renameBot('bot'))
  const reopened = document.querySelector('.bt-panel')
  focused(reopened.querySelector('input[aria-label="Bot name"]'), 'Rename again focuses the name field')
  await act(() => key('Escape'))
  assert.equal(ui.getSnapshot().details, 'bot', 'Escape in the rename field cancels editing, not the details')
  assert.equal(toggle().getAttribute('aria-expanded'), 'true')
  focused(reopened.querySelector('.bt-drawer-name'), 'Escape gives focus back to the Bot\'s name button, not the toggle')
  reopened.focus()
  await act(() => key('Escape'))
  assert.equal(ui.getSnapshot().details, null, 'Escape closes the details')
  assert.equal(toggle().getAttribute('aria-expanded'), 'false')
  focused(toggle(), 'closing by Escape returns focus to the part\'s toggle, not <body>')
})

test('a multi-part Bot\'s memory pill follows its Bot id, not the part', async (t) => {
  const { document, root, HeaderPill, createSource, indexRoster } = mount(t)
  const h = React.createElement
  const team = indexRoster({ bots: [{ id: 'bot', name: 'Omni', sessionId: 'part-2', parts: ['bot', 'part-2'] }], rooms: [] })
  const shown = { ...roster, ...team, memory: true }
  const news = { bot: { seen: Date.now(), at: Date.now() } }
  const ui = createSource({ visits: {}, details: null, view: 'details', renaming: false, tab: null })
  const useUi = select => React.useSyncExternalStore(ui.subscribe, () => select(ui.getSnapshot()))
  const opened = [], toggled = []
  const actions = new Proxy({ beginVisit() {}, endVisit() {}, openMemory: id => opened.push(id), toggleDetails: id => toggled.push(id) },
    { get: (known, name) => known[name] ?? (() => {}) })
  await act(() => root.render(h(HeaderPill, {
    sessionId: 'part-2', useRoster: hook(shown), useSessions: hook({ byId: {} }), useSessionStatus: hook(new Map()),
    useSession: hook({}), useActivity: hook({}), useMemoryNews: hook(news), useTurnClock: hook({}), useUi,
    useLive: hook({}), useWork: hook({}), actions,
  })))
  const pill = document.querySelector('[data-memory="updated"]')
  assert.ok(pill, 'the part header shows its Bot\'s memory news')
  assert.match(pill.getAttribute('aria-label'), /Omni/, 'the news names the Bot, not its part')
  await act(() => pill.click())
  assert.deepEqual(opened, ['bot'], 'the pill opens the Bot\'s memory')
  assert.deepEqual(toggled, [], 'and never toggles the details')
})

// #338: Escape in the Rename field cancels. It saves nothing (not through the field's blur
// either), keeps the details open, and gives focus back to the name button, not <body> or
// the Details trigger. Enter still saves the typed name.
test('Escape cancels a rename and gives focus back to the name button; Enter still saves', async (t) => {
  const { window, document, root, key, focused, BotPanel } = mount(t)
  const named = { ...roster, roomsById: { ...roster.roomsById, group: { id: 'group', name: 'Team', named: true, members: [] } } }
  const updates = []
  let leaving = false
  const actions = {
    closeOverlay: () => { leaving = true; render() },
    updateRoom: async (id, patch) => { updates.push(['room', id, { ...patch }]) },
    updateBot: async (id, patch) => { updates.push(['bot', id, { ...patch }]) },
  }
  const render = () => root.render(React.createElement(BotPanel, { pane: { id: 'group', view: 'details' }, leaving, roster: named, actions, ...panelProps }))
  const trigger = document.querySelector('[data-details-subject="group"]')
  trigger.focus()
  await act(render)
  const panel = document.querySelector('.bt-panel')
  const type = async (value) => {
    const input = panel.querySelector('input[aria-label="Group name"]')
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value)
    await act(() => input.dispatchEvent(new window.Event('input', { bubbles: true })))
  }
  await act(() => panel.querySelector('.bt-drawer-name').click())
  focused(panel.querySelector('input[aria-label="Group name"]'), 'Rename focuses the name field')
  await type('Draft name')
  await act(() => key('Escape'))
  await tick()
  assert.equal(panel.querySelector('input[aria-label="Group name"]'), null, 'Escape ends editing')
  const button = panel.querySelector('.bt-drawer-name')
  assert.ok(button, 'the name button is back')
  assert.equal(button.textContent, 'Team', 'the shown name is unchanged')
  assert.equal(leaving, false, 'Escape in the rename field does not close the details')
  assert.ok(document.querySelector('.bt-panel') === panel && !panel.hasAttribute('inert'), 'the details stay open')
  assert.notEqual(document.activeElement, document.body, 'focus does not fall to <body>')
  assert.notEqual(document.activeElement, trigger, 'the Details trigger does not take the focus')
  focused(button, 'Escape gives focus back to the name button')
  await act(() => document.querySelector('#composer').focus())
  assert.deepEqual(updates, [], 'a cancelled rename saves nothing, also after focus moves on')

  await act(() => button.click())
  await type('Renamed')
  await act(() => key('Enter'))
  await tick()
  assert.equal(panel.querySelector('input[aria-label="Group name"]'), null, 'Enter ends editing')
  assert.deepEqual(updates, [['room', 'group', { name: 'Renamed' }]], 'Enter saves the typed name once')
  assert.equal(leaving, false, 'Enter does not close the details')
})

// Issue #337: the memory notice reuses the pill, which used to copy the Details state into
// its own aria-expanded. Only the Details button may expose it; the pill's arrow reads
// data-expanded instead.
test('only the Details button exposes aria-expanded; the memory pill carries data-expanded for its arrow', async (t) => {
  const { document, root, HeaderPill, createSource, indexRoster } = mount(t)
  const h = React.createElement
  const team = indexRoster({ bots: [{ id: 'bot', name: 'Omni', sessionId: 'bot' }], rooms: [] })
  const shown = { ...roster, ...team, memory: true }
  const news = { bot: { seen: Date.now(), at: Date.now() } }
  const opened = []
  const actions = new Proxy({ beginVisit() {}, endVisit() {}, openMemory: id => opened.push(id) },
    { get: (known, name) => known[name] ?? (() => {}) })
  for (const [view, expanded] of [['details', 'true'], ['chat', 'false']]) {
    const ui = createSource({ visits: {}, details: 'bot', view, renaming: false, tab: null })
    const useUi = select => React.useSyncExternalStore(ui.subscribe, () => select(ui.getSnapshot()))
    await act(() => root.render(h(HeaderPill, {
      sessionId: 'bot', useRoster: hook(shown), useSessions: hook({ byId: {} }), useSessionStatus: hook(new Map()),
      useSession: hook({}), useActivity: hook({}), useMemoryNews: hook(news), useTurnClock: hook({}), useUi,
      useLive: hook({}), useWork: hook({}), actions,
    })))
    const headerNode = document.querySelector('.bt-head')
    assert.ok(headerNode, `${view}: the real header renders`)
    const pill = headerNode.querySelector('.bt-pill[data-memory="updated"]')
    assert.ok(pill, `${view}: the memory notice shows`)
    const details = headerNode.querySelector('.bt-head-details[data-details-subject="bot"]')
    assert.ok(details, `${view}: the Details button shows beside it`)
    const exposed = [...headerNode.querySelectorAll('[aria-expanded]')]
    const names = exposed.map(node => node.className).join(', ')
    assert.equal(exposed.length, 1,
      `${view}: exactly one header element carries aria-expanded, not ${names}`)
    assert.ok(exposed[0] === details, `${view}: and it is the Details button`)
    assert.equal(details.tagName, 'BUTTON',
      `${view}: the expanded control is the real Details button`)
    assert.equal(details.getAttribute('aria-expanded'), expanded)
    assert.equal(details.getAttribute('aria-controls'), 'bt-conversation-panel')
    assert.equal(headerNode.hasAttribute('aria-expanded'), false,
      `${view}: the header itself exposes no expanded state`)
    assert.equal(pill.tagName, 'BUTTON', `${view}: the memory pill is the button beside it`)
    assert.equal(pill.hasAttribute('aria-expanded'), false, `${view}: the memory pill exposes no expanded state`)
    assert.equal(pill.hasAttribute('aria-controls'), false, `${view}: the memory pill controls no pane`)
    assert.equal(pill.getAttribute('data-expanded'), expanded, `${view}: the pill's arrow still reads the Details state`)
    assert.match(pill.getAttribute('aria-label'), /^Memory updated\. Open Omni/)
  }
  await act(() => document.querySelector('[data-memory="updated"]').click())
  assert.deepEqual(opened, ['bot'], 'the memory pill still opens the memory')
})
