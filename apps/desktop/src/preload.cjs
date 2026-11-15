// The window runs dsh's web app as a plain page. This preload tells the page it is inside the
// desktop app (`omniDesktop` and its `app` value are what the page's plugins look for, so they
// keep the name the app shipped under) and hands it the app's update, for the Bot team's
// sidebar to show: `updates` has DSH's desktop shape (status, open, subscribe), under our own
// name, since a page that finds `dshDesktop` takes itself for DSH's own app.
const { contextBridge, ipcRenderer } = require('electron')

const updates = Object.freeze({
  status: () => ipcRenderer.invoke('automagik-updates-status'),
  open: () => ipcRenderer.invoke('automagik-updates-open'),
  // Check and nothing else: unlike `open`, it never restarts into an update or puts plugins in.
  check: () => ipcRenderer.invoke('automagik-updates-check'),
  // About's Force update: conversations stop, every available update goes in, and it restarts.
  force: () => ipcRenderer.invoke('automagik-updates-force'),
  // What this copy is: the app's version, its runtime's, its plugins', and whether it updates.
  versions: () => ipcRenderer.invoke('automagik-updates-versions'),
  // The plugins the lane staged: put them in now (DSH restarts, the window stays), and whether
  // they go in by themselves once no agent is at work.
  applyPlugins: () => ipcRenderer.invoke('automagik-updates-apply-plugins'),
  setAutoApply: on => ipcRenderer.invoke('automagik-updates-auto-apply', on === true),
  subscribe(listener) {
    const handle = (_event, presentation) => listener(presentation)
    ipcRenderer.on('automagik-updates', handle)
    return () => ipcRenderer.off('automagik-updates', handle)
  },
})

// Code mode (RFC 0013): Herdr's state, and bringing its window forward. The page sends a Bot
// id and, to an offer of a newer Herdr (`reason: 'update'`), `update: true` or `false`; nothing
// else, and only during a real click; main finds everything else, the update included, itself.
// User activation is the page's, shared by every script in it (the RFC's threat model).
const herdr = Object.freeze({
  status: () => ipcRenderer.invoke('automagik-herdr-status'),
  open(options) {
    if (globalThis.navigator?.userActivation?.isActive !== true) {
      return Promise.reject(new Error('Herdr opens only on a click'))
    }
    const botId = options?.botId
    const request = { botId: typeof botId === 'string' ? botId : null }
    if (typeof options?.update === 'boolean') request.update = options.update
    return ipcRenderer.invoke('automagik-herdr-open', request)
  },
})

contextBridge.exposeInMainWorld('omniDesktop', Object.freeze({ app: 'omni-desktop', platform: process.platform, updates, herdr }))

// The Bot browsers (main.js, bot-views.js), in the shape the Bot team's panel drives
// (bots-dsh src/client/bot-browsers.js `bridge.views`): each tab is a view the app lays over
// the panel's rectangle. `forget` closes a deleted Bot's tabs and clears its sign-ins.
// `dsBotApp` carries only this; the rest of DS Bot's app bridge is not the app's.
const viewListeners = new Set()
ipcRenderer.on('automagik-browser-view', (_event, change) => {
  for (const listener of [...viewListeners]) {
    try { listener(change) } catch (error) { console.error('Automagik: a browser view listener failed', error) }
  }
})
const call = (channel, ...args) => ipcRenderer.invoke(`automagik-browser-${channel}`, ...args)
const browser = Object.freeze({
  forget: key => call('forget', String(key)),
  views: Object.freeze({
    create: (botId, tabId, url) => call('create', String(botId), String(tabId), typeof url === 'string' ? url : undefined),
    sync: botId => call('sync', String(botId)),
    place: (tabId, rect, visible) => call('place', String(tabId), rect ?? null, visible === true),
    navigate: (botId, tabId, url) => call('navigate', String(botId), String(tabId), String(url)),
    command: (botId, tabId, command) => call('command', String(botId), String(tabId), String(command)),
    focus: (botId, tabId) => call('focus', String(botId), String(tabId)),
    read: (botId, tabId, script) => call('read', String(botId), String(tabId), String(script)),
    close: (botId, tabId) => call('close', String(botId), String(tabId)),
    hold: (botId, held) => call('hold', String(botId), held === true),
    subscribe(listener) {
      viewListeners.add(listener)
      return () => viewListeners.delete(listener)
    },
  }),
})
contextBridge.exposeInMainWorld('dsBotApp', Object.freeze({ browser }))

// The page's styles know they are in the app, on which system, and whether it is full screen:
// on macOS the sidebar's top row makes room for the traffic lights and drags the window
// (bots-dsh sidebar.js), and the title bar's brand is the only one.
const root = () => document.documentElement
const mark = () => { if (root()) root().dataset.automagikDesktop = process.platform }
mark()
document.addEventListener('DOMContentLoaded', mark)
ipcRenderer.on('automagik-window', (_event, state) => {
  if (!root()) return
  if (state?.fullScreen) root().dataset.automagikFullscreen = ''
  else delete root().dataset.automagikFullscreen
})

// The composer's unsent drafts (#141). DSH keeps each Session's draft in this origin's
// localStorage, under `dsh.conversation.<session id>`, and the origin moves with dsh's port when
// the one it had is taken. So the app keeps a copy outside the origin (main.js, drafts.js): here,
// before any script of the page runs, the drafts kept on another origin are put back under DSH's
// own keys (on the same origin, only the ones its storage has lost), and from then on the
// page's are sent to main as they change. The values are DSH's strings, untouched; nothing is
// exposed to the page, and nothing is ever submitted.
const DRAFT_PREFIX = 'dsh.conversation.'
const DRAFTS_EVERY_MS = 2000
// DSH's Session entries hold a `draft`; its other keys under the prefix (a width) are not drafts.
const isDraftEntry = (key, value) => {
  if (typeof key !== 'string' || !key.startsWith(DRAFT_PREFIX) || typeof value !== 'string') return false
  try {
    const stored = JSON.parse(value)
    return stored !== null && typeof stored === 'object' && 'draft' in stored
  } catch { return false }
}
function keepDrafts() {
  const storage = globalThis.localStorage
  if (!storage || typeof ipcRenderer.sendSync !== 'function') return
  // Main answers null to anything but dsh's own page: nothing is put back or sent then. A take
  // or a storage that fails ends it too, so a broken load never replaces the copy with nothing.
  const back = ipcRenderer.sendSync('automagik-drafts-take')
  if (back === null || typeof back !== 'object' || back.entries === null || typeof back.entries !== 'object') return
  // Kept on another origin (`moved`): the copy is the newest state of its Sessions. On this one,
  // the page's storage is; the copy only fills in a key the storage has lost.
  for (const [key, value] of Object.entries(back.entries)) {
    if (isDraftEntry(key, value) && (back.moved === true || storage.getItem(key) === null)) storage.setItem(key, value)
  }
  let sent = null
  const send = () => {
    try {
      const entries = {}
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i)
        const value = storage.getItem(key)
        if (isDraftEntry(key, value)) entries[key] = value
      }
      const now = JSON.stringify(entries)
      if (now === sent) return
      ipcRenderer.send('automagik-drafts-keep', entries)
      sent = now
    } catch { /* storage unavailable: the copy stays as it was */ }
  }
  send()
  setInterval(send, DRAFTS_EVERY_MS)
  globalThis.addEventListener?.('pagehide', send)
}
try { keepDrafts() } catch { /* the page works without the copy */ }
