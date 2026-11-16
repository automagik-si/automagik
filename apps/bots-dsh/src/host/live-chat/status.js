// herdr-core's view of each watched terminal (RFC 0015, "Status and hooks"). Ours. One
// events.subscribe for every terminal the process watches, kept as a fresh copy of each
// terminal's facts: status.state (idle, working, done, blocked, error), status.kind while blocked
// (permission, question, auth), status.msg, turn, title, labels. The status is the program's own
// report: a gate, never proof of what a dialog asks.
//
// A `missed` snapshot replaces everything (events at or below its seq are dropped); a subscription
// that goes quiet past the heartbeat (15 s) for `staleMs`, or ends, is opened again. It stays open
// while anything watches a terminal or holds the hub (the engine does, for its list).

const realTimers = { setTimeout, clearTimeout, setInterval, clearInterval }
/** Event data fields that are not terminal facts. */
const NOT_FACTS = new Set(['records', 'reported'])
/** How long ready() waits for the first snapshot before answering with what it has. */
export const READY_MS = 3_000

/**
 * The chat's status fields from a herdr-core Terminal.
 * @returns {{ state: string, kind: string | null, msg: string, turn: number, title: string, app: string | null }}
 */
export function statusOf(terminal) {
  const s = terminal?.status ?? null
  return {
    state: typeof s?.state === 'string' ? s.state : terminal?.state === 'finished' ? 'done' : 'idle',
    kind: typeof s?.kind === 'string' ? s.kind : null,
    msg: typeof s?.msg === 'string' ? s.msg : '',
    turn: Number.isInteger(terminal?.turn) ? terminal.turn : 0,
    title: typeof terminal?.title === 'string' ? terminal.title : '',
    app: typeof s?.app === 'string' ? s.app : null
  }
}

export class StatusHub {
  /**
   * @param {{ subscribe(p: object, on: (m: any) => void): { close(): void } }} hc
   * @param {{ timers?: typeof realTimers, now?: () => number, staleMs?: number, retryMs?: number }} [options]
   */
  constructor(hc, { timers = realTimers, now = Date.now, staleMs = 45_000, retryMs = 2_000 } = {}) {
    Object.assign(this, { hc, timers, now, staleMs, retryMs })
    /** @type {Map<string, any>} */
    this.terminals = new Map()
    /** @type {Map<string, Set<(e: any) => void>>} */
    this.listeners = new Map()
    this.sub = null
    this.floor = 0
    this.seen = 0
    this.closed = false
    this.holds = 0
    /** A snapshot has arrived since the hub was made. */
    this.fresh = false
    /** @type {Set<() => void>} */
    this.waiting = new Set()
  }

  /**
   * Resolves once the first snapshot is in (at once if it is), or after `ms`: a just-made engine's
   * list waits for herdr-core's answer, and never hangs on an hc that does not give one.
   * @returns {Promise<void>}
   */
  ready(ms = READY_MS) {
    if (this.fresh || this.closed || !this.wanted()) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => { this.timers.clearTimeout(timer); this.waiting.delete(done); resolve() }
      const timer = this.timers.setTimeout(done, ms)
      timer?.unref?.()
      this.waiting.add(done)
    })
  }

  wake() { for (const done of [...this.waiting]) done() }

  /** Something still needs the subscription: a watcher, or a hold. */
  wanted() { return this.listeners.size > 0 || this.holds > 0 }

  /**
   * Keep the subscription open with no terminal watched, so all() stays current (the engine's
   * list, before any client watches and after the last one leaves).
   * @returns {() => void} release
   */
  hold() {
    this.holds++
    if (!this.sub) this.open()
    let held = true
    return () => {
      if (!held) return
      held = false
      this.holds--
      if (!this.wanted()) this.shut()
    }
  }

  /**
   * Follow one terminal. The listener gets { type: 'terminal', terminal, change } (change: the
   * event kind, or 'snapshot'), { type: 'gone' } when herdr-core no longer lists it, and
   * { type: 'offline' } when the subscription ends (until it is back).
   * @returns {() => void} stop following
   */
  watch(address, listener) {
    let set = this.listeners.get(address)
    if (!set) this.listeners.set(address, (set = new Set()))
    set.add(listener)
    if (!this.sub) this.open()
    else if (this.terminals.has(address)) queueMicrotask(() => set.has(listener) && listener({ type: 'terminal', terminal: this.terminals.get(address), change: 'snapshot' }))
    return () => {
      set.delete(listener)
      if (!set.size) this.listeners.delete(address)
      if (!this.wanted()) this.shut()
    }
  }

  /** The latest facts for a watched terminal, if known. */
  current(address) { return this.terminals.get(address) }

  /** Every terminal in the latest snapshot (for siblings: other panes in one folder). */
  all() { return [...this.terminals.values()] }

  close() { this.closed = true; this.shut(); this.wake() }

  /** A listener that throws never stops the others, or the hub. */
  emit(address, e) { for (const l of [...(this.listeners.get(address) ?? [])]) { try { l(e) } catch {} } }

  open() {
    if (this.closed) return
    this.seen = this.now()
    this.sub = this.hc.subscribe({}, (m) => this.onMessage(m))
    this.timers.clearInterval(this.watchdog)
    this.watchdog = this.timers.setInterval(() => {
      if (this.sub && this.now() - this.seen > this.staleMs) this.reopen()
    }, Math.max(1000, Math.floor(this.staleMs / 3)))
    this.watchdog.unref?.()
  }

  reopen() {
    try { this.sub?.close() } catch {}
    this.sub = null
    if (this.wanted()) this.open()
  }

  shut() {
    this.timers.clearInterval(this.watchdog)
    this.timers.clearTimeout(this.retry)
    try { this.sub?.close() } catch {}
    this.sub = null
  }

  onMessage(m) {
    this.seen = this.now()
    if (m.type === 'snapshot' || m.type === 'missed') {
      this.floor = m.seq ?? 0
      this.terminals = new Map((m.terminals ?? []).filter((t) => typeof t?.address === 'string').map((t) => [t.address, t]))
      this.fresh = true
      this.wake()
      for (const address of this.listeners.keys()) {
        const t = this.terminals.get(address)
        this.emit(address, t ? { type: 'terminal', terminal: t, change: 'snapshot' } : { type: 'gone' })
      }
      return
    }
    if (m.type === 'event') {
      if (typeof m.seq === 'number' && m.seq <= this.floor) return
      if (typeof m.seq === 'number') this.floor = m.seq
      if (typeof m.terminal !== 'string') return
      if (m.kind === 'removed') {
        this.terminals.delete(m.terminal)
        this.emit(m.terminal, { type: 'gone' })
        return
      }
      const data = m.data && typeof m.data === 'object' ? m.data : {}
      let t = this.terminals.get(m.terminal)
      if (!t) {
        if (m.kind !== 'created' || typeof data.address !== 'string') return
        this.terminals.set(m.terminal, (t = { ...data }))
      } else {
        for (const [k, v] of Object.entries(data)) if (!NOT_FACTS.has(k)) t[k] = v
      }
      this.emit(m.terminal, { type: 'terminal', terminal: t, change: m.kind })
      return
    }
    if (m.type === 'closed') {
      this.sub = null
      for (const address of this.listeners.keys()) this.emit(address, { type: 'offline' })
      if (this.wanted() && !this.closed) {
        this.retry = this.timers.setTimeout(() => { if (!this.sub && this.wanted()) this.open() }, this.retryMs)
        this.retry.unref?.()
      }
    }
  }
}
