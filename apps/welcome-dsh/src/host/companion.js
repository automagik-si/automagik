// The person's own companion: the character they create in onboarding, which becomes their
// Main Bot (the orchestrator). Two ways to make one: describe it and have an image model draw
// it, when an OpenAI API key the person gave the app (not one only inherited from the
// environment, #869 delivery B) or a signed-in Codex CLI is here (or, last, a ChatGPT grant
// an earlier version stored through DSH's openai-codex sign-in, only on a shared auth scope);
// or pick one of Omni's characters. The look and name are applied to the Main Bot through
// @automagik/bots-dsh's `omniTeam` service when that plugin is present. The team step then
// adds the Omni Bot, which keeps the person's channels.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hostOf } from './host.js'
import { CompanionPayload, GeneratePayload, TeamPayload, parse } from './payloads.js'

// Where DSH keeps each sign-in (dsh-llm-pi-ai's recordKeyFor): a ChatGPT grant, or a key.
export const CODEX_RECORD = 'llm-pi-ai/openai-codex'
export const OPENAI_RECORD = 'llm-pi-ai/openai'
export const OPENAI_ENV = 'OPENAI_API_KEY'

// Same rule as bots-dsh imagegen.js givenKey (#869 delivery B); the plugins share no module.
const INHERITED_SOURCE = 'env'
const givenKey = resolved => typeof resolved?.value === 'string' && resolved.value !== ''
  && typeof resolved.source === 'string' && resolved.source !== '' && resolved.source !== INHERITED_SOURCE

// ChatGPT plans generate images through the Codex backend (the same request the Codex CLI makes).
export const CODEX_IMAGES = 'https://chatgpt.com/backend-api/codex/images/generations'
export const CODEX_IMAGE_MODEL = 'gpt-image-2'
export const OPENAI_IMAGES = 'https://api.openai.com/v1/images/generations'
export const OPENAI_IMAGE_MODEL = 'gpt-image-1'
const JWT_CLAIM = 'https://api.openai.com/auth'
const MAX_IMAGE_BYTES = 6 * 1024 * 1024
const ENTRY = 'omni-ai'

// The Main Bot's role once it is the person's companion: it leads the team. The person can
// rename it in the Bot's settings; a role they set is kept. Roles this plugin or the team
// once set by themselves give way to it.
export const COMPANION_ROLE = 'Orchestrator'
const DEFAULT_ROLES = new Set(['', 'Your companion', 'Channel orchestrator', COMPANION_ROLE])
const roleFor = bot => (DEFAULT_ROLES.has(bot?.role ?? '') ? { role: COMPANION_ROLE } : {})

// The Omni Bot the team step adds: the octopus Omni always wore, keeping the person's channels.
// Its project is a folder of the team workspace (Bots may not work in the Omni home).
export const OMNI_PROJECT = 'omni'
export const OMNI_BOT = Object.freeze({
  name: 'Omni',
  kind: 'omni',
  role: 'Channel keeper',
  color: 'deepseek',
  avatar: Object.freeze({ shape: 'octopus' }),
  instructions: 'You keep the user\'s Omni: its channels and the chats on them. Read them, answer and act there as far as the user allows, and tell the Main Bot what needs a decision.',
})
// The Omni Bot's name when the companion already took "Omni".
export const OMNI_BOT_FALLBACK = 'Omni Channels'
// The Unfold Bot: Unfold inside DSH. Its own plugin (@automagik/unfold-bot-dsh) makes it, with
// its persona; in Unfold's own instance (AUTOMAGIK_PRELOAD=unfold) it is the Main Bot, so there
// is no companion to make and Unfold leads the team.
export const UNFOLD_BOT = Object.freeze({ name: 'Unfold', kind: 'unfold' })

// The plugin's own settings entry (DSH's settings.describe rows carry `ns` and `value`).
const ownEntry = (ctx) => {
  try {
    return (ctx.settings.describe?.() ?? []).find(row => row.ns === ENTRY)?.value ?? {}
  } catch {
    return {}
  }
}

