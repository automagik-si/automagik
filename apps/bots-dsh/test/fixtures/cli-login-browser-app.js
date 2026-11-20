// Browser fixture for the sign-in row: the pinned DSH conversation, composer, Lexical editor,
// draft persistence and transcript are real; the host's cli-login-* endpoints are a fake in this
// page. No CLI, network or model is involved.
import { createElement as h, useSyncExternalStore } from 'react'
import { CLI_LOGIN_CSS, CliLoginConversation, installKnownStateGuard } from '../../src/client/cli-login.js'
import { createCliLogin } from '../../src/client/cli-login-state.js'
import { CliAccounts } from '../../src/client/cli-accounts.js'
import { install as installAccountActions } from '../../src/host/cli-login.js'
import { createSource, indexRoster } from '../../src/client/sources.js'
import { teamActions } from '../../src/client/team-actions.js'
import { SHELL_CSS, CONVERSATION_CSS } from '../../src/client/styles.js'
import { CONVERSATION_MARK } from '../../src/client/stage.js'
import { allThemes, themeCss } from '../../src/client/themes.js'

const { createRoot } = window.nativeSeeds['react-dom/client']
const { createSnapshotStore } = window.nativeSeeds['@deepseek-ai/dsh-client-store']
const native = window.modules['@deepseek-ai/dsh-client-ui-conversation'].fixture
const registerFileIntake = native.createComposerFileIntake()
const { ChatView, TurnErrorNodeView } = window.modules['@deepseek-ai/dsh-client-ui-chat'].fixture
const renderer = window.modules['@deepseek-ai/dsh-client-ui-renderer']
const source = value => createSnapshotStore(value)
const hook = value => select => useSyncExternalStore(value.subscribe, () => select(value.getSnapshot()))
const constant = value => select => select(value)
const t = key => key
const NO_TURNS = []
const roster = createSource(indexRoster({ bots: [], rooms: [], agents: [], models: [], prefs: {} }))
const ui = createSource({ toast: null })
const selected = source([])
const runtimes = new Map()
const ctx = { emit() {}, effect(fn) { return fn() ?? (() => {}) }, fiber: { name: 'cli-login-fixture' } }
const slots = new renderer.SlotRegistry(ctx)
slots.install(renderer.fixtureCreateRenderer())
const current = source(undefined)
slots.installScope('session', { current, bindingSource: () => current, renderArea: (_binding, props) => props.children })
slots.provideRoot({ hooks: { selected } })

// What the page did, for the test to read. None of it is ever sent anywhere.
window.calls = []; window.sends = []; window.storageWrites = []; window.selectorClicks = 0; window.documentEvents = []
const setStored = Storage.prototype.setItem
Storage.prototype.setItem = function (key, value) {
  window.storageWrites.push({ key: String(key), value: String(value) })
  return setStored.call(this, key, value)
}
for (const type of ['keydown', 'keyup', 'input', 'beforeinput', 'paste', 'copy', 'cut', 'drop', 'compositionstart', 'focusin']) {
  document.addEventListener(type, event => {
    if (event.target instanceof Element && event.target.closest('[data-cli-login-field]')) window.documentEvents.push(type)
  })
}

// The host, faked: one attempt per agent, any view of the owner reads it.
export const STATE = 'Sentinel_State_ABCdef0123456789'
window.STATE = STATE
window.host = { attempts: {}, signedIn: { 'acp-codex': false, 'acp-claude': false }, choices: {}, restarted: false, hold: {}, release: {}, sequence: 0 }
const refused = (message, code = 'bot/refused') => Object.assign(new Error(message), { code })
const linkOf = provider => (provider === 'acp-codex' ? 'https://auth.openai.com/codex/device'
  : `https://claude.ai/oauth/authorize?code=true&client_id=${'c'.repeat(240)}&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&state=${STATE}`)
