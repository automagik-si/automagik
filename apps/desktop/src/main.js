// Automagik desktop: one window on a DeepSeek Harness of the app's own (see dsh.js for where it
// keeps things). The window opens at once on its own frame (frame.js, shell.html) with the
// Automagik mark waking up; the main process starts dsh on a loopback port, waits for the launch
// URL with dsh's per-launch token, and lays dsh's page into the frame; quitting stops dsh.
// Both pages are plain browser pages with no Node in them: context isolation and the
// renderer sandbox are on, dsh's page can navigate only within dsh's origin, web links open
// in the system browser, and the frame page never navigates. Each Bot's browser is in the
// window too (bot-views.js), over the Bot browser panel, and the Bot drives it through a
// loopback CDP relay (bot-relay.js) that dsh asks for over its IPC channel, with its cursor
// drawn in a click-through window over the tab (bot-cursor.js).
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, powerMonitor, session, shell, systemPreferences, WebContentsView } from 'electron'
import updaterModule from 'electron-updater'
import { appendFileSync, createWriteStream, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { linkInArgs, parseDeepLink, registerSchemes } from './deeplink.js'
import { fade, PAGE_IN_CSS } from './motion.js'
import { noteRestart, restartLine, steps } from './timeline.js'
import { startUp } from './startup.js'
import { dismissSplash, markSplashStep, showUpdateSplash } from './splash.js'
import { PUBLISHERS, TRIAL_MS, beforeStart, checkLane, confirm as confirmLane, installedVersions, laneMemory, stage as stageLane, stagedOf, stagedVersion, trialFailed } from './lane.js'
import {
  ANONYMOUS_ID, appHome, automagikHome, backupSettingsOrLog, busyFileOf, dshEnv, dshRun,
  forgetDshLogins, launchUrlFileOf, privacyFileOf, privacyPatchOf, guardContents, installProfile,
  launchPort, pageUrlOf, pinProfileStore, portFileOf, preloadOf, resourcesOf, serveDsh,
  storeLayoutOf, writeTools,
} from './dsh.js'
import { BotCursor } from './bot-cursor.js'
import { BotRelay } from './bot-relay.js'
import { BotViews, isBotId, isTabId } from './bot-views.js'
import { findHerdr, herdrStatus } from './herdr.js'
import { openRequest, pickSpace } from './herdr-space.js'
import { openLatest } from './herdr-update.js'
import { laneMissedOf, tableColor, updatePresentation, versionsAnswer, WINDOW_ACTIONS, windowChrome, windowPageLayout } from './frame.js'
import { dataPathsOf, PRODUCT } from './identity.js'
import { LOOK_EVERY_MS, readBusy } from './idle.js'
import { appMenuTemplate } from './menu.js'
import { sendPaneClose } from './pane-close.js'
import { closeAfterFade, createQuitGuard, liveBusy, quitPrompt, requestQuit, surfaceWindow } from './quit-guard.js'
import { applyNow, applyStaged, appStopped, causeOf, changesOf, confirmationBudget, readAutoApply, settingsFileOf, writeAutoApply } from './auto-apply.js'
import { readChoices, writeOverlay } from './privacy.js'
import { draftsFileOf, PAGE_DRAFTS, saveDrafts, takeDrafts } from './drafts.js'
import { prepareRestart } from './prepare-restart.js'
import { forceUpdate } from './force-update.js'
import { CHECK_EVERY_MS, compareVersions, isReleasePage, startUpdates, updateMode } from './update.js'
import {
  DSH_TUI_LABEL, DSH_TUI_LOG, dshTuiModuleDir, dshTuiRunnerOf, dshTuiSupported, ensurePathLine,
  formatDoctor, pathActionOf, pathDoneView, pathView, resultView, runDshTui, setupView,
} from './dsh-tui.js'

const HERE = dirname(fileURLToPath(import.meta.url))
// Before anything reads it (the single-instance lock does): the window's data is filed under
// the app's own name (identity.js), whatever Electron derives from the running binary.
for (const [name, path] of Object.entries(dataPathsOf(app.getPath('appData')))) app.setPath(name, path)
const root = automagikHome()
const home = appHome()
let dsh = null
// dsh's process from the moment it is spawned: a quit before it is ready still stops it.
// The dsh this start runs, whichever process that is now (a retry on another port replaces the
// first): every way out stops it, and one that spawns after that is stopped at once. A restart of
// DSH alone, for plugins the lane staged (auto-apply.js), stops it and makes a new one.
let dshProcess = dshRun()
let window = null
let page = null
let quitting = false
// The window is fading out on its way to close.
let closing = false
// The system's "reduce motion" (macOS accessibility, Windows animation settings).
const lessMotion = () => systemPreferences.getAnimationSettings?.().prefersReducedMotion === true
let ready = false
// The update the title bar shows ({ version, state, percent }), once there is one.
let update = null
let updates = null
// The plugin lane (lane.js): plugins staged for the next start, this start's trial, and where
// the profile and DSH's own version are.
let laneReady = null
// What the staged plugins change ([{ name, from, to }], auto-apply.js changesOf), and the same
// while they go in with DSH restarted alone (null when they are not going in).
let laneWaiting = []
let laneApplying = null
// DSH is being stopped and started again on purpose (auto-apply.js): its exit is no failure.
let restartingDsh = false
let laneTrial = null
let laneProfile = null
let laneDsh = null
// The lane update being downloaded ({ version, percent }), while it is.
let laneFetching = null
// Check for Updates is under way, or its last check failed (frame.js updatePresentation). A
// transient failure that update.js is retrying within a minute is not a failure: its state
// carries the retrying marker instead.
let checking = false
let checkFailed = false
// The last look at the lanes could not read the lane of a publisher whose plugins are installed
// (lookOnce).
let laneFailed = false
const laneDecisions = new Map(PUBLISHERS.map(publisher => [publisher.publisher, { reason: 'not-checked', plugins: [] }]))
let forceState
let forcing = null
let laneOutcome
// logs/start.log (timeline.js): a start's steps from the process's own start, and the way out
// (a quit, or a restart into an update) from the moment it was asked for.
const startLog = (line) => { try { appendFileSync(join(home, 'logs', 'start.log'), line) } catch {} }
const RESTART_NOTE = () => join(home, 'logs', 'restart.json')
const started = steps('start', { write: startLog, since: Date.now() - process.uptime() * 1000 })
let leaving = null
const leave = (kind) => (leaving ??= steps(kind, { write: startLog, since: Date.now() }))
// A quit while the welcome says a bot runs (busy.json) asks first; a missing file is an older
// welcome or no dsh, and quits as it always has, as does a file this run's dsh did not write
// (a crash's leftover, liveBusy). The clean stop behind a confirmed quit is stopAndQuit(), below.
const quitLog = line => startLog(`${new Date().toISOString()} ${line}\n`)
const quitGuard = createQuitGuard({
  busy: () => liveBusy(readBusy(busyFileOf(home)), { child: dshProcess.child, since: dshProcess.since }),
  // The question is a sheet on the window, so the window comes where the person sees it first:
  // minimized, hidden or behind a hidden app, the sheet would wait unseen and hold every quit.
  prompt: ({ running, parent }) => {
    if (process.platform === 'darwin') app.show()
    const sheet = surfaceWindow(parent ?? window)
    app.focus({ steal: true })
    const question = quitPrompt({ product: PRODUCT, running })
    return sheet ? dialog.showMessageBox(sheet, question) : dialog.showMessageBox(question)
  },
  log: quitLog,
})
// dsh's origin, from the port it is started on; Bot pages never reach it.
let dshOrigin
// The corner radius of dsh's page (frame.js pageLayout), which the Bot views take too.
let pageRadius = 0
// The Bot browsers: their views over the panel's rectangle in dsh's page, which tells them
// what changed, the relay each Bot drives them through, and the Bot's cursor over them.
const botViews = new BotViews({
  window: () => window,
  WebContentsView,
  session,
  origin: () => dshOrigin,
  page: () => (page && ready ? { ...page.getBounds(), zoom: page.webContents.getZoomFactor(), radius: pageRadius } : null),
  devTools: !app.isPackaged,
  onChange: (change) => { if (page && !page.webContents.isDestroyed()) page.webContents.send('automagik-browser-view', change) },
})
const botRelay = new BotRelay({ views: botViews })
// On Wayland no window can place itself, so the Bot's cursor is not drawn there, unless
// Electron runs through XWayland (`--ozone-platform=x11`).
const wayland = process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland' &&
  !['ozone-platform', 'ozone-platform-hint'].some(name => app.commandLine.getSwitchValue(name) === 'x11')
const botCursor = new BotCursor({ window: () => window, BrowserWindow, views: botViews, placeable: !wayland })

// automagik:// and omni:// links (deeplink.js): the system hands them to the running app
// (macOS: open-url; Linux and Windows: a second instance with the link as an argument), or
// starts the app with one. A link that arrives before the app's page is up waits for it.
// The schemes are taken once the page is in (registerSchemes).
let pendingLink = linkInArgs(process.argv)
let schemesTaken = null
app.on('open-url', (event, url) => {
  event.preventDefault()
  receiveLink(url)
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // Opened again after an update: the splash that update left up (splash.js) moves its bar on.
  markSplashStep(home, 'starting')
  app.on('second-instance', (_event, argv) => {
    // `omni desktop` or `genie desktop` while the app runs: kept for the next start.
    preloadOf({ home: root, argv, env: {} })
    if (window) {
      if (window.isMinimized()) window.restore()
      window.focus()
    }
    const link = linkInArgs(argv)
    if (link) receiveLink(link)
  })
  app.whenReady().then(launch).catch(fail)
}

function receiveLink(text) {
  const link = parseDeepLink(text)
  if (!link) return
  if (window) {
    if (window.isMinimized()) window.restore()
    window.focus()
  }
  logLinkBot(link)
  if (link.action !== 'connect') return
  pendingLink = text
  if (ready) void connectFromLink()
}

// A link's Bot is selected from RFC 0013 delivery 8; until then it is only logged.
function logLinkBot(link) {
  if (link?.bot) switchLog(`${new Date().toISOString()} link: open, bot ${link.bot} (not selected yet)\n`)
}

// Ask, then hand the address to Omni's page (apps/omni-channels-dsh, the omni-desktop:connect
// event). With a grant the page trades it for this device's key at once; without one it
// starts the sign-in on that Omni and opens its approval page in the browser.
async function connectFromLink() {
  const link = parseDeepLink(pendingLink)
  pendingLink = null
  // A link that started the app (Linux and Windows: in its argv) is read here, once the page is in.
  logLinkBot(link)
  if (!link || link.action !== 'connect' || !window || !page) return
  const { response } = await dialog.showMessageBox(window, {
    type: 'question',
    buttons: ['Connect', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: `Connect ${PRODUCT} to ${link.host}?`,
    detail: (link.grant
      ? `Your Omni sent you this link on WhatsApp. Connecting gives this computer its own key to ${link.host}.`
      : `You'll sign in on ${link.host} with Face ID, Touch ID, your fingerprint or a code on WhatsApp.`)
      + (link.secure ? '' : '\n\nThis address is not encrypted (http). Connect only if it is your own network.'),
  })
  if (response !== 0) return
  await page.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('omni-desktop:connect', { detail: ${JSON.stringify({ url: link.url, ...(link.grant ? { grant: link.grant } : {}) })} }))`)
}

// app.exit skips before-quit, so dsh is stopped here: a start that fails after dsh came up
// must not leave it running on loopback with no window.
function fail(error) {
  quitting = true
  sendState({ status: `${PRODUCT} could not start.`, problem: true })
  dialog.showErrorBox(`${PRODUCT} could not start`, `${error?.message ?? error}\n\nLog: ${join(home, 'logs', 'dsh.log')}`)
  void dshProcess.stop().finally(() => app.exit(1))
}

// macOS's app menu: the system's usual menus, with Check for Updates under the app's name.
// The File menu's Cmd+W closes the focused pane/tab in dsh's page, never the window: the window
// keeps its own close button, which asks while a bot runs (quitGuard).
function appMenu() {
  return Menu.buildFromTemplate(appMenuTemplate({
    product: PRODUCT,
    platform: process.platform,
    dshTuiLabel: dshTuiSupported() ? DSH_TUI_LABEL : null,
    onCheckForUpdates: () => void checkForUpdates(),
    onDshTui: () => void openDshTuiSetup(),
    onClosePane: () => closeFocusedPane(),
  }))
}

// Cmd+W's path: the dsh page closes its focused pane/tab, or does nothing when there is none.
// With the keyboard in a Bot view, the pane under that view is the one meant, not the page's
// last focus. The window and the app are never touched here (pane-close.js).
function closeFocusedPane() {
  if (!page) return
  const at = botViews.focusedPoint()
  if (at) sendPaneClose(page.webContents, { at })
  else sendPaneClose(page.webContents)
}

async function launch() {
  // No menu bar on Linux; macOS keeps its app menu for the usual shortcuts.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  else {
    Menu.setApplicationMenu(appMenu())
  }
  mkdirSync(join(home, 'logs'), { recursive: true })
  started.mark(`${app.getVersion()} ready`)
  openWindow()
  nativeTheme.on('updated', followTheme)
  const resources = resourcesOf({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() })
  // dsh's boot is the long wait of a start: only what dsh reads as it starts comes before it, and
  // the page gets ready while it boots (startup.js keeps the order, and its tests check it).
  await startUp({
    mark: step => started.mark(step),
    // The port dsh served on last time, while it is still free: the page's URL, and so its
    // cached bundle and its storage, stay the same (dsh.js launchPort).
    port: () => launchPort(portFileOf(home), undefined, { onWaited: portWaited(started) }),
    // The profile is in place before dsh reads it.
    profile: async () => {
      // Before this start's dsh first reads its settings: dsh 0.2.2 moves settings.yaml into
      // the profile and renames the file, and a section it rejects survives only there.
      const saved = backupSettingsOrLog({
        dshHome: join(home, 'dsh'),
        version: readVersion(join(dirname(resources.bin), '..', 'package.json')),
        log: reason => startLog(`${new Date().toISOString()} start: ${reason}\n`),
      })
      if (saved) startLog(`${new Date().toISOString()} start: settings copied to ${saved}\n`)
      const { target } = await installProfile({ dshHome: join(home, 'dsh'), source: resources.profile })
      pinProfileStore({ target, home, layout: storeLayoutOf(resources.pnpm) })
      laneProfile = target
    },
    // Then the plugins the lane staged go in, and this start is their trial (lane.js).
    lane: () => { if (app.isPackaged) laneTrial = beforeStart({ home, target: laneProfile, log: laneLog }) },
    // Electron's own binary runs dsh as Node, so the app ships one runtime.
    tools: () => { dshTools = { resources, binDir: writeTools({ dir: join(home, 'bin'), node: process.execPath, pnpm: resources.pnpm }) } },
    spawn: port => spawnDsh(port, started),
    // Earlier starts' dsh logins would pile up until dsh refuses the page (dsh.js forgetDshLogins).
    // dsh's page has the default session, and cookies ignore the port.
    forget: port => forgetDshLogins(session.defaultSession.cookies, `http://127.0.0.1:${port}`)
      .catch(error => startLog(`${new Date().toISOString()} start: earlier dsh logins kept (${error.message})\n`)),
    after: () => {
      laneDsh = readVersion(join(dirname(resources.bin), '..', 'package.json'))
      if (app.isPackaged) readStaged()
      aboutPanel()
    },
    // Before the page is made: every webContents from here on keeps to dsh's origin.
    guard: () => harden(() => dshOrigin),
    view: () => { if (window) makePage() },
    load: async (running) => {
      if (!window || !page) return
      // The page comes only from the dsh this start spawned, on the origin the guard keeps to.
      const url = pageUrlOf(running, dshOrigin)
      started.mark('page loading')
      await page.webContents.loadURL(url)
    },
    // Once dsh is up, as before this ran; a page that fails to load must not stop the app from
    // updating.
    updates: () => { if (window && page) watchUpdates() },
  })
}