// The style every companion is drawn in, so a description becomes one of the family.
export function companionPrompt(description) {
  return [
    'A single cute chibi mascot character for an app, the whole body visible and centered,',
    'soft rounded 3D shapes lit from the top left, big friendly eyes, a gentle smile,',
    'cyan and magenta accent lights, on a plain dark navy background, no text, no frame.',
    `The character: ${description}`,
  ].join(' ')
}

const refused = message => Object.assign(new Error(message), { code: 'omni-ai/refused' })
const invalid = message => Object.assign(new Error(message), { code: 'omni-ai/invalid' })

/** The ChatGPT account id inside an access token, or undefined. */
export function accountIdOf(token) {
  try {
    const part = String(token).split('.')[1]
    const payload = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    const id = payload?.[JWT_CLAIM]?.chatgpt_account_id
    return typeof id === 'string' && id !== '' ? id : undefined
  } catch {
    return undefined
  }
}

// acp-dsh's acpAgents, when it can draw (imageAccess and generateImage), else undefined.
const codexOf = (ctx) => {
  try {
    const service = ctx.get?.('acpAgents')
    return typeof service?.generateImage === 'function' && typeof service?.imageAccess === 'function' ? service : undefined
  } catch {
    return undefined
  }
}

// Which image source this DSH can use right now, without revealing anything stored. The Bots'
// order (bots-dsh imagegen.js, owner decision D-g, and #869 delivery B's opt-in rule): an OpenAI
// key the person gave the app (an inherited environment key, or one of unnamed source, is
// skipped), then Codex on its own sign-in, then the earlier ChatGPT grant. That grant is not
// refreshed here, so a run-out one gives way to anything after it and is offered (not ready)
// only when nothing else draws.
// An OPENAI_API_KEY inherited from the environment Automagik was started in (DSH's `env`
// credential layer) is not used for images unless the person opted in explicitly, and a key
// the person gave the app counts as that opt-in: the key record saved in the app, DSH's own
// credential file, the app's own `.env` files, a vault mapping (owner's delegate, #869 delivery
// B, 2026-11-21; a vault mapping never reaches this selector). No new setting.
async function imageSource(ctx, now = Date.now()) {
  const record = await ctx.credentials.readRecord?.(OPENAI_RECORD).catch(() => undefined)
  if (record?.kind === 'api-key' && typeof record.key === 'string' && record.key !== '') return { kind: 'openai', fresh: true, token: record.key }
  const env = await ctx.credentials.resolve?.(OPENAI_ENV).catch(() => undefined)
  if (givenKey(env)) return { kind: 'openai', fresh: true, token: env.value }
  const service = codexOf(ctx)
  let access
  try {
    access = await service?.imageAccess()
  } catch {
    access = undefined
  }
  if (typeof access?.ready !== 'boolean') access = undefined
  if (access?.ready === true) return {
    kind: 'codex', fresh: true, service, accountGeneration: access.accountGeneration,
  }
  // Legacy shared hosts must positively declare their scope. Missing/reloading/unreadable
  // ACP cannot authorize billing an older grant; the shipped ACP only declares isolated.
  if (service?.authScope !== 'shared' || access === undefined) return undefined
  const grant = await ctx.credentials.readRecord?.(CODEX_RECORD).catch(() => undefined)
  const payload = grant?.kind === 'grant' ? grant.payload : undefined
  if (payload && typeof payload.access === 'string') {
    const fresh = typeof payload.expires !== 'number' || payload.expires > now + 60_000
    return { kind: 'chatgpt', fresh, token: payload.access, accountId: payload.accountId ?? accountIdOf(payload.access) }
  }
  return undefined
}

/**
 * Where companion images are kept: companion/ in the Bot team's home (bots-dsh folders.js
 * teamHomeOf: $AUTOMAGIK_BOTS_HOME, else $AUTOMAGIK_HOME/bots), never DSH's own.
 */
