import { SessionFileApproval, selectSessionFileApproval } from './session-file-approval.js'
import { call } from './api.js'
import { OmniMark, installFavicon } from './logo.js'
import * as icons from './icons.js'
import { setCanvasRenderer } from './canvas-slot.js'
import { badges, botChildren, botSettings, chatSuggestions, composerPacks, headerButtons, mountShellInstallers, nav, onShell, registerComposerPack, sidebarTools, toolCards } from './extend.js'
import { BUILTIN_PACKS, packCellSync, stepsAside } from './composer-packs.js'
import { COMPOSER_PACK_CSS, packModelCell } from './composer-pack-cells.js'
import { agentRowSessions, TASK_CSS } from './task-card.js'
import { LIVE_CSS, LiveTab } from './live-rail.js'
import { advancedBot, installLiveTab, installSimpleControls, sidebarActions } from './native-sidebar.js'
import { LAMP_CSS } from './lamp.js'
import { isHex, inkText, paintCss } from './inks.js'
import { CHARACTERS, DEFAULT_MASK, MAIN_LOOK, SHAPES, markupCache, maskOf } from './characters.js'
import { createSource, EMPTY_ROSTER, indexRoster, isAgentSession } from './sources.js'
import { teamActions } from './team-actions.js'
import { themeCss, shellTokens, registry, registerShape, registerTheme, allThemes, layoutOf, widthOf, flatWidthOf } from './themes.js'
import { markConversation } from './stage.js'
import { MENTION_ORIGIN, currentPart, relativeShort } from './text.js'
import { SHELL_CSS, CONVERSATION_CSS, installStyles, installCompiledStyles } from './styles.js'
import { BotMark, lookOf } from './mark.js'
import { TeamSidebar, ChannelsMoved, YouAvatar, AccountLauncher, FooterAccount, BrandMark, BrandName, BotReturn, SIDEBAR_CSS, RETURN_CSS, holdShellShortcuts, openHarnessOnboarding, openHarnessSettings } from './sidebar.js'
import { HeaderPill, NativeBotHeader, NativeControlsNote } from './header.js'
import { ComposerPermission, ComposerPlus, ComposerVoice, menuIcons } from './composer.js'
import { CHATS_SOURCE, atSources } from './at-menu.js'
import { BtwDock, BtwTurnTail } from './btw.js'
import { SIDE_CSS, sideSource } from './side-chat.js'
import { VOICE_BUNDLE } from './speech.js'
import { sameVersion } from './dsh-offer.js'
import { QuestionCard, QuestionDock } from './questions.js'
import { DesktopUpdate, DESKTOP_UPDATE_CSS } from './desktop-update.js'
import { WORK_CODE_SWITCH_CSS } from './work-code-switch.js'
import { PRIVACY_CSS } from './privacy.js'
import { AGENT_ACCESS_CSS } from './agent-access.js'
import { PET_CSS } from './pet.js'
import { CHARACTER_SELECT_CSS } from './character-select.js'
import { VOICE_SETTINGS_CSS } from './voice-settings.js'
import { IMAGE_CELL_CSS } from './image-cell.js'
import { ChildApprovalDock, TeamApproval, TEAM_APPROVAL_CSS, isTeamApproval } from './team-approval.js'
import { AnsweredReply, WidgetDock, WIDGET_CSS } from './widget-cell.js'
import { HandoffDock, HANDOFF_CSS } from './handoff-card.js'
import { headerNavigation, installHeaderNavigation } from './header-navigation.js'
import { AssistantCell, TriggerCell, TurnProcessCell, Nothing, CellEmpty, TurnTailCell, ToolCell } from './cells.js'
import { Overlays } from './overlays.js'
import { createBotBrowsers, serveBrowserReads } from './bot-browsers.js'
import { BROWSER_CSS } from './browser-pane.js'
import { SECRET_CSS, SecretDock } from './secret-card.js'
import { PermissionChoiceDock } from './permission-card.js'
import { MODEL_CSS, ModelChoiceDock, ModelChoiceTail, ModelLineTail, DeepSeekSignIn } from './model-menu.js'
import { announceCarried, CLI_LOGIN_CSS, CliLoginConversation, installCliLoginBridge, installKnownStateGuard } from './cli-login.js'
import { createCliLogin } from './cli-login-state.js'
import { cliLoginBotOf } from './cli-login-model.js'
import { BOT_SETTINGS_CSS } from './bot-settings.js'
import { AVATAR_LIBRARY_CSS } from './avatar-library.js'
import { GROUP_SETTINGS_CSS } from './group-settings.js'
import { FOLDER_CSS } from './folder-menu.js'
import { USAGE_CSS } from './usage-page.js'
import { SCHEDULE_CSS } from './schedules.js'
import { STORAGE, migrateStorage } from './storage.js'
import { rememberOpen, takeReopen } from './reopen.js'
import { noteLeft, setUnread, sharedMap, toggleReaction } from './shared-map.js'
import { freePriority, groupsFor, readMode, surfaceGroups, writeMode } from './surface.js'
import { addStrings, dateLocale, hostText, installLocale, language, t } from './i18n.js'
import { allowPlace } from './places.js'
import { noteClientError, quietly } from './diagnostics.js'
import { RIGHTBAR_ATTRIBUTES, columnOpened, createSwitchWindow, drawerOpened, rightColumnOpen } from './right-panel.js'
import { ErrorToast, FEEDBACK_CSS } from './feedback.js'
import { ABOUT_CSS } from './about.js'
import { MEMBER_CSS, MemberDock } from './member-status.js'
import { SUGGEST_CSS, SuggestionDock } from './suggestions.js'
import { USER_MESSAGE_CSS, UserMessageCell, canDrawUserMessages } from './user-message.js'
import { noticeApprovals } from './approval-notices.js'
import { listedOpener } from './open-listed.js'

export const inject = ['sessions', 'uiWorkspace', 'uiConversation', 'slots', 'theme', 'layout']
// What a state answer carries that is not roster data, or is kept apart from it.
const LIVE_OWN = new Set(['revision', 'unchanged', 'activity', 'work', 'memoryNews', 'memoryReviews'])

// What other Omni plugins build on (the channels and canvas plugins, which require this
// bundle through `dsh.client.external`). They share this module instance: one interface
// dictionary, one roster, and the registries of extend.js.
let currentFace = null
export const omni = Object.freeze({
  // The host's POST /api/omni-ui, which their own host halves extend.
  call,
  // Copy in this plugin's namespace; addStrings brings a plugin's Chinese copy.
  t, addStrings, hostText, language, dateLocale,
  // The Bot surface: what runs while it is up, and what draws in its places.
  onShell, toolCards, nav, badges, botChildren, headerButtons, sidebarTools, botSettings, chatSuggestions, registerComposerPack, setCanvasRenderer,
  // Parts of the Bot surface a plugin's own views are drawn with.
  ui: Object.freeze({ icons, OmniMark, BotMark, MAIN_LOOK, CHARACTERS, relativeShort, createSource }),
  // The roster and actions of the running surface, or null before it runs.
  face: () => currentFace?.() ?? null,
})

// DSH's own settings pages (its ui-settings plugins), which Harness settings already lists.
const DSH_SETTINGS = new Set(['general', 'account', 'models', 'agent-presets', 'plugins'])

