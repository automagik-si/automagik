// A Bot on an agent whose CLI signed out since it was picked (plan v3, H14 and H17): its next
// call fails as MODEL_ACCESS_REQUIRED before anything is sent, so neither DSH's retry policy nor
// the fallback model answers it (model-state.js, fallback.js KEEP_CODES) and the Bot keeps its
// model. Only a Bot's own Sessions, and only an agent route over ACP (acp-claude, acp-codex):
// an ordinary DSH Session and every API provider keep DSH's own handling. Only a CLI that says
// it is signed out refuses (modelAccess's `bot/sign-in-required`); a sign-in DSH cannot read
// (unknown, an older acp-dsh, a failed check) passes, and the agent's own answer decides.
//
// The same refusal answers an agent signed in to an account the person has not confirmed for
// Bots (#869, modelAccess's `bot/account-confirm-required`): the turn ends before anything is
// sent or billed, with the same code, so no other model answers it either. Only acp-dsh saying
// `consent: 'needed'` refuses; an account it cannot read passes.
//
// Only a turn's first call is checked: a call that continues a turn (a tool result already
// answered the agent since the last message that opened it) passes as it is, so no step of a
// running turn waits on the CLI's auth check, and no reading mid-turn ends a turn the agent
// already took. A sign-out during a turn is the agent's own answer to give: its auth_required
// is MODEL_ACCESS_REQUIRED already (acp-dsh's adapter).
//
// No selection command is wrapped: a pick is checked where the Bot team makes it (updateBot,
// models.js `checkAccess`), and DSH's own controller is left as it ships.
import { routeOf } from '../shared/routes.js'
import { MODEL_ACCESS_REQUIRED } from './model-state.js'
import { ACCOUNT_CONFIRM_REQUIRED } from './models.js'
import { createReservationCheck } from './reservation-check.js'

// The context DSH adds to every call of a turn is not what opens one.
const opensTurn = message => message?.role === 'user' && message.source?.kind !== 'runtime-context'

/** Whether a call continues a turn: the agent or a tool spoke after the turn's opening message. */
export function continuesTurn(messages) {
  if (!Array.isArray(messages)) return false
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role === 'tool' || message?.role === 'assistant') return true
    if (opensTurn(message)) return false
  }
  return false
}

const finish = message => ({
  type: 'finish', reason: { kind: 'error', failure: { code: MODEL_ACCESS_REQUIRED, message } },
})

export function install(rt, reservationDeps) {
  const { ctx } = rt
  const check = reservationDeps && createReservationCheck(rt, reservationDeps)
  if (check) rt.machineReservations = check
  ctx.on('llm/stream', (options, next) => {
    // Let DSH validate malformed calls; this guard only knows complete model routes.
    if (typeof options?.provider !== 'string' || typeof options?.model !== 'string') return next()
    const { provider, sessionId } = options
    if (routeOf(provider).connectedBy !== 'acp') return next()
    if (!rt.isBotSession?.(sessionId) || continuesTurn(options.messages)
      || check?.isAdmitted(sessionId)) {
      check?.admitted(sessionId, provider)
      return next()
    }
    return (async function* authenticateAgentStream() {
      const release = check?.starting(provider)
      try {
        const held = check && await check.gate(provider, sessionId)
        if (held) {
          yield finish(held)
          return
        }
        let access
        try {
          access = await rt.modelAccess(`${provider}/${options.model}`)
        } catch {
          access = undefined
        }
        const late = check?.held(provider)
        if (late) {
          yield finish(late)
          return
        }
        if (access?.ready === false && (access.code === 'bot/sign-in-required'
          || access.code === ACCOUNT_CONFIRM_REQUIRED)) {
          yield finish(access.message)
          return
        }
        check?.admitted(sessionId, provider)
        release?.()
        yield* next()
      } finally {
        release?.()
      }
    })()
  })
  if (!check) return
  ctx.on('acp-dsh/login-ready', payload => check.loginReady(payload?.id))
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'turn/end') check.turnEnded(session?.id)
  })
  ctx.on('session/disposed', session => check.sessionDisposed(session?.id))
  ctx.on('session/created', session => check.sessionOpened(session))
  if (typeof ctx.inject === 'function') {
    ctx.inject(['acpAgents'], sub => {
      const off = check.started()
      sub.effect(() => off, 'ds-bot: reservation check')
    })
  } else {
    try { if (ctx.get?.('acpAgents') !== undefined) check.started() } catch {}
  }
}
