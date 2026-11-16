// Which agent a terminal runs, and where its transcript is (RFC 0015, "Finding a terminal's
// transcript"). Ours. First match wins:
//   1. the `agent.transcript` label;
//   2. the workers ledger's last `session` row for the terminal (this computer only);
//   3. derived from `agent.session` (Claude only: Codex and omp name files by date);
//   4. discovered: the one transcript in the agent's folder for the pane's cwd written since the
//      pane started (this computer only; never guessed between two panes in one folder);
//   5. none: the chat is screen only.
// Every path passes the folder rule (folder-rule.js). A refusal is logged once per folder, never
// with the path.
//
// Discovery's limit: it counts only the panes herdr-core lists. A Claude started outside Herdr
// in the same folder is not a sibling, so its transcript can be the one fresh file and be taken
// for the pane's. Labels (delivery 2, and delivery 6's hook for every pane) close this.
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { addressParts } from './hc.js'
import { localTranscriptPath, remoteTranscriptPath, TRANSCRIPT_FOLDERS } from './folder-rule.js'

export const TRANSCRIPT_LABEL = 'agent.transcript'
export const SESSION_LABEL = 'agent.session'
/** <app home>/automagik-herdr/workers.jsonl (am-sidebar's workers.js, LEDGER_FILE). */
export const LEDGER_FILE = 'automagik-herdr/workers.jsonl'
/** Only the ledger's tail is read: its newest rows are the ones that count. */
export const LEDGER_TAIL_BYTES = 1024 * 1024

const APPS = { 'claude-code': 'claude', claude: 'claude', codex: 'codex', omp: 'omp' }
const base = (p) => (typeof p === 'string' ? p.split('/').pop() : '')

/**
 * The agent a terminal runs: herdr-core's `status.app` (Claude Code reports `claude-code`), else
 * the program in the foreground or in `argv`. Null for anything with no decoder (screen only).
 * @param {any} terminal  herdr-core's Terminal
 * @returns {'claude' | 'codex' | 'omp' | null}
 */
export function agentOf(terminal) {
  const app = terminal?.status?.app
  if (typeof app === 'string' && Object.hasOwn(APPS, app)) return APPS[app]
  for (const name of [base(terminal?.foreground?.argv?.[0]), terminal?.foreground?.name, base(terminal?.argv?.[0])]) {
    if (typeof name === 'string' && Object.hasOwn(APPS, name)) return APPS[name]
  }
  return null
}

/** Claude's project folder name for a cwd: every character but a letter or digit becomes `-`. */
export const claudeSlug = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, '-')

/** omp's session folder name for a cwd: home-relative, `/` becomes `-`, a leading `-`. */
export function ompSlug(cwd, home) {
  const h = String(home).replace(/\/+$/, '')
  const rel = cwd === h ? '' : cwd.startsWith(h + '/') ? cwd.slice(h.length + 1) : cwd.replace(/^\/+/, '')
  return `-${rel.replaceAll('/', '-')}`
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/

/**
 * A label or ledger path for a terminal on another machine, as the home-relative path to read
 * with `file.read --on`. An absolute path's home is what precedes the agent's folder in it: even
 * a wrong one only reaches that folder in the machine's real home, since the read is relative.
 */
function remotePath(agent, path) {
  // A home-relative path needs no home: the placeholder is never compared with it.
  if (typeof path !== 'string' || !path.startsWith('/')) return remoteTranscriptPath(agent, path, '/relative')
  const at = path.indexOf(`/${TRANSCRIPT_FOLDERS[agent]}/`)
  return remoteTranscriptPath(agent, path, at > 0 ? path.slice(0, at) : '/nowhere')
}

/** The ledger's last session row for `address` with a transcript, or null. */
function ledgerTranscript(appHome, address) {
  if (typeof appHome !== 'string' || !appHome) return null
  let fd
  try {
    fd = openSync(join(appHome, LEDGER_FILE), 'r')
    const size = statSync(join(appHome, LEDGER_FILE)).size
    const start = Math.max(0, size - LEDGER_TAIL_BYTES)
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    const lines = buf.toString('utf8').split('\n')
    if (start > 0) lines.shift()
    for (let i = lines.length - 1; i >= 0; i--) {
      let row
      try { row = JSON.parse(lines[i]) } catch { continue }
      if (row?.event === 'session' && row.terminal === address && typeof row.transcript === 'string' && row.transcript) return row.transcript
    }
  } catch {} finally { if (fd !== undefined) closeSync(fd) }
  return null
}

/** The first `max` lines of a file (for a Codex or omp session record), or []. */
function headLines(path, max = 8, bytes = 64 * 1024) {
  let fd
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(bytes)
    const n = readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, n).toString('utf8').split('\n').slice(0, max)
  } catch { return [] } finally { if (fd !== undefined) closeSync(fd) }
}

