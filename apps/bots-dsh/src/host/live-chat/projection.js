// One watched terminal as chat rows, read side only (RFC 0015 delivery 3a). Ours. It finds the
// transcript (find.js), tails it (tail.js), decodes and ranks it into rows (rows.js), follows
// herdr-core's status (status.js) and fills the turn in progress from the screen (screen.js).
// It holds no state on disk: everything can be read again. Sending, approvals and interrupt are
// delivery 3b, which wraps this in the engine API both clients call.
//
// Events to listeners (never a path, never logged):
//   { type: 'rows', rows }      transcript rows appended (a "new session" divider included)
//   { type: 'screen', rows }    the screen rows now shown for the turn in progress ([] once covered)
//   { type: 'status', status }  herdr-core's status changed (statusOf)
//   { type: 'source', source, agent, reason }  where rows come from: label, ledger, derived,
//                               discovered, or none (screen only, with why)
//   { type: 'gone' } | { type: 'offline' }     the terminal ended, or herdr-core went away
import { addressParts } from './hc.js'
import { agentOf, findTranscript } from './find.js'
import { localTranscriptPath } from './folder-rule.js'
import { statusOf } from './status.js'
import { LocalTail, RemoteTail, readLocalLines } from './tail.js'
import { KEEP_ROWS, RowStore, tokensFromLine } from './rows.js'
import { screenMessages } from './screen.js'
import { decodeClaudeTranscriptLine } from './decode-claude.js'
import { decodeCodexTranscriptLine } from './decode-codex.js'
import { decodeOmpTranscriptLine } from './decode-omp.js'

const DECODERS = { claude: decodeClaudeTranscriptLine, codex: decodeCodexTranscriptLine, omp: decodeOmpTranscriptLine }
const realTimers = { setTimeout, clearTimeout, setInterval, clearInterval }
const ACTIVE = new Set(['working', 'blocked'])
const ID = /^(\d+):(\d+)\.(\d+)$/
/** Lines read at first, from the end; enough for KEEP_ROWS rows. Older lines come on a backfill. */
export const WINDOW_LINES = 2 * KEEP_ROWS
/** A user message with text opens a turn (rows.js). */
const opensTurn = (m) => m?.role === 'user' && m.blocks.some((b) => b.type === 'text')

/** Order of two row ids (`<segment>:<line>.<block>`). */
export function compareIds(a, b) {
  const x = ID.exec(a)
  const y = ID.exec(b)
  if (!x || !y) return 0
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i])
  return 0
}

export class Projection {
  /**
   * @param {string} address  `t7` or `machine/t7`
   * @param {{ hc: any, hub: import('./status.js').StatusHub, home: string, appHome?: string,
   *   log?: (l: string) => void, refused?: Set<string>, timers?: typeof realTimers,
   *   screenMs?: number, keep?: number, pollMs?: number, watch?: any, now?: () => number, relocateMs?: number,
   *   window?: number }} options
   *   relocateMs: with no transcript yet, how often a status event may look again (labels always do)
   */
  constructor(address, { hc, hub, home, appHome, log = () => {}, refused = new Set(), timers = realTimers, screenMs = 2000, keep = KEEP_ROWS, pollMs, watch, now = Date.now, relocateMs = 5000, window = WINDOW_LINES }) {
    Object.assign(this, { address, hc, hub, home, appHome, log, refused, timers, screenMs, pollMs, watch, now, relocateMs, window })
    this.lastLocate = -Infinity
    this.machine = addressParts(address).machine
    this.store = new RowStore({ keep })
    this.listeners = new Set()
    this.terminal = null
    this.status = statusOf(null)
    this.found = { source: 'none', agent: null, reason: 'not-yet' }
    this.tail = null
    this.tailKey = null
    /** segment -> { agent, tail, remote, gone } (for backfill) */
    this.segments = new Map()
    /** segment -> [[line, turn]]: where each turn starts, for backfilled rows */
    this.turnStarts = new Map()
    this.screenDirty = true
    this.readingScreen = false
    this.stopped = false
  }