const view = provider => {
  const attempt = window.host.attempts[provider]
  if (!attempt) return undefined
  const choice = window.host.choices[`${attempt.openedBy}:${provider}`]
  return structuredClone({ ...attempt, ...(choice ? { choice } : {}) })
}
const live = provider => ['starting', 'waiting'].includes(window.host.attempts[provider]?.status)
const pause = async (endpoint) => { if (window.host.hold[endpoint]) await new Promise(resolve => { window.host.release[endpoint] = resolve }) }
window.finishSignIn = (provider) => {
  window.host.signedIn[provider] = true
  const attempt = window.host.attempts[provider]
  if (attempt) Object.assign(attempt, { status: 'ready', url: undefined, userCode: undefined, prompt: undefined })
  for (const [key, choice] of Object.entries(window.host.choices)) {
    if (!key.endsWith(`:${provider}`) || choice.state !== 'pending') continue
    if (window.host.applyFails) window.host.choices[key] = { ref: choice.ref, state: 'failed', message: 'Sign in to Claude Code CLI (acp-claude) before using this model.', kept: choice.kept }
    else {
      window.host.choices[key] = { ref: choice.ref, state: 'applied' }
      const snapshot = roster.getSnapshot()
      roster.set(indexRoster({ ...snapshot, bots: snapshot.bots.map(bot => (`${bot.id}:${provider}` === key ? { ...bot, model: choice.ref } : bot)) }))
    }
  }
}
const call = async (endpoint, payload) => {
  window.calls.push({ endpoint, payload: structuredClone(payload) })
  await pause(endpoint)
  if (window.reservationActions?.[endpoint]) return window.reservationActions[endpoint](payload)
  const { provider, botId } = payload ?? {}
  switch (endpoint) {
    case 'cli-login-connections': return { available: true, connections: Object.fromEntries(Object.entries(window.host.signedIn).map(([id, signedIn]) => [id, { id, signedIn }])) }
    case 'cli-login-start': {
      if (payload.model) window.host.choices[`${botId}:${provider}`] = { ref: payload.model, state: 'pending', kept: roster.getSnapshot().byId[botId]?.model }
      if (window.host.signedIn[provider]) { window.finishSignIn(provider); return { id: provider, attemptId: `a${'0'.repeat(30)}`, status: 'ready', ...view(provider) } }
      if (!live(provider)) {
        window.host.attempts[provider] = { id: provider, attemptId: `attempt_${provider.replace('-', '_')}_${String(++window.host.sequence).padStart(20, '0')}`, status: 'waiting',
          expiresAt: Date.now() + 600_000, expiresBy: 'app', openedBy: botId, url: linkOf(provider),
          ...(provider === 'acp-codex' ? { userCode: 'ABCD-1234' } : { prompt: { id: 'claude-code', label: 'Authorization code', secret: true } }) }
      }
      return view(provider)
    }
    case 'cli-login-current': {
      const choice = window.host.choices[`${botId}:${provider}`]
      return live(provider) ? { id: provider, attempt: view(provider) } : { id: provider, attempt: null, ...(choice ? { choice } : {}) }
    }
    case 'cli-login-status':
      if (window.host.restarted || window.host.attempts[provider]?.attemptId !== payload.attemptId) throw refused('This sign-in has ended. Start again.', 'bot/login-ended')
      return view(provider)
    case 'cli-login-answer':
      if (payload.value !== `authcode-XYZ#${STATE}`) throw refused('Paste the complete code shown by Claude, including the part after #.', 'bot/invalid')
      window.finishSignIn(provider)
      return view(provider)
    case 'cli-login-cancel':
      window.host.attempts[provider].status = 'cancelled'
      return view(provider)
    case 'update-bot': {
      if (payload.model?.startsWith('acp-') && !window.host.signedIn[payload.model.split('/')[0]]) throw refused('Sign in to Claude Code CLI (acp-claude) before using this model.', 'bot/sign-in-required')
      const snapshot = roster.getSnapshot()
      roster.set(indexRoster({ ...snapshot, bots: snapshot.bots.map(bot => (bot.id === payload.id ? { ...bot, model: payload.model } : bot)) }))
      return undefined
    }
    case 'models': return undefined
    default: throw new Error(`Unexpected fixture endpoint: ${endpoint}`)
  }
}

