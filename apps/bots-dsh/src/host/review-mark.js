// The Solver's "unreviewed" mark (RFC 0048, delivery 1; #2056's soft guard). For a Bot with the
// Solver marker, the host keeps, per request in its own chat, when its first and last work calls
// ran and when its reviewer's verdicts came, and marks each delivery with what it saw: plan and
// result reviewed, plan unreviewed, result unreviewed, a fresh-session review the host cannot
// see, or no reviewer. It grants and refuses nothing, so it reads the cosmetic marker and the
// reviewer id the New Solver dialog stores (`reviewerId`). Groups, tasks and scheduled runs of a
// Solver are not marked: only its own chat (and the subagents under it).
import { isSolverBot } from '../shared/solver-method.js'
import { VERDICTS_KEPT, deliveryMark, verdictOf } from '../shared/review-mark.js'
import { teamToolOf } from './approvals.js'
import { reachesShell } from './tool-deny.js'

// The tools that change files by name (as private-bots.js and auto-judge.js read them), after
// the `dsh` bridge's `mcp__dsh__` prefix is taken off.
const WRITE_NAMES = new Set(['write', 'edit', 'str_replace_editor', 'apply_patch'])
// Tools that start a worker or a program from outside the tool surface (tool-deny.js).
const LAUNCHERS = new Set(['start_task', 'attach_capability', 'approve_agent_action'])
// An ACP agent's own call (acp-dsh's `acp_tool`, Claude Code's and Codex's native tools) that
// changes files or runs a program.
const ACP_WORK_KINDS = new Set(['edit', 'delete', 'move', 'execute'])

/**
 * Whether one call can change files or run a program: a work call. Research (read, search,
 * fetch, list_bots, message_bot, a subagent) is not.
 * @param {string} name - the tool name as the executor sees it.
 * @param {unknown} args - the call's arguments.
 * @param {object} [definition] - the tool definition, when known.
 */
export function isWorkCall(name, args, definition) {
  if (typeof name !== 'string' || name === '') return false
  const team = teamToolOf(name)
  if (WRITE_NAMES.has(team) || LAUNCHERS.has(team)) return true
  if (name === 'acp_tool') {
    if (args === null || typeof args !== 'object' || args.image === true) return false
    const input = args.input
    return ACP_WORK_KINDS.has(args.kind) || (input !== null && typeof input === 'object'
      && (Object.hasOwn(input, 'command') || Object.hasOwn(input, 'cmd')))
  }
  return reachesShell(name, definition)
}

export function install(rt) {
  const save = () => void rt.save?.().catch?.(() => {})
  const tracked = bot => bot !== undefined && isSolverBot(bot)
  // The record of the request in progress: { requested, requestAt, firstWorkAt, lastWorkAt,
  // verdicts, delivered, last }. `requested`: a person asked for something (a message in its
  // own chat, or the brief it was made with), so the next delivery answers it; a greeting does
  // not. `last` is the last delivery's mark, which the view shows.
  const trackOf = bot => (bot.reviewTrack ??= { requested: false, requestAt: bot.createdAt ?? 0, verdicts: [] })
  const open = (bot, at) => {
    const last = bot.reviewTrack?.last
    bot.reviewTrack = { requested: true, requestAt: at, verdicts: [], ...(last ? { last } : {}) }
  }
  const reviewOf = (bot) => {
    if (typeof bot.reviewerId !== 'string' || bot.reviewerId === '') return 'fresh'
    return rt.botOf(bot.reviewerId) === undefined ? 'none' : 'bot'
  }

  // A Solver just made, with the brief it was made with (its first request) or none (a greeting).
  function reviewCreated(bot, brief) {
    if (!tracked(bot)) return
    if (brief) open(bot, bot.createdAt ?? Date.now())
    else trackOf(bot)
  }

  // A person's message in the Solver's own chat. After a delivery, or with no request open, it
  // opens the next request; while one is open (the Solver waits for its reviewer) it changes nothing.
  function reviewRequest(botId) {
    const bot = rt.botOf(botId)
    if (!tracked(bot)) return
    const track = bot.reviewTrack
    if (track?.requested === true && track.delivered !== true) return
    open(bot, Date.now())
    save()
  }

  // A call the executor let through, on a Session of `bot`; `own`: the Session is its own
  // chat or a subagent under it.
  function reviewWork(bot, own, name, args, definition) {
    if (!own || !tracked(bot) || !isWorkCall(name, args, definition)) return
    const track = trackOf(bot)
    if (track.delivered === true) return
    const at = Date.now()
    track.firstWorkAt ??= at
    track.lastWorkAt = at
    save()
  }

  // A reply going from `fromId` to the Bot `toId` that asked it. It counts only when it is the
  // Solver's own reviewer answering a request from the Solver's own chat, and opens with a verdict.
  function reviewVerdict(fromId, toId, roomId, text) {
    const bot = rt.botOf(toId)
    if (roomId !== undefined || !tracked(bot) || bot.reviewerId !== fromId || fromId === toId) return
    const verdict = verdictOf(text)
    if (verdict === undefined) return
    const track = trackOf(bot)
    if (track.delivered === true) return
    track.verdicts = [...(track.verdicts ?? []), { verdict, at: Date.now() }].slice(-VERDICTS_KEPT)
    save()
  }

  // A turn of the Solver's own chat ended. A completed turn that wrote text, for an open request,
  // with nothing out to its reviewer, is a delivery: it is marked once per request.
  function reviewTurnEnd(botId, { completed, wroteText }) {
    const bot = rt.botOf(botId)
    if (!tracked(bot) || !completed || !wroteText) return
    const track = bot.reviewTrack
    if (track?.requested !== true || track.delivered === true) return
    const review = reviewOf(bot)
    if (review === 'bot' && Object.values(rt.state?.works ?? {}).some(work => work?.from === bot.id && work?.to === bot.reviewerId)) return
    track.last = deliveryMark(track, review, Date.now())
    track.delivered = true
    save()
  }

  // What the view shows of it: the last delivery's mark only, never the timestamps it came from.
  const reviewMarkOf = (bot, track = bot?.reviewTrack) => (tracked(bot) && track?.last ? { reviewMark: { ...track.last } } : {})

  Object.assign(rt, { reviewCreated, reviewRequest, reviewWork, reviewVerdict, reviewTurnEnd, reviewMarkOf })
}
