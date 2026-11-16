// Seed the shared Bot registry (RFC 0014) for one project from the version 1 roster Herdr
// already keeps. Two version 2 files, and nothing else:
//
//   <project>/.automagik/bots/bots.json          the project's Bots (repo file)
//   <AUTOMAGIK_HOME>/bots/bots.json              projects[] and the project's main Bot (home file)
//
// The Code side reads the home file's projects and each project's repo file; the bar's seats
// read the home file's Bots. So the repo file gets the whole roster, and the home file gets the
// project entry plus its one main Bot (the project's seat).
//
// The seed creates what is missing and leaves an identical file alone. It never updates a file
// that differs and never overwrites one: an existing file that disagrees with the roster is
// refused. Bot ids are never minted here. A project with no `.herdr/bots.json` is refused,
// because a team and its ids are made by Herdr when the project's team is created; this seed
// only reflects a roster that already exists.
//
// Nothing Session-shaped is stored: `sessionId`, `sessions` and `segments` are removed at every
// depth, including under `dsh`, before either file is written. The version 2 module's own
// parser, checker and write-if-unchanged (its lock beside the file) do the rest, so DSH and the
// CLI can edit the same files without losing each other's work.
//
// The command is `scripts/seed-registry.mjs`; this module holds the conversion, the merge and
// the report so tests and the image's entrypoint can use the same code without a process.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  HOME_PATH, REPO_PATH, checkRegistry, emptyRegistry, fromHerdrV1, parseRegistry,
  readRegistryText, writeRegistry,
} from '../shared/registry.js'

const ROSTER = '.herdr/bots.json'
const SESSION_KEYS = Object.freeze(['sessionId', 'sessions', 'segments'])
const ATTEMPTS = 3

export const USAGE = `Seed the shared version 2 Bot registry (RFC 0014) from a project's Herdr roster.

Usage: node seed-registry.mjs [--project <folder>] [--home <folder>]

  --project <folder>  the checkout that holds .herdr/bots.json (default: the current folder)
  --home <folder>     the Automagik home that holds bots/bots.json (default: $AUTOMAGIK_HOME,
                      else ~/.automagik). This is the registry home, not AUTOMAGIK_BOTS_HOME.
  -h, --help          this text

It writes, from <project>/.herdr/bots.json version 1:
  <project>/.automagik/bots/bots.json   the project's Bots (repo file)
  <home>/bots/bots.json                 projects[] and the project's main Bot (home file)

A missing file is created; an identical one is left alone; a different one is refused, never
overwritten. No Bot id is minted: a project with no version 1 roster is refused. No Session id,
Session list or segment is written. The report ends with a read-back of both files: Bot counts,
parser warnings and each file's sha256.`

