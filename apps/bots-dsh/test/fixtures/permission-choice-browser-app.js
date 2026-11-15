// Browser fixture for the explained permission choice: the Bot team's real card, Details panel,
// Settings page, styles and themes. The host is a fake in this page: `window.saves` lists what
// the page asked it to save. Nothing leaves the page.
import { createElement as h, useSyncExternalStore } from 'react'
import { SHELL_CSS, CONVERSATION_CSS } from '../../src/client/styles.js'
import { MODEL_CSS } from '../../src/client/model-menu.js'
import { BOT_SETTINGS_CSS } from '../../src/client/bot-settings.js'
import { GROUP_SETTINGS_CSS } from '../../src/client/group-settings.js'
import { FOLDER_CSS } from '../../src/client/folder-menu.js'
import { MEMBER_CSS } from '../../src/client/member-status.js'
import { allThemes, themeCss } from '../../src/client/themes.js'
import { createSource, indexRoster } from '../../src/client/sources.js'
import { BotPanel, BROWSER_CSS } from '../../src/client/browser-pane.js'
import { SettingsDialog } from '../../src/client/settings.js'
import { PermissionChoiceDock } from '../../src/client/permission-card.js'

const { createRoot } = window.nativeSeeds['react-dom/client']

const style = document.createElement('style')
document.head.append(style)
window.setTheme = (id, dark) => {
  style.textContent = SHELL_CSS + CONVERSATION_CSS + MODEL_CSS + FOLDER_CSS + BOT_SETTINGS_CSS + GROUP_SETTINGS_CSS + BROWSER_CSS + MEMBER_CSS + themeCss(allThemes()[id])
  if (dark) document.body.setAttribute('data-ds-dark-theme', '')
  else document.body.removeAttribute('data-ds-dark-theme')
}

const LEVELS = {
  'read-only': { value: 'read-only', name: 'Read only' },
  'workspace-write': { value: 'workspace-write', name: 'Workspace' },
  auto: { value: 'auto', name: 'Auto review' },
  'danger-full-access': { value: 'danger-full-access', name: 'Full access' },
}
const roster = createSource(indexRoster({ bots: [], rooms: [] }))
window.saves = []
const setBot = (patch) => {
  const snapshot = roster.getSnapshot()
  roster.set({ ...indexRoster({ ...snapshot, bots: snapshot.bots.map(bot => ({ ...bot, ...patch })) }), permissions: snapshot.permissions, readOnly: snapshot.readOnly })
}
const actions = new Proxy({
  updateBot: async (id, patch) => { window.saves.push({ id, patch }); if (patch.permission !== undefined) setBot({ permission: patch.permission }); return {} },
  setPrefs: async (patch) => { window.saves.push({ prefs: patch }); roster.set({ ...roster.getSnapshot(), prefs: { ...roster.getSnapshot().prefs, ...patch } }); return {} },
  updateRoom: async (id, patch) => { window.saves.push({ room: id, patch }); return {} },
  pluginSettings: () => [],
}, { get: (known, name) => (name in known ? known[name] : name === 'providers' || name === 'browserShow' || name === 'runStats' ? undefined : async () => undefined) })

const useRoster = select => useSyncExternalStore(roster.subscribe, () => select(roster.getSnapshot()))
const constant = value => select => select(value)
const panelProps = { useSessions: constant({ byId: {} }), useSessionStatus: constant(new Map()), useActivity: constant({}), useWork: constant({}), useBrowserTabs: constant({}), useBrowserPages: constant({}) }

function Page({ view }) {
  const team = useRoster(value => value)
  if (view === 'settings' || view === 'group') {
    return h(SettingsDialog, { page: view === 'group' ? 'groups' : 'bots', id: view === 'group' ? 'group' : undefined, roster: team, actions, useUpdate: constant({}) })
  }
  // Beside the chat the shell leaves the panel its 320 px; in a narrower window the panel covers the chat.
  const beside = view === 'panel' && window.innerWidth >= 740 ? 320 : 0
  return h('div', { 'data-chat': '', style: { height: '100%', marginRight: beside, display: 'flex', flexDirection: 'column', color: 'var(--bt-ink)', font: '400 15px/22px var(--bt-font)' } },
    h('div', { style: { flex: 1, minHeight: 0, width: '100%', maxWidth: 748, margin: '0 auto', padding: '24px 16px', boxSizing: 'border-box' } },
      h('p', null, 'Hi! Before I start, choose what I may do on my own.')),
    h('div', { 'data-dock': '', style: { width: '100%', maxWidth: 748, margin: '0 auto', padding: '0 16px 16px', boxSizing: 'border-box' } },
      h(PermissionChoiceDock, { sessionId: 'omni', useRoster, actions })),
    view === 'panel' ? h(BotPanel, { pane: { id: 'omni', view: 'details' }, leaving: false, roster: team, actions, ...panelProps }) : null)
}

let root = null
window.mount = ({ view = 'card', levels = ['read-only', 'workspace-write', 'danger-full-access'], defaultPreset = 'read-only', permission, readOnly, name = 'Test Bot' } = {}) => {
  root?.unmount()
  window.saves = []
  try { localStorage.clear() } catch { /* storage unavailable */ }
  const bot = { id: 'omni', name, sessionId: 'omni', color: 'red', model: 'deepseek/v3', ...(permission ? { permission } : {}) }
  const room = { id: 'group', name: 'Studio', members: ['omni'], admin: 'omni', permission: 'workspace-write', named: true }
  roster.set({
    ...indexRoster({ bots: [bot], rooms: [room], agents: [], models: [{ ref: 'deepseek/v3', id: 'v3', name: 'DeepSeek V3', provider: 'deepseek' }], prefs: {}, exchangeTurns: {}, questions: {}, sideChats: {}, secretRequests: {}, secrets: [], capabilities: [], mainBotId: 'omni', mainBotIds: ['omni'] }),
    permissions: { options: levels.map(value => LEVELS[value]), defaultPreset }, memory: false, ...(readOnly ? { readOnly } : {}),
  })
  root = createRoot(document.getElementById('root'))
  root.render(h(Page, { view }))
}
