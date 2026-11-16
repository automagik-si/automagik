#!/usr/bin/env node
// What the image does once, on the first start of a data volume: put the reviewed skills where
// the agents read them, create a fresh three-role team when the workspace has no Herdr roster,
// and run #1424's published seed so both version 2 registry surfaces exist. The vendor CLIs are
// installed separately, in the background, by installVendorClis(): they are hundreds of MB and
// come from registry.npmjs.org, so they must never be baked into the image.
//
// No registry is written by hand. Until #1424 merges, the seed is the published bytes of PR
// #1428's head (vendored under server/vendor/registry-seed); once the installed plugin carries
// it, seedScript() prefers that path. A seed failure (exit 1 or 2) fails the boot: the whole
// point is a team whose roster and both readers agree.
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  AGENTS_RELATIVE,
  CLI_STORE_RELATIVE,
  PNPM_PATH,
  REGISTRY_SEED_COMMIT,
  REGISTRY_SEED_INSTALLED,
  REGISTRY_SEED_SHA256,
  REGISTRY_SEED_VENDOR,
  SKILL_NAME,
  SKILL_ROOT,
  SKILL_SHA256,
} from './toolchain.mjs'

export const FIRST_BOOT_MARKER = '.automagik-first-boot.json'
/** Where Claude Code and Codex look for their skills; each is a link to the shared folder. */
export const SKILL_LINKS = Object.freeze(['.claude', '.codex'])
/**
 * The fresh team a new project starts with. The ids are minted by `am create`, never copied.
 * The model is the reviewed per-role route; reasoning effort and service tier are deliberately
 * absent (per-bot effort/tier is #1411, not a roster field yet). UI work goes through the
 * approved Claude route; a Sol/Terra author's code review comes from another provider.
 */
export const TRIAD = Object.freeze([
  Object.freeze({
    name: 'Purpose',
    kind: 'main',
    model: 'gpt-6-astra',
    role: 'Own the project outcome',
    instructions: 'Own a bounded product outcome: prioritize the queue, state acceptance criteria, resolve dependencies and accept evidenced delivery. UI work goes through the approved Claude route (Fable 5.2; catalog id pending #1415).',
  }),
  Object.freeze({
    name: 'Dogfooder',
    kind: 'member',
    model: 'gpt-6.1-terra',
    role: 'Verify the product',
    instructions: 'Exercise the product against the outcome, produce reproducible failures and independently verify fixes, keeping the acceptance evidence. UI work goes through the approved Claude route (Fable 5.2; catalog id pending #1415). A Sol or Terra author\'s code review comes from another provider, Opus for critical work, never Terra reviewing Sol.',
  }),
  Object.freeze({
    name: 'Fixer',
    kind: 'member',
    model: 'gpt-6.1-sol',
    role: 'Implement the change',
    instructions: 'Implement the increment or repair in a worktree, run the relevant gates, and return the patch and evidence. UI work goes through the approved Claude route (Fable 5.2; catalog id pending #1415). A Sol or Terra author\'s code review comes from another provider, Opus for critical work, never Terra reviewing Sol.',
  }),
])

const lstatOrUndefined = (path) => {
  try { return lstatSync(path) } catch { return undefined }
}
export const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** Why the installed skill at `target` is not the pinned payload, or an empty list when it is. */
export function skillProblems(target) {
  const problems = []
  for (const [relative, expected] of Object.entries(SKILL_SHA256)) {
    const file = join(target, relative)
    if (!existsSync(file)) { problems.push(`${relative}: missing`); continue }
    const actual = sha256File(file)
    if (actual !== expected) problems.push(`${relative}: sha256 ${actual}, not ${expected}`)
  }
  return problems
}

/**
 * Install the read-only skill into the shared agents folder and link it for Claude Code and
 * Codex. An existing folder with other bytes is never overwritten: it is the person's, and the
 * caller reports the conflict. Returns the state of the folder and of each link.
 */
export function installSkill({
  home,
  source = SKILL_ROOT,
  name = SKILL_NAME,
  log = console.log,
  warn = console.warn,
  fs = { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync },
} = {}) {
  const from = join(source, name)
  for (const [relative, expected] of Object.entries(SKILL_SHA256)) {
    const actual = createHash('sha256').update(fs.readFileSync(join(from, relative))).digest('hex')
    if (actual !== expected) throw new Error(`${name}/${relative}: sha256 ${actual}, not the pinned ${expected}`)
  }
  const target = join(home, '.agents', 'skills', name)
  const current = Object.entries(SKILL_SHA256).filter(([relative, expected]) => (
    !fs.existsSync(join(target, relative)) || createHash('sha256').update(fs.readFileSync(join(target, relative))).digest('hex') !== expected
  ))
  let state
  if (current.length === 0) state = 'present'
  else if (lstatOrUndefined(target)) {
    warn(`skill ${name}: ${target} exists with other bytes; left as it is`)
    state = 'conflict'
  } else {
    fs.mkdirSync(dirname(target), { recursive: true })
    fs.cpSync(from, target, { recursive: true })
    for (const relative of Object.keys(SKILL_SHA256)) fs.chmodSync(join(target, relative), 0o444)
    log(`skill ${name}: installed at ${target}`)
    state = 'installed'
  }
  const relative = join('..', '..', '.agents', 'skills', name)
  const links = []
  for (const vendor of SKILL_LINKS) {
    const link = join(home, vendor, 'skills', name)
    const existing = lstatOrUndefined(link)
    if (existing) {
      if (existing.isSymbolicLink() && fs.readlinkSync(link) === relative) links.push({ path: link, state: 'present' })
      else {
        warn(`skill ${name}: ${link} exists and is not this link; left as it is`)
        links.push({ path: link, state: 'conflict' })
      }
      continue
    }
    fs.mkdirSync(dirname(link), { recursive: true })
    fs.symlinkSync(relative, link)
    links.push({ path: link, state: 'linked' })
  }
  return { state, target, links }
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const rosterOf = (workspace) => join(workspace, '.herdr', 'bots.json')
const homeRegistryOf = (home) => join(home, 'bots', 'bots.json')
const repoRegistryOf = (workspace) => join(workspace, '.automagik', 'bots', 'bots.json')

/** A `b-` id, as `am create` mints one. No id is ever copied from another team. */
const BOT_ID = /^b-[a-z2-7]{10}$/
const NO_MODEL_LIST = /There is no list of [a-z]+ models to pin from/i
const noModelList = (error) => NO_MODEL_LIST.test(`${error?.stderr ?? ''}\n${error?.message ?? ''}`)
const MODEL_PIN_STATE = 'model-pin-state.json'
const modelPinStateOf = (home) => join(home, 'bots', MODEL_PIN_STATE)
const pinPendingLine = (model) => `Model pin pending: ${model}. No task starts while the team is model-pin pending; this clears after all three reviewed pins are applied and the v1/v2 registries verify.`
const clearPinPendingLine = (instructions) => String(instructions ?? '').replace(/\n*Model pin pending:[^\n]*/g, '').trimEnd()

/** The authoritative model-pin state: pending, ready (verified), failed, conflict or unknown. */
export function readModelPinState(home) {
  const file = modelPinStateOf(home)
  if (!existsSync(file)) return { state: 'unknown', pins: [] }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const state = ['pending', 'ready', 'failed', 'conflict'].includes(parsed?.state) ? parsed.state : 'unknown'
    const pins = Array.isArray(parsed?.pins)
      ? parsed.pins.filter((pin) => pin && typeof pin.id === 'string' && typeof pin.model === 'string') : []
    return { ...parsed, state, pins }
  } catch {
    return { state: 'unknown', pins: [] }
  }
}