// What dsh is started with (the app's resources, and the tools on its PATH), for a start and for
// each restart of DSH alone.
let dshTools = null
let dshLog = null

// A start that waited for dsh's last port (dsh.js launchPort) notes it in `steps` (start.log).
const portWaited = steps => (ms, freed) => steps.mark(`waited ${ms} ms for dsh's last port: ${freed ? 'free again' : 'still taken'}`)

// Start dsh on `port` and resolve with it once it is ready. `steps` notes the moments (start.log).
function spawnDsh(port, steps) {
  const { resources, binDir } = dshTools
  dshOrigin = `http://127.0.0.1:${port}`
  dshLog?.end()
  const log = dshLog = createWriteStream(join(home, 'logs', 'dsh.log'), { flags: 'a' })
  // `--preload=omni|genie` from `omni desktop` / `genie desktop`, kept in Automagik's home.
  const preload = preloadOf({ home: root, argv: process.argv, env: process.env })
  // What the person chose to share on the Privacy page (privacy.js): nothing, unless they did.
  const privacy = readChoices(privacyFileOf(home))
  // A new anonymous id every launch (dsh.js ANONYMOUS_ID), unless they chose to keep one.
  if (privacy['stable-id'] !== true) rmSync(join(home, 'dsh', ANONYMOUS_ID), { force: true })
  const overlay = writeOverlay(privacyPatchOf(home), privacy)
  // Something that took the port before dsh bound it gets dsh started on a fresh one.
  const onPort = (next) => {
    steps.mark(`port ${port} taken, dsh on ${next}`)
    dshOrigin = `http://127.0.0.1:${next}`
  }
  // Only a port dsh bound and served on is kept for the next launch (dsh.js serveDsh).
  const onUnkept = error => startLog(`${new Date().toISOString()} start: port not kept (${error.message})\n`)
  const env = dshEnv({ home, electronAsNode: true, binDir, preload, privacy })
  // dsh's web app records its launch URL here (runtime patch web-launch-token-persistence); the
  // launcher reads it when dsh's output is unavailable.
  const urlFile = launchUrlFileOf(join(home, 'dsh'))
  return serveDsh({
    run: dshProcess, portFile: portFileOf(home), node: process.execPath, bin: resources.bin, env,
    urlFile, port, onPort, onUnkept, cwd: home, log, privacy: overlay,
    onSpawn: (child) => {
      laneConfirmation.reset()
      child.on('message', message => answerDsh(child, message))
      steps.mark('dsh spawned')
    },
  })
    .then((running) => {
      dsh = running
      steps.mark('dsh ready')
      // Only the dsh that runs now: one stopped for a restart of DSH alone exits on purpose.
      running.child.once('exit', (code) => {
        if (!quitting && !restartingDsh && dsh === running) fail(new Error(`dsh stopped (${code}).`))
      })
      return running
    })
}

