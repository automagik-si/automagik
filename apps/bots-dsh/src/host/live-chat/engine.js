// The chat engine: one per process, behind the one API both clients call (RFC 0015 delivery 3).
// Ours. Pocket Link's chat route (delivery 4) and the Automagik window (RFC 0014 delivery 9) use
// it; its methods mirror the route's `chat.*`.
//
// - One projection per watched terminal (projection.js), shared by every client watching it; kept
//   10 minutes after the last client leaves, then dropped (nothing is on disk).
// - send, sendHeld, cancelHeld, answer and interrupt act only for a client that watches that
//   terminal, and only on what that client's person did; they are never a tool, an automation or
//   another plugin's (RFC 0015, "Who can call the engine"). The engine never answers on its own.
// - herdr-core is reached with no caller and with HC_TERMINAL_ID removed from hc's environment
//   (chatEnv), so a message is typed as the person wrote it, not as a note from a terminal.
//
// Events to a client's listener: the projection's (rows, screen, status, source, gone, offline),
// plus { type: 'approval', row } (open, or closed with open: false), { type: 'question', row },
// { type: 'held' | 'sent' | 'cancelled', id, ... } from input.js, and { type: 'sending', id } then
// { type: 'matched', id, row } once the transcript shows the message.
import { addressParts, connectHc } from './hc.js'
import { agentOf, findTranscript } from './find.js'
import { StatusHub, statusOf } from './status.js'
import { Projection } from './projection.js'
import { Input } from './input.js'
import { answerApproval, approvalRow, approvalState } from './approve.js'
import { answerQuestion, questionRow, questionState } from './question.js'

/** How long a terminal's rows are kept after its last client leaves (RFC 0015, "Reconnect"). */
export const LINGER_MS = 10 * 60_000
/** While messages are held, how often to look whether they can go. */
export const FLUSH_MS = 2000
/** Sent messages waiting for their transcript row, per terminal; the oldest goes past this. */
export const MAX_PENDING = 100
/** Terminals an engine holds at once (watched or in their 10-minute hold). */
export const MAX_TERMINALS = 16
const realTimers = { setTimeout, clearTimeout, setInterval, clearInterval }

/** The environment for the engine's `hc connect`: without HC_TERMINAL_ID, so no send has a caller. */
export function chatEnv(env = process.env) {
  const out = { ...env }
  delete out.HC_TERMINAL_ID
  return out
}

/** An engine with its own hc (the bridge passes hcPath and its environment). */
export function createEngine({ home, appHome, hcPath, env = process.env, log } = {}) {
  const engine = new Engine({ hc: connectHc({ hcPath, env: chatEnv(env) }), home, appHome, log })
  // Its own hc: closed with it.
  engine.ownsHc = true
  return engine
}

const refused = (reason = 'not-watching') => ({ state: 'refused', ok: false, reason })

/**
 * The bridge log's line for one chat.answer: the terminal, row and choice exactly as the phone
 * sent them (quoted, so no newline gets in), the result, and what terminal.keys and the last
 * read saw. No row text.
 */
export function answerLine(address, row, choice, result, { typed, final } = {}) {
  const v = (x) => (x === undefined || x === null || x === '' ? '-' : String(x))
  return `chat.answer terminal=${JSON.stringify(address)} row=${JSON.stringify(row)} choice=${JSON.stringify(choice)} ` +
    `ok=${result?.ok === true} reason=${v(result?.reason)} pressed=${v(result?.pressed)} sent=${result?.sent === true} ` +
    `typed=${typed ? `${v(typed.status)}/${v(typed.turn)}` : '-'} final=${final ? `${v(final.state)}/${v(final.kind)}/${v(final.turn)}` : '-'}`
}

