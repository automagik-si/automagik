// A model that fails does not end the conversation: the next turn runs on the fallback
// model (the profile's default, DeepSeek out of the box, or config.fallbackModel) when it
// uses the same harness, and the turn after it is back on the Bot's own model. It covers
// every Session of the team (a Bot's chat, a group seat, a task), after everything that
// answers a failed request before
// it: DSH's own retries of the same model, and parts.js, which moves a full or stuck chat
// to a fresh part. A full context, a stop, and a fallback that fails too end the turn as
// before. config.fallback: false turns it off.
//
// DSH fixes a step's route before the request and keeps it across that step's retries, and
// agent/request may no longer move it (dsh 0.2.2): the choice is recorded on the Agent with
// agent.model.select() and the continuing turn is woken with agent.followup(). This plugin
// used to rewrite agent/request, which dsh 0.2.2 rejects before the request is admitted.
//
// The followup waits for the Agent to be idle. Sent from agent/request-error, the failed turn
// still runs: DSH puts the notice in the next turn's inbox and latches no wake for it (only
// maintenance or an abort latch one), so it would sit there as a queued message, the fallback
// would never answer, and the person's next message would carry it along. Sent once the failed
// turn ended, it opens the fallback turn. A turn that started meanwhile (the person wrote
// again) already ran on the fallback, so the notice is not sent then.
// The way back retries after DSH's event publication if it refused a reentrant selection.
// On Agent creation or plugin reload it can be rebuilt from the Session log and the Bot's
// current choice. A return never takes a Session across harnesses.
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { commandCapableAgent, crossesHarness, leavesCli } from '../shared/routes.js'
import { splitRef } from './text.js'
import { NO_BOT_RUNNER } from './bot-runner.js'
import { MODEL_ACCESS_REQUIRED, switchFailure, switchPending } from './model-state.js'

// Failures another model cannot answer better: the conversation is too long (parts.js moves
// it on), the person stopped it, an image has to leave the request first, or the model's
// account needs a sign-in (an agent whose CLI is signed out: model-state.js; the Bot stays on
// its pick and the person is asked to sign in, never moved silently to another model). Any
// other failure of an agent (ACP_AGENT) can fall back on the same harness, with its notice.
export const KEEP_CODES = new Set(['CONTEXT_WINDOW_EXCEEDED', 'ABORTED', 'IMAGE_OFFLOAD_REQUIRED', MODEL_ACCESS_REQUIRED, NO_BOT_RUNNER, 'REMOTE_HERMES'])

const sameRoute = (a, b) => a?.provider === b?.provider && a?.model === b?.model
const label = route => `${route.provider}/${route.model}`
const ref = label
// A failover may never move a conversation to another harness (RFC 0030, Q7). A local CLI the
// team carries (`local-*`) runs its own agent, so any provider change from or to one counts too,
// although routes.js files it under DSH's harness.
const localCli = provider => typeof provider === 'string' && provider.startsWith('local-')
export const failoverCrosses = (from, to) => crossesHarness(ref(from), ref(to))
  || ((localCli(from?.provider) || localCli(to?.provider)) && from?.provider !== to?.provider)
const known = route => route?.provider !== undefined && route.model !== undefined
const newestSelection = events => events?.findLastIndex(event => event.type === 'model/selection') ?? -1

/** The newest selection points to a fallback only if it was made inside a failed turn. */
export function fallbackLeftOn(events) {
  const index = newestSelection(events)
  if (index < 0) return undefined
  const selection = events[index]
  if (!known(selection.data)) return undefined
  const { provider, model } = selection.data
  const B = { provider, model }
  let otherRoute = false
  let failedTurn
  for (let i = index - 1; i >= 0; i--) {
    const { type, data } = events[i]
    if (type === 'turn/end') return undefined
    if (type === 'turn/start') {
      failedTurn = data?.turn
      break
    }
    if (type === 'request/header' && known(data?.header?.config) && !sameRoute(data.header.config, B)) otherRoute = true
  }
  if (!otherRoute || typeof failedTurn !== 'number') return undefined
  for (let i = index + 1; i < events.length; i++) {
    const { type, data } = events[i]
    if (type === 'turn/start') return undefined
    if (type === 'turn/end') {
      if (data?.turn !== failedTurn || data.reason?.kind !== 'error') return undefined
      return { B, selectionSeq: selection.seq, failedTurn }
    }
  }
}

/**
 * The route a failed request moves to, or undefined when it stays failed: a failure kept
 * as it is, no fallback route, or a request already on the fallback.
 */
export function fallbackFor({ failure, failed, fallback }) {
  if (!failure || KEEP_CODES.has(failure.code)) return undefined
  if (fallback?.provider === undefined || fallback.model === undefined) return undefined
  if (failed === undefined || sameRoute(failed, fallback)) return undefined
  return fallback
}

