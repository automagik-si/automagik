// The Code side's tree (RFC 0030 delivery 1): this computer's projects, their Bots and the
// workers each Bot started, from what the team already has. Nothing new is stored.
//
// Sources, in the RFC's order:
//   - the shared Bot registry (`src/shared/registry.js`): the home file's projects and Bots
//     (with a folder), then each project's repo file's Bots; a Bot on another machine is not
//     this computer's and never appears;
//   - the attach record (`src/shared/attach-record.js`, a byte-equal copy of the pack's
//     `herdr/mods/am-sidebar/attach.js`): which terminal plays which Bot here;
//   - the workers journal (`src/shared/workers-journal.js`): the workers a Bot started;
//   - herdr-core itself (`terminal.list`): the terminal's state, size and status, and the
//     `created_ms` that proves an id was not reused after a core restart.
//
// A binding is shown only once this computer's core confirms it: the core id is the one the
// registry-side rows name and `terminal.list` carries the same `created_ms`. Linked machines
// are not listed (RFC 0030 delivery 1's acceptance). A row carries no terminal for clicking
// until that confirmation holds, so the view can never attach a terminal it was merely told
// about. Reading and building are separate: `buildCodeTree` is pure and the host's reader
// only supplies the files and the core's answer.
import { execFile } from 'node:child_process'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { HOME_PATH, REPO_PATH, parseRegistry } from '../shared/registry.js'
import { attachPath, foldAttach, heldIn, readAttach } from '../shared/attach-record.js'
import { foldWorkers, readWorkers, workersOf, workersPath } from '../shared/workers-journal.js'
import { connectCore } from './code-core.js'
import { GIT_DIRS, startEnv, trustedHc, trustedProgram } from './code-env.js'

export const TREE_VERSION = 1
/** No ledger is read past this: a runaway file is refused, never parsed into memory. */
export const MAX_LEDGER_BYTES = 64 * 1024 * 1024
/** How many projects one answer carries: a bound on a runaway registry. */
export const MAX_PROJECTS = 200
/** A registry file past this is not read. */
export const MAX_REGISTRY_BYTES = 8 * 1024 * 1024
/** A project's Herdr team file past this is not read for the Start menu. */
export const MAX_ROSTER_BYTES = 1024 * 1024
/** The project file the pack's CLI starts a Bot from (`am start`, RFC 0014's version 1). */
export const ROSTER_PATH = join('.herdr', 'bots.json')

/**
 * Why New › Start an existing Bot cannot start a row, or null. Advisory for the menu: the CLI
 * decides again when a start runs.
 *   global-bot       RFC 0014's global Bot has no folder, and the CLI has no start path for it yet;
 *   ambiguous-clone  the id is listed in more than one folder (clones of one repository);
 *   folder-missing   the project folder is gone;
 *   not-in-roster    the project's `.herdr/bots.json` (version 1) does not list it: a Bot only in
 *                    the v2 registry, which the CLI does not read yet (RFC 0014 delivery 2);
 *   unverified       the project the CLI would start in, or its file, could not be checked here.
 * A row is startable only when its membership was verified.
 */
export const START_BLOCKS = Object.freeze(['global-bot', 'ambiguous-clone', 'folder-missing', 'not-in-roster', 'unverified'])
/** How long one git question about a project's main checkout may take. */
export const GIT_TIMEOUT_MS = 3_000
/** How many folders' git questions run at once. */
export const GIT_AT_ONCE = 4

/**
 * Why one Bot cannot start (or null), from what `startFacts` found. `facts` absent: a pure
 * caller with nothing read, so only a global Bot gets a reason.
 */
export function startBlock(botId, folder, facts) {
  if (folder === null) return 'global-bot'
  if (!facts) return null
  const roster = facts.rosters.get(folder)
  if (roster === 'missing') return 'folder-missing'
  if ((facts.clones.get(botId) ?? 1) > 1) return 'ambiguous-clone'
  // A project's registry that could not be read may list the same id: uniqueness is unknown.
  if (facts.incomplete || !(roster instanceof Set)) return 'unverified'
  return roster.has(botId) ? null : 'not-in-roster'
}

