// The Solver's review guard (RFC 0048, delivery 1.5; #2056's hard guard). A Bot with the person's
// own `reviewGuard: true` has its work refused, in its own chat and the subagents under it, until
// its reviewer (the `reviewerId` the New Solver dialog stored) answers the current request's plan
// with a verdict (review-mark.js records `planVerdictAt`). It only removes tools: a call is held
// unless it is on the open list below (reads, research, asking the person, the notes file and
// messages to the reviewer), so a tool nobody taught this file about is held. It never reads the
// cosmetic Solver marker, and only the person sets or clears the field (setReviewGuard), or the
// one-time upgrade turns it on (store.js).
import { guardGroupRefusal, refusal } from './refusal.js'
import { guardGroupText } from '../shared/guard-groups.js'
import { reviewGuardReach } from '../shared/review-guard.js'
import { teamToolOf } from './approvals.js'
import { cleanTrack, isNotesWrite } from './review-mark.js'
import { activeSolverLimit, limitWhat, solverTracked } from './solver-progress.js'
import { reachesShell } from './tool-deny.js'
import { nativeCheckDirectory, normalizeCheckCommand } from './solver-check-command.js'

// The team tools (constants.js TEAM_TOOLS, each on exactly one list) open while the plan waits for
// its verdict: they read the team, a chat or a memory, or ask the person. `update_bot` and
// `message_bot` are open only in part (heldCall).
export const OPEN_TEAM_TOOLS = Object.freeze([
  'list_bots', 'list_bot_models', 'list_capabilities', 'list_connectors', 'list_secrets', 'read_own_chat',
  'read_group_chat', 'read_browser', 'recall', 'remember', 'forget', 'load_skill',
  'ask_user', 'request_secret', 'request_connector', 'show_view', 'show_settings', 'propose_bot_change',
  'update_bot', 'message_bot', 'solver_progress',
])
// The team tools held while the plan waits: they change the team, act outside it or start work.
// The tools other plugins define (`find_chats`, the automations, Omni's) are not proven read-only
// here, so they are held too (H5-3).
export const HELD_TEAM_TOOLS = Object.freeze([
  'stop_bot', 'create_bot', 'delete_bot', 'create_group', 'update_group', 'delete_group', 'post_to_group',
  'group_relay', 'save_capability', 'delete_capability', 'attach_capability', 'detach_capability', 'group_goal',
  'find_chats', 'list_automations', 'save_automation', 'pause_automation', 'delete_automation', 'generate_image',
  'omni_endpoints', 'omni_call', 'omni_channels', 'omni_chats', 'omni_messages', 'omni_send', 'omni_react',
  'omni_media', 'omni_delete', 'omni_connect', 'show_canvas', 'start_task',
])
// This plugin's other tools that only read: mail and browser lookups.
const OPEN_HOST_TOOLS = ['mail_read', 'mail_search', 'browser_open', 'browser_snapshot', 'browser_screenshot', 'browser_tabs', 'browser_back']
// DeepSeek Harness tools proven read-only in its installed harness (SOL-IMPLEMENT-D15, stage 4):
// file reads and searches, the web, the subagent spawn (each child's own calls pass this guard by
// its lineage), the goal read and the session's todo list.
const OPEN_DSH_TOOLS = ['read', 'read_image', 'grep', 'glob', 'web_search', 'web_fetch', 'subagent', 'list_subagent_models', 'get_goal', 'todo_write']
const OPEN = new Set([...OPEN_TEAM_TOOLS, ...OPEN_HOST_TOOLS, ...OPEN_DSH_TOOLS])
// An ACP agent's own call (`acp_tool`) that only reads, searches, fetches or thinks (Claude Code's
// Agent/Task spawn arrives as `think`).
const ACP_OPEN_KINDS = new Set(['read', 'search', 'fetch', 'think'])
// Attempt holds permit only reads, the question, notes and the designated
// reviewer. In particular, the plan guard allows several writes and launches.
const ATTEMPT_READS = new Set([
  'list_bots', 'list_bot_models', 'list_capabilities', 'list_connectors', 'list_secrets',
  'read_own_chat', 'read_group_chat', 'read_browser', 'recall', 'ask_user', 'solver_progress',
  'load_skill',
  'mail_read', 'mail_search', 'browser_snapshot', 'browser_screenshot', 'browser_tabs',
  'read', 'read_image', 'grep', 'glob', 'web_search', 'web_fetch', 'list_subagent_models', 'get_goal',
])

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const quoted = name => JSON.stringify(String(name ?? ''))