// dsh's page, made while dsh boots and loaded once it is ready.
function makePage() {
  page = new WebContentsView({
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      // Chromium fetches dictionaries from Google on Linux and Windows (a share on the Privacy
      // page); macOS checks spelling itself.
      spellcheck: process.platform === 'darwin' || readChoices(privacyFileOf(home)).spellcheck === true,
    },
  })
  page.setBackgroundColor(tableColor(nativeTheme.shouldUseDarkColors))
  page.webContents.on('before-input-event', (event, input) => shortcut(event, input))
  // dsh's page loads again: its browser panel is gone until it draws again.
  page.webContents.on('did-start-navigation', (event) => { if (event.isMainFrame && !event.isSameDocument) botViews.hideAll() })
  page.webContents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
    if (mainFrame && code !== -3) sendState({ status: `${PRODUCT} could not load (${description}).`, problem: true })
  })
  // Laid in once painted, so the frame's splash stays up until there is something to show.
  page.webContents.once('did-finish-load', async () => {
    if (!window) return
    await page.webContents.insertCSS(PAGE_IN_CSS).catch(() => {})
    if (!window) return
    window.contentView.addChildView(page)
    ready = true
    layout()
    started.mark('page in')
    // An update's splash (splash.js) stays up until this copy has something to show.
    dismissSplash(home)
    if (laneTrial === 'applied' || laneTrial === 'trial') void judgeLane()
    const back = restartLine(RESTART_NOTE(), { version: app.getVersion() })
    if (back) startLog(back)
    if (pendingLink) void connectFromLink()
    schemesTaken ??= registerSchemes(app)
  })
}

// dsh asks over its IPC channel for a Bot's browser endpoint (bots-dsh browser-plugins.js
// appBrowserEndpoint): the relay's address with a fresh token for that Bot.
function answerDsh(child, message) {
  if (message?.type !== 'ds-bot:browser-endpoint' || typeof message.id !== 'string') return
  const reply = (answer) => { if (child.connected) child.send({ type: 'ds-bot:browser-endpoint-response', id: message.id, ...answer }) }
  if (!isBotId(message.botId)) return reply({ error: 'Unknown Bot.' })
  botRelay.endpoint(message.botId, { downloadRoots: message.downloadRoots })
    .then(url => reply({ url }), error => reply({ error: String(error?.message ?? 'The app browser relay is unavailable.') }))
}

// The Bot browser panel's bridge (preload.cjs `dsBotApp.browser`), for dsh's page only.
function browserCall(channel, handle) {
  ipcMain.handle(`automagik-browser-${channel}`, (event, botId, ...rest) => {
    if (!fromPage(event)) throw new Error('Not the app page')
    return handle(botId, ...rest)
  })
}
const botOf = (botId) => {
  if (!isBotId(botId)) throw new Error('Unknown Bot')
  return botId
}
const tabOf = (tabId) => {
  if (!isTabId(tabId)) throw new Error('Unknown browser tab')
  return tabId
}
browserCall('create', (botId, tabId, url) => botViews.create(botOf(botId), { tabId: tabOf(tabId), ...(typeof url === 'string' && url !== '' ? { url } : {}) }).tabId)
browserCall('sync', botId => botViews.sync(botOf(botId)))
browserCall('place', (tabId, rect, visible) => botViews.place(tabOf(tabId), rect && typeof rect === 'object' ? rect : null, visible === true))
for (const operation of ['navigate', 'command', 'focus', 'read', 'close']) {
  browserCall(operation, (botId, tabId, value) => botViews.operate(botOf(botId), operation, { tabId: tabOf(tabId), url: value, command: value, script: value }))
}
browserCall('hold', (botId, held) => botViews.hold(botOf(botId), held === true))
browserCall('forget', key => botViews.forget(botOf(typeof key === 'string' && key.startsWith('bot:') ? key.slice(4) : '')))

