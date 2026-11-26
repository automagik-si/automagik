import { chosenIdentity, chosenIdentityOf } from '../shared/solver-model.js'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readlinkSync, realpathSync, statfsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { SOLVER_FIX_LIMIT, SOLVER_REPLAN_LIMIT, isSolverBot, isWrittenSolverMethod, solverAutoOn } from '../shared/solver-method.js'
import { guardVerdictMatch } from '../shared/review-guard.js'
import { normalizeCheckCommand } from './solver-check-command.js'

const MAX_CHECKS = 20
const MAX_RESULT_ENTRIES = 20_000
const FD_ROOT = '/proc/self/fd'
const PROC_SUPER_MAGIC = 0x9fa0
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const count = value => Number.isSafeInteger(value) && value >= 0
const id = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_.:-]{0,79}$/.test(value)
const notDone = reason => ({ reason })
const missingPass = reason => `No verified passing evidence for this run. ${reason ? `${reason} ` : ''}Start a new run on the current result.`
const listOfIds = value => Array.isArray(value) && value.length > 0 && value.length <= MAX_CHECKS
  && value.every(id) && new Set(value).size === value.length
const fingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const includesAll = (ids, values) => ids.length === values.length && ids.every(key => values.includes(key))
const commandOf = value => typeof value === 'string' && value.length <= 2_000 ? value : undefined
function checkCommands(value, checks) {
  if (!Array.isArray(value) || value.length !== checks.length || !value.every(item => record(item)
    && Object.keys(item).length === 2 && id(item.check) && commandOf(item.command))) return undefined
  const byCheck = Object.fromEntries(value.map(item => [item.check, commandOf(item.command)]))
  if (includesAll(checks, Object.keys(byCheck))) return byCheck
}

export const solverTracked = bot => bot != null && (isSolverBot(bot) || bot.reviewGuard === true
  || bot.solverAuto === true || id(bot.reviewTrack?.solver?.request)
  || (typeof bot.instructions === 'string' && isWrittenSolverMethod(bot.instructions)))

export function newProgress(origin) {
  return { request: randomUUID(), origin, attempts: {}, replans: 0, revision: 0, runs: {}, replanRuns: {}, passed: [], passRuns: {} }
}

export function cleanProgress(value) {
  if (!record(value) || !id(value.request) || !['bot', 'person'].includes(value.origin)) return undefined
  const { request, origin } = value
  const attempts = Object.fromEntries(Object.entries(record(value.attempts) ? value.attempts : {})
    .filter(([check, number]) => id(check) && count(number)).slice(0, MAX_CHECKS))
  const plan = record(value.plan) && count(value.plan.revision) && listOfIds(value.plan.checks) ? value.plan : undefined
  const snapshot = fingerprint(value.snapshot) ? value.snapshot : undefined
  const passed = snapshot && plan && Array.isArray(value.passed) ? plan.checks.filter(check => value.passed.includes(check)) : []
  const passRuns = Object.fromEntries(Object.entries(record(value.passRuns) ? value.passRuns : {})
    .filter(([check, run]) => passed.includes(check) && id(run)))
  const limit = value.limit
  return {
    request, origin, attempts, passed, passRuns,
    ...(snapshot ? { snapshot } : {}),
    replans: count(value.replans) ? value.replans : 0,
    revision: count(value.revision) ? value.revision : 0,
    runs: record(value.runs) ? value.runs : {},
    replanRuns: record(value.replanRuns) ? value.replanRuns : {},
    ...(value.auto === true ? { auto: true } : {}),
    ...(plan ? { plan } : {}),
    ...(plan && record(value.pending) && id(value.pending.run) && listOfIds(value.pending.checks)
      && value.pending.checks.every(check => plan.checks.includes(check)) ? { pending: value.pending } : {}),
    ...(record(limit) && count(limit.at) && (limit.kind === 'replan' || (limit.kind === 'fix' && id(limit.check))) ? { limit } : {}),
    ...(record(value.review) ? { review: value.review } : {}),
  }
}