/** A refusal the operator can act on: no roster, no usable main, or a conflicting file. */
export class SeedError extends Error {
  constructor(message, code = 'seed/refused') {
    super(message)
    this.name = 'SeedError'
    this.code = code
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const clone = value => JSON.parse(JSON.stringify(value))
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`
// Object key order is not data: two files that differ only in order are the same file.
const same = (a, b) => {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => same(item, b[index]))
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && same(a[key], b[key]))
  }
  return false
}
const sha256Of = bytes => createHash('sha256').update(bytes).digest('hex')

const expandHome = text => (text === '~' ? homedir() : /^~[\\/]/.test(text) ? join(homedir(), text.slice(2)) : text)
/** A folder as the rest of the plugin resolves one: absolute, with a leading `~` expanded. */
export const folderOf = value => resolve(expandHome(String(value)))
/** The Automagik home the registry lives under: `$AUTOMAGIK_HOME`, else `~/.automagik`. */
export const defaultHome = (env = process.env) => folderOf(env.AUTOMAGIK_HOME?.trim() ? env.AUTOMAGIK_HOME.trim() : join(homedir(), '.automagik'))

/**
 * Removes `sessionId`, `sessions` and `segments` from `value` at every depth, recording each
 * removed key's path in `removed`. Returns `value`. Mutates the object it is given.
 */
export function scrubSessions(value, path = '', removed = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scrubSessions(item, `${path}[${index}]`, removed))
    return value
  }
  if (!isObject(value)) return value
  for (const key of Object.keys(value)) {
    const at = path === '' ? key : `${path}.${key}`
    if (SESSION_KEYS.includes(key)) {
      delete value[key]
      removed.push(at)
    } else scrubSessions(value[key], at, removed)
  }
  return value
}

/**
 * The version 2 files one version 1 roster becomes, before anything is read from disk:
 * `{ repo, homeBot, sourceBots, warnings }`. Throws SeedError when the roster has no single
 * usable main Bot or does not convert to a valid repo file.
 */
export function deriveSeed(sourceText, { sourcePath = ROSTER, project } = {}) {
  let source
  try {
    source = JSON.parse(sourceText)
  } catch (error) {
    throw new SeedError(`${sourcePath} is not JSON: ${error.message}`, 'seed/source')
  }
  if (!isObject(source)) throw new SeedError(`${sourcePath} is not an object`, 'seed/source')
  if (source.version !== 1) throw new SeedError(`${sourcePath} is version ${JSON.stringify(source.version)}, expected the version 1 roster`, 'seed/source')
  if (!Array.isArray(source.bots)) throw new SeedError(`${sourcePath} has no bots list`, 'seed/source')
  const sourceMains = source.bots.filter(bot => isObject(bot) && bot.kind === 'main')
  if (sourceMains.length !== 1) {
    throw new SeedError(`${sourcePath} has ${plural(sourceMains.length, 'main Bot')}; a project has exactly one. Fix the roster and run the seed again.`, 'seed/main')
  }
  let converted
  try {
    converted = fromHerdrV1(sourceText)
  } catch (error) {
    throw new SeedError(`${sourcePath} could not be converted: ${error.message}`, 'seed/source')
  }
  const warnings = [...converted.warnings]
  const scrubbed = []
  const repo = scrubSessions(converted.file, '', scrubbed)
  for (const path of scrubbed) warnings.push(`${path} is never kept in bots.json; removed`)
  const mains = repo.bots.filter(bot => bot.main === true)
  if (mains.length !== 1) {
    throw new SeedError(`${sourcePath} does not convert to one main Bot (${plural(mains.length, 'main Bot')} left); the main Bot needs a valid b- id and a name`, 'seed/main')
  }
  if (mains[0].id !== sourceMains[0].id) {
    throw new SeedError(`${sourcePath}: the roster's main Bot ${JSON.stringify(sourceMains[0].id)} cannot be used in version 2; fix its id and name`, 'seed/main')
  }
  const errors = checkRegistry(repo, { kind: 'repo' })
  if (errors.length) throw new SeedError(`${sourcePath} does not convert to a valid version 2 repo file: ${errors.join('; ')}`, 'seed/source')
  const homeBot = { ...mains[0], folder: project }
  return { repo, homeBot, sourceBots: source.bots.length, warnings }
}

/** The file's text, or null when it is not there (no other read failure is swallowed). */
const textOf = async (path) => readRegistryText(path)

/**
 * What the repo file should be: created, unchanged, or a refusal. Never returns a plan that
 * writes over a file whose parsed content differs from the roster.
 */
