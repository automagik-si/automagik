// How the app's window looks. No system frame and no border anywhere: on Linux the window
// is transparent and the shell page (shell.html) draws its rounded shape, title bar and
// window buttons; on macOS there is no bar: dsh's page fills the window, and the system's
// traffic lights sit in the sidebar's top row, beside its buttons (bots-dsh sidebar.js), as
// in Claude, Codex or DSH's own app.
// The frame is the clay theme's table (apps/bots-dsh src/client/clay.js), light or dark as
// the system is: cream by day, the same clay at night.
// dsh's page is a view laid in edge to edge below the bar, its corners rounded with
// the window's. Chromium keeps a frameless window's resize edge over the view.

import { PRODUCT } from './identity.js'

export const BAR_HEIGHT = 40
export const RADIUS = 14
// The traffic lights' top left on macOS: centred on the sidebar's top row (its 30px buttons,
// 18px down the page), inside the sidebar's card.
export const TRAFFIC_LIGHTS = Object.freeze({ x: 26, y: 32 })

// The clay table (CLAY_LIGHT.bg and CLAY_DARK.bg in the clay theme): what a window or page
// shows before its page paints, so a light system never sees a dark flash.
export const TABLE = Object.freeze({ light: '#f6eee2', dark: '#1e1923' })

/** The table colour for the system's light or dark setting (Electron's nativeTheme). */
export const tableColor = dark => (dark ? TABLE.dark : TABLE.light)

/**
 * BrowserWindow options for the frame on `platform`. macOS gets the solid table, not
 * vibrancy: clay is matte and opaque, and the desktop blurred through it would not read as
 * clay. Linux stays transparent so the shell page can round the window's corners.
 */
export function windowChrome(platform, { dark = false } = {}) {
  if (platform === 'darwin') {
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { ...TRAFFIC_LIGHTS }, backgroundColor: tableColor(dark) }
  }
  return { frame: false, transparent: true, backgroundColor: '#00000000', autoHideMenuBar: true }
}

/**
 * Where dsh's page goes in a window whose content is `size`, and how round its corners
 * are: below the bar and rounded with the window on Linux; the whole window on macOS (whose
 * window rounds itself), and square when maximized.
 */
export function pageLayout(size, { platform, maximized }) {
  const top = platform === 'darwin' ? 0 : BAR_HEIGHT
  return {
    bounds: { x: 0, y: top, width: size.width, height: Math.max(0, size.height - top) },
    radius: platform === 'darwin' || maximized ? 0 : RADIUS,
  }
}

/** The page follows the native window size, including Linux maximize/snap transitions. */
export function windowPageLayout(window, { platform = process.platform } = {}) {
  // On Linux/X11, resize can fire before getContentBounds() catches up. With no
  // subsequent resize the page stays at its old size (electron/electron#42586).
  // Our Linux window has no native frame or menu, so its outer size is the content
  // size. Keep the content measurement on macOS and Windows for their native insets.
  const size = platform === 'linux' ? window.getBounds() : window.getContentBounds()
  return pageLayout(size, { platform, maximized: window.isMaximized() || window.isFullScreen() })
}

/** What the shell page may ask the main process for: the window buttons and the title bar's menu. */
export const WINDOW_ACTIONS = new Set(['minimize', 'maximize', 'close', 'menu'])

/**
 * The update as the page's sidebar shows it, at the bottom left beside the settings, as DSH's
 * own desktop app does (its DesktopUpdateIndicator): `{ phase, version?, percent?, failure? }`,
 * phase one of idle, checking, available, downloading, installing, ready, error. `update` is
 * update.js's state; `checking` and `failed` (a check that failed) come from Check for Updates.
 * A quick retry of a transient failure (a 5xx from the releases API, a changed network) is the
 * checking phase plus `retrying: true`, so a client that knows only the seven phases still
 * renders it as a check in progress instead of a failure; a client that reads the marker can
 * say "Retrying update check…".
 *
 * A download carries `transferred` and `total` (bytes) beside `percent` when the updater counts
 * them. The error phase's `failure` says what failed: `check` (the releases could not be read),
 * `download` (the update did not arrive) or `verify` (what arrived is not what the release
 * says); in each the running version stays as it is.
 *
 * Given `lane` ({ changes, auto, applying }: the staged plugins as auto-apply.js changesOf names
 * them, the setting, and whether they are going in now), it also carries the app's update and
 * the plugins' apart, for a Bot team that names each plugin: `app` ({ phase, version?, percent?,
 * failure? }, the app alone) and `plugins` ({ phase, changes, auto, percent? }, phase one of
 * idle, downloading, ready, installing). The fields above stay as they were, for a Bot team that
 * reads only those.
 */
export function updatePresentation(update, { checking = false, failed = false, plugins, fetching, lane } = {}) {
  const legacy = lane?.applying ? { phase: 'installing', version: plugins, kind: 'plugins' } : legacyPresentation(update, { checking, failed, plugins, fetching })
  if (!lane) return legacy
  return { ...legacy, app: legacyPresentation(update, { checking, failed }), plugins: pluginsPresentation({ lane, fetching }) }
}

