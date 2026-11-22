// Where Pocket Link keeps its state, outside the mod folder, so reinstalling the mod
// (rm -rf, then copy) never loses the phone pairings.
//
//   $POCKET_LINK_STATE_DIR                     when set (absolute): tests, and the login service,
//                                              which gets the dir the dialog resolved
//   ${XDG_STATE_HOME:-~/.local/state}/automagik-pocket-link/
//                                              the default, on macOS and Linux, as herdr-core does
//   .../automagik-pocket-link-<hash>/          when HERDR_APP_HOME picks another Herdr home, so a
//                                              test window never shares the live pairings
//
// Older versions kept it in <mod>/.state; open() moves it from there once (migrate()).
// No dependencies, so node --test runs it without the bridge's packages.
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const NAME = 'automagik-pocket-link'
export const KEY = 'secret.key'

export function syncStateDir(dir) {
  const fd = openSync(dir, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

export function writeStateJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`
  const fd = openSync(temp, 'wx', 0o600)
  try {
    try { writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temp, path)
    syncStateDir(dirname(path))
  } finally { rmSync(temp, { force: true }) }
}

const absolute = (p) => (typeof p === 'string' && p !== '' && isAbsolute(p) ? p : null)

/** The state dir for this environment (not created). */
export function stateDir({ env = {}, home }) {
  const forced = absolute(env.POCKET_LINK_STATE_DIR)
  if (forced) return resolve(forced)
  const base = absolute(env.XDG_STATE_HOME) ?? join(home, '.local/state')
  const appHome = absolute(env.HERDR_APP_HOME)
  if (appHome && resolve(appHome) !== resolve(home, '.config/herdr-app')) {
    const tag = createHash('sha256').update(resolve(appHome)).digest('hex').slice(0, 8)
    return join(base, `${NAME}-${tag}`)
  }
  return join(base, NAME)
}

/** Moves one file without ever replacing what is at `to`. False when `to` exists or `from` is gone. */
function moveFile(from, to) {
  try {
    // link() refuses an existing target, and the inode keeps its mode (and any open fd, such as
    // launchd's handle on bridge.log, keeps writing into the moved file).
    linkSync(from, to)
  } catch (e) {
    if (e.code === 'EEXIST' || e.code === 'ENOENT') return false
    if (e.code !== 'EXDEV' && e.code !== 'EPERM' && e.code !== 'ENOTSUP') throw e
    // Another filesystem (or one without hard links): copy beside it, then link into place.
    const tmp = `${to}.${process.pid}.migrate`
    try {
      copyFileSync(from, tmp, constants.COPYFILE_EXCL)
      chmodSync(tmp, statSync(from).mode & 0o777)
      try { linkSync(tmp, to) } catch (e2) { if (e2.code === 'EEXIST') return false; throw e2 }
    } catch (e2) {
      if (e2.code === 'ENOENT') return false
      throw e2
    } finally { try { unlinkSync(tmp) } catch {} }
  }
  try { unlinkSync(from) } catch {}
  return true
}

/** Moves every file from the old dir into `to` (which must exist). Returns the names moved and kept. */
export function migrate(from, to) {
  const moved = [], kept = []
  // The key first: once it is in the new dir, a second bridge starting now won't migrate again.
  const names = readdirSync(from, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name)
  names.sort((a, b) => (a === KEY ? -1 : b === KEY ? 1 : a.localeCompare(b)))
  for (const name of names) (moveFile(join(from, name), join(to, name)) ? moved : kept).push(name)
  if (existsSync(join(to, KEY))) chmodSync(join(to, KEY), 0o600)
  return { moved, kept }
}

const defaultAlive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

/**
 * Resolves, creates (0700) and, the first time, fills the state dir. Returns the dir to use now.
 * - The new dir has no secret.key and <mod>/.state exists: move its files over, one line in the log.
 * - Except while an older bridge still runs from <mod>/.state (its status.json pid is alive): moving
 *   its phones would make it refuse them, so this run keeps using the old dir. The next `serve`
 *   after that bridge stops (Turn on, Turn off, a restart) migrates.
 * - The old .state is left as an empty folder: a LaunchAgent loaded by an older version still
 *   writes its log there until it is installed again.
 */
export function open({ env = {}, home, modRoot, pid = process.pid, alive = defaultAlive, log = () => {} }) {
  const dir = stateDir({ env, home })
  // Parents (~/.local/state) at the usual mode; only this folder is 0700.
  mkdirSync(dirname(dir), { recursive: true })
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const old = join(modRoot, '.state')
  // `target` is where state belongs (what the login service is given); `dir` is what to use now.
  if (resolve(old) === resolve(dir) || existsSync(join(dir, KEY)) || !existsSync(old)) return { dir, target: dir, migrated: null, legacy: false }
  let running = null
  try { running = JSON.parse(readFileSync(join(old, 'status.json'), 'utf8')).pid } catch {}
  if (Number.isInteger(running) && running !== pid && alive(running)) return { dir: old, target: dir, migrated: null, legacy: true }
  const migrated = migrate(old, dir)
  log(`state: moved ${migrated.moved.length} file(s) from ${old} to ${dir}` + (migrated.kept.length ? `; kept ${migrated.kept.join(', ')} (already there)` : ''))
  return { dir, target: dir, migrated, legacy: false }
}
