import { grantModelFields, grantTeamModels, withGrantHold } from './grants.js'
// Models. Every Bot runs on one model of its own, fixed when it is created and changed
// only in its settings or by a Main Bot. The team's first Main Bot has none until the
// user picks one in its chat. The Session keeps the selection durably.
import { BlockAssembler, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { AsyncLocalStorage } from 'node:async_hooks'
import { cliRoute, commandCapableAgent, leavesCli, piAiRoutes, routeOf } from '../shared/routes.js'
import { CHOOSE_CONCRETE, CHOOSE_DIFFERENT, chosenIdentityOf } from '../shared/solver-model.js'
import { refusal } from './refusal.js'
import { normalize, splitRef } from './text.js'
import { install as installHostModels } from './host-models.js'
import { PI_AI_CLAUDE, claudeFamilyOf, supersededClaude } from './claude-models.js'
import { SettingsSelectionRejected } from './pocket-settings.js'
import { readableRoute } from './session-route.js'

const CLAUDE_PIN_REFS = new Set([
  'acp-claude/claude-sonnet-5-5',
  'acp-claude/claude-opus-5-5',
  'acp-claude/claude-fable-5-2',
  'acp-claude/claude-haiku-5-5',
])
const CATALOG_TTL_MS = 10_000
const quiet = new AsyncLocalStorage()
// What a refused model says, by case; `{connection}` is the agent's name and route. The client
// words each template in the interface language (i18n.js hostText).
export const ACCESS_MESSAGES = Object.freeze({
  off: 'Turn on {connection} in Settings → Coding agents before using this model.',
  installing: 'Wait for {connection} to finish installing, or retry it in Settings → Coding agents.',
  signIn: 'Sign in to {connection} before using this model.',
  // Signed in on this computer, to an account the person has not confirmed for Bots (#869).
  account: 'Confirm the account of {connection} before using this model.',
})
// The refusal of a model whose agent is signed in to an account the person has not confirmed
// (acp-dsh's `consent: 'needed'`): the sign-in card's confirm step answers it, a sign-in does not.
export const ACCOUNT_CONFIRM_REQUIRED = 'bot/account-confirm-required'
const ROUTE_WAIT_MS = 30_000
// How often an agent whose sign-in acp-dsh has not checked yet is asked once, in the
// background: the menu reads acp-dsh's last answer and never spawns a check when it opens.
const SIGN_IN_CHECK_MS = 5 * 60_000
// How long a fresh catalog waits on acp-dsh's status before it keeps the last answer.
const STATUS_WAIT_MS = 1000

// A connection's name in the model menu: the brand, without the route's id. How it is
// connected (`via`) is worded by the menu (API key, sign-in); an agent is its CLI's name.
const BRANDS = Object.freeze({ anthropic: 'Anthropic', openai: 'OpenAI', 'openai-codex': 'ChatGPT', 'acp-claude': 'Claude Code', 'acp-codex': 'Codex' })
function brandOf(provider, directory) {
  if (BRANDS[provider.id] !== undefined) return BRANDS[provider.id]
  const name = typeof provider.name === 'string' && provider.name !== '' && provider.name !== provider.id ? provider.name : undefined
  if (routeOf(provider.id).connectedBy === 'acp') return (name ?? provider.id).replace(/\s*\(ACP\)$/, '')
  return name ?? directory.find(entry => entry?.provider === provider.id)?.displayName ?? provider.id
}
// The agent that serves a subscription DSH could also sign in to: ChatGPT and Claude Pro/Max
// sign in only through their CLIs (D-a), so a Bot runs a plan through Claude Code or Codex
// (D-c), never DSH's own sign-in route. That route is `covered`: no Bot connection, shown only
// as the model a Bot is still on. The jobs beside the chats keep it (D-g).
const CLI_OF_SIGNIN = Object.freeze({ 'openai-codex': 'acp-codex', anthropic: 'acp-claude' })
const PLAN_NAMES = Object.freeze({ 'openai-codex': 'ChatGPT', anthropic: 'Claude' })
const coveredBy = entry => (entry.via === 'signin' ? CLI_OF_SIGNIN[entry.provider] : undefined)
// What a Bot's own chat can start on: a provider with its key, an agent that is signed in, a
// sign-in route of another provider that is stored, and never a route a CLI covers. An agent
// signed in to an account nobody confirmed (`needsAccount`, #869) is never a default: a Bot
// goes on it only by the person's own pick, which asks them first.
export const configured = entry => !entry.needsKey && !entry.needsSignIn && !entry.covered && !entry.needsAccount
// The model of a covered sign-in route on its agent, among `usable`: the same id, else the same
// Claude family (Claude Code names its models `opus`, `sonnet`, `haiku`, or a versioned id such
// as `claude-fable-5-1[1m]`), else the agent's own
// `default`, else its first. Undefined when the agent offers nothing that can run.
function cliPeerOf(entry, usable) {
  const agent = CLI_OF_SIGNIN[entry?.provider]
  const own = agent === undefined ? [] : usable.filter(item => item.provider === agent)
  if (own.length === 0) return undefined
  const family = entry.provider === PI_AI_CLAUDE ? claudeFamilyOf(`claude-code/${entry.id}`) : undefined
  const sameFamily = family === undefined ? undefined : own.find(item => item.id === family) ?? own.find(item => claudeFamilyOf(`claude-code/${item.id}`) === family)
  return own.find(item => item.id === entry.id) ?? sameFamily ?? own.find(item => item.id === 'default') ?? own[0]
}

// The model an agent's own `default` runs on, when its catalog says (acp-dsh catalog.js
// describes that row "Its own setting: <model>"): the menu names the row "Default (<model>)"
// rather than the agent's name twice.
const OWN_SETTING = /^Its own setting: (.+)$/
function resolvedDefault(provider, model) {
  if (model?.id !== 'default' || routeOf(provider).connectedBy !== 'acp') return {}
  const name = OWN_SETTING.exec(typeof model.description === 'string' ? model.description : '')?.[1]?.trim()
  return name ? { resolvesTo: name } : {}
}

// The DeepSeek account's sign-in grant (dsh-deepseek-account-platform).
const ACCOUNT_RECORD = 'deepseek-account-platform/default'
const TRANSIENT_LLM_CODES = new Set(['TRANSPORT', 'TIMEOUT'])
export const QUOTA_CODES = new Set(['QUOTA', 'ACCOUNT_QUOTA', 'acp/aside-quota'])
const QUOTA_HOLD_MS = 60 * 60_000

function retryPolicyOf(ctx, provider) {
  try {
    const resolved = ctx.llm?.providerRetryPolicy?.(provider)
    if (resolved !== undefined) return resolved
  } catch {}
  return resolveRetryPolicy(undefined, 'ds-bot')
}

function retryDelayMs(policy, failure, retry, backoff, random) {
  const initialDelayMs = backoff?.initialDelayMs ?? policy.initialDelayMs
  const maxDelayMs = backoff?.maxDelayMs ?? policy.maxDelayMs
  const jitterRatio = backoff?.jitterRatio ?? policy.jitterRatio
  const providerAfter = failure?.providerRetryAfterMs
  if (providerAfter !== undefined && Number.isFinite(providerAfter) && providerAfter > 0) {
    if (providerAfter <= maxDelayMs) return providerAfter
    if (policy.mode === 'normal') return undefined
  }
  const exponential = Math.min(initialDelayMs * 2 ** Math.min(retry - 1, 1024), maxDelayMs)
  const jitter = 1 - jitterRatio + 2 * jitterRatio * random()
  return Math.min(exponential * jitter, maxDelayMs)
}

function waitRetryDelay(delayMs, signal) {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort() {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function abortedAssembler(failure) {
  const assembler = new BlockAssembler()
  assembler.push({ type: 'finish', reason: { kind: 'aborted', failure: failure ?? { code: 'ABORTED', message: 'aborted' } } })
  return assembler
}

function canRetryPolicy(policy, code, retry) {
  if (policy.mode === 'always') return true
  if (policy.mode !== 'normal') return false
  return Array.isArray(policy.retryableCodes) && policy.retryableCodes.includes(code) && retry <= policy.maxRetries
}

// Auxiliary calls (memory, learning, handoff, steward, OCR, side chats, browser_task)
// bypass the agent loop's `agent/request-error` hook, so `dsh-llm-retry` never sees
// their transport or stream-idle failures. Retry those transient codes on the same
// route with the provider's own retry policy, discarding partial chunks from failed attempts.
export async function assembleLlmStream(ctx, options, { signal, backoff, random = Math.random, check, dispatch } = {}) {
  const fused = options.signal && signal ? AbortSignal.any([options.signal, signal]) : (options.signal ?? signal)
  const request = fused === options.signal ? options : { ...options, signal: fused }
  for (let retry = 1; ; retry += 1) {
    if (dispatch?.prepare !== undefined) await dispatch.prepare()
    dispatch?.check()
    const assembler = new BlockAssembler()
    let thrown
    try {
      for await (const chunk of ctx.llm.stream(request)) {
        check?.()
        assembler.push(chunk)
      }
    } catch (error) {
      thrown = error
    }
    if (thrown !== undefined) {
      const code = thrown?.failure?.code ?? thrown?.code
      const failure = thrown?.failure ?? { code, message: thrown?.message || String(thrown) }
      if (fused?.aborted || !TRANSIENT_LLM_CODES.has(code)) throw thrown
      const policy = retryPolicyOf(ctx, options.provider)
      if (!canRetryPolicy(policy, code, retry)) throw thrown
      const delayMs = retryDelayMs(policy, failure, retry, backoff, random)
      if (delayMs === undefined) throw thrown
      if (!await waitRetryDelay(delayMs, fused)) throw fused?.reason ?? thrown
      continue
    }
    const finish = assembler.finish
    if (finish.kind !== 'error' || fused?.aborted) return assembler
    const failure = finish.failure
    const code = failure?.code
    if (!TRANSIENT_LLM_CODES.has(code)) return assembler
    const policy = retryPolicyOf(ctx, options.provider)
    if (!canRetryPolicy(policy, code, retry)) return assembler
    const delayMs = retryDelayMs(policy, failure, retry, backoff, random)
    if (delayMs === undefined) return assembler
    if (!await waitRetryDelay(delayMs, fused)) return abortedAssembler({ code: 'ABORTED', message: failure?.message ?? 'aborted' })
  }
}

export function install(rt) {
  const { ctx, state } = rt
  const asideQuota = new Map()
  const quotaUntil = provider => {
    const until = asideQuota.get(provider)
    if (until > Date.now()) return until
    asideQuota.delete(provider)
    return undefined
  }
  const liftQuota = () => {
    asideQuota.clear()
    rt.liftMemoryHolds?.()
  }
  // Bots a plugin answers for on its own engine (host-models.js) never run on a DSH model.
  installHostModels(rt)
  const onDsh = bot => !rt.hostOwned(bot)

  let modelsSynced = null
  let catalogCache = { at: 0, value: [] }
  let catalogEpoch = 0
  let signInsRead = false
  let signInsDirty = false
  // Routes DSH serves that cannot answer a request at all — a hosted loop engine
  // publishes one so its Sessions can be prompted. Once one refuses with
  // HOSTED_ENGINE_ROUTE it is remembered with the models its provider served then,
  // and nothing chooses it again until that provider serves different models.
  const refused = new Map()
  const answerable = entries => (refused.size === 0 ? entries : entries.filter(entry => !refused.has(entry.ref)))
  // `held`: the snapshot as last listed, whatever its age, or undefined when none is held
  // (never listed, or dropped by a key, sign-in or route change). Pocket reads only this:
  // the desktop lists models when its menus need them, so a phone could wait a long time
  // for one listed in the last few seconds (RFC 0036, Models).
  const cachedCatalog = ({ held = false } = {}) => {
    if (held && catalogCache.at === 0) return undefined
    return answerable(catalogCache.value)
  }
  // The models a ref's provider serves, as a string to compare; undefined when it
  // cannot be listed, e.g. the provider is not registered.
  async function servedModels(ref) {
    try { return JSON.stringify(await ctx.llm.listModels(splitRef(ref).provider)) } catch { return undefined }
  }
  // An adapter update may have replaced a refused placeholder with a real route, which
  // serves other models; the same models again are the same route, still refused.
  async function forgetChangedRefusals() {
    for (const [ref, served] of refused) {
      const now = await servedModels(ref)
      if (now !== undefined && now !== served) refused.delete(ref)
    }
  }
  // A model's thinking levels, resolved once and kept for a short while: they change
  // only with the provider, which also drops the catalog cache.
  const reasoningCache = new Map()
  const invalidate = () => {
    catalogEpoch += 1
    catalogCache.at = 0
  }
  // A key set or a sign-in may be the user's fix for a Bot's failed turn (turns.js); a
  // key removed or a sign-out is not. A provider that registers or changes fixes
  // nothing by itself: providers register late at every start.
  ctx.on?.('llm/adapters-updated', () => {
    invalidate()
    reasoningCache.clear()
    // Invalidate a status already requested, including one still being read. Until the
    // first request, keep the ordinary catalog's lazy sign-in check.
    signInsDirty = signInsRead
    return forgetChangedRefusals()
  })
  ctx.on?.('credentials/reference-updated', async (ref) => {
    invalidate()
    if (await inPlace(credentials => credentials.describe(ref))) {
      liftQuota()
      rt.unblockBots?.({ ref })
    }
  })
  // A sign-in writes the account's record. A sign-out removes it, and so does a token
  // the provider refused, while the turn that failed on it still runs. Other plugins'
  // records (an OAuth token refresh) say nothing about the account.
  ctx.on?.('credentials/record-updated', async (key) => {
    invalidate()
    if (String(key) !== ACCOUNT_RECORD) return
    if (await inPlace(credentials => credentials.describeRecord(key))) {
      liftQuota()
      rt.unblockBots?.({ signedIn: true })
    }
  })
  ctx.on?.('settings/document-updated', invalidate)

  // Whether a credential is there after a change. One that cannot be read counts as
  // there, so a fix is not missed.
  async function inPlace(describe) {
    const credentials = ctx.get?.('credentials')
    if (credentials === undefined) return true
    try { return (await describe(credentials))?.configured !== false } catch { return true }
  }

  // The thinking levels a model serves: `{efforts: [{id, name, description?}],
  // defaultEffort?}`, or undefined when it has none or the provider cannot say.
  async function reasoningOf(ref, epoch = catalogEpoch) {
    const cached = reasoningCache.get(ref)
    if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) return cached.value
    const route = splitRef(ref)
    const info = route === undefined ? undefined : await ctx.llm.resolveModelInfo?.(route.provider, route.model).catch(() => undefined)
    const value = info?.reasoning === undefined ? undefined : {
      efforts: (info.reasoning.efforts ?? []).map(effort => ({ id: effort.id, name: effort.name ?? effort.id, ...(effort.description ? { description: effort.description } : {}) })),
      ...(info.reasoning.defaultEffort === undefined ? {} : { defaultEffort: info.reasoning.defaultEffort }),
    }
    if (epoch === catalogEpoch) reasoningCache.set(ref, { at: Date.now(), value })
    return value
  }

  // Each agent's sign-in as acp-dsh last saw it: true, false, or absent while unknown. A
  // fresh catalog (a menu about to open) reads acp-dsh's `status()`, which spawns nothing; any
  // other catalog keeps the last answer unless adapters changed. An unknown agent ready to run
  // is checked once in the background (acp-dsh's `inspect`, one `auth status`), at most every
  // SIGN_IN_CHECK_MS.
  const agentSignIn = new Map()
  // The agents signed in to an account the person has not confirmed (acp-dsh's `consent`). An
  // older acp-dsh says nothing, and nothing is asked.
  const agentUnconfirmed = new Set()
  const noteConsent = (row) => {
    const needed = row?.signedIn === true && row.consent === 'needed'
    if (needed === agentUnconfirmed.has(row.id)) return false
    if (needed) agentUnconfirmed.add(row.id)
    else agentUnconfirmed.delete(row.id)
    return true
  }
  const signInChecks = new Map()
  const acpAgents = () => { try { return ctx.get?.('acpAgents') } catch { return undefined } }
  async function readAgentSignIns(epoch) {
    const agents = acpAgents()
    if (typeof agents?.status !== 'function') return
    signInsRead = true
    let timer
    const late = new Promise((resolve) => { timer = setTimeout(resolve, STATUS_WAIT_MS) })
    let rows
    try { rows = (await Promise.race([Promise.resolve().then(() => agents.status()), late]))?.agents } catch {} finally { clearTimeout(timer) }
    if (epoch !== catalogEpoch || !Array.isArray(rows)) return
    signInsDirty = false
    const bots = Object.values(state.bots ?? {})
    for (const row of rows) {
      if (typeof row?.id !== 'string') continue
      noteConsent(row)
      if (typeof row.signedIn === 'boolean') { agentSignIn.set(row.id, row.signedIn); continue }
      agentSignIn.delete(row.id)
      const last = signInChecks.get(row.id)
      if (row.on === false || row.connector?.state !== 'ready' || typeof agents.inspect !== 'function' || (last !== undefined && Date.now() - last < SIGN_IN_CHECK_MS)) continue
      const providerMatches = bot => [bot.model, bot.appliedModel].some(ref => typeof ref === 'string' && ref.split('/')[0] === row.id)
      if (bots.some(bot => providerMatches(bot) && bot.shellHeld !== undefined)
        && !bots.some(bot => providerMatches(bot) && bot.shellHeld === undefined)) continue
      signInChecks.set(row.id, Date.now())
      void Promise.resolve().then(() => agents.inspect(row.id)).then((seen) => {
        if (epoch !== catalogEpoch || typeof seen?.signedIn !== 'boolean') return
        noteConsent({ ...seen, id: row.id })
        agentSignIn.set(row.id, seen.signedIn)
        catalogCache = { at: 0, value: [] }
      }, () => {})
    }
  }

  // A provider's model list can change in DSH settings without any event, so a picker
  // that is about to be used asks for a `fresh` one. Entries for models a Bot uses
  // also carry their `reasoning`, so the picker can offer thinking levels.
  // Auxiliary Bot work without a runner can list API providers without probing
  // command-capable adapters or changing the owner's catalog cache.
  async function catalog({ fresh = false, remember = true, noCommands = false } = {}) {
    const visible = entries => noCommands ? entries.filter(entry => !commandCapableAgent(entry.provider)) : entries
    // Pocket's work can use the existing snapshot. Even a module-local catalog call
    // must leave desktop enumeration, cache population and unblocking to the desktop.
    if (quiet.getStore() === rt) return visible(cachedCatalog({ held: true }) ?? [])
    if (!fresh && Date.now() - catalogCache.at < CATALOG_TTL_MS && catalogCache.value.length > 0) return answerable(visible(catalogCache.value))
    const epoch = catalogEpoch
    const listed = []
    let directory = []
    try { directory = ctx.llm.listConfigurableProviders?.() ?? [] } catch {}
    const piAi = piAiRoutes(directory)
    for (const provider of ctx.llm.listProviders()) {
      if (noCommands && commandCapableAgent(provider.id)) continue
      let models = []
      try { models = await ctx.llm.listModels(provider.id) } catch { continue }
      const acp = provider.id === 'acp-claude' ? ctx.get?.('acpAgents') : undefined
      for (const model of models) {
        const ref = `${provider.id}/${model.id}`
        const identity = chosenIdentityOf(ref)
        let proof
        if (acp && CLAUDE_PIN_REFS.has(identity) && identity !== ref) {
          try { proof = acp.modelIdentityOf?.(provider.id, model.id) } catch {}
        }
        listed.push({
          ref,
          provider: provider.id,
          providerName: brandOf(provider, directory),
          id: model.id,
          name: model.name ?? model.id,
          solverIdentity: identity,
          ...(proof?.status === 'offered' && `${provider.id}/${proof.model}` === identity ? { solverRef: identity } : {}),
          route: routeOf(provider.id, { piAi }),
          ...(model.inputModalities ? { input: [...model.inputModalities] } : {}),
          ...resolvedDefault(provider.id, model),
        })
      }
    }
    const used = new Set(Object.values(state.bots ?? {}).filter(bot => onDsh(bot) && bot.shellHeld === undefined)
      .flatMap(bot => [bot.model, bot.appliedModel].filter(Boolean)))
    const entries = listed
    // Claude on pi-ai's anthropic route: the menu offers each family's newest model.
    const claude = entries.filter(entry => entry.provider === PI_AI_CLAUDE)
    const superseded = supersededClaude(claude.map(entry => entry.id))
    for (const entry of claude) if (superseded.has(entry.id)) entry.superseded = true
    // DSH serves a provider's models whether or not its key is set; without one, every
    // turn on them fails.
    const missing = await rt.missingKeys?.([...new Set(entries.map(entry => entry.provider))]) ?? new Set()
    for (const entry of entries) if (missing.has(entry.provider)) entry.needsKey = true
    // How each route is connected (providers.js routeAuth) and whether it can run: a plan
    // route with no stored sign-in, or an agent whose CLI is signed out, `needsSignIn`.
    const providers = [...new Set(entries.map(entry => entry.provider))]
    const agentsListed = entries.some(entry => routeOf(entry.provider).connectedBy === 'acp')
    const [auth] = await Promise.all([
      Promise.resolve().then(() => rt.routeAuth?.(providers)).catch(() => undefined).then(value => value ?? new Map()),
      (fresh || signInsDirty) && agentsListed ? readAgentSignIns(epoch) : undefined,
    ])
    for (const entry of entries) {
      const how = routeOf(entry.provider).connectedBy === 'acp' ? { via: 'cli', ...(agentSignIn.get(entry.provider) === false ? { needsSignIn: true } : {}) } : auth.get(entry.provider)
      if (how?.via) entry.via = how.via
      if (how?.needsSignIn) entry.needsSignIn = true
      // Still offered in the menu: picking it opens the confirm step in the Bot's chat.
      if (how?.via === 'cli' && agentUnconfirmed.has(entry.provider)) entry.needsAccount = true
    }
    // DSH's own ChatGPT or Claude sign-in: its CLI serves that plan, signed in or not.
    for (const entry of entries) if (coveredBy(entry) !== undefined) entry.covered = true
    if (remember && !noCommands) {
      noteConnected(entries)
      // A key can arrive without an event, so a provider listed with its key again lifts
      // what its missing key blocked. Catalog reads used to validate a pick stay read-only.
      rt.unblockBots?.({ keyed: new Set(entries.filter(entry => !entry.needsKey).map(entry => entry.provider)) })
    }
    await Promise.all(entries.filter(entry => used.has(entry.ref)).map(async (entry) => {
      const reasoning = await reasoningOf(entry.ref, epoch)
      if (reasoning !== undefined) entry.reasoning = reasoning
    }))
    if (epoch === catalogEpoch && !noCommands) catalogCache = { at: Date.now(), value: entries }
    return answerable(entries)
  }

  // The profile default model of DSH as set, served or not, and able to answer.
  const defaultRef = () => {
    const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.()
    if (!selection?.provider || !selection?.model) return undefined
    const ref = `${selection.provider}/${selection.model}`
    return refused.has(ref) ? undefined : ref
  }
  // The providers in the order they could first run here (a key set, an account signed
  // in), kept with the team: "the first account you connected".
  function noteConnected(entries) {
    if (!Array.isArray(state.providersSeen)) state.providersSeen = []
    const seen = state.providersSeen
    const fresh = [...new Set(entries.filter(entry => !entry.needsKey).map(entry => entry.provider))].filter(provider => !seen.includes(provider))
    if (fresh.length === 0) return
    seen.push(...fresh)
    void rt.save?.()?.catch?.(() => {})
  }
  // By the catalog as last listed, without waiting for a fresh one.
  const isUsable = ref => catalogCache.value.some(entry => entry.ref === ref && entry.needsKey !== true)
  // The profile default model of DSH (DeepSeek, unless the user chose another there), when
  // it is served and can run (its provider has its key); else a model of the first account
  // connected here. Within a provider, a `default` alias comes after the models it names, and
  // a superseded model (an older Claude) after the current ones.
  // Nothing can run: none, and a Bot made then waits for one.
  // `canRun`: what counts as able to run. A Bot's own model skips a sign-in that is missing
  // and a route a CLI covers; the jobs beside the chats keep their own rule.
  // DSH's default on a ChatGPT or Claude sign-in it cannot run that way is read as the same
  // model on that plan's CLI, when the CLI can run.
  function pickDefault(entries, canRun = configured, captured) {
    // Neither a refused route nor one that cannot run is picked.
    const usable = answerable(entries).filter(canRun)
    const ref = captured === undefined ? defaultRef() : captured.modelDefault
    const chosen = usable.find(entry => entry.ref === ref)
    if (chosen) return chosen.ref
    const signIn = entries.find(entry => entry.ref === ref && entry.covered === true)
    const peer = signIn === undefined ? undefined : cliPeerOf(signIn, usable)
    if (peer) return peer.ref
    const seen = captured === undefined ? providersSeen() : JSON.parse(captured.providersSeen)
    const rank = entry => (seen.includes(entry.provider) ? seen.indexOf(entry.provider) : seen.length)
    const ordered = usable.map((entry, index) => ({ entry, index })).sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index).map(({ entry }) => entry)
    const first = ordered[0]?.provider
    const own = ordered.filter(entry => entry.provider === first)
    return (own.find(entry => entry.id !== 'default' && entry.superseded !== true) ?? own.find(entry => entry.id !== 'default') ?? own[0])?.ref
  }
  const providersSeen = () => Array.isArray(state.providersSeen) ? state.providersSeen : []
  const defaultModel = async ({ noCommands = false } = {}) => pickDefault(await catalog({ noCommands }))

  // The model a create that names none starts on: the team's pick while the catalog
  // still serves it, else the DSH default. A create fixes the ref then, so a later
  // change of either default leaves the Bot alone.
  const defaultBotModel = async () => {
    const entries = await catalog()
    const preferred = state.prefs.defaultBotModel
    return entries.some(entry => entry.ref === preferred) ? preferred : pickDefault(entries)
  }

  // The model of the jobs that run beside the chats (memory review, the memory panel, a part's
  // note or checkpoint when its chat is on an agent): one that answers a request on its own. An
  // agent over ACP answers only in its own chat, so it is never one. The team's pick
  // (prefs.backgroundModel, in Settings) when it is served and can run; else DSH's default
  // model (DeepSeek, unless the person chose another there) when that can; else the first
  // account connected here, as for a Bot's default.
  const answersAside = entry => !['acp', 'hermes-remote'].includes(routeOf(entry.provider).connectedBy)
  function pickBackground(entries, canRun = entry => !entry.needsKey && !quotaUntil(entry.provider)) {
    const aside = entries.filter(answersAside)
    const chosen = state.prefs?.backgroundModel
    if (typeof chosen === 'string' && aside.some(entry => entry.ref === chosen && canRun(entry))) return chosen
    return pickDefault(aside, canRun)
  }
  const backgroundModel = async (sessionId, { noCommands = false } = {}) => {
    rt.assertBotRunnerProvider?.(state.prefs?.backgroundModel, sessionId)
    return pickBackground(await catalog({ noCommands: noCommands || rt.botRunnerRequired?.(sessionId) }))
  }
  const memoryBackground = async (sessionId) => {
    rt.assertBotRunnerProvider?.(state.prefs?.backgroundModel, sessionId)
    const entries = await catalog({ noCommands: true })
    const ref = pickBackground(entries)
    if (ref !== undefined) return { ref }
    const holds = entries.filter(entry => answersAside(entry) && !entry.needsKey)
      .map(entry => quotaUntil(entry.provider)).filter(Boolean)
    return { retryAt: holds.length ? Math.min(...holds) : undefined }
  }
  /** Whether a `provider/model` ref can answer a job beside the chats (not an ACP agent). */
  const answersAsideRef = ref => typeof ref === 'string' && ref.includes('/') && !['acp', 'hermes-remote'].includes(routeOf(ref.split('/')[0]).connectedBy)

  // A ChatGPT or Claude plan runs a Bot only through its CLI (D-a, D-c), whoever picks the model
  // (the menu, a tool, the API, Pocket): a covered sign-in route is read as the closest model on
  // that plan's agent (cliPeerOf, as the one-time move maps it), signed in or not, so the
  // agent's own sign-in answers. `keep`, the model the Bot is on now, stays as it is. With no
  // model of that agent served (its CLI off), the pick is refused.
  function onPlanCli(ref, entries, keep) {
    const entry = entries.find(item => item.ref === ref)
    if (entry?.covered !== true || ref === keep) return ref
    const peer = cliPeerOf(entry, entries.filter(item => !item.covered && !item.needsKey))
    if (peer !== undefined) return peer.ref
    const plan = PLAN_NAMES[entry.provider] ?? entry.provider
    const cli = BRANDS[CLI_OF_SIGNIN[entry.provider]] ?? CLI_OF_SIGNIN[entry.provider]
    throw refusal(`A ${plan} plan runs Bots only through ${cli}. Turn ${cli} on, then pick one of its models.`)
  }

  // A full `provider/model` ref, or a model id or name that only one provider serves.
  // `checkAccess`: a model that cannot run now (modelAccess) is refused here, before anything
  // is written. `remember: false` leaves team state alone while validating the pick.
  // `keep`: the Bot's current model, never moved (onPlanCli).
  async function resolveModel(text, { checkAccess = false, remember = true, keep } = {}) {
    const entries = await catalog({ fresh: true, remember })
    const wanted = String(text ?? '').trim()
    const exact = entries.find(entry => entry.ref === wanted)
    const named = exact ? [] : entries.filter(entry => normalize(entry.id) === normalize(wanted) || normalize(entry.name) === normalize(wanted))
    const picked = exact?.ref ?? (named.length === 1 ? named[0].ref : undefined)
    if (picked !== undefined) {
      const found = onPlanCli(picked, entries, keep)
      if (checkAccess) await assertModelAccess(found)
      return found
    }
    if (named.length > 1) {
      throw refusal(`Model ${wanted} is served by more than one provider; use one of ${named.map(entry => entry.ref).join(', ')}`)
    }
    const known = entries.map(entry => entry.ref).join(', ') || 'none'
    throw Object.assign(refusal(`Model ${wanted} is not available. Available models: ${known}`), { modelUnavailable: true })
  }

  async function checkSolverModel(ref, reviewer) {
    const selected = chosenIdentityOf(ref)
    if (!selected) throw refusal(CHOOSE_CONCRETE)
    if (!reviewer) return
    const saved = reviewer.model ?? reviewer.appliedModel
    const other = chosenIdentityOf(saved)
    if (!other || rt.botOf(reviewer.id) !== reviewer || (reviewer.model ?? reviewer.appliedModel) !== saved) throw refusal(CHOOSE_CONCRETE)
    if (other === selected) throw refusal(CHOOSE_DIFFERENT)
  }

  // Whether a model can run now, read-only: nothing is installed, enabled or signed in, and no
  // model is called. An agent over ACP (Claude Code, Codex) is asked through acp-dsh's
  // `inspect` (a fresh `auth status` of that CLI only); its connection must be on, installed
  // and not signed out. A sign-in DSH cannot read (`signedIn` unknown, an older acp-dsh, a
  // failed check) does not refuse: the agent's own answer decides then, and a signed-out agent
  // fails its turn as MODEL_ACCESS_REQUIRED. Any other provider keeps the catalog's own marks
  // (a missing key shows in the picker) and is not refused here.
  // `{ ready: true }` or `{ ready: false, code, message }`; `code` is `bot/sign-in-required`
  // only when the CLI says it is signed out, the one case a sign-in answers, and
  // `bot/account-confirm-required` only when acp-dsh says the signed-in account waits for the
  // person's word (#869). An account that cannot be read, or an acp-dsh that says nothing of
  // consent, never refuses.
  async function modelAccess(ref) {
    const route = splitRef(ref)
    if (route === undefined || route.model === '') return { ready: false, code: 'bot/refused', message: 'Choose an available model.' }
    const { provider } = route
    if (routeOf(provider).connectedBy !== 'acp') return { ready: true, provider }
    const agents = ctx.get?.('acpAgents')
    if (typeof agents?.inspect !== 'function') return { ready: true, provider }
    let agent
    try {
      agent = await agents.inspect(provider)
    } catch (error) {
      rt.warn('ds-bot: the sign-in of %s could not be checked: %s', provider, error?.message ?? error)
      return { ready: true, provider }
    }
    if (agent === undefined) return { ready: true, provider }
    const connection = `${agent.name ?? provider} (${provider})`
    const denied = (template, code = 'bot/refused') => ({ ready: false, provider, code, template, message: template.replace('{connection}', connection) })
    if (agent.on === false) return denied(ACCESS_MESSAGES.off)
    if (agent.cli?.found === false || agent.connector?.state === 'installing' || agent.connector?.state === 'failed' || agent.connector?.state === 'no-cli') return denied(ACCESS_MESSAGES.installing)
    if (agent.signedIn === false) return denied(ACCESS_MESSAGES.signIn, 'bot/sign-in-required')
    if (noteConsent({ ...agent, id: provider })) catalogCache = { at: 0, value: [] }
    if (agent.signedIn === true && agent.consent === 'needed') return denied(ACCESS_MESSAGES.account, ACCOUNT_CONFIRM_REQUIRED)
    return { ready: true, provider }
  }

  async function assertModelAccess(ref) {
    const access = await modelAccess(ref)
    if (!access.ready) throw refusal(access.message, { code: access.code })
    return access
  }

  // A Bot with no model yet waits for the user to pick one and changes nothing. A
  // model that is no longer served falls back to the last one it ran on, then the default.
  // A Session at Full access of a Bot whose model is a coding CLI's (acp-claude, acp-codex) is
  // not moved to another provider this way: there the CLI itself runs without asking, and
  // another model would run DSH's own tools unasked at that level. The rule is read per
  // Session: `sessionId` (and `session`, when the caller holds it) names the one the model is
  // for, and without it every Session of the Bot's own counts. It answers undefined then, as
  // for a Bot that waits; another model of the same CLI is still taken. `aside`: a call
  // beside the chat that runs no tool (memory.js) keeps the plain rule.
  const stayed = new Set()
  function plainModelIn(bot, entries, captured) {
    if (entries.some(entry => entry.ref === bot.model)) return bot.model
    // A fallback is never one that needs a key.
    return entries.some(entry => entry.ref === bot.appliedModel && entry.needsKey !== true) ? bot.appliedModel : pickDefault(entries, configured, captured)
  }
  const plainModel = async (bot, noCommands) => {
    // Keep a Claude Code pin through a catalog outage so ACP can refuse it at dispatch.
    if (!noCommands && CLAUDE_PIN_REFS.has(bot.model)) return bot.model
    return plainModelIn(bot, await catalog({ noCommands }))
  }
  // A role task uses the same choice as desiredModel's aside route, from the
  // captured Bot and the catalog already read for the eligibility scan.
  const taskAskerState = bot => ({
    model: bot.model, appliedModel: bot.appliedModel,
    asideAllowed: Boolean(bot.model) && onDsh(bot) && !rt.switchingChat?.(bot.id),
    modelDefault: defaultRef(), providersSeen: JSON.stringify(providersSeen()),
  })
  const taskAskerModel = (captured, entries) => captured.asideAllowed ? plainModelIn(captured, entries, captured) : undefined
  // Whether going from the Bot's saved model to `ref` leaves its coding CLI.
  const offCli = (bot, ref) => ref !== undefined && ref !== bot.model && leavesCli(splitRef(bot.model), splitRef(ref))
  const stays = (bot, ref) => {
    const key = `${bot.id}:${bot.model}:${ref}`
    if (stayed.has(key)) return
    stayed.add(key)
    rt.warn?.('ds-bot: %s is not served now; %s stays on it where it has Full access, not moved to %s', bot.model, bot.name, ref)
  }
  // The Sessions among `ids` that read Full access now (permissions.js sessionWide).
  function wideAmong(ids) {
    if (typeof rt.sessionWide !== 'function') return new Set()
    let loaded = []
    try { loaded = ctx.sessions?.list?.() ?? [] } catch {}
    const open = new Map(loaded.map(session => [session?.id, session]))
    return new Set(ids.filter(id => typeof id === 'string' && rt.sessionWide(id, open.get(id)) === true))
  }
  const ownSessions = bot => [rt.chatOf?.(bot.id), ...(rt.groupSessionsOf?.(bot.id) ?? [])]
  async function desiredModel(bot, { aside = false, sessionId, session, noCommands = false } = {}) {
    if (!bot.model || !onDsh(bot)) return undefined
    // A Bot's own chat is moving to a new route: its old part must not be selected, but the
    // fresh part asks with its own Session (freshRoute) and may. A plain fresh-part switch
    // has no target and keeps the old behavior.
    if (sessionId === undefined && rt.switchingChat?.(bot.id)) return undefined
    const ref = await plainModel(bot, noCommands)
    if (aside || !offCli(bot, ref)) return ref
    const wide = sessionId !== undefined ? rt.sessionWide?.(sessionId, session) === true : wideAmong(ownSessions(bot)).size > 0
    if (!wide) return ref
    stays(bot, ref)
    return undefined
  }
  async function memoryModel(bot) {
    if (!bot?.model || !onDsh(bot) || rt.switchingChat?.(bot.id)) return undefined
    if (routeOf(splitRef(bot.model)?.provider).connectedBy === 'acp') return bot.model
    if (!answersAsideRef(bot.model)) return undefined
    const entries = await catalog({ noCommands: true })
    return entries.some(entry => entry.ref === bot.model && configured(entry)) ? bot.model : undefined
  }
  // Before a Session of the Bot takes a turn by itself (a task, a group seat, a fresh part, a
  // greeting): when the Bot's saved CLI model is not served, so the Session would run on
  // another provider's model, and the Session is at Full access, the start is refused.
  // `unselected`: the caller tried to select the Bot's model on the new Session and that
  // failed, so the Session is still on the model DSH made it with. Which one that is cannot
  // be told before its first request, so it is not taken for the Bot's CLI: refused too.
  // `owner`: whose Session it is when it is not on record yet (permissions.js sessionWide).
  const STAYS = 'This Bot has Full access on its coding CLI, which is not available now, so nothing was started on another model. Fix the CLI or sign in to it, or pick another model for the Bot yourself.'
  async function assertNotOffCli(bot, sessionId, session, { unselected = false, owner } = {}) {
    if (!bot?.model || !onDsh(bot) || !cliRoute(splitRef(bot.model).provider)) return
    if (rt.sessionWide?.(sessionId, session, owner) !== true) return
    if (unselected || offCli(bot, await plainModel(bot))) throw refusal(STAYS)
  }

  // The thinking level a Bot asked for, when the model it runs on serves it; else the
  // model's own default applies. A pinned pick with no cached reasoning metadata
  // lets DSH handle the saved effort without a plugin catalog lookup.
  async function desiredEffort(bot, ref, entry) {
    if (bot.effort === undefined || ref === undefined) return undefined
    const reasoning = entry === undefined ? await reasoningOf(ref)
      : entry.reasoning ?? reasoningCache.get(ref)?.value
    if (entry !== undefined && reasoning === undefined) return bot.effort
    const efforts = reasoning?.efforts ?? []
    if (efforts.some(effort => effort.id === bot.effort)) return bot.effort
    // A model may name the same level with another id, as resolveEffort already reads.
    const named = efforts.filter(effort => normalize(effort.name) === normalize(bot.effort))
    return named.length === 1 ? named[0].id : undefined
  }

  // A thinking level id, or a name only one level of the model has, like resolveModel.
  async function resolveEffort(ref, text) {
    const wanted = String(text ?? '').trim()
    if (wanted === '') return undefined
    const reasoning = await reasoningOf(ref)
    const efforts = reasoning?.efforts ?? []
    if (efforts.length === 0) throw refusal(`Model ${ref} has no thinking levels`)
    const key = normalize(wanted)
    const named = efforts.filter(effort => normalize(effort.id) === key || normalize(effort.name) === key)
    if (named.length === 1) return named[0].id
    throw refusal(`Thinking level ${wanted} is not available for ${ref}. Available: ${efforts.map(effort => effort.name).join(', ')}`)
  }

  // The profile default model's thinking level, when the model a Bot starts on
  // serves it. A level the model does not know is ignored, like an inherited
  // `bot.effort` — the model's own default applies instead.
  async function defaultEffort(ref) {
    const wanted = ctx.get?.('agentDefaultModel')?.currentSelection?.()?.reasoningEffort
    if (ref === undefined || wanted === undefined) return undefined
    return resolveEffort(ref, wanted).catch(() => undefined)
  }

  // DSH's selectModel also saves the selection as the profile default model, in the
  // background. A Bot's model is its own, so the user's default is written back after
  // it. Selections run one at a time and wait for the write-back: profile writes land in
  // submission order, so the next one reads the user's default, not a Bot's. A write-back
  // that fails while the default still reads as the user's lost nothing: inside DSH's
  // plugin reload every profile write is refused ("HMR transactions cannot be nested"),
  // DSH's own save of the selection included, so the default never moved.
  let selecting = Promise.resolve()
  // Recheck group Sessions after every restart: Bot-level applied fields cannot
  // prove that an older group Session received the member's thinking level.
  const sessionSelections = new Map()
  function selectSessionModel(sessionId, { provider, model, reasoningEffort }, pocket) {
    const release = rt.holdGrants?.({ sessionIds: [sessionId] }, () => {
      const selected = sessionSelections.get(sessionId)
        ?? readableRoute(ctx.sessions?.get?.(sessionId)?.requestHeader?.()?.config)
      return [selected?.provider, selected?.model]
    })
    const run = selecting.then(async () => {
      pocket?.check()
      rt.assertShellChoice?.(sessionId)
      const defaults = ctx.get?.('agentDefaultModel')
      const before = defaults?.currentSelection?.()
      const controller = ctx.sessionController
      const select = controller?.selectModel
      if (pocket !== undefined && typeof select !== 'function') throw new Error('Model selection is unavailable.')
      let result
      try {
        result = await select.call(controller, {
          sessionId, provider, model,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        })
      } catch (error) {
        if (pocket !== undefined) throw new SettingsSelectionRejected()
        throw error
      }
      pocket?.selected?.()
      const saved = result?.selected ?? { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
      if (before?.provider && before?.model && !sameSelection(before, saved)) {
        await defaults.saveSelection(before).catch((error) => {
          if (!sameSelection(defaults.currentSelection(), before)) rt.warn('ds-bot: the default model was not restored: %s', error)
        })
      }
      sessionSelections.set(sessionId, { provider, model, reasoningEffort })
      return result
    })
    selecting = run.catch(() => {})
    if (release) void run.then(() => release(false), () => release(true))
    return run
  }

  async function reselectOwnRoute(agent, check) {
    await rt.load()
    const sessionId = agent.session.id
    if (!rt.isBotSession(sessionId)) return false
    const bot = rt.botOf(rt.selfOf(sessionId))
    if (!bot?.model) return false
    const canSelect = () => modelTargetLive(bot) && !rt.hostOwned?.(bot)
      && !rt.pickingModel?.(bot.id) && !rt.switchingChat?.(bot.id)
    if (!canSelect()) return false
    const { model, effort: savedEffort } = bot
    const noCommands = rt.botRunnerRequired?.(sessionId, agent) === true
    const ref = await desiredModel(bot, { sessionId, session: agent.session, noCommands })
    if (ref === undefined || await keepsCarriedRoute(sessionId, ref)) return false
    // A group conversation whose history ran on another harness keeps its route: it follows
    // an agent switch only with a handoff of its own (RFC 0030, Handoff note).
    if (rt.groupOwners?.has?.(sessionId) && await rt.crossingHistory?.(sessionId, ref)) return false
    const effort = await desiredEffort(bot, ref)
    const route = { ...splitRef(ref), ...(effort === undefined ? {} : { reasoningEffort: effort }) }

    // The selection queue can already be waiting for this Agent's creation to finish.
    // Select on the Agent in hand without changing the profile's default model.
    if (!canSelect() || !rt.isBotSession(sessionId) || rt.selfOf(sessionId) !== bot.id
      || bot.model !== model || bot.effort !== savedEffort || !check(route)) return false
    try {
      rt.assertShellChoice?.(sessionId)
    } catch {
      return false
    }
    agent.model.select(route)
    sessionSelections.set(sessionId, route)
    return true
  }

  const sameSelection = (a, b) => a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort

  function storedRouteEvent(route, event) {
    if (event?.type === 'model/selection') return { ...route, pendingSelection: readableRoute(event.data) }
    if (event?.type !== 'request/header') return route
    const header = event.data?.header
    const used = readableRoute(header?.config)
    const selected = used && header?.adapterDefaults?.reasoningEffort === true ? { ...used, reasoningEffort: undefined } : used
    // History callers read the last request. Prompt delivery follows DSH's pending choice
    // until a request uses that choice.
    const pending = route.pendingSelection
    if (pending === undefined || (pending && selected && sameSelection(pending, selected))) return { used }
    return { used, pendingSelection: pending }
  }
  async function storedRoute(sessionId) {
    // undefined means the store confirms there is no log or the log has no events.
    // null means the route could not be read.
    // bots-dsh does not inject sessionPersistence: in real cordis a sibling plugin's
    // service throws on a property read but is readable through ctx.get.
    let handle
    try {
      const persistence = ctx.get?.('sessionPersistence')
      if (typeof persistence?.open !== 'function') return null
      handle = await persistence.open(sessionId, 'read')
      if (typeof handle?.read !== 'function') return null
      const { events } = await handle.read()
      if (!Array.isArray(events)) return null
      if (events.length === 0) return undefined
      const { used, pendingSelection } = events.reduce(storedRouteEvent, {})
      if (used === null || pendingSelection === null || (used === undefined && pendingSelection === undefined)) return null
      return pendingSelection === undefined ? used : { ...used, pendingSelection }
    } catch (error) {
      return error?.name === 'SessionPersistenceNotFoundError' && error.sessionId === sessionId ? undefined : null
    } finally {
      try { await handle?.close?.() } catch {}
    }
  }

  // THE RULE: a chat already on a Remote Hermes route never takes the in-place model
  // switch to the attach row, whatever came before. The attached serve answers on its
  // one row whatever ref the request names (remote-chat-adapter.js stream), so the
  // Session keeps its route and the exact-route guard accepts the turn. The decision is
  // the chat's ACTUAL route: the live Session's request header, or, for an unloaded
  // chat, the last request/header in its stored log. It is never the history of picks.
  // An unreadable route blocks a selection without confirming a carried Hermes chat.
  /** @returns {Promise<boolean | 'unreadable'>} */
  async function keepsCarriedRoute(sessionId, ref) {
    if (ref !== 'hermes-remote/attach') return false
    try {
      const header = ctx.sessions?.get?.(sessionId)?.requestHeader?.()
      const route = readableRoute(header?.config)
      if (header != null) return route ? route.provider === 'hermes-remote' : 'unreadable'
    } catch { return 'unreadable' }
    const stored = await storedRoute(sessionId)
    const route = readableRoute(stored)
    if (route) return route.provider === 'hermes-remote'
    // A valid selection before the first request confirms there is no carried route yet.
    return readableRoute(stored?.pendingSelection) ? false : 'unreadable'
  }

  const unreadableRouteMessage = bot => `${bot.name} could not switch because its current Session route could not be read.`
  async function assertReadableRoute(bot, ref) {
    if (await keepsCarriedRoute(rt.chatOf(bot.id), ref) === 'unreadable') throw refusal(unreadableRouteMessage(bot))
  }

  // The store can replace a Bot while a model choice is in flight.
  const modelTargetLive = bot => bot.shellHeld === undefined
    && (rt.botOf === undefined || rt.botOf(bot.id) === bot)

  // `force` re-selects even when the record says it is applied: the composer's own
  // model picker can move the Session without telling this plugin.
  function applyModel(bot, options) {
    return withGrantHold(rt, { botId: bot.id }, () => grantModelFields(bot), () => applyModelHeld(bot, options))
  }

  // Group Sessions already logged as keeping their route, so the warning comes once.
  const keptGroupRoutes = new Set()
  async function applyModelHeld(bot, { force = false, requireReadable = false, modelEntry, checkChoice, selected } = {}) {
    const pinned = modelEntry !== undefined
    const expectedChat = pinned ? rt.chatOf(bot.id) : undefined
    const live = () => modelTargetLive(bot) && !rt.switchingChat?.(bot.id)
    const check = () => {
      if (!live() || rt.hostOwned(bot) || rt.chatOf(bot.id) !== expectedChat) {
        throw new Error('The Bot changed during model selection.')
      }
      checkChoice()
    }
    const accept = () => { check(); selected?.() }
    if (pinned) check()
    if (!live()) return undefined
    // The Bot's own part is in a route switch: selecting the new model there would move the
    // old conversation, and restore() would then leave that Session on the target route. A
    // plain fresh part has no target and keeps taking the pick on the old part.
    const ref = pinned ? modelEntry.ref : await desiredModel(bot, { aside: true })
    if (ref === undefined) return ref
    // A move off the Bot's coding CLI skips each Session that is at Full access; the others
    // take the model as before. When every one stays, nothing moved and the record stands.
    const chat = rt.chatOf(bot.id)
    if (!modelTargetLive(bot)) return undefined
    const staying = offCli(bot, ref) ? wideAmong([chat, ...rt.groupSessionsOf(bot.id)]) : new Set()
    if (staying.size > 0) stays(bot, ref)
    if (staying.has(chat) && rt.groupSessionsOf(bot.id).every(sessionId => staying.has(sessionId))) return undefined
    const effort = await desiredEffort(bot, ref, modelEntry)
    const ownChanged = force || staying.size > 0 || bot.appliedModel !== ref || (bot.appliedEffort ?? undefined) !== effort
    const route = { ...splitRef(ref), ...(effort === undefined ? {} : { reasoningEffort: effort }) }
    const applyOwn = ownChanged && !staying.has(chat)
    const carried = applyOwn ? await keepsCarriedRoute(chat, ref) : false
    if (applyOwn) {
      if (carried === 'unreadable') {
        if (pinned) throw Object.assign(new SettingsSelectionRejected(unreadableRouteMessage(bot)), { code: 'bot/refused' })
        if (requireReadable) throw refusal(unreadableRouteMessage(bot))
      } else if (carried === true) {
        if (pinned) accept()
      } else {
        await selectSessionModel(chat, route, pinned ? { check, selected: accept } : undefined)
      }
    }
    for (const sessionId of rt.groupSessionsOf(bot.id)) {
      if (staying.has(sessionId)) continue
      const applied = sessionSelections.get(sessionId)
      if (!force && applied !== undefined && sameSelection(applied, route)) continue
      if (await keepsCarriedRoute(sessionId, ref)) continue
      // A group conversation with history on another harness is never moved across in place:
      // it keeps its route until it follows with a handoff of its own (RFC 0030, Handoff note).
      if (await rt.crossingHistory?.(sessionId, ref)) {
        if (!keptGroupRoutes.has(sessionId)) {
          keptGroupRoutes.add(sessionId)
          rt.warn('ds-bot: %s keeps its route in group Session %s: its history ran on another harness than %s', bot.name, sessionId, ref)
        }
        continue
      }
      keptGroupRoutes.delete(sessionId)
      await selectSessionModel(sessionId, route, pinned ? { check: () => {
        check()
        if (!rt.groupSessionsOf(bot.id).includes(sessionId)) throw new Error('The group Session changed.')
      } } : undefined)
        .catch(error => {
          if (pinned) rt.warn('pocket settings: group selection unavailable')
          else rt.warn('omni-ui: model for %s in a group not applied: %s', bot.name, error)
        })
    }
    // Some Sessions moved and some stayed, so no one model is applied to all of them. The
    // record, which is one per Bot, says what the Bot's own chat runs on: the model it just
    // took, or, when it is the chat that stayed, nothing unless the record already names that
    // model. A record left naming the CLI would skip the selection when the CLI is served
    // again, and the Sessions moved here would stay off it. Nothing is returned as applied.
    if (pinned) check()
    if (!modelTargetLive(bot) || carried === 'unreadable') return undefined
    if (staying.size > 0 && staying.has(chat)) {
      if (bot.appliedModel === undefined || bot.appliedModel === ref) return undefined
      delete bot.appliedModel
      delete bot.appliedEffort
      await rt.save()
      return undefined
    }
    if (!ownChanged) return ref
    bot.appliedModel = ref
    if (effort === undefined) delete bot.appliedEffort
    else bot.appliedEffort = effort
    await rt.save(pinned ? { required: true } : undefined)
    return staying.size > 0 ? undefined : ref
  }

  // A provider may register after the plugin starts; a greeting waits for its Bot's
  // model instead of failing with "no adapter registered".
  async function waitForModel(bot, ms = ROUTE_WAIT_MS) {
    const deadline = Date.now() + ms
    for (;;) {
      if (!bot.model || !onDsh(bot)) return undefined
      catalogCache = { at: 0, value: [] }
      const served = new Set((await catalog()).map(entry => entry.ref))
      if (served.has(bot.model) || Date.now() >= deadline) return desiredModel(bot)
      await new Promise((resolve) => {
        const timer = setTimeout(done, Math.min(2000, deadline - Date.now()))
        const off = ctx.on?.('llm/adapters-updated', done)
        function done() { clearTimeout(timer); off?.(); resolve() }
      })
    }
  }

  // Sequential, and again whenever the answerable models change (a refused route is
  // not one of them): a provider that registers late still gets its Bots' models selected.
  let syncedKey
  const syncModels = () => {
    const key = answerable(catalogCache.value).map(entry => entry.ref).join(',')
    if (key !== syncedKey) { syncedKey = key; modelsSynced = modelsSynced?.then(syncAll, syncAll) ?? syncAll() }
    return modelsSynced
  }
  async function syncAll() {
    for (const bot of Object.values(state.bots)) {
      await applyModel(bot).catch(error => rt.warn('omni-ui: model for %s not applied: %s', bot.name, error))
    }
  }

  // A route that refused a request for not being a model endpoint: it stays out of
  // the catalog from now on, the Bots pinned to it move to what they would be given
  // today, and each of them re-selects even when its record looks applied (`force`):
  // its Session may still be on the route, or on another Bot's route in a group.
  function routeRefused(ref, bot) {
    return withGrantHold(rt, { all: true }, () => grantTeamModels(rt),
      () => routeRefusedHeld(ref, bot))
  }

  async function routeRefusedHeld(ref, bot) {
    const served = await servedModels(ref)
    if (!refused.has(ref)) {
      refused.set(ref, served)
      rt.warn('omni-ui: %s is not a model endpoint, so it is not chosen again', ref)
      const entries = await catalog()
      const pinned = Object.values(state.bots).filter(other => other.shellHeld === undefined && (other.model === ref || other.appliedModel === ref))
      for (const other of pinned) {
        if (other.model === ref) other.model = pickDefault(entries)
        if (other.appliedModel === ref) delete other.appliedModel
      }
      await rt.save()
      for (const other of pinned) {
        if (other !== bot) await applyModel(other, { force: true }).catch(error => rt.warn('omni-ui: model for %s not applied: %s', other.name, error))
      }
    }
    if (bot !== undefined) await applyModel(bot, { force: true })
  }

  const lifetime = new AbortController()
  ctx.effect?.(() => () => lifetime.abort(), 'ds-bot: auxiliary llm retry')
  const assembleLlm = async (options, { check, dispatch } = {}) => {
    rt.assertBotRunnerProvider?.(options.provider, options.sessionId)
    return assembleLlmStream(ctx, options, { signal: lifetime.signal, backoff: rt.config?.llmRetryBackoff, check, dispatch })
  }

  Object.assign(rt, {
    assembleLlm,
    modelsEpoch: () => catalogEpoch,
    catalog, cachedCatalog, quietCatalog: run => quiet.run(rt, run), cachedDefault: () => pickDefault(catalogCache.value),
    defaultRef, defaultModel, defaultBotModel, defaultEffort, isUsable, resolveModel, checkSolverModel, modelAccess, assertModelAccess, desiredModel, taskAskerState, taskAskerModel, assertNotOffCli, reasoningOf, resolveEffort, desiredEffort,
    backgroundModel, cachedBackground: () => pickBackground(catalogCache.value), answersAside: answersAsideRef,
    memoryModel, memoryBackground, quotaUntil,
    quotaHeld: provider => quotaUntil(provider) !== undefined,
    noteAsideQuota: provider => asideQuota.set(provider, Date.now() + QUOTA_HOLD_MS),
    clearAsideQuota: provider => asideQuota.delete(provider),
    selectSessionModel, reselectOwnRoute, keepsCarriedRoute, assertReadableRoute, storedRouteOf: storedRoute,
    applyModel, waitForModel, syncModels, routeRefused,
    dropCatalog: () => {
      invalidate()
      catalogCache = { at: 0, value: [] }
    },
  })
}
