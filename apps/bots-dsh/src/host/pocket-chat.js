// Pocket live chat for the team's own Bots (#517). A paired phone already sees Herdr's terminal
// agents through Pocket Link (RFC 0015); this is the source beside them for the Bots this plugin
// runs, read from their DSH Session logs instead of a screen. Claude, Codex and omp panes keep
// their transcript > status > screen sources unchanged: none of this touches them.
//
// - Reads, and since RFC 0015's amendment (2026-11-07) three writes: send a prompt, interrupt the
//   running turn, and answer one approval or question DSH raised. The writes exist only on a
//   watch handle (a channel a socket connection subscribed to), never by terminal name, never as
//   a DSH tool, never to an automation: `send`, `answer` and `interrupt` on the source itself
//   stay refused. Without DSH's prompt and cancel the source stays read only, as before.
// - Approvals and questions come from DSH's approval and question services: a listener on their
//   answerer waterfalls (`approval/request`, `user-questions/request`) passes each request on at
//   once and races the computer's answer against the phone's; the first answer wins, the other
//   side closes with a receipt (Amendments, "Approvals on the phone, and the race").
// - Own Bots only: each live Bot's own current chat Session. No group, task or archived Sessions,
//   no subagents (a Session whose header says `origin: 'subagent'` is refused). A project Bot is
//   served only with the person's yes for its project (`shown`, the home file's `shown[]`, read
//   by shown.js); global Bots need none. A Bot's project and machine are its home-file folder and
//   machine; a Bot the home file does not list is global.
// - Each listed chat keeps its `dsh:<sessionId>` terminal and Session id and carries the Bot's
//   registry id beside them (`registryId`, a Herdr `b-...` or null), so Pocket can join the chat
//   to the registry Bot (#672). Watch, send and the terminal ids are unchanged.
// - The listing serves a watched Bot's status and, for a Bot no phone watches, reads its Session
//   state while listing (in parallel, a short timeout; failures keep the idle row), so Home sees a
//   question before anyone opens the chat (#752). With writes on, the open request's text is the
//   row's line. State and open requests are memory only.
// - No import of a DSH package. The Session API is DSH 0.2.2's Session Controller (`follow`,
//   `events`, `state`, `observeState`; `prompt` and `cancel` for writes), reached through
//   `ctx.sessionController`, behind a capability check and a lazy import of the adapter
//   (pocket-chat-adapter.js). On a runtime without the read methods the source is absent.
// - Served to Pocket Link over a Unix socket in the team's home, owner-only (pocket-socket.js).
// - With RFC 0036 management, a live phone grant can read, edit or add a shown project Bot's
//   own memory and manage its own scheduled tasks without a chat subscription. Each check uses
//   the current team lock and one fresh home registry snapshot.
import { randomUUID } from 'node:crypto'
import { isBotId } from '../shared/registry.js'
import { TEAM_LOOKUPS, teamToolOf } from './approvals.js'
import { startPocketSocket } from './pocket-socket.js'
import { homeRegistryPathOf, shownReader } from './shown.js'

/** The Session Controller methods this source needs (DSH 0.2.2); all of them, or none is used. */
export const SESSION_METHODS = Object.freeze(['follow', 'events', 'state', 'observeState'])
export const hasSessionApi = controller => controller != null && SESSION_METHODS.every(name => typeof controller[name] === 'function')
/** The methods the writes need besides the reads; without both, the source stays read only. */
export const WRITE_METHODS = Object.freeze(['prompt', 'cancel'])
export const hasWriteApi = controller => hasSessionApi(controller) && WRITE_METHODS.every(name => typeof controller[name] === 'function')

/** A send's text, and an answer's free text, at most this many UTF-8 bytes (Pocket Link's SEND_TEXT_MAX). */
export const SEND_TEXT_MAX = 32 * 1024
/** Phone ids kept per Session for the Retry dedupe. */
export const KEEP_SENT_IDS = 64
/** Settled requests kept per Session, for the phone's receipts on reconnect. */
export const KEEP_SETTLED = 16
/** Sessions whose settled requests are kept (oldest forgotten first). */
export const KEEP_SETTLED_SESSIONS = 32
/** Every prompt from the phone carries a request id that starts so (the log tells them apart). */
export const REQUEST_PREFIX = 'pocket-'
/** What an approval row offers the phone: one call, or no. Allow for session stays on the computer. */
export const APPROVAL_CHOICES = Object.freeze(['allow', 'deny'])
export const OTHER = 'other'
const PHONE_OUTCOMES = { allow: 'allowed-once', deny: 'rejected' }
const COMPUTER_OUTCOMES = { 'allowed-once': 'allow', rejected: 'deny' }
const PHONE_ID = /^[A-Za-z0-9._:-]{1,128}$/

// ---- the cleaner (RFC 0015, Design, "Input"): Pocket Link's chat/paste.js cleanChatText, the same
// rules, kept here because a plugin never imports from the herdr pack.
const ESC = '\u001b'
const CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g
const STRING = /(?:\u001b[\]PX^_]|[\u0090\u0098\u009d\u009e\u009f])[^\u0007\u001b\u0090\u0098\u009c-\u009f]*(?:\u0007|\u001b\\|\u009c)/g
const OTHER_SEQUENCE = /\u001b[ -/]*[0-~]/g
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

/**
 * Paste markers, escape sequences, every C0 control but newline and tab, DEL and C1 go; CRLF
 * becomes LF. Empty (or only whitespace) after cleaning is refused.
 * @param {unknown} text
 * @returns {{ ok: true, text: string } | { ok: false, reason: 'empty' | 'not-text' }}
 */
export function cleanChatText(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'not-text' }
  const cleaned = text
    .replaceAll(`${ESC}[200~`, '')
    .replaceAll(`${ESC}[201~`, '')
    .replace(STRING, '')
    .replace(CSI, '')
    .replace(OTHER_SEQUENCE, '')
    .replace(/\r\n/g, '\n')
    .replace(CONTROLS, '')
  return cleaned.trim() === '' ? { ok: false, reason: 'empty' } : { ok: true, text: cleaned }
}

const bytes = text => Buffer.byteLength(text, 'utf8')
/** A refused write, in the shapes `chat.*` answers (Pocket Link forwards them unchanged). */
export const refused = (reason, extra = {}) => ({ ok: false, state: 'refused', reason, ...extra })
const sessionOfAgent = agent => agent?.session?.id ?? agent?.id

