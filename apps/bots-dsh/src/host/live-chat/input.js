// What the person types in a chat, as keys in the same terminal (RFC 0015, "Input"). Ours.
//
// A message is cleaned (paste.js), then:
//   - blocked (a dialog is open): it waits, held ('dialog'); nothing forces it in;
//   - working: Claude takes it as a queued prompt ('queued'); other agents' messages wait, held
//     ('working'), since the recordings did not show them queueing;
//   - a half-typed draft in the terminal's input row, or an input row that cannot be read: held
//     ('draft' / 'no-input-row'). Send now pastes it after the draft and sends both (the oldest
//     held message only, and never with no input row in sight); without a tap it goes by itself
//     once the row is empty. The draft is never cleared or retyped;
//   - else terminal.send pastes it and presses Enter.
// herdr-core's own rules close the gaps: terminal.send refuses a blocked program (never forced),
// and `if` (when the state read was exactly idle or working) refuses a status that changed since;
// either refusal holds the message instead. No caller is passed: herdr-core would otherwise wrap
// the text as a note from that terminal. Held messages go in order, oldest first. Every attempt
// runs under one lock, so a retried id, Send now and a flush never paste the same message twice.
import { cleanChatText } from './paste.js'
import { readInput } from './dialog.js'

/** A message is at most this many bytes after cleaning (RFC 0015, "Limits"). */
export const MAX_SEND_BYTES = 32 * 1024

/**
 * @typedef {{ agent: string | null, status: { state: string }, screen: string }} Facts
 * @typedef {{ id: string, text: string, why: string }} Held
 */

export class Input {
  /**
   * @param {{ hc: any, address: string, read(): Promise<Facts> }} options
   *   read: the terminal's facts now (terminal.get and terminal.read)
   */
  constructor({ hc, address, read }) {
    Object.assign(this, { hc, address, read })
    /** @type {Held[]} */
    this.held = []
    /** id -> the answer already given, so a retried id is never typed twice */
    this.done = new Map()
    this.listeners = new Set()
    this.flushing = null
    /** Every attempt runs under one lock: never two pastes at once (send, Send now, flush). */
    this.lock = Promise.resolve()
    /** id -> the send of that id now in flight, so a second one waits for it instead of pasting. */
    this.inflight = new Map()
  }

  /** Run `fn` alone: after every attempt before it has finished. */
  serial(fn) {
    const run = this.lock.then(fn, fn)
    this.lock = run.catch(() => {})
    return run
  }

  on(l) { this.listeners.add(l); return () => this.listeners.delete(l) }
  emit(e) { for (const l of [...this.listeners]) { try { l(e) } catch {} } }

  /**
   * @param {{ text: unknown, id: string }} m
   * @returns {Promise<{ state: 'sent' | 'queued' | 'held' | 'refused', id: string, why?: string, reason?: string, text?: string }>}
   */
  send({ text, id }) {
    if (typeof id !== 'string' || !id) return Promise.resolve({ state: 'refused', id, reason: 'id' })
    if (this.inflight.has(id)) return this.inflight.get(id)
    const p = this.serial(() => this.sendNow({ text, id })).finally(() => this.inflight.delete(id))
    this.inflight.set(id, p)
    return p
  }

  async sendNow({ text, id }) {
    if (this.done.has(id)) return this.done.get(id)
    const held = this.held.find((h) => h.id === id)
    if (held) return { state: 'held', id, why: held.why }
    const clean = cleanChatText(text)
    if (!clean.ok) return { state: 'refused', id, reason: clean.reason }
    if (Buffer.byteLength(clean.text, 'utf8') > MAX_SEND_BYTES) return { state: 'refused', id, reason: 'too-long' }
    // Behind a held message: in order.
    if (this.held.length) return this.hold({ id, text: clean.text, why: 'behind' })
    return this.attempt({ id, text: clean.text })
  }