/** herdr-app's home: `$HERDR_APP_HOME`, else `~/.config/herdr-app` (the pack's own rule). */
export const appHomeOf = (env = process.env) => (env.HERDR_APP_HOME || join(env.HOME || '', '.config', 'herdr-app')).replace(/\/+$/, '')

/** The status words the Code side shows, as keys the client localizes. */
export const STATUS_WORDS = Object.freeze(['working', 'needs-you', 'idle', 'not-running'])

/** One terminal's status as the bar's words: a person is needed first, then what runs. */
export function statusWord(terminal) {
  if (!terminal) return 'not-running'
  if (terminal.status === 'blocked' || terminal.status === 'error') return 'needs-you'
  if (terminal.status === 'working') return 'working'
  return 'idle'
}

/** The terminal's own size, for an observer that must not reflow it. */
const sizeOf = (terminal) => (Number.isInteger(terminal?.cols) && Number.isInteger(terminal?.rows) && terminal.cols > 0 && terminal.rows > 0
  ? { cols: Math.min(terminal.cols, 65535), rows: Math.min(terminal.rows, 65535) }
  : null)

/** The project a folder names: its last segment, as the bar's rows show it; null for a global Bot. */
export const projectName = (folder) => {
  if (typeof folder !== 'string' || folder === '') return null
  const clean = folder.replace(/[\\/]+$/, '')
  return basename(clean) || clean
}

const byName = (a, b) => a.name.localeCompare(b.name)
const STATUS_RANK = { 'needs-you': 0, working: 1, idle: 2, 'not-running': 3 }

/**
 * This computer's projects, Bots and workers, pure over what was read.
 * @param {{
 *   bots: Array<{ id: string, name: string, role?: string, main?: boolean, folder?: string, agent?: string }>,
 *   projects?: Array<{ folder: string }>,
 *   attach: { fold: any, rows: any[] },
 *   workers: Map<string, any>,
 *   terminals: Map<string, any>,
 *   core: { id: string, name: string },
 *   facts?: { rosters: Map<string, 'missing' | Set<string> | null>, clones: Map<string, number>, keys: Map<string, string | null> },
 * }} input
 * @returns {{ v: number, machine: { name: string, core: string }, projects: any[] }}
 */