export const companionDir = (env = process.env) => join(env.AUTOMAGIK_BOTS_HOME?.trim() || join(env.AUTOMAGIK_HOME?.trim() || join(homedir(), '.automagik'), 'bots'), 'companion')

function firstImage(body) {
  const item = Array.isArray(body?.data) ? body.data[0] : undefined
  if (typeof item?.b64_json === 'string') return { base64: item.b64_json }
  if (typeof item?.url === 'string' && item.url.startsWith('data:image/')) return { base64: item.url.split(',')[1] ?? '' }
  if (typeof item?.url === 'string' && item.url.startsWith('https://')) return { url: item.url }
  return undefined
}

export function createCompanionActions(ctx, { fetch: fetchImpl = globalThis.fetch, env = process.env, now = () => Date.now() } = {}) {
  const team = () => {
    try {
      return ctx.get?.('omniTeam') ?? undefined
    } catch {
      return undefined
    }
  }

  async function mainBotOf(rt) {
    await rt.load?.()
    if (!(rt.state?.mainBotIds ?? []).some(id => rt.botOf?.(id))) await rt.bootstrap?.()
    return (rt.state?.mainBotIds ?? []).find(id => rt.botOf?.(id))
  }

  async function omniProjectOf(rt) {
    await rt.load?.()
    const workspace = rt.teamFolder?.()
    return typeof workspace === 'string' ? join(workspace, OMNI_PROJECT) : undefined
  }

  // Made once, the first time Omni joins the team, without a model: its greeting waits
  // until it has one, so joining sends nothing anywhere. Once Connect AI succeeds,
  // assignModels gives it and the companion a model, and the held greetings go out then,
  // without a click.
  async function joinOmni(rt) {
    await mainBotOf(rt)
    const existing = Object.values(rt.state?.bots ?? {}).find(bot => bot.kind === OMNI_BOT.kind)
    if (existing !== undefined) return existing
    const project = await omniProjectOf(rt)
    if (project !== undefined) mkdirSync(project, { recursive: true })
    const name = rt.findBot?.(OMNI_BOT.name) === undefined ? OMNI_BOT.name : OMNI_BOT_FALLBACK
    return rt.createBot({ ...OMNI_BOT, name, workDir: project, pickModel: true })
  }

  // The companion made before the Omni plugins ran here (installed by the team step) is
  // the Main Bot's look and name once they do.
  async function applyCompanion(rt, entry = ownEntry(ctx)) {
    // In Unfold's instance the Main Bot is Unfold's own, and no companion renames it.
    if (hostOf(env) === 'unfold') return false
    if (typeof entry.companionName !== 'string') return false
    const id = await mainBotOf(rt)
    if (id === undefined) return false
    const bot = rt.botOf?.(id)
    if (bot?.name === entry.companionName && (bot?.role === COMPANION_ROLE || !DEFAULT_ROLES.has(bot?.role ?? ''))) return true
    await rt.updateBot(id, {
      name: entry.companionName,
      ...roleFor(bot),
      ...(entry.companionColor ? { color: entry.companionColor } : {}),
      ...(entry.companionShape ? { avatar: { shape: entry.companionShape } } : {}),
    })
    return true
  }

  // After Connect AI succeeds: the companion (the first Main Bot), the Omni Bot and the Genie
  // Bot were made without a model and hold their greetings until they have one. Each gets the team's
  // default model (bots-dsh models.js: DSH's default model when it is served and its
  // provider has its key, else the first model that can run); a Bot that has one keeps it.
  // A provider that Connect AI just turned on may register a moment later, so the models
  // are read again until one can run or `waitMs` passes. With none, the Bots keep waiting
  // and their chats offer the ways to set one up. Returns the names of the Bots it set.
  async function assignModels(rt, { waitMs = 0, pauseMs = 1500 } = {}) {
    await rt.load?.()
    const main = (rt.state?.mainBotIds ?? []).find(id => rt.botOf?.(id))
    // Omni's Bot, and Genie's and Unfold's (which their plugins make before Connect AI if they ran first).
    const joined = Object.values(rt.state?.bots ?? {}).filter(bot => [OMNI_BOT.kind, 'genie', UNFOLD_BOT.kind].includes(bot.kind)).map(bot => bot.id)
    const waiting = () => [main, ...joined].filter(Boolean).map(id => rt.botOf?.(id)).filter(bot => bot !== undefined && !bot.model)
    if (waiting().length === 0) return []
    const deadline = Date.now() + waitMs
    let ref
    for (;;) {
      await rt.catalog?.({ fresh: true })
      ref = await rt.defaultModel?.()
      if (ref !== undefined || Date.now() >= deadline) break
      await new Promise(resolve => setTimeout(resolve, pauseMs))
    }
    if (ref === undefined) return []
    const set = []
    for (const bot of waiting()) {
      await rt.updateBot(bot.id, { model: ref })
      set.push(bot.name)
    }
    return set
  }

  return {
    // Not endpoints: the Bot types (bot-types.js) read the team through these, the
    // finished Connect AI step gives the companions their model, and Add Omni brings a
    // deleted Omni Bot back (endpoint.js).
    team,
    omniProjectOf,
    assignModels,
    joinOmni,

    // What the companion step needs: can it generate, and is a companion already made.
    async companion() {
      const source = await imageSource(ctx, now())
      const entry = ownEntry(ctx)
      const rt = team()
      return {
        generate: source === undefined ? null : { kind: source.kind, ready: source.fresh },
        name: typeof entry.companionName === 'string' ? entry.companionName : undefined,
        hasTeam: rt !== undefined,
        omniProject: rt === undefined ? null : (await omniProjectOf(rt).catch(() => undefined)) ?? null,
      }
    },

    // Draws a companion from a description. Returns the image as a data URL for the page.
    async 'companion-generate'(payload, signal) {
      const fields = parse(GeneratePayload, payload)
      if (fields === undefined) throw invalid('Describe your companion in a few words.')
      const source = await imageSource(ctx, now())
      if (source === undefined) throw refused('Sign in to Codex first, or pick a companion instead.')
      if (!source.fresh) throw refused('Your earlier ChatGPT sign-in has run out. Sign in to Codex in Connect AI, or pick a companion instead.')
      const prompt = companionPrompt(fields.description)
      if (source.kind === 'codex') {
        // Codex draws in one piece; its refusals (signed out, usage limit, timeout) read as they are.
        const made = await source.service.generateImage({
          prompt, size: '1024x1024', signal,
          ...(source.accountGeneration === undefined ? {} : { accountGeneration: source.accountGeneration }),
        })
          .catch((error) => { throw refused(String(error?.message ?? error).slice(0, 240)) })
        if (typeof made?.base64 !== 'string' || made.base64 === '') throw refused('The image service answered without an image. Try again.')
        if (Buffer.byteLength(made.base64, 'base64') > MAX_IMAGE_BYTES) throw refused('The image is too large to keep. Try again.')
        return { image: `data:image/png;base64,${made.base64}`, via: 'codex' }
      }
      const chatgpt = source.kind === 'chatgpt'
      const response = await fetchImpl(chatgpt ? CODEX_IMAGES : OPENAI_IMAGES, {
        method: 'POST',
        signal,
        headers: chatgpt
          ? { authorization: `Bearer ${source.token}`, 'chatgpt-account-id': source.accountId ?? '', originator: 'codex_cli_rs', 'content-type': 'application/json', accept: 'application/json' }
          : { authorization: `Bearer ${source.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: chatgpt ? CODEX_IMAGE_MODEL : OPENAI_IMAGE_MODEL, prompt, size: '1024x1024', ...(chatgpt ? {} : { n: 1 }) }),
      }).catch(() => { throw refused('The image service could not be reached. Check your connection and try again.') })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail = typeof body?.error?.message === 'string' ? body.error.message.slice(0, 160) : `HTTP ${response.status}`
        throw refused(`The image was not made: ${detail}`)
      }
      let image = firstImage(body)
      if (image?.url) {
        const fetched = await fetchImpl(image.url, { signal }).catch(() => undefined)
        const bytes = fetched?.ok ? Buffer.from(await fetched.arrayBuffer()) : undefined
        image = bytes ? { base64: bytes.toString('base64') } : undefined
      }
      if (!image?.base64) throw refused('The image service answered without an image. Try again.')
      if (Buffer.byteLength(image.base64, 'base64') > MAX_IMAGE_BYTES) throw refused('The image is too large to keep. Try again.')
      return { image: `data:image/png;base64,${image.base64}`, via: source.kind }
    },

    // Keeps the companion and makes it the Main Bot's look and name.
    async 'companion-save'(payload) {
      const fields = parse(CompanionPayload, payload)
      if (fields === undefined) throw invalid('Give your companion a name and a look.')
      let imageFile
      if (fields.image) {
        const base64 = fields.image.split(',')[1] ?? ''
        if (Buffer.byteLength(base64, 'base64') > MAX_IMAGE_BYTES) throw invalid('That image is too large.')
        const dir = companionDir(env)
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        imageFile = join(dir, 'companion.png')
        writeFileSync(imageFile, Buffer.from(base64, 'base64'), { mode: 0o600 })
      }
      const rt = team()
      let applied = false
      if (rt !== undefined) {
        const id = await mainBotOf(rt)
        if (id !== undefined) {
          await rt.updateBot(id, {
            name: fields.name,
            ...roleFor(rt.botOf?.(id)),
            ...(fields.color ? { color: fields.color } : {}),
            ...(fields.shape ? { avatar: { shape: fields.shape } } : {}),
            ...(fields.avatar ? { avatar: { image: fields.avatar } } : {}),
          }).catch((error) => { throw refused(String(error?.message ?? error)) })
          applied = true
        }
      }
      await ctx.settings.update(ENTRY, {
        companionName: fields.name,
        ...(fields.shape ? { companionShape: fields.shape } : {}),
        ...(fields.color ? { companionColor: fields.color } : {}),
        ...(imageFile ? { companionImage: imageFile } : {}),
      })
      return { name: fields.name, applied, image: imageFile !== undefined }
    },

    // The companion's picture for the page: the generated one, if any.
    async 'companion-image'() {
      const entry = ownEntry(ctx)
      if (typeof entry.companionImage !== 'string') return { image: null }
      try {
        return { image: `data:image/png;base64,${readFileSync(entry.companionImage).toString('base64')}` }
      } catch {
        return { image: null }
      }
    },

    // Who joins the team. Omni on adds the Omni Bot (once); off keeps its connect step skipped.
    async 'team-save'(payload) {
      const fields = parse(TeamPayload, payload)
      if (fields === undefined) throw invalid('Choose who joins your team.')
      const { omni, genie, omniAbilities } = fields
      await ctx.settings.update(ENTRY, { teamOmni: omni, teamGenie: genie, ...(omniAbilities ? { teamOmniAbilities: JSON.stringify(omniAbilities) } : {}), ...(omni ? {} : { connectOmniSkipped: true }) })
      const rt = team()
      let omniBot = null
      if (rt !== undefined) await applyCompanion(rt).catch(error => { throw refused(String(error?.message ?? error)) })
      if (omni && rt !== undefined) {
        const bot = await joinOmni(rt).catch((error) => { throw refused(String(error?.message ?? error)) })
        omniBot = { id: bot.id, name: bot.name }
      }
      return { omni, genie, abilities: omniAbilities ?? null, omniBot }
    },
  }
}
