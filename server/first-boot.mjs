#!/usr/bin/env node
// What the image does once, on the first start of a data volume: put the reviewed skills where
// the agents read them, and ask the shipped v2 registry seed to fill a team home that has none.
// The vendor CLIs are installed separately, in the background, by installVendorClis(): they are
// hundreds of MB and come from registry.npmjs.org, so they must never be baked into the image.
//
// Nothing here is baked into /data at build time. The in-image smoke calls the same functions in
// a temporary home (in-image-smoke.mjs).
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  AGENTS_RELATIVE,
  CLI_STORE_RELATIVE,
  PNPM_PATH,
  REGISTRY_SEED_RELATIVE,
  SKILL_NAME,
  SKILL_ROOT,
  SKILL_SHA256,
} from './toolchain.mjs'

export const FIRST_BOOT_MARKER = '.automagik-first-boot.json'
/** Where Claude Code and Codex look for their skills; each is a link to the shared folder. */
export const SKILL_LINKS = Object.freeze(['.claude', '.codex'])
/** The seed's exit code for "there is no version 1 roster to migrate". */
export const SEED_NO_SOURCE = 3

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

/**
 * Run the shipped v2 registry seed when the team home has no registry. The path and interface
 * come from #1424: `registry-seed.js --home <team home> --workspace <folder>`, writing
 * `<home>/bots/bots.json` and, when there is a version 1 roster, the workspace's repo file.
 * Exit 3 means there is no roster to migrate; that is not a failure. While #1424 is unmerged the
 * path is absent, and this reports the interface it assumed instead of writing a registry by
 * hand.
 */
export function seedRegistry({
  home,
  workspace,
  profile,
  log = console.log,
  warn = console.warn,
  run,
  env = process.env,
} = {}) {
  const file = join(home, 'bots', 'bots.json')
  if (existsSync(file)) return { state: 'present', file }
  const script = join(profile, REGISTRY_SEED_RELATIVE)
  if (!existsSync(script)) {
    warn(`registry seed pending: ${script} is not in this @automagik/bots-dsh release; #1424 adds it (assumed interface: --home <team home> --workspace <folder>)`)
    return { state: 'pending', file, script }
  }
  try {
    const exec = run ?? process.getBuiltinModule('node:child_process').execFileSync
    const output = exec(process.execPath, [script, '--home', home, '--workspace', workspace], {
      cwd: workspace,
      env: { ...env, AUTOMAGIK_HOME: home, AUTOMAGIK_BOTS_HOME: join(home, 'bots') },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    })
    if (output?.trim()) log(`registry seed: ${output.trim()}`)
  } catch (error) {
    if (error?.status === SEED_NO_SOURCE) return { state: 'no-source', file, script }
    warn(`registry seed failed: ${error?.stderr?.trim() || error?.message || error}`)
    return { state: 'failed', file, script }
  }
  if (!existsSync(file)) {
    warn(`registry seed at ${script} returned 0 but wrote no ${file}`)
    return { state: 'failed', file, script }
  }
  log(`registry seed: wrote ${file}`)
  return { state: 'seeded', file, script }
}

/**
 * The first-start hook: install the skill once (marker), then seed a home that has no registry.
 * The registry check runs on every start, so a home deleted by hand is filled again; the seed
 * never overwrites an existing file. Returns what it did for the startup log and tests.
 */
export function runFirstBoot({
  home,
  workspace,
  profile,
  version = 'unknown',
  source = SKILL_ROOT,
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
  const registry = seedRegistry({ home, workspace, profile, log, warn, run })
  if (fresh) {
    const record = {
      schemaVersion: 1,
      version,
      at: now(),
      skill: skill?.state ?? 'skipped',
      registry: registry.state,
      ...(registry.script ? { seed: registry.script } : {}),
    }
    try {
      fs.writeFileSync(marker, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    } catch (error) {
      warn(`first boot: ${marker} was not written: ${error?.message ?? error}`)
    }
    log(`first boot: skill ${record.skill}, registry ${record.registry}`)
  }
  return { fresh, marker, ...(skill ? { skill } : {}), registry }
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
  const result = runFirstBoot({ home, workspace, profile: join(dshHome, 'profiles', 'automagik-web'), version: process.env.AUTOMAGIK_VERSION })
  process.exitCode = result.skill?.state === 'failed' ? 1 : 0
}