  on(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  emit(e) { for (const l of [...this.listeners]) { try { l(e) } catch {} } }

  start() {
    this.unwatch = this.hub.watch(this.address, (e) => this.onHub(e))
    this.screenTimer = this.timers.setInterval(() => { this.screenTick() }, this.screenMs)
    this.screenTimer.unref?.()
  }

  async stop() {
    this.stopped = true
    this.unwatch?.()
    this.timers.clearInterval(this.screenTimer)
    await this.tail?.stop()
  }

  /** Rows held after a cursor (a row id), or null when the cursor is no longer held. */
  rows(after) { return this.store.after(after) }
  /** The screen rows shown now. */
  screen() { return this.store.screen.slice() }
  /** Tool calls the transcript has not answered yet (for the approval guard, delivery 3b). */
  openCalls() { return this.store.openCalls() }

  onHub(e) {
    if (this.stopped) return
    if (e.type !== 'terminal') { this.emit({ type: e.type }); return }
    const before = this.status
    this.terminal = e.terminal
    this.status = statusOf(e.terminal)
    const look = e.change === 'snapshot' || e.change === 'labels' || e.change === 'restarted' || e.change === 'created'
    if (look || (this.tailKey === null && this.now() - this.lastLocate >= this.relocateMs)) this.locate()
    const changed = ['state', 'kind', 'msg', 'turn'].some((k) => before[k] !== this.status[k])
    if (changed) {
      this.screenDirty = true
      this.emit({ type: 'status', status: this.status })
      if (this.tail instanceof RemoteTail) this.tail.tick()
    }
  }

  siblings(agent) {
    const t = this.terminal
    return this.hub.all().filter((o) => o.address !== this.address && addressParts(o.address).machine === this.machine
      && o.state !== 'finished' && o.cwd === t.cwd && agentOf(o) === agent).length
  }

  locate() {
    const t = this.terminal
    if (!t) return
    this.lastLocate = this.now()
    const agent = agentOf(t)
    const found = findTranscript(t, { home: this.home, appHome: this.appHome, siblings: agent ? this.siblings(agent) : 0, log: this.log, refused: this.refused })
    const key = found.local ?? (found.remote ? `${found.remote.on}\u0000${found.remote.path}` : null)
    const next = { source: found.source, agent: found.agent, reason: found.reason ?? null }
    if (next.source !== this.found.source || next.reason !== this.found.reason || next.agent !== this.found.agent) {
      this.found = next
      this.emit({ type: 'source', ...next })
    }
    if (key === null || key === this.tailKey) return
    const old = this.tail
    this.tail = null
    old?.stop()
    if (this.store.rows.length) this.emit({ type: 'rows', rows: [this.store.newSegment()] })
    this.tailKey = key
    this.ready = this.startTail(agent, found)
  }

  startTail(agent, found) {
    let tail
    const onLines = (lines) => this.onLines(tail, agent, lines)
    const onReset = () => this.onReset(tail, agent)
    if (found.local) {
      tail = new LocalTail(found.local, {
        onLines, onReset,
        // Asked at every open; the handle must be the real path it returns (tail.js openAdmitted).
        admit: (p) => { const r = localTranscriptPath(agent, p, this.home); return r.ok ? r.path : null },
        window: this.window,
        ...(this.pollMs ? { pollMs: this.pollMs } : {}), ...(this.watch !== undefined ? { watch: this.watch } : {}), timers: this.timers
      })
    } else {
      tail = new RemoteTail({ hc: this.hc, on: found.remote.on, path: found.remote.path, onLines, onReset, working: () => ACTIVE.has(this.status.state), window: this.window, timers: this.timers })
    }
    this.tail = tail
    this.segments.set(this.store.segment, { agent, tail, remote: !found.local, gone: false })
    this.turnStarts.set(this.store.segment, [])
    return tail.start()
  }

  onReset(tail, agent) {
    if (tail !== this.tail) return
    const old = this.segments.get(this.store.segment)
    if (old) old.gone = true
    this.emit({ type: 'rows', rows: [this.store.newSegment()] })
    this.segments.set(this.store.segment, { agent, tail, remote: tail instanceof RemoteTail, gone: false })
    this.turnStarts.set(this.store.segment, [])
  }

  onLines(tail, agent, lines) {
    if (tail !== this.tail || this.stopped) return
    const seg = this.store.segment
    const starts = this.turnStarts.get(seg)
    const hadScreen = this.store.screen.length > 0
    const added = []
    for (const { n, text } of lines) {
      if (text === null) continue
      const message = DECODERS[agent](text, `${seg}:${n}`)
      const tokens = tokensFromLine(agent, text)
      if (!message && !tokens) continue
      const turn = this.store.turn
      added.push(...this.store.addMessage(message ?? { id: `${seg}:${n}`, role: 'assistant', blocks: [], timestamp: null, source: 'transcript' }, { line: n, tokens }))
      if (this.store.turn !== turn) starts.push([n, this.store.turn])
    }
    if (added.length) this.emit({ type: 'rows', rows: added })
    if (hadScreen && !this.store.screen.length) this.emit({ type: 'screen', rows: [] })
  }

  /** Read the screen when it can add something: no transcript, or the turn not covered yet. */
  async screenTick() {
    if (this.stopped || !this.terminal || this.readingScreen) return
    const needed = !this.tail || !this.store.covered
    if (!needed || !(ACTIVE.has(this.status.state) || this.screenDirty)) return
    this.screenDirty = false
    this.readingScreen = true
    try {
      let read = null
      try { read = await this.hc.call('terminal.read', { terminal: this.address }) } catch {}
      if (this.stopped) return
      const rows = this.store.setScreen(screenMessages(read))
      if (rows) this.emit({ type: 'screen', rows })
    } finally { this.readingScreen = false }
  }

  /** Read `from`..`to` of a segment's file again (local through the folder rule, or remote). */
  readSegment(entry, from, to) {
    return entry.remote ? entry.tail.readLines(from, to) : readLocalLines(entry.tail, from, to)
  }

  /**
   * The turn of a row at `line`. In the window tailed live, from where its turns started. Before
   * it (rows only a backfill reads), counted back from the window: the last turn opened before it
   * is 0, the one before -1, and so on, from user rows found by scanning those lines (ensureOlder).
   */
  turnAt(seg, entry, line) {
    if (line >= entry.tail.first) {
      let turn = 0
      for (const [l, t] of this.turnStarts.get(seg) ?? []) { if (l <= line) turn = t; else break }
      return turn
    }
    const back = entry.older.users.filter((u) => u > line).length
    return back ? -back : 0
  }

  /** Scan back from the window to `from`, noting the lines where a turn opens. */
  async ensureOlder(entry, from) {
    entry.older ??= { from: entry.tail.first, users: [] }
    while (entry.older.from > from) {
      const lo = Math.max(1, from, entry.older.from - 500)
      const lines = await this.readSegment(entry, lo, entry.older.from - 1)
      if (!lines.length) break
      for (const { n, text } of lines) {
        if (text !== null && opensTurn(DECODERS[entry.agent](text, `${n}`))) entry.older.users.push(n)
      }
      entry.older.from = lo
    }
  }

  /**
   * Up to `limit` rows before the row `before`, read again from the transcript (they are not
   * kept): for scrolling back past what is held. [] when that file is no longer the one tailed.
   */
  async backfill(before, limit = 50) {
    const m = ID.exec(before ?? '')
    if (!m || limit < 1) return []
    const seg = Number(m[1])
    const line = Number(m[2])
    const entry = this.segments.get(seg)
    if (!entry || entry.gone) return []
    const out = []
    let to = line
    while (to >= 1 && out.length < limit) {
      const from = Math.max(1, to - Math.max(limit, 20) + 1)
      if (from < entry.tail.first) await this.ensureOlder(entry, from)
      const lines = await this.readSegment(entry, from, to)
      if (!lines.length) break
      const scratch = new RowStore({ keep: Infinity })
      scratch.segment = seg
      const rows = []
      for (const { n, text } of lines) {
        if (text === null) continue
        const msg = DECODERS[entry.agent](text, `${seg}:${n}`)
        const tokens = tokensFromLine(entry.agent, text)
        if (!msg && !tokens) continue
        const turn = this.turnAt(seg, entry, n)
        for (const r of scratch.addMessage(msg ?? { id: `${seg}:${n}`, role: 'assistant', blocks: [], timestamp: null, source: 'transcript' }, { line: n, tokens })) {
          rows.push({ ...r, turn })
        }
      }
      out.unshift(...rows.filter((r) => compareIds(r.id, before) < 0))
      to = from - 1
    }
    return out.slice(-limit)
  }
}