/** What every read-only row, status and refusal tells the person. */
export const ANSWER_ON_COMPUTER = 'Answer on the computer'
/** Rows kept per followed Session (the bridge keeps as many for a terminal, RFC 0015). */
export const KEEP_ROWS = 500
/** One page: at most this many rows and bytes of JSON (Pocket Link's backfill limits). */
export const PAGE_ROWS = 200
export const PAGE_BYTES = 1024 * 1024
/** A row's text is cut here, a tool's input or output preview here (RFC 0015 limits). */
export const TEXT_MAX = 64 * 1024
export const PREVIEW_MAX = 8 * 1024
/** While a turn runs, the state is read again this often: a pending approval alone does not
 *  wake `observeState` (dsh-api-session-controller types.d.ts:584-585). */
export const STATE_POLL_MS = 2000
/** Sessions followed at once. */
export const MAX_FOLLOWED = 8
/** One unwatched Bot's state read while listing: past it the row stays idle, so `list` never waits long. */
export const LIST_STATE_MS = 1500

const TERMINAL_PREFIX = 'dsh:'
const realTimers = { setInterval, clearInterval }

export const terminalOf = botId => `${TERMINAL_PREFIX}${botId}`
export const botIdOf = terminal => (typeof terminal === 'string' && terminal.startsWith(TERMINAL_PREFIX) && terminal.length > TERMINAL_PREFIX.length
  ? terminal.slice(TERMINAL_PREFIX.length)
  : null)

/** A row id: `dsh:<sessionId>:<seq>`, with `#<part>` when one event makes more than one row. */
export const rowIdOf = (sessionId, seq, part) => `${TERMINAL_PREFIX}${sessionId}:${seq}${part ? `#${part}` : ''}`

/** The Session and event seq a row id names, or null. */
export function cursorOf(id) {
  if (typeof id !== 'string' || !id.startsWith(TERMINAL_PREFIX)) return null
  const rest = id.slice(TERMINAL_PREFIX.length)
  const at = rest.lastIndexOf(':')
  if (at <= 0) return null
  const seq = Number(rest.slice(at + 1).split('#')[0])
  return Number.isSafeInteger(seq) && seq >= 0 ? { sessionId: rest.slice(0, at), seq } : null
}

const cut = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text)
const textOf = (content) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
}
const count = value => (Number.isFinite(value) && value >= 0 ? value : 0)

/**
 * The Pocket rows one committed Session event makes (Pocket Link chat/types.js row kinds).
 * `scope` carries what the fold needs across events: the open turn and the tool-call rows by call id.
 * @param {{ type: string, seq: number, time?: number, data?: any }} event
 * @param {{ sessionId: string, turn: number, calls: Map<string, string>, stopOf?: (turn: number) => string | undefined }} scope
 */
export function rowsOf(event, scope) {
  const data = event?.data ?? {}
  if (Number.isInteger(data.turn)) scope.turn = data.turn
  if (!Number.isSafeInteger(event?.seq)) return []
  const base = part => ({ id: rowIdOf(scope.sessionId, event.seq, part), turn: scope.turn, at: Number.isFinite(event.time) ? event.time : null, source: 'session' })
  switch (event.type) {
    case 'user/message': {
      // A person's prompt only: injected context (file notices, skills, reminders) is not chat.
      if (data.role !== 'user' || data.source?.kind !== 'user') return []
      const text = textOf(data.content)
      return text.trim() ? [{ ...base(), kind: 'text', role: 'user', text: cut(text, TEXT_MAX) }] : []
    }
    case 'assistant/message': {
      const rows = []
      const text = textOf(data.message?.content)
      if (text.trim()) rows.push({ ...base(), kind: 'text', role: 'assistant', text: cut(text, TEXT_MAX), ...(data.interrupted === true ? { interrupted: true } : {}) })
      const usage = data.usage
      if (usage && typeof usage === 'object') rows.push({ ...base('tokens'), kind: 'tokens', input: count(usage.inputTokens), output: count(usage.outputTokens), cache: count(usage.cacheReadTokens) })
      return rows
    }
    case 'turn/end': {
      const msg = scope.stopOf?.(data.turn ?? scope.turn)
      return msg ? [{ ...base('stop'), kind: 'status', state: 'error', msg: cut(msg, PREVIEW_MAX) }] : []
    }
    case 'tool/call': {
      const row = { ...base(), kind: 'tool-call', tool: String(data.name ?? ''), summary: String(data.name ?? ''), input: cut(typeof data.arguments === 'string' ? data.arguments : '', PREVIEW_MAX) }
      if (typeof data.callId === 'string') scope.calls.set(data.callId, row.id)
      return [row]
    }
    case 'tool/result': {
      const message = data.message ?? {}
      const call = scope.calls.get(message.toolCallId) ?? null
      return [{ ...base(), kind: 'tool-result', call, ok: message.isError !== true, output: cut(textOf(message.content), PREVIEW_MAX) }]
    }
    default:
      return []
  }
}

/** Pocket status from a Session state (`SessionState`, dsh-api-session-controller types.d.ts:578-588). */
export function statusOf(state, turn = 0, { writable = false } = {}) {
  const pending = Array.isArray(state?.pendingInput) ? state.pendingInput : []
  // With writes, the phone answers from the row itself; the status no longer sends it away.
  const msg = writable ? '' : ANSWER_ON_COMPUTER
  if (pending.includes('approval')) return { state: 'blocked', kind: 'permission', msg, turn }
  if (pending.includes('question')) return { state: 'blocked', kind: 'question', msg, turn }
  if (pending.length) return { state: 'blocked', kind: null, msg, turn }
  return { state: state?.running === true ? 'working' : 'idle', kind: null, msg: '', turn }
}

/**
 * The read-only row for what the Session waits on, or null. It has no buttons and no tool input:
 * the state does not say which call is pending, and the tool-call row already shows it.
 */
export function pendingRowOf(state, sessionId, turn = 0) {
  const pending = Array.isArray(state?.pendingInput) ? state.pendingInput : []
  const at = Number.isSafeInteger(state?.cursor) ? state.cursor : 0
  if (pending.includes('approval')) {
    return { id: rowIdOf(sessionId, at, 'approval'), turn, at: null, source: 'session', kind: 'approval', tool: '', summary: ANSWER_ON_COMPUTER, choices: [], open: true, answerable: false }
  }
  if (pending.includes('question')) {
    return { id: rowIdOf(sessionId, at, 'question'), turn, at: null, source: 'session', kind: 'question', prompt: ANSWER_ON_COMPUTER, options: [], multi: false, answerable: false }
  }
  return null
}