/** The pins still owed; null means unknown/corrupt, [] means verified ready. */
export function readPendingPins(home) {
  const state = readModelPinState(home)
  if (state.state === 'unknown') return null
  return state.state === 'ready' ? [] : state.pins
}

function writeModelPinState(home, state, { pins = [], superseded = [], conflicts = [], receipt = null, error = null } = {}) {
  const file = modelPinStateOf(home)
  mkdirSync(dirname(file), { recursive: true })
  const text = `${JSON.stringify({ version: 1, state, pins, ...(superseded.length ? { superseded } : {}), ...(conflicts.length ? { conflicts } : {}), ...(receipt ? { receipt } : {}), ...(error ? { error } : {}) }, null, 2)}\n`
  writeFileSync(file, text, { mode: 0o600 })
  chmodSync(file, 0o600)
}

/** The evidence a ready state carries: what the three surfaces held at verification time. */
function modelPinReceipt({ home, workspace, now = () => new Date().toISOString() }) {
  const models = (bot) => ({ id: bot?.id, name: bot?.name, model: bot?.model })
  const v1 = readJson(rosterOf(workspace))
  const repo = existsSync(repoRegistryOf(workspace)) ? readJson(repoRegistryOf(workspace)) : null
  const homeRegistry = existsSync(homeRegistryOf(home)) ? readJson(homeRegistryOf(home)) : null
  return {
    version: 1,
    verifiedAt: now(),
    v1: (v1.bots ?? []).map(models),
    repo: (repo?.bots ?? []).map(models),
    home: (homeRegistry?.bots ?? []).filter((bot) => bot?.folder === workspace).map(models),
  }
}

/**
 * Fill a resolved pin into the v2 repo and home surfaces without overwriting a person. A model
 * already set on that surface is preserved; if it differs from v1 it is a conflict, not a
 * correction. Only our "Model pin pending" line is removed from that surface's own instructions;
 * other edits stay. Nothing is written for an id that did not resolve, so a no-progress retry
 * leaves all three roster files byte-identical.
 */
