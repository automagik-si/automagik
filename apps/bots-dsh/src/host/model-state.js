import { grantModelFields, withGrantHold } from './grants.js'
// What a Bot's model really did, as opposed to what was picked (plan v3, 2.2 and A-3).
//
// Each signal proves one thing and no more: `bot.model` is the choice; a `request/header` in the
// Bot's chat says a call on a route started, not that it answered; only an `assistant/message`
// whose `source` names that route says it answered. Per Bot this module keeps, in memory:
// `requestStarted`, `lastAnswer` and `lastFailure {code, text}`; the state answer reads them with
// `selected` (`bot.model`) and `previousModel`, and `answered` is derived, never written.
//
// `bot.previousModel` is persisted: the last model of the Bot that answered. Its first answer on
// `bot.model` records it, and updateBot keeps it on a change (or records the model it leaves when
// that one answered in this process); a model that never answered is never recorded, so nothing
// goes back to it. While the two differ, the switch is unconfirmed. A switch whose first turn
// fails because the new model cannot run this conversation (DSH's
// MODEL_SWITCH_COMPACTION_FAILED, MODEL_ACCESS_REQUIRED from an agent whose CLI is signed out,
// or a pi-ai route whose provider is not configured: switchFailure) puts the Bot back on
// `previousModel`, Session selection included.
// Nothing runs again on its own: the person's message stays in the chat, and the failed turn's
// error row says why. A fresh part's failed first call goes back the same way (parts.js,
// revertSwitch). The fallback model (fallback.js) never touches `bot.model`.
//
// Only the Bot's own chat counts: a group seat or a task runs the same model, but its turns say
// nothing about the switch made in the chat.
import { turnFailure } from './turns.js'
import { OWN_TOOLS_MODEL_TEXT } from '../shared/own-tools.js'
import { HANDOFF_ACK } from './constants.js'
import { textOf } from './text.js'

export const MODEL_ACCESS_REQUIRED = 'MODEL_ACCESS_REQUIRED'
export const SWITCH_FAILED = 'MODEL_SWITCH_COMPACTION_FAILED'
// An agent switch, or its way back, stopped because the Bot denies acp_tool and the model it
// would run on runs its own tools (#2026).
export const OWN_TOOLS_SWITCH = 'MODEL_OWN_TOOLS_DENIED'
// The failures that say the model a Bot was just switched to cannot run its conversation.
// Any other failure (a provider down, a timeout) keeps the pick: the fallback answers it.
export const SWITCH_CODES = new Set([SWITCH_FAILED, MODEL_ACCESS_REQUIRED])
// pi-ai refuses a route whose provider has no credential (a sign-in that is gone, such as
// openai-codex's) before any request goes out, as a generic PI_AI_ERROR. Every turn on it would
// fail the same way, so a switch onto it goes back like one in SWITCH_CODES.
const NOT_CONFIGURED = /^Provider is not configured\b/i
const providerNotConfigured = failure => failure?.code === 'PI_AI_ERROR' && NOT_CONFIGURED.test(String(failure?.message ?? '').trim())
/** Whether a failure says the model a Bot was just switched to cannot run its conversation. */
export const switchFailure = failure => SWITCH_CODES.has(failure?.code) || providerNotConfigured(failure)

const refOf = route => (typeof route?.provider === 'string' && route.provider !== '' && typeof route?.model === 'string' && route.model !== ''
  ? `${route.provider}/${route.model}`
  : undefined)

// The attached serve answers on its one row whatever ref the request names (models.js
// applyModel keeps a carried chat's route; remote-chat-adapter.js serves rows[0]). An
// answer there belongs to the Bot's pick, the row id, not to the carried-over ref: recording
// it under the old ref would keep the switch unconfirmed, label the answer with a model the
// Bot is no longer on, and let a later switch failure move the pick back.
const ATTACHED_REF = 'hermes-remote/attach'
const answeredRef = (bot, ref) => bot?.model === ATTACHED_REF && typeof ref === 'string' && ref.startsWith('hermes-remote/')
  ? ATTACHED_REF
  : ref