export function buildCodeTree({ bots = [], projects = [], attach, workers, terminals, core, facts }) {
  const local = bots.filter(bot => typeof bot.id === 'string' && typeof bot.name === 'string')
  const inProject = local.filter(bot => typeof bot.folder === 'string' && bot.folder !== '')
  // RFC 0014's global Bots have no folder; RFC 0022 lists them as seats. They are this
  // computer's Bots too, so the Code side carries them in a project-less group of their own.
  const globalBots = local.filter(bot => typeof bot.folder !== 'string' || bot.folder === '')
  const folders = new Map()
  for (const project of Array.isArray(projects) ? projects : []) {
    if (typeof project?.folder !== 'string' || !isAbsolute(project.folder)) continue
    folders.set(resolve(project.folder), { folder: resolve(project.folder) })
  }
  for (const bot of inProject) folders.set(resolve(bot.folder), { folder: resolve(bot.folder) })
  const rowsOf = (projectBots, folder = null) => projectBots.map((bot) => {
    const binding = heldIn(attach.fold, bot.id, null)
    const terminal = binding ? terminals.get(String(binding.terminal)) : undefined
    // The row must name this computer's core as well: a terminal id reused after a core
    // wipe is not the binding the ledger wrote.
    const live = Boolean(binding) && binding.core === core.id && terminal?.created_ms === binding.created_ms
    const size = live ? sizeOf(terminal) : null
    const seen = workersOf(workers, bot.id)
      .filter(worker => worker.core === core.id)
      .map((worker) => {
        const running = terminals.get(worker.terminal)
        if (!running || running.created_ms !== worker.created_ms) return null
        return {
          terminal: worker.terminal,
          role: worker.role,
          agent: worker.agent,
          model: worker.model,
          branch: worker.branch,
          worktree: worker.worktree,
          session: worker.session,
          status: statusWord(running),
        }
      })
      .filter(Boolean)
      .sort((a, b) => (STATUS_RANK[a.status] - STATUS_RANK[b.status]) || String(a.role ?? '').localeCompare(String(b.role ?? '')) || a.terminal.localeCompare(b.terminal))
    return {
      id: bot.id,
      name: bot.name,
      role: typeof bot.role === 'string' ? bot.role : null,
      agent: typeof bot.agent === 'string' ? bot.agent : null,
      main: bot.main === true,
      status: live ? statusWord(terminal) : 'not-running',
      terminal: live && size ? { id: binding.terminal, cols: size.cols, rows: size.rows } : null,
      // The project the live seat was started for, as its attach row says.
      ...(live && typeof binding.project === 'string' ? { seatProject: binding.project } : {}),
      workers: seen,
      blocked: startBlock(bot.id, folder, facts),
    }
  })
  // The main Bot of a group comes first; a global group has no main Bot unless one is marked.
  const ordered = (rows) => {
    const main = rows.find(row => row.main) ?? rows[0]
    const others = rows.filter(row => row !== main).sort((a, b) => (STATUS_RANK[a.status] - STATUS_RANK[b.status]) || byName(a, b))
    return [{ ...main, main: true }, ...others]
  }
  const built = []
  for (const { folder } of [...folders.values()].slice(0, MAX_PROJECTS)) {
    const projectBots = inProject.filter(bot => resolve(bot.folder) === folder)
    if (projectBots.length === 0) continue
    // The folder a start runs in, when the CLI's project is another one (a worktree's main checkout).
    const key = facts?.keys.get(folder)
    built.push({ folder, name: projectName(folder), ...(typeof key === 'string' && key !== folder ? { launch: key } : {}), bots: ordered(rowsOf(projectBots, folder)) })
  }
  built.sort((a, b) => String(a.name ?? a.folder).localeCompare(String(b.name ?? b.folder)))
  if (globalBots.length > 0) built.unshift({ folder: null, name: null, global: true, bots: ordered(rowsOf(globalBots)) })
  return { v: TREE_VERSION, machine: { name: core.name, core: core.id }, projects: built }
}

/** One registry read: { file, warnings } or { error }; a missing file is an empty registry. */
function readRegistry(path, kind, readFile = readFileSync) {
  const missing = { file: { bots: [], projects: [] }, warnings: [] }
  let text
  if (readFile === readFileSync) {
    // Never a blocking read on the host's loop: a regular file, opened without waiting, bounded.
    text = boundedText(path, MAX_REGISTRY_BYTES)
    if (text === undefined) return missing
    if (text === null) return { error: 'unreadable' }
  } else {
    try {
      text = readFile(path, 'utf8')
    } catch (error) {
      return error?.code === 'ENOENT' ? missing : { error: 'unreadable' }
    }
  }
  try {
    return parseRegistry(text, { kind })
  } catch {
    return { error: 'unreadable' }
  }
}

/**
 * The registry as the tree reads it: the home file's Bots and projects, then each project's
 * repo file's Bots (home wins on an id). A Bot on another machine, or a project on one, is
 * left out here.
 */
