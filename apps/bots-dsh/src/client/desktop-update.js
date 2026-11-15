import { createElement as h, useEffect, useState } from 'react'
import { language, t } from './i18n.js'
import { opensIntoPlugins, splitsPlugins } from './update-hold.js'

// `splitsPlugins` belongs to the update rule both this module and About read (update-hold.js);
// it is re-exported here for the callers that read the presentation through this module.
export { splitsPlugins }

// -------------------------------------------------------------------------
// The Automagik desktop app's own update, at the bottom of the sidebar above the account and
// Channels, where DSH's own desktop app shows its update (DesktopUpdateIndicator beside its
// settings). The app hands it over in its preload (`omniDesktop.updates`: status, open,
// subscribe, in DSH desktop's phases); in a browser, or a desktop build without it, nothing
// shows. Clicking restarts into a downloaded update, opens the release page of one this copy
// cannot install, or checks again after a failed check.
//
// The plugins the app's lane updates (apps/desktop src/lane.js) have a notice of their own beside
// the app's, naming each plugin with its versions ('Bot team 3.58.1 → 3.59.2'): an app that
// says so (`state.app` and `state.plugins`, apps/desktop src/frame.js updatePresentation) gets
// both; an older one sends one presentation for both, as before.

const BUSY = new Set(['checking', 'downloading', 'installing'])