// The lane's lines go to the update log, with the app's own update.
function laneLog(message) {
  try { appendFileSync(join(home, 'logs', 'update.log'), `${new Date().toISOString()} info ${message}\n`) } catch {}
}
const readVersion = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')).version } catch { return undefined } }

// This start is a lane trial: the page must draw the Bot team within TRIAL_MS, or the app starts
// again and the previous plugins come back (lane.js beforeStart).
async function judgeLane() {
  if (await teamDrawn()) {
    confirmLane(home)
    laneLog('lane: the trial passed; the Bot team is drawn')
    laneTrial = 'good'
    return
  }
  if (quitting) return
  laneLog('lane: the Bot team never drew; starting again with the previous plugins')
  trialFailed(home)
  restartForLane({ why: 'lane rollback' })
}

// Whether dsh's page draws the Bot team within TRIAL_MS.
async function teamDrawn() {
  const deadline = Date.now() + TRIAL_MS
  while (Date.now() < deadline && page && !page.webContents.isDestroyed() && !quitting) {
    const drawn = await page.webContents.executeJavaScript("Boolean(document.querySelector('.bt-side, .bt-rail, .bt-list'))").catch(() => false)
    if (drawn) return true
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  return false
}

// What the lane has waiting, and what it changes in the profile as it is now.
function readStaged() {
  laneReady = stagedOf(home)
  laneConfirmation.sync({ child: dshProcess.child, since: dshProcess.since, staged: laneReady })
  laneWaiting = laneReady && laneProfile ? changesOf(laneReady.plugins, installedVersions(laneProfile, laneReady.plugins.map(plugin => plugin.name))) : []
}

// About names the version this copy runs: its plugins' (a lane patch, 3.N.P) beside the app's.
function aboutPanel() {
  if (process.platform !== 'darwin') return
  const plugins = pluginsVersion()
  app.setAboutPanelOptions({ applicationName: PRODUCT, applicationVersion: plugins ?? app.getVersion(), version: plugins ? `app ${app.getVersion()}` : app.getVersion() })
}

// The version this copy runs: Automagik's plugins' (3.N.P once a lane patch went in), and
// the app's beside it when they differ.
function pluginsVersion() {
  const ours = Object.values(laneProfile ? installedVersions(laneProfile, PUBLISHERS[0].plugins.filter(name => name.startsWith('@automagik/'))) : {}).sort(compareVersions).at(-1)
  return ours && ours !== app.getVersion() ? ours : null
}
const runningVersion = () => (pluginsVersion() ? `${pluginsVersion()} (app ${app.getVersion()})` : app.getVersion())

// One look at every lane: what it has for this app is downloaded and staged for the next start,
// with the download in the sidebar while it runs. Answers whether anything is staged now. A
// check asked for during the quarter-hour look joins it.
let looking = null
const lookAtLanes = () => (looking ??= lookOnce().finally(() => { looking = null }))
async function lookOnce() {
  laneFailed = false
  if (!app.isPackaged || !laneProfile || !laneDsh || laneTrial === 'applied' || laneTrial === 'trial' || laneApplying) return Boolean(laneReady)
  for (const publisher of PUBLISHERS) {
    try {
      const found = await checkLane({ publisher, onDecision: (decision, version) => laneDecisions.set(publisher.publisher, { ...decision, version }), appVersion: app.getVersion(), dshVersion: laneDsh, installed: installedVersions(laneProfile, publisher.plugins), ...laneMemory(home, publisher.publisher) })
      publishUpdate()
      if (!found || stagedVersion(home, publisher.publisher) === found.version) continue
      laneLog(`lane: ${publisher.publisher} ${found.version} is out; downloading ${found.plugins.map(plugin => `${plugin.name} ${plugin.version}`).join(', ')}`)
      const changes = changesOf(found.plugins, installedVersions(laneProfile, publisher.plugins))
      laneFetching = { version: found.version, percent: 0, changes }
      publishUpdate()
      try {
        await stageLane(found, { home, onProgress: (percent) => { laneFetching = { version: found.version, percent, changes }; publishUpdate() } })
      } finally {
        laneFetching = null
      }
      readStaged()
      laneLog(`lane: ${found.version} is ready${readAutoApply(settingsFileOf(home)) ? ', and goes in by itself once no agent is at work' : ' and goes in at the next start'}`)
      publishUpdate()
    } catch (error) {
      laneDecisions.set(publisher.publisher, { ...laneDecisions.get(publisher.publisher), reason: 'check-failed' })
      // A lane nothing here is installed from has no update to miss.
      if (Object.keys(installedVersions(laneProfile, publisher.plugins)).length > 0) laneFailed = true
      laneLog(`lane: ${publisher.publisher}: ${error.message}`)
      publishUpdate()
    }
  }
  return Boolean(laneReady)
}

// Start again into the staged plugins: the window goes, DSH stops, and the app opens again.
function restartForLane({ away = false, why } = {}) {
  if (quitting) return
  quitting = true
  const out = leave(why ?? (away ? 'lane while away' : 'lane restart'))
  update = { ...update, state: 'restarting', version: laneReady?.version ?? update?.version }
  publishUpdate()
  void fade(window, { to: 0, reduced: lessMotion() })
    .then(async () => { out.mark('window gone'); return prepareAndStop('restart') })
    .finally(() => {
      out.mark('dsh stopped')
      app.relaunch()
      app.exit(0)
    })
}

// What a plugin is called in the app's own words (the update log, the frame's status).
const PLUGIN_NAMES = { '@automagik/bots-dsh': 'Bot team', '@automagik/welcome-dsh': 'Welcome', '@automagik/acp-dsh': 'ACP agents', '@automagik/genie-dsh': 'Genie', '@automagik/locale-pt-br-dsh': 'Português (Brasil)' }
const changeText = changes => changes.map(({ name, from, to }) => `${PLUGIN_NAMES[name] ?? name.replace(/^@[^/]+\//, '')} ${from ? `${from} → ` : ''}${to}`).join(', ')

// Put the staged plugins in now, with DSH restarted alone (auto-apply.js): the window stays, the
// frame says what is updating while DSH is down, and the page loads again into the new plugins.
let applyingLane = null
const laneConfirmation = confirmationBudget({ wake: () => lookForAutoApply() })
function autoApplyReason({ recheck = false } = {}) {
  if (quitting || !window || !page) return 'app stopping'
  return applyNow({
    staged: laneReady, auto: readAutoApply(settingsFileOf(home)),
    busy: laneConfirmation.read(readBusy(busyFileOf(home)), {
      child: dshProcess.child, since: dshProcess.since, staged: laneReady,
    }),
    trial: laneTrial, fetching: laneFetching,
    appUpdate: Boolean(updates?.ready) || update?.state === 'restarting',
    applying: (!recheck && Boolean(laneApplying)) || Boolean(forcing),
    idleMs: powerMonitor.getSystemIdleTime() * 1000,
    focused: window.isFocused() === true,
  })
}
function lookForAutoApply() {
  if (autoApplyReason() === 'apply') void applyLaneNow({ auto: true })
}
// `auto`: the minute's look found a safe moment, and the moment is checked again before DSH stops.
const applyLaneNow = ({ auto = false } = {}) => (applyingLane ??= applyLane({ auto }).finally(() => { applyingLane = null }))
async function applyLane({ auto }) {
  if (quitting || !laneReady || !laneProfile || !dshTools || !page || !window) return
  laneApplying = laneWaiting
  const text = changeText(laneApplying)
  laneLog(`lane: ${laneReady.version} goes in now (${text}); DSH restarts, the window stays`)
  publishUpdate()
  let outcome = 'down'
  let rolledBack = false
  try {
    // The sidebar says it first.
    await new Promise(resolve => setTimeout(resolve, RESTART_NOTICE_MS))
    // An agent started meanwhile: the update waits for the next safe moment.
    if (auto && autoApplyReason({ recheck: true }) !== 'apply') {
      laneLog('lane: an agent started meanwhile; the plugins wait for the next moment no agent is at work')
      outcome = 'waiting'
    } else {
      laneConfirmation.reset()
      outcome = await applyStaged({
        cycle: prepare => cycleDsh(prepare, `Updating ${text}…`),
        beforeStart: () => {
          laneTrial = beforeStart({ home, target: laneProfile, log: laneLog, onRollback: () => { rolledBack = true } })
          return laneTrial
        },
        confirm: () => { confirmLane(home); laneTrial = 'good' },
        trialFailed: () => { rolledBack = true; trialFailed(home) },
        // A quit while the page draws is no verdict on the plugins.
        judge: async () => { if (await teamDrawn()) return true; if (quitting) throw appStopped('the app is quitting'); return false },
        log: laneLog,
      })
    }
  } catch (error) {
    laneLog(`lane: the restart of DSH for the plugins failed: ${error?.message ?? error}`)
  } finally {
    laneApplying = null
  }
  laneOutcome = rolledBack ? 'restored' : outcome
  if (outcome === 'waiting') return void publishUpdate()
  laneLog(`lane: the restart of DSH for the plugins ended: ${outcome}`)
  if (outcome === 'down') return restartForLane({ why: 'lane, DSH down' })
  readStaged()
  aboutPanel()
  publishUpdate()
}

// Stop DSH, run `prepare` while it is down, start it again on its port and load the page into it.
// The frame shows `status` meanwhile. Answers what `prepare` answered.
async function cycleDsh(prepare, status, reason = forcing ? 'force' : 'lane') {
  const out = steps('dsh restart', { write: startLog, since: Date.now() })
  restartingDsh = true
  try {
    ready = false
    if (window && page) window.contentView.removeChildView(page)
    botViews.hideAll()
    sendState({ ready: false, status })
    // The Bot team opens the same chat again once the page is back (bots-dsh reopen.js).
    await page?.webContents.executeJavaScript("try { sessionStorage.setItem('omni-ui:reopen', '1') } catch {}").catch(() => {})
    await prepareAndStop(reason)
    out.mark('dsh stopped')
    if (quitting) throw appStopped('the app is quitting')
    dshProcess = dshRun()
    const prepared = prepare()
    const running = await spawnDsh(await launchPort(portFileOf(home), undefined, { onWaited: portWaited(out) }), out)
    await forgetDshLogins(session.defaultSession.cookies, dshOrigin).catch(() => {})
    if (!window || !page || page.webContents.isDestroyed()) throw appStopped('the window is gone')
    await page.webContents.loadURL(pageUrlOf(running, dshOrigin))
    await page.webContents.insertCSS(PAGE_IN_CSS).catch(() => {})
    window.contentView.addChildView(page)
    ready = true
    layout()
    sendState({ ready: true })
    out.mark('page in')
    return prepared
  } catch (error) {
    // DSH stopped under a quit: that is the app's doing, not the plugins'. A quit that came while no
    // DSH process ran yet stopped this dshProcess before it spawned (before-quit).
    throw causeOf(error, { quitting, stopped: dshProcess.stopped })
  } finally {
    restartingDsh = false
  }
}

// See update.js. Its log is logs/update.log.
function watchUpdates() {
  const mode = updateMode({ packaged: app.isPackaged, platform: process.platform, env: process.env })
  if (!mode || updates) return
  const out = createWriteStream(join(home, 'logs', 'update.log'), { flags: 'a' })
  const line = level => message => out.write(`${new Date().toISOString()} ${level} ${message}\n`)
  const log = { info: line('info'), warn: line('warn'), error: line('error'), debug() {} }
  log.info(`update: ${app.getVersion()} checks for updates (${mode})`)
  updates = startUpdates({
    updater: updaterModule.autoUpdater,
    current: app.getVersion(),
    platform: process.platform,
    env: process.env,
    log,
    mode,
    onState: (state) => {
      update = state
      checkFailed = false
      publishUpdate()
    },
  })
  // The lanes are looked at a minute after the start, then every quarter hour like the app:
  // a lane is two small files, and a patch should show up soon after it is out.
  setTimeout(() => void lookAtLanes(), 60_000).unref?.()
  setInterval(() => void lookAtLanes(), CHECK_EVERY_MS).unref?.()
  // Plugins the lane staged go in by themselves once no agent is at work (auto-apply.js), with
  // DSH restarted alone; switched off, they wait for a Restart, a quit or the next start.
  setInterval(lookForAutoApply, LOOK_EVERY_MS).unref?.()
  // A downloaded app update never goes in by itself (#859): the app keeps running the version it
  // has, the sidebar says "Restart to update", and it installs when the person presses that or
  // quits the app.
}

// The update shows in the page's sidebar (the Bot team's, bottom left, as in DSH's own app),
// through the page's preload (preload.cjs `omniDesktop.updates`).
const presentUpdate = () => ({ ...updatePresentation(update, {
  checking, failed: checkFailed, plugins: laneReady?.version, fetching: laneFetching,
  lane: { changes: laneApplying ?? laneWaiting, auto: readAutoApply(settingsFileOf(home)), applying: Boolean(laneApplying) },
}), ...(forceState ? { force: forceState } : {}) })
function publishUpdate() {
  if (page && !page.webContents.isDestroyed()) page.webContents.send('automagik-updates', presentUpdate())
}
const fromPage = event => page !== null && event.sender === page.webContents
// The composer's unsent drafts (drafts.js, #141), for dsh's page only and only while its main
// frame is on dsh's origin: the page's preload takes them back as it starts, when the origin is
// not the one they were kept on, and sends them as they change. The origin kept with them is the
// one dsh serves, never one the page names. The take is synchronous in the page, so it only reads
// (and at most rewrites) one small file and always answers: { moved, entries }, or null, which
// tells the preload to keep out.
const draftsFrom = event => fromPage(event) && event.senderFrame != null
  && event.senderFrame === page.webContents.mainFrame && event.senderFrame.origin === dshOrigin
ipcMain.on('automagik-drafts-take', (event) => {
  let back = null
  try { if (draftsFrom(event)) back = takeDrafts(draftsFileOf(home), dshOrigin) } catch {}
  event.returnValue = back
})
ipcMain.on('automagik-drafts-keep', (event, entries) => {
  try { if (draftsFrom(event)) saveDrafts(draftsFileOf(home), dshOrigin, entries) } catch {}
})
// The page's drafts as they are now, kept before dsh is stopped for a restart of DSH alone or a
// quit: the page's own last send may be up to its interval old, and the next dsh may serve on
// another origin, where this page's sends are refused.
// Never holds a restart or a quit: a page that does not answer in a second keeps its last send.
async function keepPageDrafts() {
  if (!page || page.webContents.isDestroyed()) return
  const origin = dshOrigin
  try {
    if (page.webContents.mainFrame?.origin !== origin) return
    const entries = await Promise.race([
      page.webContents.executeJavaScript(PAGE_DRAFTS),
      new Promise(done => setTimeout(done, 1000, null)),
    ])
    if (entries !== null && !page.webContents.isDestroyed() && page.webContents.mainFrame?.origin === origin && dshOrigin === origin) {
      saveDrafts(draftsFileOf(home), origin, entries)
    }
  } catch {}
}

// Before DSH stops for an update, a lane, a restart or a quit: the drafts are kept, then DSH's
// plugins get a bounded moment to end sign-ins and conversations cleanly (prepare-restart.js).
// A plugin that does not answer in time changes nothing: the stop goes on.
async function prepareAndStop(reason, stop = () => dshProcess.stop()) {
  await keepPageDrafts()
  const outcome = await prepareRestart(dshProcess.child ?? dsh?.child, { reason })
  laneLog(`prepare restart: ${outcome.ok ? 'prepared' : outcome.why}`)
  return stop()
}

// About's Force update (force-update.js): conversations stop, everything available goes in, and
// DSH (or the whole app, for an app update) restarts.
const forceDeps = {
  appReady: () => Boolean(updates?.ready),
  appMode: () => updateMode({ packaged: app.isPackaged, platform: process.platform, env: process.env }),
  check: async () => updates?.check(),
  waitAppReady: options => updates?.whenReady(options) ?? false,
  installApp: installUpdate,
  lookLanes: async () => { await lookAtLanes(); return versionsAnswer({ reason: pluginReason() }).reason },
  laneStaged: () => Boolean(laneReady),
  applyLane: async () => { laneOutcome = 'down'; await applyLaneNow({ auto: false }); return laneOutcome },
  restartDsh: async () => {
    try { await cycleDsh(() => null, 'Restarting…', 'force') } catch (error) {
      restartForLane({ why: 'force, DSH down' })
      throw error
    }
  },
  publish: state => { forceState = state; publishUpdate() },
  log: laneLog,
}

ipcMain.handle('automagik-updates-force', (event) => {
  if (!draftsFrom(event) || quitting) return null
  return (forcing ??= Promise.resolve(applyingLane).then(() => forceUpdate(forceDeps)).finally(() => { forcing = null }))
})

// The profile can carry plugins outside the publishers followed by the lane.
function profilePlugins() {
  try { return Object.keys(JSON.parse(readFileSync(join(laneProfile, 'package.json'), 'utf8')).dependencies ?? {}) } catch { return [] }
}
function pluginReason() {
  const decisions = PUBLISHERS.filter(publisher => laneProfile && Object.keys(installedVersions(laneProfile, publisher.plugins)).length > 0)
    .map(publisher => laneDecisions.get(publisher.publisher))
  const decision = decisions.find(value => value.reason && value.reason !== 'up-to-date')
  return decision ? { code: decision.reason, params: { line: decision.line, base: decision.base, version: decision.version, app: app.getVersion() } } : null
}

ipcMain.handle('automagik-updates-status', event => (fromPage(event) ? presentUpdate() : null))
// The sidebar's update button: restart into a downloaded update, open the release page of one
// this copy cannot install itself (a deb), or check.
ipcMain.handle('automagik-updates-open', async (event) => {
  if (!fromPage(event) || forcing) return
  if (updates?.ready) return installUpdate()
  if (laneReady && update?.state !== 'available') return void applyLaneNow()
  if (update?.state === 'available' && isReleasePage(update.page)) return void shell.openExternal(update.page)
  await checkForUpdates({ quiet: true })
})
// About's Check for updates: a check and nothing else. Unlike `open` above it never restarts
// into a downloaded update and never puts staged plugins in by itself.
ipcMain.handle('automagik-updates-check', async (event) => {
  if (fromPage(event)) await checkForUpdates({ quiet: true })
})
// What this copy is, for About: version text only (frame.js versionsAnswer).
ipcMain.handle('automagik-updates-versions', event => (fromPage(event) ? versionsAnswer({
  app: app.getVersion(),
  dsh: laneDsh,
  plugins: laneProfile ? { ...installedVersions(laneProfile, PUBLISHERS.flatMap(publisher => publisher.plugins)), ...installedVersions(laneProfile, profilePlugins()) } : {},
  latest: Object.fromEntries([...laneDecisions.values()].flatMap(decision => decision.plugins.map(plugin => [plugin.name, plugin.version]))),
  reason: pluginReason(),
  appUpdate: updates?.appUpdate ?? null,
  force: forceState,
  mode: updateMode({ packaged: app.isPackaged, platform: process.platform, env: process.env }),
}) : null))
// The plugins' own notice: put the staged plugins in now, with DSH restarted alone.
ipcMain.handle('automagik-updates-apply-plugins', (event) => {
  if (fromPage(event) && laneReady && !forcing) void applyLaneNow()
})
// The setting "Apply plugin updates automatically" (About → Updates).
ipcMain.handle('automagik-updates-auto-apply', (event, on) => {
  if (!fromPage(event) || typeof on !== 'boolean') return null
  const saved = writeAutoApply(settingsFileOf(home), on)
  publishUpdate()
  return saved
})

// Code mode (RFC 0013, deliveries 1, 2 and 4): Herdr's state, and its window brought forward on
// a click in the page (preload.cjs `omniDesktop.herdr`). The page sends a Bot id and, to an
// offer of a newer Herdr, the person's yes or no; nothing else (openRequest drops the rest).
// Once the window is open, main looks up the Bot's folder itself and shows its space
// (herdr-space.js); an unknown Bot, or one with no folder, gets no space picked. One open at a
// time. herdrdev's feed is read on an open only, never here at boot. A yes is honoured only for
// a pending offer. A version declined is not offered again until the app restarts (kept in
// memory only). logs/switch.log has the steps.
const herdrHost = () => ({ platform: process.platform, arch: process.arch, env: process.env, home: homedir() })
const switchLog = (line) => { try { appendFileSync(join(home, 'logs', 'switch.log'), line) } catch {} }
let herdrOpening = null
let herdrOffered = null
let herdrDeclined = null
ipcMain.handle('automagik-herdr-status', event => (fromPage(event) ? herdrStatus(herdrHost()) : null))
ipcMain.handle('automagik-herdr-open', (event, request) => {
  if (!fromPage(event)) return null
  const { botId, update } = openRequest(request)
  herdrOpening ??= (async () => {
    const timed = steps(`switch${botId ? ` ${botId}` : ''}`, { write: switchLog, since: Date.now() })
    const log = what => switchLog(`${new Date().toISOString()} switch: ${what}\n`)
    try {
      if (update === false && herdrOffered) herdrDeclined = herdrOffered
      // A yes counts only for the version this session offered (openLatest checks the feed
      // still names it); any other open clears the offer.
      const result = await openLatest({ ...herdrHost(), update, offered: herdrOffered, skip: herdrDeclined, mark: timed.mark, log })
      herdrOffered = result.reason === 'update' ? result.latest : null
      if (!result.ok) return result
      log(`opened${result.raised === true ? '' : ' (no focus)'}`)
      const found = findHerdr(herdrHost())
      const space = found ? await pickSpace({ ...herdrHost(), botId, found, appHome: home, mark: timed.mark, log }) : { action: 'none' }
      return { ...result, space }
    } catch (error) {
      log(`failed ${error?.message ?? error}`)
      return { ok: false, reason: 'error', message: "Herdr didn't open" }
    } finally {
      herdrOpening = null
    }
  })()
  return herdrOpening
})

// Check for Updates (the app menu, the title bar's menu, the sidebar): the sidebar shows the
// check and what it found; asked from a menu, a check that finds nothing says so in a dialog.
async function checkForUpdates({ quiet = false } = {}) {
  if (!updates) {
    if (!quiet) void dialog.showMessageBox(window ?? undefined, { type: 'info', message: `Updates are off in this copy of ${PRODUCT}` })
    return
  }
  checking = true
  checkFailed = false
  publishUpdate()
  // The app's own releases and the plugin lane, at once: a check finds either.
  const [{ result, retrying }, staged] = await Promise.all([updates.check(), lookAtLanes().catch(() => false)])
  checking = false
  checkFailed = result === 'error' && !retrying
  // A lane that could not be read is a failed check too, when the check found nothing else:
  // "up to date" would not be true.
  const laneMissed = laneMissedOf({ result, laneFailed, staged: Boolean(laneReady) })
  if (laneMissed) checkFailed = true
  publishUpdate()
  if (quiet) return
  if (result === 'latest' && staged && laneReady) {
    const { response } = await dialog.showMessageBox(window ?? undefined, { type: 'info', buttons: ['Update now', 'Later'], defaultId: 0, cancelId: 1, message: `${PRODUCT} ${laneReady.version} is ready`, detail: `${changeText(laneWaiting)}. It goes in when DSH restarts, in a few seconds; the window stays.${readAutoApply(settingsFileOf(home)) ? ' Later, it goes in by itself once no agent is at work.' : ''} You have ${runningVersion()}.` })
    if (response === 0) void applyLaneNow()
  } else if (result === 'latest' && !laneMissed) void dialog.showMessageBox(window ?? undefined, { type: 'info', message: `${PRODUCT} is up to date`, detail: `Version ${runningVersion()}` })
  else if ((result === 'error' && !retrying) || laneMissed) void dialog.showMessageBox(window ?? undefined, { type: 'warning', message: 'Could not check for updates', detail: 'Check your connection and try again.' })
}

// The title bar's menu, on a right click; on macOS the app menu has the same entries.
function barMenu() {
  const items = [{ label: 'Check for Updates…', click: () => void checkForUpdates() }]
  if (dshTuiSupported()) items.push({ label: DSH_TUI_LABEL, click: () => void openDshTuiSetup() })
  return Menu.buildFromTemplate(items)
}

// DSH as a Herdr agent (#561): the shared installer (am/dshTui.mjs) runs in a child process;
// this is the desktop's opt-in dialog, its log, and the PATH line it asks about. The installer's
// pin, profile, shim, doctor and release-age rules are the module's, never repeated here.
let dshTuiRunning = false
const dshTuiPaths = () => ({
  packaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  appPath: app.getAppPath(),
})
const dshTuiModule = () => dshTuiModuleDir(dshTuiPaths())
const dshTuiLog = (line) => {
  try {
    appendFileSync(join(home, 'logs', DSH_TUI_LOG), `${new Date().toISOString()} ${line}\n`)
  } catch {}
}
const askDshTui = async (view) => {
  const { response } = await dialog.showMessageBox(window ?? undefined, {
    type: view.type ?? 'info',
    message: view.message,
    detail: view.detail,
    buttons: view.buttons.map(button => button.label),
    defaultId: view.defaultId ?? 0,
    cancelId: view.cancelId ?? view.buttons.length - 1,
    noLink: true,
  })
  return view.buttons[response]?.id ?? 'close'
}
const runDshTuiAction = async (action) => {
  const answer = await runDshTui({
    action, moduleDir: dshTuiModule(), runner: dshTuiRunnerOf(dshTuiPaths()),
  })
  const checks = answer.result?.checks ? formatDoctor(answer.result.checks).split('\n') : null
  const lines = answer.ok
    ? (answer.result?.lines ?? checks ?? [answer.result?.detail])
    : [answer.error]
  for (const line of (lines ?? []).filter(Boolean)) dshTuiLog(`${action}: ${line}`)
  return answer
}
async function withDshTuiProgress(text, work) {
  window?.setProgressBar(2, { mode: 'indeterminate' })
  sendState({ status: text })
  try { return await work() } finally {
    window?.setProgressBar(-1)
    sendState({ status: '' })
  }
}
async function openDshTuiSetup() {
  if (dshTuiRunning) return
  dshTuiRunning = true
  try {
    let answer = await runDshTuiAction('doctor')
    for (;;) {
      const choice = await askDshTui(setupView({ answer }))
      if (choice === 'close') return
      if (choice === 'uninstall') {
        const { response } = await dialog.showMessageBox(window ?? undefined, {
          type: 'question',
          message: 'Uninstall dsh-TUI?',
          detail: `Removes dsh-TUI from the ${answer.profile ?? 'dsh-tui'} DSH profile and the `
            + `shim this installer wrote. DSH sessions, dsh-TUI's own state and the profile stay.`,
          buttons: ['Uninstall', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
        })
        if (response !== 0) continue
      }
      const result = await withDshTuiProgress(
        choice === 'uninstall' ? 'Removing dsh-TUI…' : 'Installing dsh-TUI…',
        () => runDshTuiAction(choice),
      )
      await askDshTui(resultView({ action: choice, answer: result }))
      const installed = result.ok
        && result.result?.status !== 'skipped' && result.result?.status !== 'failed'
      if (choice === 'install' && installed) await offerDshTuiPath(result)
      answer = await runDshTuiAction('doctor')
    }
  } finally {
    dshTuiRunning = false
  }
}
async function offerDshTuiPath(answer) {
  const action = pathActionOf({ pane: answer.pane, home: homedir() })
  if (!action || await askDshTui(pathView(action)) !== 'add-path') return
  try {
    const written = ensurePathLine({ action })
    dshTuiLog(written.changed
      ? `path: added ${action.line} to ${action.config}`
      : `path: ${action.config} already names the user bin folder`)
    await askDshTui(pathDoneView(action))
  } catch (error) {
    dshTuiLog(`path: could not write ${action.config}: ${error?.message ?? error}`)
    await askDshTui({
      type: 'warning',
      message: 'Could not write the PATH line',
      detail: `${action.config}: ${error?.message ?? error}`,
      buttons: [{ id: 'close', label: 'Close' }],
    })
  }
}

// Restart into the downloaded update: dsh is stopped first, as on any quit. macOS then checks
// the new app before it opens it, and the app opened again meanwhile cancels the install. So
// the sidebar says "Installing" before the window goes, and on macOS a splash (splash.js)
// stays on screen while macOS swaps the app, until the new copy's page is in; where the
// splash cannot go up, a notification says it instead. Only the person's Restart comes here
// (the sidebar's button, `automagik-updates-open`): nothing calls it on a timer.
const RESTART_NOTICE_MS = 600
function installUpdate() {
  if (!updates?.ready || quitting) return
  quitting = true
  const out = leave('update restart')
  update = { ...update, state: 'restarting' }
  publishUpdate()
  const splash = showUpdateSplash({ home, product: PRODUCT, version: update?.version, dark: nativeTheme.shouldUseDarkColors })
  if (!splash && process.platform === 'darwin' && Notification.isSupported()) {
    new Notification({ title: `Updating ${PRODUCT}`, body: `${PRODUCT} reopens by itself in about a minute. Leave it closed until then.`, silent: true }).show()
  }
  setTimeout(() => {
    void fade(window, { to: 0, reduced: lessMotion() })
      .then(async () => { out.mark('window gone'); return prepareAndStop('app-update') })
      .finally(() => {
        out.mark('dsh stopped')
        noteRestart(RESTART_NOTE(), { from: app.getVersion(), to: update?.version })
        // The splash's bar moves on: this copy is closed, and macOS takes over.
        markSplashStep(home, 'installing')
        updates.install()
      })
  }, RESTART_NOTICE_MS)
}

const WINDOW_PREFERENCES = {
  preload: join(HERE, 'shell-preload.cjs'),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webviewTag: false,
  spellcheck: false,
}

// The system turned light or dark: the table under dsh's page (and macOS's solid window) turns
// with it. The frame page follows on its own (prefers-color-scheme).
function followTheme() {
  const color = tableColor(nativeTheme.shouldUseDarkColors)
  page?.setBackgroundColor(color)
  if (process.platform === 'darwin') window?.setBackgroundColor(color)
}

function openWindow() {
  window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    title: PRODUCT,
    show: false,
    ...windowChrome(process.platform, { dark: nativeTheme.shouldUseDarkColors }),
    webPreferences: WINDOW_PREFERENCES,
  })
  const frame = window.webContents
  frame.setWindowOpenHandler(() => ({ action: 'deny' }))
  frame.on('will-navigate', event => event.preventDefault())
  frame.on('before-input-event', (event, input) => shortcut(event, input))
  frame.once('did-finish-load', () => sendState())
  window.once('ready-to-show', () => {
    started.mark('window shown')
    void fade(window, { to: 1, reduced: lessMotion() })
  })
  // Closing fades the window out first; 'closed' and quitting follow. A running bot is asked
  // about first (quitGuard): Cancel keeps the window and dsh exactly as they are. The fade and
  // the question go one after the other (closeAfterFade): a bot that starts while the window
  // fades brings it back and is asked about, and a close with nothing to ask is settled before
  // the window goes, so the quit behind it never asks with no window left.
  window.on('close', (event) => {
    if (closing || quitting) return
    const askToQuit = () => requestQuit({ guard: quitGuard, parent: window, beginQuit: stopAndQuit })
    if (quitGuard.needs()) {
      event.preventDefault()
      void askToQuit()
      return
    }
    // No fade on Linux: the window closes now, on the answer just read.
    if (process.platform === 'linux') { quitGuard.settle(); return }
    event.preventDefault()
    closing = true
    const out = leave('quit')
    void closeAfterFade({
      guard: quitGuard,
      fadeOut: () => fade(window, { to: 0, reduced: lessMotion() }),
      fadeIn: () => { closing = false; leaving = null; return fade(window, { to: 1, reduced: lessMotion() }) },
      reveal: () => { window?.setOpacity(1); window?.show() },
      ask: askToQuit,
      destroy: () => { out.mark('window gone'); window?.destroy() },
      log: quitLog,
    })
  })
  for (const change of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) window.on(change, layout)
  window.on('closed', () => { window = null; page = null })
  void window.loadFile(join(HERE, 'shell.html'))
}