/** The newest rows that fit one page. */
export function pageOf(rows, limit = PAGE_ROWS) {
  const out = []
  let bytes = 0
  for (let i = rows.length - 1; i >= 0 && out.length < limit; i--) {
    const size = Buffer.byteLength(JSON.stringify(rows[i]))
    if (bytes + size > PAGE_BYTES) break
    bytes += size
    out.unshift(rows[i])
  }
  return out
}

const seqOf = row => cursorOf(row.id)?.seq ?? -1

/** What the phone may never do by terminal name, and why: writes exist only on a watch handle. */
export function refusal(id) {
  return { state: 'refused', ok: false, reason: 'read-only', message: ANSWER_ON_COMPUTER, ...(id === undefined ? {} : { id }) }
}

/** A row id for a request DSH raised: keyed by the tool call DSH's own card attaches to. */
const requestRowId = (sessionId, seq, kind, key) => rowIdOf(sessionId, Math.max(0, seq), `${kind}-${encodeURIComponent(key)}`)

/** Without a reader (tests): global Bots (`project: null`) only; install passes shown.js's. */
const globalOnly = bot => bot?.project == null

/**
 * The source: one follow per watched Bot's Session, shared by every listener of it.
 * @param {{ adapter: { follow(sessionId: string, signal: AbortSignal): AsyncIterable<any>,
 *   events(sessionId: string, page: { beforeSeq?: number, maxMessages?: number }, signal: AbortSignal): Promise<{ records: any[], hasMore: boolean }>,
 *   state(sessionId: string, signal: AbortSignal): Promise<any>, observeState(sessionId: string, signal: AbortSignal): AsyncIterable<any>,
 *   prompt?(sessionId: string, prompt: { requestId: string, text: string }, signal: AbortSignal): Promise<any>, cancel?(sessionId: string): any },
 *   bots: () => Promise<Array<{ id: string, name: string, sessionId: string, project?: string | null, machine?: string, placeUnknown?: true }>>,
 *   registryIdOf?: (bot: { id: string, name?: string, project?: string | null }) => string | null,
 *   timers?: typeof realTimers, pollMs?: number, listMs?: number,
 *   keep?: number, maxFollowed?: number, log?: (...args: any[]) => void, writable?: boolean,
 *   shown?: (bot: { id: string, project?: string | null, machine?: string, placeUnknown?: true }) => boolean, chatOwner?: (sessionId: string) => string | undefined, now?: () => number,
 *   stopOf?: (sessionId: string, turn: number) => string | undefined,
 *   carriesSignInCode?: (text: string) => boolean }} options
 */
export class DshChatSource {
  constructor({ adapter, bots, timers = realTimers, pollMs = STATE_POLL_MS, listMs = LIST_STATE_MS, keep = KEEP_ROWS, maxFollowed = MAX_FOLLOWED, log = () => {}, writable = false, shown = globalOnly, registryIdOf = () => null, chatOwner, now = Date.now, carriesSignInCode = () => false, stopOf = () => undefined, management, schedules }) {
    Object.assign(this, { adapter, bots, timers, pollMs, listMs, keep, maxFollowed, log, shown, registryIdOf, now, stopOf })
    /** Whether a text carries a Claude sign-in code the computer showed (cli-login.js). Never throws. */
    this.carriesSignInCode = (text) => { try { return carriesSignInCode(text) === true } catch { return false } }
    /** Writes need the adapter's prompt and cancel, and the answerer listeners wired (install). */
    this.writable = writable === true && typeof adapter?.prompt === 'function' && typeof adapter?.cancel === 'function'
    this.management = management
    this.schedules = schedules
    this.chatOwner = chatOwner ?? (sessionId => [...this.entries.values()].find(entry => entry.sessionId === sessionId)?.botId)
    /** botId -> entry */
    this.entries = new Map()
    /** sessionId -> Map(rowId -> open request): what DSH waits on now, followed or not. */
    this.open = new Map()
    /** sessionId -> settled requests, newest last (KEEP_SETTLED). Memory only. */
    this.settled = new Map()
    /** sessionId -> request ids already prompted (KEEP_SENT_IDS), the phone's and the log's. */
    this.sent = new Map()
  }

  get manages() {
    return this.writable && this.management?.enabled() === true
  }

  memoryAllowed(botId) {
    return this.management.allowed(botId)
  }

  manageMemory(method, args) {
    return this.management.run(method, args)
  }

  get listsSchedules() {
    return this.writable && this.schedules?.available() === true
  }

  get writesSchedules() {
    return this.listsSchedules && this.schedules.writable()
  }

  schedulesAllowed(botId, scheduleAvailable) {
    return this.schedules.allowed(botId, scheduleAvailable)
  }

  manageSchedules(method, args) {
    return this.schedules.run(method, args)
  }

  /**
   * The Bots a phone can open, each as `dsh:<botId>`. The terminal keeps the Session id; the
   * registry id beside it lets Pocket join the chat to the registry Bot (#672).
   *
   * A chat some phone watches is what that watch knows. One nobody watches is read from its
   * Session now, every Bot in parallel and each for at most `listMs`, so a question or an approval
   * reaches Home before the chat is opened (#752). With writes on, the row's line is the open
   * request's text (the question's prompt, the approval's summary). A read that fails or is too
   * slow keeps the idle row it always had, and is logged. Nothing here is stored: Session state
   * and the open requests are memory only.
   */
  async list() {
    const bots = await this.bots()
    const statuses = await Promise.all(bots.map(bot => this.listedStatus(bot)))
    return bots.map((bot, i) => ({
      terminal: terminalOf(bot.id), machine: null, agent: 'dsh', title: bot.name ?? '',
      status: statuses[i], chat: 'session', shown: this.shown(bot) === true,
      registryId: this.registryIdOf(bot) ?? null,
    }))
  }

  /** What the listing says of one Bot: its watched entry, else a read of its Session now (never a hang). */
  async listedStatus(bot) {
    const watched = this.entries.get(bot.id)
    if (watched) return watched.status
    const read = await this.readListed(bot)
    // A phone may have opened the chat while this read ran: the watch is then the fresher word.
    return this.entries.get(bot.id)?.status ?? read
  }

