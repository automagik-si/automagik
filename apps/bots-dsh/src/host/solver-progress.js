import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { SOLVER_FIX_LIMIT, SOLVER_REPLAN_LIMIT, isSolverBot, isWrittenSolverMethod, solverAutoOn } from '../shared/solver-method.js'
import { readableRoute } from './session-route.js'

const MAX_CHECKS = 20
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const count = value => Number.isSafeInteger(value) && value >= 0
const id = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_.:-]{0,79}$/.test(value)
const notDone = reason => ({ reason })
const MISSING_PASS = 'No verified passing evidence for this run. Start a new run on the current result.'
const listOfIds = value => Array.isArray(value) && value.length > 0 && value.length <= MAX_CHECKS
  && value.every(id) && new Set(value).size === value.length
const fingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const includesAll = (ids, values) => ids.length === values.length && ids.every(key => values.includes(key))
const commandOf = value => typeof value === 'string' && value.length <= 2_000 && value.trim() !== '' ? value.trim() : undefined
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
  return { request: randomUUID(), origin, attempts: {}, replans: 0, revision: 0, runs: {}, replanRuns: {}, passed: [] }
}

export function cleanProgress(value) {
  if (!record(value) || !id(value.request) || !['bot', 'person'].includes(value.origin)) return undefined
  const { request, origin } = value
  const attempts = Object.fromEntries(Object.entries(record(value.attempts) ? value.attempts : {})
    .filter(([check, number]) => id(check) && count(number)).slice(0, MAX_CHECKS))
  const plan = record(value.plan) && count(value.plan.revision) && listOfIds(value.plan.checks) ? value.plan : undefined
  const snapshot = fingerprint(value.snapshot) ? value.snapshot : undefined
  const passed = snapshot && plan && Array.isArray(value.passed) ? plan.checks.filter(check => value.passed.includes(check)) : []
  const limit = value.limit
  return {
    request, origin, attempts, passed,
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
  delete progress.snapshot
  delete progress.review
}

export function resumeProgress(progress, limit) {
  if (limit.kind === 'fix') progress.attempts[limit.check] = 0
  else progress.replans = 0
  delete progress.limit
}

// File identity and change times track local result changes without reading file contents.
export function resultSnapshot(folder) {
  if (typeof folder !== 'string' || !isAbsolute(folder)) return undefined
  const hash = createHash('sha256')
  let remaining = 20_000
  function visit(path, name, root = false) {
    if (--remaining < 0) throw new Error('Result has too many entries to verify.')
    const stat = lstatSync(path, { bigint: true })
    if (!stat.isDirectory() && !stat.isFile()) throw new Error('Result contains an unverifiable entry.')
    hash.update(JSON.stringify([name, stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)))
    if (stat.isDirectory()) {
      for (const child of readdirSync(path).sort()) {
        if (root && child === '.git') continue
        visit(join(path, child), child)
      }
      if (stat.ctimeNs !== lstatSync(path, { bigint: true }).ctimeNs) throw new Error('Result changed during verification.')
    }
  }
  try {
    visit(folder, folder, true)
    return hash.digest('hex')
  } catch {
    return undefined
  }
}

export function modelOf(rt, agent, session = agent?.session) {
  // Only the generation's route and the ACP option the live agent actually selected.
  try {
    const route = readableRoute(session?.requestHeader?.()?.config)
    if (!route) return undefined
    const acp = route.provider.startsWith('acp-')
    const model = acp
      ? rt.ctx.get?.('acpAgents')?.effectiveModelOf?.(session?.id ?? agent?.id, route.provider) : route.model
    if (typeof model !== 'string') return undefined
    const slug = model.trim().toLowerCase().split(route.provider === 'acp-hermes' ? /[:/]/ : '/').at(-1)
    if (!slug || slug.endsWith('-latest') || /^(?:default|auto|unknown|opus|sonnet|haiku|fable)(?:plan)?(?:\[1m\])?$/.test(slug)) return undefined
    // A CLI's friendly choices (including "latest") cannot prove a model identity.
    if (acp && !/^(?:claude|gpt|o[1-9]|gemini|deepseek|qwen|llama|mistral|grok)[.-][a-z0-9.-]*\d[a-z0-9.\[\]-]*$/.test(slug)) return undefined
    return slug.replace(/\[1m\]$/, '').replace(/-\d{8}$/, '')
      .replace(/^claude-(\d+-\d+)-(opus|sonnet|haiku)$/, 'claude-$2-$1')
  } catch {
    return undefined
  }
}

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
  if (review !== 'bot' || pending || result?.revision !== progress.revision || result.verdict !== 'SHIP'
    || result.solverModel !== model || result.reviewer?.id !== bot.reviewerId || !result.reviewer.model) return notDone('review')
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

export function recordSolverVerdict(progress, exchangeId, reviewer, verdict, model) {
  if (!progress || typeof exchangeId !== 'string') return
  const plan = progress.plan
  if (plan?.review?.exchangeId === exchangeId && plan.review.reviewerId === reviewer.id) {
    progress.plan = { ...plan, accepted: verdict === 'SHIP', review: { ...plan.review, verdict: verdict ?? 'unverified' } }
  }
  const result = progress.review
  if (result?.exchangeId === exchangeId && result.reviewerId === reviewer.id && result.revision === progress.revision) {
    progress.review = {
      ...result,
      verdict: model && model !== result.solverModel ? (verdict ?? 'unverified') : 'unverified',
      ...(model && model !== result.solverModel ? { reviewer: { id: reviewer.id, name: reviewer.name, model } } : {}),
    }
  } else if (result?.verdict === 'SHIP' && ['FIX-FIRST', 'BLOCKED'].includes(verdict)) {
    progress.review = { ...result, verdict }
  }
}

export function recordProgress(bot, track, args, { now, authorizedAuto, running, snapshot } = {}) {
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
    return { text: limit ? limitText(limit) : prior?.unverified ? MISSING_PASS : recorded }
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
    progress.pending = { run, checks: [...checks], revision: progress.revision }
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
      if (pending.checks.length !== 1 || evidence?.pass !== true || !fingerprint(evidence.snapshot)
        || evidence.snapshot !== snapshot || pending.revision !== progress.revision) {
        progress.passed = progress.passed.filter(check => !pending.checks.includes(check))
        progress.runs[run].unverified = true
        return { changed: true, text: MISSING_PASS }
      }
      progress.snapshot = snapshot
      progress.passed = [...new Set([...progress.passed, ...pending.checks])]
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