function fillV2Surfaces({ home, workspace, ids }) {
  const resolved = new Set(ids)
  if (!resolved.size) return []
  const v1 = readJson(rosterOf(workspace))
  const v1Bots = Array.isArray(v1.bots) ? v1.bots : []
  const conflicts = []
  const fill = (file, surface, match) => {
    if (!existsSync(file)) return
    const registry = readJson(file)
    let changed = false
    for (const bot of Array.isArray(registry.bots) ? registry.bots : []) {
      if (!resolved.has(bot?.id) || !match(bot)) continue
      const source = v1Bots.find((candidate) => candidate?.id === bot.id)
      if (!source) continue
      if (source.model !== undefined) {
        if (bot.model === undefined) { bot.model = source.model; changed = true }
        else if (bot.model !== source.model) conflicts.push({ surface, id: bot.id, field: 'model', have: bot.model, want: source.model })
      } else if (bot.model !== undefined) {
        conflicts.push({ surface, id: bot.id, field: 'model', have: bot.model, want: null })
      }
      const clean = clearPinPendingLine(bot.instructions)
      if (clean !== String(bot.instructions ?? '').trimEnd()) { bot.instructions = clean; changed = true }
      if (source.instructions !== undefined && clean !== source.instructions) {
        conflicts.push({ surface, id: bot.id, field: 'instructions', have: clean, want: source.instructions })
      }
    }
    if (changed) writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`, { mode: statSync(file).mode & 0o777 })
  }
  fill(repoRegistryOf(workspace), 'repo', () => true)
  fill(homeRegistryOf(home), 'home', (bot) => bot?.folder === workspace)
  return conflicts
}

/**
 * Apply the pins a no-list first boot could not set. am edit refuses with its no-list message
 * until ~/.codex/models_cache.json (or the config default) gives a catalogue; every other
 * failure is logged and the pin is kept. A model a person set to something else is never
 * overwritten: the reviewed pin is reported superseded and that Bot's pending marker is removed.
 * The version 2 copies are patched to the v1 model and instructions; the pending file is only
 * cleared by runFirstBoot after verifySurfaces passes.
 */
export function applyPendingPins({
  home,
  workspace,
  env = process.env,
  am = env.AUTOMAGIK_AM || 'am',
  run,
  log = console.log,
  warn = console.warn,
} = {}) {
  const pending = readPendingPins(home)
  if (pending === null) {
    log('pins: model-pin state is unknown; no roster is written')
    return { state: 'unknown', applied: [], superseded: [], pending: [], conflicts: [], noList: false }
  }
  if (!pending.length) {
    log('pins: no pending model pins; no-op')
    return { state: 'none', applied: [], superseded: [], pending: [], conflicts: [], noList: false }
  }
  const exec = run ?? process.getBuiltinModule('node:child_process').execFileSync
  const childEnv = {
    ...env,
    HOME: env.HOME || home,
    HERDR_APP_HOME: env.HERDR_APP_HOME || join(home, '.config', 'herdr-app'),
    AUTOMAGIK_HOME: home,
  }
  const applied = []
  const superseded = []
  const left = []
  const resolved = []
  let sawNoList = false
  const save = (bot, args) => {
    exec(am, ['edit', bot.id, '--project', workspace, ...args, '--json'], {
      cwd: workspace, env: childEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
    })
    return (readJson(rosterOf(workspace)).bots ?? []).find((candidate) => candidate?.id === bot.id)
  }
  for (const pin of pending) {
    const bot = (readJson(rosterOf(workspace)).bots ?? []).find((candidate) => candidate?.id === pin.id)
    if (!bot) { warn(`pins: ${pin.name ?? pin.id} is no longer in the v1 roster; kept for the next boot`); left.push(pin); continue }
    const clean = clearPinPendingLine(bot.instructions)
    const marker = clean !== String(bot.instructions ?? '').trimEnd()
    if (bot.model !== undefined && bot.model !== pin.model) {
      superseded.push({ pin, model: bot.model })
      resolved.push(bot.id)
      log(`pins: ${pin.name ?? pin.id} keeps the person's model ${bot.model}; reviewed ${pin.model} superseded`)
      if (marker) {
        try { save(bot, ['--instructions', clean]) } catch (error) { warn(`pins: ${pin.name ?? pin.id} marker not cleared: ${error?.message ?? error}`); left.push(pin) }
      }
      continue
    }
    try {
      const args = []
      if (bot.model === undefined) args.push('--model', pin.model)
      if (marker) args.push('--instructions', clean)
      const after = args.length ? save(bot, args) : bot
      if (after?.model !== undefined && after.model !== pin.model) throw new Error(`${am} edit ${pin.id} did not save the pin`)
      if (clearPinPendingLine(after?.instructions) !== String(after?.instructions ?? '').trimEnd()) throw new Error(`${am} edit ${pin.id} did not clear the pending marker`)
      applied.push(pin)
      resolved.push(bot.id)
      log(`pins: ${pin.name ?? pin.id} -> ${pin.model}`)
    } catch (error) {
      if (noModelList(error)) { sawNoList = true; log(`pins: waiting for the Codex model catalogue; ${pending.length} pin${pending.length === 1 ? '' : 's'} pending`) }
      else warn(`pins: ${pin.name ?? pin.id} was not pinned: ${error?.stderr?.trim() || error?.message || error}`)
      left.push(pin)
    }
  }
  const conflicts = fillV2Surfaces({ home, workspace, ids: resolved })
  return {
    state: conflicts.length ? 'conflict' : left.length ? (resolved.length ? 'partial' : 'pending') : 'pinned',
    applied, superseded, pending: left, conflicts, noList: sawNoList,
  }
}

/**
 * Create the fresh triad through `am create` when the workspace has no Herdr roster. The ids
 * come from am (newBotId), not from a template or another team's file. When am has no Codex
 * model catalogue (a fresh HOME has no ~/.codex/models_cache.json), the triad is created
 * unpinned, each Bot's instructions and roster say "Model pin pending", and the three reviewed
 * pins are recorded for a later am edit. A partial failure removes the roster it just made.
 */
export function ensureTeam({
  home,
  workspace,
  env = process.env,
  am = env.AUTOMAGIK_AM || 'am',
  run,
  log = console.log,
  warn = console.warn,
} = {}) {
  const roster = rosterOf(workspace)
  if (existsSync(roster)) return { state: 'present', roster }
  const exec = run ?? process.getBuiltinModule('node:child_process').execFileSync
  const childEnv = {
    ...env,
    HOME: env.HOME || home,
    HERDR_APP_HOME: env.HERDR_APP_HOME || join(home, '.config', 'herdr-app'),
    AUTOMAGIK_HOME: home,
  }
  mkdirSync(workspace, { recursive: true })
  const create = (pinned) => {
    const made = []
    let lead
    for (const role of TRIAD) {
      const instructions = pinned ? role.instructions : `${role.instructions}\n\n${pinPendingLine(role.model)}`
      const args = ['create', '--project', workspace, '--name', role.name, '--agent', 'codex',
        '--kind', role.kind, '--role', role.role, '--instructions', instructions]
      if (pinned) args.push('--model', role.model)
      if (lead) args.push('--lead', lead)
      args.push('--json')
      const output = exec(am, args, {
        cwd: workspace,
        env: childEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      })
      let result
      try { result = JSON.parse(output) } catch { throw new Error(`${am} create ${role.name} printed no JSON: ${String(output).trim().slice(0, 300)}`) }
      if (!BOT_ID.test(result?.id ?? '')) throw new Error(`${am} create ${role.name} minted no b- id`)
      if (role.kind === 'main') lead = result.id
      made.push({ name: role.name, id: result.id, kind: role.kind, role: role.role })
      log(`team: created by am create: ${role.name} (${role.kind}) ${result.id} role="${role.role}"`)
    }
    const v1 = readJson(roster)
    const mains = Array.isArray(v1.bots) ? v1.bots.filter((bot) => bot?.kind === 'main') : []
    if (v1.version !== 1 || mains.length !== 1 || mains[0].name !== 'Purpose' || v1.bots.length !== TRIAD.length) {
      throw new Error(`${roster} does not hold the fresh triad: ${v1.bots?.length ?? 0} bots, ${mains.length} main`)
    }
    return { made, lead }
  }
  try {
    let created
    try {
      created = create(true)
    } catch (error) {
      rmSync(roster, { force: true })
      if (!noModelList(error)) throw error
      log('team: no Codex model catalogue (am reads ~/.codex/models_cache.json plus the config default); creating the triad unpinned and recording all three pins')
      created = create(false)
      return {
        state: 'created', roster, bots: created.made, mainId: created.lead, pinned: false,
        pendingPins: created.made.map((bot) => ({ id: bot.id, name: bot.name, model: TRIAD.find((role) => role.name === bot.name).model })),
      }
    }
    return { state: 'created', roster, bots: created.made, mainId: created.lead, pinned: true }
  } catch (error) {
    // Only the file this call made: an existing roster is never removed.
    try { rmSync(roster, { force: true }) } catch {}
    warn(`team: not created: ${error?.stderr?.trim() || error?.message || error}`)
    throw error
  }
}

