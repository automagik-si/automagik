// Plain helpers for the New Solver dialog (RFC 0048, delivery 1), kept free of React so tests
// can load them. A Solver is an ordinary Bot: no `kind`, made with the person's own create-bot,
// its native tools turned on through update-bot on their own, its method in its instructions.
import { CHARACTERS, DEFAULT_COLORS, DEFAULT_SHAPES } from './characters.js'
import { createPayload, freshBotName, setUp, startModel } from './bot-draft.js'
import { isRefusal } from './api.js'
import { t } from './i18n.js'
import { markOf } from '../shared/permission-levels.js'
import { REVIEWER_INSTRUCTIONS, solverInstructions } from '../shared/solver-method.js'

// The Solver's character slot: avatar objects as the host's cleanAvatar keeps them, `{ shape }`
// of a CHARACTERS key or `{ pet: { source: 'builtin', id, version } }`. Empty until the Solver
// characters are in the catalogue; the change that adds them fills this list and nothing else.
export const SOLVER_LOOKS = []

const pick = (list, random) => list[Math.floor(random() * list.length)]

/**
 * The look a new Solver wears: one entry of `looks` at random, kept only when this window knows
 * it (a shape in CHARACTERS, a pet the `pets` read lists with the same source and id), with a
 * random default color; with none, today's random look. Never throws.
 */
export function solverLook({ looks = SOLVER_LOOKS, pets = [], random = Math.random } = {}) {
  const known = (Array.isArray(looks) ? looks : []).filter((entry) => {
    if (entry === null || typeof entry !== 'object') return false
    if (typeof entry.shape === 'string') return Object.hasOwn(CHARACTERS, entry.shape)
    const pet = entry.pet
    return pet !== null && typeof pet === 'object'
      && (Array.isArray(pets) ? pets : []).some(item => item?.source === pet.source && item?.id === pet.id)
  })
  const color = pick(DEFAULT_COLORS, random)
  if (known.length === 0) return { shape: pick(DEFAULT_SHAPES, random), color }
  const entry = pick(known, random)
  return entry.pet ? { color, pet: { ...entry.pet } } : { shape: entry.shape, color }
}

/** The avatar a look sends to create-bot, unchanged. */
export const avatarOfLook = look => (look.pet ? { pet: look.pet } : { shape: look.shape })

// A Hermes remote route reads its profile's own instructions, so the method never reaches it.
export const isHermesRemote = ref => typeof ref === 'string' && ref.startsWith('hermes-remote/')

// The agent a model runs on: a local agent's mark, else the provider.
export const agentOf = (ref) => {
  const mark = markOf(ref)
  return mark !== undefined && !mark.startsWith('api:') ? mark : String(ref ?? '').split('/')[0]
}
export const modelOfBot = bot => bot?.model ?? bot?.appliedModel

// Set up now (a key, a sign-in, a signed-in agent) and not a Hermes remote route.
const usableModels = roster => (roster.models ?? []).filter(model => setUp(model) && !isHermesRemote(model.ref))

/** The Solver's first model: Claude Code when it is set up (its native subagents), else the form's. */
export function solverStartModel(roster) {
  const models = usableModels(roster)
  const claude = models.filter(model => markOf(model.ref) === 'acp-claude')
  const first = claude.find(model => model.ref === roster.prefs?.defaultBotModel) ?? claude.find(model => model.superseded !== true) ?? claude[0]
  if (first) return first.ref
  return startModel({ ...roster, models: (roster.models ?? []).filter(model => !isHermesRemote(model.ref)) })
}

/**
 * The reviewer choices for a Solver on `solverModel`, the default first:
 * a new reviewer on another model when one is set up; each existing Bot that may review (not a
 * Main Bot, no `kind`, on a set-up model other than the Solver's, not a Hermes remote route),
 * another agent first; and always, last, a fresh session. Never a "none".
 */
export function reviewerChoices(roster, solverModel) {
  const models = usableModels(roster)
  const refs = new Set(models.map(model => model.ref))
  const others = models.filter(model => model.ref !== solverModel)
  const elsewhere = others.filter(model => agentOf(model.ref) !== agentOf(solverModel))
  const model = (elsewhere.find(entry => entry.superseded !== true) ?? elsewhere[0] ?? others.find(entry => entry.superseded !== true) ?? others[0])?.ref
  const choices = model === undefined ? [] : [{ key: 'new', kind: 'new', model }]
  const mains = new Set(roster.mainBotIds ?? [])
  const bots = (roster.bots ?? []).filter((bot) => {
    const ref = modelOfBot(bot)
    return !mains.has(bot.id) && bot.kind === undefined && typeof ref === 'string'
      && !isHermesRemote(ref) && refs.has(ref) && ref !== solverModel
  })
  const away = bot => (agentOf(modelOfBot(bot)) !== agentOf(solverModel) ? 0 : 1)
  bots.sort((a, b) => away(a) - away(b) || a.name.localeCompare(b.name))
  for (const bot of bots) choices.push({ key: `bot:${bot.id}`, kind: 'bot', botId: bot.id, name: bot.name, model: modelOfBot(bot) })
  choices.push({ key: 'fresh', kind: 'fresh' })
  return choices
}

/** The models a new reviewer may run on: set up, not a Hermes remote route, not the Solver's. */
export const reviewerModels = (roster, solverModel) => usableModels(roster).filter(model => model.ref !== solverModel)

