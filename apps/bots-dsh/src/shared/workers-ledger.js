// The workers ledger's read-only fold (RFC 0030 delivery 1): which workers a Bot started,
// under it. `<app home>/automagik-herdr/workers.jsonl`, beside the attach ledger and in the
// same format: one JSON object per line, one O_APPEND write each, the owner's file.
//
// The pack owns the rows (`herdr/mods/am-sidebar/workers.js`, the CLI writes them; am/ holds
// the byte copy). This module only reads what the Code side needs, and it never writes: a
// `start` row of `kind: "worker"` opens a launch, keyed by (`core`, `terminal`, `created_ms`)
// because herdr-core reuses terminal ids; an `end` row closes that key; a `session` row names
// the agent session a terminal now runs. A launch left open is a worker the Bot started whose
// terminal has not ended, and its `botId` is the Bot it belongs to (`lead` is the project lead
// the row names, which the tree does not need twice).
//
// Pure: no `node:` import, no herdr runtime, so the host and its tests share it. Anything it
// cannot use is skipped, never guessed.
import { attachKey } from './attach-ledger.js'

export const WORKERS_FILE = 'automagik-herdr/workers.jsonl'
/** The largest ledger this reader takes: a runaway file is refused, never read into memory. */
export const MAX_LEDGER_BYTES = 64 * 1024 * 1024

/** `$HOME`'s app home plus the ledger, the same `automagik-herdr/` folder the attach ledger uses. */
export const workersPath = (appHome) => `${String(appHome).replace(/\/+$/, '')}/${WORKERS_FILE}`

const BOT_SHAPE = /^(b-[a-z2-7]{10}|session-[A-Za-z0-9._-]+)$/
const TERMINAL_SHAPE = /^[A-Za-z0-9._-]+$/
const AGENT_SHAPE = /^[A-Za-z0-9._-]{1,40}$/

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value, max = 300) => (typeof value === 'string' && value !== '' && value.length <= max ? value : null)

/** A launch's key: the attach ledger's own (`core`, `terminal`, `created_ms`), or null. */
export const launchKey = (row) => {
  if (!isObject(row)) return null
  if (typeof row.core !== 'string' || row.core === '') return null
  if (typeof row.terminal !== 'string' || !TERMINAL_SHAPE.test(row.terminal)) return null
  if (!Number.isSafeInteger(row.created_ms)) return null
  return attachKey(row)
}

/** The rows of a ledger's text as far as this reader can use them: { rows, skipped }. */
export function readWorkers(raw) {
  const rows = []
  let skipped = 0
  for (const line of String(raw ?? '').split('\n')) {
    if (!line.trim()) continue
    let row = null
    try { row = JSON.parse(line) } catch { row = null }
    if (!isObject(row) || typeof row.event !== 'string') { skipped += 1; continue }
    rows.push(row)
  }
  return { rows, skipped }
}

/**
 * The open worker launches of `start` rows, as Map key -> worker. A worker is
 * { key, terminal, botId, lead, role, agent, model, branch, project, worktree, created_ms,
 *   core, at, session } (`session` from a later session row, when one names this launch).
 * An end row removes its key; rows with no key, a foreign shape or no Bot are skipped.
 */
export function foldWorkers(rows) {
  const open = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = launchKey(row)
    if (row.event === 'end') {
      if (key) open.delete(key)
      continue
    }
    if (row.event === 'start' && row.kind === 'worker') {
      if (!key || typeof row.botId !== 'string' || !BOT_SHAPE.test(row.botId)) continue
      open.set(key, {
        key,
        terminal: row.terminal,
        botId: row.botId,
        lead: text(row.lead, 80),
        role: text(row.role, 40),
        agent: text(row.agent, 40),
        model: text(row.model, 120),
        branch: text(row.branch, 300),
        project: text(row.project, 1024),
        worktree: text(row.worktree, 1024),
        created_ms: row.created_ms,
        core: row.core,
        at: text(row.at, 40),
        session: null,
      })
      continue
    }
    if (row.event === 'session' && typeof row.session === 'string') {
      // A session row names its launch when the writer knew the key; older rows name only
      // the terminal, so a worker still open on that terminal takes it.
      const named = key ? open.get(key) : undefined
      if (named) { named.session = text(row.session, 200) ?? named.session; continue }
      if (typeof row.terminal !== 'string') continue
      for (const worker of open.values()) {
        if (worker.terminal !== row.terminal) continue
        if (key && worker.key !== key) continue
        worker.session = text(row.session, 200) ?? worker.session
      }
    }
  }
  return open
}

/** A Bot's workers, in the order the ledger opened them (oldest first). */
export const workersOf = (open, botId) => [...open.values()]
  .filter(worker => worker.botId === botId)
  .sort((a, b) => (a.created_ms - b.created_ms) || a.terminal.localeCompare(b.terminal))

/** What a worker's terminal says it is doing: the tree's four words, never a fifth. */
export const workerWord = (terminal) => {
  if (!terminal) return 'not-running'
  if (terminal.status === 'blocked') return 'needs-you'
  if (terminal.status === 'working') return 'working'
  if (terminal.status === 'error') return 'needs-you'
  return 'idle'
}

/** The agent a worker shows, from its ledger row (an hc template names none: it is a launch detail). */
export const workerAgent = (worker) => (AGENT_SHAPE.test(worker?.agent ?? '') ? worker.agent : null)