export function activeSolverLimit(bot, track = bot?.reviewTrack) {
  if (track?.requested !== true || track.delivered === true || !track.solver || solverAutoOn(bot, track.solver)) return undefined
  const progress = track.solver
  if (progress.limit) return progress.limit
  const check = Object.keys(progress.attempts ?? {}).find(key => progress.attempts[key] > SOLVER_FIX_LIMIT)
  if (check) return { kind: 'fix', check, at: track.requestAt }
  if (progress.replans > SOLVER_REPLAN_LIMIT) return { kind: 'replan', at: track.requestAt }
}

export const limitWhat = limit => limit.kind === 'fix'
  ? `${JSON.stringify(limit.check)} failed after ${SOLVER_FIX_LIMIT} fix attempts` : '3rd re-plan'
export const limitText = limit => `Attempt limit reached (${limitWhat(limit)}). Stop now: tell the person what you did, what still fails, the likely cause and the exact decision you need, and ask how to proceed. Work stays held until the person answers.`

export function invalidateResult(progress) {
  progress.revision++
  progress.passed = []
  progress.passRuns = {}
  delete progress.snapshot
  delete progress.review
}

export function resumeProgress(progress, limit) {
  if (limit.kind === 'fix') progress.attempts[limit.check] = 0
  else progress.replans = 0
  delete progress.limit
}

const entryStat = path => lstatSync(path, { bigint: true })
const directoryStat = fd => fstatSync(fd, { bigint: true })
const sameEntry = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
const sameVersion = (a, b) => sameEntry(a, b) && a.ctimeNs === b.ctimeNs
const changedDuringRead = 'It changed while it was read.'
const tooManyEntries = 'It has more than 20,000 entries.'
const snapshotError = reason => Object.assign(new Error(reason), { reason })

function hasDescriptorPaths() {
  if (process.platform !== 'linux' || !constants.O_DIRECTORY || !constants.O_NOFOLLOW) return false
  try {
    return statfsSync(FD_ROOT).type === PROC_SUPER_MAGIC
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ENOSYS'].includes(error.code)) return false
    throw error
  }
}