export function readRegistryTree({ env = process.env, readFile = readFileSync, warn = () => {} } = {}) {
  const automagikHome = env.AUTOMAGIK_HOME && String(env.AUTOMAGIK_HOME).trim() ? env.AUTOMAGIK_HOME : join(env.HOME || '', '.automagik')
  const home = join(automagikHome.replace(/\/+$/, ''), HOME_PATH)
  const readHome = readRegistry(home, 'home', readFile)
  if (readHome.error) { warn(`the Bot registry ${home} could not be read`); return { bots: [], projects: [], listed: new Map() } }
  // A local shown[] entry grants the project on this computer. Global Bots need no project.
  const shown = new Set((readHome.file.shown ?? [])
    .filter(entry => entry.machine === undefined && entry.project !== null && isAbsolute(entry.project))
    .map(entry => resolve(entry.project)))
  const bots = []
  const seen = new Set()
  // Every distinct local folder that lists an id: two clones of one repository list the same ids.
  const listed = new Map()
  const list = (id, folder) => {
    if (!listed.has(id)) listed.set(id, new Set())
    listed.get(id).add(folder)
  }
  for (const bot of readHome.file.bots ?? []) {
    if (bot.machine !== undefined) continue
    if (seen.has(bot.id)) continue
    seen.add(bot.id)
    if (bot.folder && (!isAbsolute(bot.folder) || !shown.has(resolve(bot.folder)))) continue
    if (typeof bot.folder === 'string' && bot.folder !== '') list(bot.id, resolve(bot.folder))
    // A home-file Bot with no folder is a global Bot (RFC 0014), and a seat (RFC 0022).
    bots.push({ id: bot.id, name: bot.name, role: bot.role, agent: bot.agent, main: bot.main === true, folder: typeof bot.folder === 'string' && bot.folder !== '' ? bot.folder : undefined })
  }
  const folders = new Set()
  for (const project of readHome.file.projects ?? []) {
    if (project?.machine !== undefined) continue
    if (typeof project?.folder === 'string' && isAbsolute(project.folder) && shown.has(resolve(project.folder))) folders.add(resolve(project.folder))
  }
  for (const bot of bots) if (typeof bot.folder === 'string') folders.add(resolve(bot.folder))
  const projects = [...folders].map(folder => ({ folder }))
  let incomplete = false
  for (const folder of folders) {
    const readRepo = readRegistry(join(folder, REPO_PATH), 'repo', readFile)
    if (readRepo.error) incomplete = true
    if (readRepo.error || !readRepo.file?.bots) continue
    for (const bot of readRepo.file.bots) {
      if (bot.machine !== undefined) continue
      if (typeof bot.id === 'string') list(bot.id, folder)
      if (seen.has(bot.id)) continue
      seen.add(bot.id)
      bots.push({ id: bot.id, name: bot.name, role: bot.role, agent: bot.agent, main: bot.main === true, folder })
    }
  }
  return { bots, projects, listed, incomplete }
}

/**
 * Whether the pack CLI's `--project <folder>` (its `namedKeyOf`: git's main checkout, else the
 * folder) is provably this folder: 'own' for a main checkout's root (a `.git` folder here) or a
 * folder in no repository at all (no `.git` here or above, no GIT_DIR), 'missing' when the folder
 * is gone, else 'unknown' (a linked worktree or submodule, a folder inside a repository): the CLI
 * answers for those itself.
 */
export function folderKind(folder, env = process.env) {
  try {
    if (!statSync(folder).isDirectory()) return 'missing'
  } catch { return 'missing' }
  if (env.GIT_DIR || env.GIT_WORK_TREE || env.GIT_COMMON_DIR) return 'unknown'
  // A path through a link: git walks the physical folders, so it is git's to answer.
  try { if (realpathSync(folder) !== resolve(folder)) return 'unknown' } catch { return 'unknown' }
  const entry = (dir, name = '.git') => { try { return lstatSync(join(dir, name)) } catch { return null } }
  const here = entry(folder)
  // A git dir with its own commondir shares another repository's: git decides where that is.
  // Only a .git folder git itself would take (HEAD, objects, refs) is this folder's own repository;
  // an empty or partial one makes git look further up, so git answers for it.
  const gitDir = join(folder, '.git')
  if (here) {
    return here.isDirectory() && !entry(gitDir, 'commondir') && entry(gitDir, 'HEAD')?.isFile() && headLooksValid(join(gitDir, 'HEAD'))
      && entry(gitDir, 'objects')?.isDirectory() && entry(gitDir, 'refs')?.isDirectory() ? 'own' : 'unknown'
  }
  for (let dir = dirname(folder); ; dir = dirname(dir)) {
    if (entry(dir)) return 'unknown'
    if (dir === dirname(dir)) return 'own'
  }
}

// git's own test of a HEAD: a symbolic ref under refs/, or an object id.
const headLooksValid = (path) => {
  const text = boundedText(path, 512)
  return typeof text === 'string' && (/^ref: refs\/\S+\s*$/.test(text) || /^[0-9a-f]{40}(?:[0-9a-f]{24})?\s*$/.test(text))
}

const isText = value => typeof value === 'string' && value.trim() !== ''
const ROSTER_KINDS = new Set(['main', 'member'])

