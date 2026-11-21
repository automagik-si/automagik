// The environment of a program the Code side runs in a project folder (the pack CLI's start, a
// git question about the project): the host's own, with the folders it read relative to its own
// working folder made absolute, and a PATH of absolute folders outside the project, so nothing
// the project holds is found first.
import { accessSync, constants, readdirSync, realpathSync } from 'node:fs'
import { delimiter, isAbsolute, relative, resolve, sep } from 'node:path'

/** The PATH a program gets when none of the host's entries can be used. */
export const FALLBACK_PATH = ['/usr/bin', '/bin'].join(delimiter)
const DROPPED_ENV = ['HC_SESSION', 'HC_TERMINAL_ID', 'HC_TERMINAL_SOCKET', 'HC_SCOPE', 'AUTOMAGIK_HERDR_DEADLINE',
  // run.sh's test-only override of where it looks for node.
  'AUTOMAGIK_HERDR_RUNTIME_DIRS',
  // Node's own loaders and search paths: a relative one would resolve inside the project.
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_REPL_EXTERNAL_MODULE',
  // The native loader's preloads: never into a program the Code side runs.
  'LD_PRELOAD', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES']
// The native loader's search paths keep only absolute folders outside the project, as PATH does.
const SEARCH_ENV = ['LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH']
/** Where git is taken from: a system installation, never a folder found through the projects' PATH. */
export const GIT_DIRS = ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/bin']
const HOME_ENV = ['HOME', 'HERDR_APP_HOME', 'AM_HOME', 'AUTOMAGIK_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME']

/** Whether `path` is `root` or inside it. */
export const inside = (root, path) => {
  const rest = relative(root, path)
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest))
}
const real = (path) => { try { return realpathSync(path) } catch { return null } }

/**
 * The environment for a program run in `project` (a folder, or the folders a start concerns):
 * pinned to `socket` when one is given, without a pane's transport or Node loader settings, with
 * absolute home folders and a PATH outside those folders.
 */
export function startEnv(env, socket, project = null) {
  const child = { ...env }
  for (const name of DROPPED_ENV) delete child[name]
  for (const name of HOME_ENV) {
    if (typeof child[name] === 'string' && child[name] !== '' && !isAbsolute(child[name])) child[name] = resolve(child[name])
  }
  if (typeof child.NVM_DIR === 'string' && !isAbsolute(child.NVM_DIR)) delete child.NVM_DIR
  const owns = (Array.isArray(project) ? project : [project]).filter(dir => typeof dir === 'string' && isAbsolute(dir))
    .map(dir => real(dir) ?? resolve(dir))
  const usable = (entry) => {
    if (entry === '' || !isAbsolute(entry)) return false
    return owns.every(own => !inside(own, resolve(entry)) && !inside(own, real(entry) ?? resolve(entry)))
  }
  const path = [...new Set(String(env.PATH ?? '').split(delimiter).filter(usable))]
  child.PATH = path.length ? path.join(delimiter) : FALLBACK_PATH
  for (const name of SEARCH_ENV) {
    if (typeof child[name] !== 'string') continue
    const kept = [...new Set(child[name].split(delimiter).filter(usable))]
    if (kept.length) child[name] = kept.join(delimiter)
    else delete child[name]
  }
  if (socket !== undefined) {
    child.HC_SOCKET = socket
    child.AUTOMAGIK_HERDR_CORE_SOCKET = socket
  }
  return child
}

/**
 * Where a program run by name comes from, searched as the pack CLI searches (`env.PATH`, then
 * `~/.local/bin` and `extra` folders): its real path, or null when none is found.
 */
export function programTarget(name, env, extra = []) {
  const home = typeof env.HOME === 'string' && isAbsolute(env.HOME) ? env.HOME : null
  const dirs = [...String(env.PATH ?? '').split(delimiter), ...(home ? [`${home}/.local/bin`] : []), ...extra]
  for (const dir of dirs) {
    if (!dir || !isAbsolute(dir)) continue
    const file = `${dir}/${name}`
    try { accessSync(file, constants.X_OK) } catch { continue }
    return real(file)
  }
  return null
}

/** Whether `path` lies in one of `projects`, compared by real paths. */
export const inProjects = (path, projects) => projects.some(project => typeof project === 'string' && inside(real(project) ?? resolve(project), path))

/** `programTarget`, or null when it leads into one of `projects`: a link into a checkout never runs. */
export function trustedProgram(name, env, projects = [], extra = []) {
  const target = programTarget(name, env, extra)
  return target && !inProjects(target, projects) ? target : null
}

/** The hc a Code side read runs: HERDR_HC when set (absolute), else the CLI's search; never one inside `projects`. */
export function trustedHc(env, projects = []) {
  const configured = typeof env.HERDR_HC === 'string' && env.HERDR_HC.trim() !== '' ? env.HERDR_HC : null
  if (configured) return isAbsolute(configured) && !inProjects(real(configured) ?? configured, projects) ? configured : null
  return trustedProgram('hc', startEnv(env, undefined, projects), projects)
}

/**
 * An executable link, in any folder the CLI searches for programs (PATH, `~/.local/bin`, `extra`),
 * that leads into one of `projects`: its path, or null. Any program the CLI runs by name is then
 * known to come from outside the checkouts, whatever its name.
 */
export function linkIntoProjects(env, projects, extra = [], limit = 50_000) {
  const home = typeof env.HOME === 'string' && isAbsolute(env.HOME) ? env.HOME : null
  const dirs = [...new Set([...String(env.PATH ?? '').split(delimiter), ...(home ? [`${home}/.local/bin`] : []), ...extra])]
  let seen = 0
  for (const dir of dirs) {
    if (!dir || !isAbsolute(dir)) continue
    // The folder itself first: a link to a folder inside a checkout makes all of it the checkout's.
    const canonical = real(dir)
    if (canonical && inProjects(canonical, projects)) return dir
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue
      return `${dir} (cannot be read)`
    }
    for (const entry of entries) {
      if (++seen > limit) return `${dir} (too many entries to check)`
      if (!entry.isSymbolicLink()) continue
      const target = real(`${dir}/${entry.name}`)
      if (target && inProjects(target, projects)) return `${dir}/${entry.name}`
    }
  }
  return null
}
