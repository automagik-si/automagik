// The Solver's "unreviewed" mark (RFC 0048, delivery 1; #2056's soft guard). For a Bot with the
// Solver marker, the host keeps, per request in its own chat, when its first and last work calls
// ran and when its reviewer's verdicts came, and marks each delivery with what it saw: plan and
// result reviewed, plan unreviewed, result unreviewed, a fresh-session review the host cannot
// see, or no reviewer. It grants and refuses nothing, so it reads the cosmetic marker and the
// reviewer id the New Solver dialog stores (`reviewerId`). Groups, tasks and scheduled runs of a
// Solver are not marked: only its own chat (and the subagents under it).
import { chosenIdentity, chosenIdentityOf, originalReviewContent, unverifiedNotice, unverifiedReason } from '../shared/solver-model.js'
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { SOLVER_NOTES } from '../shared/solver-method.js'
import { VERDICTS_KEPT, deliveryMark, verdictOf } from '../shared/review-mark.js'
import { guardVerdictOf } from '../shared/review-guard.js'
import { teamToolOf } from './approvals.js'
import { SOURCE_KIND } from './constants.js'
import { reachesShell } from './tool-deny.js'
import { refusal } from './refusal.js'
import { nativeCheckDirectory, normalizeCheckCommand, withinCheckRoot } from './solver-check-command.js'
import {
  activeSolverLimit, cleanProgress, designateReview, imageBaseline, inspectResult, invalidateResult, legacyResultReview, modelOf, newProgress,
  normalizedAutoInstruction, recordedModelOf, recordProgress, recordSolverVerdict, resultPicturePathsAllowed, resumeProgress, solverOutcome, solverTracked,
} from './solver-progress.js'
import { readResultPicture } from './image-input.js'

// The tools that change files by name (as private-bots.js and auto-judge.js read them), after
// the `dsh` bridge's `mcp__dsh__` prefix is taken off.
const WRITE_NAMES = new Set(['write', 'edit', 'str_replace_editor', 'apply_patch'])
// Tools that start a worker or a program from outside the tool surface (tool-deny.js).
const LAUNCHERS = new Set(['start_task', 'attach_capability', 'approve_agent_action'])
const ACP_WRITE_KINDS = new Set(['edit', 'delete', 'move'])

// Cordis creates a fresh tracing proxy at each lookup of the same service.
const ORIGINAL = Symbol.for('cordis.original')
const storeIdentity = store => store?.[ORIGINAL] ?? store

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
export const pathsIn = (value, depth = 0) => depth > 4 || value === null || typeof value !== 'object' ? []
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
const matchesReview = (review, reviewerId, exchangeId) => typeof exchangeId === 'string'
  && review?.exchangeId === exchangeId && review.reviewerId === reviewerId
const isReviewVerdict = verdict => ['SHIP', 'FIX-FIRST', 'BLOCKED'].includes(verdict)
const planProof = (proof, solver, reviewerId) => isRecord(proof) && isTime(proof.at)
  && typeof proof.request === 'string' && proof.request === solver?.request
  && typeof proof.reviewerId === 'string' && proof.reviewerId === reviewerId && isReviewVerdict(proof.verdict)
  && !solver.plan?.superseded && matchesReview(solver.plan?.review, reviewerId, proof.exchangeId)
  && solver.plan.review.verdict === proof.verdict

export function planOpenAt(bot, track, { legacy = true } = {}) {
  if (!track?.requested) return undefined
  const { solver } = track
  if (planProof(track.planOpen, solver, bot?.reviewerId)) return track.planOpen.at
  const plan = solver?.plan
  if (legacy && !Object.hasOwn(track, 'planOpen') && isTime(track.planVerdictAt)
    && !plan?.superseded && typeof bot?.reviewerId === 'string'
    && matchesReview(plan?.review, bot.reviewerId, plan?.review?.exchangeId)
    && isReviewVerdict(plan.review.verdict)) return track.planVerdictAt
}
const designatedReview = (progress, reviewerId, exchangeId) => [progress?.plan?.review, progress?.review]
  .some(review => matchesReview(review, reviewerId, exchangeId))