export class Engine {
  /**
   * @param {{ hc: any, home: string, appHome?: string, log?: (l: string) => void,
   *   timers?: typeof realTimers, lingerMs?: number, flushMs?: number, hub?: StatusHub, projection?: object }} options
   *   projection: extra options for each Projection (tests)
   */
  constructor({ hc, home, appHome, log = () => {}, timers = realTimers, lingerMs = LINGER_MS, flushMs = FLUSH_MS, maxTerminals = MAX_TERMINALS, hub, projection = {} }) {
    Object.assign(this, { hc, home, appHome, log, timers, lingerMs, flushMs, maxTerminals, projectionOptions: projection })
    this.hub = hub ?? new StatusHub(hc, { timers })
    // Held for the engine's life: list() reads the hub, cold (nothing watched yet) and after the
    // last client leaves alike. close() ends it.
    this.hub.hold()
    this.refused = new Set()
    /** @type {Map<string, any>} address -> entry */
    this.entries = new Map()
    /** client -> its private key: message ids are the client's own, never shared between clients */
    this.keys = new WeakMap()
    this.nextKey = 1
  }

  /** The hub's first snapshot is in (or it waited READY_MS): list() then answers what is live. */
  ready() { return this.hub.ready() }

  /** Live terminals with a decoder (Claude, Codex, omp): what a client can open as a chat. */
  list() {
    return this.hub.all().filter((t) => t.state !== 'finished' && agentOf(t)).map((t) => {
      const watched = this.entries.get(t.address)
      const source = watched ? watched.projection.found.source : findTranscript(t, { home: this.home, appHome: this.appHome, log: this.log, refused: this.refused }).source
      return {
        terminal: t.address, machine: addressParts(t.address).machine, agent: agentOf(t), title: t.title ?? '',
        status: statusOf(t), chat: source === 'none' ? 'screen' : 'transcript'
      }
    })
  }

  watching(client, address) { return this.entries.get(address)?.clients.has(client) ?? false }

  /**
   * A message id as the engine keeps it: the client's own id under that client's key, so another
   * client using the same id has a different message, and can neither move, send nor cancel it.
   * The key is the authenticated device (`client.device`, the paired key the bridge admitted,
   * nothing the phone sends) when there is one, so a Retry after a reconnect finds the message it
   * already sent and never types it twice; else a key of this client object alone. Who wrote a
   * message is still the connection (authors), so a phone leaving drops its held messages.
   */
  own(client, id) {
    let key
    if (typeof client?.device === 'string' && client.device) key = `d:${client.device}`
    else {
      key = this.keys.get(client)
      if (!key) this.keys.set(client, (key = `c:${this.nextKey++}`))
    }
    return `${key}\u0000${id}`
  }

  /** Back to the id the client gave. */
  static theirs(internal) { return internal.slice(internal.indexOf('\u0000') + 1) }

  /** An event about one message: to the client that wrote it, with its own id; to no other. */
  toAuthor(entry, internal, e) {
    const author = entry.authors.get(internal)
    const listener = author && entry.clients.get(author)
    if (!listener) return
    try { listener({ ...e, id: Engine.theirs(internal) }) } catch {}
  }

  /**
   * A client opens a terminal's chat. `listener` gets its events; the handle reads rows. Null when
   * the engine already holds maxTerminals terminals, every one of them watched.
   * @returns {null | { rows(after?: string): any[] | null, screen(): any[], backfill(before: string, limit?: number): Promise<any[]>,
   *   status(): any, approval(): any, question(): any, held(): any[], close(): void }}
   */
  watch(address, client, listener) {
    let entry = this.entries.get(address)
    if (!entry) {
      // At most maxTerminals: a held one (no client) goes first; if every one is watched, none.
      if (this.entries.size >= this.maxTerminals) {
        const held = [...this.entries.values()].find((e) => !e.clients.size)
        if (!held) return null
        this.drop(held.address)
      }
      entry = this.open(address)
    }
    this.timers.clearTimeout(entry.linger)
    entry.linger = null
    entry.clients.set(client, listener)
    return {
      rows: (after) => entry.projection.rows(after),
      screen: () => entry.projection.screen(),
      backfill: (before, limit) => entry.projection.backfill(before, limit),
      status: () => entry.projection.status,
      approval: () => entry.approval,
      // The open question, for a client that watches after it was raised (no question event comes).
      question: () => entry.question,
      // Only this client's own held messages, by its own ids.
      held: () => entry.input.held.filter((h) => entry.authors.get(h.id) === client).map(({ id, why }) => ({ id: Engine.theirs(id), why })),
      close: () => this.leave(address, client)
    }
  }