/** The real #1424 seed: the installed plugin's script when it is there, else the vendored bytes. */
export function seedScript({ profile, vendorRoot = REGISTRY_SEED_VENDOR } = {}) {
  const root = resolve(vendorRoot)
  const installed = join(profile, REGISTRY_SEED_INSTALLED)
  if (existsSync(installed)) return { path: installed, source: 'installed', commit: null }
  const vendored = join(root, 'scripts', 'seed-registry.mjs')
  for (const [relative, expected] of Object.entries(REGISTRY_SEED_SHA256)) {
    const file = join(root, relative)
    const actual = sha256File(file)
    if (actual !== expected) throw new Error(`registry seed vendor ${relative}: sha256 ${actual}, not ${expected}`)
  }
  return { path: vendored, source: 'vendored', commit: REGISTRY_SEED_COMMIT }
}

/**
 * Run #1424's seed when the workspace has a version 1 roster. It takes the two flags the
 * published contract names exactly: `--project <checkout>` and `--home <registry home>`. Exit 0
 * is success; 1 (operational) and 2 (usage) are failures and fail the boot with its stderr.
 */
export function seedRegistry({
  home,
  workspace,
  profile,
  env = process.env,
  run,
  vendorRoot = REGISTRY_SEED_VENDOR,
  log = console.log,
  warn = console.warn,
} = {}) {
  const roster = rosterOf(workspace)
  if (!existsSync(roster)) {
    throw new Error(`first boot: no version 1 roster at ${roster}; the seed mints no Bot ids`)
  }
  const script = seedScript({ profile, vendorRoot })
  const exec = run ?? process.getBuiltinModule('node:child_process').execFileSync
  let stdout
  try {
    stdout = exec(process.execPath, [script.path, '--project', workspace, '--home', home], {
      cwd: workspace,
      env: { ...env, AUTOMAGIK_HOME: home },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    })
  } catch (error) {
    const stderr = String(error?.stderr ?? '').trim()
    throw new Error(`first boot: registry seed (${script.source}) failed with exit ${error?.status ?? 'unknown'}: ${stderr || error?.message || error}`)
  }
  for (const line of String(stdout ?? '').trim().split('\n').filter(Boolean)) log(line)
  const homeFile = homeRegistryOf(home)
  const repoFile = repoRegistryOf(workspace)
  if (!existsSync(homeFile) || !existsSync(repoFile)) {
    throw new Error(`first boot: the seed returned 0 but ${!existsSync(homeFile) ? homeFile : repoFile} is missing`)
  }
  return { state: 'seeded', script, homeFile, repoFile, stdout: String(stdout ?? '') }
}

const noSessionKeys = (value, path = '') => {
  if (Array.isArray(value)) return value.flatMap((item, index) => noSessionKeys(item, `${path}[${index}]`))
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, inner]) => (
    ['sessionId', 'sessions', 'segments'].includes(key) ? [`${path}.${key}`] : noSessionKeys(inner, `${path}.${key}`)
  ))
}

/** Sorted Bot ids; a verifier never drops or re-mints one. */
const sortedIds = (bots) => bots.map((bot) => bot?.id).filter((id) => typeof id === 'string').sort()
/** The identity fields both the v1 roster and the v2 repo file carry. */
const identityOf = (bot) => JSON.stringify({
  name: bot?.name,
  role: bot?.role ?? null,
  agent: bot?.agent ?? null,
  model: bot?.model ?? null,
})

/**
 * Verify the three surfaces the first boot leaves behind: the version 1 roster, the version 2
 * home file and the version 2 repo file. The v1 roster and the repo file must carry the same
 * full identity set; the home file carries this project's main Bot and index entry. No count is
 * fixed here, so a legitimate 3-, 6- or 9-Bot expansion is accepted; `expectedIds` is passed
 * only for the triad a fresh boot just minted. No Session key may survive.
 */