export function inspectResult(folder) {
  if (typeof folder !== 'string' || !isAbsolute(folder)) return { reason: 'The Solver has no usable result folder.' }
  const selectedRoot = resolve(folder)
  let root = selectedRoot
  const hash = createHash('sha256')
  let remaining = MAX_RESULT_ENTRIES - 1
  const openDirectory = path => openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const fdPath = fd => join(FD_ROOT, String(fd))
  const shown = path => JSON.stringify(relative(root, path) || '.').slice(0, 200)
  let location = root
  let descriptorPaths
  let rootStat
  function visit(path, locationOfEntry, name, isRoot = false) {
    location = locationOfEntry
    const stat = entryStat(path)
    if (isRoot && !sameVersion(rootStat, stat)) throw snapshotError(changedDuringRead)
    const identity = [name, stat.dev, stat.ino, stat.mode].map(String)
    if (stat.isDirectory()) {
      const fd = descriptorPaths ? openDirectory(path) : undefined
      try {
        const opened = fd === undefined ? entryStat(path) : directoryStat(fd)
        if (!sameVersion(stat, opened)) throw snapshotError(changedDuringRead)
        const directoryPath = fd === undefined ? path : fdPath(fd)
        const children = []
        const directory = opendirSync(directoryPath)
        try {
          for (let child; (child = directory.readSync()) !== null;) {
            if (isRoot && child.name === '.git') continue
            if (--remaining < 0) throw snapshotError(tooManyEntries)
            children.push(child.name)
          }
        } finally {
          directory.closeSync()
        }
        // On the portable path a concurrent swap can expose directory metadata between
        // the identity checks. Reject observed changes before looking up any child names.
        if (fd === undefined && !sameVersion(stat, entryStat(path))) throw snapshotError(changedDuringRead)
        children.sort()
        for (const child of children) visit(join(directoryPath, child), join(locationOfEntry, child), child)
        location = locationOfEntry
        if (!sameVersion(stat, entryStat(path))) throw snapshotError(changedDuringRead)
        hash.update(JSON.stringify([...identity, children]))
      } finally {
        if (fd !== undefined) closeSync(fd)
      }
    } else if (stat.isFile()) {
      const changes = [stat.size, stat.mtimeNs, stat.ctimeNs].map(String)
      hash.update(JSON.stringify([...identity, ...changes]))
    } else if (stat.isSymbolicLink()) {
      const target = readlinkSync(path, { encoding: 'buffer' }).toString('hex')
      if (!sameVersion(stat, entryStat(path))) throw snapshotError(changedDuringRead)
      const changes = [stat.size, stat.mtimeNs, stat.ctimeNs].map(String)
      hash.update(JSON.stringify([...identity, ...changes, 'link', target]))
    } else {
      throw snapshotError(`It contains a device, pipe or socket at ${shown(location)}.`)
    }
  }
  const parents = []
  try {
    rootStat = entryStat(selectedRoot)
    if (!rootStat.isDirectory()) return { reason: rootStat.isSymbolicLink()
      ? 'The result root is a symbolic link.' : 'The result root is not a directory.' }
    root = realpathSync.native(selectedRoot)
    location = root
    descriptorPaths = hasDescriptorPaths()
    let walkRoot = root
    if (descriptorPaths) {
      // Procfs keeps lookup and enumeration tied to held directory descriptors. Open
      // each component of the resolved root with O_NOFOLLOW before walking its entries.
      const components = root.split('/').filter(Boolean)
      const name = components.pop()
      let parent = '/'
      for (const component of ['', ...components]) {
        if (!name) break
        const path = join(parent, component)
        const fd = openDirectory(path)
        parents.push({ path, fd })
        parent = fdPath(fd)
      }
      if (name) walkRoot = join(parent, name)
    }
    visit(walkRoot, root, folder, true)
    for (const { path, fd } of parents) {
      if (!sameEntry(entryStat(path), directoryStat(fd))) throw snapshotError(changedDuringRead)
    }
    if (selectedRoot !== root && !sameVersion(rootStat, entryStat(selectedRoot))) throw snapshotError(changedDuringRead)
    return { snapshot: hash.digest('hex') }
  } catch (error) {
    return { reason: error.reason ?? (error.code
      ? `An entry at ${shown(location)} could not be read (${error.code}).` : 'It could not be read.') }
  } finally {
    for (const { fd } of parents.reverse()) closeSync(fd)
  }
}

export const resultSnapshot = folder => inspectResult(folder).snapshot

export function modelOf(session) {
  try {
    const route = session?.requestHeader?.()?.config
    return chosenIdentity(route?.provider, route?.model)
  } catch {
    return undefined
  }
}

// The log records the generation's route before its output. The header and
// context are repeated only on change, so each applies until the next one.
export function recordedModelOf(event) {
  const route = event.type === 'request/header' ? event.data?.header?.config : event.data
  return chosenIdentity(route?.provider, route?.model)
}

export function replyModel(texts, models, firstLine, reviewerName) {
  const model = models[0]
  if (models.every(route => route === model)) return model
  const match = guardVerdictMatch(texts.join('\n\n'), reviewerName, 'result', firstLine)
  if (match?.verdict !== 'SHIP') return undefined
  let line = match.line
  for (const [index, text] of texts.entries()) {
    const lines = text.split(/\r?\n/).length
    if (line < lines) return models[index]
    line -= lines + 1
  }
}

export const legacyResultReview = review => review !== undefined
  && (!chosenIdentityOf(review.solverModel) || (review.reviewer && !chosenIdentityOf(review.reviewer.model)))

export function normalizedAutoInstruction(text) {
  if (typeof text !== 'string') return undefined
  const clean = text.trim().replace(/\s+/g, ' ').toLowerCase()
  // Only a complete instruction from the person's own text. A quoted example,
  // option label, excerpt or negated instruction carries no authority.
  if (/^(?:(?:please |por favor,? )?(?:work alone until delivered|turn auto on|enable auto|trabalhe sem perguntar até entregar|ative o modo auto)|请?(?:开启自动模式|独立工作直到交付))[.!。！]?$/.test(clean)) return clean
}