  /** Read one unwatched Bot's state for the listing, for at most `listMs`; on failure the old idle row. */
  async readListed(bot) {
    const controller = new AbortController()
    let timer
    try {
      const state = await Promise.race([
        this.adapter.state(bot.sessionId, controller.signal),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort(new Error('the listing waited too long'))
            reject(new Error('the listing waited too long'))
          }, this.listMs)
          timer.unref?.()
        }),
      ])
      const status = statusOf(state, 0, { writable: this.writable })
      const text = status.state === 'blocked' ? this.openTextOf(bot.sessionId, status.kind) : ''
      return text ? { ...status, msg: text } : status
    } catch (error) {
      this.log('pocket chat: could not read %s for the listing: %s', bot.id, error?.message ?? error)
      return statusOf(null)
    } finally {
      clearTimeout(timer)
    }
  }

  /** The text of the request DSH waits on in this Session ([open]): a question's prompt, else an approval's summary. */
  openTextOf(sessionId, kind) {
    const requests = [...(this.open.get(sessionId)?.values() ?? [])].filter(record => !record.done)
    const request = requests.find(record => record.row.kind === kind) ?? requests[0]
    if (!request) return ''
    return request.row.kind === 'question' ? String(request.row.prompt ?? '') : String(request.row.summary ?? '')
  }

  /**
   * Start watching a Bot's chat. The listener gets a `snapshot` first, then `rows`, `status`,
   * `approval` and `question` events, and `gone` if the Session stops being followable. With
   * writes on, the handle also sends, interrupts and answers, for this chat only.
   * @returns {Promise<{ ok: true, close(): void, backfill(before: string, limit?: number): Promise<any[]>,
   *   send?: Function, interrupt?: Function, answer?: Function } | { ok: false, reason: string }>}
   */
  async watch(terminal, listener, { after } = {}) {
    const botId = botIdOf(terminal)
    if (botId === null) return { ok: false, reason: 'not-found' }
    const bot = (await this.bots()).find(item => item.id === botId)
    if (!bot) return { ok: false, reason: 'not-found' }
    if (this.shown(bot) !== true) return { ok: false, reason: 'not-shown' }
    let entry = this.entries.get(botId)
    if (entry && entry.sessionId !== bot.sessionId) { this.drop(entry, 'moved'); entry = undefined }
    if (!entry) {
      if (this.entries.size >= this.maxFollowed) return { ok: false, reason: 'too-many' }
      entry = this.open_(bot)
      this.entries.set(botId, entry)
    }
    let opened
    try { opened = await entry.ready } catch { opened = { ok: false, reason: 'unavailable' } }
    if (!opened.ok) { this.drop(entry); return opened }
    entry.listeners.add(listener)
    const live = this.writable ? [...(this.open.get(entry.sessionId)?.values() ?? [])].map(request => request.row) : []
    const snapshot = await this.snapshotFor(entry, after)
    const firstApproval = live.find(row => row.kind === 'approval')
    this.emitTo(listener, this.writable ? { ...snapshot, approval: firstApproval ?? null, settled: [...(this.settled.get(entry.sessionId) ?? [])] } : snapshot)
    if (this.writable) {
      for (const row of live) if (row !== firstApproval) this.emitTo(listener, { type: row.kind, row })
    } else if (entry.question) {
      this.emitTo(listener, { type: 'question', row: entry.question })
    }
    const writes = new AbortController()
    let closed = false
    const handle = {
      ok: true,
      close: () => { closed = true; writes.abort(new Error('the phone left this chat')); this.leave(entry, listener) },
      backfill: (before, limit) => this.backfill(entry, before, limit),
    }
    if (this.writable) {
      const live_ = () => !closed && !entry.gone
      Object.assign(handle, {
        send: message => this.send_(entry, live_, writes.signal, message),
        interrupt: () => this.interrupt_(entry, live_),
        answer: message => this.answer_(entry, live_, message),
      })
    }
    return handle
  }

  open_(bot) {
    const controller = new AbortController()
    const entry = {
      botId: bot.id, sessionId: bot.sessionId, controller, listeners: new Set(), rows: [], floorSeq: 0, cursor: -1,
      scope: { sessionId: bot.sessionId, turn: 0, calls: new Map(), stopOf: turn => this.stopOf(bot.sessionId, turn) }, status: statusOf(null), approval: null, question: null, poller: null, gone: false,
    }
    entry.ready = this.start(entry)
    return entry
  }

  async start(entry) {
    const { signal } = entry.controller
    const stream = this.adapter.follow(entry.sessionId, signal)[Symbol.asyncIterator]()
    const first = await stream.next()
    const opening = first.value
    if (first.done || opening?.type !== 'snapshot') return { ok: false, reason: 'unavailable' }
    if (opening.header?.origin === 'subagent') return { ok: false, reason: 'subagent' }
    const records = Array.isArray(opening.records) ? opening.records : []
    entry.floorSeq = records.length ? records[0].event.seq : (Number.isSafeInteger(opening.cursor) ? opening.cursor + 1 : 0)
    entry.cursor = Number.isSafeInteger(opening.cursor) ? opening.cursor : -1
    for (const record of records) this.noteRequestId(entry.sessionId, record.event)
    this.keepRows(entry, records.flatMap(record => rowsOf(record.event, entry.scope)))
    this.applyState(entry, await this.adapter.state(entry.sessionId, signal), { quiet: true })
    void this.pump(entry, stream)
    void this.watchState(entry)
    entry.poller = this.timers.setInterval(() => { if (entry.status.state !== 'idle') void this.readState(entry) }, this.pollMs)
    entry.poller?.unref?.()
    return { ok: true }
  }

  keepRows(entry, rows) {
    if (!rows.length) return
    entry.rows.push(...rows)
    if (entry.rows.length > this.keep) {
      entry.rows.splice(0, entry.rows.length - this.keep)
      entry.floorSeq = seqOf(entry.rows[0])
    }
  }

  async pump(entry, stream) {
    try {
      for (;;) {
        const { value: frame, done } = await stream.next()
        if (done || entry.gone) break
        if (frame?.type !== 'event' || !Number.isSafeInteger(frame.event?.seq)) continue
        entry.cursor = frame.event.seq
        this.noteRequestId(entry.sessionId, frame.event)
        const rows = rowsOf(frame.event, entry.scope)
        if (rows.length) { this.keepRows(entry, rows); this.emit(entry, { type: 'rows', rows }) }
        // A call can be waiting for approval now; turn edges change what is running.
        if (frame.event.type === 'tool/call' || frame.event.type === 'turn/start' || frame.event.type === 'turn/end') void this.readState(entry)
      }
      if (!entry.gone) this.drop(entry, 'ended')
    } catch (error) {
      if (!entry.gone) { this.log('pocket chat: follow ended: %s', error?.message ?? error); this.drop(entry, 'ended') }
    }
  }

  async watchState(entry) {
    try {
      for await (const state of this.adapter.observeState(entry.sessionId, entry.controller.signal)) {
        if (entry.gone) break
        this.applyState(entry, state)
      }
    } catch {
      // The follow decides when the chat is gone; the poll keeps the state meanwhile.
    }
  }

  async readState(entry) {
    if (entry.gone || entry.reading) return
    entry.reading = true
    try { this.applyState(entry, await this.adapter.state(entry.sessionId, entry.controller.signal)) } catch {} finally { entry.reading = false }
  }

  applyState(entry, state, { quiet = false } = {}) {
    if (entry.gone || state == null) return
    const status = statusOf(state, entry.scope.turn, { writable: this.writable })
    const changed = ['state', 'kind', 'msg', 'turn'].some(key => status[key] !== entry.status[key])
    entry.status = status
    entry.running = state.running === true
    // With writes on, the open rows come from the requests DSH raised (the answerer listeners),
    // never from the state too: one source, so a phone never sees the same wait twice.
    const row = this.writable ? null : pendingRowOf(state, entry.sessionId, entry.scope.turn)
    const approval = row?.kind === 'approval' ? row : null
    const question = row?.kind === 'question' ? row : null
    if (quiet) { entry.approval = approval; entry.question = question; return }
    if (changed) this.emit(entry, { type: 'status', status })
    if (entry.approval && entry.approval.id !== approval?.id) this.emit(entry, { type: 'approval', row: { ...entry.approval, open: false } })
    if (approval && entry.approval?.id !== approval.id) this.emit(entry, { type: 'approval', row: approval })
    if (question && entry.question?.id !== question.id) this.emit(entry, { type: 'question', row: question })
    entry.approval = approval
    entry.question = question
  }

  /**
   * Where the chat stands for one listener. A cursor in this Session gets what it missed (paging
   * older events when it is below the rows kept); a cursor from another Session (the Bot moved to
   * a new part), or one too old for a page, gets `reset` and the latest page.
   */
  async snapshotFor(entry, after) {
    const base = { type: 'snapshot', screen: [], status: entry.status, approval: entry.approval, held: [] }
    const latest = { ...base, reset: Boolean(after), rows: pageOf(entry.rows) }
    if (!after) return { ...latest, reset: false }
    const cursor = cursorOf(after)
    if (!cursor || cursor.sessionId !== entry.sessionId || cursor.seq > entry.cursor) return latest
    if (cursor.seq >= entry.floorSeq - 1) return { ...base, reset: false, rows: pageOf(entry.rows.filter(row => seqOf(row) > cursor.seq)) }
    let older
    try { older = await this.adapter.events(entry.sessionId, { beforeSeq: entry.floorSeq, maxMessages: PAGE_ROWS }, entry.controller.signal) } catch { return latest }
    const records = Array.isArray(older?.records) ? older.records : []
    if (!records.length || records[0].event.seq > cursor.seq + 1) return latest
    const scope = { sessionId: entry.sessionId, turn: 0, calls: new Map(entry.scope.calls), stopOf: turn => this.stopOf(entry.sessionId, turn) }
    const missed = records.filter(record => record.event.seq > cursor.seq).flatMap(record => rowsOf(record.event, scope))
    const rows = [...missed, ...entry.rows]
    // Everything missed must fit one page; otherwise the phone starts over from the latest page.
    return rows.length > PAGE_ROWS ? latest : { ...base, reset: false, rows: pageOf(rows) }
  }

  /** Rows before a row id, newest last: at most `limit`, read from the log (cold-safe). */
  async backfill(entry, before, limit = 50) {
    const cursor = cursorOf(before)
    if (!cursor || cursor.sessionId !== entry.sessionId || entry.gone) return []
    const max = Math.min(Math.max(1, Number.isInteger(limit) ? limit : 50), PAGE_ROWS)
    const page = await this.adapter.events(entry.sessionId, { beforeSeq: cursor.seq, maxMessages: max }, entry.controller.signal)
    const scope = { sessionId: entry.sessionId, turn: 0, calls: new Map(), stopOf: turn => this.stopOf(entry.sessionId, turn) }
    const rows = (page?.records ?? []).filter(record => record.event.seq < cursor.seq).flatMap(record => rowsOf(record.event, scope))
    return pageOf(rows, max)
  }

  emitTo(listener, event) { try { listener(event) } catch {} }
  emit(entry, event) { for (const listener of entry.listeners) this.emitTo(listener, event) }
  emitSession(sessionId, event) {
    for (const entry of this.entries.values()) if (entry.sessionId === sessionId && !entry.gone) this.emit(entry, event)
  }

  leave(entry, listener) {
    entry.listeners.delete(listener)
    if (!entry.listeners.size) this.drop(entry)
  }

  drop(entry, reason) {
    if (entry.gone) return
    entry.gone = true
    if (reason) this.emit(entry, { type: 'gone', reason })
    entry.listeners.clear()
    this.timers.clearInterval(entry.poller)
    entry.controller.abort()
    if (this.entries.get(entry.botId) === entry) this.entries.delete(entry.botId)
  }

  close() { for (const entry of this.entries.values()) this.drop(entry, 'closed') }

  // What a phone may do on a terminal and never by name on a DSH chat: each is refused, with no
  // call. The writes are the watch handle's (one subscribed channel), never these.
  send(_terminal, message) { return refusal(message?.id) }
  sendHeld(_terminal, message) { return refusal(message?.id) }
  cancelHeld(_terminal, message) { return refusal(message?.id) }
  answer() { return refusal() }
  interrupt() { return refusal() }

  // ---- the Retry dedupe: request ids already prompted, the phone's and the log's

  noteRequestId(sessionId, event) {
    const rpcId = event?.type === 'user/message' ? event.data?.source?.rpcId : undefined
    if (typeof rpcId === 'string' && rpcId.startsWith(REQUEST_PREFIX)) this.remember(sessionId, rpcId)
  }

  remember(sessionId, requestId) {
    const ids = this.sent.get(sessionId) ?? []
    if (!ids.includes(requestId)) ids.push(requestId)
    if (ids.length > KEEP_SENT_IDS) ids.splice(0, ids.length - KEEP_SENT_IDS)
    this.sent.set(sessionId, ids)
  }

  /** Whether the Bot this chat follows is still served, on the Session the chat follows. */
  async stillServed(entry) {
    const bot = (await this.bots()).find(item => item.id === entry.botId)
    if (!bot || bot.sessionId !== entry.sessionId) return 'not-watching'
    if (this.shown(bot) !== true) return 'not-shown'
    return null
  }

  /**
   * A prompt to the Bot's current chat Session, queued behind a running turn (never `steer`).
   * A known id is answered `sent` and prompts nothing: this memory, the Session log the follow
   * read, and DSH's own check (it skips a prompt whose request id the inbox or log holds).
   */
  async send_(entry, live, signal, message) {
    const id = message?.id
    if (typeof id !== 'string' || !PHONE_ID.test(id)) return refused('invalid', { message: 'id' })
    if (!live()) return refused('not-watching', { id })
    if (typeof message.text !== 'string') return refused('invalid', { id, message: 'text' })
    if (bytes(message.text) > SEND_TEXT_MAX) return refused('too-long', { id })
    const cleaned = cleanChatText(message.text)
    if (!cleaned.ok) return refused('empty', { id })
    // A pasted sign-in code is refused before DSH's prompt: that would write it into the
    // Session's record ahead of any step (plan v3, rule 3). An existing reason, so Pocket says
    // it was not sent without a new wording; the log names the kind only.
    if (this.carriesSignInCode(message.text)) {
      this.log('pocket chat: a send carried a sign-in code and was not sent')
      return refused('invalid', { id, message: 'sign-in-code' })
    }
    const requestId = id.startsWith(REQUEST_PREFIX) ? id : `${REQUEST_PREFIX}${id}`
    if (this.sent.get(entry.sessionId)?.includes(requestId)) return { ok: true, state: 'sent', id, repeat: true }
    const gate = await this.stillServed(entry)
    if (gate) return refused(gate, { id })
    if (!live() || signal.aborted) return refused('not-watching', { id })
    let running = entry.running === true
    try { running = (await this.adapter.state(entry.sessionId, signal))?.running === true } catch {}
    if (!live() || signal.aborted) return refused('not-watching', { id })
    try {
      await this.adapter.prompt(entry.sessionId, { requestId, text: cleaned.text }, signal)
    } catch (error) {
      if (signal.aborted) return refused('not-watching', { id })
      this.log('pocket chat: a send was not accepted: %s', error?.message ?? error)
      return refused('offline', { id })
    }
    this.remember(entry.sessionId, requestId)
    return { ok: true, state: running ? 'queued' : 'sent', id }
  }

  /** Cancel the running turn; with none running, `sent` and nothing done. Never escalates. */
  async interrupt_(entry, live) {
    if (!live()) return refused('not-watching')
    const gate = await this.stillServed(entry)
    if (gate) return refused(gate)
    let running = entry.running === true
    try { running = (await this.adapter.state(entry.sessionId, entry.controller.signal))?.running === true } catch {}
    if (!running) return { ok: true, state: 'sent' }
    if (!live()) return refused('not-watching')
    try { await this.adapter.cancel(entry.sessionId) } catch (error) {
      this.log('pocket chat: an interrupt was not accepted: %s', error?.message ?? error)
      return refused('offline')
    }
    return { ok: true, state: 'sent' }
  }

  /**
   * One answer to the request open now in this chat's Session, checked at answer time (never
   * against what a channel was shown). Allow for session is never taken from the phone.
   */
  async answer_(entry, live, message) {
    const { row, choice, text } = message ?? {}
    if (typeof row !== 'string' || typeof choice !== 'string') return refused('invalid')
    if (text !== undefined && typeof text !== 'string') return refused('invalid')
    if (!live()) return refused('not-watching')
    if (cursorOf(row)?.sessionId !== entry.sessionId) return refused('not-watching')
    const gate = await this.stillServed(entry)
    if (gate) return refused(gate)
    const open = this.open.get(entry.sessionId)
    const request = open?.get(row)
    if (!request || request.done) {
      const settled = this.settled.get(entry.sessionId)?.find(item => item.id === row)
      // Withdrawn and a newer request open in its place: the row was replaced, not answered.
      const replaced = settled?.outcome === 'withdrawn' && (open?.size ?? 0) > 0
      return settled && !replaced ? refused('settled', { receipt: settled }) : refused('changed', { message: 'The question changed' })
    }
    if (typeof text === 'string' && this.carriesSignInCode(text)) {
      this.log('pocket chat: an answer carried a sign-in code and was not sent')
      return refused('invalid', { message: 'sign-in-code' })
    }
    const value = request.row.kind === 'approval' ? approvalAnswer(choice, text) : questionAnswer(request, choice, text)
    if (!value.ok) return refused(value.reason)
    const by = typeof message.by === 'string' ? message.by.slice(0, 120) : ''
    if (!request.settle(value.value, { by: 'phone', ...(by ? { name: by } : {}), outcome: value.outcome })) {
      const settled = this.settled.get(entry.sessionId)?.find(item => item.id === row)
      return refused('settled', settled ? { receipt: settled } : {})
    }
    return { ok: true, state: 'sent' }
  }

  // ---- the answerer listeners: DSH's approval and question services, under the race rule

  /**
   * An `approval/request` waterfall step. Passed on at once (`next`); for a Bot's own chat it is
   * also open to the phone until either side answers. The team's own lookups pass straight on:
   * approvals.js answers them before anyone is asked.
   */
  raceApproval(request, next) {
    const sessionId = sessionOfAgent(request?.agent)
    if (!this.writable || typeof sessionId !== 'string' || this.chatOwner(sessionId) === undefined || TEAM_LOOKUPS.has(teamToolOf(request.toolName))) return next()
    const callId = typeof request.callId === 'string' && request.callId ? request.callId : randomUUID()
    const input = this.callInput(sessionId, request.callId)
    const row = {
      id: requestRowId(sessionId, this.cursorOfSession(sessionId), 'approval', callId), turn: this.turnOfSession(sessionId), at: this.now(), source: 'session', kind: 'approval',
      tool: String(request.toolName ?? ''), summary: String(request.reason ?? request.toolName ?? '').slice(0, 500), input,
      choices: [...APPROVAL_CHOICES], open: true, answerable: true, call: typeof request.callId === 'string' ? request.callId : null,
    }
    return this.hold(sessionId, row, request, next, value => (COMPUTER_OUTCOMES[value] === undefined ? null : { outcome: COMPUTER_OUTCOMES[value] }))
  }

  /** A `user-questions/request` waterfall step, the same way. One question with options is answerable. */
  raceQuestion(request, next) {
    const sessionId = sessionOfAgent(request?.agent)
    if (!this.writable || typeof sessionId !== 'string' || this.chatOwner(sessionId) === undefined) return next()
    const questions = Array.isArray(request?.questions) ? request.questions : []
    const one = questions.length === 1 ? questions[0] : null
    const callId = typeof request.wait?.callId === 'string' && request.wait.callId ? request.wait.callId : randomUUID()
    const options = (one?.options ?? []).map(option => String(option?.label ?? ''))
    const row = {
      id: requestRowId(sessionId, this.cursorOfSession(sessionId), 'question', callId), turn: this.turnOfSession(sessionId), at: this.now(), source: 'session', kind: 'question',
      prompt: one ? cut(String(one.question ?? ''), PREVIEW_MAX) : ANSWER_ON_COMPUTER, options, multi: one?.multiSelect === true,
      answerable: one !== null && typeof one.id === 'string', open: true, call: typeof request.wait?.callId === 'string' ? request.wait.callId : null,
    }
    return this.hold(sessionId, row, request, next, (value) => {
      const answer = Array.isArray(value?.answers) ? value.answers[0] : null
      if (!answer) return null
      const picked = Array.isArray(answer.selected) ? answer.selected.filter(label => options.includes(label)) : []
      return { outcome: picked.length ? picked.join(', ') : 'answered' }
    }, { question: one })
  }

  cursorOfSession(sessionId) { return [...this.entries.values()].find(entry => entry.sessionId === sessionId)?.cursor ?? 0 }
  turnOfSession(sessionId) { return [...this.entries.values()].find(entry => entry.sessionId === sessionId)?.scope.turn ?? 0 }
  callInput(sessionId, callId) {
    const entry = [...this.entries.values()].find(item => item.sessionId === sessionId)
    const rowId = typeof callId === 'string' ? entry?.scope.calls.get(callId) : undefined
    const row = rowId === undefined ? undefined : entry.rows.find(item => item.id === rowId)
    return typeof row?.input === 'string' ? cut(row.input, PREVIEW_MAX) : ''
  }

  /**
   * Hold one request open to the phone while the rest of the chain (the computer's dialog) has
   * it too. The first answer wins: the phone's resolves this step and withdraws the computer's
   * dialog (the request signal the chain below sees is aborted, so DSH sends its `cancel`); the
   * computer's resolves it and closes the phone's card. Either way the winner is recorded with a
   * receipt from this record, never from DSH's frame. No answer is ever made here on its own.
   */
  hold(sessionId, row, request, next, receiptOf, extra = {}) {
    const original = request.signal
    if (original?.aborted) return next()
    const withdraw = new AbortController()
    const signal = original ? AbortSignal.any([original, withdraw.signal]) : withdraw.signal
    // The chain below reads the request's signal; swapping it is how a phone answer reaches the
    // computer's dialog. A request that will not take it is shown but not answerable.
    let swapped = false
    try { request.signal = signal; swapped = request.signal === signal } catch {}
    const shown = swapped ? row : { ...row, answerable: false, ...(row.kind === 'approval' ? { choices: [] } : {}) }
    return new Promise((resolve, reject) => {
      const open = this.open.get(sessionId) ?? new Map()
      this.open.set(sessionId, open)
      const record = { row: shown, done: false, ...extra }
      const finish = () => {
        record.done = true
        open.delete(shown.id)
        if (!open.size && this.open.get(sessionId) === open) this.open.delete(sessionId)
        original?.removeEventListener('abort', onWithdrawn)
        if (swapped) { try { request.signal = original } catch {} }
      }
      const close = (receipt) => {
        const closed = { ...shown, open: false, answerable: false, ...(receipt ? { receipt } : {}) }
        this.emitSession(sessionId, { type: shown.kind, row: closed })
      }
      const keep = (receipt) => {
        const list = this.settled.get(sessionId) ?? []
        list.push(receipt)
        if (list.length > KEEP_SETTLED) list.splice(0, list.length - KEEP_SETTLED)
        this.settled.delete(sessionId)
        this.settled.set(sessionId, list)
        while (this.settled.size > KEEP_SETTLED_SESSIONS) this.settled.delete(this.settled.keys().next().value)
      }
      record.settle = (value, how) => {
        if (record.done || !swapped || !shown.answerable) return false
        finish()
        const receipt = { id: shown.id, by: how.by, ...(how.name ? { name: how.name } : {}), outcome: how.outcome, at: this.now() }
        keep(receipt)
        resolve(value)
        withdraw.abort(new Error('answered on the phone'))
        close(receipt)
        return true
      }
      // Withdrawn by DSH (the turn was interrupted, the Session stopped): "No longer needed".
      const onWithdrawn = () => {
        if (record.done) return
        finish()
        const receipt = { id: shown.id, by: null, outcome: 'withdrawn', at: this.now() }
        keep(receipt)
        close(receipt)
      }
      original?.addEventListener('abort', onWithdrawn, { once: true })
      open.set(shown.id, record)
      this.emitSession(sessionId, { type: shown.kind, row: shown })
      Promise.resolve().then(next).then((value) => {
        if (record.done) { if (!withdraw.signal.aborted) resolve(value); return }
        finish()
        const known = receiptOf(value)
        const receipt = { id: shown.id, by: known ? 'computer' : null, outcome: known?.outcome ?? 'withdrawn', at: this.now() }
        keep(receipt)
        close(receipt)
        resolve(value)
      }, (error) => {
        if (record.done) { if (!withdraw.signal.aborted) reject(error); return }
        finish()
        const receipt = { id: shown.id, by: null, outcome: 'withdrawn', at: this.now() }
        keep(receipt)
        close(receipt)
        reject(error)
      })
    })
  }
}

