// From decoded transcript messages and screen turns to RFC 0015's rows ("The row model",
// "Ranking and dedupe"). Ours.
//
// - A row id is `<segment>:<line>.<block>`: stable across re-reads, ordered, and never a path
//   (ids travel to the phone). A segment is one transcript file; a new session in the same pane
//   starts the next one, behind a "new session" divider.
// - A turn runs from a user message to the next one. Screen rows belong to the turn in progress,
//   are replaced on every screen read, and are dropped once transcript rows (beyond the user's
//   own message) cover that turn.
// - A tool result points at its call's row: by the provider's call id, else the oldest call still
//   open. The calls still open are what an approval is checked against (delivery 3b).
// - Rows hold previews: a tool call's input and a result's output are cut (clients show "open in
//   terminal"). Text is kept whole here; the phone route cuts it (delivery 4). Nothing is logged.
import { NATIVE_CHAT_INTERRUPTED_STATUS_TEXT } from './types.js'

/** @typedef {import('./types.js').NativeChatMessage} NativeChatMessage */
/** @typedef {import('./types.js').Row} Row */

export const INPUT_PREVIEW = 2000
export const OUTPUT_PREVIEW = 8 * 1024
export const SUMMARY_MAX = 200
/** Transcript rows kept in memory per terminal (RFC 0015, "Reconnect"). */
export const KEEP_ROWS = 500

/** @param {unknown} value @param {number} max */
export function preview(value, max) {
  let text
  if (typeof value === 'string') text = value
  else if (value === undefined || value === null) text = ''
  else { try { text = JSON.stringify(value) } catch { text = String(value) } }
  return text.length > max ? `${text.slice(0, max)}…` : text
}

const oneLine = (s) => s.replace(/\s+/g, ' ').trim()

/** A short line naming what a tool call does: its command, file or first string argument. */
export function toolSummary(name, input) {
  let value = input
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object') value = parsed } catch {}
  }
  let s = ''
  if (typeof value === 'string') s = value.split('\n', 1)[0]
  else if (value && typeof value === 'object') {
    const v = /** @type {Record<string, unknown>} */ (value)
    const pick = v.command ?? v.cmd ?? v.file_path ?? v.path ?? v.pattern ?? v.url ?? v.query ?? v.description
    if (Array.isArray(pick)) s = pick.filter((x) => typeof x === 'string').join(' ')
    else if (typeof pick === 'string') s = pick
    else s = Object.values(v).find((x) => typeof x === 'string') ?? ''
  }
  return preview(oneLine(String(s)), SUMMARY_MAX)
}

const count = (n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0)

/**
 * Token counts a raw transcript line carries, where the decoder does not keep them (Claude's
 * message.usage, Codex's token_count event). No prices.
 * @returns {{ input: number, output: number, cache: number, context: number } | null}
 */
export function tokensFromLine(agent, line) {
  if (typeof line !== 'string' || line.length > 1_000_000 || !line.includes('token')) return null
  let r
  try { r = JSON.parse(line) } catch { return null }
  if (agent === 'claude' && r?.type === 'assistant') {
    const u = r.message?.usage
    if (!u || typeof u !== 'object') return null
    const cache = count(u.cache_read_input_tokens) + count(u.cache_creation_input_tokens)
    return { input: count(u.input_tokens), output: count(u.output_tokens), cache, context: count(u.input_tokens) + cache }
  }
  if (agent === 'codex' && r?.type === 'event_msg' && r.payload?.type === 'token_count') {
    const u = r.payload.info?.last_token_usage
    if (!u || typeof u !== 'object') return null
    return { input: count(u.input_tokens), output: count(u.output_tokens), cache: count(u.cached_input_tokens), context: count(u.input_tokens) }
  }
  return null
}