function passes(progress, snapshot) {
  return progress.plan?.accepted === true && !progress.pending && typeof snapshot === 'string'
    && progress.snapshot === snapshot && includesAll(progress.plan.checks, progress.passed)
}

export function solverOutcome(bot, track, review, pending, model, snapshot) {
  const progress = track.solver
  const limit = activeSolverLimit(bot, track)
  if (limit) return { reason: 'limit', limit: { kind: limit.kind, ...(limit.check ? { check: limit.check } : {}) } }
  if (!progress || !passes(progress, snapshot)) return notDone('checks')
  const result = progress.review
  if (legacyResultReview(result) || review !== 'bot' || pending || result?.revision !== progress.revision || result.verdict !== 'SHIP'
    || chosenIdentityOf(result.solverModel) !== model || result.reviewer?.id !== bot.reviewerId
    || !result.reviewer.model || chosenIdentityOf(result.reviewer.model) === model) return notDone('review')
  return { done: true, reviewer: result.reviewer, exchangeId: result.exchangeId }
}

export function designateReview(progress, { kind, exchangeId, reviewerId, model, snapshot }) {
  if (kind === 'plan') {
    if (!progress.plan || progress.plan.superseded) return 'Register the agreed checks with solver_progress plan first.'
    if (progress.pending) return 'Record the open run before asking for plan review.'
    progress.plan = { ...progress.plan, accepted: false, review: { exchangeId, reviewerId } }
    invalidateResult(progress)
    return
  }
  if (!passes(progress, snapshot)) return 'Record current passing runs for every agreed check before asking for result review.'
  if (!model) return 'The effective Solver model could not be verified for an independent result review.'
  progress.review = { exchangeId, reviewerId, revision: progress.revision, solverModel: model }
}

export function recordSolverVerdict(progress, exchangeId, reviewer, verdict, model, receipt, legacyHeld) {
  if (!progress || typeof exchangeId !== 'string') return
  const plan = progress.plan
  if (plan?.review?.exchangeId === exchangeId && plan.review.reviewerId === reviewer.id) {
    progress.plan = { ...plan, accepted: verdict === 'SHIP', review: { ...plan.review, verdict: verdict ?? 'unverified' } }
  }
  const result = progress.review
  if (result?.exchangeId === exchangeId && result.reviewerId === reviewer.id && result.revision === progress.revision) {
    const solverIdentity = chosenIdentityOf(result.solverModel)
    const reviewerIdentity = chosenIdentityOf(model)
    const comparable = solverIdentity && reviewerIdentity
    const independent = comparable && reviewerIdentity !== solverIdentity
    const veto = verdict === 'FIX-FIRST' || verdict === 'BLOCKED'
    const reason = legacyHeld && !comparable ? 'held'
      : veto ? undefined
        : !comparable ? 'model' : !independent ? 'same' : verdict === undefined ? 'verdict' : undefined
    const { unverified: _previous, reviewer: _reviewer, receipt: _receipt, ...designated } = result
    progress.review = {
      ...designated,
      verdict: reason && !veto ? 'unverified' : verdict,
      ...(independent ? { reviewer: { id: reviewer.id, name: reviewer.name, model: reviewerIdentity } } : {}),
      ...(reason ? { unverified: reason } : {}),
      ...(receipt ? { receipt } : {}),
    }
    return reason
  } else if (result?.verdict === 'SHIP' && ['FIX-FIRST', 'BLOCKED'].includes(verdict)) {
    progress.review = { ...result, verdict }
  }
}