export function verifySurfaces({ home, workspace, expectedIds } = {}) {
  const rosterFile = rosterOf(workspace)
  const homeFile = homeRegistryOf(home)
  const repoFile = repoRegistryOf(workspace)
  const missing = [rosterFile, homeFile, repoFile].filter((file) => !existsSync(file))
  if (missing.length) throw new Error(`first boot: registry verifier failed: missing ${missing.join(', ')}`)
  const v1 = readJson(rosterFile)
  const homeRegistry = readJson(homeFile)
  const repoRegistry = readJson(repoFile)
  const v1Bots = Array.isArray(v1.bots) ? v1.bots : []
  const v1Mains = v1Bots.filter((bot) => bot?.kind === 'main')
  const homeBots = Array.isArray(homeRegistry.bots) ? homeRegistry.bots : []
  const repoBots = Array.isArray(repoRegistry.bots) ? repoRegistry.bots : []
  const repoMains = repoBots.filter((bot) => bot?.main === true)
  const v1Ids = sortedIds(v1Bots)
  const repoIds = sortedIds(repoBots)
  const problems = []
  if (v1.version !== 1 || v1Mains.length !== 1) problems.push(`v1 ${rosterFile}: ${v1Bots.length} bots, ${v1Mains.length} main`)
  if (homeRegistry.version !== 2) problems.push(`v2 home ${homeFile}: version ${JSON.stringify(homeRegistry.version)}`)
  if (!Array.isArray(homeRegistry.projects) || !homeRegistry.projects.some((entry) => entry?.folder === workspace)) problems.push(`v2 home ${homeFile}: no project ${workspace}`)
  if (repoRegistry.version !== 2 || repoMains.length !== 1) problems.push(`v2 repo ${repoFile}: ${repoBots.length} bots, ${repoMains.length} main`)
  if (expectedIds) {
    const wanted = [...expectedIds].map(String).sort()
    if (JSON.stringify(wanted) !== JSON.stringify(v1Ids)) problems.push(`fresh team ids [${wanted.join(' ')}] do not match the v1 roster [${v1Ids.join(' ')}]`)
  }
  if (JSON.stringify(v1Ids) !== JSON.stringify(repoIds)) {
    problems.push(`v1 ids [${v1Ids.join(' ')}] and v2 repo ids [${repoIds.join(' ')}] differ`)
  }
  const repoById = new Map(repoBots.map((bot) => [bot?.id, bot]))
  for (const bot of v1Bots) {
    const other = repoById.get(bot?.id)
    if (!other) { problems.push(`v1 Bot ${JSON.stringify(bot?.id)} is missing from the v2 repo file`); continue }
    if ((bot?.kind === 'main') !== (other?.main === true)) problems.push(`v1 Bot ${bot.id} main flag differs in the v2 repo file`)
    if (identityOf(bot) !== identityOf(other)) problems.push(`v1 Bot ${bot.id} identity differs in the v2 repo file`)
  }
  const homeProjectBots = homeBots.filter((bot) => bot?.folder === workspace)
  const homeMain = homeProjectBots.find((bot) => bot?.main === true)
  const homeProjectIds = sortedIds(homeProjectBots)
  if (!homeProjectBots.length) problems.push(`v2 home ${homeFile}: no Bot for ${workspace}`)
  if (!homeMain) problems.push(`v2 home ${homeFile}: no main Bot for ${workspace}`)
  const v1Main = v1Mains[0]
  if (homeMain && v1Main) {
    if (homeMain.id !== v1Main.id) problems.push(`v2 home ${homeFile}: main ${homeMain.id} is not the v1 main ${v1Main.id}`)
    else if (identityOf(homeMain) !== identityOf(v1Main)) problems.push(`v2 home ${homeFile}: main ${homeMain.id} identity differs from the v1 main`)
  }
  for (const id of homeProjectIds) {
    if (!v1Ids.includes(id)) problems.push(`v2 home ${homeFile}: Bot ${id} is not in the v1 roster`)
  }
  for (const [file, value] of [[rosterFile, v1], [homeFile, homeRegistry], [repoFile, repoRegistry]]) {
    for (const at of noSessionKeys(value)) problems.push(`${file}: ${at} is a Session key`)
  }
  if (problems.length) throw new Error(`first boot: registry verifier failed: ${problems.join('; ')}`)
  return {
    v1: { file: rosterFile, bots: v1Bots.length, mains: v1Mains.length, mainId: v1Main?.id, ids: v1Ids },
    home: { file: homeFile, bots: homeProjectBots.length, projects: homeRegistry.projects.length, mains: homeMain ? 1 : 0, mainId: homeMain?.id, ids: homeProjectIds },
    repo: { file: repoFile, bots: repoBots.length, mains: repoMains.length, mainId: repoMains[0]?.id, ids: repoIds },
    bots: v1Bots.map((bot) => ({ id: bot.id, name: bot.name, kind: bot.kind, role: bot.role })),
  }
}

/**
 * The first-start hook never kills the server over the team: a team/seed/verification failure
 * is logged and returned, DSH starts, and the work is retried on a later boot and after the
 * vendor CLI install. The detailed flow lives in boot().
 */
