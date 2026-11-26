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
// - Each live Bot's own current chat Session. No task or archived Sessions, no subagents
//   (a Session whose header says `origin: 'subagent'` is refused). A project Bot is
//   served only with the person's yes for its project (`shown`, the home file's `shown[]`, read
//   by shown.js); global Bots need none. A Bot's project and machine are its home-file folder and
//   machine; a Bot the home file does not list is global.
// - Since RFC 0040 the team's eligible group chats are also served, to connections that
//   negotiate `groups: 1` (pocket-groups.js).
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
// - RFC 0033 adds per-watch image and document uploads and queued sends with receipts.
//   Rich watches get file metadata and image thumbnail reads. Documents have a separate
//   per-watch grant, and attachment services are looked up on demand.
// - With RFC 0036 management, a live phone grant can read, edit or add a shown project Bot's
//   own memory, manage its own scheduled tasks, and change its name and model without a chat
//   subscription. Its permission level is shown read-only. Each check uses the current team lock
//   and one fresh home registry snapshot.
import { chatPersonParts, personParts, SKILL_NOTICE, SKILL_TOOL } from './skill-message.js'
import { SKILL_ACTIVITY_RECORD, skillActivityOf } from '../shared/skill-activity.js'
import { randomUUID } from 'node:crypto'
import { isSandboxGrant } from '../shared/hermes-consent.js'
import { isBotId } from '../shared/registry.js'
import { guardGroupText, guardOffNoticeOf } from '../shared/guard-groups.js'
import { TEAM_LOOKUPS, teamToolOf } from './approvals.js'
import { ATTACH_REQUEST_PREFIX, THUMBNAILS, attachmentCode, effectiveAttachments, positiveInt, sanitizeAttachmentName, validId } from './pocket-attach.js'
import { startPocketSocket } from './pocket-socket.js'
import { pocketSettingsOf } from './pocket-settings.js'
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
export const botIdOf = terminal => (typeof terminal === 'string' && terminal.startsWith(TERMINAL_PREFIX) && terminal.length > TERMINAL_PREFIX.length && !terminal.startsWith('dsh:room:')
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

const imageType = type => ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type)
const mediaPart = part => part?.type === 'image' || part?.type === 'file'

function blocksOf(content) {
  if (!Array.isArray(content) || !content.some(mediaPart)) return
  const blocks = []
  let media = 0
  let textLeft = TEXT_MAX
  // Bound the JSON overhead from many short blocks as well as the text they contain.
  let jsonLeft = PAGE_BYTES / 2
  for (const [block, part] of content.entries()) {
    if (part?.type === 'text' && typeof part.text === 'string' && textLeft > 0 && jsonLeft > 0) {
      const text = part.text.slice(0, textLeft)
      const projected = { type: 'text', text }
      jsonLeft -= bytes(JSON.stringify(projected)) + 1
      if (jsonLeft >= 0 && text) {
        blocks.push(projected)
        textLeft -= text.length
      }
    }
    if (!mediaPart(part)) continue
    if (++media > 16) continue
    const ref = part.attachment
    if (part.type === 'image') {
      if (imageType(ref?.mediaType) && positiveInt(ref.width) && positiveInt(ref.height)) {
        blocks.push({ type: 'image', block, mediaType: ref.mediaType, width: ref.width, height: ref.height })
      }
    } else if (ref && Number.isSafeInteger(ref.bytes) && ref.bytes >= 0) {
      const name = sanitizeAttachmentName(ref.name)
      blocks.push({ type: 'file', block, ...(name === undefined ? {} : { name }), bytes: ref.bytes })
    }
  }
  if (media > 16) blocks.push({ type: 'more', count: media - 16 })
  return blocks
}

const legacyVisible = row => !(row.kind === 'text' && row.blocks && row.text.trim() === '')
const legacyRows = rows => rows.filter(legacyVisible).map(row => {
  if (!row.blocks) return row
  const { blocks, ...legacy } = row
  return legacy
})
const rowsFor = (rows, attachments) => attachments ? rows : legacyRows(rows)

/**
 * The Pocket rows one committed Session event makes (Pocket Link chat/types.js row kinds).
 * `scope` carries what the fold needs across events: the open turn and the tool-call rows by call id.
 * @param {{ type: string, seq: number, time?: number, data?: any }} event
 * @param {{ sessionId: string, turn: number, calls: Map<string, string>, stopOf?: (turn: number) => string | undefined }} scope
 */
