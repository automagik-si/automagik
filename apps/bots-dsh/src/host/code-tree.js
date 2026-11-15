// The Code side's tree (RFC 0030 delivery 1): this computer's projects, their Bots and the
// workers each Bot started, from what the team already has. Nothing new is stored.
//
// Sources, in the RFC's order:
//   - the shared Bot registry (`src/shared/registry.js`): the home file's projects and Bots
//     (with a folder), then each project's repo file's Bots; a Bot on another machine is not
//     this computer's and never appears;
//   - the attach ledger (`src/shared/attach-ledger.js`, a byte-equal copy of the pack's
//     `herdr/mods/am-sidebar/attach.js`): which terminal plays which Bot here;
//   - the workers ledger (`src/shared/workers-ledger.js`): the workers a Bot started;
//   - herdr-core itself (`terminal.list`): the terminal's state, size and status, and the
//     `created_ms` that proves an id was not reused after a core restart.
//
// A binding is shown only once this computer's core confirms it: the core id is the one the
// registry-side rows name and `terminal.list` carries the same `created_ms`. Linked machines
// are not listed (RFC 0030 delivery 1's acceptance). A row carries no terminal for clicking
// until that confirmation holds, so the view can never attach a terminal it was merely told
// about. Reading and building are separate: `buildCodeTree` is pure and the host's reader
// only supplies the files and the core's answer.
import { readFileSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { HOME_PATH, REPO_PATH, parseRegistry } from '../shared/registry.js'
import { attachPath, foldAttach, heldIn, readAttach } from '../shared/attach-ledger.js'
import { foldWorkers, readWorkers, workersOf, workersPath } from '../shared/workers-ledger.js'
import { connectCore } from './code-core.js'

export const TREE_VERSION = 1
/** No ledger is read past this: a runaway file is refused, never parsed into memory. */
export const MAX_LEDGER_BYTES = 64 * 1024 * 1024
/** How many projects one answer carries: a bound on a runaway registry. */
export const MAX_PROJECTS = 200

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
 * }} input
 * @returns {{ v: number, machine: { name: string, core: string }, projects: any[] }}
 */
export function buildCodeTree({ bots = [], projects = [], attach, workers, terminals, core }) {
  const local = bots.filter(bot => typeof bot.id === 'string' && typeof bot.name === 'string' && typeof bot.folder === 'string' && bot.folder !== '')
  const folders = new Map()
  for (const project of Array.isArray(projects) ? projects : []) {
    if (typeof project?.folder !== 'string' || !isAbsolute(project.folder)) continue
    folders.set(resolve(project.folder), { folder: resolve(project.folder) })
  }
  for (const bot of local) folders.set(resolve(bot.folder), { folder: resolve(bot.folder) })
  const built = []
  for (const { folder } of [...folders.values()].slice(0, MAX_PROJECTS)) {
    const projectBots = local.filter(bot => resolve(bot.folder) === folder)
    if (projectBots.length === 0) continue
    const rows = projectBots.map((bot) => {
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
        workers: seen,
      }
    })
    const main = rows.find(row => row.main) ?? rows[0]
    const others = rows.filter(row => row !== main).sort((a, b) => (STATUS_RANK[a.status] - STATUS_RANK[b.status]) || byName(a, b))
    built.push({
      folder,
      name: projectName(folder),
      bots: [{ ...main, main: true }, ...others],
    })
  }
  built.sort((a, b) => String(a.name ?? a.folder).localeCompare(String(b.name ?? b.folder)))
  return { v: TREE_VERSION, machine: { name: core.name, core: core.id }, projects: built }
}

/** One registry read: { file, warnings } or { error }; a missing file is an empty registry. */
function readRegistry(path, kind, readFile = readFileSync) {
  let text
  try {
    text = readFile(path, 'utf8')
  } catch (error) {
    return error?.code === 'ENOENT' ? { file: { bots: [], projects: [] }, warnings: [] } : { error: 'unreadable' }
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
  if (readHome.error) { warn(`the Bot registry ${home} could not be read`); return { bots: [], projects: [] } }
  const bots = []
  const seen = new Set()
  for (const bot of readHome.file.bots ?? []) {
    if (bot.machine !== undefined) continue
    if (typeof bot.folder !== 'string') continue
    if (seen.has(bot.id)) continue
    seen.add(bot.id)
    bots.push({ id: bot.id, name: bot.name, role: bot.role, agent: bot.agent, main: bot.main === true, folder: bot.folder })
  }
  const folders = new Set()
  for (const project of readHome.file.projects ?? []) {
    if (typeof project?.folder === 'string' && isAbsolute(project.folder)) folders.add(resolve(project.folder))
  }
  for (const bot of bots) folders.add(resolve(bot.folder))
  const projects = [...folders].map(folder => ({ folder }))
  for (const folder of folders) {
    const readRepo = readRegistry(join(folder, REPO_PATH), 'repo', readFile)
    if (readRepo.error || !readRepo.file?.bots) continue
    for (const bot of readRepo.file.bots) {
      if (bot.machine !== undefined || seen.has(bot.id)) continue
      seen.add(bot.id)
      bots.push({ id: bot.id, name: bot.name, role: bot.role, agent: bot.agent, main: bot.main === true, folder })
    }
  }
  return { bots, projects }
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
  let core
  try {
    core = await connect({ env })
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
    return { tree: buildCodeTree({ bots: registry.bots, projects: registry.projects, attach, workers, terminals, core: { id: core.info?.core?.id ?? '', name: core.info?.core?.name ?? '' } }) }
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