/**
 * The native-tools block a Bot the person makes now on `ref` reads, from the host's read-only
 * `nativeToolsNew` view field. A missing field or ref fails closed (`level-unknown`); JSON null
 * is no block.
 */
export function newBotBlock(roster, ref) {
  const map = roster?.nativeToolsNew ?? {}
  if (typeof map !== 'object' || !Object.hasOwn(map, ref)) return 'level-unknown'
  return map[ref] ?? undefined
}

/** The Solver as the Details switch would see it once made, ticked or not (nativeSwitchView). */
export function solverCandidate(roster, model, ticked) {
  const block = newBotBlock(roster, model)
  return {
    model,
    ...(typeof block === 'string' ? { nativeToolsBlock: block } : {}),
    ...(ticked ? { nativeTools: true, nativeToolsAgent: markOf(model) } : {}),
  }
}

/** The reviewer's name: "<Solver> reviewer", cut so a " 2" suffix still fits in 40. */
export const reviewerName = (roster, name) => freshBotName(roster, t('{name} reviewer', { name }).slice(0, 36))

/** The new reviewer's create-bot payload. */
export function reviewerPayload({ name, look, model, workDir }) {
  const payload = createPayload({ name, look, model, role: 'Reviewer', instructions: REVIEWER_INSTRUCTIONS })
  if (workDir) payload.workDir = workDir
  return payload
}

/**
 * The Solver's create-bot payload, written once its reviewer's real name is known (`reviewer`:
 * that name, or null for fresh-session reviews; `dedicated`: made by this dialog). With native
 * tools ticked the brief is not in the payload: it is sent after the switch (`sendBrief`), so
 * the task's first turn already runs with them.
 */
export function solverPayload({ name, look, model, effort, workDir, brief, sectionId, reviewer = null, dedicated = false, native = false }) {
  const payload = createPayload({
    name, look, model, effort, sectionId, ownLook: true, avatar: avatarOfLook(look),
    brief: native ? '' : brief, role: 'Solver', instructions: solverInstructions({ reviewer, dedicated }),
  })
  if (workDir) payload.workDir = workDir
  return { payload, ...(native && brief ? { sendBrief: brief } : {}) }
}

/**
 * Whether a failure leaves it unknown what the host did: anything that is not a host refusal,
 * and a changed viewer (the answer came back for another window).
 */
export const uncertain = error => error?.code === 'bot/viewer-changed' || !isRefusal(String(error?.code ?? ''))

/** The Bots in a fresh team view that were not there `before` and that this run does not know. */
export function mayHaveBeenCreated(before, fresh, known = []) {
  const seen = new Set([...before, ...known])
  return (fresh?.bots ?? []).filter(bot => bot?.id !== undefined && !seen.has(bot.id)).map(bot => bot.name)
}

/**
 * Makes the Solver through the person's own actions, best effort (RFC 0048): 1. the new reviewer,
 * 2. the Solver, with the reviewer's real name in its instructions, 3. native tools on their own,
 * 4. the brief. A failure at 1-3 deletes, newest first, only what this run made (never an
 * existing Bot, never by name) and reads the team again when what happened is not known. It
 * never throws: the answer says what was made, what may have been made, and what is left.
 * `before`: the Bot ids the team had before Create.
 */
export async function createSolver({ actions, before, reviewer, reviewerPayload: firstPayload, solverPayloadFor, native = false }) {
  const made = []
  const unsure = []
  let step = 0
  const make = async (payload) => {
    try {
      const bot = await actions.createBot(payload)
      made.push({ id: bot.id, name: bot.name ?? payload.name })
      return bot
    } catch (error) {
      if (uncertain(error)) unsure.push(payload.name)
      throw error
    }
  }
  let solver
  try {
    let name = null
    let dedicated = false
    if (reviewer?.kind === 'new') {
      step = 1
      name = (await make(firstPayload)).name ?? firstPayload.name
      dedicated = true
    } else if (reviewer?.kind === 'bot') {
      name = reviewer.name
    }
    step = 2
    const { payload, sendBrief } = solverPayloadFor({ reviewer: name, dedicated })
    solver = await make(payload)
    if (native) {
      step = 3
      await actions.updateBot(solver.id, { nativeTools: true })
    }
    if (sendBrief) {
      step = 4
      try { await actions.send(solver.id, sendBrief) } catch (error) { return { solver, sendError: error } }
    }
    return { solver }
  } catch (error) {
    const left = []
    for (const bot of [...made].reverse()) {
      try {
        await actions.deleteBot(bot.id)
        left.push({ ...bot, removed: true })
      } catch (failure) {
        left.push({ ...bot, removed: failure?.code === 'bot/not-found' })
      }
    }
    const unknown = uncertain(error)
    let fresh
    if (unknown || left.some(bot => !bot.removed)) {
      // A view with no Bot list proves nothing: it counts as a failed read.
      try {
        const value = await actions.teamState()
        fresh = Array.isArray(value?.bots) ? value : undefined
      } catch { fresh = undefined }
    }
    if (fresh !== undefined) {
      const ids = new Set(fresh.bots.map(bot => bot?.id))
      for (const bot of left) if (!bot.removed && !ids.has(bot.id)) bot.removed = true
    }
    const maybe = !unknown ? []
      : fresh !== undefined ? mayHaveBeenCreated(before, fresh, made.map(bot => bot.id))
        : [...unsure]
    const unremoved = left.filter(bot => !bot.removed).map(bot => bot.name)
    return { error, step, nothing: !unknown && unremoved.length === 0, unremoved, maybe }
  }
}