/** Whether a Codex rollout or omp session file records `cwd` as its working folder. */
function recordsCwd(agent, path, cwd) {
  for (const l of headLines(path)) {
    let r
    try { r = JSON.parse(l) } catch { continue }
    if (agent === 'codex' && r?.type === 'session_meta') return r.payload?.cwd === cwd
    if (agent === 'omp' && r?.type === 'session') return r.cwd === cwd
  }
  return false
}

/** *.jsonl files directly in `dir` modified at or after `since` (ms), as full paths. */
function freshIn(dir, since) {
  let names
  try { names = readdirSync(dir) } catch { return [] }
  const out = []
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue
    try {
      const s = statSync(join(dir, n))
      if (s.isFile() && s.mtimeMs >= since) out.push(join(dir, n))
    } catch {}
  }
  return out
}

/** Codex's dated folders that can hold a rollout started at or after `since`, up to `now`. */
function codexDays(home, since, now) {
  const days = []
  // A day either side covers a local date that differs from UTC.
  for (let t = since - 86_400_000; t <= now + 86_400_000; t += 86_400_000) {
    const d = new Date(t)
    const p = (n) => String(n).padStart(2, '0')
    days.push(join(home, TRANSCRIPT_FOLDERS.codex, String(d.getFullYear()), p(d.getMonth() + 1), p(d.getDate())))
  }
  return [...new Set(days)]
}

/**
 * Discovery on this computer: the candidates for a pane with no label.
 * @returns {string[]}
 */
export function discoverCandidates(agent, { cwd, created, home, now = Date.now() }) {
  if (agent === 'claude') return freshIn(join(home, TRANSCRIPT_FOLDERS.claude, claudeSlug(cwd)), created)
  if (agent === 'omp') return freshIn(join(home, TRANSCRIPT_FOLDERS.omp, ompSlug(cwd, home)), created).filter((p) => recordsCwd('omp', p, cwd))
  if (agent === 'codex') return codexDays(home, created, now).flatMap((d) => freshIn(d, created)).filter((p) => recordsCwd('codex', p, cwd))
  return []
}

/**
 * @typedef {{ agent: string | null, source: 'label' | 'ledger' | 'derived' | 'discovered' | 'none',
 *   local?: string, remote?: { on: string, path: string }, reason?: string }} Found
 */

/**
 * Where terminal `t`'s transcript is.
 * @param {any} terminal              herdr-core's Terminal (address, labels, cwd, created_ms, status)
 * @param {{ home: string, appHome?: string, siblings?: number, now?: number,
 *   log?: (line: string) => void, refused?: Set<string> }} options
 *   home: this computer's home; siblings: other live panes here with the same agent and cwd
 *   (discovery is then skipped); refused: folders already logged, shared by the caller.
 * @returns {Found}
 */
export function findTranscript(terminal, { home, appHome, siblings = 0, now = Date.now(), log = () => {}, refused = new Set() }) {
  const agent = agentOf(terminal)
  if (!agent) return { agent, source: 'none', reason: 'no-decoder' }
  const { machine } = addressParts(terminal.address)
  const labels = terminal.labels ?? {}
  const check = (path) => {
    const r = machine ? remotePath(agent, path) : localTranscriptPath(agent, path, home)
    if (!r.ok) {
      const key = `${r.folder ?? agent}:${r.reason}`
      if (!refused.has(key)) { refused.add(key); log(`chat: a transcript path was refused (${r.reason}) for ${r.folder ?? agent}`) }
      return null
    }
    return machine ? { remote: { on: machine, path: r.path } } : { local: r.path }
  }

  const label = labels[TRANSCRIPT_LABEL]
  if (typeof label === 'string' && label) {
    const r = check(label)
    if (r) return { agent, source: 'label', ...r }
  }
  if (!machine) {
    const row = ledgerTranscript(appHome, terminal.address)
    if (row) {
      const r = check(row)
      if (r) return { agent, source: 'ledger', ...r }
    }
  }
  const session = labels[SESSION_LABEL]
  if (agent === 'claude' && typeof session === 'string' && SESSION_ID.test(session) && typeof terminal.cwd === 'string') {
    const rel = `${TRANSCRIPT_FOLDERS.claude}/${claudeSlug(terminal.cwd)}/${session}.jsonl`
    const r = check(machine ? rel : join(home, rel))
    if (r) return { agent, source: 'derived', ...r }
  }
  if (machine) return { agent, source: 'none', reason: 'remote-unlabelled' }
  if (siblings > 0) return { agent, source: 'none', reason: 'shared-folder' }
  if (typeof terminal.cwd !== 'string') return { agent, source: 'none', reason: 'no-cwd' }
  // Without when the pane started, every file would look fresh: discovery would be a guess.
  const created = terminal.created_ms
  if (typeof created !== 'number' || !Number.isFinite(created) || created <= 0) return { agent, source: 'none', reason: 'no-start' }
  const found = discoverCandidates(agent, { cwd: terminal.cwd, created, home, now })
  if (found.length !== 1) return { agent, source: 'none', reason: found.length ? 'ambiguous' : 'not-found' }
  const r = check(found[0])
  return r ? { agent, source: 'discovered', ...r } : { agent, source: 'none', reason: 'refused' }
}