/** What the model and the person read where the conversation moved: which model failed, and why. */
export function fallbackNotice(failed, fallback, failure) {
  const why = String(failure?.message ?? failure?.code ?? 'it failed').split('\n')[0].slice(0, 200)
  const text = `[model fallback: ${label(failed)} failed (${failure?.code ?? 'error'}: ${why}); `
    + `the next turn continues with ${label(fallback)}]`
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'model-selection', form: 'notice', summary: `${label(failed)} failed → ${label(fallback)}` },
  })
}

/**
 * What the chat reads when a failed turn is not moved to the fallback model: the Bot has Full
 * access on its coding CLI, where the CLI itself runs without asking, and another
 * model would run DSH's own tools at that level. The turn fails as it did, with its own error;
 * this is one fixed sentence, the one the language tables carry (client/i18n.js, the pt-BR pack).
 */
export const STAYS_ON_CLI = 'The model failed and no other model answered in its place: this Bot has Full access on its coding CLI and stays there. Fix the CLI or sign in to it, or pick another model for the Bot yourself.'
export function stayNotice(failed) {
  return createUserMessage({
    content: [{ type: 'text', text: STAYS_ON_CLI }],
    source: { kind: 'model-selection', form: 'notice', summary: `${label(failed)} failed; the Bot stays on it` },
  })
}

export const STAYS_ON_HARNESS = 'The model failed and no other model answered in its place: the fallback model runs on another harness, and a conversation never changes harness. Try again, fix or sign in to the model, or start a new conversation on another model.'
export function harnessNotice(failed) {
  return createUserMessage({
    content: [{ type: 'text', text: STAYS_ON_HARNESS }],
    source: { kind: 'model-selection', form: 'notice', summary: `${label(failed)} failed; the fallback runs on another harness` },
  })
}

