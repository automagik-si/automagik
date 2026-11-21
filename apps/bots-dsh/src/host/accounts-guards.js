// Settings → Accounts, Add and Remove login (RFC 0030 delivery 5b; Decisions (2026-11-21), 1): the
// Herdr Accounts panel's guards, kept beside the page that now offers the buttons. They only read:
// the one writer stays the accounts CLI's `set-login`. Ported from the pack, whose rules they keep:
// `herdr/mods/am-sidebar/loginProbe.js` (statusOf, authCommand, paneLogin) and
// `herdr/mods/am-quota/main.js` (addLogin, removeLogin).
import { execFile } from 'node:child_process'
import { lstat as lstatAsync, realpath as realpathAsync } from 'node:fs/promises'

export const CONFIG_VAR = 'CLAUDE_CONFIG_DIR'
export const PROBE_MS = 10_000
/** A file-system look that does not answer in this long counts as failed (a stalled mount never blocks the host). */
export const FS_MS = 3_000
const PROBE_MAX_BYTES = 65_536
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/
const SLOT_ID = /^[1-9][0-9]{0,8}$/

export const trimSlash = path => String(path).replace(/\/+$/, '')

/** The next slot the CLI reported, as { id, dir }, only in the panel's form `<home>/.claude-<n>`, n >= 2. */
export function nextSlotOf(nextSlot, home) {
  const base = trimSlash(home)
  if (typeof nextSlot !== 'string' || !base.startsWith('/') || !nextSlot.startsWith(`${base}/.claude-`)) return null
  const id = nextSlot.slice(base.length + '/.claude-'.length)
  return SLOT_ID.test(id) && Number(id) >= 2 && shapeOkay(nextSlot, home) ? { id, dir: nextSlot } : null
}

/** What a look that ran out of time answers: never taken for "missing". */
export const TIMED_OUT = Symbol('timed out')

/** `fn()`'s answer, `fallback` when it fails, or TIMED_OUT when it takes longer than `ms`. */
export function bounded(fn, fallback, ms = FS_MS) {
  let timer
  return Promise.race([Promise.resolve().then(fn).catch(() => fallback), new Promise(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), ms) })])
    .finally(() => clearTimeout(timer))
}

/** A folder's real path, null when it has none, or TIMED_OUT; bounded. */
export const realPath = (path, realpath = realpathAsync) => bounded(() => realpath(path), null)

/** Whether `path` is a directory: true, false, or TIMED_OUT; bounded. */
export const isDirectoryAsync = (path, stat = lstatAsync) => bounded(async () => (await stat(path)).isDirectory(), false)

/** The pack's shape rule for a login folder (loginProbe.js shapeProblem): true when the CLI could launch with it. */
export function shapeOkay(dir, home) {
  if (typeof dir !== 'string' || !dir.startsWith('/') || dir.includes('~')) return false
  if (dir === '/' || dir.endsWith('/') || dir.split('/').slice(1).some(part => part === '' || part === '.' || part === '..')) return false
  return dir !== `${trimSlash(home)}/.claude`
}

/** The Add command: fixed text from the validated slot number, never from a path. */
export const signInCommand = id => `${CONFIG_VAR}="$HOME/.claude-${id}" claude auth login`

/**
 * The logout command for a verified slot folder: under home `"$HOME"/'<rest>'`, else `'<dir>'`,
 * every literal part single-quoted (POSIX), so no character of the folder expands in a shell.
 */
export function signOutCommand(dir, home) {
  const base = trimSlash(home)
  const quote = text => `'${text.replace(/'/g, "'\\''")}'`
  const word = base.startsWith('/') && dir.startsWith(`${base}/`) ? `"$HOME"/${quote(dir.slice(base.length + 1))}` : quote(dir)
  return `${CONFIG_VAR}=${word} claude auth logout`
}

/**
 * The panel's folder check before Add (the pack's FOLDER_SCRIPT): null when `dir` exists, is not a
 * symlink, its parent's physical path is the path as spelled, and it is a directory; else
 * 'no-folder' (missing) or 'bad-folder'. The CLI's form rule stays the authority under its lock.
 */
export async function folderProblem(dir, { lstat = lstatAsync, realpath = realpathAsync } = {}) {
  const stat = await bounded(() => lstat(dir), undefined)
  if (stat === TIMED_OUT) return 'probe-failed'
  if (stat === undefined) return 'no-folder'
  if (stat.isSymbolicLink()) return 'bad-folder'
  const parent = dir.slice(0, dir.lastIndexOf('/')) || '/'
  const real = await realPath(parent, realpath)
  if (real === TIMED_OUT) return 'probe-failed'
  if (real === null) return 'no-folder'
  if (real !== parent) return 'bad-folder'
  return stat.isDirectory() ? null : 'bad-folder'
}

