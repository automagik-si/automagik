// Signing in to Claude Code or Codex from a Bot's chat (plan v3, 2.3). The attempt lives in
// acp-dsh (its login.js holds the CLI process); this module is the Bot team's route to it, the
// model the person chose waiting for the sign-in, and the guard that keeps a pasted code out of
// a conversation. Nothing here enters team state, a tool, a message or a model call.
//
// Access: these are endpoints of the team's /api/omni-ui route, a DSH exact Fetch route, which
// DSH answers 403 for any principal but the owner (client-connection's shared Fetch handler):
// a share viewer or a shared remote access never reaches them. Within the owner, every view is
// the same person: a second window, a reloaded page or another Bot gets the live attempt back
// (`cli-login-current`, and `cli-login-start` while one runs). The Bot that opened it is only
// a label (`openedBy`) for the cancel confirmation. Reading never cancels.
//
// The model chosen (rule 5): an explicit entry that names a model (`model` on start) keeps
// that choice here, in memory, per Bot and agent. When acp-dsh announces the sign-in ready, the
// choice is applied through updateBot, to that Bot only, and only while it is still the
// latest: the Bot's model has not changed since, no newer choice for that Bot was made, and no
// turn ran on another model. A view that only attaches registers nothing.
//
// A pasted code: acp-dsh keeps keyed hashes of the Claude states it showed (24 h) and answers
// only whether a text carries one (`loginTextMatches`). The team's send endpoints, its
// deliveries (rt.deliver), a group's running round (groups.js drainRoomInbox) and Pocket
// (pocket-chat.js send) refuse such a text before anything records it, and a Bot's or a group's
// step drops such a message before it reaches a model or a transcript row (`dropLoginCodes`, from
// parts.js's pre-step).
//
// The account (#869): Claude and Codex have an isolated Bot home per installation. Account
// controls show Bot and terminal identities separately; switch/sign-out stop work before
// changing only Bot credentials. The earlier confirm protocol remains compatible: an account
// already in the Bot home is used only after the person said so. An agent
// signed in to an account that waits for the person answers `{ status: 'confirm', account }`
// (who it is, read by acp-dsh from the CLI: an email, an organisation, a plan, or that it is an
// API key), and `cli-login-confirm` is their "Use this account". acp-dsh then announces the
// agent ready, so the model chosen with the entry is applied exactly as after a sign-in. The
// account is shown on these owner-only endpoints and nowhere else: not in team state, a
// message, a tool, a model call or a log. `cli-login-accounts` and `cli-login-noticed` serve
// the one-time notice for older ACP hosts. New isolated homes never carry terminal consent.
//
// Residual risk (RFC 0003's amendment, RFC 0023 section 3): a send from DSH's own composer is
// admitted by DSH's session controller, which records it (`agent/inbox/spliced`) before any
// plugin hook runs. The page refuses it only for a state that page showed; after a reload or in a
// window that never showed the link, the code reaches that Session record, and only the step's
// drop keeps it from a model and the transcript. DSH 0.2.2 offers no hook before admission.
import { ACCOUNT_RECOVERY_CODE, ACCOUNT_RECOVERY_HINT } from '../shared/cli-account.js'

