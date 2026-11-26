import { chosenIdentity, chosenIdentityOf } from '../shared/solver-model.js'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readlinkSync, readSync, realpathSync, statfsSync } from 'node:fs'
import { extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { SOLVER_FIX_LIMIT, SOLVER_REPLAN_LIMIT, isSolverBot, isWrittenSolverMethod, solverAutoOn } from '../shared/solver-method.js'
import { guardVerdictMatch } from '../shared/review-guard.js'
import { normalizeCheckCommand } from './solver-check-command.js'

const MAX_CHECKS = 20
const MAX_RESULT_ENTRIES = 20_000
const MAX_IMAGE_BASE = 1_000
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'])
const png = Buffer.from('89504e470d0a1a0a', 'hex')
const jpeg = Buffer.from('ffd8ff', 'hex')
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
  const base = value.imageBase
  const imageBase = base?.v === 1 && (base.indeterminate === true || (Array.isArray(base.keys)
    && base.keys.length <= MAX_IMAGE_BASE && base.keys.every(key => typeof key === 'string' && /^[a-f0-9]{16}$/.test(key))))
    ? base : undefined
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
    ...(imageBase ? { imageBase } : {}),
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
const sameFile = (a, b) => b.isFile() && b.nlink === 1n && sameVersion(a, b)
  && a.size === b.size && a.mtimeNs === b.mtimeNs
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

const fdPath = fd => join(FD_ROOT, String(fd))
const openDirectory = path => openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)

export function resultImageType(bytes, { gif = false } = {}) {
  if (bytes.subarray(0, 8).equals(png)) return 'image/png'
  if (bytes.subarray(0, 3).equals(jpeg)) return 'image/jpeg'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (gif && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif'
}

function canReadResultEntry(parts, botId) {
  if (parts.some(part => part.toLowerCase() === '.git')) return false
  if (parts.some((part, i) => part.toLowerCase() === 'objects'
    && /^[a-f0-9]{2}$/i.test(parts[i + 1]) && /^(?:[a-f0-9]{62}|[a-f0-9]{64})$/i.test(parts[i + 2]))) return false
  const managed = parts.findIndex(part => part.toLowerCase() === '.automagik')
  if (managed === -1) return true
  if (managed !== 0 || parts.slice(1).some(part => part.toLowerCase() === '.automagik')) return false
  return parts[1] === 'bots' && parts[2] === botId && parts.length > 3 && parts[3].toLowerCase() !== 'uploads'
}

function checkedRead(path, stat, bytes, signal, deadline) {
  const checkTime = () => {
    signal?.throwIfAborted()
    if (performance.now() > deadline) throw snapshotError('The result file was not read in time.')
  }
  checkTime()
  if (!stat.isFile() || stat.nlink !== 1n) throw snapshotError('The result file must be regular and have one link.')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    if (!sameFile(stat, directoryStat(fd))) throw snapshotError(changedDuringRead)
    const data = Buffer.alloc(bytes)
    for (let offset = 0; offset < data.length;) {
      checkTime()
      const count = readSync(fd, data, offset, Math.min(64 * 1024, data.length - offset), offset)
      if (count === 0) throw snapshotError(changedDuringRead)
      offset += count
    }
    checkTime()
    if (!sameFile(stat, directoryStat(fd)) || !sameFile(stat, entryStat(path))) throw snapshotError(changedDuringRead)
    return data
  } finally {
    closeSync(fd)
  }
}