/**
 * What `claude auth status` said, by the pack's statusOf rules: { state: 'in' | 'out' | 'nobin' |
 * 'unread' | 'late', loggedIn, configDirectory }. Signed out only on JSON `loggedIn: false` with
 * exit 0 or 1; no other field of the output is kept.
 */
export function readAuthStatus(result) {
  if (result?.late) return { state: 'late' }
  if (result?.code === 127) return { state: 'nobin' }
  let data = null
  try { data = JSON.parse(String(result?.stdout ?? '')) } catch {}
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { state: 'unread' }
  const configDirectory = typeof data.configDirectory === 'string' && data.configDirectory ? data.configDirectory : null
  if (data.loggedIn === false && (result.code === 0 || result.code === 1)) return { state: 'out', configDirectory }
  if (result.code !== 0) return { state: 'unread' }
  return { state: 'in', loggedIn: data.loggedIn === true, configDirectory }
}

/** `claude auth status` in `dir`, run as a launch on that login would run claude (`where`: launch-path's answer). */
export function askAuthStatus(dir, where, { env, cwd, ms = PROBE_MS, run = execFile } = {}) {
  if (!where?.program) return Promise.resolve({ state: 'nobin' })
  const args = [`PATH=${where.path}`, `${CONFIG_VAR}=${dir}`, where.program, 'auth', 'status']
  return new Promise(resolve => {
    let child
    try {
      child = run('/usr/bin/env', args, { env, cwd, timeout: ms, encoding: 'buffer', maxBuffer: PROBE_MAX_BYTES, killSignal: 'SIGKILL' },
        (error, stdout) => {
          if (error?.killed || error?.signal) return resolve({ state: 'late' })
          if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ state: 'unread' })
          if (error && typeof error.code !== 'number') return resolve({ state: 'unread' })
          resolve(readAuthStatus({ code: error?.code ?? 0, stdout }))
        })
    } catch { return resolve({ state: 'unread' }) }
    child.stderr?.removeAllListeners('data')
    child.stderr?.resume()
    child.stdin?.on('error', () => {})
    child.stdin?.end()
  })
}

/**
 * Which login a pane was launched on, from its launch argv, by value (the pack's paneLogin): { id }
 * for a listed folder or `-u CLAUDE_CONFIG_DIR` (the default login), { unknown: dir } for a folder no
 * login lists, { why } when it can't be told. Only env's own options and assignments are read.
 */
export function paneLogin(argv, logins) {
  if (!Array.isArray(argv) || !argv.length || !argv.every(word => typeof word === 'string')) return { why: 'no-argv' }
  const untracked = { why: 'untracked' }
  if (argv[0].split('/').pop() !== 'env') return untracked
  let i = 1
  let unset = false
  for (; i < argv.length; i += 1) {
    const word = argv[i]
    if (word === '-u' || word === '--unset') { unset ||= argv[i + 1] === CONFIG_VAR; i += 1 }
    else if (word === `-u${CONFIG_VAR}` || word === `--unset=${CONFIG_VAR}` || word === '-i') unset = true
    else if (!/^(-u.|--unset=)/.test(word)) break
  }
  let dir = null
  for (; i < argv.length && ASSIGN.test(argv[i]); i += 1) if (argv[i].startsWith(`${CONFIG_VAR}=`)) dir = argv[i].slice(CONFIG_VAR.length + 1)
  if (dir !== null && dir.startsWith('/')) dir = dir.replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1')
  if (dir !== null) {
    const login = logins.find(candidate => candidate.dir === dir)
    return login ? { id: login.id } : { unknown: dir }
  }
  return unset ? { id: 'default' } : untracked
}

/**
 * Whether any of `argvs` runs on the login being removed (the panel's Remove check), by its folder:
 * 'running' when one names `target.dir` by value or by real path, 'running-unknown' when one names a
 * folder under home that no listed login has, 'panes-unknown' when a real path could not be told in
 * time or the request ran out of time, else null. `logins`: [{ id, dir }] from the fresh read.
 */
export async function panesOn(argvs, target, logins, home, { realpath = realpathAsync, late = () => false } = {}) {
  const base = trimSlash(home)
  let unknown = false
  for (const argv of argvs) {
    if (late()) return 'panes-unknown'
    // The pane's folder as its env words name it (the default login and untracked panes name none).
    const on = paneLogin(argv, [])
    if (typeof on.unknown !== 'string') continue
    if (on.unknown === target.dir) return 'running'
    const real = await realPath(on.unknown, realpath)
    if (real === TIMED_OUT) return 'panes-unknown'
    if (real === target.dir) return 'running'
    if (logins.some(login => login.dir === on.unknown || (real !== null && login.dir === real))) continue
    if (on.unknown.startsWith(`${base}/`)) unknown = true
  }
  return unknown ? 'running-unknown' : null
}