export function rowsOf(event, scope) {
  const data = event?.data ?? {}
  if (!Number.isSafeInteger(event?.seq)) return []
  const base = part => ({ id: rowIdOf(scope.sessionId, event.seq, part), turn: scope.turn, at: Number.isFinite(event.time) ? event.time : null, source: 'session' })
  if (event.type === SKILL_ACTIVITY_RECORD) {
    const activity = skillActivityOf(event)
    return activity === undefined || activity.roomId !== undefined || scope.hidden?.(activity.turn)
      ? [] : [{ ...base(), turn: activity.turn ?? 0, kind: 'tool-call', tool: 'Skill', summary: activity.name, input: '', output: '' }]
  }
  if (Number.isInteger(data.turn)) scope.turn = data.turn
  switch (event.type) {
    case 'user/message': {
      if (data.source?.kind === SKILL_NOTICE) {
        return [{ ...base(), kind: 'status', state: 'notice', msg: cut(textOf(data.content), PREVIEW_MAX) }]
      }
      // A person's prompt only: injected context (file notices, skills, reminders) is not chat.
      if (data.role !== 'user' || data.source?.kind !== 'user') return []
      const content = chatPersonParts(data)
      const text = textOf(content)
      const blocks = blocksOf(content)
      return text.trim() || blocks
        ? [{ ...base(), kind: 'text', role: 'user', text: text.trim() ? cut(text, TEXT_MAX) : '', ...(blocks ? { blocks } : {}) }]
        : []
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
      if (data.name === SKILL_TOOL || data.name === `mcp__dsh__${SKILL_TOOL}`) {
        scope.calls.set(data.callId, null)
        return []
      }
      const row = { ...base(), kind: 'tool-call', tool: String(data.name ?? ''), summary: String(data.name ?? ''), input: cut(typeof data.arguments === 'string' ? data.arguments : '', PREVIEW_MAX) }
      if (typeof data.callId === 'string') scope.calls.set(data.callId, row.id)
      return [row]
    }
    case 'tool/result': {
      const message = data.message ?? {}
      if (scope.calls.get(message.toolCallId) === null || (Array.isArray(message.content) &&
          message.content.some(part => part?.automagikSkill?.use === 'load'))) return []
      const call = scope.calls.get(message.toolCallId) ?? null
      return [{ ...base(), kind: 'tool-result', call, ok: message.isError !== true, output: cut(textOf(personParts(message.content)), PREVIEW_MAX) }]
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

// The Android question card shows only prompt and options. A sandbox grant must
// carry its full scope there, including the target and any remote context.
function pocketQuestionPrompt(question) {
  if (!question) return null
  const title = String(question.question ?? '')
  if (!isSandboxGrant(question)) return cut(title, PREVIEW_MAX)
  if (!title || typeof question.detail !== 'string' || !question.detail.trim()) return null
  const full = `${title}\n${question.detail}`
  return bytes(full) <= PREVIEW_MAX ? full : null
}

/** The newest rows that fit one page. */
export function pageOf(rows, limit = PAGE_ROWS, reservedBytes = 0) {
  const out = []
  let bytes = reservedBytes
  for (let i = rows.length - 1; i >= 0 && out.length < limit; i--) {
    const size = Buffer.byteLength(JSON.stringify(rows[i]))
    if (bytes + size > PAGE_BYTES) break
    bytes += size
    out.unshift(rows[i])
  }
  return out
}

const seqOf = row => cursorOf(row?.id)?.seq ?? -1

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
 *   fileUploads?: () => any, attachmentStore?: () => any,
 *   groups?: import('./pocket-groups.js').GroupSource,
 *   stopOf?: (sessionId: string, turn: number) => string | undefined,
 *   turnHidden?: (sessionId: string, turn: number) => boolean,
 *   guardOffOf?: (botId: string, sessionId: string) => { id: string, at: number, text: string } | undefined,
 *   carriesSignInCode?: (text: string) => boolean, switching?: (botId: string) => boolean }} options
 */
export class DshChatSource {
  constructor({ adapter, bots, timers = realTimers, pollMs = STATE_POLL_MS, listMs = LIST_STATE_MS, keep = KEEP_ROWS, maxFollowed = MAX_FOLLOWED, log = () => {}, writable = false, shown = globalOnly, registryIdOf = () => null, chatOwner, now = Date.now, carriesSignInCode = () => false, stopOf = () => undefined, guardOffOf = () => undefined, turnHidden = () => false, management, schedules, settings, fileUploads, attachmentStore, groups, switching = () => false }) {
    Object.assign(this, { adapter, bots, timers, pollMs, listMs, keep, maxFollowed, log, shown, registryIdOf, now, stopOf, guardOffOf, turnHidden, fileUploads, attachmentStore })
    /** Whether a Bot's own chat is switching agents (parts.js): a send then waits, as queued. Never throws. */
    this.switching = (botId) => { try { return switching(botId) === true } catch { return false } }
    /** Whether a text carries a Claude sign-in code the computer showed (cli-login.js). Never throws. */
    this.carriesSignInCode = (text) => { try { return carriesSignInCode(text) === true } catch { return false } }
    /** Writes need the adapter's prompt and cancel, and the answerer listeners wired (install). */
    this.writable = writable === true && typeof adapter?.prompt === 'function' && typeof adapter?.cancel === 'function'
    this.management = management
    this.schedules = schedules
    this.settings = settings
    this.groups = groups
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

  get groupsOffer() { return this.writable && this.groups?.available() === true }

  attachmentServices() {
    if (!this.writable || this.adapter.supportsReceipts !== true) return
    try {
      const uploads = this.fileUploads?.()
      const store = this.attachmentStore?.()
      if (typeof uploads?.uploadImageStream === 'function' && typeof store?.readImageRequest === 'function') {
        return { uploads, store, effective: effectiveAttachments(store.imageLimits, typeof uploads.uploadStream === 'function') }
      }
    } catch {}
  }

  attachmentOffer() { return this.attachmentServices()?.effective }
  get attachments() { return this.attachmentOffer() !== undefined }

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

  get managesSettings() {
    return this.writable && this.settings?.enabled() === true
  }

  settingsAllowed(botId) {
    return this.settings.allowed(botId)
  }

  manageSettings(method, args) {
    return this.settings.run(method, args)
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
  async watch(terminal, listener, { after, attachments = false, documents = false } = {}) {
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
    const subscription = { listener, attachments }
    entry.listeners.add(subscription)
    const live = this.writable ? [...(this.open.get(entry.sessionId)?.values() ?? [])].map(request => request.row) : []
    const snapshot = await this.snapshotFor(entry, after, attachments)
    snapshot.rows = await this.visibleRows(entry, snapshot.rows)
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
      close: () => { closed = true; writes.abort(new Error('the phone left this chat')); this.leave(entry, subscription) },
      backfill: (before, limit) => this.backfill(entry, before, limit, attachments),
    }
    if (this.writable) {
      const live_ = () => !closed && !entry.gone
      Object.assign(handle, {
        send: (message, uploads, scope) => this.send_(entry, live_, writes.signal, message, uploads,
          attachments && scope ? { ...scope, documents, entry, sessionId: entry.sessionId, live: live_ } : undefined),
        interrupt: () => this.interrupt_(entry, live_),
        answer: message => this.answer_(entry, live_, message),
      })
      if (attachments) {
        const signal = AbortSignal.any([writes.signal, entry.controller.signal])
        handle.attach = (method, params, uploads, scope, reply) => this.attach_(
          method, params, uploads, { ...scope, documents, entry, sessionId: entry.sessionId, live: live_, signal }, reply)
      }
    }
    return handle
  }

  open_(bot) {
    const controller = new AbortController()
    const entry = {
      botId: bot.id, sessionId: bot.sessionId, controller, listeners: new Set(), rows: [], floorSeq: 0, mediaFloorSeq: 0, cursor: -1,
      scope: this.rowScope(bot.sessionId), status: statusOf(null), approval: null, question: null, poller: null, gone: false,
    }
    entry.ready = this.start(entry)
    return entry
  }

  rowScope(sessionId, calls) {
    return { sessionId, turn: 0, calls: new Map(calls), stopOf: turn => this.stopOf(sessionId, turn),
      hidden: turn => this.turnHidden(sessionId, turn) }
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
    entry.mediaFloorSeq = entry.floorSeq
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
    let legacy = entry.rows.reduce((total, row) => total + Number(legacyVisible(row)), 0)
    if (legacy > this.keep) {
      let trim = 0
      while (legacy > this.keep) legacy -= Number(legacyVisible(entry.rows[trim++]))
      entry.rows.splice(0, trim)
      entry.floorSeq = seqOf(entry.rows.find(legacyVisible))
      entry.mediaFloorSeq = Math.max(entry.mediaFloorSeq, seqOf(entry.rows[0]))
    }
    // Media-only history may fill the extra window, but never displace a legacy row.
    let extra = entry.rows.length - 2 * this.keep
    if (extra > 0) entry.rows = entry.rows.filter(row => {
      if (extra === 0 || legacyVisible(row)) return true
      extra--
      entry.mediaFloorSeq = Math.max(entry.mediaFloorSeq, seqOf(row) + 1)
      return false
    })
  }

  async pump(entry, stream) {
    try {
      for (;;) {
        const { value: frame, done } = await stream.next()
        if (done || entry.gone) break
        if (frame?.type !== 'event' || !Number.isSafeInteger(frame.event?.seq)) continue
        if (frame.event.type === SKILL_ACTIVITY_RECORD && frame.event.seq <= entry.cursor) continue
        entry.cursor = frame.event.seq
        this.noteRequestId(entry.sessionId, frame.event)
        const rows = rowsOf(frame.event, entry.scope)
        if (rows.length) {
          this.keepRows(entry, rows)
          const visible = frame.event.type === SKILL_ACTIVITY_RECORD ? await this.visibleRows(entry, rows) : rows
          if (visible.length) this.emit(entry, { type: 'rows', rows: visible })
        }
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
  async snapshotFor(entry, after, attachments = false) {
    const base = { type: 'snapshot', screen: [], status: entry.status, approval: entry.approval, held: [] }
    const retained = rowsFor(entry.rows, attachments).filter(row => row.tool !== 'Skill' || !this.turnHidden(entry.sessionId, row.turn))
    const floor = attachments ? entry.mediaFloorSeq : entry.floorSeq
    const notice = this.guardOffRow(entry)
    const page = (rows) => {
      if (notice === undefined) return pageOf(rows)
      const result = pageOf(rows, PAGE_ROWS - 1, bytes(JSON.stringify(notice)))
      const next = result.findIndex(row => row.at > notice.at)
      result.splice(next === -1 ? result.length : next, 0, notice)
      return result
    }
    const latest = { ...base, reset: Boolean(after), rows: page(retained) }
    // A roster notice has no event seq. Resume with the latest page and let the stable
    // row ids merge into the phone's existing history.
    if (!after || after === notice?.id) return { ...latest, reset: false }
    const cursor = cursorOf(after)
    if (!cursor || cursor.sessionId !== entry.sessionId || cursor.seq > entry.cursor) return latest
    if (cursor.seq >= floor - 1) return { ...base, reset: false, rows: page(retained.filter(row => seqOf(row) > cursor.seq)) }
    let older
    try { older = await this.adapter.events(entry.sessionId, { beforeSeq: floor, maxMessages: PAGE_ROWS }, entry.controller.signal) } catch { return latest }
    const records = Array.isArray(older?.records) ? older.records : []
    if (!records.length || records[0].event.seq > cursor.seq + 1) return latest
    const scope = this.rowScope(entry.sessionId, entry.scope.calls)
    const missed = records.filter(record => record.event.seq > cursor.seq && (!attachments || record.event.seq < floor)).flatMap(record => rowsOf(record.event, scope))
    const current = retained
    const rows = [...rowsFor(missed, attachments), ...(attachments ? current.filter(row => seqOf(row) >= floor) : current)]
    // Everything missed must fit one page; otherwise the phone starts over from the latest page.
    return rows.length + Number(notice !== undefined) > PAGE_ROWS ? latest : { ...base, reset: false, rows: page(rows) }
  }

  guardOffRow(entry) {
    const notice = this.guardOffOf(entry.botId, entry.sessionId)
    if (notice === undefined) return
    return { id: rowIdOf(entry.sessionId, 0, notice.id), at: notice.at, turn: 0,
      source: 'session', kind: 'status', state: 'idle', msg: cut(notice.text, PREVIEW_MAX) }
  }

  /** Rows before a row id, newest last: at most `limit`, read from the log (cold-safe). */
  async backfill(entry, before, limit = 50, attachments = false) {
    const cursor = cursorOf(before)
    if (!cursor || cursor.sessionId !== entry.sessionId || entry.gone) return []
    const max = Math.min(Math.max(1, Number.isInteger(limit) ? limit : 50), PAGE_ROWS)
    const notice = this.guardOffRow(entry)
    const beforeSeq = before === notice?.id
      ? seqOf(pageOf(rowsFor(entry.rows, attachments), PAGE_ROWS - 1, bytes(JSON.stringify(notice)))[0])
      : cursor.seq
    if (beforeSeq < 0) return []
    const page = await this.adapter.events(entry.sessionId, { beforeSeq, maxMessages: max }, entry.controller.signal)
    const scope = this.rowScope(entry.sessionId)
    const rows = (page?.records ?? []).filter(record => record.event.seq < beforeSeq).flatMap(record => rowsOf(record.event, scope))
    return pageOf(await this.visibleRows(entry, rowsFor(rows, attachments)), max)
  }

  async visibleRows(entry, rows) {
    if (!rows.some(row => row.tool === 'Skill')) return rows
    let served = false
    try { served = (await this.stillServed(entry)) === null && !entry.gone } catch {}
    return rows.filter(row => row.tool !== 'Skill' || served && !this.turnHidden(entry.sessionId, row.turn))
  }

  emitTo(listener, event) { try { listener(event) } catch {} }
  emit(entry, event) {
    const legacy = event.type === 'rows' ? legacyRows(event.rows) : undefined
    for (const subscription of entry.listeners) {
      // A bare function is a listener without the attachment opt-in (callers outside watch()).
      const { listener, attachments } = typeof subscription === 'function' ? { listener: subscription, attachments: false } : subscription
      if (!attachments && legacy) {
        if (legacy.length) this.emitTo(listener, { ...event, rows: legacy })
      } else this.emitTo(listener, event)
    }
  }
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
    if (requestId.startsWith(ATTACH_REQUEST_PREFIX)) return
    const ids = this.sent.get(sessionId) ?? []
    if (!ids.includes(requestId)) ids.push(requestId)
    if (ids.length > KEEP_SENT_IDS) ids.splice(0, ids.length - KEEP_SENT_IDS)
    this.sent.set(sessionId, ids)
  }

  /** Whether the Bot this chat follows is still served, on the Session the chat follows. */
  async stillServed(entry, moved = 'not-watching') {
    const bot = (await this.bots()).find(item => item.id === entry.botId)
    if (!bot) return 'not-watching'
    if (bot.sessionId !== entry.sessionId) return moved
    if (this.shown(bot) !== true) return 'not-shown'
    return null
  }

  async attachmentGate(scope, uploads, moved) {
    const reason = await this.stillServed(scope.entry, moved)
    if (reason && scope.live()) uploads.revokeEntry(scope.entry, reason)
    return reason
  }

  attach_(method, params, uploads, scope, reply) {
    const authorize = () => this.attachmentGate(scope, uploads)
    switch (method) {
      case 'upload-begin':
        return uploads.begin(params, scope, this.attachmentServices(), authorize, this.carriesSignInCode)
      case 'upload-chunk':
        return uploads.chunk(params, scope, reply)
      case 'upload-finish':
        return uploads.finish(params, scope, authorize)
      case 'upload-cancel':
        return uploads.cancel(params, scope)
      case 'attachment-read':
        return this.readAttachment(scope, params, uploads, authorize, reply)
    }
  }

  readAttachment(scope, { row, block }, uploads, authorize, reply) {
    const { entry, sessionId, live, signal } = scope
    const cursor = cursorOf(row)
    if (!cursor || row.includes('#') || rowIdOf(cursor.sessionId, cursor.seq) !== row || !Number.isSafeInteger(cursor.seq + 1)
      || !Number.isSafeInteger(block) || block < 0) return refused('invalid')
    if (cursor.sessionId !== sessionId || !live()) return refused('not-watching')
    if (cursor.seq > entry.cursor) return refused('not-found')
    return uploads.read(signal, async (active) => {
      const gate = await authorize()
      if (gate) return refused(gate)
      active.throwIfAborted()
      const store = this.attachmentServices()?.store
      if (!store) return refused('unavailable')
      const page = await this.adapter.events(sessionId, { beforeSeq: cursor.seq + 1, maxMessages: 1 }, active)
      active.throwIfAborted()
      const event = page?.records?.find(record => record.event?.seq === cursor.seq)?.event
      const projection = rowsOf(event, { sessionId, turn: 0, calls: new Map() })
      if (!projection.some(row => row.blocks?.some(part => part.type === 'image' && part.block === block))) return refused('not-found')
      const ref = event.data.content[block].attachment
      for (const { edge, bytes } of THUMBNAILS) {
        const thumbnail = await store.readImageRequest(ref, { width: edge, height: edge, maxBytes: bytes }, active)
        active.throwIfAborted()
        const { data, mediaType, width, height } = thumbnail ?? {}
        if (!(data instanceof Uint8Array) || data.byteLength === 0 || !imageType(mediaType) || !positiveInt(width) || !positiveInt(height)) return refused('unavailable')
        if (data.byteLength > bytes || width > edge || height > edge) continue
        const encoded = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64')
        const gate = await authorize()
        if (gate) return refused(gate)
        active.throwIfAborted()
        if (!live()) return refused('revoked')
        // Check authority and emit the thumb in the same turn, before a channel can be reused.
        reply({ ok: true, mediaType, width, height, data: encoded })
        return
      }
      return refused('too-large')
    })
  }

  async sendAttachments(entry, signal, { id, text = '', uploads: ids }, uploads, scope) {
    const refuse = (reason, extra) => refused(reason, { id, ...extra })
    if (!scope || !uploads || !validId(id) || typeof text !== 'string' || !Array.isArray(ids)
      || ids.length < 1 || ids.length > 4 || !ids.every(validId) || new Set(ids).size !== ids.length) return refuse('invalid')
    if (!scope.live() || signal.aborted) return refuse('not-watching')
    if (bytes(text) > SEND_TEXT_MAX) return refuse('too-long')
    const cleanedText = cleanChatText(text).text ?? ''
    if (text && this.carriesSignInCode(text)) {
      this.log('pocket chat: a send carried a sign-in code and was not sent')
      return refuse('invalid', { message: 'sign-in-code' })
    }
    const prepare = () => uploads.prepare(scope, id, cleanedText, ids, () => this.attachmentOffer())
    const initial = prepare()
    if (initial.reason) return refuse(initial.reason)
    let running = entry.running === true
    try { running = (await this.adapter.state(entry.sessionId, signal))?.running === true } catch {}
    const gate = await this.attachmentGate(scope, uploads, 'session-changed')
    if (gate) return refuse(gate)
    if (!scope.live() || signal.aborted) return refuse('revoked')
    // State and authority reads can race cancellation, expiry and other watches' sends.
    const { reason, manifest, repeat } = prepare()
    if (reason) return refuse(reason)
    try {
      if (!repeat) uploads.recordManifest(manifest)
    } catch {
      this.log('pocket upload: refused')
      return refuse('unavailable')
    }
    try {
      const result = await this.adapter.prompt(entry.sessionId, {
        requestId: manifest.requestId, text: cleanedText, receipts: manifest.receiptIds,
      }, signal)
      if (result?.accepted !== true) throw new Error('Pocket send refused')
    } catch (error) {
      this.log('pocket chat: a send was not accepted')
      if (signal.aborted) return refuse('revoked')
      const code = attachmentCode(error, true)
      if (code === 'FILE_NOT_STAGED') return refuse('expired', { code })
      return code ? refuse('rejected', { code }) : refuse('offline')
    }
    uploads.consume(scope, manifest)
    return { ok: true, state: running ? 'queued' : 'sent', id, ...(repeat ? { repeat: true } : {}) }
  }

  /**
   * A prompt to the Bot's current chat Session, queued behind a running turn (never `steer`).
   * A known id is answered `sent` and prompts nothing: this memory, the Session log the follow
   * read, and DSH's own check (it skips a prompt whose request id the inbox or log holds).
   */
  async send_(entry, live, signal, message, uploads, scope) {
    if (message && Object.hasOwn(message, 'uploads')) return this.sendAttachments(entry, signal, message, uploads, scope)
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
    // During an agent switch the message waits for the new agent, behind the handoff.
    if (entry.botId !== undefined && this.switching(entry.botId)) running = true
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
    const prompt = pocketQuestionPrompt(one)
    const options = (one?.options ?? []).map(option => String(option?.label ?? ''))
    const row = {
      id: requestRowId(sessionId, this.cursorOfSession(sessionId), 'question', callId), turn: this.turnOfSession(sessionId), at: this.now(), source: 'session', kind: 'question',
      prompt: prompt ?? ANSWER_ON_COMPUTER, options: prompt === null ? [] : options, multi: one?.multiSelect === true,
      ...(isSandboxGrant(one) ? { fixedOptions: true } : {}),
      answerable: prompt !== null && typeof one?.id === 'string', open: true, call: typeof request.wait?.callId === 'string' ? request.wait.callId : null,
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
    if (request.row.multi || isSandboxGrant(question) || text === undefined) return { ok: false, reason: 'invalid' }
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

// A Bot the home file lists with a folder takes that project and machine. When the file
// cannot be read, a registry Bot's place stays unknown and it is withheld.
export function placedBot(_rt, places, bot) {
  const own = { id: bot.id, name: typeof bot.name === 'string' ? bot.name : '' }
  if (places === null && isBotId(bot.id)) return { ...own, project: null, placeUnknown: true }
  const place = places?.get(bot.id)
  if (place) return { ...own, project: place.folder, ...(place.machine !== undefined ? { machine: place.machine } : {}) }
  return { ...own, project: typeof bot.project === 'string' ? bot.project : null }
}

export function pocketGuardOffOf(rt, botId, sessionId) {
  if (rt.chatOf(botId) !== sessionId) return
  const bot = rt.botOf(botId)
  const notice = guardOffNoticeOf(bot, sessionId)
  if (notice !== undefined) {
    return { ...notice, text: guardGroupText('off', { name: bot.name }, rt.uiLocale?.()) }
  }
}

// The team's live Bots with their current own-chat Sessions.
export function ownBots(rt, reader) {
  return async () => {
    await rt.load?.()
    const places = reader ? reader.places() : new Map()
    const bots = Object.values(rt.state?.bots ?? {})
    return bots
      .filter(bot => typeof bot?.id === 'string' && rt.botOf(bot.id) === bot)
      .map((bot) => {
        const { id, name, ...place } = placedBot(rt, places, bot)
        return { id, name, sessionId: rt.chatOf(id), ...place }
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

function ownSettings(rt, reader) {
  const { enabled, readable, run } = pocketSettingsOf(rt)
  return {
    enabled,
    allowed(botId) {
      if (!enabled() || !readable()) return 'unavailable'
      return ownShownBot(rt, reader, botId)
    },
    run,
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
  const lineListeners = new Set()
  const carriesSignInCode = (text) => {
    try { return rt.loginTextMatches?.(text) === true } catch { return false }
  }
  const log = (...args) => rt.warn?.(...args)
  let source
  if (writable) {
    rt.roomLineAdded = (room, record) => {
      for (const listener of lineListeners) {
        try { listener(room, record) } catch {}
      }
    }
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
    let groups
    let stopped = false
    const started = (async () => {
      const { createAdapter } = await import('./pocket-chat-adapter.js')
      const GroupSource = writable ? (await import('./pocket-groups.js')).GroupSource : undefined
      if (stopped) return
      const reader = shownReader({ path: rt.registryPath ?? homeRegistryPathOf(), warn: log })
      if (GroupSource !== undefined) {
        groups = new GroupSource({ rt, reader, lines: lineListeners, log, carriesSignInCode })
        if (groups.available()) groups.start()
      }
      source = new DshChatSource({
        adapter: createAdapter(controller), bots: ownBots(rt, reader), shown: reader.shown, registryIdOf: reader.registryIdOf,
        log, writable, chatOwner, management: ownMemory(rt, reader), groups,
        schedules: ownSchedules(rt, reader), settings: ownSettings(rt, reader),
        fileUploads: () => ctx.get?.('fileUploads'), attachmentStore: () => ctx.get?.('attachments'),
        stopOf: (id, turn) => rt.stopLineOfTurn?.(id, turn),
        turnHidden: (id, turn) => (rt.state?.exchangeTurns?.[id] ?? []).includes(turn),
        guardOffOf: (botId, sessionId) => pocketGuardOffOf(rt, botId, sessionId),
        carriesSignInCode,
        switching: botId => Boolean(rt.switchingChat?.(botId, { crossing: true })),
      })
      socket = await startPocketSocket({ home: rt.home, source, log })
    })().catch((error) => {
      groups?.close()
      rt.warn?.('omni-ui: Pocket chat is off: %s', error?.message ?? error)
    })
    return async () => {
      stopped = true
      await started
      const closing = source
      source = undefined
      groups?.close()
      closing?.close()
      await socket?.close()
    }
  }, 'ds-bot: pocket chat')
}
