// Client channel: the team view the browser renders, and the POST /api/bot endpoints.
import { randomUUID } from 'node:crypto'
import { createSpaceReads } from './agent-space.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { MCP_PATH, AGENT_TOOLS, botConfig, roomConfig, createAgentAccess } from './agent-access.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { install as installBtw } from './btw.js'
import { createPrivacy } from './privacy.js'
import { createPets } from './pets.js'
import { CODE_REFUSED } from './cli-login.js'
import { install as installSide } from './side.js'
import { handoffReply, questionReply, viewReply } from './parts.js'
import { defaultRelayLimit } from './groups.js'
import { validateViewAnswer } from '../shared/views.js'
import { previewText } from '../shared/plain-text.js'
import { normalizeAddressList } from './browser/address-policy.js'
import { COLORS, EXTRA_COLORS, IMAGE_ROUTE, PET_CODEX_ROUTE, PET_ROUTE, ROUTE } from './constants.js'

const LANGUAGES = { zh: 'Chinese (简体中文)', en: 'English' }
const RUN_STATS = ['sessionStats', 'tokenUsage', 'contextPressure']
// Where the English interface allows an MCP server: the words the Bot names until a browser
// reports its own (rt.allowPlace below).
const DEFAULT_ALLOW_PLACE = 'Settings > Capabilities > Allow'

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
// Programming and file system errors are DS Bot's own faults, logged with their stack;
// any other error is a refusal whose message is meant for the user.
const isInternal = error => error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError
  || error instanceof SyntaxError || (typeof error?.code === 'string' && /^E[A-Z_]+$/.test(error.code))
