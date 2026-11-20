// Browser fixture for the sidebar toggle's one spot (#1502): the pinned DSH SidebarRoot, taken
// from its own client bundle (dsh-client-ui-sidebar lib, with the CSS module it injects), around
// the Bot team's real sidebar, footer entries and style sheets.
//
// What is reconstructed rather than the shell's own, and why it is enough here:
// - The frame (dsh-client-ui-layout AppFrame) is a plain grid with the layout bundle's own CSS
//   module: the sidebar track is 56px collapsed and the wide width open, as AppFrame sets it
//   inline. AppFrame's track transition is not replayed; SidebarRoot's own settle (the wide
//   content fading for 150ms, then the rail entering) is, since that is SidebarRoot's code.
// - The slots: renderSlot draws the Bot team's TeamSidebar for sidebar.workspaces and its footer
//   entries (FooterAccount, RailToggle, plus `extra` stand-in entries other plugins would add);
//   the toggle badge is a stand-in dot.
// - The desktop attributes (data-windows-titlebar, data-platform, data-sidebar-drawer) are set
//   by the test as the desktop preload and AppFrame set them.
import { createElement as h, Fragment, useSyncExternalStore } from 'react'
import { SHELL_CSS } from '../../src/client/styles.js'
import { SIDEBAR_CSS, TeamSidebar, FooterAccount, RailToggle } from '../../src/client/sidebar.js'
import { LEFT_BAR_CSS } from '../../src/client/left-bar-css.js'
import { WORK_CODE_SWITCH_CSS } from '../../src/client/work-code-switch.js'
import { allThemes, themeCss } from '../../src/client/themes.js'
import { createSource, indexRoster } from '../../src/client/sources.js'
import { CODE_PANEL, CodeMainPanel, codePanelNavigation, codeStore } from '../../src/client/code-side.js'
import { CodeTree, CodeTerminal } from '../../src/client/code-side-pane.js'
import { SEAT_CHAT_CSS } from '../../src/client/seat-chat.js'

const { createRoot } = window.nativeSeeds['react-dom/client']

// The DSH bundles register through window.__ModuleLoader__; their requires are the page's seeds.
const loaded = {}
window.__ModuleLoader__ = { load: ({ id, factory }) => { loaded[id] = factory(name => window.nativeSeeds[name]) } }
window.loadDsh = (sources) => { for (const source of sources) (0, eval)(source) }

// SidebarRoot is what dsh-client-ui-sidebar's apply registers for the `sidebar` slot.
function sidebarRoot() {
  let component = null
  const ctx = {
    get: () => ({}),
    effect: run => run(),
    locale: { register: () => () => {}, subscribe: () => () => {} },
    slots: {
      entriesOfSlot: () => [],
      subscribe: () => () => {},
      registerFactory: () => () => {},
      register: (spec, Component) => { if (spec.name === 'sidebar') component = Component; return () => {} },
      inject: (_name, make) => { const made = make(); if (made && typeof made.next === 'function') Array.from(made) },
    },
  }
  loaded['@deepseek-ai/dsh-client-ui-sidebar'].apply(ctx)
  return component
}

const style = document.createElement('style')
document.head.append(style)
window.setTheme = (id, dark) => {
  style.textContent = SHELL_CSS + SIDEBAR_CSS + LEFT_BAR_CSS + WORK_CODE_SWITCH_CSS + themeCss(allThemes()[id])
  if (dark) document.body.setAttribute('data-ds-dark-theme', '')
  else document.body.removeAttribute('data-ds-dark-theme')
}

const bot = (id, name, at) => ({ id, name, createdAt: at, avatar: { shape: 'octopus' }, color: 'deepseek' })
const BOTS = Array.from({ length: 24 }, (_, at) => bot(`bot-${at}`, `Bot ${at + 1}`, at + 1))
const roster = createSource(indexRoster({ bots: [], rooms: [], agents: [], models: [], prefs: {}, exchangeTurns: {} }))
const hook = source => pick => useSyncExternalStore(source.subscribe, () => pick(source.getSnapshot()))
const constant = value => pick => pick(value)
const NO_SESSIONS = { ids: [], byId: {} }
const NO_WORK = { approvals: [], rooms: {}, failed: {}, waiting: {} }

const state = { collapsed: false, drawer: false, width: 300, extra: 0, bots: 3 }
let root = null
let Root = null
window.toggles = 0
const toggleSidebar = () => { window.toggles += 1; state.collapsed = !state.collapsed; render() }
const actions = {
  toggleSidebar, openSession: () => {}, openAgent: () => {}, openAgentSession: () => {}, newAgentSession: () => {},
  openPalette: () => {}, openNewChat: () => {}, clearUnread: () => {}, selectPanel: () => {}, openSettings: () => {},
  openConnectors: () => {}, setSurface: () => {}, seatAccount: () => {}, installUpdate: async () => {},
}
const teamProps = {
  actions, useRoster: hook(roster), useUi: constant({ unread: {} }), useRegistry: constant({}), useSessions: constant(NO_SESSIONS),
  useUpdate: constant({}), useSessionStatus: constant(new Map()), useSessionRetainInfo: (_id, pick) => pick(undefined),
  useActivity: constant({}), useWork: constant(NO_WORK),
}

