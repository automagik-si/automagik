// The Solver's "unreviewed" mark (RFC 0048, delivery 1; #2056's soft guard). For a Bot with the
// Solver marker, the host keeps, per request in its own chat, when its first and last work calls
// ran and when its reviewer's verdicts came, and marks each delivery with what it saw: plan and
// result reviewed, plan unreviewed, result unreviewed, a fresh-session review the host cannot
// see, or no reviewer. It grants and refuses nothing, so it reads the cosmetic marker and the
// reviewer id the New Solver dialog stores (`reviewerId`). Groups, tasks and scheduled runs of a
// Solver are not marked: only its own chat (and the subagents under it).
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { SOLVER_NOTES, isSolverBot } from '../shared/solver-method.js'
import { VERDICTS_KEPT, deliveryMark, verdictOf } from '../shared/review-mark.js'
import { guardVerdictOf } from '../shared/review-guard.js'
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

// The tools that write one file, and the argument naming it (private-bots.js).
const ONE_FILE = { write: 'file_path', edit: 'file_path', str_replace_editor: 'path' }
const PATH_KEYS = /^(file_path|filePath|file|path|paths)$/
const pathsIn = (value, depth = 0) => depth > 4 || value === null || typeof value !== 'object' ? []
  : Object.entries(value).flatMap(([key, item]) => PATH_KEYS.test(key)
    ? (typeof item === 'string' ? [item] : Array.isArray(item) ? item.map(entry => (typeof entry === 'string' ? entry : '')) : [''])
    : pathsIn(item, depth + 1))

/**
 * Whether `path` is exactly the Solver's notes file (SOLVER_NOTES) in `folder`, the Bot's folder:
 * relative paths resolve against `base`, the call's folder. No `..` segment, no prefix match, and no
 * symlink (or hard link) on the way: anything else is not the notes file (#2056 SR4-2).
 */
export function isNotesPath(path, folder, base = folder) {
  if (typeof path !== 'string' || path === '' || path.includes('\0') || typeof folder !== 'string' || folder === '') return false
  if (path.split(/[\\/]/).includes('..') || /[\\/]$/.test(path)) return false
  if (!isAbsolute(path) && (typeof base !== 'string' || base === '')) return false
  const target = isAbsolute(path) ? resolve(path) : resolve(base, path)
  const [dir, file] = SOLVER_NOTES.split('/')
  if (basename(target) !== file || basename(dirname(target)) !== dir) return false
  const kind = (at) => {
    try { return lstatSync(at) } catch (error) { return error?.code === 'ENOENT' ? null : undefined }
  }
  try {
    if (realpathSync(dirname(dirname(target))) !== realpathSync(folder)) return false
  } catch { return false }
  const notesDir = kind(dirname(target))
  if (notesDir === undefined || (notesDir !== null && (notesDir.isSymbolicLink() || !notesDir.isDirectory()))) return false
  const notes = kind(target)
  if (notes === undefined || (notes !== null && (notesDir === null || !notes.isFile() || notes.nlink > 1))) return false
  return true
}

/**
 * Whether one call writes only the Solver's notes file: a one-file write tool (through the `dsh`
 * bridge too), or an ACP agent's own edit whose every path is that file.
 */