const partsOf = path => path.split(sep === '\\' ? /[\\/]/ : '/')
const cleanPart = part => part !== '' && part !== '.' && part !== '..' && !part.includes('\0')
  && (sep !== '\\' || (!/[<>:"|?*]/.test(part) && !/[ .]$/.test(part)))

export function readResultFile(folder, selector, { botId, maxBytes, signal, allowPath }) {
  if (!folder || !isAbsolute(folder) || typeof selector !== 'string') throw snapshotError('The Solver has no usable result path.')
  const absolute = isAbsolute(selector)
  if (!partsOf(absolute ? selector.slice(parse(selector).root.length) : selector).every(cleanPart)) {
    throw snapshotError('Use a path inside the result folder without empty, dot, or parent components.')
  }
  const selectedRoot = resolve(folder)
  const rootStat = entryStat(selectedRoot)
  if (!rootStat.isDirectory()) throw snapshotError(rootStat.isSymbolicLink()
    ? 'The result root is a symbolic link.' : 'The result root is not a directory.')
  const root = realpathSync.native(selectedRoot)
  let name = selector
  if (absolute) {
    name = relative(selectedRoot, selector)
    if (isAbsolute(name) || !partsOf(name).every(cleanPart)) name = relative(root, selector)
  }
  const parts = partsOf(name)
  if (isAbsolute(name) || !parts.every(cleanPart)) throw snapshotError('Use a path inside the result folder.')
  if (!canReadResultEntry(parts, botId) || allowPath?.(join(root, ...parts)) === false) {
    throw snapshotError('The result picture is in a protected folder.')
  }
  const confined = hasDescriptorPaths()
  if (!confined && process.platform === 'linux') throw snapshotError('Confined result reads are unavailable.')
  const held = []
  const deadline = performance.now() + 10_000
  let parent = parse(root).root
  let parentPath = parent
  const rootComponents = partsOf(root.slice(parent.length)).filter(Boolean)
  try {
    for (const component of ['', ...rootComponents, ...parts.slice(0, -1)]) {
      parent = join(parent, component)
      parentPath = join(parentPath, component)
      const stat = entryStat(parent)
      if (!stat.isDirectory()) throw snapshotError('A result directory is a symbolic link or is not a directory.')
      if (parentPath === root && !sameVersion(rootStat, stat)) throw snapshotError(changedDuringRead)
      const entry = { path: parent, stat }
      held.push(entry)
      if (confined) {
        entry.fd = openDirectory(parent)
        if (!sameVersion(stat, directoryStat(entry.fd))) throw snapshotError(changedDuringRead)
        parent = fdPath(entry.fd)
      }
    }
    const leaf = join(parent, parts.at(-1))
    const stat = entryStat(leaf)
    if (stat.isSymbolicLink()) throw snapshotError('The result picture is a symbolic link.')
    if (stat.size < 1n || stat.size > BigInt(maxBytes)) throw snapshotError('The result picture is empty or exceeds 12 MiB.')
    const bytes = checkedRead(leaf, stat, Number(stat.size), signal, deadline)
    for (const { path, stat, fd } of held) {
      const current = entryStat(path)
      if (!current.isDirectory() || !sameEntry(stat, current)
        || (fd !== undefined && !sameEntry(stat, directoryStat(fd)))) throw snapshotError(changedDuringRead)
    }
    if (!sameVersion(rootStat, entryStat(selectedRoot))) throw snapshotError(changedDuringRead)
    return { bytes, path: name }
  } finally {
    for (const { fd } of held.reverse()) if (fd !== undefined) closeSync(fd)
  }
}

export function imageBaseline(result) {
  const manifest = result.manifest
  return !manifest || manifest.indeterminate || manifest.entries.length > MAX_IMAGE_BASE
    ? { v: 1, indeterminate: true }
    : { v: 1, keys: manifest.entries.map(entry => entry.key.slice(0, 16)).sort() }
}

export function inspectResult(folder, { manifest = false, botId, managedEntry, signal, allowPath } = {}) {
  if (typeof folder !== 'string' || !isAbsolute(folder)) return { reason: 'The Solver has no usable result folder.' }
  const selectedRoot = resolve(folder)
  let root = selectedRoot
  const hash = createHash('sha256')
  let remaining = MAX_RESULT_ENTRIES - 1
  const images = []
  let indeterminate = false
  const deadline = performance.now() + 10_000
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
        const tracked = children.filter(child => visit(join(directoryPath, child), join(locationOfEntry, child), child))
        location = locationOfEntry
        if (!sameVersion(stat, entryStat(path))) throw snapshotError(changedDuringRead)
        if (!isRoot && tracked.length === 0 && managedEntry?.(location, stat)) return false
        hash.update(JSON.stringify([...identity, tracked]))
      } finally {
        if (fd !== undefined) closeSync(fd)
      }
    } else if (stat.isFile()) {
      if (managedEntry?.(locationOfEntry, stat)) return false
      const changes = [stat.size, stat.mtimeNs, stat.ctimeNs].map(String)
      hash.update(JSON.stringify([...identity, ...changes]))
      const pathInResult = relative(root, locationOfEntry)
      if (manifest && canReadResultEntry(partsOf(pathInResult), botId) && allowPath?.(locationOfEntry) !== false) {
        try {
          const extension = IMAGE_EXTENSIONS.has(extname(name).toLowerCase())
          if (!descriptorPaths && process.platform === 'linux') throw snapshotError('Confined result reads are unavailable.')
          if (extension || resultImageType(checkedRead(path, stat, Number(stat.size < 12n ? stat.size : 12n), signal, deadline), { gif: true })) {
            const key = createHash('sha256').update(JSON.stringify([pathInResult, ...identity.slice(1, 3), ...changes])).digest('hex')
            images.push({ path: pathInResult, key })
          }
        } catch {
          indeterminate = true
        }
      }
    } else if (stat.isSymbolicLink()) {
      const target = readlinkSync(path, { encoding: 'buffer' }).toString('hex')
      if (!sameVersion(stat, entryStat(path))) throw snapshotError(changedDuringRead)
      const changes = [stat.size, stat.mtimeNs, stat.ctimeNs].map(String)
      hash.update(JSON.stringify([...identity, ...changes, 'link', target]))
    } else {
      throw snapshotError(`It contains a device, pipe or socket at ${shown(location)}.`)
    }
    return true
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
    return { snapshot: hash.digest('hex'), ...(manifest ? { manifest: { entries: images, indeterminate } } : {}) }
  } catch (error) {
    return { reason: error.reason ?? (error.code
      ? `An entry at ${shown(location)} could not be read (${error.code}).` : 'It could not be read.') }
  } finally {
    for (const { fd } of parents.reverse()) closeSync(fd)
  }
}

