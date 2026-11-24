// Connect AI as switches: one row per AI, one way to reach each, and what this computer
// already has turned into rows that are on before anyone types anything.
//
//   ais                  every row: how it connects, whether it is set up and on, what was
//                        found on this computer, and the duplicates of it that are connected
//   ai-switch { id, on } turns a row that is set up on or off. Off stops using it and keeps
//                        its key, sign-in or account; a row that is not set up is refused,
//                        and the page opens its setup instead
//   ai-dedupe { id }     stops using the other ways a row's AI is connected (hides their
//                        models), keeping their accounts
//   ai-subscription { provider, on }
//                        a dsh-subscriptions vendor nothing else covers: off hides its models
//                        in that plugin's own picker settings, on shows them again; the
//                        account stays signed in either way
//
// One sign-in per vendor. Claude and ChatGPT sign in only through their own CLIs, Claude Code
// and Codex (acp-dsh's acp-claude and acp-codex, signed in from a Bot's chat): their rows are on
// when that agent can answer, and their switch is acp-dsh's own `claude` or `codex` setting,
// which every Bot on that agent shares. Claude also takes an Anthropic API key, on pi-ai's
// anthropic route, exactly as before. A pi-ai route still on DSH's own sign-in for them
// (openai-codex, or anthropic with no key named) is a duplicate of the CLI: turning the row on
// unsets that route and keeps its sign-in record (images still read openai-codex's), but only
// once no Bot runs on it. The Bot team (bots-dsh's `omniTeam`) first moves its Bots on that
// route to the CLI's (`moveSubscriptionBots`); a Bot still on it afterwards (or a team that
// cannot be read) keeps the route, listed as a duplicate, so no Bot is left on a provider that
// no longer exists.
// Antigravity is a third CLI row (acp-dsh's acp-antigravity, #2048), listed only when acp-dsh
// offers its sign-in in the app (`appSignIn`): it signs in in place, in the step itself, with
// the link, a Copy button and the field for the address the browser ends on (no Bot chat), and
// has no pi-ai route and no key. The sign-in link and the paste-back values stay in `acp`,
// behind the owner viewer: an `ais` row never carries them.
// Everything else connects through DSH's own sign-ins and keys; dsh-subscriptions keeps the
// vendors nothing else covers.
//
// Replies carry names and states only: never a key, a token or an account's credential.
import { z } from 'zod'
import { PI_AI, keyRefOf } from './providers.js'
import { acpService, agentRunning, agentView, setAgent } from './acp.js'

const RECORD_SCOPE = 'llm-pi-ai'
export const DEEPSEEK_REF = 'DEEPSEEK_API_KEY'
export const DEEPSEEK_ACCOUNT = 'deepseek-account-platform/default'
const SUBSCRIPTIONS = 'dsh-subscriptions'
const CLIPROXY_ROUTE = 'cliproxy'
const OLLAMA_ROUTE = 'ollama'
const OLLAMA_URL = 'http://127.0.0.1:11434'
// Ollama ignores the key; pi-ai's OpenAI route still sends one, so the route names this.
export const OLLAMA_KEY_REF = 'OMNI_AI_OLLAMA_API_KEY'
const OLLAMA_PROBE_MS = 800