export function apply(ctx) {
  ctx.effect(() => installLocale(ctx.get('locale')), 'ds-bot: interface copy')
  const roster = createSource(EMPTY_ROSTER)
  // A Bot's own browser hold, from the team view, where no browser bridge reports holds.
  const hostHolds = createSource({})
  migrateStorage()
  const unreadStore = sharedMap(STORAGE.unread)
  const reactionStore = sharedMap(STORAGE.reactions)
  // When each conversation was last left; a visit compares new turns against it.
  const seenStore = sharedMap(STORAGE.seen)
  let seenAt = seenStore.read()
  // `details` is the panel's subject (a Session id); `view` picks details or the
  // subject Bot's browser inside it.
  const ui = createSource({ details: null, view: 'details', renaming: false, tab: null, side: null, newChat: null, exchange: null, menu: null, voice: null, palette: null, quote: null, settings: null, memory: null, toast: null, signIn: null, renameAgent: null, unread: unreadStore.read(), reactions: reactionStore.read(), visits: {} })
  // Bot mode paints the whole team surface; Agent mode withdraws every slot and
  // style so the shell's own interface returns. `plain` stays false until a Bot-mode
  // view hosts a plain session, which drops only the conversation replacements.
  const surface = createSource({ mode: readMode(), plain: false })
  // DSH Agent Session ids from the last pull, so a reload already knows the main
  // view is a plain Session before the team answers.
  let agentSessionCache = new Set()
  try { agentSessionCache = new Set(JSON.parse(localStorage.getItem(STORAGE.agentSessions) ?? '[]')) } catch { agentSessionCache = new Set() }
  // Sessions adopted on this window (workspace pick, fork) but not yet in the roster.
  const pendingAdopt = new Map()
  // Bot ownership is distinct from standalone Agent ownership and native rendering.
  const pendingBot = new Map()
  let nativeDestination
  const isAgentSessionId = id => isAgentSession(roster.getSnapshot(), agentSessionCache, id) || pendingAdopt.has(id) || pendingBot.has(id) || (id !== undefined && id === nativeDestination)
  const agentOfSession = id => roster.getSnapshot().agentOf[id] ?? pendingAdopt.get(id)
  // The workspace a Session lives in, for follow-up creates and switch detection.
  const workspaces = ctx.get('workspaces')
  const workspaceOf = (sessionId) => {
    const items = workspaces?.list?.getSnapshot()?.items ?? []
    return items.find(item => item.sessionIds?.includes(sessionId))?.workspaceId
  }
  // A navigation this plugin started: the surface effect trusts the id it lands on.
  let expected = null
  let navigationRevision = 0
  // The last Session opened through actions.openSession (a plugin's included): it stays on
  // screen while blank, where a blank DSH Session would land on the Main Bot.
  let chosen = null
  const setPlain = (plain) => surface.set(state => (state.plain === plain ? state : { ...state, plain }))
  // A DSH Agent Session shows the plain conversation: the Bot details and browser
  // panels would follow it and report it is not on the team, so they close.
  const dropPanels = () => ui.set(state => (state.details || state.renaming ? { ...state, details: null, view: 'details', renaming: false, tab: null } : state))
  // A Bot's chat spans several parts, so when it was last left is kept per Bot.
  const seenKey = id => roster.getSnapshot().byId?.[id]?.id ?? id
  const leaveVisits = (ids) => {
    seenAt = seenStore.update(seen => noteLeft(seen, ids.map(seenKey), Date.now()), seenAt)
  }
  ctx.effect(() => {
    const onPageHide = () => leaveVisits(Object.keys(ui.getSnapshot().visits ?? {}))
    window.addEventListener('pagehide', onPageHide)
    return () => window.removeEventListener('pagehide', onPageHide)
  }, 'ds-bot: remember visits on page hide')
  // Unread marks, reactions and visits are shared by every window; one saved elsewhere
  // shows here at once. A `null` key is a cleared storage.
  ctx.effect(() => {
    const onStorage = (event) => {
      if (event.storageArea !== localStorage) return
      if (event.key === null || event.key === unreadStore.key) ui.set(state => ({ ...state, unread: unreadStore.read(state.unread) }))
      if (event.key === null || event.key === reactionStore.key) ui.set(state => ({ ...state, reactions: reactionStore.read(state.reactions) }))
      if (event.key === null || event.key === seenStore.key) seenAt = seenStore.read(seenAt)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, 'ds-bot: follow other windows')
  const activity = createSource({})
  // Per Bot, the turn it runs and its tool; and the approvals waiting for the user.
  const work = createSource({ bots: {}, approvals: [] })
  let workKey = ''
  // Per Session, what its transcript has in flight (running tools, a streaming reply).
  const live = createSource({})
  // Per Session, the ask_user and request_secret calls its transcript draws; the
  // docks carry the cards of the other calls.
  const cards = createSource({})
  // Edited dock cards keep their component when history arrives. This source
  // holds only request identities and counts, never drafts or secret values.
  const heldCards = createSource({})
  // Per Session, the first visible time and the end time of each turn the transcript
  // has rendered; time separators compare one turn's end with the next turn's start.
  const turnClock = createSource({})
  let activityKey = '{}'
  // Per Bot, its latest memory change, and `seen`: when this window first saw it, or 0
  // for a change made before the window opened, which is no news.
  const memoryNews = createSource({})
  let memoryNewsKey
  const noteMemoryNews = (next) => {
    const key = JSON.stringify(next)
    if (key === memoryNewsKey) return
    const opening = memoryNewsKey === undefined
    memoryNewsKey = key
    memoryNews.set(state => Object.fromEntries(Object.entries(next).map(([id, entry]) => [id,
      state[id]?.at === entry.at ? state[id] : { ...entry, seen: opening ? 0 : Date.now() }])))
  }
  const PREFS_KEY = STORAGE.prefs
  let savedPrefs = {}
  try { savedPrefs = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') ?? {} } catch { savedPrefs = {} }
  const writeUnread = (id, value) => {
    const unread = unreadStore.update(marks => setUnread(marks, id, value), ui.getSnapshot().unread)
    ui.set(state => (JSON.stringify(state.unread) === JSON.stringify(unread) ? state : { ...state, unread }))
  }
  const refreshed = new Set()
  // Pulls can overlap (the poll and a navigation); an older answer never wins.
  let pulls = 0
  let applied = 0
  const pull = async () => {
    const order = ++pulls
    const known = roster.getSnapshot()
    const value = await call('state', { since: known.revision, models: known.modelsKey ?? '', locale: language(), allowPlace: allowPlace() })
    if (order < applied) return
    applied = order
    const nextActivity = JSON.stringify(value.activity ?? {})
    if (nextActivity !== activityKey) { activityKey = nextActivity; activity.set(value.activity ?? {}) }
    const nextWork = JSON.stringify(value.work ?? null)
    if (nextWork !== workKey) { workKey = nextWork; work.set(value.work ?? { bots: {}, approvals: [] }) }
    noteMemoryNews(value.memoryNews ?? {})
    const current = roster.getSnapshot()
    // Connector and capability states change without a new revision, and so does what
    // other Omni plugins add to every answer (the host's extend.js), such as the events
    // Omni listens to: an unchanged answer carries only those.
    const live = {}
    if (value.connectors !== undefined && JSON.stringify(value.connectors) !== JSON.stringify(current.connectors ?? [])) live.connectors = value.connectors
    if (value.capabilityStatuses !== undefined && JSON.stringify(value.capabilityStatuses) !== JSON.stringify(current.capabilityStatuses ?? {})) live.capabilityStatuses = value.capabilityStatuses
    if (value.unchanged) {
      for (const [key, next] of Object.entries(value)) {
        if (!LIVE_OWN.has(key) && !(key in live) && JSON.stringify(next) !== JSON.stringify(current[key])) live[key] = next
      }
    }
    if (value.btwCards !== undefined && JSON.stringify(value.btwCards) !== JSON.stringify(current.btwCards ?? {})) live.btwCards = value.btwCards
    if (value.sideChats !== undefined && JSON.stringify(value.sideChats) !== JSON.stringify(current.sideChats ?? {})) live.sideChats = value.sideChats
    if (value.browserHolds !== undefined && JSON.stringify(value.browserHolds) !== JSON.stringify(hostHolds.getSnapshot())) hostHolds.set(value.browserHolds)
    if (Object.keys(live).length > 0 && current.ready) roster.set({ ...current, ...live })
    if (value.unchanged || (value.revision === current.revision && value.modelsKey === current.modelsKey)) return
    // On a browser with no visit record yet, everything already there counts as seen.
    if (Object.keys(seenAt).length === 0) leaveVisits([...value.bots, ...value.rooms].map(entry => entry.id))
    roster.set(indexRoster(value))
    try {
      const ids = (value.agents ?? []).flatMap(agent => agent.sessions ?? [])
      localStorage.setItem(STORAGE.agentSessions, JSON.stringify(ids))
      agentSessionCache = new Set(ids)
    } catch { /* storage unavailable */ }
    // Adopted ids are known by the roster now; ones gone from the list were archived.
    const listed = ctx.sessions.list.getSnapshot().byId ?? {}
    for (const id of pendingAdopt.keys()) {
      if (roster.getSnapshot().agentOf[id] !== undefined || listed[id] === undefined) pendingAdopt.delete(id)
    }
    for (const id of [...value.bots.map(currentPart), ...value.rooms.map(room => room.id)]) {
      if (refreshed.has(id)) continue
      refreshed.add(id)
      void Promise.resolve(ctx.sessions.refreshProjections?.(id)).catch(quietly('refresh projections'))
    }
  }

  ctx.effect(() => {
    let stopped = false
    let running = false
    let timer
    const loop = async () => {
      clearTimeout(timer)
      if (running || stopped) return
      running = true
      try { await pull() } catch (error) { if (!stopped) console.warn('[ds-bot] state', error) } finally { running = false }
      if (!stopped) timer = setTimeout(loop, document.hidden ? 10000 : 1500)
    }
    const wake = () => { if (!document.hidden) void loop() }
    document.addEventListener('visibilitychange', wake)
    void loop()
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', wake) }
  }, 'ds-bot: roster poll')

  // Plugin updates: every window that opens asks the host once (the host keeps its
  // answer for a while), again each hour, and every two seconds while installing.
  const update = createSource({ available: false, phase: 'idle' })
  let wakeUpdate = () => {}
  ctx.effect(() => {
    let stopped = false
    let timer
    const loop = async () => {
      clearTimeout(timer)
      if (stopped) return
      const value = await call('update-check', { fresh: false }).catch(() => null)
      if (stopped) return
      if (value) update.set(previous => ({ ...value, app: previous.app }))
      timer = setTimeout(loop, value?.phase === 'installing' || value?.dsh?.phase === 'installing' ? 2000 : 60 * 60_000)
    }
    wakeUpdate = loop
    void loop()
    return () => { stopped = true; clearTimeout(timer); wakeUpdate = () => {} }
  }, 'ds-bot: update check')

  // A packaged DSH updates through its own updater; what that updater found is
  // kept beside the host's answer so the card can match it to the verified DSH.
  const appUpdates = window.dshDesktop?.protocolVersion === 1 ? window.dshDesktop.updates ?? null : null
  if (appUpdates?.status && appUpdates.subscribe) {
    ctx.effect(() => {
      let stopped = false
      const take = (app) => { if (!stopped && app) update.set(previous => ({ ...previous, app })) }
      void appUpdates.status().then(take, () => {})
      const unsubscribe = appUpdates.subscribe(take)
      return () => { stopped = true; unsubscribe?.() }
    }, 'ds-bot: app update status')
  }

  // Bot browsers need a webview bridge: DSH Desktop's, or a desktop app's of the same shape
  // (`views`: the Automagik app's, whose views are the Bot's own browser). The host turns the
  // panel on there (`browser` in the state).
  const bridge = (window.dshDesktop?.protocolVersion === 1 ? window.dshDesktop.browser : globalThis.dsBotApp?.browser) ?? null
  const browsers = bridge ? createBotBrowsers({ bridge, createSource, savedTabs: () => roster.getSnapshot().browserTabs }) : null
  if (browsers) {
    ctx.effect(() => {
      let stopReads = null
      const sync = () => {
        const snapshot = roster.getSnapshot()
        if (!snapshot.ready) return
        const on = snapshot.browser === true
        if (on && !stopReads) stopReads = serveBrowserReads({ browsers, post: call })
        if (!on && stopReads) { stopReads(); stopReads = null }
        // A Bot deleted here or in another window takes its guests and saved tabs along.
        void browsers.retain(snapshot.bots.map(bot => bot.id))
        // A panel open on the browser view without a browsable subject falls back
        // to the details view.
        ui.set(state => (state.details && state.view === 'browser' && (!on || !snapshot.byId[state.details]) ? { ...state, view: 'details' } : state))
      }
      sync()
      const offRoster = roster.subscribe(sync)
      return () => { offRoster(); stopReads?.(); browsers.dispose() }
    }, 'ds-bot: Bot browsers')
  }

  ctx.effect(() => () => { markupCache.clear() }, 'ds-bot: character markup')

  // Mentions wear each Bot's color and character silhouette (or its photo). A message
  // DSH still draws itself, while it waits to be sent or to join a running turn, shows
  // "@Name" as a file reference; one whose label is a whole Bot name wears the Bot's
  // mark there too (a name with a space is cut by DSH, so it stays as DSH draws it).
  const installMentions = () => {
    const style = installStyles('', 'mentions')
    let last = ''
    const render = () => {
      const next = roster.getSnapshot().bots.map((bot) => {
        const anchor = `.bt-bubble a[href="${MENTION_ORIGIN}${bot.id}"]`
        const chip = /\s/.test(bot.name) ? '' : `[class*="_userRow"] [data-ref-chip="file"][title="@${bot.name.replace(/["\\]/g, '\\$&')}" i]`
        const look = lookOf(bot)
        const marks = chip ? `${anchor}::before,${chip}::before` : `${anchor}::before`
        const mark = look.image
          ? `${marks}{background:center/cover url("${look.image}");-webkit-mask:none;mask:none;border-radius:50%}`
          : `${marks}{background:${paintCss(look.color)};-webkit-mask-image:${maskOf(look.shape)};mask-image:${maskOf(look.shape)}}`
        const chipBase = chip ? `${chip}{color:inherit;font-weight:600}${chip}>svg{display:none}${chip}::before{content:"";display:inline-block;flex:none;width:16px;height:16px;margin-right:3px;vertical-align:-3px;-webkit-mask:${DEFAULT_MASK} center/contain no-repeat;mask:${DEFAULT_MASK} center/contain no-repeat}` : ''
        return `${anchor}{color:${inkText(look.color)}}${chipBase}${mark}`
      }).join('\n')
      if (next !== last) style.textContent = last = next
    }
    render()
    const offRoster = roster.subscribe(render)
    const offRegistry = registry.subscribe(render)
    return () => { offRoster(); offRegistry(); style.remove() }
  }

  // The chosen theme lives in the team state so every device shares it; the local
  // copy only avoids a flash of the default theme before the first state pull.
  const installTheme = () => {
    const style = installStyles('', 'theme')
    let key = ''
    let releaseTokens = null
    const render = () => {
      const snapshot = roster.getSnapshot()
      const prefs = snapshot.ready ? snapshot.prefs ?? {} : savedPrefs
      const themes = allThemes()
      const id = themes[prefs.theme] ? prefs.theme : 'deepseek'
      const accent = isHex(prefs.accent) ? prefs.accent : undefined
      const motion = prefs.motion === 'quiet' || prefs.motion === 'lively' ? prefs.motion : 'normal'
      const layout = layoutOf(prefs)
      const width = widthOf(prefs)
      const flatWidth = flatWidthOf(prefs)
      document.body.dataset.btMotion = motion
      document.body.dataset.btLayout = layout
      document.body.style.setProperty('--bt-msg-w', String(width / 100))
      document.body.style.setProperty('--bt-flat-w', String(flatWidth / 100))
      const next = `${id}|${accent ?? ''}|${motion}|${layout}|${width}|${flatWidth}|${registry.getSnapshot()}`
      if (next === key) return
      key = next
      style.textContent = themeCss(themes[id], accent)
      const release = releaseTokens
      releaseTokens = ctx.theme.overrideTokens('omni-ui', shellTokens(themes[id], accent))
      if (typeof release === 'function') release()
      if (snapshot.ready) {
        try { localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: prefs.theme, accent: prefs.accent, motion: prefs.motion, layout: prefs.layout, width: prefs.width, flatWidth: prefs.flatWidth, thinking: prefs.thinking })) } catch { /* storage unavailable */ }
      }
    }
    render()
    const offRoster = roster.subscribe(render)
    const offRegistry = registry.subscribe(render)
    return () => {
      offRoster()
      offRegistry()
      try {
        if (typeof releaseTokens === 'function') releaseTokens()
      } finally {
        delete document.body.dataset.btMotion
        delete document.body.dataset.btLayout
        document.body.style.removeProperty('--bt-msg-w')
        document.body.style.removeProperty('--bt-flat-w')
        style.remove()
      }
    }
  }

  ctx.effect(() => {
    const hub = { registerShape, registerTheme, themes: () => Object.keys(allThemes()), shapes: () => Object.keys(SHAPES) }
    const queued = Array.isArray(window.omniUiQueue) ? window.omniUiQueue : []
    window.dshBot = hub
    window.omniUiQueue = { push: (task) => { try { task(hub) } catch (error) { console.warn('[ds-bot] registration', error); noteClientError('registration', error) } } }
    for (const task of queued) window.omniUiQueue.push(task)
    return () => {
      if (window.dshBot === hub) delete window.dshBot
      delete window.omniUiQueue
    }
  }, 'ds-bot: registry')

  ctx.inject(['shortcuts'], scope => { scope.effect(() => holdShellShortcuts(scope.shortcuts), 'ds-bot: settings shortcut') })

  const after = promise => promise.then(async (value) => { await pull().catch(() => {}); return value })
  // A Bot id, or any part of its chat, opens the Bot's current part.
  const partFor = (id) => {
    const bot = roster.getSnapshot().byId[id]
    return bot ? currentPart(bot) : id
  }
  // Sessions owned by an Agent, including ones adopted before the roster caught up.
  const agentSessions = (agentId) => {
    const snapshot = roster.getSnapshot()
    const agent = snapshot.agentsById[agentId]
    const ids = agent === undefined ? [] : [...agentRowSessions(agent, snapshot, Date.now())]
    for (const [id, owner] of pendingAdopt) if (owner === agentId && !ids.includes(id)) ids.push(id)
    return ids
  }
  const mainView = () => Object.values(ctx.sessions.list.getSnapshot().byId ?? {}).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id
  const show = listedOpener({ list: ctx.sessions.list, refresh: () => Promise.resolve(ctx.sessions.refresh?.()).catch(quietly('refresh sessions')), open: (target) => { expected = target; ctx.uiWorkspace.openSession(target) }, current: mainView })
  // Bot mode's view must hold a team conversation; an outside Session wears the
  // Bot skin without one. Runs whenever the surface is (or stays) Bot mode —
  // including a cold start, where no setSurface call ever fires.
  const homeToMainBot = () => {
    const snapshot = roster.getSnapshot()
    if (!snapshot.ready || !snapshot.mainBotId) return
    const main = mainView()
    if (main !== undefined && snapshot.byId[main] === undefined && snapshot.roomsById[main] === undefined) {
      actions.openSession(snapshot.mainBotId)
    }
  }
  const ensureBotHome = () => {
    if (roster.getSnapshot().ready) homeToMainBot()
    else {
      const off = roster.subscribe(() => {
        if (!roster.getSnapshot().ready) return
        off()
        homeToMainBot()
      })
    }
  }
  let cliLogin
  const actions = {
    ...teamActions({ call, after, partFor, roster, ui, live, cards, heldCards, turnClock, openSession: id => actions.openSession(id), loginState: () => cliLogin }),
    // The full-pane overlays sit above the conversation, so opening one must dismiss them
    // or the click appears to do nothing.
    isAgentSession: id => isAgentSessionId(id),
    openedOnPurpose: id => id === chosen,
    ownershipPending: id => pendingBot.has(id),
    openSession: (id) => {
      // A DSH Agent Session id lands on the plain surface, not the Bot skin.
      if (isAgentSessionId(id)) return actions.openAgentSession(partFor(id))
      ui.set(state => (state.newChat || state.exchange || state.menu || state.palette ? { ...state, newChat: null, exchange: null, menu: null, palette: null } : state))
      setPlain(false)
      const target = partFor(id)
      chosen = target
      show(target)
    },
    // The conversation replacements withdraw for a plain Session; set the surface
    // before the navigation so the Bot skin never flashes.
    openAgentSession: (sessionId) => {
      ui.set(state => ({ ...state, newChat: null, exchange: null, menu: null, palette: null, details: null, view: 'details', renaming: false, tab: null }))
      setPlain(true)
      show(sessionId)
    },
    // UI-created DSH bots join the team without replacing the native conversation.
    addAgent: async (fields) => {
      const agent = await after(call('add-agent', { ...fields, teamMember: true }))
      if (agent?.adoptedBotId !== undefined) actions.openSession(agent.adoptedBotId)
      else if (agent?.sessions?.[0] !== undefined) actions.openAgentSession(agent.sessions[0])
      return agent
    },
    updateAgent: (agentId, fields) => after(call('update-agent', { agentId, ...fields })),
    // A DSH bot the user wants on the team becomes a Bot: same Session, folder and name,
    // now with the team tools, messages, groups, capabilities and tasks.
    adoptAgentAsBot: async (agentId) => {
      const { botId } = await after(call('agent-bot-adopt', { agentId }))
      actions.openSession(botId)
      return botId
    },
    agentPresets: () => call('agent-presets'),
    openAgent: (agentId) => {
      const agent = roster.getSnapshot().agentsById[agentId]
      if (agent === undefined) return
      const list = ctx.sessions.list.getSnapshot()
      const recent = agentSessions(agentId).sort((a, b) => (list.byId[b]?.updatedAt ?? 0) - (list.byId[a]?.updatedAt ?? 0))
      if (recent.length === 0) return actions.newAgentSession(agentId)
      actions.openAgentSession(recent[0])
    },
    newAgentSession: async (agentId) => {
      const agent = roster.getSnapshot().agentsById[agentId]
      // Tasks come from the Bots that start them, never from the row.
      if (agent === undefined || agent.kind === 'tasks') return
      const list = ctx.sessions.list.getSnapshot()
      const recent = agentSessions(agentId).sort((a, b) => (list.byId[b]?.updatedAt ?? 0) - (list.byId[a]?.updatedAt ?? 0))
      // An untouched Session is already the new conversation the user wants.
      if (recent.length > 0 && list.byId[recent[0]]?.blank === true) {
        actions.openAgentSession(recent[0])
        return recent[0]
      }
      const { sessionId } = await after(call('agent-session', { agentId, workspaceId: workspaceOf(recent[0]) }))
      actions.openAgentSession(sessionId)
      return sessionId
    },
    archiveAgentSession: async (agentId, sessionId) => {
      await after(call('agent-archive', { agentId, sessionId }))
      const list = ctx.sessions.list.getSnapshot()
      const main = Object.values(list.byId ?? {}).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id
      if (main !== sessionId) return
      const rest = roster.getSnapshot().agentsById[agentId]?.sessions ?? []
      if (rest.length > 0) actions.openAgent(agentId)
      else if (roster.getSnapshot().mainBotId) actions.openSession(roster.getSnapshot().mainBotId)
    },
    renameAgentSession: (agentId, sessionId, title) => after(call('agent-rename', { agentId, sessionId, title })),
    beginAgentRename: sessionId => ui.set(state => ({ ...state, renameAgent: sessionId })),
    endAgentRename: () => ui.set(state => (state.renameAgent ? { ...state, renameAgent: null } : state)),
    // Removing the Agent archives every Session it owns; one of them may fill the
    // main view, and it must not stay there wearing the Bot surface afterwards.
    removeAgent: async (agentId) => {
      const owned = agentSessions(agentId)
      const result = await after(call('remove-agent', { agentId }))
      const list = ctx.sessions.list.getSnapshot()
      const main = Object.values(list.byId ?? {}).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id
      if (main !== undefined && owned.includes(main) && roster.getSnapshot().mainBotId) actions.openSession(roster.getSnapshot().mainBotId)
      return result
    },
    // `last` is the Bot conversation the view held before it cleared: when that part
    // was archived for a fresh one, the view goes on in the fresh one.
    landOn: async (id, last, from = mainView() ?? null) => {
      if ((mainView() ?? null) !== from || pendingBot.has(from)) return
      const revision = navigationRevision
      if (last) await pull().catch(() => {})
      if ((mainView() ?? null) !== from || navigationRevision !== revision || pendingBot.has(from)) return
      const bot = last ? roster.getSnapshot().byId[last.botId] : undefined
      setPlain(false)
      const target = bot && currentPart(bot) !== last.sessionId ? currentPart(bot) : partFor(id)
      show(target)
    },
    selectPanel: (id) => { ctx.layout.selectPanel(id) },
    toggleSidebar: () => { ctx.layout.toggleSidebar() },
    // Agent mode hands the surface back to the shell; everything open on the Bot
    // surface closes first so nothing stale reopens on the way back.
    setSurface: (mode) => {
      if (mode !== 'bot' && mode !== 'agent') return
      // Already there: still worth the landing check — a cold start never calls
      // setSurface, so this is also how a stuck Bot surface recovers itself.
      if (surface.getSnapshot().mode === mode) {
        if (mode === 'bot') ensureBotHome()
        return
      }
      if (mode === 'agent') {
        ui.set(state => ({ ...state, details: null, view: 'details', settings: null, palette: null, newChat: null, menu: null, voice: null, exchange: null, memory: null, toast: null }))
      }
      writeMode(mode)
      surface.set(state => ({ ...state, mode }))
      if (mode !== 'bot') return
      ensureBotHome()
    },
    markUnread: id => writeUnread(id, true),
    beginVisit: (id) => {
      // A conversation a Bot started, never opened here, is unread from its start.
      const made = roster.getSnapshot().byId[id] ?? roster.getSnapshot().roomsById[id]
      const seen = seenAt[seenKey(id)] ?? (made?.createdBy && Number.isFinite(made.createdAt) ? made.createdAt : null)
      ui.set(state => ({ ...state, visits: { ...state.visits, [id]: { seen, entered: Date.now() } } }))
    },
    endVisit: (id) => {
      leaveVisits([id])
      ui.set((state) => {
        if (!(id in (state.visits ?? {}))) return state
        const visits = { ...state.visits }
        delete visits[id]
        return { ...state, visits }
      })
    },
    toggleReaction: (key, index, emoji) => {
      const reactions = reactionStore.update(saved => toggleReaction(saved, key, index, emoji), ui.getSnapshot().reactions)
      ui.set(state => ({ ...state, reactions }))
    },
    clearUnread: id => writeUnread(id, false),
  }
  // Without the Desktop bridge these stay undefined, and no browser control renders.
  if (browsers) {
    Object.assign(actions, {
      // The globe button: the Bot's active tab in the browser view, or a new tab.
      openBrowser: (id) => {
        const bot = roster.getSnapshot().byId[id]
        if (!bot) return
        browsers.ensureTabs(bot.id)
        if (browsers.tabs.getSnapshot()[bot.id]?.active == null) browsers.openTab(bot.id)
        ui.set(state => ({ ...state, details: id, view: 'browser', renaming: false, tab: null }))
      },
      // '+' on the strip or the drawer's new-tab card: a blank tab in the browser view.
      browserNewTab: (id) => {
        const bot = roster.getSnapshot().byId[id]
        if (!bot) return null
        browsers.ensureTabs(bot.id)
        const tabId = browsers.openTab(bot.id)
        ui.set(state => ({ ...state, details: id, view: 'browser', renaming: false, tab: null }))
        return tabId
      },
      // A drawer card: its tab active, the panel on the browser view.
      browserPick: (id, tabId) => {
        const bot = roster.getSnapshot().byId[id]
        if (!bot) return
        browsers.activate(bot.id, tabId)
        ui.set(state => ({ ...state, details: id, view: 'browser' }))
      },
      browserEnsure: botId => browsers.ensureTabs(botId),
      browserCloseTab: (botId, tabId) => browsers.closeTab(botId, tabId),
      browserActivate: (botId, tabId) => browsers.activate(botId, tabId),
      browserShow: (tabId, box) => browsers.show(tabId, box),
      browserNavigate: (tabId, input) => browsers.navigate(tabId, input),
      browserCommand: (tabId, name) => browsers.command(tabId, name),
      browserFocus: (tabId) => browsers.focus(tabId),
      browserTakeover: bridge.views ? async botId => {
        const result = await call('browser-takeover', { botId })
        await bridge.views.hold(botId, true)
        return result
      } : undefined,
      browserStop: bridge.views ? async botId => {
        const result = await call('browser-stop', { botId })
        await bridge.views.hold(botId, true)
        return result
      } : undefined,
      // `answer` is a handoff card's { callId, outcome }; the panel's Give back sends none.
      browserGiveBack: bridge.views ? async (botId, answer = {}) => {
        const result = await call('browser-give-back', { botId, ...answer })
        await bridge.views.hold(botId, false)
        return result
      } : undefined,
      // Cookie imports, only where the bridge offers them (the desktop app): a file or an
      // installed browser's profile is previewed, then applied into the Bot's storage key.
      browserImport: typeof bridge.importSources === 'function' ? {
        sources: () => bridge.importSources(),
        pick: () => bridge.importPick(),
        live: (source, close) => bridge.importLive(source, close),
        apply: (botId, pending) => bridge.importApply(`bot:${botId}`, pending),
        cancel: (pending) => bridge.importCancel(pending),
      } : null,
    })
  } else {
    // Without the bridge a Bot's own browser is a window of the Chrome on this computer: it
    // still hands over to the user, through the host alone, and the team view carries the hold.
    Object.assign(actions, {
      browserTakeover: botId => call('browser-takeover', { botId }),
      browserStop: botId => call('browser-stop', { botId }),
      browserGiveBack: (botId, answer = {}) => call('browser-give-back', { botId, ...answer }),
    })
  }
  // The sign-in rows of the Bots' chats (cli-login.js): this page's views of the attempts the
  // host holds. Disposing them never cancels an attempt.
  cliLogin = createCliLogin({ actions, modelOf: botId => work.getSnapshot().models?.[botId]?.selected,
    botOf: botId => cliLoginBotOf(roster.getSnapshot(), botId) })
  actions.cliLogin = cliLogin
  // A sign-in row about a provider its Bot has left closes by itself (cli-login-state.js).
  ctx.effect(() => work.subscribe(() => cliLogin.followModels()), 'ds-bot: CLI sign-in rows follow the Bots\' models')
  // A turn refused because its agent's account waits for the person opens the row's account
  // step in that Bot's chat (#869).
  ctx.effect(() => work.subscribe(() => cliLogin.followFailures(work.getSnapshot().models)), 'ds-bot: CLI account step follows a refused turn')
  // Once per upgrade: which CLI sign-in the Bots already use, shared with the terminal.
  ctx.effect(() => {
    let told = false
    const tell = () => {
      if (told || roster.getSnapshot().ready !== true) return
      told = true
      void announceCarried({ actions })
    }
    const off = roster.subscribe(tell)
    tell()
    return off
  }, 'ds-bot: carried CLI sign-in notice')
  actions.inputActionsOf = sessionId => ctx.sessions.binding?.(sessionId)?.props?.inputActions
  ctx.effect(() => () => cliLogin.dispose(), 'ds-bot: CLI sign-in rows')
  ctx.effect(() => installKnownStateGuard({ onRefused: () => actions.showNotice(t('This message contains a sign-in code, so it was not sent. Paste the code only in the sign-in step.')) }), 'ds-bot: sign-in code guard')
  ctx.effect(() => installCliLoginBridge({
    selectedBot: () => cliLoginBotOf(roster.getSnapshot(), mainView()),
    mainBot: () => {
      const snapshot = roster.getSnapshot()
      return [...(snapshot.mainBotIds ?? []), snapshot.mainBotId].map(id => cliLoginBotOf(snapshot, id)).find(Boolean)
    },
    openLogin: (botId, provider) => actions.openCliLogin(botId, provider),
  }), 'ds-bot: CLI sign-in bridge')
  // Whether AccountLauncher holds the shell's settings seat; FooterAccount steps aside if so.
  actions.signInEntry = () => ctx.slots.entries?.('settings.models.sign-in')?.[0] ?? null
  actions.canSignIn = () => Boolean(actions.signInEntry())
  actions.signIn = () => ui.set(state => ({ ...state, signIn: (state.signIn ?? 0) + 1 }))
  actions.closeSignIn = () => ui.set(state => ({ ...state, signIn: null }))
  actions.accountT = () => ctx.get('locale').bind('settings.account')
  // The Voice Input plugin's speech Remote; absent while that plugin is off.
  actions.speech = () => ctx.get('remote.speech') ?? undefined
  // DSH's own settings: models, providers, keys and its plugins.
  actions.openHarnessSettings = openHarnessSettings
  // Pages other plugins add to DSH's settings (its settings.section slot), such as Omni's link:
  // Omni's settings list them too. DSH's own stay in Harness settings; a page that needs
  // DSH's injected props can only be drawn there.
  actions.pluginSettings = () => (ctx.slots.entries?.('settings.section') ?? [])
    .filter(({ component, options = {}, registrant }) => component && options.inject === undefined && !DSH_SETTINGS.has(options.id) && !/^@deepseek-ai\//.test(registrant ?? ''))
    .map(({ component, options }) => ({ id: options.id, order: options.order ?? 0, label: typeof options.label === 'function' ? options.label() : String(options.label ?? options.id), Component: component }))
    .sort((a, b) => a.order - b.order)
  actions.openHarnessOnboarding = openHarnessOnboarding
  actions.voiceSetup = () => {
    const navigation = ctx.get('pluginNavigation')
    return navigation ? () => navigation.openBundle(VOICE_BUNDLE) : null
  }
  actions.seatAccount = on => ui.set(state => (state.accountSeated === on ? state : { ...state, accountSeated: on }))
  // The install runs on the host; the check loop follows it every two seconds.
  actions.installUpdate = async () => {
    const value = await call('update-install')
    update.set(previous => ({ ...previous, ...value }))
    wakeUpdate()
  }
  // The DSH the newest released Omni verified installs the same way.
  actions.installDshUpdate = async () => {
    const dsh = await call('dsh-update-install')
    update.set(previous => ({ ...previous, dsh }))
    wakeUpdate()
  }
  // The app's panel installs whatever its updater found by now, so it opens only
  // while that is still the verified version.
  actions.openAppUpdates = async (verified) => {
    const app = await appUpdates?.status?.()
    if (app) update.set(previous => ({ ...previous, app }))
    if (sameVersion(app?.version, verified)) await appUpdates.open()
  }
  actions.checkUpdate = async () => {
    const value = await call('update-check', { fresh: true })
    update.set(previous => ({ ...value, app: previous.app }))
    wakeUpdate()
  }
  actions.freshConversation = botId => after(call('bot-fresh', { id: botId }))
  // Each Bot's model state (the host's model-state.js), as the last state answer carried it.
  actions.subscribeWork = listener => work.subscribe(listener)
  actions.modelStateOf = botId => work.getSnapshot().models?.[botId]
  const browserPages = browsers?.pages ?? createSource({})
  const browserTabs = browsers?.tabs ?? createSource({})
  const browserHolds = browsers?.holds ?? hostHolds
  const face = () => ({ actions, hooks: { roster, ui, activity, work, memoryNews, registry, turnClock, live, cards, heldCards, browserPages, browserTabs, browserHolds, surface, update, panel: ctx.layout.panelInfo } })
  ctx.effect(() => noticeApprovals({
    work,
    roster,
    shownSession: () => Object.values(ctx.sessions.list.getSnapshot().byId ?? {}).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id,
    openSession: id => actions.openSession(id),
  }), 'ds-bot: approval notifications')
  const assistantFace = (sessionId) => {
    const binding = ctx.sessions.binding(sessionId)
    if (binding === undefined) throw new Error(`ds-bot: unknown session "${sessionId}"`)
    const chat = ctx.uiConversation.binding(binding).target('chat')
    return { ...face(), keyedHooks: {
      turnSteps: (turn) => {
        const snapshot = chat.getSnapshot()
        if (snapshot === undefined) throw new Error('ds-bot: Chat target is unavailable')
        return snapshot.nodes.turnDataSource(Number(turn), 'assistant-step')
      },
      turnContext: (turn) => {
        const snapshot = chat.getSnapshot()
        if (snapshot === undefined) throw new Error('ds-bot: Chat target is unavailable')
        return snapshot.nodes.turnDataSource(Number(turn), 'context')
      },
    } }
  }

  // The dock lives outside the chat snapshot, so it subscribes for the turn that
  // owns a card. Until that turn closes, the card stays by the composer.
  actions.turnFacts = (sessionId) => {
    try {
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) return { turns: undefined, openTurn: undefined }
      const conversation = ctx.uiConversation.binding(binding)
      const chat = conversation.target('chat').getSnapshot()
      return { turns: chat?.timeline?.turns, openTurn: conversation.openTurn.getSnapshot() }
    } catch {
      return { turns: undefined, openTurn: undefined }
    }
  }
  actions.watchTurns = (sessionId, listener) => {
    try {
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) return () => {}
      const conversation = ctx.uiConversation.binding(binding)
      const offChat = conversation.target('chat').subscribe(listener)
      const offOpen = conversation.openTurn.subscribe(listener)
      return () => { offChat(); offOpen() }
    } catch {
      return () => {}
    }
  }
  // A terminal tab in DSH's right column, only where the terminal plugin
  // registered its type and the column face is there.
  actions.canOpenTerminal = () => ctx.get('sidebarRight') !== undefined && ctx.get('sidebarRightTabs')?.get('terminal') !== undefined
  actions.newTerminal = () => {
    // The column takes the drawer's space: hand it over first.
    actions.closePanel()
    try {
      ctx.get('sidebarRight')?.openTab('terminal')
    } catch (error) {
      actions.reportError(error, 'right-sidebar')
    }
  }
  // The same hand-off for DSH's files tab, where that plugin registered it.
  actions.canOpenFiles = () => ctx.get('sidebarRight') !== undefined && ctx.get('sidebarRightTabs')?.get('files') !== undefined
  actions.openFiles = () => {
    actions.closePanel()
    try {
      ctx.get('sidebarRight')?.openTab('files')
    } catch (error) {
      actions.reportError(error, 'right-sidebar')
    }
  }

  // The drawer and DSH's right column never share the window: whichever the
  // user asked for last wins. The column's state is read off the frame's
  // attributes through a MutationObserver. `mounted` moves before the DOM of a
  // Session switch does, so a switch opens a timed window (createSwitchWindow):
  // an attribute batch inside it is the switch revealing that Session's own
  // column — the drawer wins and folds it back — while one outside it is the
  // user's own opening and takes the space.
  ctx.effect(() => {
    const sidebar = ctx.get('sidebarRight')
    if (!sidebar) return undefined
    let open = rightColumnOpen(document)
    // Long enough for a fullscreen panel's slide, which reports only once it ends.
    const switchWindow = createSwitchWindow(done => setTimeout(done, 400))
    const collapseColumn = () => {
      try {
        if (sidebar.isExpanded()) sidebar.toggleExpanded()
      } catch (error) {
        actions.reportError(error, 'right-sidebar')
      }
    }
    const observer = new MutationObserver(() => {
      const next = rightColumnOpen(document)
      const opening = next && !open
      open = next
      const verdict = opening ? columnOpened(ui.getSnapshot().details !== null, switchWindow.pending) : null
      if (verdict === 'close-drawer') actions.closePanel()
      else if (verdict === 'collapse-column') collapseColumn()
    })
    observer.observe(document.documentElement, {
      subtree: true, attributes: true, attributeFilter: RIGHTBAR_ATTRIBUTES,
    })
    const offMounted = sidebar.mounted.subscribe(() => switchWindow.moved())
    let drawer = ui.getSnapshot().details !== null
    const offUi = ui.subscribe(() => {
      const next = ui.getSnapshot().details !== null
      if (next && !drawer && drawerOpened(rightColumnOpen(document)) === 'collapse-column') collapseColumn()
      drawer = next
    })
    return () => { observer.disconnect(); offMounted(); offUi() }
  }, 'ds-bot: one right panel')

  // A Bot surface owns the cells it shadows. It starts far below the -10 that plugins
  // commonly use and goes below whatever already holds the cell, so a plugin that
  // shadows the same cell neither breaks the install nor shows through.
  const BOT_PRIORITY = -100
  const shadow = (name, options, component) => ctx.slots.inject(name, () => ctx.slots.register({
    name, ...options, ...(options.priority === undefined ? {} : { priority: freePriority(ctx.slots.entries(name), options) }),
  }, component))
  const controlSession = () => {
    const sidebar = ctx.get('sidebarRight')
    return sidebar ? sidebar.mounted.getSnapshot() : mainView()
  }
  const controlSources = () => [ctx.sessions.list, ctx.get('sidebarRight')?.mounted]
  const simpleOnly = install => installSimpleControls({ roster, sources: controlSources(), sessionId: controlSession, install })
  const installHeader = () => simpleOnly(() => ctx.slots.inject('conversation.session.header', () => installHeaderNavigation(ctx.slots, face, HeaderPill, BOT_PRIORITY)))
  Object.assign(actions, sidebarActions({ sidebar: () => ctx.get('sidebarRight'), shown: mainView,
    teamSession: id => { const state = roster.getSnapshot(); return Boolean(state.byId[id] || state.roomsById[id] || state.tasks?.[id]) },
    closePanel: () => actions.closePanel(), reportError: (...args) => actions.reportError(...args) }))
  // These annotations only affect this plugin's scoped styles, never execution policy.
  const installAdvancedStyle = () => {
    const sync = () => {
      document.body.toggleAttribute('data-bt-advanced', advancedBot(roster.getSnapshot(), controlSession()) !== null)
    }
    const offs = [roster, ...controlSources()].filter(Boolean).map(source => source.subscribe(sync))
    sync()
    return () => { for (const off of offs) off(); document.body.removeAttribute('data-bt-advanced') }
  }
  const installNativeBotHeader = () => ctx.slots.inject('conversation.session.header.actions', () => {
    // Share only navigation injection/store. Native header retains exclusive children ownership.
    const navigation = headerNavigation(ctx.slots.entries('conversation.session.header').filter(entry => entry.component !== HeaderPill), face)
    return ctx.slots.register({ name: 'conversation.session.header.actions', id: 'bot-native-header', order: -100, ...navigation }, NativeBotHeader)
  })

  // The "@" menu's Bot group and the chats "+" references. The composer's controller
  // for a Session is the shell's own, so the chats open at its caret.
  let atMenu = null
  const installAtMenu = () => {
    const fiber = ctx.inject(['inputTriggers'], (scope) => {
      scope.effect(() => {
        const triggers = scope.inputTriggers
        const controllerOf = (sessionId) => {
          const binding = ctx.sessions.binding(sessionId)
          return binding === undefined ? undefined : triggers.sessionOf(binding.ctx)
        }
        const launched = sessionId => controllerOf(sessionId)?.launcher.getSnapshot() === CHATS_SOURCE
        const offs = [
          ...atSources({ roster, sessions: ctx.sessions, launched, iconFor: menuIcons(roster) }).map(source => triggers.registerSource(source)),
          triggers.registerSource(sideSource({ roster, actions })),
        ]
        atMenu = { controllerOf }
        return () => {
          atMenu = null
          for (const off of offs) off()
        }
      }, 'ds-bot: @ menu')
    })
    return () => fiber.dispose()
  }
  actions.canReferenceChat = () => atMenu !== null
  actions.referenceChat = (sessionId, span) => {
    const controller = atMenu?.controllerOf(sessionId)
    if (controller === undefined || span === undefined) return
    controller.toggleSource(CHATS_SOURCE, { trigger: '@', query: '', quoted: false, position: 'inline', span })
  }

  // The shell group paints the team surface around the session; the conversation
  // group re-skins the session itself. Each step returns a disposer from slots.inject,
  // so a surface change withdraws the whole group and the outlets re-render.
  const installShell = () => [
    () => installCompiledStyles(SHELL_CSS, 'shell'),
    () => installCompiledStyles(SIDEBAR_CSS, 'sidebar'),
    () => installCompiledStyles(SECRET_CSS, 'secrets'),
    () => installCompiledStyles(MODEL_CSS + CLI_LOGIN_CSS + FOLDER_CSS + BOT_SETTINGS_CSS + GROUP_SETTINGS_CSS + AVATAR_LIBRARY_CSS, 'models'),
    () => installCompiledStyles(USAGE_CSS, 'usage'),
    () => installCompiledStyles(SCHEDULE_CSS, 'schedules'),
    () => installCompiledStyles(FEEDBACK_CSS, 'feedback'),
    () => installCompiledStyles(ABOUT_CSS, 'about'),
    () => installCompiledStyles(MEMBER_CSS, 'members'),
    () => installCompiledStyles(USER_MESSAGE_CSS, 'user-messages'),
    () => installCompiledStyles(TASK_CSS, 'tasks'),
    () => installCompiledStyles(DESKTOP_UPDATE_CSS, 'desktop-update'),
    () => installCompiledStyles(WORK_CODE_SWITCH_CSS, 'work-code-switch'),
    () => installCompiledStyles(PRIVACY_CSS, 'privacy'),
    () => installCompiledStyles(AGENT_ACCESS_CSS, 'agent-access'),
    () => installCompiledStyles(PET_CSS, 'pet'),
    () => installCompiledStyles(CHARACTER_SELECT_CSS, 'character-select'),
    () => installCompiledStyles(VOICE_SETTINGS_CSS, 'voice-settings'),
    () => installCompiledStyles(IMAGE_CELL_CSS, 'image-cell'),
    () => installCompiledStyles(SUGGEST_CSS, 'suggestions'),
    () => installCompiledStyles(LIVE_CSS, 'live'),
    () => {
      const fiber = ctx.inject(['sidebarRightTabs', 'sidebarRight'], scope => {
        scope.effect(() => installLiveTab({ tabs: scope.sidebarRightTabs, slots: scope.slots, sidebar: scope.sidebarRight, face, Body: LiveTab }), 'ds-bot: native Live tab')
      })
      return () => fiber.dispose()
    },
    () => installCompiledStyles(TEAM_APPROVAL_CSS, 'team-approval'),
    () => installCompiledStyles(LAMP_CSS, 'lamp'),
    // What other Omni plugins put on the surface (extend.js), where Omni's channels were.
    () => mountShellInstallers({ face, shadow, installStyles, installCompiledStyles }),
    () => installCompiledStyles(WIDGET_CSS, 'widgets'),
    () => installCompiledStyles(HANDOFF_CSS, 'handoff'),
    () => installCompiledStyles(SIDE_CSS, 'side'),
    // Strip and panel styles also serve the side-chat tabs, which need no bridge.
    () => installCompiledStyles(BROWSER_CSS, 'browser'),
    () => installTheme(),
    () => shadow('sidebar.workspaces', { priority: BOT_PRIORITY, inject: face }, TeamSidebar),
    () => shadow('sidebar.brand.mark', { priority: BOT_PRIORITY }, BrandMark),
    () => shadow('sidebar.brand.name', { priority: BOT_PRIORITY }, BrandName),
    // The desktop app's own update, above the account and Channels (desktop-update.js).
    () => shadow('sidebar.footer.action', { id: 'bot-desktop-update', order: -300 }, DesktopUpdate),
    () => shadow('sidebar.footer.action', { id: 'bot-account', order: -200, inject: face }, FooterAccount),
    // Shown only when the team is linked to an Omni without the channels plugin.
    () => shadow('sidebar.footer.action', { id: 'bot-channels-moved', order: -100, inject: face }, ChannelsMoved),
    () => shadow('settings.trigger', { priority: BOT_PRIORITY }, YouAvatar),
    // The whale wins the seat over a shell account plugin's own launcher (the
    // Desktop's "··· More"), which comes back in Agent mode.
    () => shadow('settings.launcher', { priority: BOT_PRIORITY, inject: face }, AccountLauncher),
    () => shadow('shell.overlay', { id: 'bot', order: 50, inject: face }, Overlays),
    () => shadow('shell.overlay', { id: 'bot-signin', order: 55, inject: face }, DeepSeekSignIn),
    () => shadow('shell.overlay', { id: 'bot-toast', order: 60, inject: face }, ErrorToast),
  ]
  // DSH draws the user's own messages itself here (no projectUserText), so each one gets the
  // time its turn began as an attribute, and CSS prints it under the bubble.
  const installUserTimes = () => {
    let frame = 0
    const paint = () => {
      frame = 0
      const list = ctx.sessions.list.getSnapshot()
      const shown = Object.values(list.byId ?? {}).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id
      const turns = shown === undefined ? {} : turnClock.getSnapshot()[shown] ?? {}
      for (const row of document.querySelectorAll('[data-chat-flow-kind=user][data-chat-turn]')) {
        const first = turns[row.dataset.chatTurn]?.first
        const label = first === undefined ? '' : new Date(first).toLocaleTimeString(dateLocale(), { hour: 'numeric', minute: '2-digit' })
        if ((row.dataset.btTime ?? '') === label) continue
        if (label) row.dataset.btTime = label
        else delete row.dataset.btTime
      }
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(paint) }
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    const offs = [turnClock.subscribe(schedule), ctx.sessions.list.subscribe(schedule)]
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      for (const off of offs) off()
      for (const row of document.querySelectorAll('[data-bt-time]')) delete row.dataset.btTime
    }
  }
  // Composer packs (composer-packs.js): the AI a Bot runs on decides what its composer
  // offers. The model cell draws per Session; the permission cell steps aside (its
  // registration withdrawn) while the Session in the main view runs on an AI whose pack
  // shows another plugin's control there, such as Claude Code's permission modes.
  const packEnv = { registrants: key => ctx.slots.entries(key).map(entry => entry.registrant) }
  const shownSessionId = () => Object.values(ctx.sessions.list.getSnapshot().byId ?? {}).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id
  const PackModelCell = packModelCell(packEnv)
  const installPackCell = (key, cell) => {
    const sync = packCellSync({
      register: () => shadow(key, { priority: BOT_PRIORITY }, Nothing),
      wantHost: () => stepsAside({ roster: roster.getSnapshot(), sessionId: shownSessionId(), cell, key, env: packEnv }),
    })
    const offs = [
      roster.subscribe(sync.sync),
      ctx.sessions.list.subscribe(sync.sync),
      composerPacks.source.subscribe(sync.sync),
      ctx.slots.subscribe?.(key, sync.sync),
    ]
    sync.sync()
    return () => {
      for (const off of offs) off?.()
      sync.dispose()
    }
  }
  const installConversation = () => [
    // First on, last off: the page mark the Stage composer rules key on (stage.js), so a Bot
    // composer card is two-row from its first paint, before DSH mounts its input slots (#322).
    () => markConversation(),
    () => installUserTimes(),
    () => installCompiledStyles(COMPOSER_PACK_CSS, 'composer-packs'),
    () => installCompiledStyles(CONVERSATION_CSS, 'conversation'),
    () => installMentions(),
    () => installAtMenu(),
    () => installAdvancedStyle(),
    installHeader,
    installNativeBotHeader,
    () => shadow('conversation.composer.dock', { id: 'bot-native-note', order: 20, inject: face }, NativeControlsNote),
    () => shadow('conversation.chat.node', { key: 'assistant-step', priority: BOT_PRIORITY, locale: 'chat', inject: assistantFace }, AssistantCell),
    () => shadow('conversation.chat.node', { key: 'turn-trigger', priority: BOT_PRIORITY, locale: 'chat', inject: face }, TriggerCell),
    () => shadow('conversation.chat.node', { key: 'tool-call', priority: BOT_PRIORITY, locale: 'chat', inject: face }, ToolCell),
    () => simpleOnly(() => shadow('conversation.chat.node', { key: 'turn-process', priority: BOT_PRIORITY, locale: 'chat', inject: face }, TurnProcessCell)),
    // DSH's own turn tail stays, so what other plugins add there shows, such as the
    // cards of the files a turn delivered; its copy and branch row is hidden.
    () => shadow('conversation.chat.turnTail', { id: 'bot-turn-separators', order: 1000, inject: face }, TurnTailCell),
    // A side question is not a transcript row. After its snapshot turn closes it
    // sits on that turn's tail, ahead of the time separator.
    () => shadow('conversation.chat.turnTail', { id: 'bot-btw', order: 800, priority: BOT_PRIORITY, inject: face }, BtwTurnTail),
    // While a Bot's chat holds only its greeting, the line under it names its model.
    () => shadow('conversation.chat.turnTail', { id: 'bot-model-line', order: 900, priority: BOT_PRIORITY, inject: face }, ModelLineTail),
    // A Bot with no model in a chat that already holds turns asks for one after the last
    // of them, below that turn's time; a chat with no turn yet asks in the dock (bot-model).
    () => shadow('conversation.chat.turnTail', { id: 'bot-model-choice', order: 1100, priority: BOT_PRIORITY, inject: face }, ModelChoiceTail),
    // A Bot condenses its conversation without telling anyone; the chat keeps showing
    // every message.
    () => shadow('conversation.chat.node', { key: 'question-reply', priority: BOT_PRIORITY, locale: 'chat' }, AnsweredReply),
    () => simpleOnly(() => shadow('conversation.chat.node', { key: 'compaction', priority: BOT_PRIORITY, locale: 'chat' }, CellEmpty)),
    // A Bot chat leaves DSH's context lines (tool updates, injected context) out; a Bot
    // message spliced in mid-turn gets an event line from the step that reads it instead.
    () => simpleOnly(() => shadow('conversation.chat.node', { key: 'context', priority: BOT_PRIORITY, locale: 'chat' }, CellEmpty)),
    ...(canDrawUserMessages() ? ['user', 'steering'].map(key => () => shadow('conversation.chat.node', { key, priority: BOT_PRIORITY, locale: 'chat', inject: face }, UserMessageCell)) : []),
    () => installPackCell('conversation.input.permission', 'permission'),
    () => simpleOnly(() => shadow('conversation.input.plan', { priority: BOT_PRIORITY }, Nothing)),
    // The composer carries no run statistics, and DSH's model picker stays out: a Bot's
    // model lives on the Bot. Omni's own model menu shows it here in every Bot's chat.
    () => shadow('conversation.input.model', { priority: BOT_PRIORITY, inject: face }, PackModelCell),
    () => simpleOnly(() => shadow('conversation.composer.dock', { id: 'activity', order: 0, priority: BOT_PRIORITY }, Nothing)),
    () => simpleOnly(() => shadow('conversation.composer.dock', { id: 'usage', order: 1, priority: BOT_PRIORITY }, Nothing)),
    () => shadow('conversation.composer.dock', { id: 'btw', order: 2, priority: BOT_PRIORITY, inject: face }, BtwDock),
    () => shadow('conversation.input.left', { id: 'bot-plus', order: -100, inject: face }, ComposerPlus),
    () => shadow('conversation.input.left', { id: 'bot-permission-chip', order: -99, inject: face }, ComposerPermission),
    () => shadow('conversation.input.right', { id: 'bot-voice', order: 100, inject: face }, ComposerVoice),
    () => shadow('conversation.composer', {
      priority: BOT_PRIORITY,
      select: owner => (owner.pendingInteraction?.kind === 'question' ? owner.pendingInteraction : null),
    }, QuestionCard),
    // The team's own tools ask in the team's words (team-approval.js); other tools keep DSH's card.
    () => shadow('conversation.composer', {
      priority: BOT_PRIORITY,
      inject: face,
      select: owner => (isTeamApproval(owner.pendingInteraction) ? owner.pendingInteraction : null),
    }, TeamApproval),
    // shadow's freePriority places each later entry below the earlier ones. Keep this
    // strict selector last so it runs before the generic question and team cards.
    () => shadow('conversation.composer', {
      priority: BOT_PRIORITY - 1,
      select: owner => selectSessionFileApproval(owner.pendingInteraction),
    }, SessionFileApproval),
    () => shadow('conversation.input.dock', { id: 'bot-members', order: -120, inject: face }, MemberDock),
    () => shadow('conversation.input.dock', { id: 'bot-model', order: -110, inject: face }, ModelChoiceDock),
    // The person's own choice of a Bot's level (permission-card.js): raised by this window alone.
    () => shadow('conversation.input.dock', { id: 'bot-permission', order: -108, inject: face }, PermissionChoiceDock),
    // Draws nothing in the dock: it seats a Bot's sign-in row in its transcript (cli-login.js).
    () => shadow('conversation.input.dock', { id: 'bot-cli-login', order: -109, inject: face }, CliLoginConversation),
    () => shadow('conversation.input.dock', { id: 'bot-child-approval', order: -102, inject: face }, ChildApprovalDock),
    () => shadow('conversation.input.dock', { id: 'bot-question', order: -100, inject: face }, QuestionDock),
    () => shadow('conversation.input.dock', { id: 'bot-view', order: -95, inject: face }, WidgetDock),
    () => shadow('conversation.input.dock', { id: 'bot-secret', order: -90, inject: face }, SecretDock),
    () => shadow('conversation.input.dock', { id: 'bot-suggest', order: -80, inject: face }, SuggestionDock),
    () => shadow('conversation.input.dock', { id: 'bot-handoff', order: -85, inject: face }, HandoffDock),
  ]
  // The return button belongs to neither group: it renders only in Agent mode.
  ctx.effect(() => installCompiledStyles(RETURN_CSS, 'return'), 'ds-bot: return styles')
  shadow('sidebar.footer.action', { id: 'bot-return', order: -300, inject: face }, BotReturn)
  ctx.effect(() => installFavicon(), 'ds-bot: Omni tab icon')
  ctx.effect(() => {
    const offs = BUILTIN_PACKS.map(pack => registerComposerPack(pack))
    return () => { for (const off of offs) off() }
  }, 'ds-bot: composer packs')
  currentFace = face
  ctx.effect(() => () => { if (currentFace === face) currentFace = null }, 'ds-bot: face for other Omni plugins')

  // The main view decides `plain`: a DSH Agent Session keeps the Bot shell but
  // withdraws the conversation replacements, so the native dsh page shows. A jump
  // this plugin did not start — the hero's workspace picker or a fork — opens an
  // unowned Session; coming from a DSH Agent Session it is adopted into that Agent.
  ctx.effect(() => {
    let previous
    let observed
    const sync = () => {
      const list = ctx.sessions.list.getSnapshot()
      const main = Object.values(list.byId ?? {}).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id
      if (main !== nativeDestination) nativeDestination = undefined
      const snapshot = roster.getSnapshot()
      const bot = snapshot.byId[previous]
      const pendingSource = pendingBot.get(previous)
      const botId = bot?.kind === 'dsh' && currentPart(bot) === previous ? bot.id : pendingSource?.botId
      const destination = list.byId[main]
      const parentId = destination?.parentId ?? destination?.parentSessionId
      const nativeCandidate = main !== undefined && main !== expected && surface.getSnapshot().mode === 'bot'
        && botId !== undefined && snapshot.byId[main] === undefined && snapshot.roomsById[main] === undefined
        && agentOfSession(main) === undefined && destination?.origin !== 'subagent'
        && (destination?.blank === true || parentId === previous)
      const plain = isAgentSessionId(main) || nativeCandidate
      setPlain(plain)
      if (plain) dropPanels()
      if (main !== observed) { navigationRevision += 1; observed = main }
      if (main === previous) return
      const before = previous
      // Clearing a source while native navigation attaches its destination is not
      // a new owner. Keep the source until a real destination arrives.
      if (main !== undefined) previous = main
      const ours = expected !== null && main === expected
      expected = null
      if (ours || main === undefined) return
      // Adoption is a Bot-mode affair: in Agent mode the native sidebar owns
      // navigation, and opening an existing Session there must not pull it in.
      if (surface.getSnapshot().mode !== 'bot') return
      if (pendingBot.has(main)) return
      if (nativeCandidate) {
        const operation = { botId, forkSource: destination?.blank !== true && parentId === before ? pendingSource : undefined }
        pendingBot.set(main, operation)
        nativeDestination = main
        setPlain(true)
        dropPanels()
        // A skipped queued pick carries the last registered source forward; it
        // must not poison the next pick or pretend its own Session was associated.
        operation.done = Promise.resolve(pendingSource?.done ?? before).then(async sourceSessionId => {
          // A selected nonblank fork needs its actual pending parents associated.
          // Follow only this operation chain; unrelated navigation still skips it.
          const current = mainView()
          let required = pendingBot.get(current)
          while (required !== undefined && required !== operation) required = required.forkSource
          if ((current !== undefined && current !== main && required !== operation) || surface.getSnapshot().mode !== 'bot') return sourceSessionId
          await call('bot-session-adopt', { botId, sessionId: main, sourceSessionId })
          await pull()
          return main
        }).catch(error => {
          console.warn('[ds-bot] bot-session-adopt', error)
          // Failure must not hide a stranded native Session behind Main, and the reason
          // reaches the person even if the native view already moved on.
          if (mainView() === main) chosen = main
          actions.reportError(error, 'bot-session-adopt')
          throw error
        }).finally(() => {
          if (pendingBot.get(main) === operation) pendingBot.delete(main)
        })
        // A later destination can await this operation; an abandoned one must not
        // leave an unhandled rejection or navigate back on completion.
        void operation.done.catch(() => {})
        return
      }
      const agentId = before !== undefined ? agentOfSession(before) : undefined
      if (agentId === undefined) return
      if (snapshot.byId[main] !== undefined || snapshot.roomsById[main] !== undefined || agentOfSession(main) !== undefined) return
      // Only a Session this jump created joins the Agent: a blank one from the
      // workspace picker, or a fork of a Session the same Agent owns. An existing
      // Session the user opened from the sidebar keeps its team tools and stays out.
      const row = list.byId[main]
      // A subagent child reports the Agent Session as its parent, but adopting it
      // would steal it from subagent routing — the Host refuses anyway, so skip.
      if (row?.origin === 'subagent') return
      // The client list maps the fork's parent to `parentId`; the raw field is
      // the fallback for shapes that skip the mapping.
      const parent = row?.parentId ?? row?.parentSessionId
      const forkedFromAgent = parent !== undefined && agentOfSession(parent) === agentId
      if (row?.blank !== true && !forkedFromAgent) return
      pendingAdopt.set(main, agentId)
      setPlain(true)
      void call('agent-adopt', { agentId, sessionId: main }).then(async () => {
        await pull()
        // Only a successful association may retire the empty source it replaced.
        const next = workspaceOf(main)
        if (list.byId[before]?.blank === true && next !== undefined && workspaceOf(before) !== next) {
          await call('agent-archive', { agentId, sessionId: before }).then(() => pull()).catch(() => {})
        }
      }).catch((error) => {
        pendingAdopt.delete(main)
        console.warn('[ds-bot] agent-adopt', error)
        // The Session never joined the Agent: the sync puts the team surface
        // back (a Map delete fires no subscription), and the user hears why.
        sync()
        actions.reportError(error, 'agent-adopt')
      })
    }
    const offList = ctx.sessions.list.subscribe(sync)
    const offRoster = roster.subscribe(sync)
    sync()
    return () => { offList(); offRoster() }
  }, 'ds-bot: agent surface')

  // The chat on screen, kept for a restart of DSH alone (reopen.js): taken before it is noted
  // again, opened once the team is known, and noted from then on.
  ctx.effect(() => {
    let reopening = takeReopen()
    const note = () => { if (reopening === null) rememberOpen(mainView()) }
    const reopen = () => {
      const snapshot = roster.getSnapshot()
      if (!snapshot.ready) return
      const id = reopening
      reopening = null
      if (isAgentSessionId(id) || snapshot.byId?.[id] !== undefined || snapshot.roomsById?.[id] !== undefined) actions.openSession(id)
      note()
    }
    const offList = ctx.sessions.list.subscribe(note)
    const offRoster = reopening === null ? () => {} : roster.subscribe(() => { if (reopening !== null) reopen() })
    if (reopening !== null) reopen()
    note()
    return () => { offList(); offRoster() }
  }, 'ds-bot: keep the open chat across a DSH restart')

  ctx.effect(() => {
    const groups = surfaceGroups({ shell: installShell, conversation: installConversation }, {
      onError: (_group, error) => actions.reportError(new Error(t('Bot mode could not be set up here: {error}', { error: error?.message ?? String(error) })), 'surface'),
    })
    // A shadow step can mount "successfully" with nothing registered: when a
    // slot's inject callback throws inside the host, the host cancels the
    // declaration's subscription but the step's disposer still counts the group
    // as mounted. After the shell goes on, check that its sidebar entry really
    // landed; remount a few times when it did not (cold start race).
    let verifyTimer = 0
    let verifyAttempts = 0
    const verifySidebar = () => {
      if (!groupsFor(surface.getSnapshot()).shell) return
      let landed = false
      let declared = true
      try {
        landed = ctx.slots.entries('sidebar.workspaces').some(entry => entry.component === TeamSidebar)
        declared = ctx.slots.spec?.('sidebar.workspaces') !== undefined
      } catch {
        declared = false
      }
      if (landed) return
      if (!declared) {
        // The slot itself is not declared yet; keep watching for a while.
        if (verifyAttempts < 20) {
          verifyAttempts += 1
          verifyTimer = setTimeout(verifySidebar, 250)
        }
        return
      }
      if (verifyAttempts >= 3) return
      verifyAttempts += 1
      console.warn('[ds-bot] sidebar entry missing after shell mount; remounting')
      groups.remount('shell')
      verifyTimer = setTimeout(verifySidebar, 250)
    }
    const reconcile = () => {
      groups.reconcile(groupsFor(surface.getSnapshot()))
      clearTimeout(verifyTimer)
      verifyAttempts = 0
      verifyTimer = setTimeout(verifySidebar, 250)
    }
    reconcile()
    if (surface.getSnapshot().mode === 'bot') ensureBotHome()
    const unsub = surface.subscribe(reconcile)
    return () => {
      unsub()
      clearTimeout(verifyTimer)
      groups.dispose()
    }
  }, 'ds-bot: surface')
}