const selectSession = (id) => {
  const ids = selected.getSnapshot()
  if (!runtimes.has(id)) return
  current.set(runtimes.get(id).binding)
  selected.set([id, ...ids.filter(other => other !== id)])
}
let manager
const actions = teamActions({ call, after: value => Promise.resolve(value), partFor: id => id, roster, ui, openSession: selectSession, loginState: () => manager })
const newPage = () => {
  manager?.dispose()
  manager = createCliLogin({ actions, pollMs: 40 })
  actions.cliLogin = manager
  window.manager = manager
}
newPage()
installKnownStateGuard({ onRefused: () => { window.refusedNotices = (window.refusedNotices ?? 0) + 1 } })
const face = () => ({ hooks: { roster }, actions })

function makeSession(id, blank) {
  const session = source({ sessionId: id, blank, running: false, removed: false, subagent: null, promptError: null, pendingSubmissions: [], openState: 'open', hasMore: false, loadingOlder: false })
  const conversation = source({ views: { grouped: () => undefined }, activeTargets: new Set() })
  const view = native.createConversationStore().create(id)
  const lexicon = source(new Map())
  const triggers = { track: () => {}, lexicon, onSpace: () => false, arbitrate: () => 'pass', adjudicate: async () => ({ kind: 'pass' }) }
  const shell = new native.SessionInputShell({ actx: {},
    submissionState: () => ({ sessionId: id, running: false, newSession: blank, runMode: 'default' }),
    messageSubmitted: () => {},
    inputTriggers: () => triggers,
    defaultSink: async (text) => { window.sends.push({ id, text }); return { kind: 'success' } },
    commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: () => '' },
  })
  const useSession = hook(session), useConversation = hook(conversation)
  const useSessions = constant({ byId: { [id]: { cwd: '/isolated-fixture' } } })
  const shared = { sessionId: id, useSession, useInput: hook(shell.state), inputActions: shell.actions }
  // The composer's model cell, as a plain button: it must stay visible and usable.
  const inputSlot = name => (name === 'conversation.input.model'
    ? h('button', { type: 'button', 'data-fixture-selector': id, onClick: () => { window.selectorClicks++ } }, 'Model')
    : null)
  const inputProps = { ...shared, variant: 'composer', keyboard: shell, registerFileIntake, t,
    useNotices: hook(shell.notices), useBusyEnter: constant('queue'), useStopShortcut: constant([]), useAccess: () => true,
    useMenuLauncher: constant(null), useProjection: (_name, select) => select?.(undefined), useFileUploads: constant({}), useLexicon: hook(shell.lexicon),
    renderSlot: inputSlot, resolveDraftAttachments: () => [], addFiles: () => null, removeAttachment: () => {}, stop: () => {},
  }
  let position = null
  const chat = source({ order: [], nodes: new Map(), navigation: { items: () => NO_TURNS } })
  const flow = source({ running: false, rows: 3, error: false })
  const useFlow = hook(flow)
  function Flow() {
    const state = useFlow(value => value)
    return h('div', { 'data-slot': 'conversation.chat.flow' },
      Array.from({ length: state.rows }, (_, index) => h('div', { key: index, 'data-native-message': id, style: { padding: '16px', minHeight: '80px' } }, `Existing message ${index} of ${id}`)),
      state.error ? h('div', { 'data-turn-error-host': '' }, h(TurnErrorNodeView, { node: { data: { kind: 'turn-error', seq: 9, time: 0, turn: 1, step: 0, message: 'Claude Code needs a sign-in before it can answer.', code: 'MODEL_ACCESS_REQUIRED' } }, t })) : null,
      state.running ? h('div', { 'data-chat-running': true }, 'Running…') : null)
  }
  const chatProps = { ...shared, useChat: hook(chat), useConversation, useSessions, t,
    useContextMenu: () => ({ getTriggerProps: () => ({}) }), usePresentation: constant({ collapseTiming: 'immediate', mode: 'full' }),
    useProjection: () => undefined, useInteractionIds: constant([]), dispatchInteraction: () => {}, resolveFilePath: value => value,
    chatScroll: { read: () => position, save: (value) => { position = value } }, loadOlder: () => {}, loadThrough: () => {},
    renderSlot: name => (name === 'conversation.chat.flow' ? h(Flow) : null),
  }
  const useViews = constant([{ id: 'chat' }, { id: 'files' }])
  function Views() {
    return h(native.DefaultConversationViews, { ...shared, useConversation, useConversationViews: useViews, useInspectCall: constant(undefined),
      useStore: hook(view), actions: view.actions, bindDraftPersistence: write => shell.bindDraftPersistence(write), openView: () => {},
      renderSlot: (_name, _props, options) => h('div', { 'data-slot': 'conversation.view', 'data-view-id': options.only },
        options.only === 'files' ? h('div', { 'data-native-files': '' }, 'Files view') : h(ChatView, chatProps)),
    })
  }
  const contentProps = { ...shared, variant: 'main', phase: blank ? 'hero' : 'active', hero: false, useSessions,
    useSessionStatus: constant(new Map()), useWorkspaces: constant({ items: [], phase: 'ready' }), useComposerBlock: constant(undefined), t,
    useFactorySlot: (name, fallback) => (name === 'views' ? Views : fallback),
  }
  const binding = { key: id, ctx, hooks: { input: shell.state, session }, keyedHooks: {}, props: { sessionId: id, inputActions: shell.actions } }
  return { id, session, view, shell, flow, binding, contentProps, inputProps }
}