export function errorCode(error) {
  if (typeof error?.code === 'string' && error.code.startsWith('bot/')) return error.code
  return isInternal(error) ? 'bot/internal' : 'bot/refused'
}
// The codes whose message this code itself wrote for the user. A provider or file
// system error carries no such code, so its message is never answered.
const exposition = error => (typeof error?.code === 'string' && /^(?:bot|memory)\//.test(error.code) ? error.code : undefined)
// The error's kind, for a log line and a reply: a code or a class name, never text
// that can carry a path, a request or a key.
const errorKind = error => [error?.code, error?.name].find(value => typeof value === 'string' && /^[\w./-]{1,40}$/.test(value)) ?? 'error'

export function install(rt) {
  installBtw(rt)
  installSide(rt)
  const { ctx, state } = rt

  // The DSH interface language of the last browser that asked for the team.
  let uiLocale
  rt.uiLanguage = () => (uiLocale === undefined ? undefined : LANGUAGES[uiLocale.split('-')[0].toLowerCase()] ?? uiLocale)
  // Where the user allows an MCP server, in that browser's words (places.js builds it from the
  // interface's own strings, "Configurações > Recursos > Permitir" in pt-BR), so the Bot names
  // the place as the user sees it. Until a browser says, the English interface's words.
  // The reported words are stripped, not rewritten: invisible format marks (Cf: zero-width
  // spaces, bidi controls such as U+202E, the BOM; also U+200D, so an emoji ZWJ sequence
  // splits) and line and paragraph separators (Zl U+2028, Zp U+2029) are removed and nothing
  // is put in their place; the rest is trimmed. Text that still holds a control character (Cc,
  // a newline or tab) is not one short line and is ignored whole, keeping the previous words;
  // so is anything empty or over 120 characters after the strip. So allowPlace() never holds
  // a Cc, Cf, Zl or Zp character.
  let uiAllowPlace
  rt.allowPlace = () => uiAllowPlace ?? DEFAULT_ALLOW_PLACE

  const ok = value => ({ ok: true, value })
  const fail = (message, code = 'bot/error') => ({ ok: false, error: { code, message, details: {} } })
  // Models come from DSH, not state.json, so a provider added in Harness settings
  // changes the view without a new revision. So do the permission presets DSH offers and
  // the Bots and groups whose Auto runs as workspace-write (permissions.js).
  const modelsKey = () => [
    rt.cachedCatalog().map(entry => [
      entry.ref, entry.needsKey ? '!' : '', entry.needsSignIn ? '?' : '',
      entry.needsAccount ? '~' : '', entry.covered ? '=' : '',
      entry.via ? `@${entry.via}` : '',
      entry.reasoning ? `:${JSON.stringify(entry.reasoning)}` : '',
    ].join('')).join(','),
    rt.cachedDefault() ?? '', rt.cachedBackground?.() ?? '', rt.permissionKey?.() ?? '',
    rt.modelsEpoch?.() ?? 0,
  ].join('|')
  const view = () => ({
    revision: state.revision,
    workspaceId: state.workspaceId ?? null,
    // `mainBotId` is the first Main Bot, which the sidebar shows as its tile.
    mainBotId: state.mainBotIds[0] ?? null,
    mainBotIds: state.mainBotIds,
    // What other Omni plugins add to the view (extend.js): the automations, for one.
    ...rt.extended.view(),
    // Tasks a Bot started (agents.js), for their live cards in the chat.
    tasks: state.tasks ?? {},
    // `sessionId` is the Bot's current own-chat part; `parts` its earlier ones.
    // `waiting`: the Bot holds its greeting until the user picks its model.
    // `adoptionHistoryMatches` (adopted originals only): rollback's history guard
    // (agents.js rollbackAdoption) would pass, so the menu offers rollback only then.
    bots: Object.values(state.bots).map(({ segments, kickoff, ...bot }) => ({
      ...bot, sessionId: rt.chatOf(bot.id), parts: (segments ?? []).map(segment => segment.sessionId), ...(kickoff ? { waiting: true } : {}),
      ...(bot.dshAgentId === undefined ? {} : { adoptionHistoryMatches: rt.adoptionHistoryMatches(bot.id) }),
      ...rt.permissionFallbackOf('bot', bot),
      ...rt.autoViewOf?.(bot),
    })),
    // `parts`: the members' hidden group Sessions and their earlier segments, for usage.
    rooms: Object.values(state.rooms).map(({ log, seen, lateRounds, relays, sessions, segments, ...room }) => {
      const parts = [...Object.values(sessions ?? {}), ...Object.values(segments ?? {}).flat().map(segment => segment.sessionId)]
      const last = (log ?? []).filter(line => line.kind === undefined).at(-1)
      // The row's one line: the start of the last message, without its markdown marks (#1155).
      const said = last ? previewText(last.text) : ''
      return { ...room, relayLimitDefault: defaultRelayLimit(room), parts, ...rt.permissionFallbackOf('room', room), ...(said ? { preview: last.who === 'User' ? said : `${last.who}：${said}` } : {}) }
    }),
    exchangeTurns: state.exchangeTurns,
    questions: state.questions,
    views: state.views ?? {},
    // Aside answers of each Bot's current part, newest first. Not part of the
    // model-visible history; earlier parts send their cards on their own pages.
    btwCards: rt.btwView?.() ?? {},
    // Each Bot's side chats, in creation order. The answers never join the
    // model-visible history; the side panel reads them here.
    sideChats: rt.sideView?.() ?? {},
    // The DSH bots (`kind: 'dsh'`) and the tasks record (`kind: 'tasks'`): plain dsh
    // Sessions, not Bots.
    agents: Object.values(state.agents).filter(agent => agent.adoptedBotId === undefined && agent.pendingCreation !== true),
    // Key names and who may use them; values never leave the host.
    secrets: rt.secretsView(),
    capabilities: rt.capabilityLibraryView(),
    secretRequests: state.secretRequests ?? {},
    colors: [...COLORS, ...EXTRA_COLORS],
    models: rt.cachedCatalog(),
    defaultModel: rt.cachedDefault() ?? null,
    backgroundModel: rt.cachedBackground?.() ?? null,
    permissions: rt.permissionCatalog?.() ?? null,
    modelsKey: modelsKey(),
    prefs: state.prefs,
    // Whether a Desktop window should serve Bot browser reads (see browser.js).
    browser: rt.browserEnabled,
    // Who holds each Bot's own browser (browser-plugins.js), for windows without the panel.
    browserHolds: rt.browserChannel?.holdSnapshot() ?? {},
    // Each Bot's saved tabs (browser/tabs.js): the panel lists them in the Automagik app.
    browserTabs: rt.browserTabsView?.() ?? {},
    // False when config.memory turns memory off: no Memory row or panel.
    memory: rt.memoryEnabled !== false,
    // Set while another dsh host holds the team (store.js): why this one cannot change it.
    readOnly: rt.readOnly() ?? null,
    // Which selector routes each bot type may use (shared/routes.js); absent: all three.
    ...(rt.routePolicy === undefined ? {} : { routePolicy: rt.routePolicy }),
  })
  // What changes without a new revision, sent with every state answer. `memoryNews`:
  // per Bot or group chat, its latest memory change; `memoryReviews`: memory reviews waiting or
  // running; `work`: per Bot, the turn it runs and its tool; per group, the members whose
  // turn there runs; the approvals waiting; permission stops; per Bot, who it waits for to hand back work;
  // and per Session, when its running turn began.
  const live = () => ({
    activity: rt.activityView(),
    work: { bots: rt.workView(), rooms: rt.roomWorkView(), approvals: rt.approvalsView(), stops: rt.stopsView?.() ?? [], waiting: rt.waitingView?.() ?? {}, turns: rt.turnsView?.() ?? {}, failed: rt.failedView?.() ?? {}, steered: rt.steeredView?.() ?? {}, models: rt.modelStateView?.() ?? {} },
    memoryNews: rt.memoryNews(),
    memoryReviews: rt.memoryReviews(),
    connectors: rt.connectorsView(),
    capabilityStatuses: rt.capabilityStatusesView(),
    ...rt.extended.live(),
    // Per Bot whose model menu a plugin owns, that menu (host-models.js); absent otherwise.
    ...rt.hostModelsView?.(),
    // Per plan route whose Bots wait for its CLI (subscription-move.js), why; absent otherwise.
    ...rt.subscriptionWaitingView?.(),
    // Channels moved to their own plugin: a team linked to an Omni (omni.json, which that
    // plugin keeps, or the older omni.url on this row) whose DSH has only this plugin
    // learns where they went.
    channelsMoved: ctx.get?.('omniChannels') === undefined && (typeof rt.config?.omni?.url === 'string' || existsSync(join(rt.home, 'omni.json'))),
    // Whether the channels plugin operates an Omni here. Then a Bot that operates it (every
    // Main Bot, and the Omni Bot) works through Omni's tools and has no computer: that plugin
    // takes DSH's shell and file tools from its Sessions (omni-channels-dsh grants.js
    // operatesHere). Its runtime is its own child of this one, so it is read from the service.
    omniLinked: omniLinked(),
  })
  const omniLinked = () => {
    const channels = ctx.get?.('omniChannels')
    if (channels === undefined || channels === null) return false
    try {
      return Boolean(channels.omniNamed?.() ?? channels.config?.omni?.url)
    } catch {
      return false
    }
  }
  // What a host that only reads the team may still answer.
  // Updates change the dsh profile, not the team, so a reading host may run them too.
  const privacy = createPrivacy()
  const pets = createPets({ home: () => rt.home, warn: (...args) => rt.warn?.(...args) })
  const READS = new Set(['privacy', 'pets', 'pets-browse', 'image-access', 'image-progress', 'state', 'models', 'efforts', 'providers', 'provider-models', 'earlier', 'chat', 'run-stats', 'context-status', 'usage-stats', 'memory-review-status', 'room-progress', 'exchange', 'exchange-text', 'file-text', 'usage', 'schedules', 'memory-view', 'browser-wait', 'browser-result', 'diagnostics', 'diagnostics-log', 'diagnostics-clear', 'diagnostics-permissions', 'update-check', 'update-install', 'dsh-update-install', 'repo-stars', 'approval-answer', 'thinking', 'agent-presets', 'avatar-library', 'model-state', 'cli-login-current', 'cli-login-status', 'cli-login-connections', 'cli-login-accounts', 'cli-login-noticed'])
  // Sign-in (cli-login.js): its replies are never cached by the browser.
  const CLI_LOGIN = new Set([
    'cli-login-start', 'cli-login-current', 'cli-login-status', 'cli-login-answer',
    'cli-login-cancel', 'cli-login-connections', 'cli-login-confirm', 'cli-login-accounts',
    'cli-login-noticed', 'cli-login-switch', 'cli-login-signout', 'cli-login-reset',
  ])
  // The endpoints whose text reaches a Bot or a model: one that carries a Claude sign-in state
  // acp-dsh showed is refused before anything is queued (cli-login.js, loginTextMatches).
  const CODE_GUARDED = new Set(['send', 'side-ask', 'answer-question', 'view-reply', 'memory-ask'])
  // Every string of the payload, at any depth and width, its keys included (#871): the walk
  // stops at nothing, so no nesting hides a text. The payload is the parsed JSON body of one
  // buffered request, so the walk is linear in a size DSH already bounds, and has no cycle
  // (`seen` only keeps another caller's object from looping). None of these endpoints takes a
  // file: an attachment reaches a Bot through DSH's own composer, never through this route.
  const textsOf = (payload) => {
    const out = []
    const seen = new Set()
    const stack = [payload]
    while (stack.length > 0) {
      const value = stack.pop()
      if (typeof value === 'string') out.push(value)
      else if (value !== null && typeof value === 'object' && !seen.has(value)) {
        seen.add(value)
        if (Array.isArray(value)) for (const item of value) stack.push(item)
        else for (const key of Object.keys(value)) stack.push(key, value[key])
      }
    }
    return out
  }

  async function setPrefs(body) {
    if (body.theme !== undefined) {
      if (typeof body.theme !== 'string' || !/^[a-z][\w-]{0,31}$/.test(body.theme)) throw invalid('Unknown theme')
      state.prefs.theme = body.theme
    }
    if (body.accent !== undefined) {
      if (body.accent === null || body.accent === '') delete state.prefs.accent
      else if (/^#[0-9a-f]{6}$/i.test(body.accent)) state.prefs.accent = body.accent
      else throw invalid('Accent must be a #rrggbb color')
    }
    if (body.motion !== undefined) {
      if (body.motion === null || body.motion === 'normal') delete state.prefs.motion
      else if (body.motion === 'quiet' || body.motion === 'lively') state.prefs.motion = body.motion
      else throw invalid('Motion must be quiet, normal or lively')
    }
    if (body.layout !== undefined) {
      if (body.layout === null || body.layout === 'bubble') delete state.prefs.layout
      else if (body.layout === 'flat') state.prefs.layout = body.layout
      else throw invalid('Layout must be bubble or flat')
    }
    if (body.width !== undefined) {
      if (body.width === null || body.width === 80) delete state.prefs.width
      else if (Number.isInteger(body.width) && body.width >= 50 && body.width <= 100) state.prefs.width = body.width
      else throw invalid('Width must be a whole percent from 50 to 100')
    }
    if (body.flatWidth !== undefined) {
      if (body.flatWidth === null || body.flatWidth === 100) delete state.prefs.flatWidth
      else if (Number.isInteger(body.flatWidth) && body.flatWidth >= 50 && body.flatWidth <= 100) state.prefs.flatWidth = body.flatWidth
      else throw invalid('Flat text width must be a whole percent from 50 to 100')
    }
    if (body.thinking !== undefined) {
      // A value this version does not know is ignored, not refused: the toggle
      // may grow more states later.
      if (body.thinking === true) state.prefs.thinking = true
      else if (body.thinking === false || body.thinking === null) delete state.prefs.thinking
    }
    // The Bot browser's and web_fetch's address lists. Both default to empty, which
    // allows every address, including localhost, LAN and tailnet targets.
    for (const [key, label] of [['browserAllow', 'Allow list'], ['browserDeny', 'Deny list']]) {
      if (body[key] === undefined) continue
      if (body[key] === null) {
        delete state.prefs[key]
        continue
      }
      try {
        state.prefs[key] = normalizeAddressList(body[key], label)
      } catch (error) {
        throw invalid(error.message)
      }
    }
    // The team default: the permission level a new Bot starts with.
    if (body.permission !== undefined) {
      if (body.permission === null || body.permission === '') delete state.prefs.permission
      else state.prefs.permission = rt.checkPreset(body.permission)
    }
    // The background jobs' model (models.js backgroundModel): a model DSH serves, with its key
    // set, that answers beside the chats, never an agent over ACP. None: DSH's default model.
    if (body.backgroundModel !== undefined) {
      if (body.backgroundModel === null || body.backgroundModel === '') delete state.prefs.backgroundModel
      else {
        const ref = String(body.backgroundModel)
        if (!rt.answersAside(ref)) throw invalid('An agent over ACP answers only in its own chat, so it cannot run background jobs')
        const entry = (await rt.catalog({ fresh: true })).find(item => item.ref === ref)
        if (entry === undefined) throw invalid(`Model ${ref.slice(0, 80)} is not available`)
        if (entry.needsKey) throw invalid(`Model ${ref.slice(0, 80)} has no key yet: add one in Connect AI first`)
        state.prefs.backgroundModel = ref
      }
    }
    return rt.save()
  }

  // UI edits retain their existing concurrency. An MCP audit excludes UI config edits
  // for its entire before/handler/after interval, so attribution cannot absorb an owner edit.
  const adminContext = new AsyncLocalStorage()
  const inTransaction = async fn => {
    const scope = { active: true }
    try { return await adminContext.run(scope, fn) }
    finally { scope.active = false }
  }
  let adminQueue = Promise.resolve()
  let pendingAgents = 0
  let activeOwners = 0
  let ownersIdle
  const adminTransaction = fn => {
    pendingAgents += 1
    const job = adminQueue.then(async () => {
      if (activeOwners > 0) await new Promise(resolve => { ownersIdle = resolve })
      return inTransaction(fn)
    }).finally(() => { pendingAgents -= 1 })
    adminQueue = job.catch(() => {})
    return job
  }
  const ownerTransaction = async fn => {
    if (adminContext.getStore()?.active) return fn()
    while (pendingAgents > 0) await adminQueue
    activeOwners += 1
    try { return await inTransaction(fn) }
    finally {
      activeOwners -= 1
      if (activeOwners === 0) { ownersIdle?.(); ownersIdle = undefined }
    }
  }
  // Internal Bot tools call these same runtime mutators directly. They participate as
  // owners; nested calls from an already admitted handler reuse its admission.
  for (const name of ['createBot', 'duplicateBot', 'updateBot', 'deleteBot', 'setMain',
    'createRoom', 'updateRoom', 'deleteRoom', 'setFlags', 'bootstrap', 'switchRoute',
    'addAgent', 'removeAgent', 'adoptAgentSession', 'adoptBotSession', 'adoptAsBot',
    'rollbackAdoption']) {
    const original = rt[name]
    if (typeof original === 'function') {
      rt[name] = (...args) => ownerTransaction(() => original(...args))
    }
  }
  const adminActions = new Set([...AGENT_TOOLS.map(tool => tool.endpoint),
    'state', 'switch-route', 'duplicate-bot', 'add-agent', 'remove-agent', 'set-flags',
    'agent-adopt', 'bot-session-adopt', 'agent-bot-adopt', 'agent-bot-rollback'])
  const spaceReads = rt.spaceReads ?? createSpaceReads(rt)
  const handle = async (endpoint, payload, signal) => {
    try {
      const body = payload ?? {}
      // The permission section of the diagnostics page (permission-diagnostics.js): answered
      // from memory before the refresh below, which may load the team or take its lock. It
      // takes no input.
      if (endpoint === 'diagnostics-permissions') return ok(rt.permissionDiagnostics())
      await rt.refresh()
      const readOnly = rt.readOnly()
      // An endpoint another Omni plugin serves (extend.js) says itself whether it only reads.
      const added = rt.extended.endpointOf(endpoint)
      if (readOnly !== undefined && !READS.has(endpoint) && !AGENT_TOOLS.some(tool => tool.read
        && tool.endpoint === endpoint) && added?.read !== true) {
        return fail(readOnly, 'bot/read-only')
      }
      if (CODE_GUARDED.has(endpoint) && textsOf(body).some(text => rt.loginTextMatches?.(text) === true)) return fail(CODE_REFUSED, 'bot/refused')
      if (CLI_LOGIN.has(endpoint)) return ok(await rt.cliLoginActions[endpoint](body))
      if (endpoint.startsWith('space-')) return ok(await spaceReads.read(endpoint, body, handle))
      switch (endpoint) {
        case 'agent-access':
          return ok(await agentAccess.owner('view'))
        case 'agent-token-create':
          return ok(await agentAccess.owner('create', body))
        case 'agent-token-revoke':
          return ok(await agentAccess.owner('revoke', body))
        case 'list-bots':
          return ok(Object.values(state.bots).map(bot => botConfig(bot, state.mainBotIds)))
        case 'get-bot':
          return ok(botConfig(rt.own(state.bots, body.id), state.mainBotIds))
        case 'list-rooms':
          return ok(Object.values(state.rooms).map(roomConfig))
        case 'get-room':
          return ok(roomConfig(rt.own(state.rooms, body.id)))
        case 'state':
          if (typeof body.locale === 'string' && /^[a-z]{2,3}(-[\w-]+)?$/i.test(body.locale)) uiLocale = body.locale
          if (typeof body.allowPlace === 'string') {
            const place = body.allowPlace.replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim()
            if (/^[^\p{Cc}]{1,120}$/u.test(place)) uiAllowPlace = place
          }
          if (readOnly === undefined) await rt.bootstrap()
          await rt.catalog()
          await rt.loadSecrets()
          if (body.since === state.revision && (body.models === undefined || body.models === modelsKey())) return ok({ revision: state.revision, unchanged: true, ...live() })
          return ok({ ...view(), ...live() })
        case 'models':
          await rt.refreshHostModels?.()
          await rt.catalog({ fresh: true })
          return ok({ modelsKey: modelsKey() })
        case 'efforts':
          return ok(await rt.reasoningOf(String(body.ref ?? '')) ?? { efforts: [] })
        // What one Bot's model really did (model-state.js): the pick, the model it goes back
        // to, the last call started, the last answer and failure, and whether it can run now.
        case 'model-state': {
          const view = await rt.modelStateOf(String(body.id ?? ''))
          if (view === undefined) throw Object.assign(new Error('Unknown Bot'), { code: 'bot/refused' })
          return ok(view)
        }
        // A Turn's exact thinking time, from the timed stream in its events; `ms`
        // omitted when the stream carries no reasoning records.
        case 'thinking': {
          const sessionId = String(body.sessionId ?? '')
          const turn = Number(body.turn)
          if (!Number.isFinite(turn) || rt.selfOf(sessionId) === undefined) return ok(null)
          await rt.load()
          const ms = await rt.thinkingOf(sessionId, turn)
          return ok(ms === undefined ? {} : { ms })
        }
        // Model providers and their keys, for a window without DSH's own Models page.
        case 'providers':
          return ok(await rt.providersView())
        case 'provider-key':
          if (body.value === null) await rt.clearProviderKey(String(body.provider ?? ''))
          else await rt.setProviderKey(String(body.provider ?? ''), body.value)
          return ok(await rt.providersView())
        case 'provider-add':
          return ok(await rt.addProvider(body))
        case 'provider-models':
          return ok(await rt.discoverModels(body))
        case 'provider-remove':
          return ok(await rt.removeProvider(String(body.provider ?? '')))
        case 'duplicate-bot':
          await rt.load()
          return ok(await rt.duplicateBot(body.id))
        case 'set-prefs':
          await rt.load()
          await setPrefs(body)
          return ok(state.prefs)
        case 'exchange': {
          await rt.load()
          const pair = new Set([body.a, body.b])
          return ok(state.exchanges.filter(entry => pair.has(entry.from) && pair.has(entry.to)))
        }
        case 'exchange-text': {
          await rt.load()
          const entry = state.exchanges.find(item => item.id === body.id)
          if (entry === undefined) return fail('This message is no longer kept', 'bot/stale')
          return ok(await rt.exchangeText(entry))
        }
        // A long Bot post's file (attachLong), for the group chat's "Show all".
        case 'file-text': {
          if (typeof body.file?.attachmentId !== 'string') return fail('No file named', 'bot/invalid')
          const read = await rt.fileText(body.file)
          return read === undefined ? fail('This file cannot be read here', 'bot/unavailable') : ok(read)
        }
        case 'earlier':
          await rt.load()
          return ok(await rt.earlierPage(String(body.sessionId ?? ''), body.cursor ?? undefined))
        case 'chat':
          await rt.load()
          return ok(await rt.chatPage(String(body.botId ?? ''), body.cursor ?? undefined))
        // Advanced queries never activate a Session or run a model. The usage query
        // may refresh its own derived ledger; checkpoint is deliberately NOT a read.
        case 'context-status':
          await rt.load()
          return ok(await rt.contextStatus(body.botId))
        case 'usage-stats':
          await rt.load()
          return ok(await rt.usageStats(body.botId, { sessionId: body.sessionId }))
        case 'memory-review-status':
          await rt.load()
          if (typeof body.botId !== 'string' || body.botId === '') return fail('A Bot id is required', 'bot/invalid')
          if (rt.botOf(body.botId) === undefined) return fail('Unknown Bot', 'bot/not-found')
          return ok(rt.memoryReviewStatus(body.botId))
        case 'checkpoint-bot':
          await rt.load()
          return ok(await rt.checkpointBot(body.botId, { sessionId: body.sessionId }))
        // DSH's own whole-log figures for the current part of a Bot's chat, the ones its
        // status bar shows; a window without that bar shows them in the Bot's details.
        case 'run-stats': {
          await rt.load()
          const bot = rt.botOf(String(body.botId ?? ''))
          if (bot === undefined) return fail('Unknown Bot', 'bot/not-found')
          const projections = ctx.get?.('sessionProjections')
          if (projections === undefined) return ok(null)
          const agent = await rt.resolveAgent(rt.chatOf(bot.id))
          return ok(projections.snapshot(agent.session, RUN_STATS).values)
        }
        case 'usage':
          await rt.load()
          return ok(await rt.usageView({ timeZone: typeof body.timeZone === 'string' ? body.timeZone.slice(0, 64) : undefined }))
        case 'room-progress':
          return ok([...rt.roomProgress.entries()].filter(([, entry]) => entry.roomId === body.roomId).map(([callId, entry]) => ({ callId, replies: entry.replies, speaking: entry.speaking ?? null })))
        case 'create-bot': {
          await rt.bootstrap()
          const bot = await rt.createBot({ name: body.name, role: body.role, color: body.color, instructions: body.instructions, brief: body.brief, avatar: body.avatar, model: body.model, effort: body.effort, workDir: body.workDir })
          return ok(bot)
        }
        case 'set-bot-auto':
          await rt.load()
          return ok(await rt.setBotAuto(String(body.id ?? ''), body.rev))
        case 'update-bot':
          await rt.load()
          return ok(await rt.updateBot(body.id, body))
        // A model on another route (parts.js): a new conversation with a handoff note.
        case 'switch-route':
          await rt.load()
          return ok(await rt.switchRoute(String(body?.id ?? ''), String(body?.model ?? ''), body?.effort))
        // The avatar library: photos the user imported once, kept beside the team.
        case 'avatar-library':
          await rt.load()
          return ok(await rt.avatarLibraryView({ offset: body.offset, limit: body.limit }))
        case 'avatar-import':
          await rt.load()
          return ok(await rt.avatarLibraryImport(Array.isArray(body.items) ? body.items : []))
        case 'avatar-delete':
          await rt.load()
          return ok(await rt.avatarLibraryDelete(String(body.id ?? '')))
        case 'delete-bot':
          await rt.load()
          await rt.deleteBot(body.id)
          return ok(view())
        case 'set-main':
          await rt.load()
          await rt.setMain(body.id, body.main !== false, {
            primary: body.primary === true,
            replace: typeof body.replace === 'string' ? body.replace : undefined,
          })
          return ok(view())
        case 'create-room': {
          await rt.load()
          const room = await rt.createRoom({ members: Array.isArray(body.members) ? body.members : [], name: body.name, ...(typeof body.admin === 'string' ? { admin: body.admin } : {}) })
          if (body.greet === true) await rt.greetRoom(room.id).catch(error => rt.warn('ds-bot: greeting in %s failed: %s', room.name, error))
          return ok(room)
        }
        case 'update-room': {
          await rt.load()
          const { room, changes } = await rt.updateRoom(body.id, {
            name: body.name,
            notice: body.notice,
            mode: body.mode,
            admin: body.admin,
            members: Array.isArray(body.members) ? body.members : undefined,
            add: Array.isArray(body.add) ? body.add : undefined,
            remove: Array.isArray(body.remove) ? body.remove : undefined,
            workDir: body.workDir,
            permission: body.permission,
            relayLimit: body.relayLimit,
          })
          return ok({ room: view().rooms.find(entry => entry.id === room.id), changes })
        }
        case 'room-continue': {
          await rt.load()
          await rt.continueRoom(body.roomId)
          return ok(view())
        }
        case 'folders':
        case 'folder-pick':
        case 'folder-list':
          await rt.load()
          return ok(await rt.folderEndpoint(endpoint, body, signal))
        case 'team-workspace':
          await rt.load()
          return ok({ team: await rt.setTeamWorkspace(String(body.path ?? '')) })
        case 'add-agent':
          await rt.load()
          return ok(await rt.addAgent(body))
        case 'update-agent':
          await rt.load()
          return ok(await rt.updateAgent(body.agentId, body))
        case 'agent-presets':
          return ok(await rt.presets())
        case 'agent-session':
          await rt.load()
          return ok({ sessionId: await rt.createAgentSession(body.agentId, body.workspaceId) })
        case 'agent-adopt':
          await rt.load()
          return ok({ sessionId: await rt.adoptAgentSession(body.agentId, body.sessionId) })
        case 'bot-session-adopt':
          await rt.load()
          return ok({ sessionId: await rt.adoptBotSession(body.botId, body.sessionId, body.sourceSessionId) })
        // A DSH bot becomes a Bot of the team, keeping its Session, folder and name.
        case 'agent-bot-adopt':
          await rt.load()
          return ok(await rt.adoptAsBot(body.agentId))
        case 'agent-bot-rollback':
          await rt.load()
          return ok(await rt.rollbackAdoption(body.agentId))
        case 'agent-archive':
          await rt.load()
          await rt.archiveAgentSession(body.agentId, body.sessionId)
          return ok(true)
        case 'agent-rename':
          await rt.load()
          await rt.renameAgentSession(body.agentId, body.sessionId, body.title)
          return ok(true)
        case 'remove-agent':
          await rt.load()
          await rt.removeAgent(body.agentId)
          return ok(view())
        case 'set-flags':
          await rt.load()
          return ok(await rt.setFlags(body.id, body))
        case 'delete-room':
          await rt.load()
          await rt.deleteRoom(body.id)
          return ok(view())
        case 'approval-answer':
          rt.answerApproval(body.id, body.choice)
          return ok(true)
        case 'stop-member-work':
          return ok(await rt.stopMemberWork(String(body.roomId ?? ''), String(body.botId ?? '')))
        case 'dismiss-question':
          await rt.load()
          if (rt.own(state.questions, body.sessionId) !== undefined) {
            delete state.questions[body.sessionId]
            await rt.save()
          }
          return ok(true)
        case 'dismiss-view':
          await rt.load()
          if (rt.own(state.views, body.sessionId) !== undefined) {
            delete state.views[body.sessionId]
            await rt.save()
          }
          return ok(true)
        case 'secret-set':
        case 'secret-allow':
        case 'secret-cancel':
        case 'secret-update':
        case 'secret-delete':
          await rt.load()
          return ok(await rt.secretEndpoint(endpoint, body))
        case 'connector-connect':
        case 'connector-disconnect':
        case 'connector-retry':
          await rt.load()
          return ok(await rt.connectorEndpoint(endpoint, body))
        case 'bot-fresh':
          await rt.load()
          return ok(await rt.startFresh(String(body?.id ?? '')))
        case 'capability-save':
        case 'capability-delete':
        case 'capability-approve':
        case 'bot-capability':
          await rt.load()
          return ok(await rt.capabilityEndpoint(endpoint, body))
        case 'schedules':
        case 'schedule-create':
        case 'schedule-delete':
          await rt.load()
          return ok(await rt.scheduleEndpoint(endpoint, body))
        case 'memory-view':
        case 'memory-ask':
        case 'memory-forget':
          await rt.load()
          return ok(await rt.memoryEndpoint(endpoint, body))
        case 'answer-question': {
          if (typeof body.sessionId !== 'string') return fail('Nothing to send', 'bot/invalid')
          await rt.load()
          const past = rt.pastOwners.get(body.sessionId)
          const sessionId = rt.botOf(body.sessionId) ? rt.chatOf(body.sessionId) : past && past.roomId === undefined ? rt.chatOf(past.botId) : body.sessionId
          const question = rt.own(state.questions, sessionId)
          if (question === undefined || question.id !== body.questionId) return fail('This question is no longer open', 'bot/stale')
          const reply = questionReply(question, body.answer)
          if (reply === undefined) return fail('Nothing to send', 'bot/invalid')
          // Claim the question before queueing so a second answer is refused.
          delete state.questions[sessionId]
          try {
            await rt.ensureCapabilities(sessionId)
            const agent = await rt.resolveAgent(sessionId)
            agent.followup(createUserMessage({ content: [{ type: 'text', text: reply.text }], source: reply.source }))
            await ctx.sessions.flush(agent.session)
          } catch (error) {
            state.questions[sessionId] ??= question
            throw error
          }
          await rt.save()
          return ok(true)
        }
        case 'view-reply': {
          if (typeof body.sessionId !== 'string') return fail('Nothing to send', 'bot/invalid')
          await rt.load()
          const past = rt.pastOwners.get(body.sessionId)
          const sessionId = rt.botOf(body.sessionId) ? rt.chatOf(body.sessionId) : past && past.roomId === undefined ? rt.chatOf(past.botId) : body.sessionId
          const pending = rt.own(state.views, sessionId)
          if (pending === undefined || pending.id !== body.viewId) return fail('This view is no longer open', 'bot/stale')
          const checked = validateViewAnswer(pending.view, body.action, body.values)
          if (checked.error !== undefined) return fail(checked.error, 'bot/invalid')
          const reply = viewReply(pending, body.action, body.values)
          if (reply === undefined) return fail('Nothing to send', 'bot/invalid')
          // Claim the view before queueing so a second answer is refused.
          delete state.views[sessionId]
          try {
            await rt.ensureCapabilities(sessionId)
            const agent = await rt.resolveAgent(sessionId)
            agent.followup(createUserMessage({ content: [{ type: 'text', text: reply.text }], source: reply.source }))
            await ctx.sessions.flush(agent.session)
          } catch (error) {
            state.views[sessionId] ??= pending
            throw error
          }
          await rt.save()
          return ok(true)
        }
        case 'send': {
          const text = String(body.text ?? '').trim()
          if (text === '' || typeof body.sessionId !== 'string') return fail('Nothing to send', 'bot/invalid')
          await rt.load()
          // A Bot id or an earlier part of its own chat means the current part.
          const past = rt.pastOwners.get(body.sessionId)
          const sessionId = rt.botOf(body.sessionId) ? rt.chatOf(body.sessionId) : past && past.roomId === undefined ? rt.chatOf(past.botId) : body.sessionId
          await rt.ensureCapabilities(sessionId)
          await ctx.sessionController.prompt({
            requestId: randomUUID(),
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text }],
          }, AbortSignal.timeout(30_000))
          return ok(true)
        }
        case 'btw-delete': {
          if (typeof body.sessionId !== 'string' || body.sessionId === '' || typeof body.cardId !== 'string' || body.cardId === '') return fail('Nothing to delete', 'bot/invalid')
          await rt.load()
          return ok(await rt.btwDelete({ sessionId: body.sessionId, cardId: body.cardId }))
        }
        // Side chats in the Bot's panel: each question is an aside on a fresh
        // snapshot of this Bot's private chat; the earlier finished pairs of
        // that chat ride along. Nothing is written into the Session.
        case 'side-new': {
          if (typeof body.sessionId !== 'string' || body.sessionId === '') return fail('Nothing to open', 'bot/invalid')
          await rt.load()
          return ok(await rt.sideNew({ sessionId: body.sessionId }))
        }
        case 'side-ask': {
          if (typeof body.sessionId !== 'string' || body.sessionId === '') return fail('Nothing to ask', 'bot/invalid')
          if (body.chatId !== undefined && typeof body.chatId !== 'string') return fail('Nothing to ask', 'bot/invalid')
          if (String(body.text ?? '').trim() === '') return fail('Write a question.', 'bot/invalid')
          await rt.load()
          return ok(await rt.sideAsk({ sessionId: body.sessionId, chatId: body.chatId, recent: body.recent === true, text: String(body.text) }))
        }
        case 'side-cancel': {
          if (typeof body.chatId !== 'string' || body.chatId === '' || typeof body.entryId !== 'string' || body.entryId === '') return fail('Nothing to cancel', 'bot/invalid')
          await rt.load()
          return ok(await rt.sideCancel({ chatId: body.chatId, entryId: body.entryId }))
        }
        case 'side-close': {
          if (typeof body.chatId !== 'string' || body.chatId === '') return fail('Nothing to close', 'bot/invalid')
          await rt.load()
          return ok(await rt.sideClose({ chatId: body.chatId }))
        }
        case 'update-check': {
          const fresh = body.fresh === true
          return ok({ ...(await rt.updateCheck({ fresh })), dsh: (await rt.dshUpdateCheck?.({ fresh })) ?? null })
        }
        case 'update-install':
          return ok(rt.updateStart())
        case 'dsh-update-install':
          return ok(rt.dshUpdateStart?.())
        case 'repo-stars':
          return ok(await rt.repoStars())
        // The Desktop window's long poll for read_browser, and its answers.
        // The panel's long poll: only where a window has the panel (browser.js).
        case 'browser-wait': {
          if (!rt.browserEnabled) return fail('Bot browsers are off on this host', 'bot/browser-off')
          const clientId = typeof body.clientId === 'string' ? body.clientId.slice(0, 100) : ''
          if (clientId === '') return fail('A browser poll needs a clientId', 'bot/invalid')
          await rt.load()
          const requests = await rt.browserChannel.wait(clientId, rt.browserOpen(body.open))
          return ok({ requests, holds: rt.browserChannel.holdSnapshot() })
        }
        case 'browser-result':
          if (!rt.browserEnabled) return fail('Bot browsers are off on this host', 'bot/browser-off')
          return ok(rt.browserChannel.result(body))
        // The Privacy page (privacy.js): what the desktop app may share, all off until switched on.
        // Images (imagegen.js): how they are made here, and a generation's progress for its card.
        case 'image-access':
          return ok(await rt.images.access())
        case 'image-progress':
          return ok(rt.images.progress(String(body.callId ?? ''), body.seen))
        // Pets (pets.js): the Codex-format avatars on this computer, and codex-pets.net's.
        case 'pets':
          return ok(await pets.list())
        case 'pets-browse':
          return ok(await pets.browse({ query: body.query, page: body.page, sort: body.sort }))
        case 'pet-use': {
          await rt.load()
          const pet = await pets.adopt(String(body.source ?? ''), String(body.id ?? ''))
          const bot = rt.botOf(body.botId)
          if (!bot) return fail('Unknown Bot', 'bot/not-found')
          return ok(await rt.updateBot(bot.id, { avatar: { ...(bot.avatar ?? {}), image: undefined, pet: { source: pet.source, id: pet.id, version: pet.version, ...(pet.sleep ? { sleep: true } : {}) } } }))
        }
        case 'privacy':
          return ok(privacy.view())
        case 'privacy-set':
          return ok(privacy.set(String(body.share ?? ''), body.on === true))
        case 'browser-takeover': {
          if (rt.browserChannel === undefined) return fail('Bot browsers are off on this host', 'bot/browser-off')
          await rt.load()
          const botId = String(body.botId ?? '')
          if (!rt.botOf(botId)) return fail('Unknown Bot', 'bot/not-found')
          // Taking over a handoff keeps its reason, note, and call, so its card stays up.
          const asked = rt.browserChannel.holdOf(botId)
          rt.browserChannel.setHold(botId, asked?.callId !== undefined
            ? { by: 'user', reason: asked.reason, note: asked.note, callId: asked.callId }
            : { by: 'user', reason: 'takeover', note: 'The user is controlling this browser.' })
          return ok(true)
        }
        // A card's 'done' or 'skip' says how the handoff went. The panel's Give back
        // sends no outcome, so its reply only says that control returned to the Bot.
        case 'browser-give-back': {
          if (rt.browserChannel === undefined) return fail('Bot browsers are off on this host', 'bot/browser-off')
          await rt.load()
          const botId = String(body.botId ?? '')
          if (!rt.botOf(botId)) return fail('Unknown Bot', 'bot/not-found')
          if (body.outcome !== undefined && !['done', 'skip', 'returned'].includes(body.outcome)) return fail('Nothing to send', 'bot/invalid')
          const hold = rt.browserChannel.holdOf(botId)
          if (hold === null) return fail('This browser is not held', 'bot/forbidden')
          if (body.callId !== undefined && body.callId !== hold.callId) return fail('This handoff is no longer open', 'bot/stale')
          // Claim the hold before queueing so a second answer is refused.
          rt.browserChannel.setHold(botId, null)
          if (hold.callId === undefined) return ok(true)
          try {
            const sessionId = rt.chatOf(botId)
            const reply = handoffReply(hold, body.outcome)
            await rt.ensureCapabilities(sessionId)
            const agent = await rt.resolveAgent(sessionId)
            agent.followup(createUserMessage({ content: [{ type: 'text', text: reply.text }], source: reply.source }))
            await ctx.sessions.flush(agent.session)
          } catch (error) {
            if (rt.browserChannel.holdOf(botId) === null) rt.browserChannel.setHold(botId, hold)
            throw error
          }
          return ok(true)
        }
        case 'browser-stop': {
          await rt.load()
          const botId = String(body.botId ?? '')
          if (!rt.botOf(botId)) return fail('Unknown Bot', 'bot/not-found')
          const sessionId = rt.chatOf(botId)
          if (sessionId && rt.live.get(sessionId)?.turn !== undefined) {
            const agent = await rt.resolveAgent(sessionId)
            agent.cancel({ kind: 'user' })
          }
          for (const room of Object.values(rt.state.rooms ?? {})) {
            if (room.members?.includes(botId)) await rt.stopMemberWork?.(room.id, botId)
          }
          rt.browserChannel?.setHold(botId, { by: 'user', reason: 'stopped', note: 'The user is controlling this browser.' })
          return ok(true)
        }
        case 'diagnostics':
          await rt.load()
          return ok(await rt.diagnostics.report(body))
        case 'diagnostics-log':
          return ok(await rt.diagnostics.logText())
        case 'diagnostics-clear':
          await rt.diagnostics.clear()
          return ok(true)
        default:
          if (added !== undefined) return ok(await added.fn(body, signal))
          return fail(`Unknown endpoint ${endpoint}`, 'bot/not-found')
      }
    } catch (error) {
      const code = errorCode(error)
      // A message meant for the user is opt-in: this code names it with its own `bot/`
      // or `memory/` code (memory writes `memory/*`). Any other error may be a
      // provider's, carrying its request or endpoint text, or a file system's, carrying
      // a path: neither the log nor the reply says its message, only its kind.
      if (code !== 'bot/internal' && exposition(error) !== undefined) return fail(error.message, code)
      const kind = errorKind(error)
      rt.noteFailure({ source: 'api', text: `${endpoint}: ${kind}`, code: kind, stack: error?.stack })
      return fail(`Something went wrong (${kind}).`, code)
    }
  }

  const agentAccess = createAgentAccess(rt, handle, { transaction: adminTransaction })
  rt.agentAccess = agentAccess
  ctx.effect(() => {
    void agentAccess.resume().catch(() => rt.warn('Agent access could not start'))
    return () => agentAccess.close()
  }, 'ds-bot: agent access')

  // A pet's sheet for the marks that wear it, and a character's baked sheet written into
  // Codex's own pets folder, as bytes rather than JSON. The write streams its body, which a
  // GET cannot have, so it has a route of its own. A failure says its kind only: the raw
  // message names the absolute path of the sheet or of Codex's folder, and the log gets
  // the kind and the stack's frames, never that message.
  const petFailure = (where, error) => {
    const kind = errorKind(error)
    rt.noteFailure({ source: 'api', text: `${where}: ${kind}`, code: kind, stack: error?.stack })
    return Response.json({ error: `Something went wrong (${kind}).` }, { status: error?.code === 'bot/invalid' ? 400 : 500 })
  }
  ctx.effect(() => ctx.connection.fetch.register({
    path: PET_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url)
      try {
        const bytes = await pets.file(url.searchParams.get('source') ?? '', url.searchParams.get('id') ?? '', url.searchParams.get('part') === 'sleep' ? 'sleep' : 'sheet')
        if (!bytes) return new Response('Not found', { status: 404 })
        return new Response(bytes, { status: 200, headers: { 'content-type': 'image/webp', 'cache-control': 'private, max-age=3600' } })
      } catch (error) {
        return petFailure('pet route', error)
      }
    },
  }), 'ds-bot: pet route')
  // A generated image (imagegen.js) for its card, by its id.
  ctx.effect(() => ctx.connection.fetch.register({
    path: IMAGE_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const bytes = await rt.images.imageFile(new URL(request.url).searchParams.get('id') ?? '').catch(() => undefined)
      if (!bytes) return new Response('Not found', { status: 404 })
      return new Response(bytes, { status: 200, headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=86400' } })
    },
  }), 'ds-bot: image route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: PET_CODEX_ROUTE,
    methods: ['PUT'],
    requestBody: 'streaming',
    fetch: async (request) => {
      const url = new URL(request.url)
      const id = url.searchParams.get('id') ?? ''
      try {
        const bytes = Buffer.from(await request.arrayBuffer())
        return Response.json(await pets.toCodex(id, { name: url.searchParams.get('name') ?? id, description: url.searchParams.get('description') ?? '', bytes, part: url.searchParams.get('part') === 'sleep' ? 'sleep' : 'sheet' }))
      } catch (error) {
        return petFailure('pet to Codex route', error)
      }
    },
  }), 'ds-bot: pet to Codex route')

  ctx.effect(() => ctx.connection.fetch.register({
    path: MCP_PATH,
    methods: ['POST', 'GET', 'DELETE', 'OPTIONS'],
    requestBody: 'streaming',
    fetch: request => agentAccess.fetch(request),
  }), 'ds-bot: MCP route')

  // An exact Fetch route on the shared /api channel; the browser authenticates with its session cookie.
  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body
      try { body = await request.json() } catch { body = {} }
      const endpoint = String(body?.endpoint ?? '')
      const dispatch = () => handle(endpoint, body?.payload, request.signal)
      const result = await (adminActions.has(endpoint) ? ownerTransaction(dispatch) : dispatch())
      const noStore = CLI_LOGIN.has(body?.endpoint)
        || ['agent-access', 'agent-token-create', 'agent-token-revoke'].includes(body?.endpoint)
      return new Response(JSON.stringify(result), { status: 200, headers: {
        'content-type': 'application/json', ...(noStore ? { 'cache-control': 'no-store' } : {}),
      } })
    },
  }), 'ds-bot: api route')

  ctx.effect(() => {
    void rt.load()
    // Registered last, so this disposer runs before the state lock is released.
    // In-flight side questions abort here; their entries stay answering for the
    // next owner.
    return () => Promise.all([rt.btwDispose?.(), rt.sideDispose?.()])
  }, 'ds-bot: load state')
}