  /**
   * A client stops watching. Its held messages go with it: a message is typed only while the
   * person who wrote it still watches (a phone removed or gone types nothing later). Every message
   * is its author's own (own()), so when the last client leaves none is left; looking stops, and
   * the rows are kept 10 minutes.
   */
  leave(address, client) {
    const entry = this.entries.get(address)
    if (!entry || !entry.clients.delete(client)) return
    for (const [id, author] of entry.authors) {
      if (author !== client) continue
      entry.authors.delete(id)
      entry.pending.delete(id)
      entry.input.cancelHeld({ id })
    }
    if (entry.clients.size) return
    this.timers.clearInterval(entry.flusher)
    entry.flusher = null
    entry.linger = this.timers.setTimeout(() => { this.drop(address) }, this.lingerMs)
    entry.linger.unref?.()
  }

  drop(address) {
    const entry = this.entries.get(address)
    if (!entry) return
    this.entries.delete(address)
    this.timers.clearTimeout(entry.linger)
    this.timers.clearInterval(entry.flusher)
    entry.projection.stop()
    if (!this.entries.size) this.onEmpty?.()
  }

  /** No terminal held any more (every client gone and every hold over): the owner may close it. */
  get empty() { return this.entries.size === 0 }

  close() {
    this.onEmpty = null
    for (const a of [...this.entries.keys()]) this.drop(a)
    this.hub.close()
    if (this.ownsHc) this.hc.close()
  }

  open(address) {
    const projection = new Projection(address, { hc: this.hc, hub: this.hub, home: this.home, appHome: this.appHome, log: this.log, refused: this.refused, timers: this.timers, ...this.projectionOptions })
    const entry = { address, projection, clients: new Map(), linger: null, approval: null, question: null, pending: new Map(), checking: null, flusher: null,
      answering: null, answered: new Map(), authors: new Map() }
    const emit = (e) => { for (const l of [...entry.clients.values()]) { try { l(e) } catch {} } }
    entry.emit = emit
    entry.read = () => this.read(entry)
    entry.input = new Input({ hc: this.hc, address, read: entry.read })
    // input.js's events are about one message each: only its author hears them.
    entry.input.on((e) => {
      if (e.type === 'sent') {
        // The text stays here, to find the transcript's row for it; the author already has it.
        const { text, ...rest } = e
        this.toAuthor(entry, e.id, rest)
        entry.pending.set(e.id, text)
        if (entry.pending.size > MAX_PENDING) {
          const oldest = entry.pending.keys().next().value
          entry.pending.delete(oldest)
          entry.authors.delete(oldest)
        }
        this.toAuthor(entry, e.id, { type: 'sending' })
      } else this.toAuthor(entry, e.id, e)
      this.flushing(entry)
    })
    projection.on((e) => {
      emit(e)
      if (e.type === 'rows') {
        this.match(entry, e.rows)
        // A question raised before its AskUserQuestion call reached the transcript: look again.
        if (entry.question && !entry.question.answerable && entry.question.why === 'no-open-call') this.checkApproval(entry)
      }
      if (e.type === 'status') { if (entry.clients.size) entry.input.flush(); this.checkApproval(entry) }
      if (e.type === 'screen' && entry.clients.size) entry.input.flush()
    })
    this.entries.set(address, entry)
    projection.start()
    return entry
  }