function currentReviewStage(progress, reviewerId, exchangeId) {
  const { plan, review, revision } = progress
  if (matchesReview(review, reviewerId, exchangeId)) return review.revision === revision ? 'result' : undefined
  if (!plan?.superseded && matchesReview(plan?.review, reviewerId, exchangeId)) return 'plan'
}

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
    ...(Object.hasOwn(track, 'planOpen') ? {
      planOpen: planProof(track.planOpen, solver, track.planOpen?.reviewerId) ? { ...track.planOpen } : null,
    } : {}),
    ...(isTime(track.uncertainWorkAt) ? { uncertainWorkAt: track.uncertainWorkAt } : {}),
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
  const uploadEntries = new Map()
  const rememberReviewUpload = (path, stat) => {
    if (uploadEntries.size >= 20_000) uploadEntries.delete(uploadEntries.keys().next().value)
    uploadEntries.set(path, stat)
  }
  const managedEntry = (path, stat) => {
    const created = uploadEntries.get(path)
    return created !== undefined && created.dev === stat.dev && created.ino === stat.ino && created.mode === stat.mode
      && (stat.isDirectory() || (stat.nlink === 1n && created.size === stat.size
        && created.mtimeNs === stat.mtimeNs && created.ctimeNs === stat.ctimeNs))
  }
  const registeredDefaultWorkspace = () => {
    const team = rt.teamFolder?.()
    const fallback = rt.defaultTeamFolder?.()
    if (!team || !fallback) return
    try {
      const workspace = join(realpathSync.native(rt.home), 'workspace')
      if (realpathSync.native(fallback) === workspace && realpathSync.native(team) === workspace) return workspace
    } catch { /* The workspace must resolve to the default inside the team's home. */ }
  }
  const resultReadScope = bot => ({ allowPath: rt.resultReadAllowed?.(bot.id), teamWorkspace: registeredDefaultWorkspace() })
  const inspect = (bot, options) => inspectResult(folderOf(bot), { botId: bot.id, managedEntry,
    ...(options?.manifest ? resultReadScope(bot) : {}), ...options })
  const snapshotOf = bot => inspect(bot).snapshot
  const resultPathsAllowed = (bot, paths) => paths.length === 0 || resultPicturePathsAllowed(folderOf(bot), paths,
    { botId: bot.id, ...resultReadScope(bot) })
  const assertResultPaths = (bot, paths) => {
    if (!resultPathsAllowed(bot, paths)) throw refusal('The result picture is in a protected folder.')
  }
  const manifestsMatch = (bot, progress) => {
    const result = inspect(bot, { manifest: true })
    return result.snapshot === progress.snapshot && result.manifest?.indeterminate === false ? result.manifest : undefined
  }
  const legacyText = (bot, progress) => manifestsMatch(bot, progress)?.entries.length === 0
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
  const openedTrack = (bot, at, origin) => {
    const { last, outcome } = cleanTrack(bot.reviewTrack) ?? {}
    const solver = newProgress(origin)
    // This baseline is an internal scan of the Solver's readable result region for its newly
    // opened request. Review sends additionally require designation and passing check authority.
    solver.imageBase = imageBaseline(inspect(bot, { manifest: true }))
    return { requested: true, requestAt: at, personAt: at, verdicts: [], solver,
      ...(last ? { last } : {}), ...(outcome ? { outcome } : {}) }
  }
  const forgetPrevious = bot => {
    unread.delete(bot)
    autoInstructions.delete(bot)
  }
  const open = (bot, at, origin = 'person') => {
    bot.reviewTrack = openedTrack(bot, at, origin)
    forgetPrevious(bot)
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
      if (track.solver.plan && !instruction) {
        const progress = track.solver
        const result = progress.review
        // The restored designation can identify visual work until this follow-up invalidates it.
        if (result && result.images?.v !== 1 && (result.unverified === 'images'
          || (result.verdict === 'SHIP' && !legacyText(bot, progress)))) progress.visualReviewRequired = true
        invalidateResult(progress)
      }
      const directAuto = noProgressTool && instruction && track.solver.origin === 'person' && !track.solver.auto
      if (limit || directAuto) {
        if (limit) resumeProgress(track.solver, limit)
        if (directAuto) track.solver.auto = true
        return saveProgress(bot, before, track.solver, track, { onCommit: () => remember(track) }).then(() => track.solver.request)
      }
      bot.reviewTrack = track
    } else {
      if (question !== undefined) return
      if (bot.reviewGuard === true && planOpenAt(bot, track) !== undefined && rt.planGateClosed?.(bot) === false) {
        const next = openedTrack(bot, Date.now(), 'person')
        if (noProgressTool && instruction) next.solver.auto = true
        return saveProgress(bot, before, next.solver, next, () => {
          forgetPrevious(bot)
          remember(next)
        }).then(() => next.solver.request)
      }
      open(bot, Date.now())
      track = bot.reviewTrack
      if (noProgressTool && instruction) track.solver.auto = true
    }
    save()
    return remember(track)
  }

  // Keep input and review events ordered with the durable write, including the interval
  // between rename and directory sync. A replacement team still produces a conflict.
  async function saveProgress(bot, before, solver, next = { ...before, solver }, { onCommit, authorizeCommit } = {}) {
    if (progressWrites.has(bot)) throw refusal('A Solver progress update is still being saved.')
    const assertCurrent = () => {
      if (rt.botOf(bot.id) !== bot || bot.reviewTrack !== before) throw refusal('The Solver request changed. Read solver_progress status again.')
    }
    const queue = []
    const wasOpen = rt.planGateClosed?.(bot) === false
    progressWrites.set(bot, queue)
    try {
      await rt.saveCopy(copy => {
        assertCurrent()
        copy.bots[bot.id].reviewTrack = next
      }, {
        durable: true,
        beforeCommit: () => {
          assertCurrent()
          authorizeCommit?.()
        },
        afterWrite: () => {
          assertCurrent()
          bot.reviewTrack = next
          if (wasOpen && rt.planGateClosed?.(bot)) rt.withdrawPlanAuthority?.(bot)
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
      inspect: () => inspect(bot),
      snapshotOf: () => snapshotOf(bot),
    })
    if (changed.changed) {
      const pending = args.action === 'start' ? track.solver.pending : undefined
      const onStart = pending ? () => {
        nativeRunStarts.set(bot, { request: track.solver.request, run: pending.run, revision: pending.revision, at: performance.now() })
      } : undefined
      await saveProgress(bot, before, track.solver, undefined, { onCommit: onStart })
      if (args.action === 'auto' && autoInstructions.get(bot) === authority) autoInstructions.delete(bot)
    }
    return changed.text
  }

  async function solverReview(bot, reviewer, own, { kind, request, exchangeId, agent, prepare, pictures }) {
    const before = bot.reviewTrack
    const track = cleanTrack(before)
    if (!own || !tracked(bot) || bot.reviewerId !== reviewer.id || !track?.solver
      || !track.requested || track.delivered || track.solver.request !== request) {
      throw refusal('Use the active Solver request and its designated reviewer in your own chat.')
    }
    if (progressWrites.has(bot) || runningWork.has(bot)) throw refusal('Finish the current Solver work before requesting a review.')
    const progress = structuredClone(track.solver)
    const prior = kind === 'plan' ? progress.plan?.review : progress.review
    if (prior && prior.verdict === undefined
      && !(kind === 'result' && (legacyResultReview(prior) || prior.images?.v !== 1))
      && (reviewSends.has(prior.exchangeId) || rt.deliveryNote?.(prior.exchangeId)
        || rt.exchangeOf?.(prior.exchangeId, bot.id, reviewer.id))) {
      throw refusal('A designated review is already waiting for its answer.')
    }
    const issue = designateReview(progress, { kind, exchangeId, reviewerId: reviewer.id,
      model: modelOf(agent?.session), snapshot: kind === 'result' ? snapshotOf(bot) : undefined })
    if (issue) throw refusal(issue)
    const assertAuthority = (writing = false) => {
      pictures?.signal?.throwIfAborted()
      if (rt.botOf(bot.id) !== bot || rt.botOf(reviewer.id) !== reviewer || bot.reviewTrack !== before
        || !before.requested || before.delivered || before.solver?.request !== request || before.solver.revision !== track.solver.revision
        || bot.reviewerId !== reviewer.id || (!writing && progressWrites.has(bot)) || runningWork.has(bot)
        || (kind === 'result' && progress.snapshot !== snapshotOf(bot))) {
        throw refusal('The Solver result changed. Verify the current checks before requesting a review.')
      }
    }
    const prepared = await prepare(kind, progress.plan.checks, progress.plan.commands)
    if (prepared === undefined) return
    assertAuthority()
    let resultPictures, authorizeCommit
    if (kind === 'result') {
      resultPictures = await prepareResultPictures(bot, progress, pictures, assertAuthority)
      assertAuthority()
      authorizeCommit = () => {
        assertAuthority(true)
        assertResultPaths(bot, progress.review.images.selectedPaths)
      }
    }
    reviewSends.add(exchangeId)
    try {
      await saveProgress(bot, before, progress, undefined, { authorizeCommit })
      if (prior && prior.verdict === undefined) rt.dropWork(prior.exchangeId)
    } catch (error) {
      reviewSends.delete(exchangeId)
      throw error
    }
    return resultPictures === undefined ? prepared : { ...prepared, ...resultPictures }
  }

  function resultReviewCurrent(bot, reviewer, request, exchangeId) {
    const track = bot.reviewTrack
    const progress = track?.solver
    return rt.botOf(bot.id) === bot && rt.botOf(reviewer.id) === reviewer && bot.reviewerId === reviewer.id
      && track?.requested && !track.delivered && progress?.request === request
      && progress.review?.exchangeId === exchangeId && progress.review.revision === progress.revision
      && progress.review.verdict === undefined && !progressWrites.has(bot) && !runningWork.has(bot)
      && progress.snapshot === snapshotOf(bot)
      && resultPathsAllowed(bot, progress.review.images?.selectedPaths ?? [])
  }

  async function prepareResultPictures(bot, progress, pictures, assertAuthority) {
    const manifest = manifestsMatch(bot, progress)
    const base = progress.imageBase?.indeterminate ? undefined : progress.imageBase?.keys
    const { signal } = pictures ?? {}
    const images = []
    const selected = new Map()
    const read = selector => readResultPicture(folderOf(bot), { bot, selector, signal, ...resultReadScope(bot) })
    for (const selector of pictures?.selectors ?? []) {
      try {
        images.push(await pictures.find(selector))
      } catch (error) {
        if (error.missing !== true) throw error
        assertAuthority()
        const result = read(selector)
        selected.set(result.path, result)
      }
    }
    const paths = new Set(manifest?.entries.filter(entry => !base?.includes(entry.key.slice(0, 16))).map(entry => entry.path))
    for (const path of selected.keys()) paths.add(path)
    if (images.length > 0 && manifest) {
      const selectors = new Set(pictures.selectors)
      for (const { path } of manifest.entries) {
        if (selectors.has(path) || selectors.has(resolve(folderOf(bot), path))) paths.add(path)
      }
    }
    const required = []
    let missing = !manifest || (!base && paths.size === 0) || paths.size > 4
    const selectedPaths = [...selected.keys()]
    const assertRelease = () => {
      assertAuthority()
      assertResultPaths(bot, selectedPaths)
    }
    assertRelease()
    let store, identity
    if (selected.size > 0) {
      store = rt.ctx.get('attachments')
      identity = storeIdentity(store)
      const local = await import('@deepseek-ai/dsh-attachment-local').catch(() => undefined)
      assertRelease()
      if (!local || !(store instanceof local.default)) throw refusal('This Automagik cannot prepare result pictures for review.')
      for (const result of selected.values()) {
        try {
          const prepared = await local.prepareImageFile(result.image, store.imageLimits, store.normalizationPolicy)
          result.ref = prepared.ref
        } catch {
          throw refusal(`The result picture ${JSON.stringify(result.path)} could not be prepared. Convert it to PNG or reduce its size, then attach it again.`)
        }
        assertRelease()
      }
    }
    for (const path of [...paths].slice(0, 4)) {
      const included = selected.get(path)
      if (!included) assertAuthority()
      try {
        const result = included ?? read(path)
        required.push({ path, digest: result.digest, ...(included ? { attachmentId: included.ref.attachmentId } : {}) })
        if (!included) missing = true
      } catch {
        missing = true
      }
    }
    const carried = [...new Set(required.map(entry => entry.attachmentId).filter(Boolean))].sort()
    const kind = !manifest || !base ? 'indeterminate' : paths.size > 0 ? 'visual' : 'text'
    const names = [...paths].slice(0, 20)
    const receipts = missing ? [
      names.length ? `Result pictures require review: ${names.map(name => JSON.stringify(name)).join(', ')}.`
        : 'The result picture manifest could not be verified.',
      paths.size > 4 ? 'Combine the result into at most 4 pictures and remove the rest from the result.'
        : 'Attach the result picture paths under images. Convert unsupported pictures to PNG.',
    ] : []
    assertRelease()
    const outgoing = new Map(images.map(ref => [ref.attachmentId, ref]))
    for (const { ref } of selected.values()) outgoing.set(ref.attachmentId, ref)
    if (outgoing.size > 0) await pictures.authorize([...outgoing.values()])
    assertRelease()
    for (const result of selected.values()) {
      if (storeIdentity(rt.ctx.get('attachments')) !== identity) throw refusal('The result picture store changed. Request the review again.')
      // The pinned store deterministically prepares the same input under its frozen policy.
      const ref = await store.saveImage(result.image)
      if (ref?.attachmentId !== result.ref.attachmentId || ref.bytes !== result.ref.bytes
        || ref.mediaType !== result.ref.mediaType || ref.width !== result.ref.width || ref.height !== result.ref.height) {
        throw refusal('The stored result picture does not match its authorized reference.')
      }
      images.push(ref)
      assertRelease()
    }
    progress.review.images = { v: 1, kind, required, carried, names, selectedPaths, definite: manifest !== undefined && !missing }
    return { images, reviewNotice: receipts.join(' '), reviewComplete: kind !== 'text' && !missing }
  }

  function pendingReviewImages(sessionId) {
    const reviewer = rt.botOfSession?.(sessionId)
    if (!reviewer || rt.chatOf(reviewer.id) !== sessionId) return []
    const pending = []
    for (const bot of Object.values(rt.state.bots ?? {})) {
      const track = bot.reviewTrack
      const progress = track?.solver
      const review = progress?.review
      if (bot.reviewerId === reviewer.id && track?.requested && !track.delivered && review?.reviewerId === reviewer.id
        && review.verdict === undefined && review.revision === progress.revision && review.images?.v === 1) {
        pending.push({ bot, progress, review })
      }
    }
    return pending
  }

  const reviewImages = (sessionId, exchangeId) => pendingReviewImages(sessionId)
    .find(({ review }) => review.exchangeId === exchangeId)?.review
  const resultReviewImages = (sessionId, exchangeId) => reviewImages(sessionId, exchangeId)?.images.carried
  const reviewAttempts = new Map()
  const reviewAttempt = sessionId => reviewAttempts.get(sessionId)
  function reviewAttemptFrame(session, frame) {
    if (!session || !frame) return
    const { id } = session
    if (frame.type === 'start') {
      if (pendingReviewImages(id).length === 0) {
        reviewAttempts.delete(id)
        return
      }
      const { attemptId, turn, step } = frame
      reviewAttempts.set(id, { session, attemptId, turn, step })
    } else if (frame.type === 'end') {
      const attempt = reviewAttempts.get(id)
      if (attempt?.session !== session || attempt.attemptId !== frame.attemptId) return
      reviewAttempts.delete(id)
      const outcome = frame.outcome
      if (outcome?.kind === 'committed' && outcome.eventType === 'assistant/message') attempt.committedSeq = outcome.seq
    }
  }

  const currentGeneration = new Map()
  function beginReviewGeneration({ sessionId, messages, provider, model, runKey, nativeIds }) {
    const pending = pendingReviewImages(sessionId)
    if (pending.length === 0) {
      currentGeneration.delete(sessionId)
      return
    }
    const previous = currentGeneration.get(sessionId)
    const entries = new Map()
    for (const { bot, progress, review } of pending) {
      const row = messages.findLast(row => row.source?.exchangeId === review.exchangeId)
      const source = row?.source
      const marked = source?.kind === SOURCE_KIND && source.form === 'relay' && source.role === 'request'
        && source.resultReview?.v === 1 && source.senderSessionId === bot.id
        && !source.resumed && !source.resumedByUpdate && !source.retried && !source.resume
      const previousEntry = previous?.entries.get(review.exchangeId)
      // A queued exchange participates only after one of its rows reaches a stream request.
      if (!row && !previousEntry) continue
      const replaced = previous?.runKey !== undefined && previous.runKey !== runKey && previousEntry !== undefined
      const native = marked ? nativeIds?.(row, review.images.carried) ?? [] : []
      entries.set(review.exchangeId, { request: progress.request, revision: review.revision, native,
        lost: !marked || replaced || previousEntry?.lost === true || previousEntry?.native.some(id => !native.includes(id)) === true })
    }
    const generation = { entries, runKey, sessionId, route: chosenIdentity(provider, model), confirmed: false }
    currentGeneration.set(sessionId, generation)
    return generation
  }

  function reviewGenerationOutput(generation, { confirmed, completed, attempt } = {}) {
    if (!generation || currentGeneration.get(generation.sessionId) !== generation) return
    if (confirmed !== undefined) generation.confirmed = confirmed
    if (completed === true && attempt && reviewAttempt(generation.sessionId) === attempt) attempt.generation = generation
    if (confirmed === false || completed === false) {
      for (const entry of generation.entries.values()) entry.lost = true
    }
  }

  function generationForReply(session, event) {
    const attempt = reviewAttempt(session.id)
    const { turn, step, stream, interrupted, message } = event.data ?? {}
    const route = chosenIdentity(message?.source?.provider, message?.source?.model)
    // The pinned loop appends the event before emitting the end frame. The frame
    // supplies the committed sequence; the verdict consumes it after the turn ends.
    if (attempt?.session === session && attempt.generation?.route === route && route
      && attempt.turn === turn && attempt.step === step && Array.isArray(stream) && stream.length > 0
      && Number.isSafeInteger(event.seq) && !interrupted) {
      return { attempt, seq: event.seq }
    }
  }

  function visualVerdict(bot, progress, model, answer) {
    const { review } = progress
    if (review.images?.v !== 1) return !progress.visualReviewRequired && legacyText(bot, progress) ? { ok: true } : { why: 'missing' }
    const { kind, definite, required } = review.images
    if (!definite || !manifestsMatch(bot, progress)) return { why: 'missing' }
    if (kind === 'text') return progress.visualReviewRequired ? { why: 'missing' } : { ok: true }
    if (!required?.length) return { why: 'missing' }
    const sessionId = rt.chatOf(review.reviewerId)
    const generation = answer?.attempt.generation
    const entry = generation?.entries.get(review.exchangeId)
    const current = currentGeneration.get(sessionId)?.entries.get(review.exchangeId)
    if (!entry || entry.lost || !generation.confirmed || !current || current.lost
      || answer.attempt.committedSeq !== answer.seq
      || current.request !== progress.request || current.revision !== review.revision
      || entry.request !== progress.request || entry.revision !== review.revision
      || generation.route !== chosenIdentityOf(model)) return { why: 'lost' }
    return required.every(file => /^[a-f0-9]{64}$/.test(file.digest)
      && /^sha256:[a-f0-9]{64}$/.test(file.attachmentId) && entry.native.includes(file.attachmentId))
      ? { ok: true } : { why: 'unseen' }
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
  function reviewWork(bot, own, name, args, definition, base, options) {
    if (!own || !tracked(bot) || !isWorkCall(name, args, definition)) return
    const folder = bot.workDir ?? rt.teamFolder?.()
    const notes = isNotesWrite(name, args, folder, base ?? folder)
    if (deferIngress(bot, () => reviewWork(bot, own, name, args, definition, base, options))) return
    const { admit } = options ?? {}
    if (admit?.bot && (admit.bot !== bot || rt.botOf(bot.id) !== bot)) return
    const track = admit && isRecord(bot.reviewTrack) ? bot.reviewTrack : trackOf(bot)
    if (track.delivered === true) return
    if (admit && track.requestAt < admit.requestAt) return
    const sameRequest = !admit || (track.requestAt === admit.requestAt && track.solver?.request === admit.request)
    const overlaps = !!admit && (!sameRequest || track.solver?.revision !== admit.revision)
    const at = sameRequest ? (isTime(options?.at) ? options.at : Date.now()) : track.requestAt
    if (overlaps || options?.uncertain) track.uncertainWorkAt = Math.max(track.uncertainWorkAt ?? at, Date.now())
    // A write to exactly the notes file never dates the plan side (SR4-2), but it is still work
    // for the result: a verdict must follow it (SR5-1).
    if (!notes) track.firstWorkAt = Math.min(track.firstWorkAt ?? at, at)
    track.lastWorkAt = Math.max(track.lastWorkAt ?? at, at)
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
    const parsedAgreed = nativeCall ? normalizeCheckCommand(agreed) : undefined
    const matchesCommand = nativeCall ? nativeCommand?.command && nativeCommand.command === parsedAgreed.command
      : shellCommand && shellCommand === agreed
    const startProblem = nativeCall && nativeStartProblem(nativeRunStarts.get(bot), request, pending, value?.terminalStart)
    const folder = folderOf(bot)
    const scoped = nativeCall ? matchesCommand && nativeCheckDirectory(parsedAgreed, nativeCommand, folder, outcome?.cwd)
      : withinCheckRoot(folder, outcome?.cwd)
    const known = nativeCall ? Number.isInteger(outcome.exitCode)
      : outcome?.kind === 'foreground' && Number.isInteger(outcome.exitCode)
        && outcome.signal === null && outcome.timedOut === false && outcome.aborted === false
        && !outcome.stopped && !outcome.sandbox?.denied && !outcome.sandbox?.runnerFailed
    const snapshot = snapshotOf(bot)
    let reason = nativeCommand?.reason
    if (!reason && !matchesCommand) reason = 'The observed command does not match one agreed check.'
    if (!reason && !known) reason = outcome?.reason ?? 'A completed foreground check outcome is missing.'
    if (!reason && startProblem) reason = startProblem
    if (!reason && !scoped) reason = parsedAgreed?.directory !== undefined
      ? 'The check working directory could not be verified as the agreed directory.'
      : 'The check working directory could not be verified within the result root.'
    if (!reason && !pending.startSnapshot) reason = 'The pre-run result snapshot is unavailable.'
    if (!reason && !snapshot) reason = 'The result snapshot at completion is unavailable.'
    if (!reason && pending.startSnapshot !== snapshot) reason = 'The result changed between the start and the outcome.'
    if (!reason && revision !== progress.revision) reason = 'The Solver revision changed during the run.'
    if (reason) invalidateResult(progress)
    const verifiedOutcome = known && matchesCommand && !startProblem && (!nativeCall || scoped)
    progress.pending = { ...pending, evidence: { call, ...(verifiedOutcome ? { pass: outcome.exitCode === 0 } : {}),
      ...(reason ? { reason } : { snapshot }) } }
    await saveProgress(bot, before, progress)
  }

  function rememberReply(bot, exchangeId, reviewerId, replyTo, { workAt, request, receipt }, recorded = true) {
    let replies = unread.get(bot)
    if (replies === undefined) unread.set(bot, replies = new Map())
    const reply = { exchangeId, reviewerId, replyTo, workAt, request, receipt, recorded, claims: new Map(),
      release: () => { if (replies.get(exchangeId) === reply) replies.delete(exchangeId) } }
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
        && (args.reviewReply.request === undefined || args.reviewReply.request === track.solver?.request)
        && args.fromId === bot.reviewerId && !unread.get(bot)?.has(args.exchangeId)) {
        rememberReply(bot, args.exchangeId, args.fromId, args.replyTo, args.reviewReply)
      }
    }
    return unread.get(bot)
  }

  const retire = (reply) => {
    reply.release()
    rt.forgetDelivery?.(reply.exchangeId)
  }

  // Base-format designations kept only a bare model. Recover the original
  // route when the Solver log shows exactly one matching call before work opened.
  function originalSolverModel(bot, track, workAt, events) {
    const log = events ?? rt.ctx.sessions?.get?.(rt.chatOf(bot.id))?.snapshotEvents?.()
    if (!log) return undefined
    let model
    let found
    let matched = false
    for (const row of log) {
      const event = row.event ?? row
      if (event.type === 'request/header' || event.type === 'request/context') {
        model = recordedModelOf(event)
      }
      if (event.type !== 'tool/call' || !isTime(event.time) || event.time < track.requestAt || event.time > workAt
        || teamToolOf(event.data?.name) !== 'message_bot') continue
      let args
      try { args = JSON.parse(event.data.arguments) } catch { continue }
      if (args?.solver_review !== 'result' || args.solver_request !== track.solver.request) continue
      if (matched) return undefined
      matched = true
      found = model
    }
    return found
  }

  // A reply going from `fromId` to the Bot `toId` that asked it. The Solver's own reviewer
  // answering work from its own chat can hold delivery even if the reply has no verdict.
  // `workAt`: when the work it answers was opened. A reply to work opened before this request (a
  // late verdict on the last one), or to no open work at all, is not this request's review (SR3-2).
  // The guard's own strict reading (guardVerdictOf) dates the plan's verdict once per request, for
  // every tracked Bot, so a guard turned on mid-request reads a verdict that already came.
  function reviewVerdict(fromId, toId, roomId, text, workAt, reply, model, firstLine, solverEvents, legacyHeld, generation) {
    const bot = rt.botOf(toId)
    if (roomId !== undefined || !tracked(bot) || bot.reviewerId !== fromId || fromId === toId) return
    if (typeof workAt !== 'number') return
    const track = cleanTrack(bot.reviewTrack) ?? { requested: false, requestAt: bot.createdAt ?? 0 }
    if (track.delivered === true || workAt < track.requestAt) return
    const { requestAt } = track
    const request = track.solver?.request
    const binding = { requestAt, workAt, ...(request ? { request } : {}),
      ...(reply?.reviewReceipt ? { receipt: reply.reviewReceipt } : {}) }
    const resultReceipt = binding.receipt && track.solver?.review?.exchangeId === reply?.replyTo
    const decision = resultReceipt ? Promise.withResolvers() : undefined
    decision?.promise.catch(() => {})
    const applyVerdict = () => {
      const current = cleanTrack(bot.reviewTrack) ?? { requested: false, requestAt: bot.createdAt ?? 0, verdicts: [] }
      if (current.requestAt !== requestAt || current.delivered || bot.reviewerId !== fromId
        || rt.botOf(toId) !== bot || (request !== undefined && current.solver?.request !== request)) return
      reviewSends.delete(reply?.replyTo)
      const reviewer = rt.botOf(fromId)
      // The receipt binds this reply to actual reviewer work. Recheck its designation
      // against current progress because a progress write can defer the reply.
      const stage = typeof binding.receipt === 'string' && typeof request === 'string' && current.requested && reviewer
        ? currentReviewStage(current.solver, fromId, reply.replyTo) : undefined
      const verdict = verdictOf(text, stage, firstLine, { veto: stage !== undefined })
      const planVerdict = guardVerdictOf(text, reviewer?.name, stage, firstLine)
      if (verdict === undefined && planVerdict === undefined && reply === undefined) return
      let withholdShip = false
      let designatedVerdict
      if (reviewer) {
        const result = current.solver?.review
        if (stage === 'result' && legacyResultReview(result) && result.verdict === undefined) {
          const original = originalSolverModel(bot, current, workAt, solverEvents)
          if (original) current.solver = { ...current.solver, review: { ...result, solverModel: original } }
        }
        const strict = planVerdict === 'SHIP' && ['FIX-FIRST', 'BLOCKED'].includes(verdict) ? verdict : planVerdict
        designatedVerdict = strict
        const exchange = stage === undefined && current.solver?.plan?.review?.exchangeId === reply?.replyTo
          ? undefined : reply?.replyTo
        const visual = stage === 'result' && strict === 'SHIP' ? visualVerdict(bot, current.solver, model, generation) : undefined
        const reason = recordSolverVerdict(current.solver, exchange, reviewer, strict, model, binding.receipt,
          stage === 'result' && legacyHeld, visual)
        withholdShip = reason === 'held' || reason === 'same' || reason === 'images'
        if (stage === 'result') {
          const sessionId = rt.chatOf(fromId)
          const dispatch = currentGeneration.get(sessionId)
          dispatch?.entries.delete(reply?.replyTo)
          if (dispatch?.entries.size === 0) currentGeneration.delete(sessionId)
        }
      }
      const at = Date.now()
      if (planVerdict !== undefined && (!withholdShip || planVerdict !== 'SHIP')) current.planVerdictAt ??= at
      if (stage === 'plan' && isReviewVerdict(designatedVerdict) && (!withholdShip || designatedVerdict !== 'SHIP')) {
        const proof = { at, request, exchangeId: reply.replyTo, reviewerId: fromId, verdict: designatedVerdict }
        if (planProof(proof, current.solver, fromId) && !planProof(current.planOpen, current.solver, fromId)) current.planOpen = proof
      }
      if (verdict !== undefined && (!withholdShip || verdict !== 'SHIP')) {
        const provenance = stage === 'result'
          ? { request, revision: current.solver.revision, exchangeId: reply.replyTo, reviewerId: fromId }
          : {}
        current.verdicts = [...current.verdicts, { verdict, at, ...(stage ? { stage } : {}), ...provenance }].slice(-VERDICTS_KEPT)
      }
      bot.reviewTrack = current
      if (decision) return rt.save({ durable: true, required: true })
      save()
    }
    const apply = () => {
      try {
        const saved = applyVerdict()
        if (decision) Promise.resolve(saved).then(decision.resolve, decision.reject)
      } catch (error) {
        if (!decision) throw error
        decision.reject(error)
      }
    }
    if (!deferIngress(bot, apply)) apply()
    if (reply === undefined || !track.requested || !isTime(workAt)) return
    const currentRequest = () => rt.botOf(toId) === bot && bot.reviewTrack?.requestAt === requestAt
      && bot.reviewTrack.delivered !== true && bot.reviewTrack.solver?.request === request && bot.reviewerId === fromId
    // The ledger append makes this reply eligible to be consumed.
    const record = (exchangeId = reply.exchangeId) => {
      if (!currentRequest()) return
      const recorded = rememberReply(bot, exchangeId, fromId, reply.replyTo, binding)
      rt.noteReviewReply?.(exchangeId, binding)
      return () => retire(recorded)
    }
    // The send can await note adoption before the ledger append takes over the hold.
    return Object.assign(record, {
      ...(decision ? { ready: decision.promise, recovery: binding } : {}),
      begin: exchangeId => currentRequest()
        ? rememberReply(bot, exchangeId, fromId, reply.replyTo, binding, false).release : undefined,
    })
  }

  const matches = (reply, source) => source?.kind === SOURCE_KIND && source.role === 'reply'
    && source.exchangeId === reply.exchangeId && source.senderSessionId === reply.reviewerId
    && source.replyTo === reply.replyTo && source.reviewReceipt === reply.receipt

  const replyAt = (sessionId, source) => {
    if (source?.kind !== SOURCE_KIND || source.role !== 'reply') return
    const past = rt.pastOwners.get(sessionId)
    const bot = rt.botOf(rt.chatOwners.get(sessionId) ?? (past?.roomId === undefined ? past?.botId : undefined))
    const reply = unreadReplies(bot)?.get(source.exchangeId)
    if (reply?.recorded && matches(reply, source)) return reply
  }

  const agentSession = agent => agent?.session?.id ?? agent?.id
  rt.ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message') return
    const reply = replyAt(session.id, event.data?.source)
    if (reply?.receipt === undefined) reply?.release()
  })
  rt.ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const sessionId = agentSession(agent)
    const reply = replyAt(sessionId, message?.source)
    if (reply !== undefined) reply.claims.set(message.id, { sessionId, turn, agent })
  })
  rt.ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    const reply = replyAt(agentSession(agent), message?.source)
    if (reply === undefined) return
    reply.claims.delete(message.id)
    reply.withdrawal = undefined
  })
  const hasMatchingInput = (reply, agent) => reply.claims.size > 0
    || [agent.inbox?.nextStep, agent.inbox?.nextTurn].some(queue =>
      queue?.some(input => matches(reply, input.source)))

  function reviewReplyDiscarded(agent, message) {
    const reply = replyAt(agentSession(agent), message?.source)
    if (reply === undefined) return false
    if (rt.wakeLog?.movingInbox) return true
    // DSH edit and steer remove and reinsert in one operation. Give the matching
    // insertion a chance to cancel the withdrawal before treating it as final.
    const withdrawal = {}
    reply.withdrawal = withdrawal
    reply.claims.delete(message.id)
    queueMicrotask(() => {
      if (reply.withdrawal === withdrawal && !hasMatchingInput(reply, agent)) retire(reply)
    })
    return true
  }

  function reviewReplyTurnEnd(sessionId, data) {
    const bot = rt.botOf(rt.chatOwners.get(sessionId))
    const replies = unreadReplies(bot)
    if (!replies?.size || rt.updateHold?.closed || rt.updateShuttingDown?.()
      || rt.cutByRestart?.(data?.reason) || data?.reason?.reason?.kind === 'disposed') return
    for (const reply of replies.values()) {
      const ended = [...reply.claims].filter(([, claim]) =>
        claim.sessionId === sessionId && (claim.turn === undefined || claim.turn === data?.turn))
      if (ended.length === 0) continue
      const settle = (messages = []) => {
        if (replies.get(reply.exchangeId) !== reply) return
        for (const [id, claim] of ended) {
          if (reply.claims.get(id) === claim) reply.claims.delete(id)
        }
        if (!hasMatchingInput(reply, ended[0][1].agent)
          && !messages.some(message => matches(reply, message.source))) retire(reply)
      }
      // The switch may have taken the proposed input in pre-step. Wait for it
      // to finish moving input before retiring the claims that ended unread.
      if (!rt.afterBotInputSwitch?.(sessionId, settle) && !rt.carriesBotInput?.(sessionId)) settle()
    }
  }

  function requestOfReply(bot, track, { request, workAt, reviewerId, replyTo }) {
    if (typeof request === 'string' && track?.requested && !track.delivered
      && track.solver?.request === request && isTime(workAt) && workAt >= track.requestAt
      && bot.reviewerId === reviewerId && reviewerId !== bot.id && rt.botOf(reviewerId)
      && designatedReview(track.solver, reviewerId, replyTo)) return request
  }

  function designatedReplyRequest(toId, reviewerId, replyTo, work) {
    if (work?.from !== toId || work?.to !== reviewerId || work.room !== undefined || work.fromRoom !== undefined) return
    const bot = rt.botOf(toId)
    const track = bot?.reviewTrack
    return requestOfReply(bot, track, { request: track?.solver?.request, workAt: work.at, reviewerId, replyTo })
  }

  function takeReviewReply(sessionId, message, turn) {
    const id = rt.chatOwners.get(sessionId)
    if (id === undefined || typeof message?.id !== 'string') return
    const reply = replyAt(sessionId, message.source)
    const claim = reply?.claims.get(message.id)
    if (claim?.sessionId !== sessionId || (claim.turn !== undefined && claim.turn !== turn)) return
    const bot = rt.botOf(id)
    if (reply.receipt === undefined) {
      // An ordinary review may complete work that predates the feature's explicit plan.
      const progress = bot?.reviewTrack?.solver
      const request = progress?.plan === undefined && reply.request === progress?.request ? reply.request : undefined
      reply.release()
      return { request }
    }
    const request = requestOfReply(bot, bot?.reviewTrack, reply)
    const binding = { toId: id, request, reviewerId: reply.reviewerId, replyTo: reply.replyTo,
      workAt: reply.workAt, receipt: reply.receipt }
    const consumedResult = resultReplyRequest(bot, bot?.reviewTrack, binding) ? binding : undefined
    if (consumedResult !== undefined) rt.noteConsumedReviewResult?.(sessionId, consumedResult)
    retire(reply)
    return { request, consumedResult }
  }

  function resultReplyRequest(bot, track, binding) {
    const result = track?.solver?.review
    if (result && binding?.toId === bot?.id && typeof binding?.receipt === 'string'
      && binding.replyTo === result.exchangeId && result.revision === track.solver.revision
      && (result.receipt === binding.receipt || (result.receipt === undefined && ['SHIP', 'FIX-FIRST', 'BLOCKED'].includes(result.verdict)))) {
      return requestOfReply(bot, track, binding)
    }
  }

  function withReviewFeedback(message, toId, continuation) {
    const source = message?.source
    if (!source || (!source.reviewReceipt && !source.reviewFeedback && !continuation)) return message
    const bot = rt.botOf(toId)
    const track = bot?.reviewTrack
    const reply = continuation === undefined && bot && unreadReplies(bot)?.get(source.exchangeId)
    const binding = continuation ?? (reply?.recorded && matches(reply, source)
      ? { ...reply, toId } : undefined)
    const result = track?.solver?.review
    const reason = binding && resultReplyRequest(bot, track, binding)
      && result?.revision === track.solver.revision && result?.receipt === binding.receipt
      && (result.verdict === 'unverified' || result.unverified === 'held')
      && unverifiedReason(result.unverified)
    const imagesWhy = reason === 'images' ? result.imagesWhy : undefined
    const notice = unverifiedNotice(reason, imagesWhy)
    if (!notice && !source.reviewFeedback) return message
    const { reviewFeedback: _previous, reviewImagesWhy: _why, ...originalSource } = source
    const content = originalReviewContent(message)
    return {
      ...message,
      source: notice ? { ...originalSource, reviewFeedback: reason, ...(imagesWhy ? { reviewImagesWhy: imagesWhy } : {}) } : originalSource,
      content: notice ? [...content, { type: 'text', text: notice }] : content,
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
    const before = bot.reviewTrack
    const track = cleanTrack(before)
    const dates = noReply || senderId === bot.reviewerId
    if (track?.requested === true && track.delivered !== true) {
      if (dates || senderId === track.openerId) return
      const progress = track.solver
      const wasOpen = bot.reviewGuard === true && planOpenAt(bot, track) !== undefined && rt.planGateClosed?.(bot) === false
      const guardedOpen = bot.reviewGuard === true && (wasOpen
        || (rt.isActualSolver?.(bot) === false && isTime(track.planVerdictAt)))
      if (progress?.plan || progress?.pending || progress?.review) {
        invalidateResult(progress)
        if (progress.plan) progress.plan = { checks: progress.plan.checks, revision: progress.plan.revision, superseded: true }
      }
      if (wasOpen) {
        const next = openedTrack(bot, Date.now(), 'bot')
        if (progress) next.solver = progress
        if (isTime(track.personAt)) next.personAt = track.personAt
        else delete next.personAt
        next.openedBy = 'bot'
        next.openerId = senderId
        if (typeof exchangeId === 'string') next.openerExchange = exchangeId
        return saveProgress(bot, before, next.solver, next, () => forgetPrevious(bot)).catch(error =>
          rt.warn('omni-ui: Solver request could not be saved: %s', error))
      }
      if (progress?.plan || progress?.pending || progress?.review) bot.reviewTrack = track
      autoInstructions.delete(bot)
      if (!guardedOpen) {
        save()
        return
      }
      open(bot, Date.now(), 'bot')
      if (progress) bot.reviewTrack.solver = progress
      if (isTime(track.personAt)) bot.reviewTrack.personAt = track.personAt
      else delete bot.reviewTrack.personAt
    } else {
      if (dates) return
      if (bot.reviewGuard === true && planOpenAt(bot, track) !== undefined && rt.planGateClosed?.(bot) === false) {
        const next = { ...openedTrack(bot, Date.now(), 'bot'), openedBy: 'bot', openerId: senderId,
          ...(typeof exchangeId === 'string' ? { openerExchange: exchangeId } : {}) }
        return saveProgress(bot, before, next.solver, next, () => forgetPrevious(bot)).catch(error =>
          rt.warn('omni-ui: Solver request could not be saved: %s', error))
      }
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
    const { completed, wroteText, model, request, trigger, consumedResult } = turn
    const bot = rt.botOf(botId)
    if (!tracked(bot) || !completed || !wroteText) return
    if (deferIngress(bot, () => reviewTurnEnd(botId, turn))) return
    const track = cleanTrack(bot.reviewTrack)
    if (track?.requested !== true || track.delivered === true) return
    const result = track.solver?.review
    if (activeSolverLimit(bot, track) || runningWork.has(bot) || legacyResultReview(result) || result?.unverified === 'held') return
    if (Object.hasOwn(turn, 'request') && track.solver) {
      const progress = track.solver
      const botRequest = progress.origin === 'bot' && typeof track.openerExchange === 'string' && trigger?.exchangeId === track.openerExchange
      const brief = track.brief === true && (trigger === undefined || trigger.role === 'kickoff')
      if (!(request === progress.request || resultReplyRequest(bot, track, consumedResult) || botRequest || brief)) return
    }
    bot.reviewTrack = track
    const review = reviewOf(bot)
    // An answered RESULT is held by its unread receipt while work closure waits
    // for disk. The open-work check covers work that still owes an answer.
    const works = Object.values(rt.state?.works ?? {}).filter(work => !rt.reviewWorkClosing?.(work))
    const beforePerson = at => typeof track.personAt === 'number' && typeof at === 'number' && at < track.personAt
    if (review === 'bot' && works.some(work => work?.from === bot.id && work?.to === bot.reviewerId && !beforePerson(work.at))) return
    if (review === 'bot' && [...(unreadReplies(bot)?.values() ?? [])].some(reply =>
      reply.reviewerId === bot.reviewerId && !beforePerson(reply.workAt)
      && (reply.receipt === undefined || requestOfReply(bot, track, reply)))) return
    // Reviewer work this request opened, still out when the person asked: delivered before its
    // verdict (Run 3). Work left from an earlier request is not this one's.
    const pending = review === 'bot' && works.some(work => work?.from === bot.id && work?.to === bot.reviewerId && typeof work.at === 'number' && work.at >= track.requestAt)
    const oldShip = result?.verdict === 'SHIP' && result.images?.v !== 1
    const visualKind = oldShip ? (legacyText(bot, track.solver) ? 'text' : 'indeterminate') : undefined
    if (oldShip && visualKind !== 'text') {
      track.solver.review = { ...result, verdict: 'unverified', unverified: 'images', imagesWhy: 'missing' }
      track.solver.visualReviewRequired = true
    }
    track.outcome = solverOutcome(bot, track, review, pending, model, track.solver?.snapshot ? snapshotOf(bot) : undefined, visualKind)
    const imagesUnverified = track.solver?.visualReviewRequired === true || track.solver?.review?.unverified === 'images'
    const resultAt = track.verdicts.findLast(entry => entry.stage === 'result' && isReviewVerdict(entry.verdict)
      && entry.request === track.solver?.request && entry.revision === track.solver?.revision
      && entry.reviewerId === bot.reviewerId && matchesReview(result, entry.reviewerId, entry.exchangeId)
      && result.revision === entry.revision && result.verdict === entry.verdict)?.at
    track.last = { ...deliveryMark(track, review, Date.now(), {
      pending, planAt: planOpenAt(bot, track, { legacy: false }), resultAt,
    }), ...(track.outcome.done
      ? { done: true, reviewer: track.outcome.reviewer, resultExchangeId: track.outcome.exchangeId }
      : imagesUnverified ? { result: false } : {}) }
    if (!imagesUnverified) track.delivered = true
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
    const result = track?.solver?.review
    const reason = result?.verdict === 'unverified' && result.revision === track.solver.revision
      ? unverifiedReason(result.unverified) : track?.solver?.visualReviewRequired === true ? 'images' : undefined
    return { solverStatus: {
      ...(track?.requested && !track.delivered ? { auto: track.solver?.auto === true } : {}),
      ...(limit ? { limit: { kind: limit.kind, check: limit.check } } : {}),
      ...(track?.outcome ? { outcome: track.outcome } : {}),
      ...(reason ? { unverified: reason } : {}),
      ...(reason === 'images' ? { imagesWhy: result?.imagesWhy ?? 'missing' } : {}),
    } }
  }

  Object.assign(rt, { reviewCreated, reviewRequest, reviewBotRequest, reviewWork, reviewVerdict, reviewReplyTurnEnd, reviewReplyDiscarded, reviewTurnEnd, reviewMarkOf,
    solverProgress, solverReview, solverQuestion, solverStatusOf, solverBeforeWork, designatedReplyRequest, takeReviewReply, withReviewFeedback,
    rememberReviewUpload, resultReviewCurrent, resultReviewImages, beginReviewGeneration, reviewGenerationOutput, generationForReply,
    reviewAttemptFrame, reviewAttempt,
    resultReplyRequest: binding => {
      const bot = rt.botOf(binding.toId)
      return resultReplyRequest(bot, bot?.reviewTrack, binding)
    },
    retireReviewReply: (toId, exchangeId) => {
      const reply = unread.get(rt.botOf(toId))?.get(exchangeId)
      if (reply !== undefined) retire(reply)
      else rt.forgetDelivery?.(exchangeId)
    },
    solverReviewSent: exchangeId => reviewSends.delete(exchangeId),
    solverProgressBusy: bot => progressWrites.has(bot) })
}