/** Whether a Bot's last explicit model change has not been confirmed by an answer yet. */
export const switchPending = bot => typeof bot?.previousModel === 'string' && typeof bot?.model === 'string' && bot.model !== bot.previousModel

export function install(rt) {
  const { ctx } = rt
  /** @type {Map<string, {requestStarted?: {ref: string, at: number}, lastAnswer?: {ref: string, at: number}, lastFailure?: {code: string, text: string, ref?: string, kept?: string, at: number}}>} */
  const states = new Map()
  const stateOf = (botId) => {
    let entry = states.get(botId)
    if (entry === undefined) states.set(botId, entry = {})
    return entry
  }
  const ownChat = sessionId => rt.chatOwners?.get?.(sessionId)

  // An explicit change (updateBot), before `bot.model` moves: the model to come back to is the
  // last one that answered, already recorded, or the model it leaves when that one answered in
  // this process. A model that only started a call (or failed) is never one to come back to. An
  // earlier failure is over: the person chose again.
  function noteModelChoice(bot, next) {
    const entry = states.get(bot.id)
    if (bot.previousModel === undefined && typeof bot.model === 'string' && bot.model !== next && entry?.lastAnswer?.ref === bot.model) bot.previousModel = bot.model
    if (entry !== undefined) delete entry.lastFailure
  }

  // The Bot back on `previousModel` after its new model failed to take over. Changes the record
  // only; the caller saves and selects. Returns whether it went back.
  function revertModel(bot, failure) {
    if (!switchPending(bot)) return false
    const failed = bot.model
    bot.model = bot.previousModel
    const code = typeof failure?.code === 'string' && failure.code !== '' ? failure.code : 'UNKNOWN'
    stateOf(bot.id).lastFailure = { code, text: failureText(code, failed, bot.model, failure), ref: failed, kept: bot.model, at: Date.now() }
    rt.warn('ds-bot: %s could not move to %s (%s); it stays on %s', bot.name, failed, code, bot.model)
    return true
  }

  // The words for a failure the person reads (Settings, the details panel), by code. The client
  // words the same codes in the interface language; this is the English and the log's.
  function failureText(code, failed, kept, failure) {
    const stays = kept ? ` It stays on ${kept}.` : ''
    if (code === OWN_TOOLS_SWITCH) return OWN_TOOLS_MODEL_TEXT
    if (code === SWITCH_FAILED) return `${failed} could not take over this conversation.${stays}`
    if (code === MODEL_ACCESS_REQUIRED) return `${failed} needs a sign-in before it can answer.${stays}`
    const message = typeof failure?.message === 'string' && failure.message !== '' ? `: ${failure.message.slice(0, 200)}` : ''
    return `${failed ?? 'The model'} did not answer (${code}${message}).${stays}`
  }

  // An agent switch in the Bot's own chat that did not take over (parts.js): the Bot never
  // left its model, so nothing is reverted; the person reads why. `code` and `text` name
  // another reason than the generic one (the acp_tool rule).
  function noteSwitchFailed(bot, target, kept, { code = SWITCH_FAILED, text } = {}) {
    if (bot === undefined) return
    stateOf(bot.id).lastFailure = { code, text: text ?? failureText(code, target, kept), ...(target ? { ref: target } : {}), ...(kept ? { kept } : {}), at: Date.now() }
    rt.warn('ds-bot: %s did not switch to %s (%s); it stays on %s', bot.name, target, code, kept)
  }

  function restore(bot, failure) {
    return withGrantHold(rt, { botId: bot.id }, () => grantModelFields(bot),
      () => restoreHeld(bot, failure))
  }

  async function restoreHeld(bot, failure) {
    if (!revertModel(bot, failure)) return
    try {
      await rt.save()
      await rt.applyModel(bot, { force: true })
    } catch (error) {
      rt.warn('ds-bot: %s was not put back on %s: %s', bot.name, bot.model, error?.message ?? error)
    }
  }

  ctx.on('session/event', (session, event) => {
    const botId = ownChat(session?.id)
    if (botId === undefined) return
    const bot = rt.botOf(botId)
    if (bot === undefined) return
    switch (event?.type) {
      case 'request/header': {
        const ref = answeredRef(bot, refOf(event.data?.header?.config))
        if (ref !== undefined) stateOf(botId).requestStarted = { ref, at: event.time ?? Date.now() }
        break
      }
      case 'assistant/message': {
        // A stopped answer is part of one, not the route's answer.
        if (event.data?.interrupted === true) break
        // Omni's own acknowledgement of a bare handoff (parts.js) carries the request's route,
        // but the new agent has not answered yet.
        if (textOf(event.data?.message?.content) === HANDOFF_ACK) break
        const ref = answeredRef(bot, refOf(event.data?.message?.source))
        if (ref === undefined) break
        const entry = stateOf(botId)
        entry.lastAnswer = { ref, at: event.time ?? Date.now() }
        if (ref === bot.model) delete entry.lastFailure
        if (ref === bot.model && (switchPending(bot) || bot.previousModel === undefined)) {
          bot.previousModel = ref
          void rt.save().catch(error => rt.warn('ds-bot: the model %s answered on was not saved: %s', bot.name, error?.message ?? error))
        }
        break
      }
      case 'turn/end': {
        const reason = event.data?.reason
        if (reason?.kind !== 'error') break
        // The outgoing agent's handoff-note turn is never the Bot's reply (parts.js).
        if (rt.handoffNoteTurn?.(session.id, event.data?.turn)) break
        const failure = turnFailure(reason.error)
        const entry = stateOf(botId)
        entry.lastFailure = { code: failure.code, text: failureText(failure.code, bot.model, undefined, failure), ...(bot.model ? { ref: bot.model } : {}), at: event.time ?? Date.now() }
        // A fresh part's first call that failed goes back with its part (parts.js).
        if (switchFailure(failure) && rt.awaitingFirstAnswer?.(session.id) !== true) {
          void restore(bot, failure)
        }
        break
      }
    }
  })

  // An agent whose CLI is signed out: neither DSH's retry policy nor the fallback model answers
  // that, a sign-in does. Only a Bot's own Sessions; any other keeps DSH's own handling.
  ctx.on('agent/request-error', (payload, next) => {
    if (payload?.failure?.code === MODEL_ACCESS_REQUIRED && rt.isBotSession(payload.agent?.id)) return undefined
    return next()
  }, { prepend: true })

  const viewOf = (bot) => {
    const entry = states.get(bot.id) ?? {}
    const switching = rt.switchingChat?.(bot.id, { crossing: true })
    return {
      selected: bot.model ?? null,
      previousModel: bot.previousModel ?? null,
      ...(entry.requestStarted ? { requestStarted: entry.requestStarted } : {}),
      ...(entry.lastAnswer ? { lastAnswer: entry.lastAnswer } : {}),
      ...(entry.lastFailure ? { lastFailure: entry.lastFailure } : {}),
      // Derived: an answer on the model the Bot is on now.
      answered: entry.lastAnswer !== undefined && entry.lastAnswer.ref === bot.model,
      pending: switchPending(bot),
      // An agent switch in the Bot's own chat under way: the chat's composer is locked.
      ...(switching ? { switching } : {}),
    }
  }
  // Per Bot, for every state answer: no sign-in check here (that spawns a CLI).
  const modelStateView = () => Object.fromEntries(Object.values(rt.state.bots ?? {}).map(bot => [bot.id, viewOf(bot)]))
  // One Bot, asked for: the same, with whether its model can run now (`access`).
  async function modelStateOf(botId) {
    const bot = rt.botOf(botId)
    if (bot === undefined) return undefined
    const access = bot.model ? await rt.modelAccess(bot.model) : undefined
    return { ...viewOf(bot), ...(access === undefined ? {} : { access }) }
  }

  Object.assign(rt, { noteModelChoice, revertModel, noteSwitchFailed, modelStateView, modelStateOf })
}