  /** Facts read now, for a send or an answer: herdr-core's status and screen, the open calls. */
  async read(entry) {
    const [t, r] = await Promise.all([
      this.hc.call('terminal.get', { terminal: entry.address }),
      this.hc.call('terminal.read', { terminal: entry.address })
    ])
    return { agent: agentOf(t), status: statusOf(t), screen: typeof r?.text === 'string' ? r.text : '', openCalls: entry.projection.openCalls() }
  }

  /** While messages are held, look again every FLUSH_MS. */
  flushing(entry) {
    if (entry.input.held.length && !entry.flusher && entry.clients.size) {
      entry.flusher = this.timers.setInterval(() => { if (entry.clients.size) entry.input.flush() }, this.flushMs)
      entry.flusher.unref?.()
    } else if (!entry.input.held.length && entry.flusher) {
      this.timers.clearInterval(entry.flusher)
      entry.flusher = null
    }
  }

  /** A sent message, shown as "sending" until the transcript's user row with its text arrives. */
  match(entry, rows) {
    for (const r of rows) {
      if (r.kind !== 'text' || r.role !== 'user' || r.source !== 'transcript') continue
      for (const [id, text] of entry.pending) {
        if (typeof text === 'string' && r.text.trim() === text.trim()) {
          entry.pending.delete(id)
          this.toAuthor(entry, id, { type: 'matched', row: r.id })
          entry.authors.delete(id)
          break
        }
      }
    }
  }

  /** Raise, update or close the approval (or question) row after a status change. */
  checkApproval(entry) {
    // One check at a time; anything that arrives meanwhile runs it once more after.
    if (entry.checking) { entry.recheck = true; return entry.checking }
    entry.checking = (async () => {
      do {
        entry.recheck = false
        await this.checkOnce(entry)
      } while (entry.recheck)
    })().finally(() => { entry.checking = null })
    return entry.checking
  }

  closeApproval(entry) {
    if (!entry.approval) return
    entry.emit({ type: 'approval', row: { ...entry.approval, open: false } })
    entry.approval = null
  }

  async checkOnce(entry) {
    const status = entry.projection.status
    if (status.state !== 'blocked') { entry.answered.clear(); entry.question = null; this.closeApproval(entry); return }
    let facts
    if (status.kind !== 'permission') {
      // A question (question.js): options to tap only for a probed agent and one open
      // AskUserQuestion call; anything else (a picker, an auth prompt) is answered in the terminal.
      try { facts = await entry.read() } catch { facts = null }
      const state = (facts && questionState(facts)) ??
        { call: null, prompt: status.msg, options: [], multi: false, why: 'answer-in-terminal' }
      const answered = state.call && entry.answered.has(state.call.id)
      const row = questionRow(answered ? { ...state, why: entry.answered.get(state.call.id) } : state, { turn: status.turn, segment: entry.projection.store.segment })
      const q = entry.question
      if (q && q.id === row.id && q.answerable === row.answerable && q.why === row.why) return
      entry.question = row
      entry.emit({ type: 'question', row })
      return
    }
    try { facts = await entry.read() } catch { return }
    const state = approvalState(facts)
    // Read fresh, no approval is open any more (answered, or the status moved on).
    if (!state) { this.closeApproval(entry); return }
    // A call already answered keeps its row, without buttons, until the status moves.
    const answered = state.call && entry.answered.has(state.call.id)
    const row = approvalRow(answered ? { ...state, choices: [], why: entry.answered.get(state.call.id) } : state, { turn: status.turn, segment: entry.projection.store.segment })
    if (entry.approval && entry.approval.id === row.id && entry.approval.choices.join() === row.choices.join()) return
    if (entry.approval && entry.approval.id !== row.id) this.closeApproval(entry)
    entry.approval = row
    entry.emit({ type: 'approval', row })
  }

  // ---- what a client's person did