// The rows, in the order "Add another" lists them. `envRefs` are the variables pi-ai reads
// for that provider, so a key already in the environment is found.
export const VENDORS = [
  { id: 'claude', name: 'Claude', via: 'Your Claude Pro or Max plan through Claude Code, or an Anthropic API key', kind: 'signin', cli: 'acp-claude', provider: 'anthropic', envRefs: ['ANTHROPIC_API_KEY'], keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'chatgpt', name: 'ChatGPT', via: 'Your ChatGPT Plus or Pro plan, through Codex', kind: 'signin', cli: 'acp-codex', provider: 'openai-codex' },
  { id: 'antigravity', name: 'Antigravity', via: 'Your Google account, through Antigravity', kind: 'signin', cli: 'acp-antigravity', appOnly: true },
  { id: 'deepseek', name: 'DeepSeek', via: 'With your API key, or your DeepSeek account', kind: 'key', provider: 'deepseek', ref: DEEPSEEK_REF, route: false, keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'kimi', name: 'Kimi', via: 'Your Kimi Code plan', kind: 'signin', provider: 'kimi-coding' },
  { id: 'copilot', name: 'GitHub Copilot', via: 'Your Copilot plan', kind: 'signin', provider: 'github-copilot' },
  { id: 'grok', name: 'Grok', via: 'SuperGrok or X Premium, or an xAI key', kind: 'signin', provider: 'xai', envRefs: ['XAI_API_KEY'], keyUrl: 'https://console.x.ai' },
  { id: 'openai', name: 'OpenAI API', via: 'With an API key, billed per use', kind: 'key', provider: 'openai', envRefs: ['OPENAI_API_KEY'], keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'openrouter', name: 'OpenRouter', via: 'One key, hundreds of models', kind: 'key', provider: 'openrouter', envRefs: ['OPENROUTER_API_KEY'], keyUrl: 'https://openrouter.ai/keys' },
  { id: 'zai', name: 'Z.ai', via: 'GLM models, with an API key', kind: 'key', provider: 'zai', envRefs: ['ZAI_API_KEY'], keyUrl: 'https://z.ai/manage-apikey/apikey-list' },
  { id: 'moonshot', name: 'Moonshot', via: 'Kimi models, with an API key', kind: 'key', provider: 'moonshotai', envRefs: ['MOONSHOT_API_KEY'], keyUrl: 'https://platform.moonshot.ai/console/api-keys' },
  { id: 'opencode', name: 'OpenCode', via: 'An OpenCode Zen key', kind: 'key', provider: 'opencode', envRefs: ['OPENCODE_API_KEY'], keyUrl: 'https://opencode.ai/zen' },
  { id: 'cliproxy', name: 'CLIProxyAPI', via: 'Your own gateway', kind: 'gateway' },
  { id: 'ollama', name: 'Ollama', via: 'Models running on this computer', kind: 'local' },
]

// dsh-subscriptions' vendors that another row covers (Omni never offers them), and the row.
// Its claude and codex are gone: dsh-subscriptions no longer ships them (0.7.21-omni.1 lists
// none), and Claude and ChatGPT are their CLIs now.
export const COVERED = { kimi: 'kimi', copilot: 'copilot', grok: 'grok', ollama: 'ollama' }
// The dsh-subscriptions vendors Omni offers: nothing else reaches them.
export const SUBSCRIPTION_ONLY = ['antigravity', 'glm', 'cursor', 'kiro', 'qwen', 'ernie', 'spark', 'jetbrains', 'perplexity', 'replit', 'cody']

const Switch = z.object({ id: z.string().max(40), on: z.boolean() }).strict()
const RowId = z.object({ id: z.string().max(40) }).strict()
const SubscriptionSwitch = z.object({ provider: z.enum(SUBSCRIPTION_ONLY), on: z.boolean() }).strict()

const failure = (code, message) => Object.assign(new Error(message), { code })
// `ais` needs no viewer: the sign-in link and the paste-back values stay in `acp` (owner viewer only).
const SIGN_IN_ONLY = ['signInUrl', 'signInAttempt', 'signInPaste', 'signInChecking', 'signInExpiresAt', 'signInEnd']
const cliOf = (agent) => {
  const view = { ...agentView(agent) }
  for (const key of SIGN_IN_ONLY) delete view[key]
  return view
}
const invalid = message => failure('omni-ai/invalid', message)
const refused = message => failure('omni-ai/refused', message)

const recordKeyOf = provider => `${RECORD_SCOPE}/${provider}`
const oauthRef = (provider, index) => `${String(provider).toUpperCase()}_OAUTH_${index}`

const quietly = async (read, fallback) => {
  try {
    return (await read()) ?? fallback
  } catch {
    return fallback
  }
}
const quietlySync = (read) => {
  try {
    return read()
  } catch {
    return undefined
  }
}
const describeAll = (ctx) => {
  try {
    return ctx.settings.describe()
  } catch {
    return []
  }
}
const entryOf = (ctx, ns) => describeAll(ctx).find(row => row.ns === ns)
const routesOf = ctx => entryOf(ctx, PI_AI)?.value?.providers ?? {}
const service = (ctx, name) => {
  try {
    return ctx.get?.(name) ?? undefined
  } catch {
    return undefined
  }
}

