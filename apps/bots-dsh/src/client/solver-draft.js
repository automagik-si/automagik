// Plain helpers for the New Solver dialog (RFC 0048, delivery 1), kept free of React so tests
// can load them. A Solver is an ordinary Bot: no `kind`, made with the person's own create-bot,
// its native tools turned on through update-bot on their own, its method in its instructions.
import { CHARACTERS, DEFAULT_COLORS, DEFAULT_SHAPES, SOLVER_SHAPES } from './characters.js'
import { createPayload, freshBotName, setUp, startModel } from './bot-draft.js'
import { isRefusal } from './api.js'
import { dateLocale, t } from './i18n.js'
import { AUTO, AUTO_ROW, markOf } from '../shared/permission-levels.js'
import { REVIEWER_INSTRUCTIONS, SOLVER_DESCRIPTION, SOLVER_ROLE_ID, isSolverBot, solverInstructions } from '../shared/solver-method.js'
import { packageAttachment, ROLES_OFF_REASON, rolesOn, sameRolePin } from '../shared/roles.js'
import { chosenIdentityOf, unverifiedReason, unverifiedText } from '../shared/solver-model.js'
import { REVIEW_GUARD_COPY, reviewGuardReach } from '../shared/review-guard.js'

// The Solver's character slot: avatar objects as the host's cleanAvatar keeps them, `{ shape }`
// of a CHARACTERS key or `{ pet: { source: 'builtin', id, version } }`. The twelve Solver
// characters of the catalogue: a new Solver wears one of them.
export const SOLVER_LOOKS = SOLVER_SHAPES.map(shape => ({ shape }))

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

// The normal catalog keeps raw routes for existing callers. In this dialog an
// affiliated alias shares the concrete row and only that row is offered.
export function solverCatalog(roster) {
  const refs = new Set(roster.models?.map(row => row.ref))
  return { ...roster, models: roster.models?.filter(row => {
    const twin = row.solverRef
    return !row.ref.startsWith('acp-claude/') || row.ref === 'acp-claude/default' || !twin || twin === row.ref
      || chosenIdentityOf(row.ref) !== twin || !refs.has(twin)
  }) }
}

/** The Solver's first model: Claude Code when it is set up (its native subagents), else the form's. */
export function solverStartModel(roster) {
  const models = usableModels(solverCatalog(roster))
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
  const identity = chosenIdentityOf(solverModel)
  const others = usableModels(solverCatalog(roster)).filter(model => chosenIdentityOf(model.ref) !== identity)
  const elsewhere = others.filter(model => agentOf(model.ref) !== agentOf(solverModel))
  const ref = (elsewhere.find(entry => entry.superseded !== true) ?? elsewhere[0]
    ?? others.find(entry => entry.superseded !== true) ?? others[0])?.ref
  const choices = ref === undefined ? [] : [{ key: 'new', kind: 'new', model: ref }]
  const mains = new Set(roster.mainBotIds ?? [])
  const bots = (roster.bots ?? []).filter((bot) => {
    const ref = modelOfBot(bot)
    return !mains.has(bot.id) && bot.kind === undefined && typeof ref === 'string'
      && !isHermesRemote(ref) && refs.has(ref) && chosenIdentityOf(ref) !== identity
  })
  const away = bot => (agentOf(modelOfBot(bot)) !== agentOf(solverModel) ? 0 : 1)
  bots.sort((a, b) => away(a) - away(b) || a.name.localeCompare(b.name))
  for (const bot of bots) choices.push({ key: `bot:${bot.id}`, kind: 'bot', botId: bot.id, name: bot.name, model: modelOfBot(bot) })
  choices.push({ key: 'fresh', kind: 'fresh' })
  return choices
}

// Keep the normal model menu (including its sign-in rows) except for the Solver’s model.
export function reviewerModels(roster, solverModel) {
  const identity = chosenIdentityOf(solverModel)
  return (roster.models ?? []).filter(row => !identity || chosenIdentityOf(row.ref) !== identity)
}

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
export function reviewerPayload({ name, look, model, workDir, solverModelChoice }) {
  const payload = createPayload({ name, look, model, role: 'Reviewer', instructions: REVIEWER_INSTRUCTIONS })
  if (workDir) payload.workDir = workDir
  if (solverModelChoice) payload.solverModelChoice = true
  return payload
}

/**
 * The Solver's create-bot payload, written once its reviewer's real name is known (`reviewer`:
 * that name, or null for fresh-session reviews; `dedicated`: made by this dialog; `reviewerId`:
 * its id, which the host's review mark reads). The brief is sent after the role
 * attempt and any native tools switch. `guard`: the Review guard tick, sent only with a
 * reviewer Bot (review-guard.js), in the Solver's own create, so it is never half made.
 */