// dsh's page goes below the frame's title bar; see frame.js.
function layout() {
  if (!window) return
  if (page && ready) {
    const { bounds, radius } = windowPageLayout(window)
    page.setBounds(bounds)
    page.setBorderRadius(radius)
    pageRadius = radius
    botViews.relayout()
    // Full screen hides the traffic lights: the sidebar's top row takes their room back.
    page.webContents.send('automagik-window', { fullScreen: window.isFullScreen() })
  }
  sendState()
}

function sendState(extra = {}) {
  if (!window || window.webContents.isLoading()) return
  const maximized = window.isMaximized() || window.isFullScreen()
  window.webContents.send('omni-window-state', { maximized, ready, ...extra })
}

ipcMain.on('omni-window', (event, action) => {
  if (!window || event.sender !== window.webContents || !WINDOW_ACTIONS.has(action)) return
  if (action === 'menu') barMenu().popup({ window })
  else if (action === 'minimize') window.minimize()
  else if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize()
  else window.close()
})

// Without a menu on Linux, the few shortcuts a window is expected to have.
function shortcut(event, input) {
  if (input.type !== 'keyDown' || process.platform === 'darwin') return
  const key = input.key.toLowerCase()
  const zoom = page?.webContents
  if (input.control && key === 'q') app.quit()
  else if (input.key === 'F11') window?.setFullScreen(!window.isFullScreen())
  else if (input.control && (key === '=' || key === '+') && zoom) zoom.setZoomLevel(zoom.getZoomLevel() + 0.5)
  else if (input.control && key === '-' && zoom) zoom.setZoomLevel(zoom.getZoomLevel() - 0.5)
  else if (input.control && key === '0' && zoom) zoom.setZoomLevel(0)
  else return
  event.preventDefault()
}

