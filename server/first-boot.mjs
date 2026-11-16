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
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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

/**
 * Create the fresh triad through `am create` when the workspace has no Herdr roster. The ids
 * come from am (newBotId), not from a template or another team's file. A partial failure removes
 * the roster it just made, so the next boot starts cleanly.
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
  const made = []
  try {
    let lead
    for (const role of TRIAD) {
      const args = ['create', '--project', workspace, '--name', role.name, '--agent', 'codex',
        '--model', role.model, '--kind', role.kind, '--role', role.role, '--instructions', role.instructions]
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
    return { state: 'created', roster, bots: made, mainId: lead }
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
 * The first-start hook: install the skill once (marker), create the fresh triad when the team
 * home has no registry, run the real seed, and verify all three files. A seed or verification
 * failure propagates: the entrypoint exits nonzero rather than starting a half-seeded team.
 */
export function runFirstBoot({
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
  let team
  let registry
  let surfaces
  if (!fs.existsSync(homeFile)) {
    team = ensureTeam({ home, workspace, env, am, run, log, warn })
    registry = seedRegistry({ home, workspace, profile, env, run, vendorRoot, log, warn })
    surfaces = verifySurfaces({
      home, workspace,
      ...(team.state === 'created' ? { expectedIds: team.bots.map((bot) => bot.id) } : {}),
    })
    log(`first boot: registry ${registry.state} from ${registry.script.source}${registry.script.commit ? ` @ ${registry.script.commit}` : ''}`)
  } else {
    team = { state: 'present' }
    registry = { state: 'present', homeFile }
    surfaces = verifySurfaces({ home, workspace })
    log(`first boot: registry present at ${homeFile}; verified`)
  }
  log(`first boot: v1 ${surfaces.v1.file} (${surfaces.v1.bots} bots, ${surfaces.v1.mains} main); v2 home ${surfaces.home.file} (${surfaces.home.bots} bots, ${surfaces.home.projects} project); v2 repo ${surfaces.repo.file} (${surfaces.repo.bots} bots, ${surfaces.repo.mains} main)`)
  log(`first boot: coherent ids: v1 [${surfaces.v1.ids.join(' ')}] main ${surfaces.v1.mainId}; v2 home [${surfaces.home.ids.join(' ')}] main ${surfaces.home.mainId}; v2 repo [${surfaces.repo.ids.join(' ')}] main ${surfaces.repo.mainId}`)
  if (fresh) {
    const record = {
      schemaVersion: 1,
      version,
      at: now(),
      skill: skill?.state ?? 'skipped',
      team: team.state === 'created' ? { state: team.state, bots: team.bots, mainId: team.mainId } : { state: team.state },
      registry: registry.state,
      ...(registry.script ? { seed: registry.script.path, seedSource: registry.script.source, ...(registry.script.commit ? { seedCommit: registry.script.commit } : {}) } : {}),
      ...(surfaces ? { v1: surfaces.v1, home: surfaces.home, repo: surfaces.repo } : {}),
    }
    try {
      fs.writeFileSync(marker, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    } catch (error) {
      warn(`first boot: ${marker} was not written: ${error?.message ?? error}`)
    }
    log(`first boot: skill ${record.skill}, team ${record.team.state}, registry ${record.registry}`)
  }
  return { fresh, marker, ...(skill ? { skill } : {}), team, registry, ...(surfaces ? { surfaces } : {}) }
}

/**
 * Install Claude Code and Codex through the shipped CLI store, into the data volume. This runs
 * after DSH starts so a slow first download never holds the auth fence closed; a failure is
 * logged and the ACP plugin's own store retries on its normal schedule. Never called at build
 * time, and never with a CLI tarball baked into the image.
 */
export async function installVendorClis({
  home,
  profile,
  env = process.env,
  log = console.log,
  warn = console.warn,
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
  const results = {}
  try {
    for (const [id, spec] of Object.entries(AGENTS)) {
      if (!spec.cliPackage) continue
      try {
        const found = await store.ensure(spec, undefined)
        if (!found) { results[id] = { state: 'missing' }; continue }
        results[id] = { state: 'ready', version: found.version, path: found.path }
        log(`vendor CLIs: ${spec.defaultName} ${found.version} at ${found.path}`)
      } catch (error) {
        results[id] = { state: 'failed', error: String(error?.message ?? error) }
        warn(`vendor CLIs: ${spec.defaultName} was not installed: ${error?.message ?? error}`)
      }
    }
  } finally {
    store.dispose?.()
  }
  const states = Object.values(results).map((entry) => entry.state)
  return { state: states.length > 0 && states.every((state) => state === 'ready') ? 'ready' : 'failed', results }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const home = process.env.AUTOMAGIK_HOME || '/data'
  const dshHome = process.env.DSH_HOME || '/data/dsh'
  const workspace = process.env.AUTOMAGIK_WORKSPACE || '/data/workspace'
  try {
    runFirstBoot({ home, workspace, profile: join(dshHome, 'profiles', 'automagik-web'), version: process.env.AUTOMAGIK_VERSION })
  } catch (error) {
    console.error(`first boot: ${error?.message ?? error}`)
    process.exitCode = 1
  }
}