export function solverPayload({ name, look, model, effort, workDir, brief, sectionId, reviewer = null, dedicated = false, reviewerId, guard = false, auto = false, solverModelChoice }) {
  const payload = createPayload({
    name, look, model, effort, sectionId, ownLook: true, avatar: avatarOfLook(look),
    role: SOLVER_DESCRIPTION, instructions: solverInstructions({ reviewer, dedicated }),
  })
  if (workDir) payload.workDir = workDir
  if (solverModelChoice) payload.solverModelChoice = true
  payload.waitingRole = SOLVER_ROLE_ID
  if (auto === true) payload.solverAuto = true
  if (typeof reviewer === 'string' && reviewer !== '' && typeof reviewerId === 'string' && reviewerId !== '') {
    payload.reviewerId = reviewerId
    if (dedicated) payload.reviewerMade = true
    if (guard === true) payload.reviewGuard = true
  }
  return { payload, ...(brief ? { sendBrief: brief } : {}) }
}

/**
 * The line Details shows for a Solver's last delivery, from the host's mark (review-mark.js):
 * which review the host saw, "plan unreviewed" or "result unreviewed" when a verdict was
 * missing. Null for a Bot the host has no mark for (it has delivered nothing as a Solver); a mark
 * it has stays shown after a role change. With no reviewer Bot it claims no review.
 */
export function reviewMarkText(bot, roster) {
  const mark = bot?.reviewMark
  if (mark === null || typeof mark !== 'object') return null
  const reviewed = reviewText(mark, bot, roster)
  const outcome = bot.solverStatus?.outcome
  const name = mark.reviewer?.name ?? roster?.byId?.[bot.reviewerId]?.name ?? t('its reviewer')
  const completion = mark.done === true ? t('Done: every check passed and {name} approved.', { name })
    : outcome?.reason === 'checks' ? t('Result not verified, so not marked done: current passing results are missing for agreed checks.')
      : outcome?.reason === 'review' ? t('Not marked done: {name} has not independently approved the current result.', { name })
        : null
  return completion ? `${reviewed}\n${completion}` : reviewed
}

function reviewText(mark, bot, roster) {
  if (mark.review === 'fresh') return t('Review not checked: this Solver has no reviewer Bot, and the app cannot see a fresh-session review.')
  if (mark.review !== 'bot') return t('Unreviewed: its reviewer is no longer on the team.')
  const name = mark.reviewer?.name ?? roster?.byId?.[bot.reviewerId]?.name ?? t('its reviewer')
  if (mark.pending === true) return t('{name} had not answered when this was delivered; the app cannot see a fresh-session review.', { name })
  if (mark.plan === true && mark.result === true) return t('Plan and result reviewed by {name}.', { name })
  if (mark.result === true) return t('Plan unreviewed: {name} gave no verdict before the work started.', { name })
  if (mark.plan === true) return t('Result unreviewed: {name} gave no verdict on the finished work.', { name })
  return t('Plan and result unreviewed: no verdict from {name} came in time.', { name })
}

export function solverAutoHint(bot, level) {
  const reach = reviewGuardReach(bot, level)
  return reach !== 'hard' || level !== 'ask'
    ? t('Attempt limits are prompt-only for actions this route runs outside the host.')
    : null
}

export function solverAutoView(bot, roster, level) {
  if (!isSolverBot(bot) && bot?.reviewGuard !== true && bot?.solverAuto !== true && !bot?.solverStatus) return null
  const limit = bot.solverStatus?.limit
  const request = bot.solverStatus?.auto
  const reason = unverifiedReason(bot.solverStatus?.unverified)
  const lines = [
    ...(reason ? [t('RESULT review unverified. {reason}', { reason: t(unverifiedText(reason, bot.solverStatus?.imagesWhy)) })] : []),
    ...(typeof request === 'boolean' ? [request ? t('Auto is on for this request.') : t('This request follows the saved Auto setting.')] : []),
    ...(limit ? [limit.kind === 'fix' ? t('Waiting for your answer after the attempt limit for {check}.', { check: limit.check })
      : t('Waiting for your answer after the re-plan limit.')] : []),
    solverAutoHint(bot, level),
  ].filter(Boolean)
  return { on: bot.solverAuto === true, disabled: Boolean(roster?.readOnly), lines }
}

/**
 * The Review guard row of a Bot's Details (RFC 0048 delivery 1.5), or null when it has none: a
 * Bot with a reviewer id, the guard on, or the Solver marker (display only: a Fresh-session Solver
 * sees why it has no guard). `level`: 'full', 'auto' or 'ask', the Bot's level. The line says how
 * far the guard holds on the Bot's route (reviewGuardReach), never more. With no reviewer Bot on
 * the team the switch is off and disabled, or, when it is on, says the work stays held.
 * @returns {{ on: boolean, disabled: boolean, lines: string[] } | null}
 */