/** A file's text, read through one descriptor and at most `limit` bytes; undefined when it is not there, null when it can't be read. */
function boundedText(path, limit) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > limit) return null
    // Room for the file as it is now, and one byte more to see it grow past the limit.
    const bytes = Buffer.alloc(Math.min(limit, stat.size) + 1)
    let size = 0
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null)
      if (count === 0) break
      size += count
    }
    return size > Math.min(limit, stat.size) ? null : bytes.toString('utf8', 0, size)
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? undefined : null
  } finally { if (fd !== undefined) closeSync(fd) }
}

/** One git question in `folder`, as the CLI asks it: its trimmed answer, '' when git says no, null when it can't tell. */
function askGit(args, folder, env, avoid = []) {
  // The repository this folder may belong to: the nearest folder up its physical path with a .git.
  let top = null
  try {
    for (let dir = realpathSync(folder); ; dir = dirname(dir)) {
      try { lstatSync(join(dir, '.git')); top = dir; break } catch { /* not here */ }
      if (dir === dirname(dir)) break
    }
  } catch { /* the folder went away: git answers that itself */ }
  const checkouts = [folder, top, ...avoid].filter(Boolean)
  const childEnv = startEnv(env, undefined, checkouts)
  // A system git, found without the projects' PATH, and not a link into a checkout.
  const git = trustedProgram('git', { PATH: GIT_DIRS.join(':') }, checkouts)
  return new Promise((done) => {
    if (!git) { done(null); return }
    try {
      execFile(git, args, { cwd: folder, env: childEnv, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024, killSignal: 'SIGKILL', windowsHide: true },
        (error, stdout) => {
          if (!error) return done(String(stdout).trim())
          // Not a repository, or no git: the CLI's own git() reads both as no answer.
          if (typeof error.code === 'number' || error.code === 'ENOENT') return done('')
          done(null)
        })
    } catch { done(null) }
  })
}

/**
 * The project the pack CLI's `--project <folder>` starts in (its `namedKeyOf`, model.js
 * projectOf's `own`): 'missing' when the folder is gone; the folder itself when that is provable
 * from files; else what git says (a common dir named `.git` -> its parent, else the top level, no
 * answer -> the folder); null when git could not be asked.
 */
export async function effectiveKey(folder, env = process.env, avoid = [], { askAlways = false } = {}) {
  const kind = folderKind(folder, env)
  if (kind === 'missing' || (kind === 'own' && !askAlways)) return kind === 'missing' ? 'missing' : folder
  const common = await askGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], folder, env, avoid)
  if (common === null) return null
  if (common) {
    const dir = common.replace(/\/+$/, '')
    if (basename(dir) === '.git') return dirname(dir)
    const top = await askGit(['rev-parse', '--show-toplevel'], folder, env, avoid)
    if (top === null) return null
    if (top) return top.replace(/\/+$/, '') || '/'
  }
  return folder
}

const keyOfFolder = (folder, env, avoid) => effectiveKey(folder, env, avoid)

/** The checkouts a set of facts names: each project folder and the project its starts run in. */
export function checkoutRoots(folders, keys = new Map()) {
  const roots = new Set(folders.filter(folder => typeof folder === 'string'))
  for (const key of keys.values()) if (typeof key === 'string' && key !== 'missing') roots.add(key)
  return [...roots]
}

/**
 * What a project's `.herdr/bots.json` says, by the CLI's own rules: the ids of its usable entries
 * (an absent file lists none: the CLI's `no-roster`); null when it can't be checked (unreadable,
 * not a regular file, too big, not JSON, not version 1).
 */
export function readRosterAt(key) {
  const text = boundedText(join(key, ROSTER_PATH), MAX_ROSTER_BYTES)
  if (text === undefined) return new Set()
  if (text === null) return null
  let file
  try { file = JSON.parse(text) } catch { return null }
  if (file === null || typeof file !== 'object' || file.version !== 1 || !Array.isArray(file.bots)) return null
  return new Set(file.bots
    .filter(bot => bot !== null && typeof bot === 'object' && isText(bot.id) && isText(bot.name) && ROSTER_KINDS.has(bot.kind))
    .map(bot => bot.id))
}

