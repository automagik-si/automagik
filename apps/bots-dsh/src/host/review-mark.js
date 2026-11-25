// The Solver's "unreviewed" mark (RFC 0048, delivery 1; #2056's soft guard). For a Bot with the
// Solver marker, the host keeps, per request in its own chat, when its first and last work calls
// ran and when its reviewer's verdicts came, and marks each delivery with what it saw: plan and
// result reviewed, plan unreviewed, result unreviewed, a fresh-session review the host cannot
// see, or no reviewer. It grants and refuses nothing, so it reads the cosmetic marker and the
// reviewer id the New Solver dialog stores (`reviewerId`). Groups, tasks and scheduled runs of a
// Solver are not marked: only its own chat (and the subagents under it).
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { SOLVER_NOTES } from '../shared/solver-method.js'
import { VERDICTS_KEPT, deliveryMark, verdictOf } from '../shared/review-mark.js'
import { guardVerdictOf } from '../shared/review-guard.js'
import { teamToolOf } from './approvals.js'
import { SOURCE_KIND } from './constants.js'
import { reachesShell } from './tool-deny.js'
import { refusal } from './refusal.js'
import {
  activeSolverLimit, cleanProgress, designateReview, invalidateResult, modelOf, newProgress,
  normalizedAutoInstruction, recordProgress, recordSolverVerdict, resultSnapshot, resumeProgress, solverOutcome, solverTracked,
} from './solver-progress.js'

// The tools that change files by name (as private-bots.js and auto-judge.js read them), after
// the `dsh` bridge's `mcp__dsh__` prefix is taken off.
const WRITE_NAMES = new Set(['write', 'edit', 'str_replace_editor', 'apply_patch'])
// Tools that start a worker or a program from outside the tool surface (tool-deny.js).
const LAUNCHERS = new Set(['start_task', 'attach_capability', 'approve_agent_action'])
const ACP_WRITE_KINDS = new Set(['edit', 'delete', 'move'])

function nativeOutcome(call, value) {
  const outcome = value?.kind === 'execute' ? value.terminalOutcome : undefined
  if (!outcome || typeof outcome !== 'object') return { reason: 'Trusted ACP terminal exit data is missing.' }
  if (typeof outcome.reason === 'string') return { reason: outcome.reason }
  if (!call.sessionId || !call.callId || !call.toolCallId || outcome.sessionId !== call.sessionId
    || outcome.callId !== call.callId || outcome.toolCallId !== call.toolCallId
    || typeof outcome.terminalId !== 'string' || outcome.terminalId === '') {
    return { reason: 'The ACP terminal outcome does not match the observed execute call.' }
  }
  return outcome
}

function nativeStartProblem(opened, request, pending, start) {
  if (!opened || opened.request !== request || opened.run !== pending.run || opened.revision !== pending.revision
    || !Number.isFinite(start?.observedAt) || !Number.isFinite(start?.startedAt) || start.startedAt < start.observedAt) {
    return 'Trusted ACP native execution start ordering is missing for this Solver run.'
  }
  if (start.startedAt <= opened.at) return 'The ACP native execution started before this Solver run was open.'
  if (start.observedAt <= opened.at) return 'The ACP execute call was queued before this Solver run was open.'
}

function effectiveCwd(cwd, directory) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return undefined
  try {
    const base = realpathSync.native(cwd)
    const path = directory === undefined ? base : isAbsolute(directory) ? directory : `${base}${sep}${directory}`
    const target = realpathSync.native(path)
    // A symlink and ".." can make logical and physical cd reach different directories.
    if (directory !== undefined && realpathSync.native(resolve(cwd, directory)) !== target) return undefined
    if (lstatSync(target).isDirectory()) return target
  } catch {}
}

export function isExplicitWorkCall(name, args) {
  if (name === 'acp_tool') return args?.image !== true && ACP_WRITE_KINDS.has(args?.kind)
  const team = teamToolOf(name)
  return WRITE_NAMES.has(team) || LAUNCHERS.has(team)
}

/**
 * Whether one call can change files or run a program: a work call. Research (read, search,
 * fetch, list_bots, message_bot, a subagent) is not.
 * @param {string} name - the tool name as the executor sees it.
 * @param {unknown} args - the call's arguments.
 * @param {object} [definition] - the tool definition, when known.
 */