export function reviewGuardView(bot, roster, level) {
  if (bot === null || typeof bot !== 'object') return null
  const on = bot.reviewGuard === true
  const reviewerId = typeof bot.reviewerId === 'string' && bot.reviewerId !== '' ? bot.reviewerId : undefined
  if (!on && reviewerId === undefined && !isSolverBot(bot)) return null
  const reviewer = reviewerId === undefined || reviewerId === bot.id ? undefined : roster?.byId?.[reviewerId]
  const readOnly = Boolean(roster?.readOnly)
  if (reviewer === undefined) {
    return on ? { on, disabled: readOnly, lines: [t(REVIEW_GUARD_COPY.gone)] }
      : { on, disabled: true, lines: [t(REVIEW_GUARD_COPY.noReviewer, { name: bot.name })] }
  }
  const reach = reviewGuardReach(bot, level)
  const lines = [t(REVIEW_GUARD_COPY[reach], { reviewer: reviewer.name })]
  if (on && typeof bot.reviewGuardWaitingSince === 'number' && Number.isFinite(bot.reviewGuardWaitingSince)) {
    const time = new Date(bot.reviewGuardWaitingSince).toLocaleTimeString(dateLocale(), { hour: 'numeric', minute: '2-digit' })
    lines.push(t(REVIEW_GUARD_COPY.waiting, { reviewer: reviewer.name, time }))
  }
  lines.push(t(REVIEW_GUARD_COPY.scope))
  return { on, disabled: readOnly, lines }
}

/** The Review guard row's text, or null (reviewGuardView). */
export const reviewGuardText = (bot, roster, level) => reviewGuardView(bot, roster, level)?.lines.join(' ') ?? null

/** The guard's level from a saved level row: Auto, a dangerous (Full access) one, or one that asks. */
export const guardLevelOf = (saved, danger) => (saved === AUTO_ROW || saved === AUTO ? 'auto' : danger ? 'full' : 'ask')

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
 * 2. the Solver with written instructions, 3. an attempt to attach the Solver role, 4. native
 * tools, 5. the brief. Install is attempted before either Bot is created. A Bot or native-tools
 * refusal deletes, newest first, only what this run made (never an
 * existing Bot, never by name) and reads the team again when what happened is not known. It
 * never throws: the answer says what was made, what may have been made, and what is left.
 * `before`: the Bot ids the team had before Create.
 */
export async function createSolver({ actions, before, reviewer, reviewerPayload: firstPayload, solverPayloadFor, native = false, prefs }) {
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
  let version
  let roleNote
  if (!rolesOn(prefs)) roleNote = ROLES_OFF_REASON
  else {
    try {
      const install = await actions.installRole(SOLVER_ROLE_ID)
      if (install?.installed === false) roleNote = 'install'
      version = install?.version
    } catch (error) {
      roleNote = error?.reason === ROLES_OFF_REASON ? ROLES_OFF_REASON : 'install'
    }
  }
  try {
    let name = null
    let dedicated = false
    let reviewerId
    if (reviewer?.kind === 'new') {
      step = 1
      const first = await make(firstPayload)
      name = first.name ?? firstPayload.name
      reviewerId = first.id
      dedicated = true
    } else if (reviewer?.kind === 'bot') {
      name = reviewer.name
      reviewerId = reviewer.botId
    }
    step = 2
    const { payload, sendBrief } = solverPayloadFor({ reviewer: name, dedicated, reviewerId })
    solver = await make(payload)
    if (roleNote === undefined) {
      step = 3
      try {
        const attached = await actions.attachRole(solver.id, SOLVER_ROLE_ID)
        if (attached?.pending) roleNote = 'attach'
      } catch (error) {
        if (error?.reason === ROLES_OFF_REASON) roleNote = ROLES_OFF_REASON
        else {
          roleNote = 'attach'
          try {
            const fresh = await actions.teamState()
            const bot = fresh?.bots?.find(bot => bot.id === solver.id)
            const pin = packageAttachment(bot)
            const runtime = fresh?.roleRuntime?.[solver.id]
            if (rolesOn(fresh?.prefs) && bot?.role === SOLVER_DESCRIPTION && bot.instructions === ''
              && pin?.id === SOLVER_ROLE_ID && pin.version === version
              && sameRolePin(pin, runtime?.pin) && runtime.acp !== true && !runtime.promptWarning) roleNote = undefined
          } catch { /* The fallback remains in place when completion is uncertain. */ }
        }
      }
    }
    const result = { solver, ...(roleNote === undefined ? {} : { roleNote }) }
    if (native) {
      step = 4
      await actions.updateBot(solver.id, { nativeTools: true })
    }
    if (sendBrief) {
      step = 5
      try { await actions.send(solver.id, sendBrief) } catch (error) { return { ...result, sendError: error } }
    }
    return result
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