const renderSlot = (name, props) => {
  if (name === 'sidebar.workspaces') return h(TeamSidebar, { ...teamProps, ...props })
  if (name === 'sidebar.toggle.badge') return h('span', { className: 'fx-badge', style: { position: 'absolute', top: '4px', right: '4px', width: '7px', height: '7px', borderRadius: '50%', background: 'currentColor' } })
  if (name === 'sidebar.footer.action') {
    return h(Fragment, null,
      // Another plugin's entries, as the shell lists them before the Bot team's own.
      Array.from({ length: state.extra }, (_, at) => h('button', { key: `extra-${at}`, type: 'button', className: 'fx-extra', style: { height: '30px' } }, `Extra ${at + 1}`)),
      h(FooterAccount, { key: 'account', ...teamProps, ...props }),
      h(RailToggle, { key: 'toggle', ...teamProps, ...props }))
  }
  return null
}
const t = key => ({ 'toggle.open': 'Open sidebar', 'toggle.collapse': 'Collapse sidebar' })[key] ?? key

function render() {
  const layout = window.layoutPrefix
  const frame = document.querySelector('#frame')
  frame.className = `${layout}_frame`
  frame.toggleAttribute('data-sidebar-collapsed', state.collapsed)
  if (state.drawer) frame.setAttribute('data-sidebar-drawer', '')
  else frame.removeAttribute('data-sidebar-drawer')
  frame.style.gridTemplateColumns = `${state.drawer ? 0 : state.collapsed ? 56 : state.width}px minmax(0px, 1fr) minmax(0px, 0px)`
  document.querySelector('#col').className = `${layout}_sidebarCol`
  document.querySelector('#center').className = `${layout}_centerCol`
  roster.set(indexRoster({ bots: BOTS.slice(0, state.bots), rooms: [], agents: [], models: [], prefs: {}, exchangeTurns: {} }))
  root.render(h(Root, {
    collapsed: state.collapsed, width: state.width, drawer: state.drawer,
    startSession: () => {}, toggleSidebar, selectPanel: () => {}, setPinned: () => {}, trackEntryClick: () => {},
    useRemoteAccess: () => true, usePanels: constant([]), useEntryPins: constant([]), useEntryActions: constant(false),
    useShortcuts: constant([]), usePanelInfo: constant({ activePanelId: null }), t, renderSlot, renderFactorySlot: () => null,
  }))
}

window.mount = (options = {}) => {
  Object.assign(state, { collapsed: false, drawer: false, width: 300, extra: 0, bots: 3 }, options)
  Root ??= sidebarRoot()
  root ??= createRoot(document.querySelector('[data-slot=sidebar]'))
  render()
}
window.setState = (options) => { Object.assign(state, options); render() }

// The Code drawer uses the same SidebarRoot and TeamSidebar as the other cases. The
// fixture's layout keeps a seat selected under the real Code panel and records its stream.
window.mountCodeDrawer = () => {
  const styles = document.createElement('style')
  styles.textContent = SEAT_CHAT_CSS
  document.head.append(styles)
  const panelInfo = createSource({ activePanelId: 'fixture-seat' })
  const layout = { panelInfo, selectPanel: activePanelId => panelInfo.set({ activePanelId }) }
  const code = codePanelNavigation(layout)
  actions.openCodePane = code.open
  actions.closeCodePane = code.close
  window.__dshChunk = async () => ({ CodeTree, CodeTerminal })
  codeStore.reset()
  window.codeTraffic = { calls: [], streams: [], closed: [] }
  const traffic = window.codeTraffic
  window.EventSource = class {
    constructor(url) { this.url = url; traffic.streams.push(url) }
    addEventListener(type, listener) {
      if (type === 'pane') queueMicrotask(() => listener({ data: '{}' }))
      if (type === 'data') queueMicrotask(() => listener({ data: btoa('fixture output') }))
    }
    close() { traffic.closed.push(this.url) }
  }
  const tree = { machine: { name: 'Local machine' }, projects: [{
    folder: '/fixture/project', name: 'Fixture project', bots: [
      { id: 'b-aaaaaaaaaa', name: 'Atlas', status: 'idle', terminal: { id: 't7' }, workers: [{ terminal: 't8', role: 'Reviewer', status: 'needs-you' }] },
    ],
  }] }
  window.fetch = async (url, init = {}) => {
    const body = JSON.parse(init.body)
    traffic.calls.push({ url, body })
    if (body.endpoint === 'code-tree') return Response.json({ ok: true, value: tree })
    if (url.endsWith('/take')) {
      if (traffic.pauseTake) await new Promise(resolve => { traffic.finishTake = resolve })
      return Response.json({ session: 'fixture-typing', mode: 'typing' })
    }
    if (url.endsWith('/release')) return new Response(null, { status: 204 })
    throw new Error(`Unexpected request: ${url}`)
  }
  function Main() {
    const { activePanelId } = useSyncExternalStore(panelInfo.subscribe, panelInfo.getSnapshot)
    if (activePanelId === CODE_PANEL) return h(CodeMainPanel, { onBack: code.close })
    if (activePanelId === 'fixture-seat') return h('p', { 'data-fixture-seat': '' }, 'Retained seat chat')
    return null
  }
  createRoot(document.querySelector('#center')).render(h(Main))
  window.mount({ drawer: true, width: 336 })
}