  hold(h) {
    const at = this.held.findIndex((x) => x.id === h.id)
    const changed = at === -1 || this.held[at].why !== h.why
    if (at === -1) this.held.push(h)
    else this.held[at] = h
    if (changed) this.emit({ type: 'held', id: h.id, why: h.why })
    return { state: 'held', id: h.id, why: h.why, text: h.text }
  }

  finish(id, answer, text) {
    this.held = this.held.filter((h) => h.id !== id)
    this.done.set(id, answer)
    if (this.done.size > 1000) this.done.delete(this.done.keys().next().value)
    this.emit({ type: 'sent', ...answer, text })
    return answer
  }

  /** Try one message now. `draftOk`: Send now, after the person saw the warning. */
  async attempt({ id, text }, { draftOk = false } = {}) {
    let facts
    try { facts = await this.read() } catch { return { state: 'refused', id, reason: 'unavailable' } }
    const { agent, status, screen } = facts
    const state = status?.state ?? null
    if (state === 'blocked') return this.hold({ id, text, why: 'dialog' })
    if (state === 'working' && agent !== 'claude') return this.hold({ id, text, why: 'working' })
    // Send now may go after a draft, never into a terminal whose input row cannot be seen.
    const row = readInput(agent, screen)
    if (!row.found) return this.hold({ id, text, why: 'no-input-row' })
    if (row.draft && !draftOk) return this.hold({ id, text, why: 'draft' })
    const params = { terminal: this.address, text, caller: null }
    if (state === 'idle' || state === 'working') params.if = state
    try {
      await this.hc.call('terminal.send', params)
    } catch (e) {
      if (e?.kind === 'blocked') return this.hold({ id, text, why: 'dialog' })
      if (e?.kind === 'status_mismatch') return this.hold({ id, text, why: 'changed' })
      return { state: 'refused', id, reason: e?.kind ?? 'unavailable' }
    }
    return this.finish(id, { state: state === 'working' ? 'queued' : 'sent', id }, text)
  }

  /**
   * Send now: the held message goes after the terminal's half-typed text, as one message (the
   * client warned first: "Sends your half-typed terminal text with it"). Nothing is cleared.
   */
  sendHeld({ id }) {
    return this.serial(async () => {
      // Read inside the lock: a flush may have sent it meanwhile.
      const h = this.held.find((x) => x.id === id)
      if (!h) return this.done.get(id) ?? { state: 'refused', id, reason: 'not-held' }
      // In order: only the oldest held message can go now.
      if (this.held[0].id !== id) return { state: 'held', id, why: h.why, reason: 'behind' }
      const answer = await this.attempt(h, { draftOk: true })
      return answer.state === 'held' || answer.state === 'refused' ? answer : { ...answer, warned: 'draft' }
    })
  }

  cancelHeld({ id }) {
    const before = this.held.length
    this.held = this.held.filter((h) => h.id !== id)
    if (this.held.length === before) return { ok: false, reason: 'not-held' }
    this.emit({ type: 'cancelled', id })
    return { ok: true }
  }

  /** Try the oldest held message again (on a status change, a screen read). One at a time. */
  flush() {
    if (this.flushing || !this.held.length) return this.flushing ?? Promise.resolve()
    this.flushing = this.serial(async () => {
      while (this.held.length) {
        const h = this.held[0]
        const answer = await this.attempt({ id: h.id, text: h.text })
        if (answer.state === 'held' || answer.state === 'refused') break
      }
    }).finally(() => { this.flushing = null })
    return this.flushing
  }

  /** Stop the agent: herdr-core's terminal.interrupt, once (esc where it reports status, else ctrl+c; never a second esc). */
  async interrupt() {
    try {
      const r = await this.hc.call('terminal.interrupt', { terminal: this.address })
      return { ok: true, outcome: r?.outcome ?? 'unknown' }
    } catch (e) { return { ok: false, reason: e?.kind ?? 'unavailable' } }
  }
}