slots.register({ name: 'root', children: {
  'conversation.composer': { kind: 'chain', scope: 'session' },
  'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' },
  'conversation.input.dock': { kind: 'list', scope: 'session' },
  'conversation.hero.frame': { kind: 'hoc', scope: 'root' },
  'conversation.hero.brand.mark': { kind: 'single', scope: 'root' },
  'conversation.hero.workspace': { kind: 'single', scope: 'root' },
  'conversation.hero.agentPreset': { kind: 'single', scope: 'session' },
  'conversation.hero.options': { kind: 'list', scope: 'session' },
} }, (props) => {
  // The shown conversation first; any other stays in the DOM, hidden, like a kept View.
  const ids = props.useSelected(value => value) ?? []
  return h('div', { style: { height: '100%' } }, ids.map((id, index) => h('div', { key: id, className: native.rootClass, 'data-phase': 'active', hidden: index > 0, style: { height: '100%' } },
    h(native.ConversationContent, { ...runtimes.get(id).contentProps, renderSlot: props.renderSlot, renderSlotChain: props.renderSlotChain }))))
})
slots.register({ name: 'conversation.composer.bar', inject: id => runtimes.get(id)?.inputProps ?? {} }, native.InputBar)
slots.register({ name: 'conversation.input.dock', id: 'bot-cli-login', inject: face }, CliLoginConversation)
const root = createRoot(document.getElementById('root'))
window.showAccounts = (failure, failureMessage = 'private-process-diagnostic') => {
  window.accountCalls = []
  const entry = { authScope: 'isolated', signedIn: true,
    account: { email: 'bot@example.test' }, terminal: { email: 'terminal@example.test' } }
  const actions = {
    cliLoginAccounts: async () => ({ accounts: { 'acp-codex': { ...entry } }, installation: 'desktop' }),
    cliLoginSignOut: async () => {
      if (failure) throw Object.assign(new Error(failureMessage), { code: failure })
      window.accountCalls.push('signout'); entry.signedIn = false
    },
    cliLoginSwitch: async () => { window.accountCalls.push('switch') },
    refreshModels: async () => {},
    openCliLogin: () => window.accountCalls.push('open'),
  }
  root.render(h(CliAccounts, { bot: { id: 'alpha' }, actions }))
}
window.showRecoveryAccounts = evidence => {
  window.accountCalls = []
  window.accountReads = 0
  let recovery = true
  const acp = {
    authScope: 'isolated', status: async () => ({ agents: [] }),
    accountRecovery: async id => ({
      required: id === 'acp-codex' && recovery && evidence === 'pending',
    }),
    account: async id => {
      if (id === 'acp-claude') return {
        signedIn: true, account: { email: 'healthy@example.test' },
      }
      if (recovery) throw Object.assign(new Error('private-damaged-proof'), {
        code: 'acp-account/unverified-login',
      })
      return { signedIn: false }
    },
    terminalAccount: async () => ({ account: { email: 'terminal@example.test' } }),
    accountReset: async id => {
      if (id !== 'acp-codex') throw new Error('Unexpected vendor')
      window.accountCalls.push('reset')
      recovery = false
    },
  }
  const bot = { id: 'alpha' }
  const rt = { ctx: { get: () => acp, on: () => {} }, botOf: id => id === bot.id ? bot : null }
  installAccountActions(rt)
  const actions = {
    cliLoginAccounts: () => {
      window.accountReads++
      return rt.cliLoginActions['cli-login-accounts']({})
    },
    cliLoginReset: (botId, provider) => rt.cliLoginActions['cli-login-reset']({
      botId, provider,
    }),
    refreshModels: async () => {},
    openCliLogin: () => window.accountCalls.push('open'),
  }
  root.render(h(CliAccounts, { bot, actions }))
}