/**
 * For the registry's project folders (or `only` of them): the folder each start runs in, its
 * roster, and per Bot id how many distinct such projects list it (clones of one repository).
 */
export async function startFacts(registry, env = process.env, only = null) {
  const folders = (only ?? registry.projects.map(project => project.folder)).slice(0, MAX_PROJECTS)
  // No git may come from any project this computer shows, or from the repository it is in.
  const avoid = checkoutRoots(registry.projects.map(project => project.folder))
  const effectiveKey = (folder, env) => keyOfFolder(folder, env, avoid)
  const keys = new Map()
  // A few folders at a time: only a folder git must answer for runs git at all.
  for (let at = 0; at < folders.length; at += GIT_AT_ONCE) {
    const batch = folders.slice(at, at + GIT_AT_ONCE)
    for (const [folder, key] of await Promise.all(batch.map(async folder => [folder, await effectiveKey(folder, env)]))) keys.set(folder, key)
  }
  const keyOf = async (folder) => {
    if (!keys.has(folder)) keys.set(folder, await effectiveKey(folder, env))
    return keys.get(folder)
  }
  const rosters = new Map()
  for (const [folder, key] of keys) rosters.set(folder, key === 'missing' ? 'missing' : key === null ? null : readRosterAt(key))
  const clones = new Map()
  const shownIds = new Set(registry.bots.map(bot => bot.id))
  for (const [id, listedIn] of registry.listed ?? []) {
    if (!shownIds.has(id)) continue
    if (only && !only.some(folder => listedIn.has(folder))) continue
    const projects = new Set()
    for (const folder of listedIn) {
      const key = await keyOf(folder)
      if (key !== 'missing') projects.add(typeof key === 'string' ? key : folder)
    }
    clones.set(id, projects.size)
  }
  return { keys, rosters, clones, incomplete: registry.incomplete === true }
}

/**
 * One Bot's start, decided afresh from the registry and the project files (no core): its folder
 * and why it cannot start, or null when it is not this computer's Bot.
 */
export async function startTarget(botId, { env = process.env, readFile = readFileSync } = {}) {
  const registry = readRegistryTree({ env, readFile })
  const bot = registry.bots.find(candidate => candidate.id === botId)
  if (!bot) return null
  const folder = typeof bot.folder === 'string' && bot.folder !== '' ? resolve(bot.folder) : null
  if (folder === null) return { folder, blocked: 'global-bot' }
  const facts = await startFacts(registry, env, [folder])
  // The grant again, after git answered: a withdrawal meanwhile starts nothing.
  const final = readRegistryTree({ env, readFile })
  const again = final.bots.find(candidate => candidate.id === botId)
  if (!again || typeof again.folder !== 'string' || resolve(again.folder) !== folder) return null
  // A project that now lists the id too, or a registry that can no longer be read: not the facts git answered for.
  const listedIn = registry => [...(registry.listed.get(botId) ?? [])].sort().join('\0')
  if (final.incomplete !== registry.incomplete || listedIn(final) !== listedIn(registry)) {
    return { folder, key: facts.keys.get(folder), blocked: 'unverified' }
  }
  return { folder, key: facts.keys.get(folder), blocked: startBlock(botId, folder, facts) }
}

const readLedger = (path, readFile) => {
  let stat
  try { stat = statSync(path) } catch (error) { return error?.code === 'ENOENT' ? '' : null }
  if (!stat.isFile() || stat.size > MAX_LEDGER_BYTES) return null
  try { return readFile(path, 'utf8') } catch { return null }
}

/**
 * The host's tree: the registry, the two ledgers, and one `terminal.list` on a fresh
 * connection to this computer's core. { tree } on success, { reason } when it cannot answer.
 * @param {{ env?: NodeJS.ProcessEnv, warn?: (...args: any[]) => void, connect?: typeof connectCore, readFile?: typeof readFileSync }} [options]
 */