// Where a key for this row lives: DSH's store ("file"), the environment, or nowhere.
async function keyOf(ctx, vendor) {
  for (const ref of [vendor.ref ?? keyRefOf(vendor.provider), ...(vendor.envRefs ?? [])]) {
    const found = await quietly(() => ctx.credentials.describe(ref), {})
    if (found?.configured === true) return { ref, source: found.source === 'file' ? 'file' : 'env' }
  }
  return null
}

// dsh-subscriptions' accounts: its slots, each signed in when its credential exists.
async function subscriptionAccounts(ctx) {
  const entry = entryOf(ctx, SUBSCRIPTIONS)
  if (entry === undefined) return null
  const slots = Array.isArray(entry.value?.slots) ? entry.value.slots : []
  const accounts = []
  for (const slot of slots) {
    if (typeof slot?.provider !== 'string' || !Number.isInteger(Number(slot.index)) || Number(slot.index) < 1) continue
    const signedIn = (await quietly(() => ctx.credentials.describe(oauthRef(slot.provider, slot.index)), {}))?.configured === true
    if (signedIn) accounts.push({ provider: slot.provider, index: Number(slot.index) })
  }
  return { accounts, hidden: Array.isArray(entry.value?.hiddenModels) ? entry.value.hiddenModels : [], revision: entry.revision }
}

async function ollamaRunning(fetchImpl) {
  try {
    const response = await fetchImpl(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(OLLAMA_PROBE_MS), redirect: 'error' })
    return response.ok
  } catch {
    return false
  }
}