/**
 * Whether one call is held while the plan has no verdict: 'message' for message_bot to a Bot that
 * is not the reviewer, 'work' for anything else not on the open list, undefined when it is open.
 * @param {object} rt - the team runtime (`findBot` resolves message_bot's target).
 * @param {object} bot - the guarded Bot.
 * @param {string} name - the tool name as the executor sees it.
 * @param {unknown} args - the call's arguments.
 * @param {object} [definition] - the tool definition, when known.
 * @param {string} [base] - the Session's folder, where a relative path lands.
 */
export function heldCall(rt, bot, name, args, definition, base) {
  if (typeof name !== 'string' || name === '') return 'work'
  const folder = bot.workDir ?? rt.teamFolder?.()
  if (name === 'acp_tool') {
    if (!isRecord(args) || typeof args.kind !== 'string') return 'work'
    if (isNotesWrite(name, args, folder, base ?? folder)) return undefined
    const input = args.input
    const command = isRecord(input) && (Object.hasOwn(input, 'command') || Object.hasOwn(input, 'cmd'))
    return ACP_OPEN_KINDS.has(args.kind) && !command ? undefined : 'work'
  }
  if (isNotesWrite(name, args, folder, base ?? folder)) return undefined
  const team = teamToolOf(name)
  if (team === 'message_bot') {
    const target = typeof args?.to === 'string' ? rt.findBot?.(args.to) : undefined
    return target !== undefined && target.id === bot.reviewerId && target.id !== bot.id ? undefined : 'message'
  }
  if (team === 'update_bot') {
    const other = typeof args?.bot === 'string' && args.bot !== '' && rt.findBot?.(args.bot)?.id !== bot.id
    return other || (isRecord(args) && args.model !== undefined && args.model !== null && args.model !== '') ? 'work' : undefined
  }
  if (OPEN.has(team)) return undefined
  // An MCP server's tool marked read-only by its server (the connector gateway's own rule). The
  // installed DeepSeek Harness drops MCP annotations, so today every one of them is held.
  if (/^mcp__[^_]/.test(name) && !name.startsWith('mcp__dsh__') && definition?.annotations?.readOnlyHint === true) return undefined
  return 'work'
}

// The ACP call's own ID survives both its mirror execution and its approval.
export function solverCallId(sessionId, name, args, callId) {
  if (name === 'acp_tool' && typeof args?.id === 'string' && args.id !== '') return `${sessionId}:acp:${args.id}`
  return typeof callId === 'string' ? `${sessionId}:${callId}` : undefined
}

function trimmedCommand(input) {
  const command = input?.command ?? input?.cmd
  return typeof command === 'string' ? command.trim() : undefined
}

