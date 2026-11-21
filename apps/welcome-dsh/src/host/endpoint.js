import { CliproxyPayload, DonePayload, MigrateOmniPayload, MigrateStartPayload, MigrateStatusPayload, OmniGithubAckPayload, OmniGithubCancelPayload, OmniGithubInstallPayload, OmniGithubStatusPayload, OmniServerPayload, RequestBody, Secret, parse } from './payloads.js'
import { createMigrateActions } from './hermes-migrate.js'
import { createAiActions } from './ais.js'
import { createProviderActions, saveRoute, unsetRoute } from './providers.js'
import { createCompanionActions } from './companion.js'
import { createBotTypeActions } from './bot-types.js'
import { createOmniServerCheck } from './release-resolve.js'
import { createOmniInstaller, omniInstallAvailable } from './omni-github.js'
import { createOmniTerminalGuard } from './omni-terminal-guard.js'
import { createAcpActions } from './acp.js'
import { hostOf, machineOf } from './host.js'
import { preloadOf } from './preload.js'
import { UNFOLD_BOT } from './companion.js'
import { needsViewer } from './viewer-policy.js'

// The host endpoint the onboarding steps call: POST /api/omni-ai with
// { endpoint, payload }, answered { ok: true, value } or { ok: false, error }.
//
//   state              the done flags, whether an AI is already connected, the product
//                      the desktop app was opened for (preload, src/host/preload.js) and the
//                      host kind, when there is one (host, src/host/host.js), and the machine
//                      DSH runs on: its OS family and whether it was launched over SSH
//                      (machine, src/host/host.js; never its hostname)
//   done { stepId, connected? }
//                      keeps a step finished, in this plugin's own settings entry; Connect
//                      AI finished with an AI on (`connected`) gives the companion, the Omni
//                      Bot and the Genie Bot their model (companion.js assignModels)
//   cliproxy { baseURL, apiKey }
//                      lists the gateway's models with the key, stores the key in DSH's
//                      credential store and writes a pi-ai route that references it
//   providers, provider-key, signin-*
//                      the rows' own connections (src/host/providers.js)
//   ais, ai-switch, ai-dedupe
//                      the rows themselves: what is found, set up and on (src/host/ais.js)
//   companion, companion-generate, companion-save, companion-image, team-save
//                      the person's own companion and team (src/host/companion.js)
//   omni-plugins, omni-plugins-install, genie-plugin, genie-plugin-install,
//   unfold-plugin, unfold-plugin-install, bot-type
//                      the Omni plugins, Genie's and Unfold's, installed through DSH's plugin
//                      manager, and what a Bot type starts with (src/host/bot-types.js)
//   omni-server-check { version, fallback? }, omni-github-install, omni-github-status,
//   omni-github-cancel, omni-github-ack
//                      the route to install Omni and the welcome's installer job
//   acp, acp-switch, acp-retry
//                      Claude Code and Codex through @automagik/acp-dsh: its acpAgents
//                      service's status, and its claude/codex settings (src/host/acp.js)
//   migrate-probe, migrate-start, migrate-status, migrate-omni-status, migrate-restore-hermes
//                      the "From another tool" step: Hermes's Telegram channel and its key,
//                      and the way back to Hermes after an unknown Omni result
//                      (src/host/hermes-migrate.js). The key never enters an answer.
//
// The key never enters settings, a reply or a log line: the route names it by the
// env-shaped reference OMNI_AI_CLIPROXY_API_KEY, which DSH resolves per request.

export const ROUTE = '/api/omni-ai'
export const ENTRY = 'omni-ai'
export const PI_AI = 'llm-pi-ai'
export const ROUTE_ID = 'cliproxy'
export const KEY_REF = 'OMNI_AI_CLIPROXY_API_KEY'
// Which flag keeps each step finished. omni-connect is the Omni plugin's step; its skip
// is kept here so a skipped connect stays skipped.
export const FLAGS = { 'omni-companion': 'companionDone', 'omni-team': 'teamDone', 'omni-welcome': 'welcomeDone', 'omni-migrate': 'migrateDone', 'omni-connect-ai': 'connectAiDone', 'omni-connect': 'connectOmniSkipped' }
// Where DSH keeps a DeepSeek API key, and a DeepSeek account sign-in.
const DEEPSEEK_REF = 'DEEPSEEK_API_KEY'
const DEEPSEEK_ACCOUNT = 'deepseek-account-platform/default'
const TIMEOUT_MS = 15_000
// How long finishing Connect AI waits for the companions' model, and how long that keeps
// being tried for a provider that registers late.
const ASSIGN_HOLD_MS = 5_000
const ASSIGN_WAIT_MS = 30_000
const MAX_MODELS = 500
const MAX_ID = 200
// A model listing is small; a gateway that sends more is not read past this.
const MAX_BODY = 2 * 1024 * 1024