// `origin` answers dsh's origin as it is now (a dsh started again on another port moves it).
function harden(origin) {
  // Every webContents but a Bot view's, which bot-views.js gives rules of its own.
  app.on('web-contents-created', (_event, contents) => {
    guardContents(contents, { origin, openExternal: url => shell.openExternal(url), isBotView: view => botViews.owns(view) })
  })
  // The page asks for notifications, the clipboard, and the microphone for voice chat (audio
  // only, never the camera); macOS asks the person once for the microphone, with the app's
  // usage line (electron-builder.yml).
  const allowed = (contents, permission, details = {}) => {
    if (new URL(contents.getURL()).origin !== origin()) return false
    if (permission === 'media') return !(details.mediaTypes ?? []).includes('video') && details.mediaType !== 'video'
    return ['notifications', 'clipboard-sanitized-write', 'clipboard-read'].includes(permission)
  }
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (!allowed(contents, permission, details)) return callback(false)
    if (permission !== 'media' || process.platform !== 'darwin') return callback(true)
    void systemPreferences.askForMediaAccess('microphone').then(callback, () => callback(false))
  })
  // What the page reads back about the microphone (navigator.permissions) follows the same
  // rule; every other check keeps Electron's own answer.
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
    (permission === 'media' ? contents !== null && allowed(contents, permission, details) : true))
}