const PROVIDERS = new Set(['acp-codex', 'acp-claude'])
const STATUS = new Set(['starting', 'waiting', 'ready', 'failed', 'cancelled', 'expired'])
const BOT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const ATTEMPT = /^[A-Za-z0-9_-]{24,128}$/
const PROMPT = /^[A-Za-z0-9_-]{1,128}$/
const MODEL_REF = /^[a-z][a-z0-9-]{0,63}\/[^\s/][^\s]{0,199}$/
// The account a confirm step showed, as acp-dsh named it (a digest, or `unknown`).
const ACCOUNT_REF = /^[A-Za-z0-9_-]{1,64}$/
// How long the result of applying a chosen model can still be read by the Bot's view.
export const OUTCOME_TTL_MS = 60_000
const METHODS = { start: 'loginStart', current: 'loginCurrent', status: 'loginStatus', answer: 'loginAnswer', cancel: 'loginCancel' }
export const CODE_HINT = 'Paste the complete code shown by Claude, including the part after #.'
export const CODE_REFUSED = 'This message contains a sign-in code, so it was not sent. Paste the code only in the sign-in step.'
const DEVICE_FAILURES = new Set([
  'Codex device sign-in is unavailable. Enable device-code login in ChatGPT security settings or workspace permissions, then try again.',
  'Codex could not start device sign-in. Check your connection and device-code login permissions in ChatGPT, then try again.',
])
const ERRORS = {
  'acp-account/unverified-login': ACCOUNT_RECOVERY_HINT,
  'acp-login/invalid': 'This sign-in request is no longer valid. Start again.',
  'acp-login/invalid-code': CODE_HINT,
  'acp-login/not-found': 'This sign-in has ended. Start again.',
  'acp-login/unavailable': 'This CLI cannot sign in yet. Check its installation and try again.',
  'acp-login/disposed': 'The connection restarted. Start sign-in again.',
}
// The page branches on these two, never on their (translated) wording: an ended attempt asks the
// agent's own sign-in first (rule 4), a restart interrupts the row.
const ERROR_CODES = {
  'acp-login/not-found': 'bot/login-ended',
  'acp-login/disposed': 'bot/login-restarted',
  'acp-account/unverified-login': ACCOUNT_RECOVERY_CODE,
}
// The confirm step's refusals: the page reads the account again on the first, and offers the
// sign-in on the second.
const ACCOUNT_ERRORS = {
  'acp-account/changed': ['The account changed. Check it and confirm again.', 'bot/account-changed'],
  'acp-account/signed-out': ['This coding agent is not signed in any more. Sign in to use it.', 'bot/account-signed-out'],
}
const failed = (message, code = 'bot/refused') => Object.assign(new Error(message), { code })
const invalid = () => failed('This sign-in request is not valid.', 'bot/invalid')