const failure = (code, message) => Object.assign(new Error(message), { code })
const invalid = message => failure('omni-ai/invalid', message)
const refused = message => failure('omni-ai/refused', message)

// A gateway base URL: http(s) only, no credentials, query or fragment, no trailing
// slash. A bare origin gets /v1, where CLIProxyAPI serves its OpenAI-compatible API.
export function cleanBaseUrl(text) {
  const value = typeof text === 'string' ? text.trim() : ''
  if (!/^https?:\/\//i.test(value)) return null
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.username || url.password || url.search || url.hash) return null
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${path === '' ? '/v1' : path}`
}

// Model ids from an OpenAI-style listing ({ data: [{ id }] }), unique, in its order.
export function modelIdsOf(body) {
  const ids = []
  for (const item of Array.isArray(body?.data) ? body.data : []) {
    const id = typeof item?.id === 'string' ? item.id.trim() : ''
    if (id !== '' && id.length <= MAX_ID && !ids.includes(id)) ids.push(id)
    if (ids.length === MAX_MODELS) break
  }
  return ids
}

// The body as text, refused past MAX_BODY without reading the rest.
async function cappedText(response) {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => {})
      throw new Error('too large')
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

async function listModels(fetchImpl, baseURL, apiKey, signal) {
  const signals = [AbortSignal.timeout(TIMEOUT_MS), ...(signal ? [signal] : [])]
  let response
  try {
    // No redirects: the key is for this address only.
    response = await fetchImpl(`${baseURL}/models`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.any(signals),
    })
  } catch {
    throw refused(`Could not reach ${baseURL}/models. Check the address and that the gateway is running.`)
  }
  if (response.status === 401 || response.status === 403) throw refused(`The gateway at ${baseURL} refused this key (HTTP ${response.status}).`)
  if (!response.ok) throw refused(`The gateway at ${baseURL} answered HTTP ${response.status} for /models.`)
  try {
    return modelIdsOf(JSON.parse(await cappedText(response)))
  } catch {
    throw refused(`The gateway at ${baseURL} did not answer /models with a JSON model list.`)
  }
}

const describeAll = (ctx) => {
  try {
    return ctx.settings.describe()
  } catch {
    return []
  }
}
const entryOf = (rows, ns) => rows.find(row => row.ns === ns)
const isConfigured = async (read) => {
  try {
    return (await read())?.configured === true
  } catch {
    return false
  }
}

export function createActions(ctx, { fetch: fetchImpl = globalThis.fetch, anyOn, env = process.env, platform = process.platform } = {}) {
  return {
    async state() {
      const rows = describeAll(ctx)
      const own = entryOf(rows, ENTRY)?.value ?? {}
      const providers = entryOf(rows, PI_AI)?.value?.providers
      const piAiRoutes = providers && typeof providers === 'object' ? Object.keys(providers) : []
      const deepseek = await isConfigured(() => ctx.credentials.describe(DEEPSEEK_REF)) || await isConfigured(() => ctx.credentials.describeRecord(DEEPSEEK_ACCOUNT))
      const host = hostOf(env)
      // In Unfold's instance, Unfold is the Main Bot its plugin made: no companion to make, its
      // card comes first, and Omni joins only when the person powers it on.
      const unfold = host === 'unfold'
      const preload = unfold ? 'unfold' : preloadOf(env)
      return {
        companionDone: unfold || own.companionDone === true,
        teamDone: own.teamDone === true,
        welcomeDone: own.welcomeDone === true,
        companionName: unfold ? UNFOLD_BOT.name : typeof own.companionName === 'string' ? own.companionName : undefined,
        companionShape: typeof own.companionShape === 'string' ? own.companionShape : undefined,
        companionColor: typeof own.companionColor === 'string' ? own.companionColor : undefined,
        companionImage: typeof own.companionImage === 'string',
        teamOmni: unfold ? own.teamOmni === true : own.teamOmni !== false,
        teamGenie: own.teamGenie === true,
        migrateDone: own.migrateDone === true,
        connectAiDone: own.connectAiDone === true,
        connectOmniSkipped: own.connectOmniSkipped === true,
        deepseek,
        piAiRoutes,
        // Really on: a route that is set up, or a subscription account.
        aiConnected: anyOn ? await anyOn().catch(() => false) : deepseek || piAiRoutes.length > 0,
        preload,
        machine: machineOf({ platform, env }),
        ...(host ? { host } : {}),
      }
    },

    async done(payload) {
      const stepId = parse(DonePayload, payload)?.stepId ?? ''
      const field = Object.hasOwn(FLAGS, stepId) ? FLAGS[stepId] : undefined
      if (field === undefined) throw invalid(`No onboarding step "${stepId.slice(0, 40)}"`)
      await ctx.settings.update(ENTRY, { [field]: true })
      return { [field]: true }
    },

    async cliproxy(payload, signal) {
      const fields = parse(CliproxyPayload, payload)
      const baseURL = cleanBaseUrl(fields?.baseURL)
      if (baseURL === null) throw invalid('Type the gateway address as an http:// or https:// URL, such as http://localhost:8317/v1.')
      const apiKey = parse(Secret, fields?.apiKey)
      if (apiKey === undefined) throw invalid('Paste the gateway\'s API key.')
      const piAi = entryOf(describeAll(ctx), PI_AI)
      if (piAi === undefined) throw refused('This DSH has no pi-ai entry (llm-pi-ai) to hold the route.')
      const models = await listModels(fetchImpl, baseURL, apiKey, signal)
      if (models.length === 0) throw refused(`The gateway at ${baseURL} lists no models. Add a provider there, then try again.`)
      // Kept to put back if DSH refuses the route, so a failed save leaves the old route on its old key.
      // A key that came from the environment rather than DSH's store ("file") is not copied into the store.
      const previous = await ctx.credentials.resolve(KEY_REF).catch(() => undefined)
      await ctx.credentials.set(KEY_REF, apiKey)
      // A deep merge: other routes stay as they are; this route's model list is replaced.
      const route = { displayName: 'CLIProxyAPI', api: 'openai-completions', baseURL, apiKeyEnv: KEY_REF, models: models.map(id => ({ id, name: id })) }
      try {
        await ctx.settings.update(PI_AI, { providers: { [ROUTE_ID]: route } }, piAi.revision)
      } catch (error) {
        await (previous?.source === 'file' ? ctx.credentials.set(KEY_REF, previous.value) : ctx.credentials.unset(KEY_REF)).catch(() => {})
        if (error?.code === 'SETTINGS_CONFLICT') throw refused('DSH\'s model settings changed while saving. Try again.')
        throw refused(`DSH did not save the route: ${error?.message ?? error}`)
      }
      return { route: ROUTE_ID, baseURL, models }
    },
  }
}

export function install(ctx, deps = {}) {
  const mode = (deps.env ?? process.env).AUTOMAGIK_MULTIUSER
  const multiuser = mode !== undefined && mode !== '' && mode !== '0'
  const service = name => {
    try { return ctx.get?.(name) } catch { return undefined }
  }
  const ai = createAiActions(ctx, { fetch: deps.fetch, saveRoute: (provider, patch) => saveRoute(ctx, provider, patch), unsetRoute: provider => unsetRoute(ctx, provider) })
  const { anyOn, ...aiEndpoints } = ai
  const { team, omniProjectOf, assignModels, joinOmni, ...companion } = createCompanionActions(ctx, { env: deps.env ?? process.env, ...deps.companion })
  // A deleted Omni Bot comes back from the Bot team's New menu (Add Omni), made the way the
  // team step makes it: while the Bot team and Omni's channels run, the team view says
  // whether it is missing, and the omni-add endpoint makes it.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['omniTeam', 'omniChannels'], (sub) => {
      const rt = sub.omniTeam
      if (typeof rt?.hooks?.view !== 'function' || typeof rt.hooks.endpoint !== 'function') return
      sub.effect(() => rt.hooks.view(() => ({ omniAddable: !Object.values(rt.state?.bots ?? {}).some(bot => bot.kind === 'omni') })), 'omni-ai: Add Omni')
      sub.effect(() => rt.hooks.endpoint('omni-add', async () => {
        await ctx.settings.update('omni-ai', { teamOmni: true })
        const bot = await joinOmni(rt)
        return { id: bot.id, name: bot.name }
      }), 'omni-ai: Add Omni')
    })
  }
  const readOnly = () => team()?.readOnly?.()
  const omniOptions = { fetch: deps.fetch, env: deps.env ?? process.env, ...deps.omniServer, ...deps.omniInstaller }
  const omniInstaller = createOmniInstaller({ ...omniOptions, readOnly })
  const botTypes = createBotTypeActions(ctx, {
    team, omniProjectOf, env: deps.env, checkGit: deps.checkGit, genieSkills: deps.genieSkills, genieCli: deps.genieCli,
    release: deps.release, releases: deps.releases, offersUnfold: deps.offersUnfold, omniInstaller,
  })
  const actions = { ...createActions(ctx, { ...deps, anyOn }), ...createProviderActions(ctx), ...aiEndpoints, ...createAcpActions(ctx), ...companion, ...botTypes }
  const checkOmniServer = deps.releases?.checkOmniServer ?? createOmniServerCheck(omniOptions)
  const available = (login, version) => readOnly() === undefined
    && omniInstallAvailable({ env: omniOptions.env, kill: omniOptions.kill, login, version })
  if (typeof ctx.inject === 'function') {
    ctx.inject(['omniTeam', 'omniChannels'], (sub) => {
      const rt = sub.omniTeam
      if (typeof rt?.hooks?.around !== 'function') return
      sub.effect(() => {
        const guard = createOmniTerminalGuard({
          check: (version, available) => checkOmniServer(version, true, available),
          available,
          installer: omniInstaller,
          endpointOf(name) {
            const run = rt.extended.endpointOf(name)?.fn
            if (name !== 'omni-link' || !run) return run
            return async (body, signal) => {
              const link = await run(body, signal)
              // The public reply carries only a host and port. Compare the saved URL, too.
              if (typeof rt.omniLink !== 'function') return link
              const url = rt.omniLink()?.url
              if (!url) return link?.linked ? null : link
              return { ...link, linked: true, origin: new URL(url).host, url }
            }
          },
          readOnly: () => team() === rt ? rt.readOnly() : 'The Bot team changed.',
          generation: () => rt.teamGeneration?.(),
          sameTeam: g => g === undefined || rt.sameTeam?.(g) !== false,
          language: () => rt.uiLanguage?.(),
        })
        const off = []
        const dispose = () => {
          guard.dispose()
          for (const remove of off) remove()
        }
        try {
          for (const name of ['open', 'read', 'write', 'resize', 'close']) {
            off.push(rt.hooks.around('omni-terminal-' + name, guard[name]))
          }
        } catch (error) {
          dispose()
          throw error
        }
        return dispose
      }, 'omni-ai: Connect card install')
    })
  }
  actions['omni-server-check'] = (payload) => {
    const fields = parse(OmniServerPayload, payload)
    if (fields === undefined) throw invalid('Name an Omni server version.')
    if (fields.fallback !== true) return checkOmniServer(fields.version)
    return checkOmniServer(fields.version, true, available)
  }
  for (const [action, schema, run] of [
    ['omni-github-install', OmniGithubInstallPayload, omniInstaller.start],
    ['omni-github-status', OmniGithubStatusPayload, omniInstaller.status],
    ['omni-github-cancel', OmniGithubCancelPayload, omniInstaller.cancel],
    ['omni-github-ack', OmniGithubAckPayload, omniInstaller.ack],
  ]) {
    actions[action] = (payload) => {
      const fields = parse(schema, payload === undefined ? {} : payload)
      if (fields === undefined) throw invalid('Check the Omni install request.')
      return run(fields)
    }
  }
  const migrate = createMigrateActions(ctx, deps.migrate ?? {})
  // The move's own payloads are parsed here, as every other endpoint's are.
  actions['migrate-start'] = (payload, signal) => migrate['migrate-start'](parse(MigrateStartPayload, payload) ?? {}, signal)
  actions['migrate-status'] = (payload, signal) => migrate['migrate-status'](parse(MigrateStatusPayload, payload) ?? {}, signal)
  actions['migrate-omni-status'] = (payload, signal) => migrate['migrate-omni-status'](parse(MigrateOmniPayload, payload) ?? {}, signal)
  actions['migrate-restore-hermes'] = migrate['migrate-restore-hermes']
  actions['migrate-probe'] = migrate['migrate-probe']
  // Connect AI finished with an AI on: the companion, the Omni Bot and the Genie Bot get their model, and
  // their held greetings go out. The step waits for that a little (ASSIGN_HOLD_MS), so the
  // chat opens on the greeting rather than on the model card; a provider that registers
  // later is still waited for in the background, up to ASSIGN_WAIT_MS.
  const markDone = actions.done
  actions.done = async (payload, signal) => {
    const result = await markDone(payload, signal)
    const fields = parse(DonePayload, payload)
    const rt = team()
    if (fields?.stepId === 'omni-connect-ai' && fields.connected === true && rt !== undefined) {
      const assigning = assignModels(rt, { waitMs: deps.assignWaitMs ?? ASSIGN_WAIT_MS })
        .catch(error => ctx.logger?.warn?.('omni-ai: the companions got no model: %s', error?.message ?? error))
      await Promise.race([assigning, new Promise(resolve => setTimeout(resolve, deps.assignHoldMs ?? ASSIGN_HOLD_MS))])
    }
    return result
  }
  const handle = async (endpoint, payload, signal) => {
    if (!Object.hasOwn(actions, endpoint)) return { ok: false, error: { code: 'omni-ai/not-found', message: `Unknown endpoint ${endpoint.slice(0, 40)}` } }
    try {
      return { ok: true, value: await actions[endpoint](payload, signal) }
    } catch (error) {
      const known = typeof error?.code === 'string' && error.code.startsWith('omni-ai/')
      if (!known) ctx.logger?.warn?.('omni-ai: %s failed: %s', endpoint, error?.message ?? error)
      return { ok: false, error: { code: known ? error.code : 'omni-ai/internal', message: known ? error.message : `${endpoint} failed` } }
    }
  }

  // The steps' own live flags are no settings page of their own.
  ctx.effect(() => ctx.settings.configure?.({ auto: false }, ctx.fiber), 'omni-ai: settings form')
  // An exact Fetch route on the shared /api channel; the browser authenticates with its session cookie.
  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body
      try { body = await request.json() } catch { body = {} }
      if (needsViewer(body?.endpoint)) {
        const hasPrincipal = request.headers.has('x-automagik-principal')
        const caller = hasPrincipal ? service('automagikCaller') : undefined
        if (multiuser || (caller?.version === 2 && caller.multiuser === true)) {
          const viewer = hasPrincipal ? service('omniTeam')?.ownerViewer?.(request) : undefined
          if (!viewer || typeof body?.viewer !== 'string' || body.viewer !== viewer.id) {
            return Response.json({ ok: false, error: { code: 'bot/viewer-changed', message: 'Your sign-in changed; reload this page.' } },
              { headers: { 'cache-control': 'no-store' } })
          }
        }
      }
      const asked = parse(RequestBody, body)
      let result
      if (asked !== undefined) {
        result = await handle(asked.endpoint, asked.payload, request.signal)
      } else {
        // A body that does not parse is not the same as an unknown endpoint: a known
        // endpoint whose request simply has no payload says that, in its own words.
        const plain = body !== null && typeof body === 'object' ? body : {}
        const named = typeof plain.endpoint === 'string' ? plain.endpoint : ''
        if (named !== '' && Object.hasOwn(actions, named) && !Object.hasOwn(plain, 'payload')) {
          result = { ok: false, error: { code: 'omni-ai/no-payload', message: 'The payload is missing.' } }
        } else {
          result = await handle(named, undefined, request.signal)
        }
      }
      return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  }), 'omni-ai: api route')
  return { actions, handle }
}