export function recordProgress(bot, track, args, { now, authorizedAuto, running, inspect, snapshotOf } = {}) {
  const progress = track.solver
  const limit = activeSolverLimit(bot, track)
  const recorded = `Recorded. ${Math.max(0, SOLVER_REPLAN_LIMIT - progress.replans)} re-plans left in Normal.`
  const { action, run, checks } = args
  if (action === 'auto') {
    if (progress.origin === 'bot') return { text: 'Only the person can turn Auto on, and this request came from a Bot.' }
    if (!authorizedAuto) return { text: "Auto needs the person's own words asking for it: quote them exactly." }
    progress.auto = true
    delete progress.limit
    return { changed: true, text: 'Recorded. Auto is on for this request.' }
  }
  if (action === 'replan' && id(run) && Object.hasOwn(progress.replanRuns, run)) {
    return { text: limit ? limitText(limit) : recorded }
  }
  if (action === 'checks' && id(run) && Object.hasOwn(progress.runs, run)) {
    const prior = progress.runs[run]
    if (JSON.stringify(args.results) !== (prior?.reported ?? prior)) return { text: 'This run ID already has different results.' }
    if (!prior?.unverified && Array.isArray(args.results) && args.results.every(item => item?.pass === true)) {
      const snapshot = prior?.evidence?.snapshot
      // A legacy report without per-check ownership cannot establish a current replay.
      if (prior?.revision !== progress.revision || !snapshot || snapshot !== progress.snapshot
        || args.results.some(({ check }) => progress.passRuns[check] !== run) || snapshot !== snapshotOf?.()) {
        return { text: 'This passing report is stale. Start a new run on the current result.' }
      }
    }
    return { text: limit ? limitText(limit) : prior?.unverified ? missingPass(prior.reason) : recorded }
  }
  if (limit) return { text: limitText(limit) }
  if (running) return { text: 'Wait for the current work to finish before updating Solver progress.' }
  if (action === 'plan') {
    if (!listOfIds(checks)) return { text: 'Register 1 to 20 distinct, stable check IDs.' }
    if (progress.pending) return { text: 'Record the open run before replacing the plan.' }
    const commands = checkCommands(args.commands, checks)
    if (args.commands !== undefined && !commands) return { text: 'Give one command for each agreed check ID.' }
    if (progress.plan && !progress.plan.superseded) {
      const sameCommands = checks.every(check => commands?.[check] === progress.plan.commands?.[check])
      return { text: includesAll(progress.plan.checks, checks) && sameCommands
        ? recorded : 'Record a re-plan before replacing the agreed checks or commands.' }
    }
    // Keep the agreed text for the reviewer and DSH's exact command comparison.
    for (const [check, command] of Object.entries(commands ?? {})) {
      const { reason } = normalizeCheckCommand(command)
      if (reason) return { text: `Cannot register check ${JSON.stringify(check)}. ${reason}` }
    }
    if (new Set([...Object.keys(progress.attempts), ...checks]).size > MAX_CHECKS) return { text: 'Use at most 20 check IDs per request.' }
    progress.plan = { revision: progress.revision, checks: [...checks], ...(commands ? { commands } : {}) }
    return { changed: true, text: recorded }
  }
  if (!id(run)) return { text: 'Provide a stable run ID.' }
  if (action === 'start') {
    if (!progress.plan || progress.plan.superseded || !listOfIds(checks) || !checks.every(check => progress.plan.checks.includes(check))) {
      return { text: 'Start a run with the IDs of its checks from the current plan.' }
    }
    if (Object.hasOwn(progress.runs, run)) return { text: 'This run was already recorded. Use a new run ID for a distinct run.' }
    if (progress.plan.review && progress.plan.review.verdict === undefined) {
      return { text: 'Wait for the designated plan review before running checks.' }
    }
    if (progress.pending) return { text: progress.pending.run === run && includesAll(progress.pending.checks, checks)
      ? 'Recorded. This run is already open.' : 'Record the open run before starting another attempt.' }
    const { snapshot: startSnapshot, reason } = inspect()
    const invalidated = Boolean(progress.snapshot && progress.snapshot !== startSnapshot)
    if (invalidated) invalidateResult(progress)
    if (!startSnapshot) return { changed: invalidated,
      text: `Cannot start this run. The result folder cannot be verified: ${reason} No run was recorded. Ask the person to set a smaller working folder for this Solver, or remove what blocks the check, then start again.`,
    }
    progress.pending = { run, checks: [...checks], revision: progress.revision, startSnapshot }
    delete progress.review
    return { changed: true, text: 'Recorded. Run the check and report all its outcomes.' }
  }
  if (action === 'replan') {
    if (progress.pending) return { text: 'Record the open run before re-planning.' }
    progress.replanRuns[run] = true
    progress.replans++
    invalidateResult(progress)
    delete progress.plan
    if (!solverAutoOn(bot, progress) && progress.replans > SOLVER_REPLAN_LIMIT) progress.limit = { kind: 'replan', at: now }
  } else if (action === 'checks') {
    const pending = progress.pending
    if (!pending || pending.run !== run || running) return { text: 'Report the outcome of the current run after its checks finish.' }
    const results = args.results
    if (!Array.isArray(results) || !results.every(item => record(item) && typeof item.pass === 'boolean')
      || !includesAll(pending.checks, results.map(item => item.check))) {
      return { text: 'Report one Boolean outcome for every check in this run.' }
    }
    const evidence = pending.evidence
    if (pending.checks.length === 1 && typeof evidence?.pass === 'boolean' && evidence.pass !== results[0].pass) {
      return { text: 'The report contradicts the observed check outcome. Report the actual outcome.' }
    }
    const failures = results.filter(item => item.pass === false).map(item => item.check)
    delete progress.pending
    progress.runs[run] = { reported: JSON.stringify(results), ...(evidence ? { evidence } : {}) }
    if (failures.length > 0) {
      invalidateResult(progress)
      for (const check of failures) {
        const previous = Object.hasOwn(progress.attempts, check) ? progress.attempts[check] : 0
        const failuresSoFar = progress.attempts[check] = previous + 1
        if (!solverAutoOn(bot, progress) && failuresSoFar > SOLVER_FIX_LIMIT) progress.limit ??= { kind: 'fix', check, at: now }
      }
    } else {
      const snapshot = snapshotOf?.()
      let reason = evidence?.reason
      if (!reason && !fingerprint(pending.startSnapshot)) reason = 'The pre-run result snapshot is unavailable.'
      if (!reason && (pending.checks.length !== 1 || !pending.call || evidence?.call !== pending.call
        || evidence.pass !== true || !fingerprint(evidence.snapshot))) reason = 'No matching completed check was observed.'
      if (!reason && pending.startSnapshot !== evidence.snapshot) reason = 'The result changed between the start and the outcome.'
      if (!reason && pending.revision !== progress.revision) reason = 'The Solver revision changed during the run.'
      if (!reason && !snapshot) reason = 'The result snapshot at report time is unavailable.'
      if (!reason && snapshot !== evidence.snapshot) reason = 'The result changed between the outcome and the report.'
      if (reason) {
        progress.passed = progress.passed.filter(check => !pending.checks.includes(check))
        for (const check of pending.checks) delete progress.passRuns[check]
        Object.assign(progress.runs[run], { unverified: true, reason })
        return { changed: true, text: missingPass(reason) }
      }
      progress.runs[run].revision = progress.revision
      progress.snapshot = snapshot
      progress.passed = [...new Set([...progress.passed, ...pending.checks])]
      for (const check of pending.checks) progress.passRuns[check] = run
    }
  } else {
    return { text: 'Unknown progress action.' }
  }
  const fixes = action === 'checks' ? checksLeft(progress, args.results) : ''
  return { changed: true, text: progress.limit ? limitText(progress.limit) : recorded + fixes }
}

function checksLeft(progress, results) {
  return results.filter(({ check }) => Object.hasOwn(progress.attempts, check))
    .map(({ check }) => ` ${JSON.stringify(check)} has ${Math.max(0, 1 + SOLVER_FIX_LIMIT - progress.attempts[check])} fix attempts left in Normal.`)
    .join('')
}