app.on('window-all-closed', () => app.quit())
app.once('will-quit', () => { botRelay.dispose(); botViews.dispose(); botCursor.dispose() })
// Cmd+Q, the window's close button and window-all-closed all come through here: a running bot
// is asked about first. The quit is held while the guard answers; Cancel leaves the app and dsh
// running, and clean/Quit runs the clean stop (stopAndQuit). A busy file that is missing or
// unreadable asks nothing, so an older welcome or a dsh that is not up quits as it always has.
app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  void requestQuit({ guard: quitGuard, parent: window, beginQuit: stopAndQuit })
})

function stopAndQuit() {
  if (quitting) return
  // Nothing spawned yet: the quit goes on, and a dsh that spawns after it is stopped. The app is
  // quitting from here: a restart of DSH alone under way must not take the stop for its plugins'.
  if (!dshProcess.child) { quitting = true; return dshProcess.stop().finally(() => app.quit()) }
  quitting = true
  const out = leave('quit')
  // The window goes at once; dsh stops behind it, so a quit never looks stuck.
  return fade(window, { to: 0, reduced: lessMotion() })
    .then(async () => { out.mark('window gone'); return prepareAndStop('quit', () => dshProcess.stop()) })
    .finally(() => { out.mark('dsh stopped'); app.quit() })
}