export function createAiActions(ctx, { fetch: fetchImpl = globalThis.fetch, saveRoute, unsetRoute } = {}) {
  const llm = () => service(ctx, 'llm')
  const authorization = () => service(ctx, 'authorization')

  // One row's state, from what DSH and this computer have.
  async function rowFor(vendor, seen) {
    const routes = seen.routes
    const base = { id: vendor.id, name: vendor.name, via: vendor.via, kind: vendor.kind }
    if (vendor.kind === 'key') {
      const key = await keyOf(ctx, vendor)
      const account = vendor.id === 'deepseek' && (await quietly(() => ctx.credentials.describeRecord(DEEPSEEK_ACCOUNT), {}))?.configured === true
      const routed = vendor.route === false || Object.hasOwn(routes, vendor.provider)
      const ready = key !== null || account
      const found = account ? 'Signed in to DeepSeek' : key?.source === 'env' ? `${key.ref} found` : key ? 'Key saved' : null
      // A route on the provider's own sign-in (no key named) is a sign-in, not this row's key.
      const keyed = vendor.route === false || routes[vendor.provider]?.apiKeyEnv !== undefined || (key?.source === 'env' && routed)
      return { ...base, ready, on: ready && routed && (keyed || account), found, keyUrl: vendor.keyUrl }
    }
    if (vendor.cli) return cliRowFor(vendor, seen, base)
    if (vendor.kind === 'signin') {
      const signedIn = (await quietly(() => ctx.credentials.describeRecord(recordKeyOf(vendor.provider)), {}))?.configured === true
      const key = vendor.envRefs ? await keyOf(ctx, vendor) : null
      const flow = authorization()?.describe?.(recordKeyOf(vendor.provider)) !== undefined
      const ready = signedIn || key !== null
      const found = signedIn ? `Signed in to ${vendor.name}` : key?.source === 'env' ? `${key.ref} found` : key ? 'Key saved' : null
      // A route that names a key runs on that key; one that names none, on the sign-in.
      const route = routes[vendor.provider]
      const runs = route?.apiKeyEnv !== undefined ? key !== null : ready
      return { ...base, ready, on: Object.hasOwn(routes, vendor.provider) && runs, found, signIn: flow, ...(vendor.keyUrl ? { keyUrl: vendor.keyUrl } : {}) }
    }
    if (vendor.kind === 'gateway') {
      const routed = Object.hasOwn(routes, CLIPROXY_ROUTE)
      return { ...base, ready: routed, on: routed, found: routed ? 'Gateway saved' : null }
    }
    // Ollama: a pi-ai OpenAI-compatible route at the local server.
    const routed = Object.hasOwn(routes, OLLAMA_ROUTE)
    const running = seen.ollama
    return { ...base, ready: running, on: routed, found: running ? 'Running on this computer' : null, ...(routed && !running ? { needs: 'start' } : {}) }
  }

  // Claude or ChatGPT: the CLI's sign-in (acp-dsh's agent), or for Claude an Anthropic API key
  // on pi-ai's anthropic route. On when the agent can answer, or when the key's route runs.
  async function cliRowFor(vendor, seen, base) {
    const agent = seen.agents?.find(row => row?.id === vendor.cli)
    // A CLI signed in to an account the person has not confirmed is not a connection yet (#869).
    const cliSignedIn = agent?.cli?.found === true && agent.signedIn === true && agent.consent !== 'needed'
    const key = vendor.envRefs ? await keyOf(ctx, vendor) : null
    const legacy = legacyRoute(vendor, seen)
    const route = seen.routes[vendor.provider]
    // A key's route: one that names the key, or (no DSH sign-in under it) one pi-ai reads an
    // environment key for.
    const keyOn = key !== null && route !== undefined && !legacy && (route.apiKeyEnv !== undefined || key.source === 'env')
    const ready = cliSignedIn || key !== null
    const found = cliSignedIn ? `Signed in to ${agent.name}` : key?.source === 'env' ? `${key.ref} found` : key ? 'Key saved' : null
    return {
      ...base,
      ready,
      on: agentRunning(agent) || keyOn,
      found,
      signIn: agent !== undefined,
      ...(agent ? { cli: cliOf(agent) } : {}),
      ...(vendor.keyUrl ? { keyUrl: vendor.keyUrl } : {}),
    }
  }

  async function look() {
    const [subscriptions, ollama, agents] = await Promise.all([
      subscriptionAccounts(ctx),
      ollamaRunning(fetchImpl),
      quietly(async () => (await acpService(ctx)?.status())?.agents, undefined),
    ])
    const routes = routesOf(ctx)
    const anthropic = routes.anthropic
    const anthropicSignIn = anthropic !== undefined && anthropic.apiKeyEnv === undefined && await claudePlanRoute()
    return { routes, subscriptions, ollama, agents: Array.isArray(agents) ? agents : undefined, anthropicSignIn }
  }

  // Whether pi-ai's anthropic route (no key named) runs on DSH's own Claude Pro/Max sign-in: the
  // one rule the Bot team moves Bots and builds its model menu by (bots-dsh subscription-move.js
  // runsOnSignIn), asked of it when it is here. Without it, the same rule: the stored record is
  // a sign-in grant (a pasted key is stored as a record too, of kind `api-key`) and no
  // ANTHROPIC_API_KEY is found for pi-ai to read instead. Only descriptions, never a value.
  async function claudePlanRoute() {
    const team = service(ctx, 'omniTeam')
    if (typeof team?.anthropicSubscription === 'function') {
      const answer = await quietly(() => team.anthropicSubscription(), undefined)
      if (typeof answer === 'boolean') return answer
    }
    const record = await quietly(() => ctx.credentials.describeRecord(recordKeyOf('anthropic')), {})
    if (record?.configured !== true || record.kind !== 'grant') return false
    return await keyOf(ctx, VENDORS.find(vendor => vendor.provider === 'anthropic')) === null
  }

  // The pi-ai route a CLI row's AI still has on DSH's own sign-in, if any: openai-codex's
  // route, or anthropic's when it names no key. Never a route that names a key.
  function legacyRoute(vendor, seen) {
    if (!vendor.cli || vendor.provider === undefined) return null
    const route = seen.routes[vendor.provider]
    if (route === undefined || route.apiKeyEnv !== undefined) return null
    if (vendor.provider === 'anthropic' && !seen.anthropicSignIn) return null
    return vendor.provider
  }

  // The other ways a row's AI is connected right now, and whether their models still show.
  function duplicatesOf(row, seen) {
    const out = []
    const vendor = VENDORS.find(item => item.id === row.id)
    const legacy = vendor ? legacyRoute(vendor, seen) : null
    if (legacy) out.push({ via: 'DSH sign-in', provider: legacy, hidden: false })
    const subs = seen.subscriptions
    for (const [vendor, rowId] of Object.entries(COVERED)) {
      if (rowId !== row.id || !subs) continue
      if (!subs.accounts.some(account => account.provider === vendor)) continue
      out.push({ via: 'dsh-subscriptions', provider: vendor, hidden: subs.hidden.some(model => model?.provider === vendor) })
    }
    return out
  }

  async function rows() {
    const seen = await look()
    const out = []
    for (const vendor of VENDORS) {
      // A row the app signs in to only in place: listed when acp-dsh offers that sign-in.
      if (vendor.appOnly && seen.agents?.find(agent => agent?.id === vendor.cli)?.appSignIn !== true) continue
      const row = await rowFor(vendor, seen)
      const duplicates = duplicatesOf(row, seen)
      out.push(duplicates.length ? { ...row, duplicates } : row)
    }
    return { rows: out, seen }
  }

  // Whether anything still runs on `provider` once the Bot team has moved its subscription Bots
  // to their CLI: a Bot (its model, the model a pending switch goes back to), the jobs beside
  // the chats (memory review, notes, steward, checkpoint: the team's pick, else the model the
  // team resolves for them, which falls back to DSH's default; D-g leaves them as they are), or
  // DSH's own default model. A team that cannot be read counts as one still on it.
  async function teamStillOn(provider) {
    const on = ref => typeof ref === 'string' && ref.startsWith(`${provider}/`)
    const selection = quietlySync(() => service(ctx, 'agentDefaultModel')?.currentSelection?.())
    if (typeof selection?.provider === 'string' && selection.provider === provider) return true
    const team = service(ctx, 'omniTeam')
    if (team === undefined) return false
    try {
      if (typeof team.moveSubscriptionBots === 'function') await team.moveSubscriptionBots()
      else await team.load?.()
      const bots = Object.values(team.state?.bots ?? {})
      if (bots.some(bot => on(bot?.model) || on(bot?.previousModel)) || on(team.state?.prefs?.backgroundModel)) return true
      return typeof team.backgroundModel === 'function' && on(await team.backgroundModel())
    } catch (error) {
      ctx.logger?.warn?.('omni-ai: the Bots on %s were not checked: %s', provider, error?.message ?? error)
      return true
    }
  }

  // Hides the models of the other ways this row's AI is connected; their accounts stay.
  async function dedupe(rowId, seen) {
    const done = []
    // A CLI row that is on stops the pi-ai route on DSH's own sign-in: the route only, never
    // its record, never a route that names a key, and never while a Bot still runs on it.
    const vendor = VENDORS.find(item => item.id === rowId)
    const legacy = vendor ? legacyRoute(vendor, seen) : null
    if (legacy && (await rowFor(vendor, seen)).on && !(await teamStillOn(legacy))) {
      await unsetRoute(legacy)
      done.push(legacy)
    }
    const subs = seen.subscriptions
    const vendors = Object.entries(COVERED).filter(([, id]) => id === rowId).map(([vendor]) => vendor)
    if (subs && vendors.some(vendor => subs.accounts.some(account => account.provider === vendor))) {
      const hidden = [...subs.hidden]
      for (const vendor of vendors) {
        if (!subs.accounts.some(account => account.provider === vendor)) continue
        const models = await quietly(() => llm()?.listModels?.(vendor), [])
        for (const model of models) {
          if (typeof model?.id === 'string' && !hidden.some(row => row?.provider === vendor && row?.id === model.id)) hidden.push({ provider: vendor, id: model.id })
        }
        done.push(vendor)
      }
      await ctx.settings.update(SUBSCRIPTIONS, { hiddenModels: hidden }, subs.revision)
    }
    return done
  }

  async function turn(vendor, on, seen) {
    if (vendor.cli) return turnCli(vendor, on, seen)
    if (vendor.kind === 'key') {
      if (vendor.route === false) {
        if (!on) throw refused('DeepSeek is DSH\'s own route. Remove its key in Settings → Models to stop using it.')
        return
      }
      if (!on) return unsetRoute(vendor.provider)
      const key = await keyOf(ctx, vendor)
      return saveRoute(vendor.provider, { apiKeyEnv: key.ref })
    }
    if (vendor.kind === 'signin') {
      if (!on) return unsetRoute(vendor.provider)
      const signedIn = (await quietly(() => ctx.credentials.describeRecord(recordKeyOf(vendor.provider)), {}))?.configured === true
      // A sign-in sits beneath a key: a route that names no key uses the sign-in. A route left
      // on a key that is gone moves to the sign-in, keeping the rest of what it holds.
      if (signedIn) {
        const { apiKeyEnv, ...rest } = seen.routes[vendor.provider] ?? {}
        if (apiKeyEnv !== undefined && await keyOf(ctx, vendor) !== null) return
        if (apiKeyEnv !== undefined) await unsetRoute(vendor.provider)
        return saveRoute(vendor.provider, rest)
      }
      const key = await keyOf(ctx, vendor)
      return saveRoute(vendor.provider, { apiKeyEnv: key.ref })
    }
    if (vendor.kind === 'gateway') {
      if (on) return
      return unsetRoute(CLIPROXY_ROUTE)
    }
    if (!on) return unsetRoute(OLLAMA_ROUTE)
    return turnOnOllama()
  }

  // On: the signed-in CLI's switch, and the Anthropic key's route as before whenever a key is
  // there (key-based Bots never move, D-c), so off and on again brings back what off stopped.
  // Off: the CLI's switch (for every Bot on it) and the pi-ai route, keeping the key and any
  // sign-in.
  async function turnCli(vendor, on, seen) {
    const agent = seen.agents?.find(row => row?.id === vendor.cli)
    if (!on) {
      if (agent?.on === true) await setAgent(ctx, vendor.cli, false)
      if (vendor.provider !== undefined && Object.hasOwn(seen.routes, vendor.provider)) await unsetRoute(vendor.provider)
      return
    }
    const key = vendor.envRefs ? await keyOf(ctx, vendor) : null
    const keyRoute = async () => {
      // A route already there is left as it is: one that names this key, or one on DSH's sign-in
      // (a duplicate the dedupe handles).
      if (key === null || Object.hasOwn(seen.routes, vendor.provider)) return
      await saveRoute(vendor.provider, { apiKeyEnv: key.ref })
    }
    if (agent?.cli?.found === true && agent.signedIn === true) {
      const acp = agent.on === true ? acpService(ctx) : await setAgent(ctx, vendor.cli, true)
      await keyRoute()
      // Its connector and sign-in looked at again, so the row says where it stands.
      await quietly(() => acp?.refresh?.(), undefined)
      return
    }
    // A row with no key (Antigravity: no route either) is set up only by its sign-in.
    if (key === null || vendor.provider === undefined) throw refused(`${vendor.name} is not set up yet.`)
    if (seen.routes[vendor.provider]?.apiKeyEnv === key.ref) return
    return saveRoute(vendor.provider, { apiKeyEnv: key.ref })
  }

  async function turnOnOllama() {
    let models = []
    try {
      const response = await fetchImpl(`${OLLAMA_URL}/v1/models`, { signal: AbortSignal.timeout(5000), redirect: 'error' })
      const body = await response.json()
      models = (Array.isArray(body?.data) ? body.data : []).map(item => item?.id).filter(id => typeof id === 'string' && id.length > 0 && id.length <= 200).slice(0, 200)
    } catch {
      throw refused('Ollama is not answering on this computer. Start it, then turn this on again.')
    }
    if (models.length === 0) throw refused('Ollama has no models yet. Pull one (ollama pull <model>), then turn this on again.')
    await ctx.credentials.set(OLLAMA_KEY_REF, 'ollama')
    await saveRoute(OLLAMA_ROUTE, { displayName: 'Ollama', api: 'openai-completions', baseURL: `${OLLAMA_URL}/v1`, apiKeyEnv: OLLAMA_KEY_REF, models: models.map(id => ({ id, name: id })) })
  }

  const vendorOf = (id) => {
    const vendor = VENDORS.find(row => row.id === id)
    if (!vendor) throw invalid(`No AI "${String(id).slice(0, 40)}" here`)
    return vendor
  }

  // A subscription vendor's models hidden in, or shown again by, dsh-subscriptions' own settings.
  async function setSubscriptionHidden(provider, hide) {
    const subs = await subscriptionAccounts(ctx)
    if (subs === null) throw refused('dsh-subscriptions is not installed in this DSH.')
    let hidden = subs.hidden.filter(row => row?.provider !== provider)
    if (hide) {
      const models = await quietly(() => llm()?.listModels?.(provider), [])
      const ids = models.map(model => model?.id).filter(id => typeof id === 'string')
      if (ids.length === 0) throw refused('Its models are not listed right now, so there is nothing to hide. Try again in a moment.')
      hidden = [...hidden, ...ids.map(id => ({ provider, id }))]
    }
    await ctx.settings.update(SUBSCRIPTIONS, { hiddenModels: hidden }, subs.revision)
  }

  const subscriptionView = (subs) => {
    if (subs === null) return null
    const providers = [...new Set(subs.accounts.map(account => account.provider))].filter(provider => SUBSCRIPTION_ONLY.includes(provider))
    return {
      accounts: subs.accounts.filter(account => SUBSCRIPTION_ONLY.includes(account.provider)),
      hidden: providers.filter(provider => subs.hidden.some(row => row?.provider === provider)),
    }
  }

  return {
    async ais() {
      const { rows: out, seen } = await rows()
      return { rows: out, subscriptions: subscriptionView(seen.subscriptions) }
    },

    async 'ai-subscription'(payload) {
      const parsed = SubscriptionSwitch.safeParse(payload)
      if (!parsed.success) throw invalid('Say which subscription to turn on or off.')
      const { provider, on } = parsed.data
      const subs = await subscriptionAccounts(ctx)
      if (on && !subs?.accounts.some(account => account.provider === provider)) throw refused('Sign in to it first.')
      await setSubscriptionHidden(provider, !on)
      return { subscriptions: subscriptionView(await subscriptionAccounts(ctx)) }
    },

    async 'ai-switch'(payload) {
      const parsed = Switch.safeParse(payload)
      if (!parsed.success) throw invalid('Say which AI to turn on or off.')
      const vendor = vendorOf(parsed.data.id)
      const seen = await look()
      const row = await rowFor(vendor, seen)
      if (parsed.data.on && !row.ready) throw refused(`${vendor.name} is not set up yet.`)
      await turn(vendor, parsed.data.on, seen)
      // Turning an AI on stops the duplicates of it Omni does not offer, as things stand now.
      if (parsed.data.on) await look().then(now => dedupe(vendor.id, now)).catch(error => ctx.logger?.warn?.('omni-ai: duplicates of %s stay: %s', vendor.id, error?.message ?? error))
      const after = await look()
      const next = await rowFor(vendor, after)
      const duplicates = duplicatesOf(next, after)
      return duplicates.length ? { ...next, duplicates } : next
    },

    async 'ai-dedupe'(payload) {
      const parsed = RowId.safeParse(payload)
      if (!parsed.success) throw invalid('Say which AI.')
      vendorOf(parsed.data.id)
      return { hidden: await dedupe(parsed.data.id, await look()) }
    },

    // Whether an AI is really on, for the step's done state and its speech.
    async anyOn() {
      const { rows: out, seen } = await rows()
      const subs = subscriptionView(seen.subscriptions)
      return out.some(row => row.on) || (subs?.accounts.some(account => !subs.hidden.includes(account.provider)) ?? false)
    },
  }
}