// The card uses the real team actions and host handlers. The browser keeps the fixture's
// reservation file in memory and reads a fake account instead of running a CLI.
function reservationFs() {
  const files = new Map()
  const open = new Map()
  let sequence = 0
  const fileOf = path => {
    if (!files.has(path)) throw Object.assign(new Error('Missing fixture file'), { code: 'ENOENT' })
    return files.get(path)
  }
  const stat = file => ({ isFile: () => true, mode: file.mode, dev: 1, ino: file.ino })
  return {
    constants: { O_RDONLY: 0, O_NOFOLLOW: 1, O_NONBLOCK: 2 },
    lstatSync: path => stat(fileOf(path)),
    openSync: (path, flags, mode) => {
      if (flags === 'wx') {
        if (files.has(path)) throw Object.assign(new Error('Fixture file exists'), { code: 'EEXIST' })
        files.set(path, { mode, ino: ++sequence })
      }
      const fd = ++sequence
      open.set(fd, fileOf(path))
      return fd
    },
    fstatSync: fd => stat(open.get(fd)),
    fchmodSync: (fd, mode) => { open.get(fd).mode = mode },
    readFileSync: fd => open.get(fd).bytes,
    writeFileSync: (fd, value) => { open.get(fd).bytes = new TextEncoder().encode(value) },
    fsyncSync() {},
    closeSync: fd => open.delete(fd),
    unlinkSync: path => files.delete(path),
    renameSync: (from, to) => { files.set(to, fileOf(from)); files.delete(from) },
  }
}

window.showReservationAccounts = ({
  isolated = false, instance = 'test-instance', machine,
} = {}) => {
  const id = 'acp-codex'
  const seen = { id, signedIn: true, consent: 'given', ref: 'fixture-ref',
    account: { kind: 'account', email: 'owner@example.test', plan: 'team' } }
  const fixture = { instance, state: 'complete', exact: 'a'.repeat(43), machine }
  const acp = {
    authScope: isolated ? 'isolated' : 'consent',
    status: async () => ({ agents: [seen] }),
    account: async provider => provider === id && !fixture.machine?.signedOut
      ? seen : { id: provider, signedIn: false },
    accountEvidence: async provider => {
      if (provider !== id || fixture.state === 'signed-out') return { id: provider, signedIn: false }
      if (fixture.state === 'unknown') return { id }
      if (fixture.state === 'unsupported') return { id, supported: false }
      if (fixture.state === 'ambiguous') return { id, signedIn: true, outcome: 'ambiguous', why: 'unknown-plan' }
      if (fixture.state === 'recovery') return { id, recoveryRequired: true }
      return { id, signedIn: true, vendor: 'codex', ref: seen.ref, outcome: fixture.state,
        reservable: true, class: 'workspace', exact: fixture.exact, loose: 'b'.repeat(43) }
    },
  }
  const rt = { ctx: { get: () => acp, on: () => {} }, holdsLock: () => true, readOnly: () => undefined }
  installAccountActions(rt, {
    path: 'reservation.json', fs: reservationFs(), pid: 1, instanceId: () => fixture.instance,
    random: (size, encoding) => {
      const bytes = crypto.getRandomValues(new Uint8Array(size))
      if (encoding === 'hex') return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
      return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
    },
    decodeKey: key => Uint8Array.from(atob(key.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0)),
  })
  const host = rt.cliLoginActions
  window.reservationActions = machine ? {
    ...host,
    async 'cli-login-accounts'(payload) {
      const value = await host['cli-login-accounts'](payload)
      value.accounts[id].machine = fixture.machine
      return value
    },
    async 'cli-login-reserve'(payload) {
      if (!payload.machineId) return host['cli-login-reserve'](payload)
      fixture.machine.claims.find(claim => claim.machineId === payload.machineId).label =
        payload.label
      return { state: 'complete', claims: [] }
    },
    async 'cli-login-release'(payload) {
      if (!payload.machineId) return host['cli-login-release'](payload)
      fixture.machine = { state: 'shared', claims: [] }
      return { state: 'unknown', claims: [] }
    },
  } : host
  let refresh
  window.refreshReservations = change => {
    Object.assign(fixture, change)
    refresh()
  }
  root.render(h(CliAccounts, { bot: { id: 'alpha' }, actions: {
    ...actions,
    cliLogin: {
      subscribe: fn => { refresh = fn; return () => { refresh = undefined } },
      getSnapshot: () => ({ rows: { alpha: { stage: 'done' } } }),
    },
  } }))
}
root.render(slots.renderSlot('root', {}))