  async send(client, address, { text, id }) {
    if (!this.watching(client, address)) return refused()
    if (typeof id !== 'string' || !id) return { state: 'refused', id, reason: 'id' }
    const entry = this.entries.get(address)
    const internal = this.own(client, id)
    entry.authors.set(internal, client)
    const answer = await entry.input.send({ text, id: internal })
    // Held, and its author left meanwhile: it goes with them, never typed later.
    if (answer.state === 'held' && !entry.clients.has(client)) {
      entry.input.cancelHeld({ id: internal })
      entry.authors.delete(internal)
    } else if (answer.state === 'refused') entry.authors.delete(internal)
    return { ...answer, id }
  }

  async sendHeld(client, address, { id }) {
    if (!this.watching(client, address)) return refused()
    const answer = await this.entries.get(address).input.sendHeld({ id: this.own(client, id) })
    return { ...answer, id }
  }

  cancelHeld(client, address, { id }) {
    if (!this.watching(client, address)) return refused()
    const entry = this.entries.get(address)
    const internal = this.own(client, id)
    const answer = entry.input.cancelHeld({ id: internal })
    if (answer.ok) entry.authors.delete(internal)
    return answer
  }

  /**
   * An approval the person tapped: only the engine's own open row, checked again before the key.
   * One answer at a time per terminal, and one per open call: herdr-core types a key only after
   * ~3 s of quiet, during which the dialog stays and every re-read still passes, so a second tap,
   * another client or a retry after 'uncertain' would press again, maybe on the next dialog. An
   * answered call is refused until the status leaves blocked.
   */
  async answer(client, address, { row, choice, text }) {
    const note = {}
    // The log line names the choice, never a question's free text.
    const result = await this.answerOnce(client, address, { row, choice, text }, note)
    this.log(answerLine(address, row, choice, result, note))
    return result
  }

  async answerOnce(client, address, { row, choice, text }, note) {
    if (!this.watching(client, address)) return refused()
    const entry = this.entries.get(address)
    if (entry.answering) return { ok: false, reason: 'in-flight' }
    if (typeof row === 'string' && row.startsWith('question:')) return this.answerQuestion(entry, address, { row, choice, text }, note)
    if (!entry.approval || entry.approval.id !== row) return { ok: false, reason: 'no-such-row' }
    if (entry.approval.call && entry.answered.has(entry.approval.call)) return { ok: false, reason: 'answered' }
    const call = entry.approval.call
    entry.answering = answerApproval({ hc: this.hc, address, rowId: row, choice, read: entry.read, timers: this.timers, note })
    let result
    try { result = await entry.answering } finally { entry.answering = null }
    // terminal.keys was called: that call is answered, whatever came back (a timeout or an error
    // may still have typed it) and whatever the dialog shows, until the status moves. Uncertain
    // (the dialog still up after VERIFY_MS) is not-taken, never shown as answered.
    if (result.sent && call) entry.answered.set(call, result.pressed === 'uncertain' ? 'not-taken' : 'answered')
    if (result.ok || result.reason === 'changed' || result.reason === 'closed') this.checkApproval(entry)
    return result
  }

  /** A question the person answered: the same rules as an approval (one at a time, one per call). */
  async answerQuestion(entry, address, { row, choice, text }, note = {}) {
    const q = entry.question
    if (!q || q.id !== row) return { ok: false, reason: 'no-such-row' }
    if (q.call && entry.answered.has(q.call)) return { ok: false, reason: 'answered' }
    if (!q.answerable) return { ok: false, reason: 'answer-in-terminal' }
    entry.answering = answerQuestion({ hc: this.hc, address, rowId: row, choice, text, read: entry.read, timers: this.timers, note })
    let result
    try { result = await entry.answering } finally { entry.answering = null }
    // A key went in: that call is answered until the status moves, as an approval's; uncertain
    // (the question still up after VERIFY_MS) is not-taken, never shown as answered.
    if (result.sent) entry.answered.set(q.call, result.pressed === 'uncertain' ? 'not-taken' : 'answered')
    if (result.sent || result.reason === 'changed' || result.reason === 'closed') this.checkApproval(entry)
    return result
  }

  interrupt(client, address) {
    if (!this.watching(client, address)) return refused()
    return this.entries.get(address).input.interrupt()
  }
}