export function planRepo(path, repo, text) {
  if (text === null) return { text, raw: repo, action: 'created' }
  let parsed
  try {
    parsed = parseRegistry(text, { kind: 'repo' })
  } catch (error) {
    throw new SeedError(`Not seeded: ${path} exists but is not a version 2 repo file (${error.message}). Move it away to seed this project.`, 'seed/conflict')
  }
  const scrubbed = clone(parsed.raw)
  const removed = []
  scrubSessions(scrubbed, '', removed)
  if (removed.length) {
    throw new SeedError(`Not seeded: ${path} holds ${plural(removed.length, 'Session key')} (${removed.join(', ')}); a version 2 file never keeps them. Nothing was written and nothing was overwritten; fix the file and run the seed again.`, 'seed/conflict')
  }
  if (same(scrubbed, repo)) return { text, raw: repo, action: 'unchanged' }
  const existing = Array.isArray(parsed.raw.bots) ? parsed.raw.bots.length : 0
  throw new SeedError(`Not seeded: ${path} already holds a different project roster (${plural(existing, 'Bot')}, roster has ${plural(repo.bots.length, 'Bot')}). Nothing was written and nothing was overwritten; move the file away to seed again.`, 'seed/conflict')
}

/**
 * What the home file should be: created, unchanged or updated by adding this project's entry
 * and main Bot. Everything else in an existing home file is kept, including other projects,
 * `shown[]` and unknown fields. A conflicting entry, a second main for the same project or an
 * invalid file is refused.
 */
export function planHome(path, project, homeBot, text) {
  if (text === null) {
    const raw = emptyRegistry('home')
    raw.projects.push({ folder: project })
    raw.bots.push(clone(homeBot))
    const errors = checkRegistry(raw, { kind: 'home' })
    if (errors.length) throw new SeedError(`Not seeded: ${path}: the project's main Bot is not valid in a home file: ${errors.join('; ')}`, 'seed/source')
    return { text, raw, action: 'created', warnings: [] }
  }
  let parsed
  try {
    parsed = parseRegistry(text, { kind: 'home' })
  } catch (error) {
    throw new SeedError(`Not seeded: ${path} exists but is not a version 2 home file (${error.message}). Move it away to seed this project.`, 'seed/conflict')
  }
  const raw = clone(parsed.raw)
  if (raw.projects !== undefined && !Array.isArray(raw.projects)) throw new SeedError(`Not seeded: ${path}: projects is not a list`, 'seed/conflict')
  const warnings = []
  const scrubbed = []
  scrubSessions(raw, '', scrubbed)
  for (const at of scrubbed) warnings.push(`${path}: ${at} is never kept in bots.json; removed`)
  const projects = raw.projects ?? (raw.projects = [])
  const entries = projects.map((entry, index) => ({ entry, index })).filter(({ entry }) => isObject(entry) && entry.folder === project)
  if (entries.length > 1) throw new SeedError(`Not seeded: ${path} lists the project more than once; fix the file and run the seed again`, 'seed/conflict')
  if (entries.length === 1) {
    if (entries[0].entry.machine !== undefined) {
      throw new SeedError(`Not seeded: ${path} lists this project on machine ${JSON.stringify(entries[0].entry.machine)}; seed it on that machine, or remove that entry first`, 'seed/conflict')
    }
  } else projects.push({ folder: project })
  const existingMain = raw.bots.find(bot => isObject(bot) && bot.folder === project && bot.main === true && bot.id !== homeBot.id)
  if (existingMain) {
    throw new SeedError(`Not seeded: ${path} already names ${existingMain.id} as this project's main Bot; the project has exactly one main. Fix the home file and run the seed again`, 'seed/conflict')
  }
  const matches = raw.bots.filter(bot => isObject(bot) && bot.id === homeBot.id)
  if (matches.length > 1) throw new SeedError(`Not seeded: ${path} lists ${homeBot.id} more than once`, 'seed/conflict')
  if (matches.length === 1) {
    if (!same(matches[0], homeBot)) {
      throw new SeedError(`Not seeded: ${path} already holds ${homeBot.id} with different fields from the roster. Nothing was written and nothing was overwritten; move the file away to seed again.`, 'seed/conflict')
    }
  } else raw.bots.push(clone(homeBot))
  const errors = checkRegistry(raw, { kind: 'home', before: text })
  if (errors.length) throw new SeedError(`Not seeded: ${path}: ${errors.join('; ')}. Fix the file and run the seed again.`, 'seed/conflict')
  return { text, raw, action: same(raw, parsed.raw) ? 'unchanged' : 'updated', warnings }
}