export function isNotesWrite(name, args, folder, base) {
  if (typeof name !== 'string' || args === null || typeof args !== 'object') return false
  const key = ONE_FILE[teamToolOf(name)]
  if (key !== undefined) return isNotesPath(args[key], folder, base)
  if (name !== 'acp_tool' || args.kind !== 'edit' || args.image === true) return false
  const input = args.input
  if (input !== null && typeof input === 'object' && (Object.hasOwn(input, 'command') || Object.hasOwn(input, 'cmd'))) return false
  const locations = Array.isArray(args.locations) ? args.locations.map(entry => (typeof entry?.path === 'string' ? entry.path : '')) : []
  const paths = [...pathsIn(input), ...locations]
  return paths.length > 0 && paths.every(path => isNotesPath(path, folder, base))
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isTime = value => typeof value === 'number' && Number.isFinite(value)

/**
 * A stored review track, kept as the host writes it, or undefined when it is not one. Fields of
 * the wrong type are dropped, and only well-formed verdicts and the last mark kept.
 * @param {unknown} track - `bot.reviewTrack` as loaded.
 */
export function cleanTrack(track) {
  if (!isRecord(track)) return undefined
  const verdicts = Array.isArray(track.verdicts)
    ? track.verdicts.filter(entry => isRecord(entry) && typeof entry.verdict === 'string' && isTime(entry.at)).slice(-VERDICTS_KEPT)
    : []
  return {
    requested: track.requested === true,
    requestAt: isTime(track.requestAt) ? track.requestAt : 0,
    ...(isTime(track.personAt) ? { personAt: track.personAt } : {}),
    ...(isTime(track.firstWorkAt) ? { firstWorkAt: track.firstWorkAt } : {}),
    ...(isTime(track.lastWorkAt) ? { lastWorkAt: track.lastWorkAt } : {}),
    // The review guard (review-guard.js): when the request's plan got its verdict, and whether a
    // Bot's request opened it (and which Bot).
    ...(isTime(track.planVerdictAt) ? { planVerdictAt: track.planVerdictAt } : {}),
    ...(track.openedBy === 'bot' ? { openedBy: 'bot' } : {}),
    ...(typeof track.openerId === 'string' && track.openerId !== '' ? { openerId: track.openerId } : {}),
    verdicts,
    ...(track.delivered === true ? { delivered: true } : {}),
    ...(isRecord(track.last) && typeof track.last.review === 'string' ? { last: track.last } : {}),
  }
}

export function install(rt) {
  const save = () => void rt.save?.().catch?.(() => {})
  // A guarded Bot stays tracked whatever its role says: the guard never reads the marker.
  const tracked = bot => bot !== undefined && (isSolverBot(bot) || bot.reviewGuard === true)
  // The record of the request in progress: { requested, requestAt, personAt, firstWorkAt,
  // lastWorkAt, verdicts, delivered, last }. `requested`: a person asked for something (a message
  // in its own chat, or the brief it was made with), so the next delivery answers it; a greeting
  // does not. `personAt`: the person's last message in it. `last` is the last delivery's mark,
  // which the view shows. `planVerdictAt`: the first verdict that opened a guarded Solver's work
  // in it; `openedBy: 'bot'` and `openerId`: a Bot's request opened it (reviewBotRequest).
  // A stored track is read as the host wrote it, or repaired: a corrupted state.json must not
  // throw on a reply, a tool call or a turn's end (SR3-6).
  const trackOf = (bot) => {
    const track = cleanTrack(bot.reviewTrack)
    bot.reviewTrack = track ?? { requested: false, requestAt: bot.createdAt ?? 0, verdicts: [] }
    return bot.reviewTrack
  }
  const open = (bot, at) => {
    const last = cleanTrack(bot.reviewTrack)?.last
    bot.reviewTrack = { requested: true, requestAt: at, personAt: at, verdicts: [], ...(last ? { last } : {}) }
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
  // opens the next request; while one is open (the Solver waits for its reviewer) it only dates the
  // person's last message, so reviewer work opened before it no longer holds the delivery (SR4-1).
  function reviewRequest(botId) {
    const bot = rt.botOf(botId)
    if (!tracked(bot)) return
    const track = cleanTrack(bot.reviewTrack)
    if (track?.requested === true && track.delivered !== true) {
      track.personAt = Date.now()
      bot.reviewTrack = track
      save()
      return
    }
    open(bot, Date.now())
    save()
  }

  // A call the executor let through, on a Session of `bot`; `own`: the Session is its own
  // chat or a subagent under it; `base`: the Session's folder.
  function reviewWork(bot, own, name, args, definition, base) {
    if (!own || !tracked(bot) || !isWorkCall(name, args, definition)) return
    const folder = bot.workDir ?? rt.teamFolder?.()
    const notes = isNotesWrite(name, args, folder, base ?? folder)
    const track = trackOf(bot)
    if (track.delivered === true) return
    const at = Date.now()
    // A write to exactly the notes file never dates the plan side (SR4-2), but it is still work
    // for the result: a verdict must follow it (SR5-1).
    if (!notes) track.firstWorkAt ??= at
    track.lastWorkAt = at
    save()
  }

  // A reply going from `fromId` to the Bot `toId` that asked it. It counts only when it is the
  // Solver's own reviewer answering a request from the Solver's own chat, and opens with a verdict.
  // `workAt`: when the work it answers was opened. A reply to work opened before this request (a
  // late verdict on the last one), or to no open work at all, is not this request's review (SR3-2).
  // The guard's own strict reading (guardVerdictOf) dates the plan's verdict once per request, for
  // every tracked Bot, so a guard turned on mid-request reads a verdict that already came.
  function reviewVerdict(fromId, toId, roomId, text, workAt) {
    const bot = rt.botOf(toId)
    if (roomId !== undefined || !tracked(bot) || bot.reviewerId !== fromId || fromId === toId) return
    if (typeof workAt !== 'number') return
    const verdict = verdictOf(text)
    const planVerdict = guardVerdictOf(text, rt.botOf(fromId)?.name)
    if (verdict === undefined && planVerdict === undefined) return
    const track = trackOf(bot)
    if (track.delivered === true || workAt < track.requestAt) return
    const at = Date.now()
    if (planVerdict !== undefined) track.planVerdictAt ??= at
    if (verdict !== undefined) track.verdicts = [...track.verdicts, { verdict, at }].slice(-VERDICTS_KEPT)
    save()
  }

  // Another Bot's message_bot request in a guarded Solver's own chat (turns.js, first arrival
  // only). Before the plan's verdict it joins the review still to come. After it, and before the
  // delivery, it opens a new track that needs its own plan verdict (H6-2 (b)), keeping the person's
  // last message (H7-1); a message that asks no reply, a follow-up from the Bot that opened the
  // current track, and the reviewer's own message leave the track unchanged (H7-2 (a), A1): dating
  // `personAt` would let a turn end deliver past the reviewer (H7-1).
  // After a delivery (or with none asked yet) a request opens the next track; a no-reply message
  // and the reviewer's own message open nothing.
  function reviewBotRequest(botId, senderId, { noReply = false } = {}) {
    const bot = rt.botOf(botId)
    if (bot?.reviewGuard !== true || typeof senderId !== 'string' || senderId === botId) return
    const track = cleanTrack(bot.reviewTrack)
    const dates = noReply || senderId === bot.reviewerId
    if (track?.requested === true && track.delivered !== true) {
      if (!isTime(track.planVerdictAt)) return
      if (dates || senderId === track.openerId) return
      open(bot, Date.now())
      if (isTime(track.personAt)) bot.reviewTrack.personAt = track.personAt
      else delete bot.reviewTrack.personAt
    } else {
      if (dates) return
      open(bot, Date.now())
    }
    bot.reviewTrack.openedBy = 'bot'
    bot.reviewTrack.openerId = senderId
    save()
  }

  // A turn of the Solver's own chat ended. A completed turn that wrote text, for an open request,
  // with nothing out to its reviewer, is a delivery: it is marked once per request. Reviewer work
  // opened before the person's last message does not hold it: a person who asks for the delivery
  // first gets it (SR3-3 (b)), and the late verdict on that work is dropped (SR4-1).
  function reviewTurnEnd(botId, { completed, wroteText }) {
    const bot = rt.botOf(botId)
    if (!tracked(bot) || !completed || !wroteText) return
    const track = cleanTrack(bot.reviewTrack)
    if (track?.requested !== true || track.delivered === true) return
    bot.reviewTrack = track
    const review = reviewOf(bot)
    const works = Object.values(rt.state?.works ?? {})
    if (review === 'bot' && works.some(work => work?.from === bot.id && work?.to === bot.reviewerId && !(typeof track.personAt === 'number' && typeof work.at === 'number' && work.at < track.personAt))) return
    // Reviewer work this request opened, still out when the person asked: delivered before its
    // verdict (Run 3). Work left from an earlier request is not this one's.
    const pending = review === 'bot' && works.some(work => work?.from === bot.id && work?.to === bot.reviewerId && typeof work.at === 'number' && work.at >= track.requestAt)
    track.last = deliveryMark(track, review, Date.now(), { pending })
    track.delivered = true
    save()
  }

  // What the view shows of it: the last delivery's mark only, never the timestamps it came from.
  // It stays once there is one, even when the Bot is no longer a Solver (SR3-8): a role change
  // must not hide the mark of the work it delivered.
  const reviewMarkOf = (bot, track = bot?.reviewTrack) => {
    const last = cleanTrack(track)?.last
    return last ? { reviewMark: { ...last } } : {}
  }

  Object.assign(rt, { reviewCreated, reviewRequest, reviewBotRequest, reviewWork, reviewVerdict, reviewTurnEnd, reviewMarkOf })
}