/** An approval answer from the phone: one call, or no. Never text, never allow for session. */
function approvalAnswer(choice, text) {
  if (text !== undefined) return { ok: false, reason: 'text-on-approval' }
  const value = PHONE_OUTCOMES[choice]
  return value === undefined ? { ok: false, reason: 'invalid' } : { ok: true, value, outcome: choice }
}

/**
 * A question answer from the phone: an option by its number (1 first; a comma list on a
 * multi-select), or `other` with one line of text on a single-select, forwarded unchanged.
 */
function questionAnswer(request, choice, text) {
  const question = request.question
  if (!request.row.answerable || !question) return { ok: false, reason: 'invalid' }
  const options = request.row.options
  if (choice === OTHER) {
    if (request.row.multi || text === undefined) return { ok: false, reason: 'invalid' }
    if (bytes(text) > SEND_TEXT_MAX) return { ok: false, reason: 'too-long' }
    if (/[\r\n]/.test(text)) return { ok: false, reason: 'invalid' }
    if (text.trim() === '') return { ok: false, reason: 'empty' }
    const cleaned = cleanChatText(text)
    if (!cleaned.ok) return { ok: false, reason: 'empty' }
    if (cleaned.text !== text) return { ok: false, reason: 'invalid' }
    return { ok: true, value: { answers: [{ id: question.id, selected: [], custom: text }] }, outcome: OTHER }
  }
  if (text !== undefined) return { ok: false, reason: 'invalid' }
  const digit = d => /^[1-9][0-9]*$/.test(d) && Number(d) <= options.length
  const picked = request.row.multi ? choice.split(',') : [choice]
  if (!picked.length || !picked.every(digit) || new Set(picked).size !== picked.length) return { ok: false, reason: 'invalid' }
  const selected = picked.map(d => options[Number(d) - 1])
  return { ok: true, value: { answers: [{ id: question.id, selected }] }, outcome: selected.join(', ') }
}

