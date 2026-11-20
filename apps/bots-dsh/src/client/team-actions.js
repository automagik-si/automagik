import { countCards, detailsSubject, heldCardKey } from './sources.js'
import { noteClientError } from './diagnostics.js'
import { CLI_NAMES, cliLoginBotOf, cliProviderOf } from './cli-login-model.js'

// The actions every window that draws the Bot views shares: dialogs and panels (the `ui`
// source), requests to the host, and the notes the transcript keeps. The shell around the
// views adds navigation and its own panels. `after` reads the team again once a request
// is done; `partFor` maps a Bot id, or any part of its chat, to its current part.
export function teamActions({ call, after, partFor, roster, ui, live, cards, heldCards, turnClock, openSession, loginState, panelFolded }) {
  // The sign-in row of a Bot's chat (cli-login.js): an explicit entry opens that Bot's chat and
  // its row; `ref` is the model the person chose, applied by the host once signed in.
  const openCliLogin = (botId, provider, ref) => {
    const bot = cliLoginBotOf(roster.getSnapshot(), botId)
    const manager = loginState?.()
    if (!bot || !manager || !Object.hasOwn(CLI_NAMES, provider)) return false
    openSession?.(bot.id)
    void manager.open({ botId: bot.id, provider, ref: cliProviderOf(ref) === provider ? ref : undefined })
    return true
  }
  const loginPayload = (botId, provider, extra = {}) => ({ botId, provider, ...extra })
  // A memory is a Bot's or a group chat's; both are opened by id.
  const memoryOf = id => (roster.getSnapshot().roomsById[id] ? { roomId: id } : { botId: id })
  // An action that shows the panel lands the yield with it: when a folded
  // panel's explicit opener fires, the column gives way in the same set.
  // `view` is the next view, since its minimum decides what fits; a yield already
  // given stays.
  const yieldTo = (state, view) => state.panelYield === true || panelFolded?.(view) === true
  // The panel on a side chat's view, on the chat the strip tab or menu named.
  const openSideChat = (sessionId, chatId) => {
    ui.set(state => ({ ...state, details: sessionId, view: 'side', side: chatId ?? null, renaming: false, tab: null, panelYield: yieldTo(state, 'side') }))
  }
  // `id` opens one Bot (page 'bots') or one group chat (page 'groups').
  const openSettings = (page = 'general', id = null) => { ui.set(state => ({ ...state, settings: { page, id }, menu: null, palette: null, newChat: null })) }
  return {
    // The pane starts at the rail's edge, so a floating drawer would stick out from under it.
    openNewChat: (mode, sectionId = null) => { ui.set(state => ({ ...state, newChat: mode, newChatSection: sectionId ?? null, menu: null, palette: null })) },
    openPalette: (query = '') => { ui.set(state => ({ ...state, palette: { query, token: Date.now() }, newChat: null, menu: null })) },
    // The token keeps a late exit timer from closing a palette opened again since.
    closePalette: (token) => { ui.set(state => (state.palette && (token === undefined || state.palette.token === token) ? { ...state, palette: null } : state)) },
    openExchange: (a, b) => { if (a && b) ui.set(state => ({ ...state, exchange: [a, b] })) },
    openVoice: (id) => { if (id) ui.set(state => ({ ...state, voice: id, menu: null })) },
    closeVoice: () => { ui.set(state => (state.voice ? { ...state, voice: null } : state)) },
    toggleDetails: (id, force) => {
      ui.set((state) => {
        // Any part of the open Bot closes it, as its header shows it expanded.
        const snap = roster?.getSnapshot?.()
        const same = state.details != null && detailsSubject(snap, state.details) === detailsSubject(snap, id)
        const details = force || !same || state.view !== 'details' ? id : null
        // A folded panel is open but not shown: its opener then means "show it"
        // (it takes the room it needs), not "close it".
        if (details === null && panelFolded?.('details') === true) return { ...state, renaming: false, tab: null, details: id, view: 'details', panelYield: true }
        return { ...state, renaming: false, tab: null, details, view: 'details' }
      })
    },
    // The open panel follows the main view; a subject with no browser (a group
    // chat, an outside Session) settles on the details view. So does one that
    // does not own the open side chat.
    followPanel: (id) => {
      ui.set((state) => {
        if (!state.details || state.details === id) return state
        const snap = roster.getSnapshot()
        const view = state.view === 'browser' && snap.byId[id] === undefined ? 'details'
          : state.view === 'side' && !(snap.sideChats?.[snap.byId[id]?.id] ?? []).some(chat => chat?.id === state.side) ? 'details'
            : state.view
        return { ...state, details: id, view, renaming: false, tab: null }
      })
    },
    showDetails: (id, tab = null) => { ui.set(state => ({ ...state, details: id, view: 'details', renaming: false, tab, panelYield: yieldTo(state, 'details') })) },
    // Opening the conversation would move focus to its composer and blur the name field.
    renameBot: (id) => { ui.set(state => ({ ...state, details: id, view: 'details', renaming: true, tab: null, panelYield: yieldTo(state, 'details') })) },
    openSettings,
    // Omni's own Models page: the providers DSH serves, their keys and models.
    openModels: () => openSettings('models'),
    closeSettings: () => { ui.set(state => (state.settings ? { ...state, settings: null } : state)) },
    openMemory: (id) => { ui.set(state => ({ ...state, memory: id, menu: null, palette: null })) },
    closeMemory: () => { ui.set(state => (state.memory ? { ...state, memory: null } : state)) },
    openConnectors: () => { ui.set(state => ({ ...state, settings: { page: 'connectors', id: null }, menu: null, palette: null, newChat: null })) },
    setPanelView: (view) => {
      if (view !== 'details' && view !== 'browser' && view !== 'side') return
      ui.set(state => (state.details && state.view !== view ? { ...state, view, panelYield: yieldTo(state, view) } : state))
    },
    // A side chat on the panel's own view, opened from the strip, the `···`
    // menus or `/side`. Closing the panel keeps the chats; only a tab's × deletes.
    openSideChat,
    // The roster is pulled before the panel opens on a new chat: a view on a chat
    // the roster does not hold yet folds back into details.
    newSideChat: async (sessionId) => {
      const value = await after(call('side-new', { sessionId }))
      openSideChat(sessionId, value?.chatId)
      return value
    },
    sideCall: (name, body) => after(call(name, body)),
    askSide: (sessionId, chatId, text) => after(call('side-ask', { sessionId, chatId, text })),
    cancelSide: (chatId, entryId) => after(call('side-cancel', { chatId, entryId })),
    closeSideChat: (chatId) => {
      ui.set(state => (state.details && state.view === 'side' && state.side === chatId ? { ...state, view: 'details', side: null } : state))
      return after(call('side-close', { chatId }))
    },
    closePanel: () => { ui.set(state => (state.details ? { ...state, details: null, view: 'details', renaming: false, tab: null, side: null } : state)) },
    quote: (sessionId, text) => ui.set(state => ({ ...state, quote: { sessionId, text, token: Date.now() } })),
    clearQuote: token => ui.set(state => (state.quote?.token === token ? { ...state, quote: null } : state)),
    setFlags: (id, flags) => after(call('set-flags', { id, ...flags })),
    saveSection: payload => after(call('section-save', payload)),
    reorderSections: ids => after(call('section-order', { ids })),
    deleteSection: id => after(call('section-delete', { id })),
    beginSectionRename: id => ui.set(state => ({ ...state, renameSection: id })),
    endSectionRename: () => ui.set(state => (state.renameSection ? { ...state, renameSection: null } : state)),
    deleteRoom: id => after(call('delete-room', { id })),
    openMenu: (menu) => { ui.set(state => ({ ...state, menu, palette: null })) },
    closeMenu: () => { ui.set(state => (state.menu ? { ...state, menu: null } : state)) },
    closeOverlay: () => { ui.set(state => ({ ...state, newChat: null, newChatSection: null, exchange: null, details: state.newChat || state.exchange ? state.details : null })) },
    createBot: payload => after(call('create-bot', payload)),
    // genie-dsh's: the folder's repository's Genie, made in a free color when it has none.
    createGenie: folder => after(call('genie-create', { folder })),
    // welcome-dsh's: the Omni Bot again, after it was deleted (the team view's omniAddable).
    addOmni: () => after(call('omni-add')),
    // The avatar library: photos the user imported once, kept by the host.
    avatarLibrary: (options = {}) => call('avatar-library', options),
    importAvatars: items => call('avatar-import', { items }),
    deleteAvatar: id => call('avatar-delete', { id }),
    createRoom: (members, options = {}) => after(call('create-room', { members, ...options })),
    setBotAuto: (id, rev) => after(call('set-bot-auto', { id, rev })),
    updateBot: (id, patch) => after(call('update-bot', { id, ...patch })),
    attachRole: (id, role) => after(call('role-attach', { id, role })),
    detachRole: id => after(call('role-detach', { id })),
    roleCatalog: () => after(call('role-catalog')),
    installRole: id => after(call('role-install', { id })),
    uninstallRole: id => after(call('role-uninstall', { id })),
    grantRole: (id, role, capability, on) => after(call('role-grant', { id, role, capability, on })),
    roleSettings: (id, role) => call('role-settings', { id, role }),
    setRoleSettings: (id, role, values) => call('role-settings-set', { id, role, values }),
    voicePane: (sessionId, paneId, open, active) => call('voice-pane', { sessionId, paneId, open, active }),
    voiceWait: (sessionId, paneId, callId, signal) => call('voice-wait', { sessionId, paneId, callId }, signal),
    voiceSpoken: (sessionId, paneId, callId, outcome) => call('voice-spoken', { sessionId, paneId, callId, outcome }),
    // A model on another route: the host changes it in place on a chat with nothing said.
    // `patch` carries the thinking level picked with it.
    switchRoute: (id, ref, patch = {}) => after(call('switch-route', { id, ...patch, model: ref })),
    switchRouteInChat: async (id, ref, patch = {}) => {
      try { return await after(call('switch-route', { id, ...patch, model: ref })) } catch (error) {
        // A signed-out agent opens its sign-in row; the pick is made again after it.
        const provider = cliProviderOf(ref)
        if (error?.code === 'bot/sign-in-required' && provider && openCliLogin(id, provider)) return undefined
        if (error?.code === 'bot/account-confirm-required' && provider && openCliLogin(id, provider)) return undefined
        throw error
      }
    },
    // A model chosen in a Bot's chat (rule 2): an agent that is signed out opens the sign-in row
    // in that chat instead of failing; the Bot keeps its model until the sign-in is done.
    // `patch` goes with the model in the same update (its thinking level).
    chooseModelInChat: async (id, ref, patch = {}) => {
      try { return await after(call('update-bot', { id, ...patch, model: ref })) } catch (error) {
        const provider = cliProviderOf(ref)
        if (error?.code === 'bot/sign-in-required' && provider && openCliLogin(id, provider, ref)) return undefined
        // An agent already signed in on this computer, to an account the person has not
        // confirmed for Bots (#869): the same row, at its account step.
        if (error?.code === 'bot/account-confirm-required' && provider && openCliLogin(id, provider, ref)) return undefined
        throw error
      }
    },
    openCliLogin,
    async recoverCliLogin(botId, provider) {
      const bot = cliLoginBotOf(roster.getSnapshot(), botId)
      const manager = loginState?.()
      if (!bot || !manager || !Object.hasOwn(CLI_NAMES, provider)) return false
      const recovered = await manager.recover({ botId: bot.id, provider })
      if (recovered && cliLoginBotOf(roster.getSnapshot(), bot.id)) openSession?.(bot.id)
      return recovered
    },
    cliLoginStart: (botId, provider, model) => call('cli-login-start', loginPayload(botId, provider, model === undefined ? {} : { model })),
    cliLoginCurrent: (botId, provider) => call('cli-login-current', loginPayload(botId, provider)),
    cliLoginStatus: (botId, provider, attemptId, signal) => call('cli-login-status', loginPayload(botId, provider, { attemptId }), signal),
    cliLoginAnswer: (botId, provider, attemptId, value) => call('cli-login-answer', loginPayload(botId, provider, { attemptId, value })),
    cliLoginCancel: (botId, provider, attemptId) => call('cli-login-cancel', loginPayload(botId, provider, { attemptId })),
    cliLoginConnections: () => call('cli-login-connections', {}),
    cliLoginConfirm: (botId, provider, ref, model) => call('cli-login-confirm', loginPayload(botId, provider, { ...(ref === undefined ? {} : { ref }), ...(model === undefined ? {} : { model }) })),
    cliLoginAccounts: options => call('cli-login-accounts', options?.reservations === true ? { reservations: true } : {}),
    cliLoginReserve: (offerId, label, claim) => call('cli-login-reserve', {
      offerId, label, ...(claim?.machineId ? { machineId: claim.machineId }
        : claim === undefined ? {} : { claimId: claim.claimId, rev: claim.rev }),
    }),
    cliLoginRelease: (claimId, rev) => call('cli-login-release', { claimId, rev }),
    cliLoginReleaseMachine: machineId => call('cli-login-release', { machineId }),
    cliLoginSwitch: (botId, provider) => call('cli-login-switch', loginPayload(botId, provider)),
    cliLoginReset: (botId, provider) => call('cli-login-reset', loginPayload(botId, provider)),
    cliLoginSignOut: (botId, provider) => call('cli-login-signout',
      loginPayload(botId, provider)),
    cliLoginNoticed: provider => call('cli-login-noticed', { provider }),
    contextStatus: botId => call('context-status', { botId }),
    usageStats: (botId, sessionId) => call('usage-stats', { botId, sessionId }),
    memoryReviewStatus: botId => call('memory-review-status', { botId }),
    // Do not remap the expected Session: the backend must reject a stale snapshot.
    checkpointBot: (botId, sessionId) => after(call('checkpoint-bot', { botId, sessionId })),
    // Give up one wait the Bot has on a hand-off that will not come back.
    abandonWork: id => after(call('abandon-work', { id })),
    refreshModels: () => after(call('models')).catch(() => {}),
    // One local agent's models: the first look starts its CLI, later ones read what it said.
    agentModels: route => after(call('local-agent-models', { route })).catch(() => {}),
    efforts: ref => call('efforts', { ref }),
    // Model providers and their API keys; DSH keeps them, and a key only travels to the host.
    providers: () => call('providers'),
    setProviderKey: (provider, value) => after(call('provider-key', { provider, value })),
    addProvider: body => after(call('provider-add', body)),
    providerModels: body => call('provider-models', body),
    removeProvider: provider => after(call('provider-remove', { provider })),
    // After a failed turn: the Bot answers the user's last unanswered message, which is never sent again.
    resume: botId => after(call('resume', { botId })),
    folders: () => call('folders'),
    folderProbe: path => call('folder-probe', { path: path ?? '' }),
    folderPick: () => call('folder-pick'),
    folderList: path => call('folder-list', { path: path ?? '' }),
    setTeamWorkspace: path => after(call('team-workspace', { path })),
    deleteBot: id => after(call('delete-bot', { id })),
    rollbackAdoption: agentId => after(call('agent-bot-rollback', { agentId })),
    releasePrivate: id => after(call('private-release', { id })),
    duplicateBot: id => after(call('duplicate-bot', { id })),
    setPrefs: prefs => after(call('set-prefs', prefs)),
    setMain: (id, main = true, options = {}) => after(call('set-main', { id, main, ...options })),
    updateRoom: (id, patch) => after(call('update-room', { id, ...patch })),
    send: (sessionId, text, voicePane) => after(call('send', { sessionId: partFor(sessionId), text, ...(voicePane ? { voicePane } : {}) })),
    answerQuestion: (sessionId, questionId, answer) => after(call('answer-question', { sessionId: partFor(sessionId), questionId, answer })),
    dismissQuestion: sessionId => after(call('dismiss-question', { sessionId })),
    answerView: (sessionId, viewId, action, values) => after(call('view-reply', { sessionId: partFor(sessionId), viewId, action, values })),
    dismissView: sessionId => after(call('dismiss-view', { sessionId: partFor(sessionId) })),
    deleteBtw: (sessionId, cardId) => after(call('btw-delete', { sessionId, cardId })),
    answerApproval: (id, choice) => after(call('approval-answer', { id, choice, client: 'web' })),
    computerSetEnabled: enabled => after(call('computer-set-enabled', { enabled })),
    computerSetLevel: (botId, level) => after(call('computer-set-level', { botId, level })),
    computerRevokeApp: (botId, appKey) => after(call('computer-revoke-app', { botId, appKey })),
    computerProviderRetry: () => after(call('computer-provider-retry', {})),
    computerSystemStatus: () => call('computer-system-status', {}),
    computerPermission: permission => call('computer-permission', { permission }),
    computerStop: (botId, all = false) => after(call('computer-stop', all ? { all: true } : { botId })),
    computerTakeover: botId => after(call('computer-takeover', { botId })),
    computerHandback: botId => after(call('computer-handback', { botId })),
    computerAllowForeground: botId => call('computer-allow-foreground', { botId }),
    computerAppAnswer: (id, answer) => call('computer-app-answer', { id, answer }),
    computerHoldAnswer: (botId, { callId, outcome } = {}) => after(call('computer-hold-answer', { botId, ...(callId !== undefined ? { callId } : {}), outcome })),
    computerShot: attachmentId => call('computer-shot', { attachmentId }),
    computerUserActive: idleSeconds => call('computer-user-active', { idleSeconds }),
    stopMemberWork: (roomId, botId) => after(call('stop-member-work', { roomId, botId })),
    stopRoomWork: roomId => after(call('stop-room-work', { roomId })),
    goalDraft: (roomId, text) => after(call('goal-draft', { roomId, text })),
    goalControl: (roomId, goalId, action, stopWork) => after(call('goal-control', { roomId, goalId, action, ...(stopWork ? { stopWork: true } : {}) })),
    // The goal island: `goalCompose` holds the room whose draft form is open,
    // `goalOpen` the room whose panel is open.
    composeGoal: roomId => ui.set(state => ({ ...state, goalCompose: roomId, goalOpen: roomId })),
    closeGoalCompose: () => ui.set(state => (state.goalCompose ? { ...state, goalCompose: null } : state)),
    toggleGoal: roomId => ui.set(state => ({ ...state, goalOpen: state.goalOpen === roomId ? null : roomId })),
    closeGoal: () => ui.set(state => (state.goalOpen ? { ...state, goalOpen: null } : state)),
    // Values go out in these requests and never come back in a response.
    secretSet: payload => after(call('secret-set', payload)),
    secretAllow: (requestId, approval) => after(call('secret-allow', { ...approval, requestId })),
    secretSourceDetail: requestId => call('secret-source-detail', { requestId }),
    vaultStatus: (signal, provider) => call('vault-status', provider === undefined ? undefined : { provider }, signal),
    vaultUnlock: (password, connection) => call('vault-unlock', { provider: 'bitwarden', password, connection }),
    vaultUnlockSecretService: () => call('vault-unlock', { provider: 'secret-service' }),
    vaultUnlockSaved: (provider, connection, credentialRevision) => call('vault-unlock', { provider, connection,
      ...(credentialRevision === undefined ? {} : { credentialRevision }) }),
    vaultLock: provider => provider === undefined ? call('vault-lock') : call('vault-lock', { provider }),
    vaultItems: (search, provider, project) => call('vault-items', provider === 'hashicorp-vault'
      ? { provider, ...search } : { search, ...(provider === undefined ? {} : { provider }),
        ...(project === undefined ? {} : { project }) }),
    vaultFields: (provider, mount, path) => call('vault-fields', { provider, mount, path }),
    vaultTokenSet: (provider, token, connection, server, credentialRevision) => call('vault-token-set', provider === 'hashicorp-vault'
      ? { provider, token, ...connection } : { provider, token, connection, ...(server === undefined ? {} : { server }),
        ...(credentialRevision === undefined ? {} : { credentialRevision }) }),
    vaultTokenClear: (provider, connection, credentialRevision) => call('vault-token-clear', { provider,
      ...(connection === undefined ? {} : { connection }), ...(credentialRevision === undefined ? {} : { credentialRevision }) }),
    secretSourceSet: mapping => after(call('secret-source-set', mapping)),
    secretCancel: requestId => after(call('secret-cancel', { requestId })),
    secretUpdate: (name, { scope, purpose } = {}) => after(call('secret-update', { name, scope, purpose })),
    secretDelete: name => after(call('secret-delete', { name })),
    secretSourceClear: name => after(call('secret-source-clear', { name })),
    connectorConnect: (id, payload = {}) => after(call('connector-connect', { id, ...payload })),
    connectorDisconnect: id => after(call('connector-disconnect', { id })),
    connectorRetry: id => after(call('connector-retry', { id })),
    connectorSignInCode: (id, input) => after(call('connector-sign-in-code', { id, input })),
    connectorCancel: id => after(call('connector-cancel', { id })),
    connectorClient: (id, clientId, clientSecret) => after(call('connector-client', { id, clientId, clientSecret })),
    connectorSet: (id, patch) => after(call('connector-set', { id, ...patch })),
    connectorAdd: spec => after(call('connector-add', spec)),
    connectorRemove: id => after(call('connector-remove', { id })),
    connectorImportScan: () => call('connector-import-scan', {}),
    connectorImport: items => after(call('connector-import', { items })),
    connectorRequestCancel: requestId => after(call('connector-request-cancel', { requestId })),
    mailAccountAdd: payload => after(call('mail-account-add', payload)),
    mailAccountRemove: id => after(call('mail-account-remove', { id })),
    mailRuleSet: payload => after(call('mail-rule-set', payload)),
    mailSendAnswer: (requestId, choice, extra = {}) => after(call('mail-send-answer', { requestId, choice, ...extra })),
    mailSignInCode: payload => after(call('mail-sign-in-code', payload)),
    imAdd: payload => after(call('im-add', payload)),
    imUpdate: (id, patch) => after(call('im-update', { id, ...patch })),
    imRemove: id => after(call('im-remove', { id })),
    imPair: (id, senderId, allow) => after(call('im-pair', { id, senderId, allow })),
    imUnpair: (id, senderId) => after(call('im-unpair', { id, senderId })),
    imChat: (id, body) => after(call('im-chat', { id, ...body })),
    imRetry: id => after(call('im-retry', { id })),
    imLoginStart: payload => call('im-login-start', payload),
    imLoginWait: payload => call('im-login-wait', payload),
    saveCapability: capability => after(call('capability-save', capability)),
    deleteCapability: name => after(call('capability-delete', { name })),
    approveCapability: name => after(call('capability-approve', { name })),
    setBotCapability: (botId, name, attached) => after(call('bot-capability', { botId, name, attached })),
    schedules: () => call('schedules'),
    scheduleCreate: task => call('schedule-create', task),
    scheduleDelete: (sessionId, id) => call('schedule-delete', { sessionId, id }),
    exchange: (a, b) => call('exchange', { a, b }).catch(() => []),
    exchangeText: (id, a, b) => call('exchange-text', { id, ...(a !== undefined && b !== undefined ? { a, b } : {}) }).catch(() => undefined),
    fileText: file => call('file-text', { file }).catch(() => undefined),
    roomProgress: roomId => call('room-progress', { roomId }).catch(() => []),
    groupRows: (roomId, from, to, anchor) => call('group-rows', { roomId, from, ...(to === undefined ? {} : { to }), ...(anchor === undefined ? {} : { anchor }) }).catch(() => null),
    earlier: (sessionId, cursor) => call('earlier', { sessionId, cursor: cursor ?? null }),
    // Hours come back in this browser's time zone, so days start at local midnight.
    usage: () => call('usage', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    // `summarize` starts a summary when the entries changed; `regenerate` always does.
    memoryView: (id, flags = {}) => call('memory-view', { ...memoryOf(id), ...flags }),
    memoryAsk: (id, text) => call('memory-ask', { ...memoryOf(id), text }),
    memoryLayer: (id, entry, always) => call('memory-layer', { ...memoryOf(id), topic: entry.topic, text: entry.text, always }),
    memoryMove: (id, entry, to) => call('memory-move', { ...memoryOf(id), scope: entry.scope, topic: entry.topic, text: entry.text, to }),
    memoryTidyUndo: (id, scope, batch) => call('memory-tidy-undo', { ...memoryOf(id), scope, batch }),
    memoryPin: (id, entry, pin) => call('memory-pin', { ...memoryOf(id), scope: entry.scope, topic: entry.topic, text: entry.text, pin }),
    memoryForget: (id, entry) => call('memory-forget', { ...memoryOf(id), scope: entry.scope, topic: entry.topic, text: entry.text }),
    memoryHistory: (id, before) => call('memory-history', { ...memoryOf(id), ...(before === undefined ? {} : { before }) }),
    memoryRestore: (id, rowId) => call('memory-restore', { ...memoryOf(id), id: rowId }),
    diagnostics: payload => call('diagnostics', payload),
    // Pets (pets.js): those on this computer, a page of codex-pets.net, and one put on a Bot.
    pets: () => call('pets'),
    petsBrowse: (query, page, sort) => call('pets-browse', { query, page, sort }),
    petUse: (botId, source, id) => after(call('pet-use', { botId, source, id })),
    agentAccess: () => call('agent-access'),
    agentTokenCreate: name => call('agent-token-create', { name }),
    agentTokenRevoke: id => call('agent-token-revoke', { id }),
    privacy: () => call('privacy'),
    privacySet: (share, on) => call('privacy-set', { share, on }),
    diagnosticsLog: () => call('diagnostics-log'),
    diagnosticsClear: () => call('diagnostics-clear'),
    diagnosticsPermissions: () => call('diagnostics-permissions'),
    repoStars: () => call('repo-stars'),
    checkSelfUpdate: () => call('self-update-check'),
    // A failed action away from any form (a menu, the palette) shows as a toast.
    reportError: (error, where = 'action') => {
      noteClientError(where, error)
      ui.set(state => ({ ...state, toast: { text: error?.message ?? String(error), token: Date.now() } }))
    },
    // A notice that is no failure (a refused paste of a sign-in code): a toast, not a diagnostic.
    showNotice: text => ui.set(state => ({ ...state, toast: { text, token: Date.now() } })),
    dismissToast: token => ui.set(state => (state.toast && (token === undefined || state.toast.token === token) ? { ...state, toast: null } : state)),
    noteTurnTime: (sessionId, turn, key, time) => {
      if (sessionId === undefined || !Number.isFinite(turn) || !Number.isFinite(time)) return
      turnClock.set((state) => {
        const turns = state[sessionId] ?? {}
        const entry = turns[turn] ?? {}
        const next = key === 'first' && entry.first !== undefined ? Math.min(entry.first, time) : time
        if (entry[key] === next) return state
        return { ...state, [sessionId]: { ...turns, [turn]: { ...entry, [key]: next } } }
      })
    },
    noteTurnPeer: (sessionId, turn, peerId) => {
      if (sessionId === undefined || !Number.isFinite(turn)) return
      turnClock.set((state) => {
        const turns = state[sessionId] ?? {}
        const entry = turns[turn] ?? {}
        if (entry.peer === peerId) return state
        return { ...state, [sessionId]: { ...turns, [turn]: { ...entry, peer: peerId } } }
      })
    },
    noteLive: (sessionId, id, entry) => {
      if (sessionId === undefined) return
      live.set((state) => {
        const own = state[sessionId] ?? {}
        const prev = own[id]
        if (entry === null ? prev === undefined : prev !== undefined && JSON.stringify({ ...prev, at: 0 }) === JSON.stringify({ ...entry, at: 0 })) return state
        const next = { ...own }
        if (entry === null) delete next[id]
        else next[id] = { ...entry, at: prev?.at ?? Date.now() }
        return { ...state, [sessionId]: next }
      })
    },
    noteCards: (sessionId, callIds, delta) => {
      if (sessionId !== undefined) cards.set(state => countCards(state, sessionId, callIds, delta))
    },
    noteHeldCard: (sessionId, kind, requestId, delta) => {
      if (sessionId !== undefined) heldCards.set(state => countCards(state, sessionId, [heldCardKey(kind, requestId)], delta))
    },
    clearLive: sessionId => live.set((state) => {
      if (!state[sessionId]) return state
      const next = { ...state }
      delete next[sessionId]
      return next
    }),
  }
}