export function install(rt) {
  const { ctx, config } = rt
  if (config.fallback === false) return
  // Agent id -> the route the Bot answers on again, and the turn that failed: the fallback
  // turn ends after it, so the Bot's own route comes back once that turn is over.
  const restore = new Map()
  // Session id -> the failed turn whose fallback turn has not ended yet: parts.js waits for that
  // turn before it takes a fresh part's switch back (rt.fallbackArmed).
  const armed = new Map()
  // Agent id -> the expected fallback and turn whose end the notice waits for.
  const waking = new Map()
  const selectionSeqOf = (session) => {
    const events = session?.snapshotEvents?.()
    return events?.[newestSelection(events)]?.seq
  }
  const savedModel = sessionId => rt.botOf?.(rt.selfOf?.(sessionId))?.model
  const hasLiveReturn = sessionId => armed.has(sessionId)
    || Array.from(restore.values()).some(entry => entry.agent.session?.id === sessionId)
    || Array.from(waking.values()).some(entry => entry.agent.session?.id === sessionId)

  async function resumeFallbackWayBack(agent) {
    const session = agent.session
    const sessionId = session?.id
    for (let round = 0; round < 3; round++) {
      if (!rt.isBotSession(sessionId) || hasLiveReturn(sessionId)) return
      if (agent.status === 'running') {
        if (typeof agent.whenIdle !== 'function') return
        await agent.whenIdle()
        if (agent.status === 'running') continue
      }
      const left = fallbackLeftOn(session.snapshotEvents?.())
      if (left === undefined) return
      const { B, selectionSeq } = left
      const selected = await rt.reselectOwnRoute(agent, route => !sameRoute(route, B)
        && !failoverCrosses(B, route)
        && !(commandCapableAgent(route.provider) && rt.botRunnerRequired?.(sessionId, agent) === true)
        && savedModel(sessionId) !== label(B)
        && fallbackLeftOn(session.snapshotEvents())?.selectionSeq === selectionSeq
        && sameRoute(agent.model.current(), B)
        && !hasLiveReturn(sessionId)
        && agent.status !== 'running')
      if (selected || agent.status !== 'running') return
    }
  }

  rt.resumeFallbackWayBack = resumeFallbackWayBack
  rt.resumeFallbackWayBacks = async () => {
    await rt.load()
    const agents = ctx.get?.('agents')?.list?.() ?? []
    await Promise.all(agents.filter(agent => rt.isBotSession(agent.session?.id)).map(resumeFallbackWayBack))
  }

  const fallbackRoute = async noCommands => splitRef(config.fallbackModel ?? await rt.defaultModel({ noCommands }))
  // A switch that cannot run (switchFailure) goes back instead: the Bot's own chat with a switch
  // not yet confirmed (model-state.js) or a fresh part still waiting for its first answer
  // (parts.js, revertSwitch). Nothing runs again on its own there, so no fallback turn is woken.
  const goesBack = (sessionId, failure) => {
    if (sessionId === undefined || !switchFailure(failure)) return false
    if (rt.awaitingFirstAnswer?.(sessionId) === true) return true
    const botId = rt.chatOwners?.get?.(sessionId)
    return botId !== undefined && switchPending(rt.botOf?.(botId))
  }

  ctx.on('agent/request-error', async (payload, next) => {
    const decided = await next()
    if (decided !== undefined || payload.signal?.aborted) return decided
    const { agent, failure, turn } = payload
    if (!failure || KEEP_CODES.has(failure.code)) return decided
    if (!rt.isBotSession(agent.id)) return decided
    const failedIn = agent.session?.id ?? agent.id
    if (goesBack(failedIn, failure)) return decided
    const failed = agent.session.requestHeader?.()?.config
    if (failed === undefined) return decided
    const noCommands = rt.botRunnerRequired?.(failedIn, agent) === true
    const fallback = fallbackFor({ failure, failed, fallback: await fallbackRoute(noCommands).catch(() => undefined) })
    if (fallback === undefined) return decided
    if (commandCapableAgent(fallback.provider) && (noCommands || rt.botRunnerRequired?.(failedIn, agent))) return decided
    // A Session at Full access on a coding CLI is not moved to another provider on its own:
    // there the CLI runs without asking, and the fallback model would run DSH's own tools
    // unasked at the same level. The turn fails as it did, and the chat says why it stays.
    // A level that cannot be read is not known to be Full access: the fallback goes on.
    // It is the Bot's saved model that says it is on that CLI, not only the route that failed:
    // a Session left on a CLI its Bot was moved off (a selection there that failed) is not one
    // the person keeps on it, so it falls back as before. So does one whose Bot is not known.
    const owner = rt.botOf?.(rt.selfOf?.(failedIn))
    const saved = typeof owner?.model === 'string' ? splitRef(owner.model).provider : undefined
    if (leavesCli(failed, fallback) && saved === failed.provider && rt.sessionWide?.(failedIn, agent.session) === true) {
      rt.warn(
        'ds-bot: %s failed on %s (%s); it stays there, at Full access no other model takes over',
        owner.name ?? agent.id, label(failed), failure.code,
      )
      try {
        agent.session.append('user/message', stayNotice(failed), { surfaceOp: 'append' })
      } catch (error) {
        rt.warn('ds-bot: the notice that the Bot stays on its CLI was not written: %s', error)
      }
      return decided
    }
    if (failoverCrosses(failed, fallback)) {
      rt.warn(
        'ds-bot: %s failed on %s (%s); the fallback on %s runs on another harness',
        owner?.name ?? agent.id, label(failed), failure.code, label(fallback),
      )
      try {
        agent.session.append('user/message', harnessNotice(failed), { surfaceOp: 'append' })
      } catch (error) {
        rt.warn('ds-bot: the notice that the conversation stays on its harness was not written: %s', error)
      }
      return decided
    }
    // DSH prepares the next step's route from agent.model; the failed step's own retry
    // keeps its fixed route, so the backup runs the turn this wakes. The Bot's own selection
    // is snapshotted whole (provider, model and its explicit reasoning effort) first.
    const own = agent.model.current?.()
    if (known(own) && failoverCrosses(own, fallback)) return decided
    if (noCommands && commandCapableAgent(own?.provider ?? failed.provider)) return decided
    try {
      agent.model.select({ provider: fallback.provider, model: fallback.model })
    } catch (error) {
      rt.warn('ds-bot: the fallback route was not recorded: %s', error)
      return decided
    }
    if (!restore.has(agent.id)) {
      const route = own?.provider !== undefined && own.model !== undefined
        ? { ...own }
        : failed?.provider !== undefined && failed.model !== undefined
          ? { provider: failed.provider, model: failed.model }
          : undefined
      if (route !== undefined) {
        restore.set(agent.id, { agent, route, fallback, failedTurn: turn, selectionSeq: selectionSeqOf(agent.session) })
      }
    }
    const sessionId = agent.session?.id
    if (sessionId !== undefined && typeof turn === 'number') armed.set(sessionId, turn)
    rt.warn(
      'ds-bot: %s failed on %s (%s); the next turn continues on %s',
      rt.botOf?.(agent.id)?.name ?? agent.id, label(failed), failure.code, label(fallback),
    )
    wake(agent, fallbackNotice(failed, fallback, failure), fallback, turn, noCommands)
    return decided
  })

  // A notice that was not sent opens no fallback turn: nothing is armed any more.
  function unarm(agent, error) {
    const sessionId = agent.session?.id
    if (sessionId !== undefined) armed.delete(sessionId)
    rt.warn('ds-bot: the fallback turn was not woken: %s', error)
  }
  // A selection made while the failed turn ended that left the fallback's harness wakes no
  // fallback turn: it would carry the conversation across (RFC 0030, Q7).
  function send(agent, notice, fallback, noCommands) {
    try {
      const current = agent.model.current?.()
      if (known(current) && failoverCrosses(current, fallback)) {
        restore.delete(agent.id)
        unarm(agent, 'the model changed')
        return
      }
      if (!commandCapableAgent(current?.provider) || !(noCommands || rt.botRunnerRequired?.(agent.session?.id ?? agent.id, agent))) {
        expected.set(notice.id, { agent, fallback })
        if (expected.size > 200) expected.delete(expected.keys().next().value)
        agent.followup(notice)
      } else {
        armed.delete(agent.session?.id)
        restore.delete(agent.id)
      }
    } catch (error) {
      unarm(agent, error)
    }
  }
  // The notice opens the fallback turn once the failed one has ended (see the header). Never
  // awaited here: a request-error listener that waits for its own Agent to be idle never returns.
  function wake(agent, notice, fallback, failedTurn, noCommands) {
    if (typeof agent.whenIdle !== 'function') return send(agent, notice, fallback, noCommands)
    const entry = { agent, failedTurn, fallback }
    waking.set(agent.id, entry)
    void Promise.resolve()
      .then(() => agent.whenIdle())
      .then(() => {
        if (waking.get(agent.id) !== entry) return
        waking.delete(agent.id)
        send(agent, notice, entry.fallback, noCommands)
      }, (error) => {
        if (waking.get(agent.id) !== entry) return
        waking.delete(agent.id)
        unarm(agent, error)
      })
  }

  rt.fallbackArmed = sessionId => armed.has(sessionId)

  // Notice id -> the fallback it was sent for. DSH fixes a step's model when the step claims
  // its input, which can be after another waiter changed the selection: a fallback notice that
  // a step would answer on another harness leaves the step, and its fallback is undone.
  // parts.js's pre-step calls it first, beside dropLoginCodes, before a switch can carry the batch.
  const expected = new Map()
  rt.dropCrossingFallback = (payload) => {
    const messages = Array.isArray(payload?.messages) ? payload.messages : []
    for (let index = messages.length - 1; index >= 0; index--) {
      const entry = expected.get(messages[index]?.id)
      if (entry === undefined) continue
      expected.delete(messages[index].id)
      if (!known(payload.modelSelection) || !failoverCrosses(payload.modelSelection, entry.fallback)) continue
      messages.splice(index, 1)
      restore.delete(entry.agent.id)
      unarm(entry.agent, 'the step runs on another harness')
    }
  }

  // The turn after the failed one (the fallback turn) ends: the Bot answers on its own
  // model again. The failed turn's own end comes first and is passed over. A turn that starts
  // after the failed one (the person wrote again) takes the waiting notice's place. A selection
  // made meanwhile (a switch that went back to the model before it, the person's own pick) is
  // left as it is: only the fallback route is undone.
  ctx.on('session/event', (session, event) => {
    const type = event?.type
    if ((type !== 'turn/end' && type !== 'turn/start') || typeof event.data?.turn !== 'number') return
    for (const [id, pending] of waking) {
      if (pending.agent.session?.id === session?.id && event.data.turn > pending.failedTurn) waking.delete(id)
    }
    if (type !== 'turn/end') return
    const failedTurn = armed.get(session?.id)
    if (failedTurn !== undefined && event.data.turn > failedTurn) armed.delete(session.id)
    for (const [id, pending] of restore) {
      const sameSession = pending.agent.session?.id === session?.id
      if (!sameSession || event.data.turn <= pending.failedTurn) continue
      restore.delete(id)
      if (failoverCrosses(pending.route, pending.fallback)) continue
      const stillOnFallback = () => {
        const current = pending.agent.model.current?.()
        if (current?.provider !== undefined && !sameRoute(current, pending.fallback)) return false
        if (pending.selectionSeq !== undefined && selectionSeqOf(pending.agent.session) !== pending.selectionSeq) return false
        return savedModel(session.id) !== label(pending.fallback)
      }
      if (!stillOnFallback()) continue
      try {
        pending.agent.model.select(pending.route)
      } catch (error) {
        if (!String(error?.message).includes('cannot reenter')) {
          rt.warn('ds-bot: the Bot\'s own model was not restored: %s', error)
          continue
        }
        queueMicrotask(() => {
          if (!stillOnFallback()) return
          try {
            pending.agent.model.select(pending.route)
          } catch (error) {
            rt.warn('ds-bot: the Bot\'s own model was not restored: %s', error)
          }
        })
      }
    }
  })
}
