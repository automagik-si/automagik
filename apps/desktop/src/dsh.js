// The DeepSeek Harness the app runs, as plain Node: where its home is, how the profile the
// app ships lands there, and the server process itself. Electron's main process
// (main.js) uses this; tests use it without Electron.
//
// Automagik's home is $AUTOMAGIK_HOME, else ~/.automagik (automagikHome). It holds the
// preload `omni desktop` and `genie desktop` write (preload), the builds they download
// (app/<tag>/), and everything the app keeps, under desktop/ (appHome):
//   dsh/   DSH_HOME: dsh's own Sessions, settings and the `omni` profile
//   bots/  the Bot team's home (AUTOMAGIK_BOTS_HOME), with the Omni link (bots/omni.json)
//   bin/   `node` and `pnpm` for dsh, both on Electron's own Node (writeTools)
// It is apart from a dsh you already run (~/.dsh) and from the Bot team installed into that
// one (~/.automagik/bots), so neither sees the other's Bots or Sessions. Omni's own folder
// (~/.omni: its sandbox, the Bun its channels download) is Omni's.
import { execFile, spawn as nodeSpawn } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { cp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { delimiter, join, resolve, win32 } from 'node:path'
import { DEFAULTS as PRIVACY_DEFAULTS, privacyEnv } from './privacy.js'
import { CLOSE_INHERITED } from './child-paths.js'

export const PROFILE = 'omni'
const READY_TIMEOUT_MS = 120_000
const STOP_GRACE_MS = 8_000

const expandHome = text => (text === '~' ? homedir() : /^~[\\/]/.test(text) ? join(homedir(), text.slice(2)) : text)

/** Automagik's home: $AUTOMAGIK_HOME, else ~/.automagik. A blank value counts as unset. */
export function automagikHome(env = process.env) {
  return env.AUTOMAGIK_HOME?.trim() ? resolve(expandHome(env.AUTOMAGIK_HOME.trim())) : join(homedir(), '.automagik')
}

/** The app's own folder: desktop/ in Automagik's home. */
export const appHome = (env = process.env) => join(automagikHome(env), 'desktop')

// What the person chose to share (privacy.js), and the dsh overlay made from it at each launch.
export const privacyFileOf = home => join(home, 'privacy.json')
export const privacyPatchOf = home => join(home, 'privacy.patch.yml')
// DSH's anonymous id, sent with every DeepSeek request, kept in the DSH home; no setting
// stops it, so the app starts each launch without one and DSH makes a new one.
export const ANONYMOUS_ID = '.anonymous-user-id'

/** Where the runtime and the profile are: inside the app when packaged, build/ in a checkout. */
export function resourcesOf({ packaged, resourcesPath, appPath }) {
  const root = packaged ? resourcesPath : join(appPath, 'build')
  return {
    bin: join(root, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    pnpm: join(root, 'runtime', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    profile: join(root, 'profile'),
  }
}

const shellQuote = text => `'${String(text).replaceAll("'", `'\\''`)}'`
// In a batch file only a % is read inside double quotes (and a !, with delayed expansion, which the
// tools switch off); a Windows path has no ".
const batchQuote = text => `"${String(text).replaceAll('%', '%%')}"`

/** The file a tool is written to: `pnpm.cmd` on Windows, which runs no `#!/bin/sh` script. */
export const toolFileOf = (dir, name, platform = process.platform) => join(dir, platform === 'win32' ? `${name}.cmd` : name)

/**
 * Write `node` and `pnpm` into `dir` for dsh's PATH: dsh's plugin manager installs plugins
 * (the market, Settings → Plugins) with pnpm, and nothing guarantees a machine has Node or
 * pnpm. Both run on `node`, the app's own binary as Node (ELECTRON_RUN_AS_NODE). Checked at
 * every launch, since the app's path changes with each install; a file that already says the
 * same, and can run, is left as it is. On Windows they are batch files, `node.cmd` and
 * `pnpm.cmd`, which PATH finds by PATHEXT.
 */
export function writeTools({ dir, node, pnpm, platform = process.platform }) {
  mkdirSync(dir, { recursive: true })
  const windows = platform === 'win32'
  const tools = windows
    ? { node: `${batchQuote(node)} %*`, pnpm: `${batchQuote(node)} ${batchQuote(pnpm)} %*` }
    : {
        node: `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(node)} "$@"`,
        pnpm: `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(node)} ${shellQuote(pnpm)} "$@"`,
      }
  for (const [name, line] of Object.entries(tools)) {
    const file = toolFileOf(dir, name, platform)
    const text = windows
      ? `@echo off\r\nrem Written by the Automagik desktop app at launch (src/dsh.js writeTools).\r\nsetlocal DisableDelayedExpansion\r\nset ELECTRON_RUN_AS_NODE=1\r\n${line}\r\n`
      : `#!/bin/sh\n# Written by the Automagik desktop app at launch (src/dsh.js writeTools).\n${line}\n`
    if (sameTool(file, text, windows)) continue
    writeFileSync(file, text)
    chmodSync(file, 0o755)
  }
  return dir
}

// Windows keeps no execute bit: there only the text counts.
const sameTool = (file, text, windows) => {
  try {
    return (windows || (statSync(file).mode & 0o777) === 0o755) && readFileSync(file, 'utf8') === text
  } catch {
    return false
  }
}

// The top-level entries of a cordis patch file (a YAML list): each starts with "- " at the
// first column, runs over its indented lines, and takes the comment lines right above it.
function patchEntries(text) {
  const entries = []
  let comments = []
  let current = null
  for (const line of String(text).split('\n')) {
    if (line.startsWith('- ')) {
      current = { lines: [...comments, line], ids: [] }
      comments = []
      entries.push(current)
    } else if (line.startsWith('#')) {
      comments.push(line)
      continue
    } else if (current && /^\s+\S/.test(line)) {
      current.lines.push(line)
    } else {
      comments = []
      continue
    }
    const id = line.match(/^[\s-]*id:\s*['"]?([^'"\s#]+)/)
    if (id) current.ids.push(id[1])
  }
  return entries
}

const idsIn = text => new Set([...String(text).matchAll(/^[\s-]*id:\s*['"]?([^'"\s#]+)/gm)].map(match => match[1]))

/**
 * The user's profile patch with the shipped entries it lacks appended, or null when it
 * lacks none. An entry is missing when none of the ids it names appears in the user's file;
 * one the user has (changed or not) is theirs and stays. DSH's empty template (`[]`) is
 * replaced rather than appended to.
 */
export function mergeProfilePatch(user, shipped) {
  const have = idsIn(user)
  const missing = patchEntries(shipped).filter(entry => entry.ids.length > 0 && entry.ids.every(id => !have.has(id)))
  if (missing.length === 0) return null
  const added = missing.map(entry => entry.lines.join('\n')).join('\n')
  const base = String(user).replace(/^\[\]\s*$/m, '').replace(/\s*$/, '')
  return `${base === '' ? '' : `${base}\n`}${added}\n`
}

/**
 * Packages earlier builds shipped under another name: the Bot team and the welcome were
 * @automagik/omni-dsh and @automagik/omni-ai-dsh while they lived in Omni's repository. An
 * update moves a profile it finds from the old names to the new ones (installProfile), so
 * it does not run two copies of one plugin, and the user's settings rows keep applying:
 * DSH applies a profile row only to the package its `name` names.
 */
export const RENAMED = Object.freeze({
  '@automagik/omni-dsh': '@automagik/bots-dsh',
  '@automagik/omni-ai-dsh': '@automagik/welcome-dsh',
})

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/**
 * A cordis patch file's text with each renamed package's name moved to its new one, its
 * subpaths too (`@automagik/omni-dsh/web-search`); null when it names none of them.
 */
export function renamePatch(text, renamed = RENAMED) {
  let next = String(text)
  for (const [from, to] of Object.entries(renamed)) {
    next = next.replace(new RegExp(`(?<![\\w@/.-])${escapeRegExp(from)}(?![\\w.-])`, 'gm'), to)
  }
  return next === String(text) ? null : next
}

/** The renamed packages whose new name `shipped` (a profile package.json) carries. */
function renamedIn(shipped, renamed = RENAMED) {
  return Object.entries(renamed).filter(([, to]) => Object.hasOwn(shipped?.dependencies ?? {}, to)).map(([from]) => from)
}

/**
 * Packages earlier builds shipped that this one dropped, each with the profile row ids its
 * own patch used. Oh My Claude (Claude through the person's Claude Code) is gone: Claude
 * comes through DSH's pi-ai route now. Left in a profile, an update would keep it as a plugin
 * the person installed. An update takes it out of node_modules, package.json and both patch
 * files (retirePatch): DSH skips a settings row for a row id nobody inserts, but an insert row
 * naming a package that is gone fails to activate.
 */
export const RETIRED = Object.freeze({
  'dsh-oh-my-claude': Object.freeze(['oh-my-claude']),
})

const retiredIn = (shipped, retired = RETIRED) => Object.keys(retired).filter(name => !Object.hasOwn(shipped?.dependencies ?? {}, name))

// A YAML scalar as a patch line holds it: `name: 'x'`, `name: "x"` or `name: x`, then an
// optional comment.
const scalarLine = (key, values) => new RegExp(`^[\\s-]*${key}:\\s*(['"]?)(?:${values.map(escapeRegExp).join('|')})\\1\\s*(?:#.*)?$`)

/**
 * A cordis patch file's text without the rows of the retired packages, or null when it has
 * none: a top-level row whose id is one of theirs or whose `name` is the package, and an
 * `insert` item naming the package (an insert left empty goes whole). Comment lines right
 * above a dropped row go with it; everything else stays as written.
 */
export function retirePatch(text, retired = RETIRED) {
  const names = Object.keys(retired)
  if (names.length === 0) return null
  const ids = Object.values(retired).flat()
  const named = scalarLine('name', names)
  const owned = scalarLine('id', ids)
  const lines = String(text).split('\n')
  // Blocks: a top-level row (from its "- " line through its indented and blank lines) with
  // the comment lines right above it; anything else is a block of its own and stays.
  const blocks = []
  let comments = []
  for (const line of lines) {
    if (line.startsWith('- ')) {
      blocks.push({ row: true, head: comments, lines: [line] })
      comments = []
    } else if (line.startsWith('#')) {
      comments.push(line)
    } else if (blocks.at(-1)?.row && comments.length === 0 && (line.trim() === '' || /^\s/.test(line))) {
      blocks.at(-1).lines.push(line)
    } else {
      blocks.push({ row: false, head: comments, lines: [line] })
      comments = []
    }
  }
  if (comments.length > 0) blocks.push({ row: false, head: comments, lines: [] })
  let changed = false
  const out = []
  for (const block of blocks) {
    if (!block.row) {
      out.push(...block.head, ...block.lines)
      continue
    }
    const [first, ...rest] = block.lines
    if (/^-\s+insert:\s*(?:#.*)?$/.test(first)) {
      // Its items: each starts at the indent of the first "- " under it.
      const indent = rest.find(line => /^\s+-\s/.test(line))?.match(/^\s+/)[0]
      if (indent === undefined) {
        out.push(...block.head, ...block.lines)
        continue
      }
      const items = []
      const lead = []
      for (const line of rest) {
        if (line.startsWith(`${indent}- `)) items.push([line])
        else if (items.length > 0) items.at(-1).push(line)
        else lead.push(line)
      }
      // An item's own keys: its "- " line and the lines at the indent right under it; its
      // nested config is left alone, as for a row below.
      const ownKey = new RegExp(`^${indent} {2}\\S`)
      const kept = items.filter(([head, ...lines]) => ![head, ...lines.filter(line => ownKey.test(line))].some(line => named.test(line)))
      if (kept.length === items.length) {
        out.push(...block.head, ...block.lines)
        continue
      }
      changed = true
      if (kept.length > 0) out.push(...block.head, first, ...lead, ...kept.flat())
      else if (block.lines.at(-1) === '') out.push('')
      continue
    }
    // A row's own keys sit at its first indent; nested config keys are left alone.
    const own = [first, ...rest.filter(line => /^ {2}\S/.test(line))]
    if (own.some(line => named.test(line) || owned.test(line))) {
      changed = true
      if (block.lines.at(-1) === '') out.push('')
      continue
    }
    out.push(...block.head, ...block.lines)
  }
  if (!changed) return null
  const next = out.join('\n')
  // A file left with no rows is DSH's empty template.
  return next.trim() === '' ? '[]\n' : next
}

/**
 * Take the retired packages out of a profile an earlier build installed: their folders in
 * node_modules and their rows in the profile's patch and DSH's own. package.json follows in
 * mergeProfilePackage. Returns what changed.
 */
export function migrateRetired({ target, dshHome, shipped, retired = RETIRED }) {
  const gone = retiredIn(shipped, retired)
  if (gone.length === 0) return []
  const changed = []
  for (const name of gone) {
    const dir = join(target, 'node_modules', ...name.split('/'))
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
      changed.push(dir)
    }
  }
  const only = Object.fromEntries(gone.map(name => [name, retired[name]]))
  for (const file of [join(target, 'cordis.patch.yml'), join(dshHome, 'cordis.patch.yml')]) {
    if (!existsSync(file)) continue
    const next = retirePatch(readFileSync(file, 'utf8'), only)
    if (next !== null) {
      writeFileSync(file, next)
      changed.push(file)
    }
  }
  return changed
}

/**
 * Move a profile from the renamed packages to their new names: the old packages leave
 * node_modules (the new ones arrive with the shipped packages), and the profile's patch and
 * DSH's own (DSH_HOME/cordis.patch.yml) name the new ones. Bots, chats, memory and the Omni
 * link are in the team's home, which no name is part of: nothing there moves.
 */
export function migrateRenamed({ target, dshHome, shipped, renamed = RENAMED }) {
  const moved = renamedIn(shipped, renamed)
  if (moved.length === 0) return []
  const changed = []
  for (const name of moved) {
    const dir = join(target, 'node_modules', ...name.split('/'))
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
      changed.push(dir)
    }
  }
  const only = Object.fromEntries(moved.map(name => [name, renamed[name]]))
  for (const file of [join(target, 'cordis.patch.yml'), join(dshHome, 'cordis.patch.yml')]) {
    if (!existsSync(file)) continue
    const next = renamePatch(readFileSync(file, 'utf8'), only)
    if (next !== null) {
      writeFileSync(file, next)
      changed.push(file)
    }
  }
  return changed
}

/**
 * Where a pre-upgrade copy of DSH's settings.yaml is kept: DSH_HOME/profile-backups, the
 * folder DSH itself writes profile backups into.
 */
export const settingsBackupsOf = dshHome => join(dshHome, 'profile-backups')

/**
 * Copy DSH's settings.yaml aside once per dsh version, before dsh starts. dsh's settings
 * service renames the file to settings.yaml.imported on its first boot with a profile that
 * no longer reads it, moving each section it accepts into the profile; a section it rejects
 * stays only in that renamed file. The copy is a copy (dsh's rename then loses nothing) and
 * one per version, so a second launch under the same runtime finds it and does nothing.
 * Missing settings.yaml is a fresh home: nothing to keep.
 * @returns the copy made now, or undefined when there was nothing to copy or it exists.
 */
export function backupSettings({ dshHome, version }) {
  if (typeof version !== 'string' || version === '') return undefined
  const settings = join(dshHome, 'settings.yaml')
  if (!existsSync(settings)) return undefined
  const dir = settingsBackupsOf(dshHome)
  const copy = join(dir, `settings-${version.replace(/[^0-9A-Za-z.-]/g, '_')}.yaml`)
  if (existsSync(copy)) return undefined
  mkdirSync(dir, { recursive: true })
  // Written under a temporary name and renamed: a copy cut short (a quit, a full disk) never
  // looks like a finished backup that the next launch then skips.
  const temp = `${copy}.${process.pid}.tmp`
  try {
    rmSync(temp, { force: true })
    cpSync(settings, temp, { errorOnExist: true, force: false })
    renameSync(temp, copy)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
  return copy
}

/**
 * `backupSettings`, with a failed copy reported and stepped over: the settings copy protects a
 * rollback, it must never keep the app from starting. Returns what backupSettings did, or
 * undefined after reporting.
 */
export function backupSettingsOrLog({ dshHome, version, log = () => {} }) {
  try {
    return backupSettings({ dshHome, version })
  } catch (error) {
    log(`settings backup failed (${error?.message ?? error})`)
    return undefined
  }
}

/**
 * Put the shipped profile in place under DSH_HOME/profiles/omni. It is copied, not
 * linked: dsh routes a plugin's imports to its own packages only for files inside the
 * profile. A profile already there from the same build (scripts/prepare-runtime.mjs stamps
 * each with .build-id) is left as it is. Another build's gets the new packages
 * (node_modules, package.json) and nothing else: dsh keeps the user's settings in that
 * folder too (models and preferences in cordis.patch.yml, .plugin-manager/), and an
 * update must not take them away. The shipped cordis.patch.yml only seeds a new profile.
 * The copies are asynchronous, so the window stays live while a new build's packages go in;
 * dsh must not start before the returned promise resolves. A quit can cut a copy short (the app
 * lets it through while dsh is not spawned yet): a new profile is copied beside its place and
 * moved in whole, with its marker, so a cut-short one never looks like a profile; an update
 * writes the marker last, so the next start does it again.
 */
export async function installProfile({ dshHome, source }) {
  const target = join(dshHome, 'profiles', PROFILE)
  const id = join(source, '.build-id')
  const stamp = existsSync(id) ? readFileSync(id, 'utf8') : readFileSync(join(source, 'package.json'), 'utf8')
  const marker = join(target, '.omni-desktop-profile')
  if (existsSync(marker) && readFileSync(marker, 'utf8') === stamp) return { target, installed: false }
  if (!existsSync(target)) {
    mkdirSync(join(dshHome, 'profiles'), { recursive: true })
    const fresh = `${target}.installing`
    await rm(fresh, { recursive: true, force: true })
    await cp(source, fresh, { recursive: true })
    writeFileSync(join(fresh, '.omni-desktop-profile'), stamp)
    renameSync(fresh, target)
    return { target, installed: true }
  } else {
    // A profile from a build that shipped the Bot team or the welcome under its old name.
    migrateRenamed({ target, dshHome, shipped: readJson(join(source, 'package.json')) })
    // A profile with a package this build no longer ships (RETIRED).
    migrateRetired({ target, dshHome, shipped: readJson(join(source, 'package.json')) })
    // Only the packages the app ships are replaced: a plugin the user installed (the market,
    // Settings → Plugins) stays, with its dependencies, and in package.json.
    for (const name of packagesIn(join(source, 'node_modules'))) {
      await rm(join(target, 'node_modules', name), { recursive: true, force: true })
      await cp(join(source, 'node_modules', name), join(target, 'node_modules', name), { recursive: true })
    }
    // The tarballs in vendor/ are the app's (file:vendor/… in the shipped package.json), except
    // those a plugin the person installed names.
    const user = readJson(join(target, 'package.json'))
    const shipped = readJson(join(source, 'package.json'))
    const own = ownDependencies(user, shipped)
    const kept = new Set(own.map(([, spec]) => /^file:(?:\.\/)?vendor\/([^/]+)$/.exec(String(spec))?.[1]))
    for (const file of existsSync(join(target, 'vendor')) ? readdirSync(join(target, 'vendor')) : []) {
      if (!kept.has(file)) rmSync(join(target, 'vendor', file), { recursive: true, force: true })
    }
    if (existsSync(join(source, 'vendor'))) await cp(join(source, 'vendor'), join(target, 'vendor'), { recursive: true })
    writeFileSync(join(target, 'package.json'), mergeProfilePackage(user, shipped))
    replaceLocks({ target, source, ownPlugins: own.length > 0 })
    if (existsSync(join(source, '.build-id'))) cpSync(join(source, '.build-id'), join(target, '.build-id'))
    for (const file of ['cordis.patch.yml', 'pnpm-workspace.yaml']) {
      if (!existsSync(join(target, file)) && existsSync(join(source, file))) cpSync(join(source, file), join(target, file))
    }
    // A setting a newer build ships (a new plugin's row, a seed) reaches an existing profile.
    const patch = join(target, 'cordis.patch.yml')
    const merged = mergeProfilePatch(readFileSync(patch, 'utf8'), readFileSync(join(source, 'cordis.patch.yml'), 'utf8'))
    if (merged !== null) writeFileSync(patch, merged)
  }
  writeFileSync(marker, stamp)
  return { target, installed: true }
}

/**
 * The lock and pnpm's records of node_modules must say what is installed, or the plugin
 * manager's next pnpm run in the profile fails on them or puts other versions back (pnpm add
 * re-resolves from them; its repair is pnpm install --frozen-lockfile). The app just put the
 * shipped packages in place, so the shipped build's own records come with them. When the person
 * installed plugins of their own, those records do not know them: the lock goes instead, and pnpm
 * resolves from package.json at its next run (node_modules/.modules.yaml stays, for its layout).
 */
function replaceLocks({ target, source, ownPlugins }) {
  const locks = ['pnpm-lock.yaml', join('node_modules', '.pnpm', 'lock.yaml')]
  if (ownPlugins) {
    for (const name of locks) rmSync(join(target, name), { force: true })
    return
  }
  for (const name of [...locks, join('node_modules', '.modules.yaml')]) {
    if (existsSync(join(source, name))) cpSync(join(source, name), join(target, name))
  }
}

/**
 * pnpm refuses to change a profile whose node_modules were linked from another store
 * (ERR_PNPM_UNEXPECTED_STORE): the shipped profile was installed on the build machine, and a
 * person's own pnpm config may name a store of its own. So the profile names the app's store
 * in its pnpm-workspace.yaml, which wins over the person's config, and its node_modules record
 * that store. Run at every launch: it also repairs a profile an earlier build left behind, and
 * never touches the person's pnpm config. `layout` is the store's folder for the app's pnpm
 * (v10 for pnpm 10, see storeLayoutOf). Returns the store path.
 */
export function pinProfileStore({ target, home, layout = 'v10' }) {
  const store = join(home, 'pnpm-store')
  const workspace = join(target, 'pnpm-workspace.yaml')
  const text = existsSync(workspace) ? readFileSync(workspace, 'utf8') : ''
  const line = `storeDir: ${JSON.stringify(store)}`
  const next = /^storeDir:.*$/m.test(text) ? text.replace(/^storeDir:.*$/m, line) : `${text.replace(/\s*$/, '')}${text.trim() ? '\n' : ''}${line}\n`
  if (next !== text) writeFileSync(workspace, next)
  // pnpm writes .modules.yaml as JSON; a store recorded there must be the one in use.
  const modules = join(target, 'node_modules', '.modules.yaml')
  const recorded = join(store, layout)
  if (existsSync(modules)) {
    const raw = readFileSync(modules, 'utf8')
    let fixed = raw
    try {
      const state = JSON.parse(raw)
      if (state.storeDir !== recorded) fixed = `${JSON.stringify({ ...state, storeDir: recorded }, null, 2)}\n`
    } catch {
      fixed = raw.replace(/^(\s*storeDir:\s*).*$/m, `$1${JSON.stringify(recorded)}`)
    }
    if (fixed !== raw) writeFileSync(modules, fixed)
  }
  return store
}

/** What a shipped profile records as its store until the app records its own at launch. */
export const SHIPPED_STORE = '<omni-desktop home>/pnpm-store'

/**
 * Take the build machine out of an installed profile before it ships: the store pnpm linked
 * it from (node_modules/.modules.yaml) and pnpm's cache of that machine's paths
 * (node_modules/.pnpm-workspace-state-v1.json, rebuilt on the next install).
 */
export function scrubBuildPaths(target) {
  const modules = join(target, 'node_modules', '.modules.yaml')
  if (existsSync(modules)) {
    const state = JSON.parse(readFileSync(modules, 'utf8'))
    writeFileSync(modules, `${JSON.stringify({ ...state, storeDir: SHIPPED_STORE }, null, 2)}\n`)
  }
  rmSync(join(target, 'node_modules', '.pnpm-workspace-state-v1.json'), { force: true })
}

/** The store folder pnpm uses for its major version: `v10` for pnpm 10.x. */
export function storeLayoutOf(pnpmCli) {
  const major = String(readJson(join(pnpmCli, '..', '..', 'package.json')).version ?? '').split('.')[0]
  return /^\d+$/.test(major) ? `v${major}` : 'v10'
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

// The packages in a node_modules folder, scoped ones as @scope/name; npm's and pnpm's own
// dot files are not packages.
function packagesIn(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => !name.startsWith('.')).flatMap(name =>
    name.startsWith('@') ? readdirSync(join(dir, name)).map(inner => `${name}/${inner}`) : [name])
}

// The dependencies the person added: neither shipped nor a shipped package under its old name.
function ownDependencies(user, shipped) {
  const replaced = new Set([...renamedIn(shipped), ...retiredIn(shipped)])
  return Object.entries(user?.dependencies ?? {}).filter(([name]) => !Object.hasOwn(shipped?.dependencies ?? {}, name) && !replaced.has(name))
}

/**
 * The shipped profile package.json with what the user added on top: dependencies and
 * bundles the shipped one does not name keep their place after the shipped ones, except a
 * shipped package's old name (RENAMED) and a package the app no longer ships (RETIRED).
 */
export function mergeProfilePackage(user, shipped) {
  const merged = structuredClone(shipped)
  const replaced = new Set([...renamedIn(shipped), ...retiredIn(shipped)])
  const extraDependencies = ownDependencies(user, shipped)
  if (extraDependencies.length > 0) merged.dependencies = { ...shipped.dependencies, ...Object.fromEntries(extraDependencies) }
  const shippedBundles = shipped.dsh?.profile?.bundles ?? []
  const extraBundles = (user?.dsh?.profile?.bundles ?? []).filter(name => !shippedBundles.includes(name) && !replaced.has(name))
  if (extraBundles.length > 0) merged.dsh.profile.bundles = [...shippedBundles, ...extraBundles]
  return `${JSON.stringify(merged, null, 2)}\n`
}

/**
 * The products the app can be opened for: `omni desktop` opens it for Omni, `genie desktop`
 * for Genie. A preload is a preference, not another build: the welcome (welcome-dsh) lists
 * that one first in its team step and starts with it chosen; the other stays a click away.
 */
export const PRELOADS = Object.freeze(['omni', 'genie'])
const PRELOAD_FILE = 'preload'

/** The preload a launch asks for: `--preload=<id>` or `--preload <id>`, else AUTOMAGIK_PRELOAD; null for none. */
export function preloadAsked(argv = [], env = {}) {
  let asked = null
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i])
    if (arg.startsWith('--preload=')) asked = arg.slice('--preload='.length)
    else if (arg === '--preload' && i + 1 < argv.length) asked = String(argv[++i])
  }
  asked ??= env.AUTOMAGIK_PRELOAD ?? null
  const id = typeof asked === 'string' ? asked.trim().toLowerCase() : ''
  return PRELOADS.includes(id) ? id : null
}

/**
 * The app's preload: the one this launch asks for, saved in the app's home so a later launch
 * from the Dock or a desktop entry (which passes no flags) keeps it; else the saved one; else
 * null, no preference. The installer never sees it: the launch that asks for it writes it.
 */
export function preloadOf({ home, argv = [], env = {} }) {
  const file = join(home, PRELOAD_FILE)
  const asked = preloadAsked(argv, env)
  if (asked) {
    mkdirSync(home, { recursive: true })
    if (!existsSync(file) || readFileSync(file, 'utf8').trim() !== asked) writeFileSync(file, `${asked}\n`)
    return asked
  }
  if (!existsSync(file)) return null
  const saved = readFileSync(file, 'utf8').trim()
  return PRELOADS.includes(saved) ? saved : null
}

/** A loopback port nobody listens on. */
export function freePort() {
  return new Promise((done, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })
}

// The port dsh served on last time, in the app's home. A new port each launch made the page's
// URL new to Chromium's HTTP cache and V8's code cache, so the 19 MB page bundle was fetched
// and compiled again on every start, and the page's origin (its localStorage: the composer's
// unsent drafts) changed with it. Only the port is reused, never a server: dsh still binds it
// itself, and the page still signs in with the launch URL its own output carries.
// When the port is taken the origin still moves: the drafts follow it through drafts.js (#141).
export const portFileOf = home => join(home, 'dsh-port')

/** The port in `file`, or null when there is none or it is not an unprivileged port. */
export function storedPort(file) {
  let text
  try { text = readFileSync(file, 'utf8').trim() } catch { return null }
  if (!/^\d{1,5}$/.test(text)) return null
  const port = Number(text)
  return port >= 1024 && port <= 65535 ? port : null
}

/** Keep `port` in `file` for the next launch; written whole, so a crash never leaves half of it. */
export function keepPort(file, port) {
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${port}\n`)
  renameSync(temporary, file)
}

/** Whether nothing listens on 127.0.0.1:`port`, the address dsh binds: binds it a moment, as dsh would. */
export function portFree(port) {
  return new Promise((done) => {
    const server = createServer()
    server.once('error', () => done(false))
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)))
  })
}

// How long a start waits for the stored port when something still listens on it, and how often
// it looks again. The usual holder is the dsh of the run before, still shutting down (a restart,
// an update, a quick relaunch): taking a new port at once moved the page's origin, and the
// composer's unsent drafts with it (#141).
export const PORT_WAIT_MS = 3000
export const PORT_WAIT_STEP_MS = 100

const defaultSleep = ms => new Promise(done => setTimeout(done, ms))

/**
 * The port to start dsh on: the one it served on last time (`file`) while nothing else
 * listens there, else a new free one. `fresh` finds the new one (freePort). A stored port that
 * is taken gets a short, bounded wait first: it is looked at again every `stepMs` for at most
 * `waitMs` on the clock `now`, and no more than `waitMs / stepMs` times whatever that clock
 * says, so a start is never held longer than the window. `onWaited(ms, freed)` tells a wait
 * that happened. `free`, `sleep` and `now` are the port check, the wait and the clock (tests
 * pass their own).
 */
export async function launchPort(file, fresh = freePort, { waitMs = PORT_WAIT_MS, stepMs = PORT_WAIT_STEP_MS, free = portFree, sleep = defaultSleep, now = Date.now, onWaited } = {}) {
  const stored = storedPort(file)
  if (stored === null) return fresh()
  if (await free(stored)) return stored
  const began = now()
  const waited = () => now() - began
  const step = Math.max(1, stepMs)
  let freed = false
  for (let looks = Math.ceil(waitMs / step); looks > 0 && !freed; looks -= 1) {
    const left = waitMs - waited()
    if (left <= 0) break
    await sleep(Math.min(step, left))
    freed = await free(stored)
  }
  if (waitMs > 0) onWaited?.(waited(), freed)
  return freed ? stored : fresh()
}

/**
 * Start dsh on `port` (startDsh); when something took the port before dsh could bind it, start
 * it once more on a fresh one (`fresh`), told first through `onPort`, unless `stopped()` says the
 * start was given up meanwhile (a quit). Resolves as startDsh does.
 */
export async function startDshOnPort({ port, fresh = freePort, onPort, stopped = () => false, ...options }) {
  try {
    return await startDsh({ ...options, port })
  } catch (error) {
    if (error.code !== 'EADDRINUSE' || stopped()) throw error
    const next = await fresh()
    if (stopped()) throw error
    onPort?.(next)
    return startDsh({ ...options, port: next })
  }
}

/**
 * The dsh a start runs, whichever process that is now: `track` takes each one as it spawns (the
 * first, then a retry's). `stop` stops the current one, and any spawned after it was called is
 * stopped at once, so a quit between the first dsh's exit and the retry leaves none behind.
 * `since` is when the current one was spawned: a busy file older than that is not its own
 * (quit-guard.js liveBusy).
 */
export function dshRun({ now = Date.now } = {}) {
  let child = null
  let since = null
  let stopped = false
  return {
    get child() { return child },
    get since() { return since },
    get stopped() { return stopped },
    track(next) {
      child = next
      since = now()
      // Just spawned, it has started nothing yet: it ends at once, before it can say it is ready
      // (taskkill, on Windows, would come too late).
      if (stopped) void stopDsh(next, undefined, { tree: false })
    },
    stop(graceMs) {
      stopped = true
      return stopDsh(child, graceMs)
    },
  }
}

/**
 * A start's dsh as main.js runs it: startDshOnPort, every process tracked by `run` (dshRun) from
 * its spawn, no retry once `run` is stopped, and the port kept in `portFile` once dsh serves on
 * it. A port that cannot be kept goes to `onUnkept(error)`; the start goes on. `onSpawn` also
 * gets each process.
 */
export async function serveDsh({ run, portFile, onSpawn, onUnkept = () => {}, ...options }) {
  const running = await startDshOnPort({
    ...options,
    stopped: () => run.stopped,
    onSpawn: (child) => {
      run.track(child)
      onSpawn?.(child)
    },
  })
  try { keepPort(portFile, Number(new URL(running.url).port)) } catch (error) { onUnkept(error) }
  return running
}

/**
 * Whether `running` (startDsh's answer) serves `origin`: its launch URL is on that origin and the
 * dsh that printed it still runs. The app loads no other page into its window.
 */
export function servesOrigin(running, origin) {
  if (!running?.child || running.child.exitCode !== null || running.child.signalCode !== null) return false
  try { return new URL(running.url).origin === origin } catch { return false }
}

/** The URL to load into the window: `running`'s launch URL, only when it serves `origin`. */
export function pageUrlOf(running, origin) {
  if (!servesOrigin(running, origin)) throw new Error(`dsh's launch URL is not on ${origin}.`)
  return running.url
}

/**
 * Whether dsh's output says its listener could not bind 127.0.0.1:`port`: Node's listen error,
 * `Error: listen EADDRINUSE: address already in use 127.0.0.1:<port>`, at the start of a line.
 */
export function listenFailed(text, port) {
  return String(text).split(/\r?\n/).some(line => line.trim() === `Error: listen EADDRINUSE: address already in use 127.0.0.1:${port}`)
}

/** The launch URL (with dsh's per-launch token) in a line of dsh's output, or null. */
export function launchUrlOf(text, port) {
  const match = String(text).match(/dsh web: (http:\/\/127\.0\.0\.1:(\d+)\/\S*token=\S+)/)
  if (!match || (port !== undefined && Number(match[2]) !== port)) return null
  return match[1]
}

/** The name of the file dsh's web app records this process's launch URL in, under DSH_HOME. */
export const LAUNCH_URL_FILE = 'launch-url'

/** The launch URL file in `dshHome`. */
export const launchUrlFileOf = dshHome => join(dshHome, LAUNCH_URL_FILE)

/**
 * The launch URL recorded in `file` for `port`, or null when the file is missing, unreadable or
 * names another origin or port: a file from a previous start must never sign this one in.
 */
export function launchUrlFromFile(file, port) {
  let text
  try { text = readFileSync(file, 'utf8').trim() } catch { return null }
  return launchUrlOf(`dsh web: ${text}`, port)
}

/**
 * Drops every dsh login cookie the app's session kept for dsh's host. dsh names one per
 * host:port and keeps it for days, but cookies ignore the port, so each start on a new port added
 * one more to every request until dsh refused them all (431 Request Header Fields Too Large) and
 * the page stayed blank. The launch URL's token signs the page in again. `cookies` is a session's
 * cookies (get, remove); answers how many went.
 */
export async function forgetDshLogins(cookies, origin) {
  const { hostname } = new URL(origin)
  const logins = (await cookies.get({ domain: hostname })).filter(cookie => cookie.name.startsWith('dsh-auth-'))
  await Promise.all(logins.map(cookie => cookies.remove(`http://${hostname}${cookie.path ?? '/'}`, cookie.name)))
  return logins.length
}

/** The environment dsh runs with: its own home, Omni's, and nothing that phones home. */
/**
 * Where command-line tools that plugins drive install themselves. An app opened from the Dock
 * or a desktop launcher gets a bare PATH without them, so a plugin that starts an agent CLI
 * (Claude Code installs to ~/.local/bin) would not find one that works in the person's terminal.
 */
export const toolDirs = (userHome = homedir()) => [join(userHome, '.local', 'bin'), join(userHome, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin']

export function dshEnv({ base = process.env, home, electronAsNode = false, binDir, userHome = homedir(), preload = null, privacy = PRIVACY_DEFAULTS, platform = process.platform }) {
  // After the machine's own: a project's commands keep the user's node and pnpm, and then the
  // usual tool folders, then the app's own node and pnpm.
  const PATH = [...String(base.PATH ?? '').split(delimiter), ...toolDirs(userHome), ...(binDir ? [binDir] : [])]
    .filter((dir, index, all) => dir !== '' && all.indexOf(dir) === index)
    .join(delimiter)
  return {
    ...base,
    PATH,
    DSH_HOME: join(home, 'dsh'),
    // The app's own team, apart from one in a dsh the person runs (bots-dsh folders.js).
    AUTOMAGIK_BOTS_HOME: join(home, 'bots'),
    // Signs in to an Omni as the desktop app (the Better Auth device-flow client id).
    OMNI_CLIENT_ID: 'omni-desktop',
    // The app answers the Bot team's browser bridge over dsh's IPC channel (startDsh): each Bot's
    // browser is in the window (bot-views.js), and the Bot drives it through bot-relay.js.
    AUTOMAGIK_APP_BROWSER: '1',
    // Nothing usable for training is reported unless the person chose to share it (privacy.js):
    // DSH's own opt-out, and the CLIs' analytics (npm's notice, OpenUI's).
    ...privacyEnv(privacy),
    // The Bot team's Privacy page saves the choices here; the app applies them at launch.
    AUTOMAGIK_PRIVACY_FILE: privacyFileOf(home),
    // The welcome keeps in it whether any agent is at work (welcome-dsh src/host/busy.js), so
    // an update installs while the person is away only when none is (idle.js).
    AUTOMAGIK_BUSY_FILE: busyFileOf(home),
    AUTOMAGIK_BUSY_PROTOCOL: '2',
    // The welcome reads it (welcome-dsh src/host/preload.js); none is no preference.
    ...(preload ? { AUTOMAGIK_PRELOAD: preload } : {}),
    // The pnpm acp-dsh installs its ACP adapters with: the app's own pnpm 10, never a newer one
    // the person has first on PATH, which installs the adapters' bundled CLIs anyway (~1.4 GB).
    ...(binDir ? { AUTOMAGIK_PNPM: toolFileOf(binDir, 'pnpm', platform) } : {}),
    ...(electronAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  }
}

/** The file dsh's welcome keeps the count of running agents in (see dshEnv). */
export const busyFileOf = home => join(home, 'busy.json')

/**
 * Start dsh on 127.0.0.1:`port` and resolve with { child, url } once it prints its launch
 * URL. `node` is the executable that runs dsh: Electron itself (with ELECTRON_RUN_AS_NODE),
 * or a Node in tests. Output goes to `log` (a writable stream) when given. `onSpawn` gets
 * the process at once, so a quit while dsh starts can stop it, and the app can answer its
 * messages (the Bot browser bridge, main.js) from the start. `urlFile` is the file dsh's web
 * app records the URL in: the previous start's is removed, and it is read when output is lost.
 */
export function startDsh({
  node, bin, env, port, cwd, log, privacy, timeoutMs = READY_TIMEOUT_MS, onSpawn, urlFile,
  spawn = nodeSpawn,
}) {
  // A file left by an earlier start must not sign this one in: dsh writes its own once it is
  // ready, and this start falls back to it when dsh's output is unavailable. A removal that
  // fails must not fail the start, but the old file may still name this port with a dead token
  // (dsh cannot replace it either), so that start learns the URL from dsh's output alone.
  let fileFallback = Boolean(urlFile)
  if (urlFile) {
    try {
      rmSync(urlFile, { force: true })
    } catch (error) {
      fileFallback = false
      const reason = error instanceof Error ? error.message : String(error)
      log?.write(`automagik: could not remove the previous launch URL ${urlFile}: ${reason}\n`)
    }
  }
  const args = [
    '--require', CLOSE_INHERITED, bin, '--profile', PROFILE,
    ...(privacy ? ['--patch', privacy] : []),
    '--no-open', '--host', '127.0.0.1', '--port', String(port),
  ]
  const child = spawn(node, args, {
    cwd, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  onSpawn?.(child)
  const ready = new Promise((done, fail) => {
    let seen = ''
    let poll = null
    let timer = null
    const stop = () => {
      clearTimeout(timer)
      if (poll !== null) clearInterval(poll)
    }
    const succeed = (url) => {
      stop()
      done(url)
    }
    const failWith = (error) => {
      stop()
      fail(error)
    }
    timer = setTimeout(
      () => failWith(new Error(`dsh did not start within ${Math.round(timeoutMs / 1000)} s`)),
      timeoutMs,
    )
    const onData = (chunk) => {
      log?.write(chunk)
      seen = `${seen}${chunk}`.slice(-4096)
      const url = launchUrlOf(seen, port)
      if (url) succeed(url)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    if (fileFallback) {
      // dsh's web app also records the URL here (runtime patch web-launch-token-persistence):
      // when its stdout is lost, the file is how the app still learns the launch URL.
      poll = setInterval(() => {
        const url = launchUrlFromFile(urlFile, port)
        if (url) succeed(url)
      }, 50)
      poll.unref?.()
    }
    child.once('exit', (code, signal) => {
      const error = new Error(`dsh exited before it was ready (${signal ?? code})`)
      // Its listener could not bind the port: something took it after the app looked. Only
      // dsh's own listen error for this very address counts (dsh-host-webserver listen), never
      // other log text that names the code.
      if (listenFailed(seen, port)) error.code = 'EADDRINUSE'
      failWith(error)
    })
    child.once('error', (error) => failWith(error))
  })
  return ready.then(url => ({ child, url }), (error) => {
    stopDsh(child)
    throw error
  })
}

/**
 * Stop dsh: SIGTERM, then SIGKILL if it is still there after the grace period. Windows has no
 * signals, and ending dsh alone there leaves its children (a terminal's OpenConsole.exe, rg.exe,
 * pnpm's node) running from the app's folder, where they hold files an update must replace: there
 * the whole tree ends at once (taskkill /T /F), and dsh alone only when taskkill cannot, or with
 * `tree: false`, for a dsh that has started nothing yet.
 */
export function stopDsh(child, graceMs = STOP_GRACE_MS, { platform = process.platform, env = process.env, run = execFile, tree = true } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((done) => {
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, graceMs)
    child.once('exit', () => {
      clearTimeout(timer)
      done()
    })
    if (tree && platform === 'win32' && child.pid) {
      run(taskkillOf(env), ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, (error) => {
        if (error) try { child.kill() } catch {}
      })
      return
    }
    try { child.kill('SIGTERM') } catch { done() }
  })
}

const taskkillOf = env => win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'taskkill.exe')

/**
 * The app's rules for every webContents it makes (main.js harden, on 'web-contents-created'):
 * window.open and off-origin links go to the system browser (`openExternal`), and a navigation
 * or a redirect off dsh's origin is refused. A Bot view (`isBotView`, bot-views.js) is left to
 * its own rules: its pages browse the web, and their new windows are the Bot's tabs.
 */
export function guardContents(contents, { origin, openExternal, isBotView = () => false }) {
  if (isBotView(contents)) return false
  // dsh's origin, or a function answering it as it is now: a dsh that could not bind its port
  // starts again on another (startDshOnPort) after the guard is in place.
  const current = typeof origin === 'function' ? origin : () => origin
  contents.setWindowOpenHandler(({ url }) => {
    if (navigationOf(url, current()) === 'external') void openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    const verdict = navigationOf(url, current())
    if (verdict === 'allow') return
    event.preventDefault()
    if (verdict === 'external') void openExternal(url)
  })
  // A server redirect is a navigation too.
  contents.on('will-redirect', (event, url) => {
    if (navigationOf(url, current()) !== 'allow') event.preventDefault()
  })
  contents.on('will-attach-webview', event => event.preventDefault())
  return true
}

/**
 * What the window may do with a URL. The app page and everything on its origin stays in
 * the window; web links (a wa.me link, docs, a channel's web page) open in the system
 * browser; anything else is refused.
 */
export function navigationOf(url, origin) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return 'deny'
  }
  if (parsed.origin === origin) return 'allow'
  if (parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:') return 'external'
  return 'deny'
}