window.setBots = (bots, { blank = false, shown } = {}) => {
  for (const bot of bots) if (!runtimes.has(bot.id)) runtimes.set(bot.id, makeSession(bot.id, blank))
  roster.set(indexRoster({ bots, rooms: [], agents: [], models: [{ ref: 'deepseek-official/deepseek-flash', name: 'DeepSeek Flash' }, { ref: 'acp-claude/default', name: 'Claude Code' }, { ref: 'acp-codex/default', name: 'Codex' }], prefs: {} }))
  for (const bot of [...bots].reverse()) if (shown === undefined || bot.id !== shown) selectSession(bot.id)
  if (shown !== undefined) selectSession(shown)
  else selectSession(bots[0].id)
}
window.selectSession = selectSession
window.openLogin = (id, provider, ref) => actions.openCliLogin(id, provider, ref)
window.chooseInChat = (id, ref) => actions.chooseModelInChat(id, ref).then(() => 'ok', error => error.code)
window.newPage = newPage
window.updateBot = (id, ref) => actions.updateBot(id, { model: ref }).then(() => 'ok', error => error.code)
window.forceDraft = (id, text) => runtimes.get(id).shell.actions.setDraft(text)
window.rows = () => manager.getSnapshot().rows
window.setView = (id, value) => runtimes.get(id).view.actions.setView(value)
window.setBlank = (id, blank) => { const r = runtimes.get(id); r.session.set({ ...r.session.getSnapshot(), blank }) }
window.setFlow = (id, patch) => { const f = runtimes.get(id).flow; f.set({ ...f.getSnapshot(), ...patch }) }
window.setSecret = (id, pending) => {
  const snapshot = roster.getSnapshot()
  roster.set(indexRoster({ ...snapshot, secretRequests: pending ? { [id]: [{ id: 's1', status: 'pending', kind: 'secret' }] } : {} }))
}
window.botModel = id => roster.getSnapshot().byId[id]?.model
window.everything = () => JSON.stringify({ storage: { ...localStorage, ...sessionStorage }, writes: window.storageWrites, calls: window.calls.filter(c => c.endpoint !== 'cli-login-answer'), sends: window.sends,
  drafts: [...runtimes.values()].map(r => r.shell.snapshot.draft), views: [...runtimes.values()].map(r => r.view.getSnapshot()) })
const style = document.createElement('style')
document.head.appendChild(style)
window.setLook = ({ theme = 'deepseek', botMode = true } = {}) => {
  document.documentElement.toggleAttribute(CONVERSATION_MARK, botMode)
  style.textContent = SHELL_CSS + (botMode ? CONVERSATION_CSS : '') + themeCss(allThemes()[theme]) + CLI_LOGIN_CSS
}
window.setLook()
