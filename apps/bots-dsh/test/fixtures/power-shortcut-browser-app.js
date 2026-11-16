// Browser fixture for the sidebar's tools (extend.js sidebarTools) with the welcome's power
// shortcut in them: the Bot team's real sidebar, styles and themes, and the welcome's real
// shortcut and power store. The welcome host's endpoints are a fake in this page; nothing is
// installed and nothing leaves it.
import { createElement as h, useSyncExternalStore } from 'react'
import { SHELL_CSS } from '../../src/client/styles.js'
import { SIDEBAR_CSS, TeamSidebar } from '../../src/client/sidebar.js'
import { WORK_CODE_SWITCH_CSS } from '../../src/client/work-code-switch.js'
import { allThemes, themeCss } from '../../src/client/themes.js'
import { sidebarTools } from '../../src/client/extend.js'
import { createSource, indexRoster } from '../../src/client/sources.js'
import { BotMark } from '../../src/client/mark.js'
import { PowerShortcut } from '../../../welcome-dsh/src/client/power-shortcut.js'
import { showPower, resetPower } from '../../../welcome-dsh/src/client/power-store.js'

const { createRoot } = window.nativeSeeds['react-dom/client']

// The welcome host, faked: each endpoint answers from window.answers.
window.answers = {
  state: { host: null, preload: null },
  'omni-plugins': { ready: true, installed: true, canInstall: true, plugins: [] },
  'genie-plugin': { ready: false, canInstall: true, install: null },
}
window.calls = []
window.fetch = async (url, init) => {
  const { endpoint, payload } = JSON.parse(init.body)
  window.calls.push({ url: String(url), endpoint, payload })
  const value = window.answers[endpoint] ?? {}
  return new Response(JSON.stringify({ ok: true, value }), { headers: { 'content-type': 'application/json' } })
}
window.actionsCalled = []

const style = document.createElement('style')
document.head.append(style)
window.setTheme = (id, dark) => {
  style.textContent = SHELL_CSS + SIDEBAR_CSS + WORK_CODE_SWITCH_CSS + themeCss(allThemes()[id])
  if (dark) document.body.setAttribute('data-ds-dark-theme', '')
  else document.body.removeAttribute('data-ds-dark-theme')
}

const roster = createSource(indexRoster({ bots: [], rooms: [], agents: [], models: [], prefs: {}, exchangeTurns: {} }))
window.setRoster = (data) => roster.set(indexRoster({ rooms: [], agents: [], models: [], prefs: {}, exchangeTurns: {}, ...data }))
window.setPower = (kind, phase, detail = null) => showPower(kind, phase, detail)
window.resetPower = resetPower
const update = createSource({})
window.setUpdate = value => update.set(value)

const hook = source => pick => useSyncExternalStore(source.subscribe, () => pick(source.getSnapshot()))
const constant = value => pick => pick(value)
const NO_SESSIONS = { ids: [], byId: {} }
const NO_WORK = { approvals: [], rooms: {}, failed: {}, waiting: {} }
const NO_STATUS = new Map()
const record = name => (...args) => { window.actionsCalled.push([name, ...args]) }
const actions = {
  openSession: record('openSession'), openAgent: record('openAgent'), openAgentSession: record('openAgentSession'), newAgentSession: record('newAgentSession'),
  openPalette: record('openPalette'), openNewChat: record('openNewChat'), toggleSidebar: record('toggleSidebar'), clearUnread: record('clearUnread'),
  openHarnessOnboarding: record('openHarnessOnboarding'), selectPanel: record('selectPanel'), addOmni: async () => { window.actionsCalled.push(['addOmni']); return { id: 'omni' } },
  installUpdate: async () => {}, installDshUpdate: async () => {}, openAppUpdates: async () => {},
}

let root = null
let offTool = null
// `onboarding: false`: a Bot team without the shell's onboarding opener.
window.mount = ({ wide = true, width = 300, tool = true, throwing = false, onboarding = true } = {}) => {
  root?.unmount()
  offTool?.()
  offTool = null
  const offs = []
  if (throwing) offs.push(sidebarTools.register({ id: 'broken', order: -1, Component: () => { throw new Error('a broken tool') } }))
  // As installPowerShortcut registers it: with the Bot team's own BotMark for each row's face.
  if (tool) offs.push(sidebarTools.register({ id: 'welcome-power', order: 0, Component: props => h(PowerShortcut, { ...props, Mark: BotMark }) }))
  offTool = () => offs.forEach(off => off())
  const host = document.getElementById('root')
  host.style.width = wide ? `${width}px` : '56px'
  root = createRoot(host)
  const { openHarnessOnboarding, ...without } = actions
  root.render(h(TeamSidebar, {
    wide, actions: onboarding ? actions : without,
    useRoster: hook(roster), useUi: constant({ unread: {} }), useRegistry: constant({}), useSessions: constant(NO_SESSIONS), useUpdate: hook(update),
    useSessionStatus: constant(NO_STATUS), useSessionRetainInfo: (_id, pick) => pick(undefined), useActivity: constant({}), useWork: constant(NO_WORK),
  }))
}

// The top row fits when nothing reaches past its edges and no button was squeezed below its
// size (a flex row shrinks its items before it overflows).
window.rowCheck = () => {
  const row = document.querySelector('.lb-head')
  const edge = row.getBoundingClientRect()
  const out = []
  for (const node of row.children) {
    const box = node.getBoundingClientRect()
    if (box.width === 0) continue
    const name = node.getAttribute('aria-label') ?? node.className
    if (box.left < edge.left - 0.5 || box.right > edge.right + 0.5) out.push(`${name} outside`)
    if (node.matches('.bt-round') && box.width < box.height - 0.5) out.push(`${name} squeezed to ${Math.round(box.width)}px`)
  }
  return { fits: out.length === 0 && row.scrollWidth <= row.clientWidth, out }
}