/**
 * The team's own live Bots, each with its current own-chat Session (never a group, task or
 * archived one). With a reader (shown.js), a Bot the home file lists with a folder takes that
 * folder as its project and its machine; a Bot it does not list stays global. When the file
 * can't be read, a Bot with a registry id is marked `placeUnknown`, which is never shown.
 */
export function ownBots(rt, reader) {
  return async () => {
    await rt.load?.()
    const places = reader ? reader.places() : new Map()
    const bots = Object.values(rt.state?.bots ?? {})
    return bots
      .filter(bot => typeof bot?.id === 'string' && rt.botOf(bot.id) === bot)
      .map((bot) => {
        const own = { id: bot.id, name: typeof bot.name === 'string' ? bot.name : '', sessionId: rt.chatOf(bot.id) }
        if (places === null && isBotId(bot.id)) return { ...own, project: null, placeUnknown: true }
        const place = places?.get(bot.id)
        if (place) return { ...own, project: place.folder, ...(place.machine !== undefined ? { machine: place.machine } : {}) }
        return { ...own, project: typeof bot.project === 'string' ? bot.project : null }
      })
      .filter(bot => typeof bot.sessionId === 'string' && bot.sessionId !== '')
  }
}

function ownShownBot(rt, reader, botId) {
  const bot = rt.state?.bots?.[botId]
  if (bot?.id !== botId || rt.botOf(botId) !== bot) return 'not-found'
  const session = rt.chatOf(botId)
  if (typeof session !== 'string' || session === '') return 'not-found'
  const binding = reader.bindingOf(botId)
  if (binding === undefined) return 'not-shown'
  const project = binding.listed ? binding.project : bot.project
  if (typeof project !== 'string' || project === '') return 'global'
  if (!binding.picked(project, binding.machine)) return 'not-shown'
}