export function install(rt) {
  function reviewGuardReachOf(bot, agent) {
    try {
      const session = agent?.session
      const presets = rt.ctx.get('permissionPresets')
      if (typeof session?.id !== 'string' || session.id === '' || typeof presets?.current !== 'function') return 'hard'
      const level = presets.current(session) === 'auto' ? 'auto'
        : rt.sessionWide(agent.id ?? session.id, session) === true ? 'full' : 'ask'
      return reviewGuardReach({ ...bot, nativeToolsBlock: rt.nativeToolsBlock?.(bot) }, level)
    } catch {
      return 'hard'
    }
  }
  const guardChanges = new Map()
  const reviewGuardOn = id => rt.botOf(id)?.reviewGuard === true
  const groupsOf = id => Object.values(rt.state.rooms).filter(room => room.members.includes(id))
  const groupText = (key, args) => guardGroupText(key, args, rt.uiLocale?.())
  function checkGuardGroupJoin(members) {
    const id = members.find(reviewGuardOn)
    if (id !== undefined) {
      throw guardGroupRefusal(groupText('join', { name: rt.botOf(id).name }), 'group-join')
    }
  }
  const reviewerOf = bot => (typeof bot.reviewerId === 'string' && bot.reviewerId !== '' && bot.reviewerId !== bot.id
    ? rt.botOf(bot.reviewerId) : undefined)
  const waiting = text => `${text} A fresh-session review does not open this guard: deliver the plan as BLOCKED-review.`
  function taskLaunchHold(botId) {
    const bot = rt.botOf(botId)
    if (bot?.reviewGuard === true) {
      return { why: 'guard-launch', text: `${bot.name} cannot use start_task: its review guard is on. Do the work in your own chat, or ask the person to turn the review guard off in ${bot.name}'s Details.` }
    }
  }

  function solverCall(bot, name, args, definition, base) {
    const folder = bot.workDir ?? rt.teamFolder?.()
    const team = teamToolOf(name)
    const commandInput = isRecord(args?.input) && (Object.hasOwn(args.input, 'command') || Object.hasOwn(args.input, 'cmd'))
    const checkCommand = name === 'acp_tool' ? args?.kind === 'execute' || commandInput : reachesShell(name, definition)
    const notes = isNotesWrite(name, args, folder, base ?? folder)
    const review = team === 'message_bot' && typeof args?.to === 'string' && !!reviewerOf(bot)
      && (args.to === bot.reviewerId || rt.findBot?.(args.to)?.id === bot.reviewerId)
    const acpRead = name === 'acp_tool' && args?.kind !== 'think'
      && ACP_OPEN_KINDS.has(args?.kind) && !commandInput
    const nativeCommand = name === 'acp_tool' ? normalizeCheckCommand(args?.input?.command ?? args?.input?.cmd) : undefined
    const shellCommand = ['bash', 'pwsh', 'powershell'].includes(team) && typeof args?.command === 'string'
      ? args.command.trim() : undefined
    // The broader admission guard also covers launches, computer use and unknown shell-capable tools.
    const compareResult = name === 'acp_tool'
      ? args?.kind === 'execute' && args.image !== true && commandInput && !!trimmedCommand(args.input)
      : !!shellCommand
    return {
      relevant: !notes && (checkCommand || (!review && !acpRead && !ATTEMPT_READS.has(team))),
      checkCommand,
      compareResult,
      nativeCommand,
      shellCommand,
    }
  }

  /**
   * Whether the guard refuses one call: { text, why } (the refusal, and the stop's reason), or
   * undefined. `own`: the Session is the Bot's own chat or a subagent under it.
   */
  function reviewGuardHolds(bot, own, name, args, definition, base, call) {
    if (!own || !solverTracked(bot)) return undefined
    const track = cleanTrack(bot.reviewTrack)
    const tool = name === 'acp_tool' && typeof args?.title === 'string' && args.title !== '' ? args.title : teamToolOf(name) || 'this tool'
    const { relevant, checkCommand, nativeCommand } = solverCall(bot, name, args, definition, base)
    const limit = activeSolverLimit(bot, track)
    if (limit && relevant) {
      return { why: 'limit', text: `${bot.name} cannot use ${tool}: it reached its attempt limit (${limitWhat(limit)}). Ask the person how to proceed: say what you did, what still fails, the likely cause and the exact decision you need. Work resumes when the person answers, or when the person turns Auto on.` }
    }
    const pending = track?.solver?.pending
    // A native ACP mirror and its later approval can describe the same action.
    const sameNativeCall = name === 'acp_tool' && !!call && pending?.call === call && !pending.evidence
    if (relevant && (rt.solverProgressBusy?.(bot) || (pending && (!checkCommand || !call || pending.call) && !sameNativeCall))) {
      return { why: 'solver-progress', text: `${bot.name} cannot use ${tool} yet. Finish recording the current Solver progress before doing more work.` }
    }
    if ((name === 'acp_tool' || checkCommand) && track?.requested && !track.delivered && track.solver?.plan?.accepted === true && !pending) {
      const raw = trimmedCommand(name === 'acp_tool' ? args?.input : args)
      const agreed = Object.values(track.solver.plan.commands ?? {})
      const exact = raw && agreed.includes(raw)
      const folder = bot.workDir ?? rt.teamFolder?.()
      const cwd = args?.input?.cwd ?? base ?? folder
      const equivalent = !exact && nativeCommand?.command && agreed.some(command => {
        const check = normalizeCheckCommand(command)
        return check.command === nativeCommand.command && nativeCheckDirectory(check, nativeCommand, folder, cwd)
      })
      if (exact || equivalent) {
        return { why: 'solver-run', text: `${bot.name} cannot use ${tool} yet. Start a check run with solver_progress before running a command for the accepted plan.` }
      }
    }
    if (bot.reviewGuard !== true) return undefined
    if (typeof track?.planVerdictAt === 'number') return undefined
    const held = heldCall(rt, bot, name, args, definition, base)
    if (held === undefined) return undefined
    const why = track?.openedBy === 'bot' ? 'guard-request' : 'guard'
    const reviewer = reviewerOf(bot)
    if (reviewer === undefined) {
      return { why, text: waiting(`${bot.name} cannot use ${tool}: its review guard is on and its reviewer is no longer on the team. Deliver what you have with this blocker named; only the person can turn the guard off in ${bot.name}'s Details.`) }
    }
    const who = quoted(reviewer.name)
    if (held === 'message') return { why, text: `${bot.name} can message only ${who} until ${who} answers the plan.` }
    return { why, text: waiting(`${bot.name} cannot use ${tool} yet: its review guard holds work until ${who} answers the plan. Send the plan to ${who} with message_bot (reply_to "me"), end your turn, and wait for its verdict. Until then you can read, research, ask the person, and write notes to .solver/notes.md with the write tool.`) }
  }

  // An ACP agent's question that reaches the approval chain without passing the executor: a
  // Claude Code native subagent's nested call asked from its Agent card (acp-dsh tool.js). Held
  // like the executor would hold it, answered with the agent's own reject, and no card is shown.
  // The same for acp-dsh's bridge ask (`bridgeCall`, native tools off): it asks before
  // tools.execute and carries no arguments, so they come from the live record of the tool/call row
  // the bridge wrote just before it asked (turns.js startCall; the record the card itself reads).
  // No record (an agent-opened turn, a subagent Session), another name, or no string: the card
  // shows as before and the executor holds the call. With an agent id reused by two concurrent calls
  // the record may be the other call's: a card or a false hold, never a release (the executor
  // re-checks the call's own arguments). A held bridge ask leaves the guard's text on
  // `bridgeCall.refused`, which acp-dsh hands the agent instead of "The person rejected".
  function reviewGuardAsk(request) {
    const bridge = request?.toolName !== 'acp_tool' && isRecord(request?.bridgeCall)
      && typeof request.toolName === 'string' && request.toolName !== ''
    if (request?.toolName !== 'acp_tool' && !bridge) return undefined
    const agent = request.agent
    const sessionId = agent?.id ?? agent?.session?.id
    if (typeof sessionId !== 'string') return undefined
    const bot = rt.botOfSession?.(sessionId, agent)
    if (!solverTracked(bot)) return undefined
    if (bot.reviewGuard === true && bridge && teamToolOf(request.toolName) === 'start_task') {
      const held = taskLaunchHold(bot.id)
      rt.noteStop?.(sessionId, { why: held.why, tool: request.toolName, callId: request.callId, text: held.text }, agent)
      request.bridgeCall.refused = { reason: held.text }
      return held
    }
    if (bot.reviewGuard !== true && !activeSolverLimit(bot) && !bot.reviewTrack?.solver?.plan && !rt.solverProgressBusy?.(bot)) return undefined
    if (rt.ownChatLineage?.(sessionId, agent, bot) !== true) return undefined
    // From here the question is the guarded Bot's own: an error holds it (fails closed, as the
    // executor's path does), and only this Bot's question is refused (DG-3).
    const refuse = error => {
      const text = error?.code === 'bot/refused' ? error.message : 'The review guard holds this call until the reviewer answers the plan.'
      try {
        const details = bridge ? request.bridgeCall : request.mirrorCall
        if (isRecord(details)) details.refused = { reason: text }
      } catch {}
      return { why: 'guard', text }
    }
    try {
      let base
      try { base = agent?.session === undefined ? undefined : rt.sessionFolder?.(agent.session) } catch {}
      if (bridge) return bridgeHeld(request, bot, sessionId, base)
      const mirror = request.mirrorCall
      const args = isRecord(mirror) ? mirror : undefined
      const call = solverCallId(sessionId, 'acp_tool', args, request.callId)
      const held = reviewGuardHolds(bot, true, 'acp_tool', args, undefined, base, call)
      if (held !== undefined) {
        if (isRecord(mirror)) mirror.refused = { reason: held.text }
        rt.noteStop?.(sessionId, { why: held.why, ...(typeof mirror?.title === 'string' ? { tool: mirror.title } : {}), callId: request.callId, text: held.text, child: true }, agent)
        return held
      }
      if (!bot.reviewTrack?.solver?.plan) return undefined
      const track = cleanTrack(bot.reviewTrack)
      const progress = track?.solver
      if (!track?.requested || track.delivered || !progress?.plan) return undefined
      const work = solverCall(bot, 'acp_tool', args, undefined, base)
      if (!work.relevant) return undefined
      // Match solverBeforeWork's durable updates. The mirror may have bound this action already.
      const pending = progress.pending
      if (!pending && work.compareResult) return undefined // Handoff and Done check the live result.
      const needsSave = pending && work.checkCommand && call
        ? pending.call !== call : progress.passed.length > 0 || progress.review !== undefined
      if (!needsSave) return undefined
      return rt.solverBeforeWork?.(bot, { ...work, call, approvalOnly: true })?.then(() => undefined, refuse)
    } catch (error) {
      return refuse(error)
    }
  }

  // A bridge ask, read from the live call record: a record that does not parse is held as work
  // until the plan verdict (fails closed), and the stop sits on the bridge's own tool/call row.
  function bridgeHeld(request, bot, sessionId, base) {
    const agent = request.agent
    const liveId = agent?.session?.id ?? sessionId
    const call = typeof request.callId === 'string' ? rt.live?.get(liveId)?.calls?.get(request.callId) : undefined
    const known = call?.name === request.toolName && typeof call?.args === 'string'
    if (!known && !activeSolverLimit(bot)) return undefined
    let args
    if (known) {
      try { args = JSON.parse(call.args) } catch {}
    }
    const held = reviewGuardHolds(bot, true, request.toolName, args, undefined, base,
      typeof request.callId === 'string' ? `${sessionId}:${request.callId}` : undefined)
    if (held === undefined) return undefined
    rt.noteStop?.(sessionId, { why: held.why, tool: request.toolName, callId: request.callId, text: held.text }, agent)
    request.bridgeCall.refused = { reason: held.text }
    return held
  }

  /**
   * The person's switch (Details), on its own: refused for any Bot, with other settings, for a
   * value that is not a boolean, an unknown Bot, or ON with no reviewer Bot on the team. Saved
   * before it answers. Keep ON live until an OFF write commits.
   */
  async function setReviewGuard(id, patch, actorId) {
    const bot = rt.botOf(id)
    if (actorId !== undefined) throw refusal('Only the user can turn the review guard on or off for ' + (bot?.name ?? 'this Bot'))
    if (Object.keys(patch).some(key => key !== 'id' && key !== 'reviewGuard')) {
      throw refusal('Change the review guard on its own, without other settings.')
    }
    const on = patch.reviewGuard
    if (typeof on !== 'boolean') throw Object.assign(new Error('The review guard is true or false.'), { code: 'bot/invalid' })
    const pending = guardChanges.get(id)
    const change = (pending ?? Promise.resolve()).then(
      () => changeReviewGuard(id, on),
      () => changeReviewGuard(id, on),
    )
    guardChanges.set(id, change)
    try {
      return await change
    } finally {
      if (guardChanges.get(id) === change) guardChanges.delete(id)
    }
  }

  async function changeReviewGuard(id, on) {
    // A deletion can still restore the Bot and the seats it took out of the live rooms.
    while (on && rt.botDeleting(id)) await rt.waitForBotDeletion(id)
    const bot = rt.botOf(id)
    if (bot === undefined) throw refusal('Unknown Bot')
    const generation = rt.teamGeneration()
    const current = () => rt.sameTeam(generation) && rt.botOf(id) === bot
    if (!on) {
      const check = () => { if (!current()) throw refusal('The Bot team changed. Try again.') }
      await rt.saveCopy(copy => {
        check()
        delete copy.bots[id].reviewGuard
      }, {
        beforeCommit: check,
        afterWrite: () => { if (current()) delete bot.reviewGuard },
      })
      check()
      return bot
    }
    const rooms = groupsOf(id)
    if (rooms.length > 0) {
      let groups = rooms.slice(0, 3).map(room => room.name).join(', ')
      if (rooms.length > 3) groups = groupText('more', { groups, count: rooms.length - 3 })
      throw guardGroupRefusal(groupText('inGroup', { name: bot.name, groups }), 'in-group')
    }
    if (reviewerOf(bot) === undefined) throw refusal(`${bot.name} has no reviewer Bot on the team, so there is no verdict to wait for.`)
    const before = bot.reviewGuard
    bot.reviewGuard = true
    try {
      await rt.save({ required: true })
    } catch (error) {
      if (current()) {
        if (before === undefined) delete bot.reviewGuard
        else bot.reviewGuard = before
      }
      throw error
    }
    return bot
  }

  async function setSolverAuto(id, patch, actorId) {
    const bot = rt.botOf(id)
    if (actorId !== undefined) throw refusal(`Only the person can turn Auto on or off for ${bot?.name ?? 'this Bot'}.`)
    if (Object.keys(patch).some(key => key !== 'id' && key !== 'solverAuto')) {
      throw refusal('Change Auto on its own, without other settings.')
    }
    const on = patch.solverAuto
    if (typeof on !== 'boolean') throw Object.assign(new Error('Auto is true or false.'), { code: 'bot/invalid' })
    if (bot === undefined) throw refusal('Unknown Bot')
    if (!solverTracked(bot)) throw refusal('Auto is a Solver setting.')
    const set = target => {
      if (on) target.solverAuto = true
      else delete target.solverAuto
    }
    const assertCurrent = () => { if (rt.botOf(id) !== bot) throw refusal('The Bot team changed. Try again.') }
    await rt.saveCopy(copy => set(copy.bots[id]), {
      durable: true, beforeCommit: assertCurrent, afterWrite: () => set(bot),
    })
    return bot
  }

  // What the owner's view shows while the guard holds: since when the plan waits for its verdict.
  const reviewGuardViewOf = (bot, track = bot?.reviewTrack) => {
    if (bot?.reviewGuard !== true) return {}
    const clean = cleanTrack(track)
    if (clean?.requested !== true || clean.delivered === true || typeof clean.planVerdictAt === 'number') return {}
    return { reviewGuardWaitingSince: clean.requestAt }
  }

  Object.assign(rt, {
    reviewGuardHolds, reviewGuardReachOf, reviewGuardAsk, setReviewGuard, reviewGuardViewOf,
    reviewGuardOn, groupsOf, checkGuardGroupJoin, taskLaunchHold, setSolverAuto, solverCall,
  })
}