export function runFirstBoot(options = {}) {
  try {
    return boot(options)
  } catch (error) {
    const home = options.home
    const marker = home ? join(home, FIRST_BOOT_MARKER) : null
    const message = String(error?.message ?? error)
    const warn = options.warn ?? console.warn
    if (home) {
      try {
        const prior = readModelPinState(home)
        writeModelPinState(home, 'failed', { pins: prior.pins ?? [], superseded: prior.superseded ?? [], conflicts: prior.conflicts ?? [], error: message })
        const marker = join(home, FIRST_BOOT_MARKER)
        if (existsSync(marker)) {
          const record = JSON.parse(readFileSync(marker, 'utf8'))
          record.pins = 'failed'
          writeFileSync(marker, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
        }
      } catch { /* the health report will say unknown */ }
    }
    warn(`first boot: ${message}; the server starts and the team/seed retry on a later boot`)
    return {
      fresh: marker ? !existsSync(marker) : true,
      marker,
      team: { state: 'failed', error: message },
      registry: { state: 'failed', error: message },
      pins: home ? readModelPinState(home) : { state: 'unknown', pins: [] },
      error: message,
    }
  }
}

/**
 * am's supported CLI-only host install. It creates the am part store and the stable
 * <HERDR_APP_HOME>/automagik-herdr/briefing.mjs link; no pack is copied into mods/. A failure is
 * logged and the server stays up; a later boot retries when the link is still missing.
 */
function installAmSelf({ home, appHome, env, am, run, log, warn }) {
  const link = join(appHome, 'automagik-herdr', 'briefing.mjs')
  if (existsSync(link)) return { state: 'present', link }
  const exec = run ?? process.getBuiltinModule('node:child_process').execFileSync
  const childEnv = {
    ...env,
    HOME: env.HOME || home,
    AUTOMAGIK_HOME: home,
    HERDR_APP_HOME: appHome,
  }
  try {
    const output = exec(am, ['self', 'install'], {
      cwd: home, env: childEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
    })
    const line = String(output ?? '').trim().split('\n').filter(Boolean).at(-1)
    log(`am self install: ${line || 'installed'}${existsSync(link) ? `; briefing link ${link}` : '; briefing link not created'}`)
    return { state: existsSync(link) ? 'installed' : 'missing-link', link }
  } catch (error) {
    warn(`am self install failed: ${error?.stderr?.trim() || error?.message || error}`)
    return { state: 'failed', link, error: String(error?.message ?? error) }
  }
}

function currentModelsPresent({ home, workspace }) {
  try {
    const v1 = readJson(rosterOf(workspace))
    const repo = existsSync(repoRegistryOf(workspace)) ? readJson(repoRegistryOf(workspace)) : null
    const homeRegistry = existsSync(homeRegistryOf(home)) ? readJson(homeRegistryOf(home)) : null
    const v1Bots = Array.isArray(v1?.bots) ? v1.bots : []
    const repoBots = Array.isArray(repo?.bots) ? repo.bots : []
    const homeMain = (Array.isArray(homeRegistry?.bots) ? homeRegistry.bots : []).filter((bot) => bot?.folder === workspace && bot?.main === true)
    return v1Bots.length > 0 && v1Bots.every((bot) => bot?.model) && repoBots.every((bot) => bot?.model) && homeMain.length === 1 && Boolean(homeMain[0].model)
  } catch {
    return false
  }
}

function boot({
  home,
  workspace,
  profile,
  version = 'unknown',
  source = SKILL_ROOT,
  vendorRoot = REGISTRY_SEED_VENDOR,
  env = process.env,
  am = env.AUTOMAGIK_AM || 'am',
  log = console.log,
  warn = console.warn,
  now = () => new Date().toISOString(),
  fs = { existsSync, readFileSync, writeFileSync },
  run,
} = {}) {
  const marker = join(home, FIRST_BOOT_MARKER)
  const fresh = !fs.existsSync(marker)
  let skill
  if (fresh) {
    try {
      skill = installSkill({ home, source, log, warn })
    } catch (error) {
      warn(`skill ${SKILL_NAME}: not installed: ${error?.message ?? error}`)
      skill = { state: 'failed', error: String(error?.message ?? error) }
    }
  }
  const homeFile = homeRegistryOf(home)
  const appHome = env.HERDR_APP_HOME || join(home, 'herdr-app')
  const amSelf = installAmSelf({ home, appHome, env, am, run, log, warn })
  let team
  let registry
  let surfaces
  if (!fs.existsSync(homeFile)) {
    team = ensureTeam({ home, workspace, env, am, run, log, warn })
    if (team.state === 'created') {
      // A fresh team has a known pending state even when am already pinned it: the empty pins
      // list means no deferral, and verification below will turn it ready. Never leave it absent.
      writeModelPinState(home, 'pending', { pins: team.pendingPins ?? [] })
    }
    registry = seedRegistry({ home, workspace, profile, env, run, vendorRoot, log, warn })
    log(`first boot: registry ${registry.state} from ${registry.script.source}${registry.script.commit ? ` @ ${registry.script.commit}` : ''}`)
  } else {
    team = { state: 'present' }
    registry = { state: 'present', homeFile }
    log(`first boot: registry present at ${homeFile}`)
  }
  // A pending pin is a known state: apply it before verification, so a person's model change
  // can be reported and the v2 copies synced, then verify the result. The file is cleared only
  // after verifySurfaces passes.
  const priorState = readModelPinState(home).state
  const pins = applyPendingPins({ home, workspace, env, am, run, log, warn })
  if (pins.conflicts.length) {
    writeModelPinState(home, 'failed', {
      pins: readPendingPins(home) ?? [], superseded: pins.superseded, conflicts: pins.conflicts,
      error: 'model pin conflicts: a roster surface was edited and was not overwritten',
    })
    warn(`first boot: model pin conflicts on ${pins.conflicts.map((entry) => entry.surface).join(', ')}; person edits were kept`)
  }
  surfaces = verifySurfaces({
    home, workspace,
    ...(team.state === 'created' ? { expectedIds: team.bots.map((bot) => bot.id) } : {}),
  })
  if (!pins.conflicts.length) {
    const models = currentModelsPresent({ home, workspace })
    if (models) {
      writeModelPinState(home, 'ready', { pins: [], superseded: pins.superseded, receipt: modelPinReceipt({ home, workspace, now }) })
    } else if (priorState === 'failed' || priorState === 'conflict') {
      const prior = readModelPinState(home)
      writeModelPinState(home, 'failed', { pins: prior.pins ?? [], superseded: prior.superseded ?? [], conflicts: prior.conflicts ?? [], error: prior.error ?? 'model pin resolution is not verified' })
    } else if (priorState === 'ready') {
      writeModelPinState(home, 'failed', { pins: [], error: 'ready state has no verified model evidence' })
    } else if (pins.pending.length) {
      writeModelPinState(home, 'pending', { pins: pins.pending, superseded: pins.superseded })
    } else if (priorState === 'unknown' || pins.state === 'unknown') {
      writeModelPinState(home, 'unknown', { pins: [] })
    } else {
      writeModelPinState(home, 'unknown', { pins: [] })
    }
  }
  log(`first boot: v1 ${surfaces.v1.file} (${surfaces.v1.bots} bots, ${surfaces.v1.mains} main); v2 home ${surfaces.home.file} (${surfaces.home.bots} bots, ${surfaces.home.projects} project); v2 repo ${surfaces.repo.file} (${surfaces.repo.bots} bots, ${surfaces.repo.mains} main)`)
  log(`first boot: coherent ids: v1 [${surfaces.v1.ids.join(' ')}] main ${surfaces.v1.mainId}; v2 home [${surfaces.home.ids.join(' ')}] main ${surfaces.home.mainId}; v2 repo [${surfaces.repo.ids.join(' ')}] main ${surfaces.repo.mainId}`)
  log(`first boot: model pins ${pins.state}${pins.pending.length ? ` (${pins.pending.length} pending: ${pins.pending.map((pin) => `${pin.name ?? pin.id} ${pin.model}`).join(', ')})` : ''}${pins.superseded.length ? ` (${pins.superseded.length} superseded)` : ''}`)
  if (fresh) {
    const record = {
      schemaVersion: 1,
      version,
      at: now(),
      skill: skill?.state ?? 'skipped',
      team: team.state === 'created' ? { state: team.state, bots: team.bots, mainId: team.mainId } : { state: team.state },
      registry: registry.state,
      pins: readModelPinState(home).state,
      amSelf: amSelf.state,
      ...(pins.pending.length ? { pendingPins: pins.pending } : {}),
      ...(pins.superseded.length ? { supersededPins: pins.superseded } : {}),
      ...(registry.script ? { seed: registry.script.path, seedSource: registry.script.source, ...(registry.script.commit ? { seedCommit: registry.script.commit } : {}) } : {}),
      ...(surfaces ? { v1: surfaces.v1, home: surfaces.home, repo: surfaces.repo } : {}),
    }
    try {
      fs.writeFileSync(marker, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    } catch (error) {
      warn(`first boot: ${marker} was not written: ${error?.message ?? error}`)
    }
    log(`first boot: skill ${record.skill}, team ${record.team.state}, registry ${record.registry}`)
  } else if (fs.existsSync(marker)) {
    try {
      const state = readModelPinState(home).state
      const record = JSON.parse(fs.readFileSync(marker, 'utf8'))
      if (record.pins !== state) {
        record.pins = state
        delete record.pendingPins
        if (pins.superseded.length) record.supersededPins = pins.superseded
        else delete record.supersededPins
        if (state === 'ready') record.pinsResolvedAt = now()
        fs.writeFileSync(marker, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
      }
    } catch (error) {
      warn(`first boot: ${marker} pin state was not updated: ${error?.message ?? error}`)
    }
  }
  return { fresh, marker, ...(skill ? { skill } : {}), amSelf, team, registry, pins, ...(surfaces ? { surfaces } : {}) }
}

/**
 * The supported launch bridge: a `programs.json` run override in the app home. am reads it
 * through withOverrides (am/models.js), so a store-installed absolute binary is what a Bot
 * starts. Only an entry whose run points into this instance's CLI store is managed here; a
 * person's own override is never deleted or rewritten. The file stays under the data volume.
 */
export function writeProgramsBridge({
  home,
  appHome = join(home, 'herdr-app'),
  agent,
  path,
  log = console.log,
  warn = console.warn,
} = {}) {
  const storeRoot = `${resolve(join(home, 'acp', 'clis'))}${sep}`
  const target = resolve(path ?? '')
  if (!target.startsWith(storeRoot) || !isAbsolute(target)) {
    throw new Error(`programs.json bridge path is not in this instance's CLI store: ${path}`)
  }
  const file = join(appHome, 'programs.json')
  let current = {}
  if (existsSync(file)) {
    try {
      current = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      warn(`programs.json: ${file} is not JSON (${error?.message ?? error}); left as it is`)
      return { file, changed: false, reason: 'invalid' }
    }
  }
  if (current === null || typeof current !== 'object' || Array.isArray(current)) {
    warn(`programs.json: ${file} is not an object; left as it is`)
    return { file, changed: false, reason: 'invalid' }
  }
  const programs = current.programs === undefined ? {} : current.programs
  if (programs === null || typeof programs !== 'object' || Array.isArray(programs)) {
    warn(`programs.json: ${file}: programs is not an object; left as it is`)
    return { file, changed: false, reason: 'invalid' }
  }
  const existing = programs[agent]
  if (existing !== undefined) {
    if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
      warn(`programs.json: ${file}: ${agent} is not an object; left as it is`)
      return { file, changed: false, reason: 'personal' }
    }
    const run = existing.run
    const managed = Array.isArray(run) && run.length === 1 && typeof run[0] === 'string'
      && isAbsolute(run[0]) && `${resolve(run[0])}${sep}`.startsWith(storeRoot)
    if (!managed) {
      warn(`programs.json: ${file}: ${agent} is a person's own override; left as it is`)
      return { file, changed: false, reason: 'personal' }
    }
  }
  const next = {
    ...current,
    programs: { ...programs, [agent]: { ...(existing ?? {}), run: [target] } },
  }
  if (JSON.stringify(next) === JSON.stringify(current)) return { file, changed: false, reason: 'current' }
  mkdirSync(appHome, { recursive: true })
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o644
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode })
  renameSync(tmp, file)
  log(`programs.json: ${agent} -> ${target}`)
  return { file, changed: true, reason: 'written' }
}