function ownMemory(rt, reader) {
  return {
    enabled: () => rt.memoryEnabled === true
      && [rt.refreshShellChoice, rt.holdsLock, rt.readOnly, rt.isPrivate].every(fn => typeof fn === 'function')
      && ['read', 'edit', 'add'].every(method => typeof rt.pocketMemory?.[method] === 'function'),
    allowed(botId) {
      if (rt.holdsLock() !== true || rt.readOnly() !== undefined || rt.memoryEnabled !== true) return 'unavailable'
      const reason = ownShownBot(rt, reader, botId)
      if (reason !== undefined) return reason
      return rt.isPrivate(botId) ? 'private' : undefined
    },
    run: (method, args) => rt.pocketMemory[method]({ ...args, refresh: () => rt.refreshShellChoice() }),
  }
}

function ownSchedules(rt, reader) {
  return {
    available: () => rt.pocketSchedules?.available() === true,
    writable: () => rt.pocketSchedules?.writable() === true,
    allowed(botId, scheduleAvailable) {
      if (rt.holdsLock() !== true || rt.readOnly() !== undefined || !scheduleAvailable || rt.pocketSchedules?.available() !== true) return 'unavailable'
      return ownShownBot(rt, reader, botId)
    },
    run: (method, args) => rt.pocketSchedules[method]({ ...args, refresh: () => rt.refreshShellChoice() }),
  }
}