const VERSION_TEXT = /^\d+\.\d+\.\d+[0-9A-Za-z.+-]{0,40}$/
const versionText = value => (typeof value === 'string' && value.length <= 64 && VERSION_TEXT.test(value) ? value : null)

/**
 * What this copy of the app is, for the Bot team's About page (preload.cjs
 * `omniDesktop.updates.versions`): `{ app, dsh, plugins: [{ name, version }], updates }`. `app`
 * is the app's own version, `dsh` its runtime's, `plugins` the installed plugins of the
 * publishers the app follows (lane.js installedVersions, by name), and `updates` whether this
 * copy updates at all (update.js updateMode). Version text only: no path, no setting.
 */
export function versionsAnswer({ app, dsh, plugins, mode, latest, reason, appUpdate, force } = {}) {
  const listed = Object.entries(plugins ?? {})
    .map(([name, version]) => ({ name, version: versionText(version) }))
    .filter(plugin => plugin.version !== null)
  return { app: versionText(app), dsh: versionText(dsh), plugins: listed, updates: mode === 'auto' || mode === 'notify',
    ...(latest === undefined ? {} : { latest: Object.fromEntries(Object.entries(latest ?? {}).map(([name, version]) => [name, versionText(version)]).filter(([, version]) => version !== null)) }),
    ...(reason === undefined ? {} : { reason: reasonText(reason) }),
    ...(appUpdate === undefined ? {} : { appUpdate: { version: versionText(appUpdate?.version), latest: appUpdate?.latest === true } }),
    ...(force === undefined ? {} : { force: forceText(force) }),
  }
}

const REASONS = new Set(['invalid-lane', 'older-sequence', 'app-line', 'app-minimum', 'trial-failed', 'dsh-range', 'up-to-date', 'check-failed', 'not-checked'])
const FORCE_PHASES = new Set(['stopping', 'checking', 'downloading', 'installing', 'restarting', 'done', 'failed'])
const FORCE_CODES = new Set([...REASONS, 'updated', 'plugins-rolled-back', 'app-download-failed', 'app-manual', 'restart-failed'])
const paramsText = params => Object.fromEntries(['line', 'base', 'version', 'app'].flatMap(key => {
  const value = params?.[key]
  const clean = key === 'line' && typeof value === 'string' && /^\d{1,9}\.\d{1,9}$/.test(value) ? value : versionText(value)
  return clean ? [[key, clean]] : []
}))
const reasonText = reason => reason && REASONS.has(reason.code) ? { code: reason.code, params: paramsText(reason.params) } : null
export const forceText = force => force && FORCE_PHASES.has(force.phase) ? {
  phase: force.phase,
  ...(FORCE_CODES.has(force.code) ? { code: force.code } : {}),
  ...(force.params ? { params: paramsText(force.params) } : {}),
} : null

/**
 * Whether a check that found the app up to date still failed: a lane could not be read
 * (`laneFailed`) and nothing is staged (`staged`), so "up to date" would not be true. Any other
 * result (an update found or ready, an error, a retry) already says what it is.
 */
export const laneMissedOf = ({ result, laneFailed, staged }) => result === 'latest' && laneFailed === true && !staged

function pluginsPresentation({ lane, fetching }) {
  const auto = lane.auto !== false
  if (lane.applying) return { phase: 'installing', changes: lane.changes ?? [], auto }
  if ((lane.changes ?? []).length > 0) return { phase: 'ready', changes: lane.changes, auto }
  if (fetching) return { phase: 'downloading', changes: fetching.changes ?? [], percent: Math.floor(fetching.percent ?? 0), auto }
  return { phase: 'idle', changes: [], auto }
}

// The download in bytes, when update.js counted them: { transferred, total }.
function bytesOf(update) {
  const { transferred, total } = update
  return Number.isFinite(transferred) && Number.isFinite(total) && total > 0 ? { transferred, total } : {}
}

function legacyPresentation(update, { checking, failed, plugins, fetching }) {
  const version = update?.version ? { version: update.version } : {}
  if (update?.state === 'restarting') return { phase: 'installing', ...version }
  if (update?.state === 'ready') return { phase: 'ready', ...version }
  // Plugins the lane staged (lane.js) are ready too: a start puts them in, in a few seconds.
  if (plugins && update?.state !== 'downloading' && update?.state !== 'available') return { phase: 'ready', version: plugins, kind: 'plugins' }
  if (update?.state === 'downloading') return { phase: 'downloading', ...version, percent: Math.floor(update.percent ?? 0), ...bytesOf(update) }
  if (update?.state === 'available') return { phase: 'available', ...version }
  // Plugins the lane is downloading: the sidebar shows them coming, not only once staged.
  if (fetching) return { phase: 'downloading', version: fetching.version, percent: Math.floor(fetching.percent ?? 0), kind: 'plugins' }
  if (checking) return { phase: 'checking' }
  // A download that did not arrive, or an update that could not be verified (update.js): the
  // error phase with what failed, so a Bot team that knows only `phase` still shows a failure.
  if (update?.state === 'failed') return { phase: 'error', failure: update.failure === 'verify' ? 'verify' : 'download', ...version }
  if (failed) return { phase: 'error', failure: 'check' }
  if (update?.state === 'retrying') return { phase: 'checking', retrying: true }
  return { phase: 'idle' }
}