const imageText = (b) => (typeof b.url === 'string' && /^https?:\/\//i.test(b.url) ? `[image](${b.url})` : '[image]')

export class RowStore {
  constructor({ keep = KEEP_ROWS } = {}) {
    this.keep = keep
    /** @type {Row[]} */
    this.rows = []
    /** @type {Row[]} */
    this.screen = []
    this.segment = 1
    this.turn = 0
    this.covered = false
    /** @type {Map<string, string>} call id -> row id, this segment */
    this.byCallId = new Map()
    /** @type {{ id: string, tool: string, input: unknown, callId?: string }[]} */
    this.open = []
  }

  push(row) {
    this.rows.push(row)
    if (this.rows.length > this.keep) this.rows.splice(0, this.rows.length - this.keep)
    return row
  }

  /** The tool calls with no result yet, oldest first (for the approval guard, delivery 3b). */
  openCalls() { return this.open.map(({ id, tool, input }) => ({ id, tool, input })) }

  /** A new transcript file in the same pane: the next segment, behind a divider. */
  newSegment(at = null) {
    this.segment += 1
    this.byCallId.clear()
    this.open = []
    return this.push({ id: `${this.segment}:0.0`, segment: this.segment, turn: this.turn, at, source: 'status', kind: 'status', state: 'new-session', msg: '' })
  }

  /**
   * The rows of one decoded message at transcript line `line`, appended.
   * @param {NativeChatMessage} message
   * @param {{ line: number, tokens?: { input: number, output: number, cache: number, context: number } | null }} where
   * @returns {Row[]} the rows added
   */
  addMessage(message, { line, tokens = null }) {
    const added = []
    const base = { segment: this.segment, at: message.timestamp ?? null, source: 'transcript' }
    let i = 0
    const row = (fields) => { const r = this.push({ id: `${this.segment}:${line}.${i++}`, ...base, turn: this.turn, ...fields }); added.push(r); return r }

    if (message.role === 'user' && message.blocks.some((b) => b.type === 'text')) {
      this.turn += 1
      this.covered = false
    }
    if (message.role === 'system') {
      for (const b of message.blocks) {
        if (b.type !== 'text') continue
        const interrupted = b.text === NATIVE_CHAT_INTERRUPTED_STATUS_TEXT
        if (interrupted) this.open = []
        row({ kind: 'status', state: interrupted ? 'interrupted' : b.presentation === 'compaction' ? 'compacted' : 'notice', msg: b.text })
      }
    } else {
      // Text rows are the user's and the assistant's only: reasoning is not shown (no row kind).
      for (const b of message.blocks) {
        if (b.type === 'text' && (message.role === 'user' || message.role === 'assistant')) row({ kind: 'text', role: message.role, text: b.text })
        else if (b.type === 'image-ref' && (message.role === 'user' || message.role === 'assistant')) row({ kind: 'text', role: message.role, text: imageText(b) })
        else if (b.type === 'tool-call') {
          const r = row({ kind: 'tool-call', tool: b.name, summary: toolSummary(b.name, b.input), input: preview(b.input, INPUT_PREVIEW) })
          if (b.callId) this.byCallId.set(b.callId, r.id)
          this.open.push({ id: r.id, tool: b.name, input: b.input, callId: b.callId })
        } else if (b.type === 'tool-result') {
          let call = b.callId ? this.byCallId.get(b.callId) ?? null : null
          const at = call ? this.open.findIndex((o) => o.id === call) : this.open.findIndex((o) => !o.callId)
          if (at >= 0) { call ??= this.open[at].id; this.open.splice(at, 1) }
          row({ kind: 'tool-result', call, ok: b.isError !== true, output: preview(b.output, OUTPUT_PREVIEW) })
        }
      }
    }
    const usage = message.usage
    const t = tokens ?? (usage ? {
      input: usage.inputTokens, output: usage.outputTokens,
      cache: usage.cacheReadInputTokens + usage.cacheCreationInputTokens,
      context: usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens
    } : null)
    if (t) row({ kind: 'tokens', ...t })
    // Anything beyond the user's own message covers the turn: its screen rows go.
    if (added.some((r) => !(r.kind === 'text' && r.role === 'user'))) { this.covered = true; this.screen = [] }
    return added
  }

  /**
   * Replace the screen rows for the turn in progress. Ignored once transcript rows cover it.
   * @param {NativeChatMessage[]} messages  screen turns (screen.js)
   * @returns {Row[] | null} the screen rows now shown, or null when nothing changed
   */
  setScreen(messages) {
    const next = this.covered ? [] : messages.flatMap((m, i) => m.blocks
      .filter((b) => b.type === 'text')
      .map((b) => ({ id: `screen:${i}`, segment: this.segment, turn: this.turn, at: null, source: 'screen', kind: 'text', role: m.role === 'user' ? 'user' : 'assistant', text: b.text })))
    const same = next.length === this.screen.length && next.every((r, i) => r.text === this.screen[i].text && r.role === this.screen[i].role)
    if (same) return null
    this.screen = next
    return next
  }

  /**
   * Rows after the one named by `cursor` (a row id), or null when the cursor is no longer held.
   * @param {string | null | undefined} cursor
   */
  after(cursor) {
    if (!cursor) return this.rows.slice()
    const at = this.rows.findIndex((r) => r.id === cursor)
    return at === -1 ? null : this.rows.slice(at + 1)
  }
}