/**
 * Wire the source when the runtime has DSH 0.2.2's Session API and the team has a home; else
 * register nothing (the source is absent, and Pocket Link lists no DSH chats). With DSH's prompt
 * and cancel too, the answerer listeners are wired and the source takes writes; they reach DSH
 * only through a socket subscription (pocket-socket.js), never as a tool or for an automation.
 */
export function install(rt) {
  const { ctx } = rt
  const controller = ctx.get?.('sessionController') ?? ctx.sessionController
  if (!hasSessionApi(controller) || typeof rt.home !== 'string' || process.platform === 'win32') return
  const writable = hasWriteApi(controller)
  let source
  if (writable) {
    // Ahead of the computer's own answerer, which holds the request until someone answers; both
    // listeners pass every request on at once, so the computer is never held up.
    ctx.on('approval/request', (request, next) => (source ? source.raceApproval(request, next) : next()), { prepend: true })
    ctx.on('user-questions/request', (request, next) => (source ? source.raceQuestion(request, next) : next()), { prepend: true })
  }
  const chatOwner = (sessionId) => {
    const botId = rt.chatOwners?.get?.(sessionId)
    return botId !== undefined && rt.chatOf?.(botId) === sessionId ? botId : undefined
  }
  ctx.effect(() => {
    let socket
    let stopped = false
    const started = (async () => {
      const { createAdapter } = await import('./pocket-chat-adapter.js')
      if (stopped) return
      const reader = shownReader({ path: rt.registryPath ?? homeRegistryPathOf(), warn: (...args) => rt.warn?.(...args) })
      source = new DshChatSource({
        adapter: createAdapter(controller), bots: ownBots(rt, reader), shown: reader.shown, registryIdOf: reader.registryIdOf,
        log: (...args) => rt.warn?.(...args), writable, chatOwner, management: ownMemory(rt, reader),
        schedules: ownSchedules(rt, reader),
        stopOf: (id, turn) => rt.stopLineOfTurn?.(id, turn),
        carriesSignInCode: text => rt.loginTextMatches?.(text) === true,
      })
      socket = await startPocketSocket({ home: rt.home, source, log: (...args) => rt.warn?.(...args) })
      if (stopped) await socket.close()
    })().catch(error => rt.warn?.('omni-ui: Pocket chat is off: %s', error?.message ?? error))
    return async () => {
      stopped = true
      await started
      const closing = source
      source = undefined
      closing?.close()
      await socket?.close()
    }
  }, 'ds-bot: pocket chat')
}