/** Whether a run entry is this instance's managed CLI store path. */
export const managedProgram = (run, home) => Array.isArray(run) && run.length === 1 && typeof run[0] === 'string'
  && isAbsolute(run[0]) && `${resolve(run[0])}${sep}`.startsWith(`${resolve(join(home, 'acp', 'clis'))}${sep}`)

/**
 * Install Claude Code and Codex through the shipped CLI store, into the data volume. This runs
 * after DSH starts so a slow first download never holds the auth fence closed; a failure is
 * logged and the ACP plugin's own store retries on its normal schedule. Never called at build
 * time, and never with a CLI tarball baked into the image.
 */
/**
 * One bounded asynchronous child. The entrypoint's event loop stays free for core/dsh exits,
 * signals and pipe draining while the install runs. Output is capped; timeout kills the child;
 * the caller receives the status, signal and timing for the receipt.
 */
export function runVendorChild(command, args, { env = process.env, cwd, timeout = 840_000, maxOutput = 16 * 1024 * 1024 } = {}) {
  const spawn = process.getBuiltinModule('node:child_process').spawn
  const token = env.AUTOMAGIK_VENDOR_INSTALL_TOKEN ?? null
  return new Promise((resolve) => {
    const started = Date.now()
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let outputOver = false
    let timer
    let grace
    let stopped = false
    const reap = async () => {
      if (!token) return { reaped: [], remaining: [] }
      const killed = new Set()
      // The token is inherited by pnpm and any detached descendant; only those processes carry
      // it, so this is an ownership-proven subtree walk, not a process-name sweep.
      let remaining = []
      for (let attempt = 0; attempt < 20; attempt += 1) {
        remaining = []
        for (const name of readdirSync('/proc')) {
          if (!/^\d+$/.test(name)) continue
          try {
            const environ = readFileSync(`/proc/${name}/environ`, 'utf8')
            if (!environ.split('\0').includes(`AUTOMAGIK_VENDOR_INSTALL_TOKEN=${token}`)) continue
            remaining.push(Number(name))
            try { process.kill(Number(name), 'SIGKILL'); killed.add(Number(name)) } catch {}
          } catch { /* not ours, gone, or not readable */ }
        }
        if (!remaining.length) return { reaped: [...killed], remaining: [] }
        await new Promise((done) => setTimeout(done, 100))
      }
      return { reaped: [...killed], remaining }
    }
    const finish = async (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(grace)
      const reaped = await reap()
      resolve({ ...result, stdout, stderr, timedOut, outputOver, reaped: reaped.reaped, remaining: reaped.remaining, durationMs: Date.now() - started })
    }
    const stop = () => {
      if (stopped) return
      stopped = true
      child.kill('SIGTERM')
      grace = setTimeout(() => child.kill('SIGKILL'), 5000)
    }
    const child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const take = (chunk, stream) => {
      const text = chunk.toString('utf8')
      if (stream === 'out') stdout += text
      else stderr += text
      if (!outputOver && stdout.length + stderr.length > maxOutput) {
        outputOver = true
        stop()
      }
    }
    child.stdout.on('data', (chunk) => take(chunk, 'out'))
    child.stderr.on('data', (chunk) => take(chunk, 'err'))
    child.on('error', (error) => { void finish({ status: null, signal: null, error }) })
    child.on('close', (status, signal) => { void finish({ status, signal, error: null }) })
    timer = setTimeout(() => {
      timedOut = true
      stop()
    }, timeout)
  })
}