export function isWorkCall(name, args, definition) {
  if (typeof name !== 'string' || name === '') return false
  if (isExplicitWorkCall(name, args)) return true
  if (name === 'acp_tool') {
    if (args === null || typeof args !== 'object' || args.image === true) return false
    const input = args.input
    return args.kind === 'execute' || (input !== null && typeof input === 'object'
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
  const solver = cleanProgress(track.solver)
  return {
    requested: track.requested === true,
    requestAt: isTime(track.requestAt) ? track.requestAt : 0,
    ...(isTime(track.personAt) ? { personAt: track.personAt } : {}),
    ...(isTime(track.firstWorkAt) ? { firstWorkAt: track.firstWorkAt } : {}),
    ...(isTime(track.lastWorkAt) ? { lastWorkAt: track.lastWorkAt } : {}),
    // The review guard (review-guard.js): when the request's plan got its verdict, and whether a
    // Bot's request opened it (and which Bot).
    ...(isTime(track.planVerdictAt) ? { planVerdictAt: track.planVerdictAt } : {}),
    ...(track.brief === true ? { brief: true } : {}),
    ...(track.openedBy === 'bot' ? { openedBy: 'bot' } : {}),
    ...(typeof track.openerExchange === 'string' ? { openerExchange: track.openerExchange } : {}),
    ...(typeof track.openerId === 'string' && track.openerId !== '' ? { openerId: track.openerId } : {}),
    verdicts,
    ...(solver ? { solver } : {}),
    ...(isRecord(track.outcome) ? { outcome: track.outcome } : {}),
    ...(track.delivered === true ? { delivered: true } : {}),
    ...(isRecord(track.last) && typeof track.last.review === 'string' ? { last: track.last } : {}),
  }
}

export function install(rt) {
  const save = () => void rt.save?.({ durable: true }).catch?.(() => {})
  // Unread host exchanges for each Bot's current request. A part switch can give
  // the inbox message a new id while keeping its exchange id and replyTo.
  const unread = new WeakMap()
  const tracked = solverTracked
  const autoInstructions = new WeakMap()
  const progressWrites = new WeakMap()
  const reviewSends = new Set()
  const folderOf = bot => bot.workDir ?? rt.teamFolder?.()
  const snapshotOf = bot => resultSnapshot(folderOf(bot))
  const deferIngress = (bot, apply) => {
    const queue = progressWrites.get(bot)
    if (queue === undefined) return false
    queue.push(apply)
    return true
  }
  const runningWork = new WeakMap()
  // Native ACP start observations use this process's monotonic clock. A reloaded run needs a fresh start.
  const nativeRunStarts = new WeakMap()
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
  const open = (bot, at, origin = 'person') => {
    unread.delete(bot)
    const { last, outcome } = cleanTrack(bot.reviewTrack) ?? {}
    bot.reviewTrack = { requested: true, requestAt: at, personAt: at, verdicts: [], solver: newProgress(origin),
      ...(last ? { last } : {}), ...(outcome ? { outcome } : {}) }
    autoInstructions.delete(bot)
  }
  const reviewOf = (bot) => {
    if (typeof bot.reviewerId !== 'string' || bot.reviewerId === '') return 'fresh'
    return rt.botOf(bot.reviewerId) === undefined ? 'none' : 'bot'
  }

  // A Solver just made, with the brief it was made with (its first request) or none (a greeting).
  function reviewCreated(bot, brief) {
    if (!tracked(bot)) return
    if (brief) {
      open(bot, bot.createdAt ?? Date.now(), bot.createdBy ? 'bot' : 'person')
      bot.reviewTrack.brief = true
    } else trackOf(bot)
  }

  // A person's message in the Solver's own chat. After a delivery, or with no request open, it
  // opens the next request; while one is open (the Solver waits for its reviewer) it only dates the
  // person's last message, so reviewer work opened before it no longer holds the delivery (SR4-1).
  function reviewRequest(botId, input = {}) {
    const bot = rt.botOf(botId)
    if (!tracked(bot)) return
    const { text, question, trustedAuto = true } = input
    const queue = progressWrites.get(bot)
    if (queue) return new Promise((resolve, reject) => {
      queue.push(() => {
        try { resolve(reviewRequest(botId, input)) } catch (error) { reject(error) }
      })
    })
    const before = bot.reviewTrack
    let track = cleanTrack(before)
    const instruction = trustedAuto ? normalizedAutoInstruction(text) : undefined
    // omp's native adapter has no team-tool bridge.
    const noProgressTool = (bot.appliedModel ?? bot.model)?.startsWith('acp-omp/') === true
    const remember = current => {
      if (current.solver.origin === 'person' && instruction && !noProgressTool) {
        autoInstructions.set(bot, { request: current.solver.request, instruction })
      } else {
        autoInstructions.delete(bot)
      }
      return current.solver.request
    }
    if (track?.requested === true && track.delivered !== true) {
      track.solver ??= newProgress(track.openedBy === 'bot' ? 'bot' : 'person')
      const limit = activeSolverLimit(bot, track) ?? track.solver.limit
      if (question !== undefined && (!limit || limit.question !== question)) return
      track.personAt = Date.now()
      if (track.solver.plan && !instruction) invalidateResult(track.solver)
      const directAuto = noProgressTool && instruction && track.solver.origin === 'person' && !track.solver.auto
      if (limit || directAuto) {
        if (limit) resumeProgress(track.solver, limit)
        if (directAuto) track.solver.auto = true
        return saveProgress(bot, before, track.solver, track, () => remember(track)).then(() => track.solver.request)
      }
      bot.reviewTrack = track
    } else {
      if (question !== undefined) return
      open(bot, Date.now())
      track = bot.reviewTrack
      if (noProgressTool && instruction) track.solver.auto = true
    }
    save()
    return remember(track)
  }

  // Keep input and review events ordered with the durable write, including the interval
  // between rename and directory sync. A replacement team still produces a conflict.
  async function saveProgress(bot, before, solver, next = { ...before, solver }, onCommit) {
    if (progressWrites.has(bot)) throw refusal('A Solver progress update is still being saved.')
    const assertCurrent = () => {
      if (rt.botOf(bot.id) !== bot || bot.reviewTrack !== before) throw refusal('The Solver request changed. Read solver_progress status again.')
    }
    const queue = []
    progressWrites.set(bot, queue)
    try {
      await rt.saveCopy(copy => {
        assertCurrent()
        copy.bots[bot.id].reviewTrack = next
      }, {
        durable: true,
        beforeCommit: assertCurrent,
        afterWrite: () => {
          assertCurrent()
          bot.reviewTrack = next
          onCommit?.()
        },
      })
    } finally {
      progressWrites.delete(bot)
      for (const apply of queue) {
        try { apply() } catch (error) { rt.warn('omni-ui: deferred Solver event failed: %s', error) }
      }
    }
  }

  async function solverProgress(bot, own, args) {
    if (!own || !tracked(bot)) return 'Only a Solver records its progress, in its own chat.'
    const before = bot.reviewTrack
    const track = cleanTrack(before)
    if (!track?.requested || track.delivered) return 'There is no active Solver request in this chat.'
    if (progressWrites.has(bot)) return 'A Solver progress update is still being saved.'
    track.solver = structuredClone(track.solver ?? newProgress(track.openedBy === 'bot' ? 'bot' : 'person'))
    if (args.action === 'status') {
      if (!before.solver) await saveProgress(bot, before, track.solver)
      const { request, plan, pending, auto } = track.solver
      return [`Request: ${request}`, `Mode: ${bot.solverAuto === true || auto ? 'Auto' : 'Normal'}`,
        ...(plan ? [`Agreed check IDs: ${plan.checks.join(', ')}`] : []),
        ...(pending ? [`Open check run: ${pending.run}`] : []),
        ...(activeSolverLimit(bot, track) ? ['Work is held for the person.'] : []),
      ].join('\n')
    }
    if (args.request !== track.solver.request) return 'Use the active request ID from solver_progress status.'
    const authority = autoInstructions.get(bot)
    const changed = recordProgress(bot, track, args, {
      now: Date.now(),
      authorizedAuto: authority?.request === args.request && authority.instruction === normalizedAutoInstruction(args.quote),
      running: runningWork.has(bot),
      snapshotOf: () => snapshotOf(bot),
    })
    if (changed.changed) {
      const onStart = args.action === 'start' ? () => {
        const { request, pending: { run, revision } } = track.solver
        nativeRunStarts.set(bot, { request, run, revision, at: performance.now() })
      } : undefined
      await saveProgress(bot, before, track.solver, undefined, onStart)
      if (args.action === 'auto' && autoInstructions.get(bot) === authority) autoInstructions.delete(bot)
    }
    return changed.text
  }

  async function solverReview(bot, reviewer, own, { kind, request, exchangeId, agent, prepare }) {
    const before = bot.reviewTrack
    const track = cleanTrack(before)
    if (!own || !tracked(bot) || bot.reviewerId !== reviewer.id || !track?.solver
      || !track.requested || track.delivered || track.solver.request !== request) {
      throw refusal('Use the active Solver request and its designated reviewer in your own chat.')
    }
    if (progressWrites.has(bot) || runningWork.has(bot)) throw refusal('Finish the current Solver work before requesting a review.')
    const progress = structuredClone(track.solver)
    const prior = kind === 'plan' ? progress.plan?.review : progress.review
    if (prior && prior.verdict === undefined && (reviewSends.has(prior.exchangeId) || rt.deliveryNote?.(prior.exchangeId)
      || rt.exchangeOf?.(prior.exchangeId, bot.id, reviewer.id))) {
      throw refusal('A designated review is already waiting for its answer.')
    }
    const issue = designateReview(progress, { kind, exchangeId, reviewerId: reviewer.id,
      model: modelOf(rt, agent), snapshot: kind === 'result' ? snapshotOf(bot) : undefined })
    if (issue) throw refusal(issue)
    const prepared = await prepare(progress.plan.checks, progress.plan.commands)
    if (prepared === undefined) return
    if (runningWork.has(bot) || (kind === 'result' && progress.snapshot !== snapshotOf(bot))) {
      throw refusal('The Solver result changed. Verify the current checks before requesting a review.')
    }
    reviewSends.add(exchangeId)
    try {
      await saveProgress(bot, before, progress)
      if (prior && prior.verdict === undefined) rt.dropWork(prior.exchangeId)
    } catch (error) {
      reviewSends.delete(exchangeId)
      throw error
    }
    return prepared
  }

  async function solverQuestion(botId, callId) {
    const bot = rt.botOf(botId)
    const before = bot?.reviewTrack
    const track = cleanTrack(before)
    const limit = activeSolverLimit(bot, track)
    if (!limit) return
    if (progressWrites.has(bot)) throw refusal('A Solver progress update is still being saved.')
    await saveProgress(bot, before, { ...track.solver, limit: { ...limit, question: callId } })
  }

  // A call the executor let through, on a Session of `bot`; `own`: the Session is its own
  // chat or a subagent under it; `base`: the Session's folder.
  function reviewWork(bot, own, name, args, definition, base) {
    if (!own || !tracked(bot) || !isWorkCall(name, args, definition)) return
    const folder = bot.workDir ?? rt.teamFolder?.()
    const notes = isNotesWrite(name, args, folder, base ?? folder)
    if (deferIngress(bot, () => reviewWork(bot, own, name, args, definition, base))) return
    const track = trackOf(bot)
    if (track.delivered === true) return
    const at = Date.now()
    // A write to exactly the notes file never dates the plan side (SR4-2), but it is still work
    // for the result: a verdict must follow it (SR5-1).
    if (!notes) track.firstWorkAt ??= at
    track.lastWorkAt = at
    save()
  }

  // Bind an open check run at admission. For ordinary commands, check the result
  // tree at completion. Other work still invalidates evidence before it runs.
  async function solverBeforeWork(bot, { relevant, checkCommand, compareResult, shellCommand, nativeCommand, nativeCall, call, approvalOnly }) {
    const before = bot.reviewTrack
    const track = cleanTrack(before)
    if (!relevant || !track?.requested || track.delivered || !track.solver?.plan) return
    const progress = track.solver
    const pending = progress.pending
    const compareOnExit = compareResult && !pending
    if (pending && checkCommand && call) {
      if (pending.call !== call) {
        // The native execute may be over by the time its mirror appears.
        progress.pending = { ...pending, call }
        await saveProgress(bot, before, progress)
      }
    } else if (!compareOnExit && (progress.passed.length > 0 || progress.review)) {
      invalidateResult(progress)
      await saveProgress(bot, before, progress)
    }
    if (approvalOnly) return
    const work = runningWork.get(bot) ?? new Set()
    const token = {}
    work.add(token)
    runningWork.set(bot, work)
    return async result => {
      try {
        if (pending && checkCommand && call) {
          const agreed = pending.checks.length === 1 && progress.plan.commands?.[pending.checks[0]]
          await observeCheck(bot, { request: progress.request, run: pending.run, revision: pending.revision,
            call, agreed, shellCommand, nativeCommand, nativeCall, result })
        } else if (compareOnExit) {
          await observeResult(bot, progress.request, progress.revision)
        }
      } finally {
        work.delete(token)
        if (work.size === 0) runningWork.delete(bot)
      }
    }
  }

  async function observeResult(bot, request, revision) {
    if (rt.botOf(bot.id) !== bot) return
    const queue = progressWrites.get(bot)
    if (queue) return new Promise((resolve, reject) => {
      queue.push(() => { observeResult(bot, request, revision).then(resolve, reject) })
    })
    const before = bot.reviewTrack
    const track = cleanTrack(before)
    const progress = track?.solver
    if (!track?.requested || track.delivered || progress?.request !== request || progress.revision !== revision) return
    if (!progress.snapshot && !progress.review) return
    if (progress.snapshot && progress.snapshot === snapshotOf(bot)) return
    invalidateResult(progress)
    await saveProgress(bot, before, progress)
  }

  async function observeCheck(bot, { request, run, revision, call, agreed, shellCommand, nativeCommand, nativeCall, result }) {
    const before = bot.reviewTrack
    const progress = cleanProgress(before?.solver)
    const pending = progress?.pending
    if (progress?.request !== request || pending?.run !== run || pending.call !== call || pending.revision !== revision) return
    const value = result?.isError === false ? result.value : undefined
    const outcome = nativeCall ? nativeOutcome(nativeCall, value) : value
    const command = nativeCommand ? nativeCommand.command : shellCommand
    const startProblem = nativeCall && nativeStartProblem(nativeRunStarts.get(bot), request, pending, value?.terminalStart)
    const directory = nativeCommand?.directory
    // Bash can search CDPATH unless the operand is absolute or starts with a . or .. component.
    const cdpathSensitive = directory !== undefined && !isAbsolute(directory) && !/^\.\.?(?:\/|$)/.test(directory)
    const folder = nativeCall ? effectiveCwd(folderOf(bot)) : folderOf(bot)
    const cwd = nativeCall ? (cdpathSensitive ? undefined : effectiveCwd(outcome?.cwd, directory)) : outcome?.cwd
    const scope = typeof folder === 'string' && typeof cwd === 'string' && isAbsolute(cwd) ? relative(folder, cwd) : undefined
    const known = nativeCall ? Number.isInteger(outcome.exitCode)
      : outcome?.kind === 'foreground' && Number.isInteger(outcome.exitCode)
        && outcome.signal === null && outcome.timedOut === false && outcome.aborted === false
        && !outcome.stopped && !outcome.sandbox?.denied && !outcome.sandbox?.runnerFailed
    const scoped = scope !== undefined && !isAbsolute(scope) && scope !== '..' && !scope.startsWith(`..${sep}`)
    const snapshot = snapshotOf(bot)
    let reason = nativeCommand?.reason
    if (!reason && (!command || command !== agreed)) reason = 'The observed command does not match one agreed check.'
    if (!reason && !known) reason = outcome?.reason ?? 'A completed foreground check outcome is missing.'
    if (!reason && startProblem) reason = startProblem
    if (!reason && cdpathSensitive) reason = 'The check working directory depends on CDPATH and only the initial directory is known.'
    if (!reason && !scoped) reason = 'The check working directory could not be verified within the result root.'
    if (!reason && !pending.startSnapshot) reason = 'The pre-run result snapshot is unavailable.'
    if (!reason && !snapshot) reason = 'The result snapshot at completion is unavailable.'
    if (!reason && pending.startSnapshot !== snapshot) reason = 'The result changed between the start and the outcome.'
    if (!reason && revision !== progress.revision) reason = 'The Solver revision changed during the run.'
    if (reason) invalidateResult(progress)
    const verifiedOutcome = known && command && command === agreed && !startProblem && !cdpathSensitive
    progress.pending = { ...pending, evidence: { call, ...(verifiedOutcome ? { pass: outcome.exitCode === 0 } : {}),
      ...(reason ? { reason } : { snapshot }) } }
    await saveProgress(bot, before, progress)
  }

  function rememberReply(bot, exchangeId, reviewerId, replyTo, workAt) {
    let replies = unread.get(bot)
    if (replies === undefined) unread.set(bot, replies = new Map())
    const reply = { exchangeId, reviewerId, replyTo, workAt, release: () => replies.delete(exchangeId) }
    replies.set(exchangeId, reply)
    return reply
  }

  // A live DSH Session can outlast the plugin. Its delivery notes keep the identity
  // of recorded replies until the corresponding input is taken or definitively lost.
  function unreadReplies(bot) {
    const track = bot?.reviewTrack
    if (track?.requested !== true || track.delivered === true) return
    for (const args of rt.unreadReviewReplies?.(bot.id) ?? []) {
      const { requestAt, workAt } = args.reviewReply
      if (requestAt === track.requestAt && isTime(workAt) && workAt >= requestAt
        && args.fromId === bot.reviewerId && !unread.get(bot)?.has(args.exchangeId)) {
        rememberReply(bot, args.exchangeId, args.fromId, args.replyTo, workAt)
      }
    }
    return unread.get(bot)
  }

  const retire = (reply) => {
    reply.release()
    rt.forgetDelivery?.(reply.exchangeId)
  }

  // A reply going from `fromId` to the Bot `toId` that asked it. The Solver's own reviewer
  // answering work from its own chat can hold delivery even if the reply has no verdict.
  // `workAt`: when the work it answers was opened. A reply to work opened before this request (a
  // late verdict on the last one), or to no open work at all, is not this request's review (SR3-2).
  // The guard's own strict reading (guardVerdictOf) dates the plan's verdict once per request, for
  // every tracked Bot, so a guard turned on mid-request reads a verdict that already came.
  function reviewVerdict(fromId, toId, roomId, text, workAt, reply, model) {
    const bot = rt.botOf(toId)
    if (roomId !== undefined || !tracked(bot) || bot.reviewerId !== fromId || fromId === toId) return
    if (typeof workAt !== 'number') return
    const track = trackOf(bot)
    if (track.delivered === true || workAt < track.requestAt) return
    const applyVerdict = () => {
      const current = trackOf(bot)
      if (current.requestAt !== track.requestAt || current.delivered || bot.reviewerId !== fromId) return
      reviewSends.delete(reply?.replyTo)
      const verdict = verdictOf(text)
      const reviewer = rt.botOf(fromId)
      const planVerdict = guardVerdictOf(text, reviewer?.name)
      if (verdict === undefined && planVerdict === undefined && reply === undefined) return
      const at = Date.now()
      if (planVerdict !== undefined) current.planVerdictAt ??= at
      if (verdict !== undefined) current.verdicts = [...current.verdicts, { verdict, at }].slice(-VERDICTS_KEPT)
      if (reviewer) {
        const strict = planVerdict === 'SHIP' && ['FIX-FIRST', 'BLOCKED'].includes(verdict) ? verdict : planVerdict
        recordSolverVerdict(current.solver, reply?.replyTo, reviewer, strict, model)
      }
      save()
    }
    if (!deferIngress(bot, applyVerdict)) applyVerdict()
    if (reply === undefined || !track.requested || !isTime(workAt)) return
    const { requestAt } = track
    // Only the delivery that appends this exchange can start its hold.
    return () => {
      if (rt.botOf(toId) !== bot || bot.reviewTrack?.requestAt !== requestAt || bot.reviewTrack.delivered === true
        || bot.reviewerId !== fromId) return
      const recorded = rememberReply(bot, reply.exchangeId, fromId, reply.replyTo, workAt)
      rt.noteReviewReply?.(reply.exchangeId, { requestAt, workAt })
      return () => retire(recorded)
    }
  }

  const matches = (reply, source) => source?.kind === SOURCE_KIND && source.role === 'reply'
    && source.exchangeId === reply.exchangeId && source.senderSessionId === reply.reviewerId && source.replyTo === reply.replyTo

  const replyAt = (sessionId, source) => {
    if (source?.kind !== SOURCE_KIND || source.role !== 'reply') return
    const past = rt.pastOwners.get(sessionId)
    const bot = rt.botOf(rt.chatOwners.get(sessionId) ?? (past?.roomId === undefined ? past?.botId : undefined))
    const reply = unreadReplies(bot)?.get(source.exchangeId)
    if (reply !== undefined && matches(reply, source)) return reply
  }

  const agentSession = agent => agent?.session?.id ?? agent?.id
  rt.ctx.on('session/event', (session, event) => {
    if (event.type === 'user/message') replyAt(session.id, event.data?.source)?.release()
  })
  rt.ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const sessionId = agentSession(agent)
    const reply = replyAt(sessionId, message?.source)
    if (reply !== undefined) reply.claim = { sessionId, turn }
  })
  rt.ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    const reply = replyAt(agentSession(agent), message?.source)
    if (reply === undefined) return
    reply.claim = undefined
    reply.withdrawal = undefined
  })
  function reviewReplyDiscarded(agent, message) {
    const reply = replyAt(agentSession(agent), message?.source)
    if (reply === undefined) return false
    if (rt.wakeLog?.movingInbox) return true
    // DSH edit and steer remove and reinsert in one operation. Give the matching
    // insertion a chance to cancel the withdrawal before treating it as final.
    const withdrawal = {}
    reply.withdrawal = withdrawal
    queueMicrotask(() => { if (reply.withdrawal === withdrawal) retire(reply) })
    return true
  }

  function reviewReplyTurnEnd(sessionId, data) {
    const bot = rt.botOf(rt.chatOwners.get(sessionId))
    const replies = unreadReplies(bot)
    if (!replies?.size || rt.updateHold?.closed || rt.updateShuttingDown?.()
      || rt.cutByRestart?.(data?.reason) || data?.reason?.reason?.kind === 'disposed') return
    for (const reply of replies.values()) {
      const claim = reply.claim
      if (claim?.sessionId !== sessionId || claim.turn !== data?.turn) continue
      // The switch may have taken the proposed input in pre-step. Wait for it
      // to finish moving input before retiring the claim that ended unread.
      const switching = rt.afterBotInputSwitch?.(sessionId, (messages) => {
        if (replies.get(reply.exchangeId) !== reply || reply.claim !== claim) return
        if (messages.some(message => matches(reply, message.source))) reply.claim = undefined
        else retire(reply)
      })
      if (!switching && !rt.carriesBotInput?.(sessionId)) retire(reply)
    }
  }

  // Another Bot's message_bot request in a guarded Solver's own chat (turns.js, first arrival
  // only). Before the plan's verdict it joins the review still to come. After it, and before the
  // delivery, it opens a new track that needs its own plan verdict (H6-2 (b)), keeping the person's
  // last message (H7-1); a message that asks no reply, a follow-up from the Bot that opened the
  // current track, and the reviewer's own message leave the track unchanged (H7-2 (a), A1): dating
  // `personAt` would let a turn end deliver past the reviewer (H7-1).
  // After a delivery (or with none asked yet) a request opens the next track; a no-reply message
  // and the reviewer's own message open nothing.
  function reviewBotRequest(botId, senderId, { noReply = false, exchangeId } = {}) {
    const bot = rt.botOf(botId)
    if (!tracked(bot) || typeof senderId !== 'string' || senderId === botId) return
    if (deferIngress(bot, () => reviewBotRequest(botId, senderId, { noReply, exchangeId }))) return
    const track = cleanTrack(bot.reviewTrack)
    const dates = noReply || senderId === bot.reviewerId
    if (track?.requested === true && track.delivered !== true) {
      if (dates || senderId === track.openerId) return
      const progress = track.solver
      if (progress?.plan || progress?.pending || progress?.review) {
        invalidateResult(progress)
        if (progress.plan) progress.plan = { checks: progress.plan.checks, revision: progress.plan.revision, superseded: true }
        bot.reviewTrack = track
        save()
      }
      autoInstructions.delete(bot)
      if (bot.reviewGuard !== true || !isTime(track.planVerdictAt)) {
        return
      }
      open(bot, Date.now(), 'bot')
      if (progress) bot.reviewTrack.solver = progress
      if (isTime(track.personAt)) bot.reviewTrack.personAt = track.personAt
      else delete bot.reviewTrack.personAt
    } else {
      if (dates) return
      open(bot, Date.now(), 'bot')
    }
    bot.reviewTrack.openedBy = 'bot'
    bot.reviewTrack.openerId = senderId
    if (typeof exchangeId === 'string') bot.reviewTrack.openerExchange = exchangeId
    save()
  }

  // A turn of the Solver's own chat ended. A completed turn that wrote text, for an open request,
  // with nothing out to its reviewer, is a delivery: it is marked once per request. Reviewer work
  // opened before the person's last message does not hold it: a person who asks for the delivery
  // first gets it (SR3-3 (b)), and the late verdict on that work is dropped (SR4-1).
  function reviewTurnEnd(botId, turn) {
    const { completed, wroteText, model, request, trigger } = turn
    const bot = rt.botOf(botId)
    if (!tracked(bot) || !completed || !wroteText) return
    if (deferIngress(bot, () => reviewTurnEnd(botId, turn))) return
    const track = cleanTrack(bot.reviewTrack)
    if (track?.requested !== true || track.delivered === true) return
    if (activeSolverLimit(bot, track) || runningWork.has(bot)) return
    if (Object.hasOwn(turn, 'request') && track.solver) {
      const progress = track.solver
      const ownReview = trigger?.role === 'reply' && trigger.senderSessionId === bot.reviewerId
        && typeof trigger.replyTo === 'string'
        && [progress.plan?.review?.exchangeId, progress.review?.exchangeId].includes(trigger.replyTo)
      const botRequest = progress.origin === 'bot' && typeof track.openerExchange === 'string' && trigger?.exchangeId === track.openerExchange
      const brief = track.brief === true && (trigger === undefined || trigger.role === 'kickoff')
      if (!(request === progress.request || ownReview || botRequest || brief)) return
    }
    bot.reviewTrack = track
    const review = reviewOf(bot)
    const works = Object.values(rt.state?.works ?? {})
    if (review === 'bot' && works.some(work => work?.from === bot.id && work?.to === bot.reviewerId && !(typeof track.personAt === 'number' && typeof work.at === 'number' && work.at < track.personAt))) return
    if (review === 'bot' && [...(unreadReplies(bot)?.values() ?? [])].some(reply =>
      reply.reviewerId === bot.reviewerId && !(typeof track.personAt === 'number' && reply.workAt < track.personAt))) return
    // Reviewer work this request opened, still out when the person asked: delivered before its
    // verdict (Run 3). Work left from an earlier request is not this one's.
    const pending = review === 'bot' && works.some(work => work?.from === bot.id && work?.to === bot.reviewerId && typeof work.at === 'number' && work.at >= track.requestAt)
    track.outcome = solverOutcome(bot, track, review, pending, model, track.solver?.snapshot ? snapshotOf(bot) : undefined)
    track.last = { ...deliveryMark(track, review, Date.now(), { pending }), ...(track.outcome.done
      ? { done: true, reviewer: track.outcome.reviewer, plan: true, result: true, resultExchangeId: track.outcome.exchangeId } : {}) }
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

  const solverStatusOf = (bot, stored = bot?.reviewTrack) => {
    const track = cleanTrack(stored)
    if (!tracked(bot) && !track?.solver && !track?.outcome) return {}
    const limit = activeSolverLimit(bot, track)
    return { solverStatus: {
      ...(track?.requested && !track.delivered ? { auto: track.solver?.auto === true } : {}),
      ...(limit ? { limit: { kind: limit.kind, check: limit.check } } : {}),
      ...(track?.outcome ? { outcome: track.outcome } : {}),
    } }
  }

  Object.assign(rt, { reviewCreated, reviewRequest, reviewBotRequest, reviewWork, reviewVerdict, reviewReplyTurnEnd, reviewReplyDiscarded, reviewTurnEnd, reviewMarkOf,
    solverProgress, solverReview, solverQuestion, solverStatusOf, solverBeforeWork,
    solverReviewSent: exchangeId => reviewSends.delete(exchangeId),
    solverProgressBusy: bot => progressWrites.has(bot) })
}