// Keep the browser link on a provider's official authorization page: Claude's must ask for
// the manual code (`code=true`); Codex uses one fixed device page, usable from any device.
export function cliLoginUrl(value, provider) {
  if (typeof value !== 'string' || value.length > 16384 || /\s/u.test(value)
    || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return undefined
  let url
  try { url = new URL(value) } catch { return undefined }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return undefined
  const allowed = provider === 'acp-codex'
    ? url.hostname === 'auth.openai.com' && url.pathname === '/codex/device' && !url.search
    : provider === 'acp-claude' && url.searchParams.get('code') === 'true' && (
      (url.hostname === 'claude.com' && url.pathname === '/cai/oauth/authorize')
      || (['claude.ai', 'console.anthropic.com', 'platform.claude.com'].includes(url.hostname) && url.pathname === '/oauth/authorize')
    )
  return allowed ? value : undefined
}

// Do not forward opaque service diagnostics: a native process failure can contain output, an
// authorization URL or a pasted code. The chat needs only these fields.
export function cliLoginView(value, provider, attemptId) {
  if (value?.id !== provider || typeof value.attemptId !== 'string' || !ATTEMPT.test(value.attemptId) || !STATUS.has(value?.status)
    || (attemptId !== undefined && value.attemptId !== attemptId)
    || (value.expiresAt !== undefined && (!Number.isFinite(value.expiresAt) || value.expiresAt <= 0))) {
    throw failed('The sign-in status could not be verified. Start again.')
  }
  const view = { id: provider, attemptId: value.attemptId, status: value.status }
  if (value.expiresAt !== undefined) {
    view.expiresAt = value.expiresAt
    view.expiresBy = value.expiresBy === 'provider' ? 'provider' : 'app'
  }
  if (typeof value.openedBy === 'string' && BOT_ID.test(value.openedBy)) view.openedBy = value.openedBy
  if (value.status === 'starting' || value.status === 'waiting') {
    if (value.url !== undefined) {
      const url = cliLoginUrl(value.url, provider)
      if (url === undefined) throw failed('The sign-in link could not be verified. Start again.')
      view.url = url
    }
    if (provider === 'acp-codex' && typeof value.userCode === 'string' && /^[A-Za-z0-9-]{4,64}$/.test(value.userCode)) view.userCode = value.userCode
    if (provider === 'acp-claude' && value.status === 'waiting' && value.prompt?.secret === true && typeof value.prompt.id === 'string' && PROMPT.test(value.prompt.id)) {
      view.prompt = { id: value.prompt.id, label: 'Authorization code', secret: true }
    }
    if (value.checking === true) view.checking = true
  }
  if (value.status === 'failed') view.message = value.message === 'Install the CLI before signing in.'
    ? 'The coding agent is not ready yet. Check its installation in Settings → Claude Code and Codex, then try again.'
    : provider === 'acp-codex' && DEVICE_FAILURES.has(value.message) ? value.message : 'Sign-in did not finish. Try again.'
  if (value.status === 'expired') view.message = 'This sign-in expired. Start again.'
  if (value.status === 'cancelled') view.message = 'Sign-in cancelled.'
  return view
}

// One shown value of an account: a single bounded line.
const shown = (value, max) => {
  if (typeof value !== 'string') return undefined
  const text = [...value].filter(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join('').trim().slice(0, max)
  return text === '' ? undefined : text
}

/** What a confirm step shows of acp-dsh's `account()` answer: only these fields. */
export function cliAccountView(value) {
  const account = value?.account
  const email = shown(account?.email, 254)
  const org = shown(account?.org, 120)
  const plan = shown(account?.plan, 40)
  return {
    ...(value?.authScope === 'isolated' ? { authScope: 'isolated' } : {}),
    ref: typeof value?.ref === 'string' && ACCOUNT_REF.test(value.ref) ? value.ref : 'unknown',
    ...(account !== null && typeof account === 'object' ? { kind: account.kind === 'key' ? 'key' : 'account' } : {}),
    ...(email ? { email } : {}),
    ...(org ? { org } : {}),
    ...(plan ? { plan } : {}),
  }
}

const ACTIONS = {
  reset: ['botId', 'provider'],
  switch: ['botId', 'provider'],
  signout: ['botId', 'provider'],
  confirm: ['botId', 'provider', 'ref', 'model'],
  start: ['botId', 'provider', 'model'],
  current: ['botId', 'provider'],
  status: ['botId', 'provider', 'attemptId'],
  answer: ['botId', 'provider', 'attemptId', 'value'],
  cancel: ['botId', 'provider', 'attemptId'],
}

function fields(payload, action) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw invalid()
  const allowed = new Set(ACTIONS[action])
  if (Object.keys(payload).some(key => !allowed.has(key)) || typeof payload.botId !== 'string' || !BOT_ID.test(payload.botId)
    || !PROVIDERS.has(payload.provider)
    || (allowed.has('attemptId') && (typeof payload.attemptId !== 'string' || !ATTEMPT.test(payload.attemptId)))) throw invalid()
  // The model the entry is for: one of this agent's, or none (a view that only attaches).
  if (payload.model !== undefined && (typeof payload.model !== 'string' || !MODEL_REF.test(payload.model) || payload.model.split('/')[0] !== payload.provider)) throw invalid()
  if (payload.ref !== undefined && (typeof payload.ref !== 'string' || !ACCOUNT_REF.test(payload.ref))) throw invalid()
  if (action === 'answer' && (typeof payload.value !== 'string' || payload.value.length > 8192 || !/^[\x21-\x7e]+$/.test(payload.value))) {
    throw payload.provider === 'acp-claude' ? failed(CODE_HINT, 'bot/invalid') : invalid()
  }
  return payload
}

const CONNECTOR_STATES = new Set(['off', 'no-cli', 'installing', 'failed', 'ready'])
const CONSENTS = new Set(['given', 'carried', 'needed'])
// Authentication and model readiness are separate. A CLI can stay signed in when its model
// switch is off or its connector needs repair; neither condition makes a returning person sign
// in again.
const connectionView = (id, agent) => ({
  id,
  signedIn: agent?.id === id && typeof agent.signedIn === 'boolean' ? agent.signedIn : null,
  cliFound: agent?.id === id && agent.cli?.found === true,
  enabled: agent?.id === id && agent.on === true,
  connectorState: agent?.id === id && CONNECTOR_STATES.has(agent.connector?.state) ? agent.connector.state : 'unknown',
  restartNeeded: agent?.id === id && agent.restartNeeded === true,
  // The person's word for the signed-in account (#869), when acp-dsh says: never who it is.
  ...(agent?.id === id && agent.signedIn === true && CONSENTS.has(agent.consent) ? { consent: agent.consent } : {}),
})

const refOf = route => (typeof route?.provider === 'string' && route.provider !== '' && typeof route?.model === 'string' && route.model !== ''
  ? `${route.provider}/${route.model}`
  : undefined)

// The text a message carries, for the code guard: its text parts only.
const textOf = message => (Array.isArray(message?.content)
  ? message.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n')
  : typeof message?.content === 'string' ? message.content : '')

export function install(rt) {
  const { ctx } = rt
  const acp = () => {
    try { return ctx.get?.('acpAgents') } catch { return undefined }
  }

  /** Whether a text carries a Claude sign-in state acp-dsh showed. Never throws. */
  function loginTextMatches(text) {
    if (typeof text !== 'string' || text === '') return false
    try { return acp()?.loginTextMatches?.(text) === true } catch { return false }
  }

  // Pending choices, by Bot and agent; `latest` is each Bot's newest registration.
  const choices = new Map()
  const latest = new Map()
  const outcomes = new Map()
  // Choices being applied now: taken from `choices`, their outcome not known yet. The view
  // still reads them as pending, so it never shows no choice between the two.
  const applying = new Map()
  let sequence = 0
  const keyOf = (botId, provider) => `${botId}\u0000${provider}`

  function registerChoice(bot, provider, ref) {
    const seq = ++sequence
    choices.set(keyOf(bot.id, provider), { botId: bot.id, provider, ref, baseline: bot.model ?? null, seq })
    latest.set(bot.id, seq)
    outcomes.delete(keyOf(bot.id, provider))
  }

  // A Bot's chat runs a turn on another model than the one it was on when the person chose:
  // that later choice wins, and the waiting one is dropped.
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'request/header' || choices.size === 0) return
    const botId = rt.chatOwners?.get?.(session?.id)
    if (botId === undefined) return
    const ref = refOf(event.data?.header?.config)
    if (ref === undefined) return
    for (const [key, choice] of choices) if (choice.botId === botId && ref !== choice.baseline) choices.delete(key)
  })

  async function applyChoices(provider) {
    for (const [key, choice] of choices) {
      if (choice.provider !== provider) continue
      choices.delete(key)
      const bot = rt.botOf(choice.botId)
      if (bot === undefined || latest.get(bot.id) !== choice.seq || (bot.model ?? null) !== choice.baseline) continue
      if (bot.model === choice.ref) continue
      const kept = bot.model ?? null
      applying.set(key, choice)
      try {
        await rt.updateBot(bot.id, { model: choice.ref })
        outcomes.set(key, { ref: choice.ref, ok: true, at: Date.now() })
      } catch (error) {
        // Only a message written for the person (a `bot/` refusal) is shown; anything else is
        // said by kind, as the rest of the route does.
        const message = typeof error?.code === 'string' && error.code.startsWith('bot/') && typeof error.message === 'string' ? error.message.slice(0, 300) : 'The model could not be selected.'
        outcomes.set(key, { ref: choice.ref, ok: false, message, kept, at: Date.now() })
        rt.warn('ds-bot: %s signed in, but %s was not put on %s: %s', provider, bot.name, choice.ref, error?.code ?? 'error')
      } finally {
        if (applying.get(key) === choice) applying.delete(key)
      }
    }
  }
  ctx.on('acp-dsh/login-ready', (payload) => {
    if (!PROVIDERS.has(payload?.id)) return
    void applyChoices(payload.id).catch(error => rt.warn('ds-bot: the model chosen for %s was not applied: %s', payload.id, error?.message ?? error))
      // Then the Bots that waited on this CLI's sign-in move to it (subscription-move.js, #868):
      // after the choices, so a model the person picked with the sign-in is theirs.
      .finally(() => rt.moveSubscriptionBots?.())
  })

  // The model chosen with this Bot's entry, for its view: still waiting, applied, or refused
  // (with the model the Bot stays on).
  function choiceOf(botId, provider) {
    const key = keyOf(botId, provider)
    const choice = choices.get(key)
    if (choice !== undefined && latest.get(botId) === choice.seq) return { ref: choice.ref, state: 'pending' }
    const inFlight = applying.get(key)
    if (inFlight !== undefined && latest.get(botId) === inFlight.seq) return { ref: inFlight.ref, state: 'pending' }
    const outcome = outcomes.get(key)
    if (outcome === undefined) return undefined
    if (Date.now() - outcome.at > OUTCOME_TTL_MS) {
      outcomes.delete(key)
      return undefined
    }
    return outcome.ok ? { ref: outcome.ref, state: 'applied' } : { ref: outcome.ref, state: 'failed', message: outcome.message, kept: outcome.kept }
  }

  // The account an agent is signed in to while it waits for the person's word, else undefined:
  // signed out, already consented, or an acp-dsh that keeps no such record. `probe` asks the CLI
  // (acp-dsh's shared, briefly cached check); without it only acp-dsh's last answer is read and
  // nothing is spawned unless that answer already says the account waits.
  async function pendingAccount(provider, { probe }) {
    const service = acp()
    if (typeof service?.account !== 'function') return undefined
    try {
      if (!probe) {
        const rows = typeof service.status === 'function' ? (await service.status())?.agents : undefined
        const row = Array.isArray(rows) ? rows.find(agent => agent?.id === provider) : undefined
        if (row?.signedIn !== true || row.consent !== 'needed') return undefined
      }
      const seen = await service.account(provider)
      return seen?.id === provider && seen.signedIn === true && seen.consent === 'needed'
        ? cliAccountView(seen) : undefined
    } catch {
      return undefined
    }
  }

  // "Use this account": the person's word for the account the confirm step showed. The model
  // chosen with the entry is kept first, so acp-dsh's announcement applies it (applyChoices).
  const confirm = async (payload) => {
    const body = fields(payload, 'confirm')
    const bot = rt.botOf(body.botId)
    if (bot === undefined) throw failed('This Bot is no longer available.', 'bot/not-found')
    const service = acp()
    if (typeof service?.accountConfirm !== 'function') throw failed(ERRORS['acp-login/unavailable'])
    if (body.model !== undefined) registerChoice(bot, body.provider, body.model)
    try {
      await service.accountConfirm(body.provider, body.ref === undefined ? {} : { ref: body.ref })
    } catch (error) {
      const [message, code] = ACCOUNT_ERRORS[error?.code] ?? ['The account could not be confirmed. Try again.', 'bot/refused']
      throw failed(message, code)
    }
    const choice = choiceOf(body.botId, body.provider)
    return { id: body.provider, status: 'ready', ...(choice ? { choice } : {}) }
  }

  // The vendors Bots use on a sign-in that was already there before this version (carried), for
  // the one-time notice. acp-dsh's last answer is read first; the CLI is asked only for a vendor
  // that may be due its notice.
  const accounts = async (payload) => {
    if (payload !== undefined && payload !== null && (typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 0)) throw invalid()
    const out = {}
    const service = acp()
    if (typeof service?.account !== 'function' || typeof service.status !== 'function') return { accounts: out }
    if (service.authScope === 'isolated') {
      for (const id of PROVIDERS) {
        let seen, terminal, recoveryRequired = false
        try {
          recoveryRequired = (await service.accountRecovery?.(id))?.required === true
          if (!recoveryRequired) seen = await service.account(id, { fresh: true })
        } catch (error) {
          recoveryRequired = error?.code === 'acp-account/unverified-login'
        }
        // An unreadable vendor never hides the other vendor or leaks its diagnostics.
        try { terminal = await service.terminalAccount?.(id) } catch {}
        out[id] = {
          authScope: 'isolated', signedIn: seen?.signedIn === true,
          ...(recoveryRequired ? { recoveryRequired: true } : {}),
          ...(seen?.signedIn === true ? { account: cliAccountView(seen) } : {}),
          ...(terminal?.account ? { terminal: cliAccountView(terminal) } : {}),
        }
      }
      return { accounts: out }
    }
    let rows
    try { rows = (await service.status())?.agents } catch {}
    for (const id of PROVIDERS) {
      const row = Array.isArray(rows) ? rows.find(agent => agent?.id === id) : undefined
      if (row === undefined || row.on === false || row.cli?.found === false || row.signedIn === false) continue
      if (row.signedIn === true && row.consent !== 'carried') {
        if (CONSENTS.has(row.consent)) out[id] = { consent: row.consent }
        continue
      }
      let seen
      try { seen = await service.account(id) } catch { continue }
      if (seen?.id !== id || seen.signedIn !== true || !CONSENTS.has(seen.consent)) continue
      out[id] = { consent: seen.consent, ...(seen.consent === 'carried' && seen.notice === true ? { notice: true, account: cliAccountView(seen) } : {}) }
    }
    return { accounts: out }
  }

  const noticed = async (payload) => {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => key !== 'provider') || !PROVIDERS.has(payload.provider)) throw invalid()
    try { await acp()?.accountNoticed?.(payload.provider) } catch {}
    return { id: payload.provider }
  }

  const connections = async (payload) => {
    if (payload !== undefined && payload !== null && (typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 0)) throw invalid()
    const ids = [...PROVIDERS]
    const empty = () => ({ available: false, connections: Object.fromEntries(ids.map(id => [id, connectionView(id)])) })
    const service = acp()
    if (typeof service?.inspect === 'function') {
      // inspect only runs the CLI's read-only auth-status probe (shared and briefly cached in
      // acp-dsh); refresh would also kick installers, so this endpoint never calls it.
      const results = await Promise.allSettled(ids.map(async id => service.inspect(id)))
      return { available: true, connections: Object.fromEntries(ids.map((id, index) => [id, connectionView(id, results[index].status === 'fulfilled' ? results[index].value : undefined)])) }
    }
    if (typeof service?.status === 'function') {
      let value
      try { value = await service.status() } catch { return empty() }
      const agents = Array.isArray(value?.agents) ? value.agents : []
      return { available: true, connections: Object.fromEntries(ids.map(id => [id, connectionView(id, agents.find(agent => agent?.id === id))])) }
    }
    return empty()
  }

  const run = action => async (payload) => {
    const body = fields(payload, action)
    // Only a Bot's chat signs in (the Omni Bot included). A cancel still goes through after its
    // Bot was removed: the attempt is the CLI's, not the Bot's.
    const bot = rt.botOf(body.botId)
    if (action !== 'cancel' && bot === undefined) throw failed('This Bot is no longer available.', 'bot/not-found')
    // The explicit entry's choice is kept before the attempt starts: an agent already signed
    // in reports ready at once.
    if (action === 'start' && body.model !== undefined) registerChoice(bot, body.provider, body.model)
    // A CLI already signed in, to an account that waits for the person: the confirm step, before
    // any sign-in starts. Their "Use this account" (confirm) is what makes the agent ready.
    if (action === 'start') {
      const account = await pendingAccount(body.provider, { probe: true })
      if (account !== undefined) {
        const choice = choiceOf(body.botId, body.provider)
        return { id: body.provider, status: 'confirm', account, ...(choice ? { choice } : {}) }
      }
    }
    let value
    try {
      const service = acp()
      const method = METHODS[action]
      if (typeof service?.[method] !== 'function') throw Object.assign(new Error('Unavailable'), { code: 'acp-login/unavailable' })
      const args = action === 'start' ? [body.provider, { label: body.botId }]
        : action === 'current' ? [body.provider]
          : action === 'answer' ? [body.provider, body.attemptId, body.value]
            : [body.provider, body.attemptId]
      value = await service[method](...args)
    } catch (error) {
      const code = error?.code ?? ''
      throw failed(Object.hasOwn(ERRORS, code) ? ERRORS[code] : 'Could not continue this sign-in. Try again.', Object.hasOwn(ERROR_CODES, code) ? ERROR_CODES[code] : 'bot/refused')
    }
    if (action === 'current' && (value === undefined || value === null)) {
      const choice = choiceOf(body.botId, body.provider)
      const account = await pendingAccount(body.provider, { probe: false })
      return { id: body.provider, attempt: null, ...(account ? { account } : {}), ...(choice ? { choice } : {}) }
    }
    const view = cliLoginView(value, body.provider, action === 'start' || action === 'current' ? undefined : body.attemptId)
    const choice = choiceOf(body.botId, body.provider)
    // An attempt that ended ready on a CLI that was already signed in (it raced the check
    // above): the same confirm step, never "done".
    if (view.status === 'ready') {
      const account = await pendingAccount(body.provider, { probe: false })
      if (account !== undefined) {
        const waiting = { id: body.provider, status: 'confirm', account, ...(choice ? { choice } : {}) }
        return action === 'current' ? { id: body.provider, attempt: null, account, ...(choice ? { choice } : {}) } : waiting
      }
    }
    if (choice !== undefined) view.choice = choice
    return action === 'current' ? { id: body.provider, attempt: view } : view
  }

  const actions = {
    ...Object.fromEntries(['switch', 'signout', 'reset'].map(action => [
      `cli-login-${action}`, async payload => {
      const body = fields(payload, action)
      if (!rt.botOf(body.botId)) throw failed('This Bot is no longer available.', 'bot/not-found')
      const service = acp()
      const method = { switch: 'accountSwitch', signout: 'accountSignOut',
        reset: 'accountReset' }[action]
      if (service?.authScope !== 'isolated' || typeof service[method] !== 'function') {
        throw failed('Bot account controls are unavailable. Update Automagik and try again.')
      }
      try {
        await service[method](body.provider, { label: body.botId })
        return { id: body.provider, signedIn: false }
      } catch (error) {
        if (error?.code === 'acp-account/unverified-login') {
          throw failed(ACCOUNT_RECOVERY_HINT, ACCOUNT_RECOVERY_CODE)
        }
        throw failed('Account change failed. Close other app windows and try again.')
      }
    }])),
    'cli-login-connections': connections,
    'cli-login-confirm': confirm,
    'cli-login-accounts': accounts,
    'cli-login-noticed': noticed,
    ...Object.fromEntries(Object.keys(METHODS).map(action => [`cli-login-${action}`, run(action)])),
  }

  // A Bot's step, or a group's own Session (parts.js calls this first in its pre-step listener,
  // before a switch can carry the batch): a message that carries a shown sign-in state leaves
  // the step before any model call or transcript row (its inbox insert, written by DSH when the
  // prompt was admitted, is out of reach here: see the header). A group's Session counts too: what is
  // typed there is relayed to its members. The batch was claimed already, so it is dropped,
  // never re-queued; the rest of the batch goes on. The claimed array itself is changed, so
  // DSH's own default decision, which reads it, no longer holds the message either. A message
  // the team delivered was noted for a resend after a restart (resume.js); that note goes too.
  function dropLoginCodes(payload) {
    const agentId = payload?.agent?.id
    if (!Array.isArray(payload?.messages) || payload.messages.length === 0) return
    if (!rt.isBotSession?.(agentId) && rt.roomOf?.(agentId) === undefined) return
    for (let index = payload.messages.length - 1; index >= 0; index--) {
      const message = payload.messages[index]
      if (message?.role === 'user' && loginTextMatches(textOf(message))) {
        payload.messages.splice(index, 1)
        const exchangeId = message.source?.exchangeId
        if (typeof exchangeId === 'string' && exchangeId !== '') {
          try { rt.forgetDelivery?.(exchangeId) } catch {}
        }
        rt.warn('ds-bot: a message in %s carried a sign-in code and was not sent', agentId)
      }
    }
  }

  // Every delivery between Bots, groups, schedules and reports: one that carries a shown
  // sign-in state is refused before it is noted anywhere (resume.js keeps a delivery's text
  // for a resend after a restart, when the state's hash is gone). Installed after resume.js,
  // so this check runs first.
  const deliver = rt.deliver
  if (typeof deliver === 'function') {
    rt.deliver = async (args) => {
      if (loginTextMatches(args?.text)) {
        rt.warn('ds-bot: a delivery to %s carried a sign-in code and was not sent', args?.toId)
        throw failed(CODE_REFUSED)
      }
      return await deliver(args)
    }
  }

  Object.assign(rt, { cliLoginActions: actions, loginTextMatches, dropLoginCodes, cliLoginChoice: choiceOf })
}