/** Reads the file just written back: counts, warnings and the sha256 of its exact bytes. */
export function readBack(path, kind) {
  const bytes = readFileSync(path)
  const parsed = parseRegistry(bytes.toString('utf8'), { kind })
  return {
    path,
    bots: parsed.file.bots.length,
    mains: parsed.file.bots.filter(bot => bot.main === true).length,
    projects: kind === 'home' ? parsed.file.projects.length : 0,
    warnings: parsed.warnings,
    sha256: sha256Of(bytes),
  }
}

/**
 * Seeds both files for `project` under `home`. Idempotent: an identical file is not rewritten.
 * Refuses a conflicting file before writing either one. Resolves with the read-back report.
 */
export async function seedRegistry({ project = process.cwd(), home = defaultHome(), wait, stale } = {}) {
  const projectFolder = resolve(project)
  const homeFolder = resolve(home)
  const sourcePath = join(projectFolder, ROSTER)
  let sourceText
  try {
    sourceText = readFileSync(sourcePath, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    throw new SeedError(`No version 1 roster at ${sourcePath}. The seed mints no Bot ids: create the project's team in Herdr first, then run it again.`, 'seed/no-roster')
  }
  const derived = deriveSeed(sourceText, { sourcePath, project: projectFolder })
  const homePath = join(homeFolder, HOME_PATH)
  const repoPath = join(projectFolder, REPO_PATH)
  for (let attempt = 1; ; attempt += 1) {
    try {
      const repoText = await textOf(repoPath)
      const homeText = await textOf(homePath)
      const repo = planRepo(repoPath, derived.repo, repoText)
      const homePlan = planHome(homePath, projectFolder, derived.homeBot, homeText)
      if (repo.action !== 'unchanged') await writeRegistry(repoPath, repo.raw, repo.text, { kind: 'repo', wait, stale })
      if (homePlan.action !== 'unchanged') await writeRegistry(homePath, homePlan.raw, homePlan.text, { kind: 'home', wait, stale })
      return {
        project: projectFolder,
        source: { path: sourcePath, bots: derived.sourceBots, mains: 1, warnings: derived.warnings },
        home: { ...readBack(homePath, 'home'), action: homePlan.action },
        repo: { ...readBack(repoPath, 'repo'), action: repo.action },
      }
    } catch (error) {
      if (error?.code === 'registry/stale' && attempt < ATTEMPTS) continue
      throw error
    }
  }
}

/** The operator report: where both files are, what happened, counts, warnings and hashes. */
export function formatSeedReport(result) {
  const { source, home, repo } = result
  const lines = [
    `seed-registry: project ${result.project}`,
    `seed-registry: source ${source.path} (${plural(source.bots, 'Bot')}, ${plural(source.mains, 'main Bot')}, ${plural(source.warnings.length, 'warning')})`,
    `seed-registry: home ${home.path} ${home.action} (${plural(home.bots, 'Bot')}, ${plural(home.projects, 'project')}, ${plural(home.warnings.length, 'warning')}, sha256 ${home.sha256})`,
    `seed-registry: repo ${repo.path} ${repo.action} (${plural(repo.bots, 'Bot')}, ${plural(repo.mains, 'main Bot')}, ${plural(repo.warnings.length, 'warning')}, sha256 ${repo.sha256})`,
  ]
  for (const warning of source.warnings) lines.push(`seed-registry: warning ${warning}`)
  for (const warning of home.warnings) lines.push(`seed-registry: warning ${warning}`)
  for (const warning of repo.warnings) lines.push(`seed-registry: warning ${warning}`)
  return `${lines.join('\n')}\n`
}