export const resultSnapshot = (folder, options) => inspectResult(folder, options).snapshot

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

export function solverOutcome(bot, track, review, pending, model, snapshot, visualKind) {
  const progress = track.solver
  const limit = activeSolverLimit(bot, track)
  if (limit) return { reason: 'limit', limit: { kind: limit.kind, ...(limit.check ? { check: limit.check } : {}) } }
  if (!progress || !passes(progress, snapshot)) return notDone('checks')
  const result = progress.review
  if (legacyResultReview(result) || review !== 'bot' || pending || result?.revision !== progress.revision || result.verdict !== 'SHIP'
    || chosenIdentityOf(result.solverModel) !== model || result.reviewer?.id !== bot.reviewerId
    || !result.reviewer.model || chosenIdentityOf(result.reviewer.model) === model) return notDone('review')
  if (result.images?.v === 1 ? result.images.definite !== true || (result.images.kind !== 'text' && result.visualOk !== true)
    : visualKind !== undefined && visualKind !== 'text') return notDone('review')
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

export function recordSolverVerdict(progress, exchangeId, reviewer, verdict, model, receipt, legacyHeld, visual) {
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
    const imagesWhy = visual?.ok === true ? undefined : visual?.why
      ?? (result.images?.v === 1 && result.images.kind !== 'text' ? 'missing' : undefined)
    const reason = legacyHeld && !comparable ? 'held'
      : veto ? undefined
        : imagesWhy ? 'images' : !comparable ? 'model' : !independent ? 'same' : verdict === undefined ? 'verdict' : undefined
    const { unverified: _previous, reviewer: _reviewer, receipt: _receipt, imagesWhy: _why, visualOk: _visual, ...designated } = result
    progress.review = {
      ...designated,
      verdict: reason && !veto ? 'unverified' : verdict,
      ...(independent ? { reviewer: { id: reviewer.id, name: reviewer.name, model: reviewerIdentity } } : {}),
      ...(reason ? { unverified: reason } : {}),
      ...(reason === 'images' ? { imagesWhy } : {}),
      ...(reason === undefined && verdict === 'SHIP' && visual?.ok === true ? { visualOk: true } : {}),
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
  const idFormat = 'An ID is 1 to 80 characters: letters, digits, "_", ".", ":" or "-", starting with a letter or digit; case does not matter.'
  const key = value => typeof value === 'string' ? value.replace(/[A-Z]/g, letter => letter.toLowerCase()) : value
  const { action } = args
  const run = key(args.run)
  const checks = Array.isArray(args.checks) ? args.checks.map(key) : args.checks
  const results = Array.isArray(args.results)
    ? args.results.map(item => record(item) ? { ...item, check: key(item.check) } : item) : args.results
  const commands = Array.isArray(args.commands)
    ? args.commands.map(item => record(item) ? { ...item, check: key(item.check) } : item) : args.commands
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
    if (JSON.stringify(results) !== (prior?.reported ?? prior)) return { text: 'This run ID already has different results.' }
    if (!prior?.unverified && Array.isArray(results) && results.every(item => item?.pass === true)) {
      const snapshot = prior?.evidence?.snapshot
      // A legacy report without per-check ownership cannot establish a current replay.
      if (prior?.revision !== progress.revision || !snapshot || snapshot !== progress.snapshot
        || results.some(({ check }) => progress.passRuns[check] !== run) || snapshot !== snapshotOf?.()) {
        return { text: 'This passing report is stale. Start a new run on the current result.' }
      }
    }
    return { text: limit ? limitText(limit) : prior?.unverified ? missingPass(prior.reason) : recorded }
  }
  if (limit) return { text: limitText(limit) }
  if (running) return { text: 'Wait for the current work to finish before updating Solver progress.' }
  if (action === 'plan') {
    if (!listOfIds(checks)) return { text: `Register 1 to 20 distinct, stable check IDs. ${idFormat}` }
    if (progress.pending) return { text: 'Record the open run before replacing the plan.' }
    const byCheck = checkCommands(commands, checks)
    if (commands !== undefined && !byCheck) return { text: 'Give one command for each agreed check ID.' }
    if (progress.plan && !progress.plan.superseded) {
      const sameCommands = checks.every(check => byCheck?.[check] === progress.plan.commands?.[check])
      return { text: includesAll(progress.plan.checks, checks) && sameCommands
        ? recorded : 'Record a re-plan before replacing the agreed checks or commands.' }
    }
    // Keep the agreed text for the reviewer and DSH's exact command comparison.
    for (const [check, command] of Object.entries(byCheck ?? {})) {
      const { reason } = normalizeCheckCommand(command)
      if (reason) return { text: `Cannot register check ${JSON.stringify(check)}. ${reason}` }
    }
    if (new Set([...Object.keys(progress.attempts), ...checks]).size > MAX_CHECKS) return { text: 'Use at most 20 check IDs per request.' }
    progress.plan = { revision: progress.revision, checks: [...checks], ...(byCheck ? { commands: byCheck } : {}) }
    return { changed: true, text: recorded }
  }
  if (!id(run)) return { text: `Provide a stable run ID. ${idFormat}` }
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
  const fixes = action === 'checks' ? checksLeft(progress, results) : ''
  return { changed: true, text: progress.limit ? limitText(progress.limit) : recorded + fixes }
}

function checksLeft(progress, results) {
  return results.filter(({ check }) => Object.hasOwn(progress.attempts, check))
    .map(({ check }) => ` ${JSON.stringify(check)} has ${Math.max(0, 1 + SOLVER_FIX_LIMIT - progress.attempts[check])} fix attempts left in Normal.`)
    .join('')
}
