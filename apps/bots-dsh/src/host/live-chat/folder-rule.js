// The transcript folder rule (RFC 0015, "Finding a terminal's transcript"; t2x5's review of RFC
// 0014). A path from a label, a hook payload or the workers ledger is used only if it is inside the
// agent's own transcript folder under the machine's home and ends in .jsonl. Labels are free-form,
// so this is what stops one pointing a chat at ~/.ssh. Ours, not Orca's. The cases both copies of
// the rule must pass are herdr/test/fixtures/transcript-folder-rule.json.
//
// Accepted limits (review of #267), for the engine (RFC 0015 delivery 3) to keep in mind:
// - A hard link inside the folder to a file elsewhere passes: realpath cannot see it. Writing one
//   needs the account that owns the folder, which can already read the target.
// - The rule checks a path; the engine opens it later. tail.js opens first, runs the rule again,
//   and reads only if the open handle's dev and inode are those of the rule's real path.
// - Case is compared as text, so on macOS's case-insensitive disk a path spelled with other case
//   than the folder (`.Claude/projects`) is refused, never wrongly accepted.
// - Remote paths are text only: a name with a leading `-` passes. The engine hands the path to hc
//   as an API argument, never on a command line, and takes `home` from hc, never from a label.
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'

/** Each agent's transcript folder, relative to the home. Widening this list changes RFC 0015. */
export const TRANSCRIPT_FOLDERS = Object.freeze({
  claude: '.claude/projects',
  codex: '.codex/sessions',
  omp: '.omp/agent/sessions'
})

/**
 * @typedef {{ ok: true, path: string } | { ok: false, reason: string, folder?: string }} RuleResult
 * A refusal names the reason and, where known, the folder: callers log it by its folder, never the path
 * or the file's contents.
 */

/** @param {string} reason @param {string} [folder] @returns {RuleResult} */
const refuse = (reason, folder) => (folder ? { ok: false, reason, folder } : { ok: false, reason })

/** Shared textual checks. @param {unknown} agent @param {unknown} path */
function textual(agent, path) {
  if (typeof agent !== 'string' || !Object.hasOwn(TRANSCRIPT_FOLDERS, agent)) return refuse('agent')
  const folder = TRANSCRIPT_FOLDERS[/** @type {keyof typeof TRANSCRIPT_FOLDERS} */ (agent)]
  if (typeof path !== 'string' || path === '') return refuse('empty', folder)
  if (/[\u0000-\u001f\u007f]/.test(path)) return refuse('control', folder)
  if (path.includes('\\')) return refuse('backslash', folder)
  if (!path.endsWith('.jsonl')) return refuse('extension', folder)
  return { folder }
}

/** True when a segment is empty, `.` or `..`: refused before anything is resolved. @param {string[]} segments */
function segmentsBad(segments) {
  return segments.some((s) => s === '' || s === '.' || s === '..')
}

/**
 * A transcript path on this computer. The path must be absolute, with no `.`, `..` or empty
 * segment, and its realpath must lie strictly inside the realpath of `<home>/<agent folder>`
 * (so a symlinked agent folder of the person's own is fine; a symlink out of it is not).
 * @param {string} agent  'claude' | 'codex' | 'omp'
 * @param {string} path   the path as a label, hook or ledger gave it
 * @param {string} home   this computer's home (callers pass it; never read here)
 * @returns {RuleResult}  on ok, `path` is the resolved real path to read
 */
export function localTranscriptPath(agent, path, home) {
  const t = textual(agent, path)
  if ('ok' in t) return t
  const { folder } = t
  if (typeof home !== 'string' || !isAbsolute(home)) return refuse('home', folder)
  if (!isAbsolute(path)) return refuse('relative', folder)
  if (segmentsBad(path.split('/').slice(1))) return refuse('segment', folder)
  let root
  let real
  try {
    root = realpathSync(join(home, folder))
    real = realpathSync(path)
  } catch {
    return refuse('missing', folder)
  }
  const rel = relative(root, real)
  if (rel === '' || isAbsolute(rel) || rel.split(sep).includes('..')) return refuse('outside', folder)
  // A s.jsonl link to an s.txt inside the folder: the name that is read must be a transcript's too.
  if (!real.endsWith('.jsonl')) return refuse('extension', folder)
  try {
    if (!statSync(real).isFile()) return refuse('not-file', folder)
  } catch {
    return refuse('missing', folder)
  }
  return { ok: true, path: real }
}

/**
 * A transcript path on another machine, checked as text only (realpath runs only here). An
 * absolute path must start with `home` + `/`; anything else must already be home-relative. The
 * result is read as that relative path with `hc file read --on <machine>`, with no `cwd`, so its
 * base is that machine's home; `on` always comes from the terminal's address, never from here.
 * @param {string} agent  'claude' | 'codex' | 'omp'
 * @param {string} path   the path as a label or ledger gave it
 * @param {string} home   that machine's home, absolute
 * @returns {RuleResult}  on ok, `path` is home-relative
 */
export function remoteTranscriptPath(agent, path, home) {
  const t = textual(agent, path)
  if ('ok' in t) return t
  const { folder } = t
  if (typeof home !== 'string' || !home.startsWith('/') || home.includes('\0')) return refuse('home', folder)
  const base = home.replace(/\/+$/, '')
  if (base === '') return refuse('home', folder)
  let rel = path
  if (path.startsWith('/')) {
    if (!path.startsWith(base + '/')) return refuse('outside', folder)
    rel = path.slice(base.length + 1)
  }
  const segments = rel.split('/')
  if (segmentsBad(segments)) return refuse('segment', folder)
  const own = folder.split('/')
  if (segments.length <= own.length) return refuse('outside', folder)
  if (own.some((s, i) => segments[i] !== s)) return refuse('outside', folder)
  return { ok: true, path: rel }
}