/**
 * Cordis runs prepended listeners newest first, so a held question is refused before any answerer.
 * The Solver progress answer runs here after the guard and before Auto, grants or cards.
 */
export function installAhead(rt) {
  rt.ctx.on('approval/request', (request, next) => {
    let held
    try { held = rt.reviewGuardAsk?.(request) } catch {}
    const answer = decision => decision === undefined ? rt.answerSolverProgress?.(request) ?? next() : 'rejected'
    return held instanceof Promise ? held.then(answer) : answer(held)
  }, { prepend: true })
  installPreExecute(rt)
}

/**
 * The same hold before DeepSeek Harness asks about its own tools: a held call is denied in
 * `tools/pre-execute`, so it never reaches the hard-step ladder, Auto review or a computer consent
 * card. `acp_tool` mirror calls stay on the executor's refusal, and an error goes on: the executor
 * still holds the call (tool-deny.js).
 */
function installPreExecute(rt) {
  rt.ctx.on('tools/pre-execute', function reviewGuardGate(exec, next) {
    // The native ACP approval is intercepted above. The mirror is a UI record.
    if (exec?.name === 'acp_tool') return next()
    let found
    try { found = rt.reviewGuardOfExec?.(exec) } catch { return next() }
    if (found === undefined) return next()
    rt.noteStop?.(found.sessionId, { why: found.held.why, tool: exec.name, callId: exec.callId, text: found.held.text }, exec.agent)
    return { kind: 'deny', reason: found.held.text }
  }, { prepend: true })
}