// A download in megabytes, to one decimal in the reader's language: '41.2'.
function megabytes(bytes) {
  const value = bytes / (1024 * 1024)
  try {
    return new Intl.NumberFormat(language(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)
  } catch {
    return value.toFixed(1)
  }
}

// What the download has of what it needs ({ done, total }), when the app counts its bytes.
function downloaded(state) {
  const { transferred, total } = state
  if (!Number.isFinite(transferred) || !Number.isFinite(total) || !(total > 0) || transferred < 0) return null
  return { done: megabytes(Math.min(transferred, total)), total: megabytes(total) }
}

// What failed, when the app says: the download, or the check of what arrived. The running
// version stays either way, and a click tries again.
function failureLabel(failure) {
  if (failure === 'download') return t('Update download failed · Retry')
  if (failure === 'verify') return t('Update could not be verified · Retry')
  return t('Update check failed · Retry')
}

function downloadPill(state) {
  const percent = state.percent ?? 0
  const size = downloaded(state)
  if (!size) return { label: t('Updating · {percent}%', { percent }), busy: true }
  const label = t('Updating · {percent}% · {done} of {total} MB', { percent, ...size })
  // The label is one line and a narrow sidebar cuts it: the whole of it is the title too.
  return { label, title: label, busy: true }
}

/** The pill for one presentation: { label, busy, primary }, or null when there is nothing to say. */
export function updatePill(state) {
  const version = state?.version
  switch (state?.phase) {
    case 'checking': return { label: t('Checking for updates…'), busy: true }
    case 'available': return { label: version ? t('Automagik {version} is out', { version }) : t('An update is out'), primary: true }
    case 'downloading': return downloadPill(state)
    case 'ready': return { label: version ? t('Restart to update to {version}', { version }) : t('Restart to update'), primary: true }
    case 'installing': return { label: t('Installing the update…'), busy: true }
    case 'error': return { label: failureLabel(state.failure) }
    default: return null
  }
}

// The plugins by the names the Bot team's pages use; another is its package name.
const PLUGIN_NAMES = {
  '@automagik/bots-dsh': () => t('Bot team'),
  '@automagik/welcome-dsh': () => t('Welcome'),
  '@automagik/acp-dsh': () => t('ACP agents'),
  '@automagik/genie-dsh': () => 'Genie',
  '@automagik/locale-pt-br-dsh': () => 'Português (Brasil)',
}

/** What a plugin is called on the page. */
export function pluginName(name) {
  return PLUGIN_NAMES[name]?.() ?? String(name ?? '').replace(/^@[^/]+\//, '')
}

/** One plugin's change: 'Bot team 3.58.1 → 3.59.2', or 'Bot team 3.59.2' when the old one is not known. */
export function changeText(change) {
  return change?.from ? t('{plugin} {from} → {to}', { plugin: pluginName(change.name), from: change.from, to: change.to }) : `${pluginName(change?.name)} ${change?.to ?? ''}`.trim()
}

// The changes in one line: two by name, more as the first and a count.
function changesLine(changes) {
  if (changes.length <= 2) return changes.map(changeText).join(', ')
  return t('{first} and {count} more', { first: changeText(changes[0]), count: changes.length - 1 })
}

/**
 * The plugins' pill: { label, title, busy, primary }, or null. `plugins` is the presentation's
 * `plugins`: { phase, changes, auto, percent }.
 */
export function pluginPill(plugins) {
  const changes = Array.isArray(plugins?.changes) ? plugins.changes : []
  if (changes.length === 0) return null
  const line = changesLine(changes)
  const title = changes.map(changeText).join('\n')
  switch (plugins.phase) {
    case 'downloading': return { label: t('Downloading {changes} · {percent}%', { changes: line, percent: plugins.percent ?? 0 }), title, busy: true }
    case 'ready': return plugins.auto === false
      ? { label: t('Update {changes} now', { changes: line }), title, primary: true }
      : { label: t('{changes} · updates when no agent is at work', { changes: line }), title }
    case 'installing': return { label: t('Updating {changes}…', { changes: line }), title, busy: true }
    default: return null
  }
}

/** The app's update alone: the app's part when the app sends one, else the whole. */
export const appState = state => (splitsPlugins(state) ? state.app : state)

/** The app's update bridge and its latest presentation; no bridge outside the app. */
export function useDesktopUpdate() {
  const bridge = globalThis.omniDesktop?.updates
  const [state, setState] = useState(null)
  useEffect(() => {
    if (!bridge) return undefined
    let live = true
    let heard = false
    const off = bridge.subscribe((next) => { heard = true; if (live) setState(next) })
    bridge.status().then((next) => { if (live && !heard) setState(next) }, () => {})
    return () => { live = false; off?.() }
  }, [bridge])
  return { bridge, state }
}

/**
 * What this copy of the app is, once it has said so (`omniDesktop.updates.versions`, apps/desktop
 * src/frame.js versionsAnswer): { app, dsh, plugins: [{ name, version }], updates }. Null
 * outside the app, and in an app that does not say.
 */
export function useDesktopVersions(presentation) {
  const bridge = globalThis.omniDesktop?.updates
  const [versions, setVersions] = useState(null)
  useEffect(() => {
    if (typeof bridge?.versions !== 'function') return undefined
    let live = true
    bridge.versions().then((next) => { if (live && next && typeof next === 'object') setVersions(next) }, () => {})
    return () => { live = false }
  }, [bridge, presentation])
  return versions
}

function Pill({ pill, busy, held, percent, onClick }) {
  return h('button', {
    type: 'button',
    className: `bt-desk-update${pill.primary ? ' bt-desk-update-go' : ''}`,
    title: pill.title,
    'aria-busy': busy || undefined,
    disabled: busy || held,
    onClick,
  },
  h('span', { className: 'bt-desk-update-dot', 'aria-hidden': true }),
  h('span', { className: 'bt-desk-update-label' }, pill.label),
  percent === undefined ? null : h('span', { className: 'bt-desk-update-bar', 'aria-hidden': true }, h('i', { style: { width: `${percent}%` } })))
}

export function DesktopUpdate() {
  const { bridge, state } = useDesktopUpdate()
  if (!bridge || !state) return null
  const app = appState(state)
  const appPill = updatePill(app)
  // An app update that is downloaded or going in brings its own plugins: theirs waits.
  const plugins = splitsPlugins(state) && !['ready', 'installing'].includes(app.phase) ? state.plugins : null
  const plugPill = pluginPill(plugins)
  if (!appPill && !plugPill) return null
  // An app from before `check` (v3.120.0) has only `open`, and `applyPlugins`/`open` put staged
  // plugins in at once, restarting DSH under the agents at work (#1029, #1240). The same rule as
  // About's Check for updates holds the plugins' pill and the app's check/Retry pill while plugins
  // are staged or coming, or before the app has said anything. The app's labelled pill (an update
  // ready or out) stays live, as About keeps it: in that app `open` restarts into the app update,
  // or opens its release page, without putting staged plugins in. The labels stay as they are, so
  // the hold changes only what a click does.
  const held = opensIntoPlugins(bridge, state)
  const appHeld = held && !appPill?.primary
  const open = () => { if (appHeld || BUSY.has(app.phase)) return; void bridge.open().catch(() => {}) }
  const apply = () => { if (held || BUSY.has(plugins?.phase)) return; void (bridge.applyPlugins ?? bridge.open)().catch(() => {}) }
  return h('div', { className: 'bt-desk-updates' },
    appPill ? h(Pill, { pill: appPill, busy: BUSY.has(app.phase), held: appHeld, percent: app.phase === 'downloading' ? app.percent ?? 0 : undefined, onClick: open }) : null,
    plugPill ? h(Pill, { pill: plugPill, busy: BUSY.has(plugins.phase), held, percent: plugins.phase === 'downloading' ? plugins.percent ?? 0 : undefined, onClick: apply }) : null)
}

export const DESKTOP_UPDATE_CSS = `
[class*="_footArea"]>[class*="_footerActions"]>div:has(>.bt-desk-updates){grid-column:1/-1;order:-1}
.bt-desk-updates{display:flex;flex-direction:column;gap:6px;width:100%}
.bt-desk-update{position:relative;display:flex;align-items:center;gap:8px;width:100%;min-height:32px;padding:6px 12px;border:1px solid color-mix(in srgb,var(--bt-accent) 25%,transparent);border-radius:12px;background:color-mix(in srgb,var(--bt-accent) 8%,var(--bt-card));color:var(--bt-accent);font:600 12px/16px var(--bt-font);text-align:left;cursor:pointer;overflow:hidden}
.bt-desk-update:hover:not(:disabled){background:color-mix(in srgb,var(--bt-accent) 14%,var(--bt-card))}
.bt-desk-update:disabled{cursor:default}
.bt-desk-update-go{background:var(--bt-accent);color:var(--bt-accent-ink);border-color:transparent}
.bt-desk-update-go:hover:not(:disabled){background:color-mix(in srgb,var(--bt-accent) 88%,var(--bt-ink))}
.bt-desk-update-dot{flex:none;width:7px;height:7px;border-radius:50%;background:currentColor}
.bt-desk-update[aria-busy] .bt-desk-update-dot{animation:bt-desk-pulse 1.2s ease-in-out infinite}
.bt-desk-update-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-desk-update-bar{position:absolute;left:0;right:0;bottom:0;height:2px;background:color-mix(in srgb,var(--bt-accent) 18%,transparent)}
.bt-desk-update-bar i{display:block;height:100%;background:var(--bt-accent);transition:width .3s ease}
@keyframes bt-desk-pulse{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.bt-desk-update[aria-busy] .bt-desk-update-dot{animation:none}}
`