export async function readCodeTree({ env = process.env, warn = () => {}, connect = connectCore, readFile = readFileSync } = {}) {
  const registry = readRegistryTree({ env, readFile, warn })
  if (registry.bots.length === 0 && registry.projects.length === 0) return { reason: 'no-registry' }
  const appHome = appHomeOf(env)
  const attachText = readLedger(attachPath(appHome), readFile)
  const workersText = readLedger(workersPath(appHome), readFile)
  if (attachText === null) warn('the attach ledger could not be read')
  if (workersText === null) warn('the workers ledger could not be read')
  const attachRows = readAttach(attachText ?? '').rows
  const attach = { rows: attachRows, fold: foldAttach(attachRows) }
  const workers = foldWorkers(readWorkers(workersText ?? '').rows)
  const facts = await startFacts(registry, env)
  // The hc that serves the read: HERDR_HC or the CLI's own search, never one inside a project
  // this computer shows or the repository it is in.
  const bin = trustedHc(env, checkoutRoots(registry.projects.map(project => project.folder), facts.keys))
  if (!bin) { warn('the Code side found no hc outside the projects'); return { reason: 'no-core' } }
  let core
  try {
    core = await connect({ env, bin })
  } catch (error) {
    warn(`the Code side could not reach herdr-core: ${error?.kind ?? error?.message ?? error}`)
    return { reason: 'no-core' }
  }
  try {
    const answer = await core.call('terminal.list')
    const terminals = new Map()
    for (const terminal of answer?.terminals ?? []) {
      if (typeof terminal?.address === 'string') terminals.set(terminal.address, terminal)
    }
    return { tree: buildCodeTree({
      bots: registry.bots, projects: registry.projects, attach, workers, terminals, facts,
      core: { id: core.info?.core?.id ?? '', name: core.info?.core?.name ?? '' },
    }) }
  } catch (error) {
    warn(`the Code side could not list terminals: ${error?.kind ?? error?.message ?? error}`)
    return { reason: 'no-core' }
  } finally {
    core.close()
  }
}

/**
 * The pane one tree row names, resolved afresh and confirmed by the core, or null. A Bot id
 * alone (its seat) or a Bot id plus one of its folded worker terminals; never a bare terminal
 * from a request.
 * @param {{ botId: string, worker?: string|null, env?: NodeJS.ProcessEnv, connect?: typeof connectCore, readFile?: typeof readFileSync, warn?: Function }} input
 */
export async function resolvePane({ botId, worker = null, env = process.env, connect = connectCore, readFile = readFileSync, warn = () => {} }) {
  if (typeof botId !== 'string' || botId === '') return null
  const registry = readRegistryTree({ env, readFile, warn })
  const bot = registry.bots.find(candidate => candidate.id === botId)
  if (!bot) return null
  const appHome = appHomeOf(env)
  const attachRows = readAttach(readLedger(attachPath(appHome), readFile) ?? '').rows
  const fold = foldAttach(attachRows)
  let terminalId = null
  let createdMs = null
  let rowCore = null
  if (worker === null || worker === undefined) {
    const binding = heldIn(fold, botId, null)
    if (!binding) return null
    terminalId = binding.terminal
    createdMs = binding.created_ms
    rowCore = binding.core
  } else {
    const workers = foldWorkers(readWorkers(readLedger(workersPath(appHome), readFile) ?? '').rows)
    const found = workersOf(workers, botId).find(candidate => candidate.terminal === worker)
    if (!found) return null
    terminalId = found.terminal
    createdMs = found.created_ms
    rowCore = found.core
  }
  let core
  try {
    core = await connect({ env })
  } catch {
    return null
  }
  try {
    const coreId = core.info?.core?.id ?? ''
    // The row must name this computer's core: a row written on another machine's core with
    // a colliding terminal id is not this computer's pane.
    if (!coreId || rowCore !== coreId) return null
    const terminal = await core.call('terminal.get', { terminal: terminalId })
    if (!terminal || terminal.created_ms !== createdMs || terminal.state !== 'live') return null
    const size = sizeOf(terminal)
    if (!size) return null
    return { botId, terminal: terminalId, cols: size.cols, rows: size.rows, core: coreId, name: bot.name, folder: bot.folder }
  } catch {
    return null
  } finally {
    core.close()
  }
}