/**
 * DSH's own CliStore is the product installer: its startup `required()`/`refresh()` installs
 * both vendors. The entrypoint must not duplicate that install. It observes the shared store,
 * waits for the binaries, and writes the programs.json bridge. One owner, one admission queue.
 */
export async function installVendorClis({
  home,
  profile,
  env = process.env,
  log = console.log,
  warn = console.warn,
  timeout = 1_900_000,
  failure = () => undefined,
} = {}) {
  const clisFile = join(profile, CLI_STORE_RELATIVE)
  const agentsFile = join(profile, AGENTS_RELATIVE)
  if (!existsSync(clisFile) || !existsSync(agentsFile)) {
    warn(`vendor CLIs: the shipped CLI store is not in ${profile}; left for the ACP plugin`)
    return { state: 'unavailable', results: {} }
  }
  const { CliStore } = await import(pathToFileURL(clisFile).href)
  const { AGENTS } = await import(pathToFileURL(agentsFile).href)
  const store = new CliStore({
    env: { ...env, AUTOMAGIK_HOME: home, AUTOMAGIK_PNPM: env.AUTOMAGIK_PNPM || PNPM_PATH },
    log: (message) => log(`vendor CLIs: ${message}`),
  })
  const stateFile = join(home, 'vendor-clis-state.json')
  const results = {}
  const writeState = () => {
    writeFileSync(stateFile, `${JSON.stringify({ version: 1, at: new Date().toISOString(), results }, null, 2)}\n`, { mode: 0o600 })
    chmodSync(stateFile, 0o600)
  }
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
  try {
    for (const [id, spec] of Object.entries(AGENTS)) {
      if (!spec.cliPackage) continue
      const startedAt = new Date().toISOString()
      log(`vendor CLIs: observing the DSH-owned install of ${spec.defaultName} (${startedAt})`)
      let found
      const started = Date.now()
      let reported
      while (!found && Date.now() - started < timeout) {
        reported = failure()
        if (reported) break
        found = store.binOf(spec.cliPackage, spec)
        if (!found) await sleep(2000)
      }
      const endedAt = new Date().toISOString()
      if (reported) {
        results[id] = { state: 'failed', startedAt, endedAt, error: String(reported) }
        warn(`vendor CLIs: ${spec.defaultName} failed: ${reported}`)
        writeState()
        continue
      }
      if (found) {
        results[id] = { state: 'ready', version: found.version, path: found.path, managed: Boolean(found.managed), startedAt, endedAt }
        log(`vendor CLIs: observed ${spec.defaultName} ${found.version} at ${found.path}`)
        if (found.managed) {
          const bridge = writeProgramsBridge({
            home, appHome: env.HERDR_APP_HOME || join(home, 'herdr-app'),
            agent: spec.key, path: found.path, log, warn,
          })
          results[id].bridge = bridge.reason
        }
      } else {
        let error = 'the DSH-owned CLI store did not install it within the observation window; see pnpm-admission.log'
        try {
          const refusal = JSON.parse(readFileSync('/data/run/pnpm-admission-refusal', 'utf8'))
          if (typeof refusal.message === 'string' && refusal.message.length > 0) error = refusal.message
        } catch { /* no refusal record */ }
        results[id] = { state: 'failed', startedAt, endedAt, error }
        warn(`vendor CLIs: ${spec.defaultName} failed: ${error}`)
      }
      writeState()
    }
  } finally {
    store.dispose?.()
  }
  const states = Object.values(results).map((entry) => entry.state)
  return { state: states.length > 0 && states.every((state) => state === 'ready') ? 'ready' : 'failed', results, stateFile }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const home = process.env.AUTOMAGIK_HOME || '/data'
  const dshHome = process.env.DSH_HOME || '/data/dsh'
  const workspace = process.env.AUTOMAGIK_WORKSPACE || '/data/workspace'
  try {
    const result = runFirstBoot({ home, workspace, profile: join(dshHome, 'profiles', 'automagik-web'), version: process.env.AUTOMAGIK_VERSION })
    if (result.team?.state === 'failed') process.exitCode = 1
  } catch (error) {
    console.error(`first boot: ${error?.message ?? error}`)
    process.exitCode = 1
  }
}
