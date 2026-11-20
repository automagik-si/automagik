// The chat route's second source (#517): the Automagik Bots' own chats, read from the bots-dsh
// plugin over its Unix socket, `<team home>/pocket/chat.sock` (bots-dsh
// src/host/pocket-socket.js). It sits beside the terminal engine: Claude, Codex and omp terminals
// keep the transcript > status > screen sources, untouched; a `dsh:<botId>` chat comes from here.
//
// A DSH chat can be listed, subscribed and paged. Writes (RFC 0015, Amendments, "writes on
// `dsh:<botId>` chats"): the bridge asks for them in its `hello` (`{write: 1}`); a socket that
// answers `readOnly: false, write: 1` gets chat.send, chat.interrupt and chat.answer as its send,
// interrupt and answer, each on the channel this connection subscribed to that chat, each with the
// paired phone's `by` (its name, devices.json) and `phone` (its paired key, the one guard.mjs
// admitted), both set here and never by the phone, so the socket counts its caps per phone too.
// A connection with no paired key writes nothing (`read-only`). A socket that
// answers `readOnly: true` (an older plugin) gets none: every write is refused `read-only`, as
// before writes. chat.sendHeld and chat.cancelHeld are always refused (a DSH Session holds no
// draft). The socket's answers come back unchanged, its refusals as `refused` with its reason
// (rate, busy, not-watching, not-shown, settled with its receipt, changed...). The bridge counts
// too: one write in flight per phone and chat (`busy`), WRITES_PER_MINUTE per phone and one
// interrupt per chat every INTERRUPT_MS (`rate`). A closed subscription (the phone hung up, or was
// removed and revoke ended it) writes nothing. Plain Node only (no dependency, the bridge's Node floor).
//
// A writable socket gets a second hello asking for memory, schedules and settings (RFC 0036). A phone
// opts in at chat hello and gets one grant, tied to its connection and team home. Closing
// the grant needs an ack in 500 ms; otherwise the socket is dropped.
// Settings writes are offered only with settings.read.
//
// RFC 0033 adds an opt-in on both socket hellos, at phone hello, and on each DSH watch.
// An upload belongs to that phone, connection and watch until it settles. The socket grants
// chunk credit as it takes the bytes. The bridge bounds pending writes, rebuilds replies from
// the attachment protocol's fields, and requires an unsubscribe ack when a rich watch closes.
// A lost finish ack leaves admission unknown. Begin ids are remembered in memory: after a
// bridge restart, a compensating cancel for a reused id can only reach that phone's own upload.
// The 65 s finish deadline covers the socket's authority check and its 60 s admission.
//
// Absent is empty: no socket, a socket another account could reach, or one that answers neither
// `readOnly: true` nor `readOnly: false, write: 1`, and the source lists nothing and opens nothing.
//
// Where the socket is (#548). The bridge tries the team homes below in order and uses the first
// whose pocket/chat.sock passes ownerOnly; a folder that exists is not enough. It never searches
// elsewhere: a team kept anywhere else is not seen, and with no such socket it stays absent.
//   1. $AUTOMAGIK_BOTS_HOME, when the bridge's own environment sets it;
//   2. <Automagik home>/desktop/bots: the desktop app's team (apps/desktop dsh.js gives the DSH it
//      runs AUTOMAGIK_BOTS_HOME there; the bridge's login service does not see that variable);
//   3. <Automagik home>/bots: a team installed into a dsh the person runs (bots-dsh's default).
// The Automagik home is $AUTOMAGIK_HOME, else ~/.automagik. HERDR_APP_HOME does not enter it (it
// moves only the bridge's state folder, state.mjs).
import { lstatSync, realpathSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ATTACH_METHODS, cutRow, MANAGE_METHODS, MAX_REQUEST, memoryRefused, page, phoneId } from './chat.mjs'

export const PREFIX = 'dsh:'
export const ANSWER_ON_COMPUTER = 'Answer on the computer'
/** One answer at most, in milliseconds. */
export const REQUEST_MS = 5000
/** Allow time for admission and model selection within the phone's 30 s deadline. */
export const SETTINGS_WRITE_MS = 25_000
/** One line from the socket at most (a snapshot page is about 1 MiB); past it, the socket is dropped. */
export const MAX_LINE = 8 * 1024 * 1024
/** Writes one paired phone may make in a minute, across its connections and chats (RFC 0015, Limits). */
export const WRITES_PER_MINUTE = 20
/** One interrupt per phone and chat in this many milliseconds. */
export const INTERRUPT_MS = 5000
/** The socket's write methods, by chat.* method. */
const WRITE_METHODS = { send: 'send', interrupt: 'interrupt', answer: 'answer' }
const CLOSE_MS = 500
const READS_PER_MINUTE = 60
const MANAGE_TEXT_MAX = 4096
const MEMORY_ID = /^[A-Za-z0-9_-]{1,32}$/
const MANAGE_REV = /^[0-9a-f]{16}$/
const SCHEDULE_ID = /^schedule-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SCHEDULE_ALIAS = /^x[0-9a-f]{16}$/
const SETTINGS_WRITES = ['settings.name', 'settings.model']
// Match the host's MODEL_REF_OK field check.
const modelRef = (model) => {
  if (typeof model !== 'string' || /[\u0000-\u001f\u007f]/.test(model)) return false
  const bytes = Buffer.byteLength(model)
  const slash = model.indexOf('/')
  return bytes >= 3 && bytes <= 512 && slash > 0 && slash < model.length - 1
}
const socketMethod = (method) => method.replace('.', '-')
const writableHello = (hello) => hello?.readOnly === false && hello?.write === 1
const validHello = (hello) => hello?.protocol === 1 && (hello.readOnly === true || writableHello(hello))
const socketError = (kind, written = false) => Object.assign(new Error(kind), { kind, written })
const manageOffline = (reading, written) => (!reading && written ? { ok: false, state: 'unknown', reason: 'offline' } : memoryRefused('offline'))
const emptyAck = (result) => result && typeof result === 'object' && !Array.isArray(result) && Object.keys(result).length === 0
const ATTACH_SOCKET_METHODS = ['upload-begin', 'upload-chunk', 'upload-finish', 'upload-cancel', 'attachment-read']
const UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const READ_TYPES = [...UPLOAD_TYPES, 'image/gif']
const ADMITTED_MAX = 128
const ADMITTED_MS = 15 * 60_000
const PHONE_KEY = /^[A-Za-z0-9+/=._:-]{1,256}$/
const ATTACH_LINE = 64 * 1024 - 1
const ATTACH_UNFLUSHED = 1024 * 1024
const ATTACH_MS = { begin: 5000, chunk: 25_000, finish: 65_000, read: 20_000, cancel: 5000, unsubscribe: 1000, idle: 35_000, total: 185_000 }
const realTimers = { setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: (timer) => clearTimeout(timer) }
const ATTACH_REASONS = new Set([
  'read-only', 'not-watching', 'not-shown', 'invalid', 'unsupported', 'too-large', 'busy', 'quota', 'rate',
  'rejected', 'changed', 'expired', 'session-changed', 'revoked', 'unavailable', 'not-found', 'offline', 'failed',
])
const IMAGE_CODES = new Set(['IMAGE_TOO_LARGE', 'IMAGE_TOO_MANY_PIXELS', 'IMAGE_DIMENSION_TOO_LARGE', 'UNSUPPORTED_IMAGE_TYPE', 'INVALID_IMAGE', 'timeout'])
const positiveInt = (n) => Number.isSafeInteger(n) && n > 0
const base64Length = (n) => 4 * Math.ceil(n / 3)
const lineOf = (id, method, params) => `${JSON.stringify({ id, method, params })}\n`
const canonicalBytes = (data, max) => {
  if (typeof data !== 'string' || data.length > base64Length(max) || data.length % 4 !== 0) return 0
  const decoded = Buffer.from(data, 'base64')
  return decoded.length <= max && decoded.toString('base64') === data ? decoded.length : 0
}

function attachmentOffer(hello) {
  const a = hello.attachments
  if (!writableHello(hello) || a?.version !== 1 || !Array.isArray(a.methods) || !Array.isArray(hello.methods)
    || !ATTACH_SOCKET_METHODS.every((m) => a.methods.includes(m) && hello.methods.includes(m))
    || !Array.isArray(a.mediaTypes)) return null
  const mediaTypes = UPLOAD_TYPES.filter((m) => a.mediaTypes.includes(m))
  const { fileBytes, files, messageBytes, deviceOutstanding, deviceDailyBytes, deviceDailyCount,
    chunkBytes, maxPixels, maxDimension, thumbnail } = a.limits ?? {}
  if (!mediaTypes.length || ![fileBytes, files, messageBytes, deviceOutstanding, deviceDailyBytes, deviceDailyCount,
    chunkBytes, maxPixels, maxDimension, thumbnail?.edge, thumbnail?.bytes].every(positiveInt)) return null
  const limits = {
    fileBytes: Math.min(fileBytes, 8 * 1024 * 1024), files: Math.min(files, 4), messageBytes: Math.min(messageBytes, 16 * 1024 * 1024),
    deviceOutstanding, deviceDailyBytes, deviceDailyCount, chunkBytes, maxPixels, maxDimension,
    thumbnail: { edge: Math.min(thumbnail.edge, 512), bytes: Math.min(thumbnail.bytes, 131072) },
  }
  const id = Number.MAX_SAFE_INTEGER
  const fields = { upload: 'u'.repeat(128), offset: id, data: '' }
  // Control characters are the longest JSON escapes a phone can use for a terminal or RPC id.
  const rpcId = '\0'.repeat(64)
  const chunkLine = lineOf(id, 'upload-chunk', { channel: id, phone: 'p'.repeat(256), ...fields })
  const chunkFrame = { jsonrpc: '2.0', id: rpcId, method: 'chat.attachChunk', params: { terminal: '\0'.repeat(128), ...fields } }
  const thumbnailFrame = { jsonrpc: '2.0', id: rpcId, result: { ok: true, mediaType: 'image/webp', width: 512, height: 512, data: '' } }
  if (Buffer.byteLength(chunkLine) + base64Length(chunkBytes) > ATTACH_LINE
    || Buffer.byteLength(JSON.stringify(chunkFrame)) + base64Length(chunkBytes) > MAX_REQUEST
    || Buffer.byteLength(JSON.stringify(thumbnailFrame)) + base64Length(limits.thumbnail.bytes) > MAX_REQUEST) return null
  return { mediaTypes, limits }
}

function attachmentRefusal(result, { upload, id } = {}) {
  const sending = id !== undefined
  let reason = result?.reason
  if (!ATTACH_REASONS.has(reason) && !(sending && ['empty', 'too-long'].includes(reason))) reason = 'failed'
  const code = result?.code
  const allowedCode = (reason === 'rejected' && (IMAGE_CODES.has(code) || (sending && code === 'MODEL_DOES_NOT_SUPPORT_IMAGES')))
    || (sending && reason === 'expired' && code === 'FILE_NOT_STAGED')
  if (code !== undefined && !allowedCode) reason = 'failed'
  return {
    ...memoryRefused(reason),
    ...(upload !== undefined && result?.upload === upload ? { upload } : {}),
    ...(sending ? { id } : {}),
    ...(allowedCode ? { code } : {}),
  }
}

function attachmentFailure(error, ids) {
  const reason = error.local || (error.kind === 'not-watching' && !error.written) ? error.kind : 'offline'
  return attachmentRefusal(error.detail ?? { reason }, ids)
}

export const isDsh = (terminal) => typeof terminal === 'string' && terminal.startsWith(PREFIX)
const manageTerminal = (terminal) => isDsh(terminal) && terminal.length > PREFIX.length && terminal.length <= 128

const expand = (text, home) => (text === '~' ? home : /^~[\\/]/.test(text) ? join(home, text.slice(2)) : text)

/** The team homes the socket may be in, in the order they are tried (see the top of this file). */
export function teamHomes(env = process.env, home = homedir()) {
  const automagik = env.AUTOMAGIK_HOME?.trim() ? resolve(expand(env.AUTOMAGIK_HOME.trim(), home)) : join(home, '.automagik')
  const named = env.AUTOMAGIK_BOTS_HOME?.trim() ? [resolve(expand(env.AUTOMAGIK_BOTS_HOME.trim(), home))] : []
  return [...new Set([...named, join(automagik, 'desktop', 'bots'), join(automagik, 'bots')])]
}

export const socketPaths = (env = process.env, home = homedir()) => teamHomes(env, home).map((team) => join(team, 'pocket', 'chat.sock'))

/**
 * A socket only this account reaches (#523, #548):
 * - the socket and its folder: ours, with no group or other bits at all;
 * - every folder above them, up to the root, both as written and on the real path: owned by us or
 *   by root; a link on the way must be ours or root's;
 * - none of those folders writable by others, nor by its group, unless it is sticky (like /tmp,
 *   where nobody else can rename or remove what is ours). One exception for the group: on Linux,
 *   a folder whose group is our primary group may be group-writable. Distributions there give
 *   each account its own group, and the umask 002 that comes with it makes ~/.automagik 0775.
 *   Caveat: a Linux host whose primary group is shared trusts that group too. macOS stays strict,
 *   since its primary group (staff) is shared by every account.
 * Another account that could rename a folder above could swap the socket after this check.
 * Without uids (Windows, where there is no socket anyway) only the modes are checked.
 */
export function ownerOnly(path, uid = process.getuid?.(), { lstat = lstatSync, realpath = realpathSync, platform = process.platform, gid = process.getgid?.() } = {}) {
  try {
    const socket = lstat(path)
    const folder = lstat(dirname(path))
    const ours = (s) => uid === undefined || s.uid === uid
    if (!(socket.isSocket() && folder.isDirectory() && (socket.mode & 0o077) === 0 && (folder.mode & 0o077) === 0 && ours(socket) && ours(folder))) return false
    if (uid === undefined) return true
    const othersWrite = (s) => (s.mode & 0o1000) === 0 && ((s.mode & 0o002) !== 0 || ((s.mode & 0o020) !== 0 && !(platform === 'linux' && s.gid === gid)))
    const safe = (dir) => {
      for (;; dir = dirname(dir)) {
        const s = lstat(dir)
        if (s.uid !== uid && s.uid !== 0) return false
        if (!s.isSymbolicLink() && (!s.isDirectory() || othersWrite(s))) return false
        if (dirname(dir) === dir) return true
      }
    }
    return safe(dirname(dirname(path))) && safe(dirname(realpath(dirname(path))))
  } catch {
    return false
  }
}

/** A refused write, in the shape both chat.send ({state}) and chat.answer ({ok}) answer. */
const refused = (reason, id, extra = {}) => ({ ...extra, state: 'refused', ok: false, reason, ...(id === undefined ? {} : { id }) })

/** What the phone gets for a write on a DSH chat whose socket accepts none. */
export const refusedDsh = (id) => refused('read-only', id, { message: ANSWER_ON_COMPUTER })

function watchRow(row, attachments) {
  if (attachments || !row || !Object.hasOwn(row, 'blocks')) return row
  const { blocks, ...legacy } = row
  return legacy
}

function rowsCut(event, attachments) {
  let out = event
  // Older watches never see blocks, even if the socket erroneously sends them.
  if (Array.isArray(event.rows)) out = { ...out, rows: event.rows.map((row) => cutRow(watchRow(row, attachments))) }
  if (!attachments && Array.isArray(event.screen)) out = { ...out, screen: event.screen.map((row) => watchRow(row, false)) }
  if (!attachments && event.row && Object.hasOwn(event.row, 'blocks')) out = { ...out, row: watchRow(event.row, false) }
  return out
}

export class DshSource {
  /**
   * `paths` are tried in order (socketPaths); `path` is one place only.
   * The clock and attachment deadlines can be replaced by the wire tests.
   */
  constructor({ path, paths = path === undefined ? socketPaths() : [path], connect = createConnection, check = ownerOnly, realpath = realpathSync, log = () => {}, requestMs = REQUEST_MS, now = Date.now,
    attachments = false, timers = realTimers, attachmentMs = {}, settingsWriteMs = SETTINGS_WRITE_MS } = {}) {
    Object.assign(this, { paths, connect, check, realpath, log, requestMs, now, attachments, timers, settingsWriteMs })
    this.attachmentMs = { ...ATTACH_MS, ...attachmentMs }
    /** The socket in use: the first of `paths` that passed the check. */
    this.path = null
    this.absent = false
    this.socket = null
    this.opening = null
    this.openingSocket = null
    this.stopped = false
    this.pending = new Map()
    /** The socket's write methods, from its hello: empty for a read-only socket. */
    this.writes = new Set()
    this.manages = new Set()
    // Keep the team across reconnects. Switching homes invalidates the old phone hellos.
    this.team = null
    this.negotiated = new WeakMap()
    this.attachOffer = null
    this.attachmentsAgreed = new WeakMap()
    this.uploads = new Map()
    this.admitted = new Map()
    this.uploadIds = new Map()
    this.attachmentWrites = new Map()
    this.grants = new Map()
    this.nextGrant = 1
    /** channel -> { socket, listener, status, approval, client, terminal } */
    this.subs = new Map()
    /** Paired key -> write and read windows, interrupt windows and separate busy sets. */
    this.phones = new Map()
    this.nextId = 1
    this.nextChannel = 1
  }

  /** The socket, connected and greeted, or null when the source is absent. */
  open() {
    if (this.stopped) return Promise.resolve(null)
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket)
    if (this.opening) return this.opening
    const path = this.paths.find((candidate) => this.check(candidate))
    if (!path) {
      if (!this.absent) this.log(`chat: no DSH socket only this account reaches in ${this.paths.join(', ')}; no Bot chats`)
      this.absent = true
      return Promise.resolve(null)
    }
    this.absent = false
    const realFolder = () => {
      try { return this.realpath(dirname(path)) } catch { return null }
    }
    this.opening = new Promise((done) => {
      const real = realFolder()
      const socket = this.connect(path)
      this.openingSocket = socket
      let buffer = ''
      socket.setEncoding('utf8')
      socket.on('error', () => socket.destroy())
      socket.on('data', (chunk) => {
        buffer += chunk
        if (buffer.length > MAX_LINE && !buffer.includes('\n')) { socket.destroy(); return }
        let at
        while ((at = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, at)
          buffer = buffer.slice(at + 1)
          let m
          try { m = JSON.parse(line) } catch { socket.destroy(); return }
          this.onMessage(socket, m)
        }
      })
      socket.on('close', () => { this.onClose(socket); done(null) })
      socket.once('connect', async () => {
        try {
          const greeting = { write: 1, ...(this.attachments ? { attachments: 1 } : {}) }
          let hello = await this.ask(socket, 'hello', greeting)
          if (validHello(hello) && writableHello(hello) && !this.stopped && !socket.destroyed) {
            hello = await this.ask(socket, 'hello', { ...greeting, manage: 1 })
          }
          if (!validHello(hello)) {
            this.log('chat: the DSH socket answers neither read-only nor write: 1; not used')
            socket.destroy()
            return
          }
          if (this.stopped || socket.destroyed) return
          if (realFolder() !== real) { socket.destroy(); return }
          const methods = Array.isArray(hello.methods) ? hello.methods : []
          const manageMethods = Array.isArray(hello.manageMethods) ? hello.manageMethods : []
          this.writes = new Set(writableHello(hello) ? Object.values(WRITE_METHODS).filter((m) => methods.includes(m)) : [])
          const offered = writableHello(hello) && hello.manage === 1 ? MANAGE_METHODS.filter((m) => manageMethods.includes(socketMethod(m))) : []
          this.manages = new Set(this.#settingsFamily(offered))
          this.attachOffer = this.attachments ? attachmentOffer(hello) : null
          this.path = path
          if (this.team?.path !== path || this.team.real !== real) this.team = { path, real }
          this.socket = socket
          done(socket)
        } catch {
          socket.destroy()
        }
      })
    }).finally(() => { this.opening = null; this.openingSocket = null })
    return this.opening
  }

  timer(run, ms) {
    const timer = this.timers.setTimeout(run, ms)
    timer?.unref?.()
    return timer
  }

  ask(socket, method, params, { timeout = this.requestMs, accept, attachment = false, signal, onWrite } = {}) {
    if (!socket || socket.destroyed) return Promise.reject(socketError('unavailable'))
    if (signal?.aborted) return Promise.reject(socketError(signal.reason))
    const id = this.nextId++
    const line = lineOf(id, method, params)
    let queued
    let bytes
    if (attachment) {
      bytes = Buffer.byteLength(line)
      const local = (kind) => Promise.reject(Object.assign(socketError(kind), { local: true }))
      if (bytes > ATTACH_LINE) return local(method === 'send' ? 'too-long' : 'invalid')
      if (method !== 'upload-cancel') {
        queued = this.attachmentWrites.get(socket) ?? { bytes: 0 }
        if (queued.bytes + bytes > ATTACH_UNFLUSHED) return local('busy')
        queued.bytes += bytes
        this.attachmentWrites.set(socket, queued)
      }
    }
    return new Promise((resolve, reject) => {
      const p = { socket, resolve, reject, accept, attachment, written: false }
      const flushed = () => {
        if (!queued) return
        queued.bytes -= bytes
        if (!queued.bytes && this.attachmentWrites.get(socket) === queued) this.attachmentWrites.delete(socket)
        queued = null
      }
      const abort = () => p.fail(signal.reason)
      p.done = () => {
        if (!this.pending.delete(id)) return false
        this.timers.clearTimeout(p.timer)
        signal?.removeEventListener('abort', abort)
        return true
      }
      p.fail = (kind) => {
        if (p.done()) reject(socketError(kind, p.written))
      }
      p.timer = this.timer(() => p.fail('timeout'), timeout)
      this.pending.set(id, p)
      signal?.addEventListener('abort', abort, { once: true })
      try {
        p.written = true
        socket.write(line, (error) => { flushed(); if (error) p.fail('unavailable') })
      } catch {
        p.written = false
        flushed()
        p.fail('unavailable')
        return
      }
      onWrite?.()
    })
  }

  async request(method, params) {
    const socket = await this.open()
    return this.ask(socket, method, params)
  }

  onMessage(socket, m) {
    const p = this.pending.get(m?.id)
    if (p?.socket === socket) {
      if (p.accept && (m.error || !p.accept(m.result))) return
      p.done()
      if (m.error && p.attachment) {
        const { kind, code, upload } = m.error
        p.reject(Object.assign(socketError('failed', p.written), { detail: { reason: kind, code, upload } }))
      } else if (m.error) p.reject(Object.assign(new Error(String(m.error.message ?? m.error.kind)), { kind: m.error.kind, detail: m.error }))
      else p.resolve(m.result)
      return
    }
    const sub = Number.isSafeInteger(m?.channel) ? this.subs.get(m.channel) : null
    if (sub?.socket !== socket || !m.event || typeof m.event.type !== 'string') return
    const e = rowsCut(m.event, sub.attachments)
    if (e.type === 'snapshot' || e.type === 'status') sub.status = e.status ?? sub.status
    if (e.type === 'snapshot' || e.type === 'approval') sub.approval = e.type === 'snapshot' ? e.approval : (e.row?.open === false ? null : e.row)
    if (e.type === 'gone' && sub.attachments) this.#unwatch(sub)
    try { sub.listener(e) } catch {}
  }

  onClose(socket) {
    if (this.socket === socket) { this.socket = null; this.writes.clear(); this.manages.clear(); this.attachOffer = null }
    this.attachmentWrites.delete(socket)
    for (const p of this.pending.values()) if (p.socket === socket) p.fail('unavailable')
    for (const rec of this.uploads.values()) if (rec.socket === socket) this.#dropUpload(rec, 'unavailable')
    for (const [client, grant] of this.grants) {
      if (grant.socket !== socket) continue
      grant.state = 'closed'
      this.grants.delete(client)
    }
    for (const [channel, sub] of this.subs) {
      if (sub.socket !== socket) continue
      this.subs.delete(channel)
      this.admitted.delete(sub)
      sub.work.abort('unavailable')
      try { sub.listener({ type: 'gone', reason: 'unavailable' }) } catch {}
    }
  }

  liveClient(client, socket) {
    return !client.closed && !this.stopped && socket === this.socket && Boolean(socket && !socket.destroyed)
  }

  #settingsFamily(methods) {
    return methods.includes('settings.read') ? methods : methods.filter((method) => !SETTINGS_WRITES.includes(method))
  }

  /** Open a grant before answering the phone's hello, when there is a method to negotiate. */
  openManage(client, requested) {
    const { socket, team } = this
    if (typeof client.device !== 'string' || !client.device || !this.liveClient(client, socket)) return null
    const methods = this.#settingsFamily(requested.filter((method) => this.manages.has(method)))
    if (!methods.length) return null
    return this.openGrant(client, socket).then((grant) => {
      if (grant?.state !== 'open' || !this.liveClient(client, socket)) return
      this.negotiated.set(client, { team, methods: new Set(methods) })
      return methods
    })
  }

  async openGrant(client, socket) {
    if (!this.liveClient(client, socket)) return null
    const old = this.grants.get(client)
    if (old?.socket === socket) return old.ready
    if (old) this.releaseGrant(old)
    const grant = { id: `g${this.nextGrant++}`, socket, client, state: 'opening' }
    this.grants.set(client, grant)
    grant.ready = this.confirmGrant(grant)
    return grant.ready
  }

  async confirmGrant(grant) {
    const { id, client, socket } = grant
    try {
      const result = await this.ask(socket, 'manage-open', { grant: id, phone: client.device })
      if (result?.grant === id && grant.state === 'opening' && this.liveClient(client, socket)) {
        grant.state = 'open'
        return grant
      }
    } catch {}
    this.releaseGrant(grant)
    return null
  }

  releaseGrant(grant) {
    if (grant.state === 'closed') return
    grant.state = 'closed'
    const { id, socket, client } = grant
    if (this.grants.get(client) === grant) this.grants.delete(client)
    if (!socket.destroyed) {
      this.ask(socket, 'manage-close', { grant: id }, { timeout: CLOSE_MS, accept: emptyAck }).catch(() => socket.destroy())
    }
  }

  closeClient(client) {
    this.negotiated.delete(client)
    this.attachmentsAgreed.delete(client)
    for (const sub of this.subs.values()) if (sub.client === client && sub.attachments) this.#unwatch(sub)
    const grant = this.grants.get(client)
    if (grant) this.releaseGrant(grant)
  }

  async #manageGrant(client, method) {
    const agreed = this.negotiated.get(client)
    if (client.closed || !agreed?.methods.has(method) || agreed.team !== this.team) return null
    const socket = await this.open().catch(() => null)
    if (!this.liveClient(client, socket) || agreed.team !== this.team || !this.manages.has(method)) return null
    const grant = await this.openGrant(client, socket)
    return this.liveClient(client, socket) && grant?.state === 'open' ? grant : null
  }

  async memory(client, method, params) {
    const grant = await this.#manageGrant(client, method)
    if (!grant) return memoryRefused('read-only')
    const { terminal, id, rev, text } = params
    const reading = method === 'memory.read'
    const editing = method === 'memory.edit'
    if (!manageTerminal(terminal) ||
      (!reading && (typeof text !== 'string' || Buffer.byteLength(text) > MANAGE_TEXT_MAX)) ||
      (editing && (typeof id !== 'string' || !MEMORY_ID.test(id) || typeof rev !== 'string' || !MANAGE_REV.test(rev)))) {
      return memoryRefused('invalid')
    }
    return this.#manageRequest(grant, method, reading, terminal, { ...(reading ? {} : { text }), ...(editing ? { id, rev } : {}) })
  }

  async schedule(client, method, params) {
    const grant = await this.#manageGrant(client, method)
    if (!grant) return memoryRefused('read-only')
    const { terminal, id, rev, title } = params
    const reading = method === 'schedule.list'
    const renaming = method === 'schedule.rename'
    if (!manageTerminal(terminal) ||
      ((!reading || id !== undefined) && (typeof id !== 'string' || (!SCHEDULE_ID.test(id) && !SCHEDULE_ALIAS.test(id)))) ||
      (!reading && (typeof rev !== 'string' || !MANAGE_REV.test(rev))) ||
      (renaming && (typeof title !== 'string' || Buffer.byteLength(title) > MANAGE_TEXT_MAX))) {
      return memoryRefused('invalid')
    }
    return this.#manageRequest(grant, method, reading, terminal, {
      ...(id === undefined ? {} : { id }), ...(reading ? {} : { rev }), ...(renaming ? { title } : {}),
    })
  }

  async settings(client, method, params) {
    const grant = await this.#manageGrant(client, method)
    if (!grant) return memoryRefused('read-only')
    const { terminal, rev, name, model } = params
    const reading = method === 'settings.read'
    const renaming = method === 'settings.name'
    const changingModel = method === 'settings.model'
    if (!manageTerminal(terminal) ||
      (!reading && (typeof rev !== 'string' || !MANAGE_REV.test(rev))) ||
      (renaming && (typeof name !== 'string' || Buffer.byteLength(name) > MANAGE_TEXT_MAX)) ||
      (changingModel && !modelRef(model))) {
      return memoryRefused('invalid')
    }
    return this.#manageRequest(grant, method, reading, terminal, {
      ...(reading ? {} : { rev }), ...(renaming ? { name } : {}), ...(changingModel ? { model } : {}),
    }, { timeout: reading ? undefined : this.settingsWriteMs })
  }

  async #manageRequest(grant, method, reading, terminal, fields, { timeout } = {}) {
    const { client, socket } = grant
    const key = client.device
    const now = this.now()
    const phone = this.phoneState(key, now)
    const times = reading ? phone.reads : phone.times
    if (phone.manageBusy.has(terminal)) return memoryRefused('busy')
    if (times.length >= (reading ? READS_PER_MINUTE : WRITES_PER_MINUTE)) return memoryRefused('rate')
    if (!this.liveClient(client, socket) || grant.state !== 'open') return memoryRefused('read-only')
    times.push(now)
    phone.manageBusy.add(terminal)
    try {
      const result = await this.ask(socket, socketMethod(method), { grant: grant.id, terminal, ...fields }, { timeout })
      if (client.closed) return memoryRefused('read-only')
      return this.liveClient(client, socket) ? result : manageOffline(reading, true)
    } catch (error) {
      if (client.closed) return memoryRefused('read-only')
      if (error.detail) return memoryRefused(typeof error.kind === 'string' && error.kind ? error.kind : 'failed')
      return manageOffline(reading, error.written)
    } finally {
      phone.manageBusy.delete(terminal)
      this.trimPhone(key, phone, this.now())
    }
  }

  trimPhone(key, phone, now) {
    phone.times = phone.times.filter((t) => now - t < 60_000)
    phone.reads = phone.reads.filter((t) => now - t < 60_000)
    for (const [terminal, at] of phone.interrupts) if (now - at >= INTERRUPT_MS) phone.interrupts.delete(terminal)
    if (!phone.times.length && !phone.reads.length && !phone.interrupts.size && !phone.busy.size && !phone.manageBusy.size && !phone.reading) this.phones.delete(key)
  }

  phoneState(key, now) {
    const phone = this.phones.get(key) ?? { times: [], reads: [], interrupts: new Map(), busy: new Set(), manageBusy: new Set() }
    this.trimPhone(key, phone, now)
    this.phones.set(key, phone)
    return phone
  }

  /** The DSH chats, as chat.list rows; [] when the source is absent. */
  async list() {
    try {
      const result = await this.request('list')
      return (Array.isArray(result?.terminals) ? result.terminals : []).filter((t) => isDsh(t?.terminal))
    } catch {
      return []
    }
  }

  /** A phone grant is made only when its hello is answered and lives on this socket. */
  attachHello(client) {
    const { socket, team, attachOffer: offer } = this
    const live = this.liveClient(client, socket)
    if (!live || !offer || typeof client.device !== 'string' || !PHONE_KEY.test(client.device)) {
      this.attachmentsAgreed.delete(client)
      return { version: 1, unavailable: live ? 'app' : 'none' }
    }
    this.attachmentsAgreed.set(client, { team, socket, offer })
    return { version: 1, methods: ATTACH_METHODS, ...offer }
  }

  offerFor(client) {
    const grant = this.attachmentsAgreed.get(client)
    return grant && grant.team === this.team && grant.offer === this.attachOffer && this.liveClient(client, grant.socket) ? grant.offer : null
  }

  #attachmentSub(client, terminal) {
    if (!this.offerFor(client)) return
    return [...this.subs.values()].find((sub) => sub.attachments && sub.client === client && sub.terminal === terminal && sub.socket === this.socket)
  }

  #activeSub(sub) {
    return this.subs.get(sub.channel) === sub && this.liveClient(sub.client, sub.socket) && Boolean(this.offerFor(sub.client))
  }

  async #attachmentAsk(sub, method, fields, timeout, { signal = sub.work.signal, onWrite } = {}) {
    const deadline = this.now() + timeout
    const notWatching = () => Object.assign(socketError('not-watching'), { local: true })
    if (!this.#activeSub(sub)) throw notWatching()
    if (!sub.subscribed) {
      const ready = await new Promise((resolve, reject) => {
        const aborted = () => signal.reason === 'cancelled' ? socketError('cancelled') : notWatching()
        if (signal.aborted) return reject(aborted())
        const abort = () => finish(reject, aborted())
        const finish = (done, value) => {
          this.timers.clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          done(value)
        }
        const timer = this.timer(() => finish(reject, socketError('timeout')), timeout)
        signal.addEventListener('abort', abort, { once: true })
        sub.ready.then((value) => finish(resolve, value))
      })
      if (!ready || !this.#activeSub(sub)) throw notWatching()
    }
    const remaining = deadline - this.now()
    if (remaining <= 0) throw socketError('timeout')
    return this.ask(sub.socket, method, { channel: sub.channel, phone: sub.client.device, ...fields },
      { attachment: true, timeout: remaining, signal, onWrite })
  }

  #uploadFor(sub, upload) {
    if (!sub) return
    const key = sub.client.device
    const rec = this.uploads.get(key)
    if (rec?.sub === sub && rec.client === sub.client && rec.terminal === sub.terminal && rec.upload === upload
      && rec.key === key && rec.socket === sub.socket && rec.team === this.team) return rec
  }

  #currentUpload(rec) { return this.uploads.get(rec.key) === rec }

  #rememberAdmitted(sub, upload) {
    const ids = this.admitted.get(sub) ?? new Map()
    const at = this.now()
    for (const [id, entry] of ids) if (at - entry.at >= ADMITTED_MS) ids.delete(id)
    ids.set(upload, { at })
    if (ids.size > ADMITTED_MAX) ids.delete(ids.keys().next().value)
    this.admitted.set(sub, ids)
  }

  #dropUpload(rec, reason) {
    if (!this.#currentUpload(rec)) return
    this.uploads.delete(rec.key)
    this.timers.clearTimeout(rec.idle)
    this.timers.clearTimeout(rec.total)
    rec.state = 'settled'
    rec.work.abort(reason)
  }

  #startCancelling(rec, reason = 'cancelled') {
    if (rec.state === 'cancelling') return
    rec.state = 'cancelling'
    this.timers.clearTimeout(rec.idle)
    this.timers.clearTimeout(rec.total)
    rec.work.abort(reason)
  }

  #cancelUpload(rec) {
    if (!this.#currentUpload(rec)) return
    if (rec.state === 'cancelling') return rec.cleanup
    this.#startCancelling(rec)
    if (!rec.written) { this.#dropUpload(rec, 'cancelled'); return }
    rec.cleanup = this.ask(rec.socket, 'upload-cancel', { channel: rec.channel, phone: rec.key, upload: rec.upload },
      { attachment: true, timeout: this.attachmentMs.cancel, accept: (result) => result?.ok === true })
      .catch(() => {}).then(() => this.#dropUpload(rec, 'cancelled'))
    return rec.cleanup
  }

  #idleUpload(rec) {
    this.timers.clearTimeout(rec.idle)
    rec.idle = this.timer(() => this.#cancelUpload(rec), Math.max(0, rec.idleAt - this.now()))
  }

  #totalUpload(rec) {
    rec.total = this.timer(() => this.#cancelUpload(rec), Math.max(0, rec.totalAt - this.now()))
  }

  #rememberUpload(key, upload) {
    const ids = this.uploadIds.get(key) ?? new Set()
    ids.add(upload)
    if (ids.size > 256) ids.delete(ids.values().next().value)
    this.uploadIds.set(key, ids)
  }

  async uploadBegin(client, terminal, { upload, mediaType, bytes }) {
    const offer = this.offerFor(client)
    if (!offer) return memoryRefused('read-only')
    const sub = this.#attachmentSub(client, terminal)
    if (!sub) return memoryRefused('not-watching')
    const key = client.device
    if (!phoneId(upload) || this.uploadIds.get(key)?.has(upload)) return memoryRefused('invalid')
    if (this.uploads.has(key)) return memoryRefused('busy')
    if (!offer.mediaTypes.includes(mediaType)) return memoryRefused('unsupported')
    if (!positiveInt(bytes) || bytes > offer.limits.fileBytes) return memoryRefused('too-large')
    const rec = {
      client, socket: sub.socket, team: this.team, sub, channel: sub.channel, terminal, key, upload, mediaType, bytes,
      acked: 0, state: 'opening', op: null, work: new AbortController(), totalAt: this.now() + this.attachmentMs.total,
    }
    this.uploads.set(key, rec)
    this.#totalUpload(rec)
    let result
    try {
      result = await this.#attachmentAsk(sub, 'upload-begin', { upload, mediaType, bytes }, this.attachmentMs.begin,
        { signal: rec.work.signal, onWrite: () => {
          rec.written = true
          this.#rememberUpload(key, upload)
        } })
    } catch (error) {
      if (this.#currentUpload(rec) && rec.state === 'opening') {
        if (error.written && !error.detail) this.#cancelUpload(rec)
        else this.#dropUpload(rec)
      }
      return error.kind === 'cancelled' ? memoryRefused('invalid') : attachmentFailure(error, { upload })
    }
    if (!this.#currentUpload(rec) || rec.state !== 'opening' || !this.#activeSub(sub)) return memoryRefused('invalid')
    if (result?.ok === false && result.state === 'refused') {
      this.#dropUpload(rec)
      return attachmentRefusal(result, { upload })
    }
    const { chunkBytes } = offer.limits
    if (result?.ok !== true || result.state !== 'open' || result.upload !== upload || result.chunkBytes !== chunkBytes) {
      this.#cancelUpload(rec)
      return memoryRefused('failed')
    }
    rec.state = 'open'
    rec.idleAt = this.now() + this.attachmentMs.idle
    this.#idleUpload(rec)
    return { ok: true, state: 'open', upload, chunkBytes }
  }

  async uploadChunk(client, terminal, { upload, offset, data }) {
    const offer = this.offerFor(client)
    if (!offer) return memoryRefused('read-only')
    const sub = this.#attachmentSub(client, terminal)
    const rec = this.#uploadFor(sub, upload)
    if (!rec) return memoryRefused('invalid')
    const { chunkBytes } = offer.limits
    const n = canonicalBytes(data, chunkBytes)
    const received = rec.acked + n
    if (rec.state !== 'open' || rec.op || offset !== rec.acked || !n || received > rec.bytes || (n !== chunkBytes && received !== rec.bytes)) {
      this.#cancelUpload(rec)
      return memoryRefused('invalid')
    }
    this.timers.clearTimeout(rec.idle)
    rec.op = 'chunk'
    let result
    try {
      result = await this.#attachmentAsk(sub, 'upload-chunk', { upload, offset, data }, this.attachmentMs.chunk, { signal: rec.work.signal })
    } catch (error) {
      if (!this.#currentUpload(rec) || rec.state !== 'open') return memoryRefused('invalid')
      if (error.local && error.kind === 'busy') {
        rec.op = null
        this.#idleUpload(rec)
      } else this.#cancelUpload(rec)
      return attachmentFailure(error, { upload })
    }
    if (!this.#currentUpload(rec) || rec.state !== 'open' || !this.#activeSub(sub)) return memoryRefused('invalid')
    if (result?.ok !== true || result.received !== received) {
      this.#cancelUpload(rec)
      return attachmentRefusal(result?.ok === false ? result : null, { upload })
    }
    rec.acked = received
    rec.op = null
    rec.idleAt = this.now() + this.attachmentMs.idle
    this.#idleUpload(rec)
    return { ok: true, received }
  }

  async uploadFinish(client, terminal, { upload }) {
    const offer = this.offerFor(client)
    if (!offer) return memoryRefused('read-only')
    const sub = this.#attachmentSub(client, terminal)
    const rec = this.#uploadFor(sub, upload)
    if (!rec || rec.state !== 'open' || rec.op || rec.acked !== rec.bytes) return memoryRefused('invalid')
    rec.state = 'finishing'
    this.timers.clearTimeout(rec.idle)
    this.timers.clearTimeout(rec.total)
    let result
    try {
      result = await this.#attachmentAsk(sub, 'upload-finish', { upload }, this.attachmentMs.finish,
        { signal: rec.work.signal, onWrite: () => { rec.op = 'finish' } })
    } catch (error) {
      if (error.kind === 'cancelled' || rec.work.signal.reason === 'cancelled') return memoryRefused('invalid')
      if (this.#currentUpload(rec)) {
        if (error.local && error.kind === 'busy') {
          rec.state = 'open'
          rec.op = null
          this.#idleUpload(rec)
          this.#totalUpload(rec)
        } else this.#cancelUpload(rec)
      }
      if (error.written && (error.kind === 'timeout' || error.kind === 'unavailable')) {
        return { ok: false, state: 'unknown', reason: 'offline', upload }
      }
      return attachmentFailure(error, { upload })
    }
    if (!this.#currentUpload(rec) || rec.state !== 'finishing' || !this.#activeSub(sub)) return memoryRefused('invalid')
    const { mediaType, width, height, bytes, stored } = result?.image ?? {}
    if (result?.ok !== true || result.state !== 'admitted' || result.upload !== upload
      || !offer.mediaTypes.includes(mediaType) || ![width, height, bytes, stored].every(positiveInt)) {
      this.#cancelUpload(rec)
      return attachmentRefusal(result?.ok === false ? result : null, { upload })
    }
    if (rec.sent !== true) this.#rememberAdmitted(sub, upload)
    this.#dropUpload(rec)
    return { ok: true, state: 'admitted', upload, image: { mediaType, width, height, bytes, stored } }
  }

  async uploadCancel(client, terminal, { upload }) {
    if (!this.offerFor(client)) return memoryRefused('read-only')
    const sub = this.#attachmentSub(client, terminal)
    const rec = this.#uploadFor(sub, upload)
    if (rec) {
      if (!rec.sent) await this.#cancelUpload(rec)
      return { ok: true }
    }
    const ids = this.admitted.get(sub)
    const entry = ids?.get(upload)
    if (entry) {
      ids.delete(upload)
      if (this.now() - entry.at < ADMITTED_MS) {
        await this.ask(sub.socket, 'upload-cancel', { channel: sub.channel, phone: client.device, upload },
          { attachment: true, timeout: this.attachmentMs.cancel, accept: (result) => result?.ok === true }).catch(() => {})
      }
    }
    return { ok: true }
  }

  async attachmentRead(client, terminal, { row, block }) {
    const offer = this.offerFor(client)
    if (!offer) return memoryRefused('read-only')
    const sub = this.#attachmentSub(client, terminal)
    if (!sub) return memoryRefused('not-watching')
    const key = client.device
    const now = this.now()
    const phone = this.phoneState(key, now)
    if (phone.reading) return memoryRefused('busy')
    if (phone.reads.length >= READS_PER_MINUTE) return memoryRefused('rate')
    phone.reads.push(now)
    if (typeof row !== 'string' || row.length > 256 || !Number.isSafeInteger(block) || block < 0) return memoryRefused('invalid')
    phone.reading = true
    try {
      const result = await this.#attachmentAsk(sub, 'attachment-read', { row, block }, this.attachmentMs.read)
      if (!this.#activeSub(sub)) return memoryRefused('not-watching')
      if (result?.ok === false) return attachmentRefusal(result)
      const { mediaType, width, height, data } = result ?? {}
      const { edge, bytes } = offer.limits.thumbnail
      if (result?.ok !== true || !READ_TYPES.includes(mediaType) || !positiveInt(width) || !positiveInt(height)
        || width > edge || height > edge || !canonicalBytes(data, bytes)) return memoryRefused('failed')
      return { ok: true, mediaType, width, height, data }
    } catch (error) {
      return this.#activeSub(sub) ? attachmentFailure(error) : memoryRefused('not-watching')
    } finally {
      phone.reading = false
      this.trimPhone(key, phone, this.now())
    }
  }

  #unwatch(sub, reason) {
    const { channel, socket } = sub
    if (this.subs.get(channel) !== sub) return false
    this.subs.delete(channel)
    this.admitted.delete(sub)
    sub.work.abort('not-watching')
    if (!sub.attachments) {
      if (socket) this.ask(socket, 'unsubscribe', { channel }).catch(() => {})
      return true
    }
    const rec = this.uploads.get(sub.client.device)
    if (rec?.sub === sub) this.#startCancelling(rec, reason)
    const closed = sub.subscribing
      ? this.ask(socket, 'unsubscribe', { channel }, { timeout: this.attachmentMs.unsubscribe, accept: emptyAck }).catch(() => socket.destroy())
      : Promise.resolve()
    if (rec?.sub === sub) closed.then(() => this.#dropUpload(rec, 'cancelled'))
    return true
  }

  /**
   * A subscription handle in the engine's shape. The snapshot comes from the socket, so the route
   * calls start(after) instead of building one (`streamsSnapshot`).
   */
  watch(terminal, client, listener) {
    const channel = this.nextChannel++
    const attachments = Boolean(this.offerFor(client))
    const sub = { channel, socket: attachments ? this.socket : null, listener, status: null, approval: null, client, terminal, attachments, work: new AbortController() }
    return {
      streamsSnapshot: true,
      attachments,
      attachmentLive: () => this.#activeSub(sub),
      start: (after) => {
        this.subs.set(channel, sub)
        sub.ready = this.#startWatch(sub, after)
        return sub.ready
      },
      rows: () => null,
      screen: () => [],
      status: () => sub.status,
      approval: () => sub.approval,
      held: () => [],
      backfill: async (before, limit) => {
        const result = await this.ask(sub.socket, 'backfill', { channel, before, limit })
        return page(Array.isArray(result?.rows) ? result.rows.map((row) => watchRow(row, attachments)) : [])
      },
      close: () => this.#unwatch(sub),
    }
  }

  async #startWatch(sub, after) {
    const { channel, terminal, attachments } = sub
    try {
      const socket = attachments ? sub.socket : await this.open()
      if (this.subs.get(channel) !== sub) return false
      if (attachments && !this.#activeSub(sub)) throw socketError('unavailable')
      sub.socket = socket
      sub.subscribing = true
      const result = await this.ask(socket, 'subscribe', {
        terminal, channel, ...(typeof after === 'string' ? { after } : {}), ...(attachments ? { attachments: 1 } : {}),
      })
      if (attachments && result?.channel !== channel) throw socketError('unavailable')
      sub.subscribed = this.subs.get(channel) === sub
      return sub.subscribed
    } catch (error) {
      const removed = attachments ? this.#unwatch(sub, 'not-watching') : this.subs.delete(channel)
      if (removed) {
        try { sub.listener({ type: 'gone', reason: attachments ? 'unavailable' : (error.kind ?? 'unavailable') }) } catch {}
      }
      return false
    }
  }

  /** Whether the socket in use answered `write: 1` (the chat hello's `dshWrite`). */
  writable() { return Boolean(this.socket && !this.socket.destroyed && this.writes.size) }

  /**
   * A phone's write on a DSH chat: `method` is send, interrupt or answer, `params` what the
   * socket method takes but the channel. Forwarded only to a socket that answered `write: 1`, on
   * the channel this same connection (`client`) subscribed to `terminal`; never opens a socket.
   * `by` is the phone's name; the phone is `client.device`, its paired key: without one (not a
   * paired connection) nothing is written. Both go to the socket after `params`, so nothing in
   * them can stand in for another phone.
   */
  async write(client, terminal, method, params = {}, { by = 'Phone' } = {}) {
    const id = method === 'send' ? params.id : undefined
    const withUploads = method === 'send' && Object.hasOwn(params, 'uploads')
    const socket = this.socket
    const attachmentRefused = (reason) => attachmentRefusal({ reason }, { id })
    const readOnly = () => withUploads ? attachmentRefused('read-only') : refusedDsh(id)
    if (!socket || socket.destroyed || !this.writes.has(method)) return readOnly()
    const key = client?.device
    if (typeof key !== 'string' || !key) return readOnly()
    if (withUploads && !this.offerFor(client)) return readOnly()
    const sub = withUploads ? this.#attachmentSub(client, terminal)
      : [...this.subs.values()].find((s) => s.socket === socket && s.client === client && s.terminal === terminal)
    if (!sub) return refused('not-watching', id)
    const now = this.now()
    const phone = this.phoneState(key, now)
    if (phone.busy.has(terminal)) return refused('busy', id)
    if (phone.times.length >= WRITES_PER_MINUTE) return refused('rate', id)
    if (method === 'interrupt' && now - (phone.interrupts.get(terminal) ?? -Infinity) < INTERRUPT_MS) return refused('rate', id)
    phone.times.push(now)
    if (method === 'interrupt') phone.interrupts.set(terminal, now)
    phone.busy.add(terminal)
    try {
      if (withUploads) {
        const { text, uploads } = params
        const onWrite = () => {
          const ids = this.admitted.get(sub)
          for (const upload of uploads) ids?.delete(upload)
          const rec = this.uploads.get(key)
          if (rec?.sub === sub && rec.state === 'finishing' && rec.op === 'finish' && uploads.includes(rec.upload)) rec.sent = true
        }
        const result = await this.#attachmentAsk(sub, method, { text, id, uploads, by }, this.requestMs, { onWrite })
        if (!this.#activeSub(sub)) return attachmentRefused('offline')
        if (result?.ok === false) return attachmentRefusal(result, { id })
        if (result?.ok !== true || result.id !== id || !['sent', 'queued'].includes(result.state)
          || (Object.hasOwn(result, 'repeat') && result.repeat !== true)) return attachmentRefused('failed')
        return { ok: true, state: result.state, id, ...(result.repeat ? { repeat: true } : {}) }
      }
      const result = await this.ask(socket, method, { channel: sub.channel, ...params, by, phone: key })
      if (!result || typeof result !== 'object' || Array.isArray(result)) return refused('failed', id)
      return id === undefined || Object.hasOwn(result, 'id') ? result : { ...result, id }
    } catch (error) {
      if (withUploads) return attachmentFailure(error, { id })
      if (error.kind === 'timeout' || error.kind === 'unavailable') return refused('offline', id)
      const { kind, message, ...rest } = error.detail && typeof error.detail === 'object' ? error.detail : {}
      if (kind === 'read-only') return refusedDsh(id)
      return refused(typeof kind === 'string' && kind ? kind : 'failed', id, { ...rest, ...(typeof message === 'string' ? { message } : {}) })
    } finally {
      phone.busy.delete(terminal)
      this.trimPhone(key, phone, this.now())
    }
  }

  close() {
    this.stopped = true
    this.admitted.clear()
    for (const rec of this.uploads.values()) this.#dropUpload(rec, 'unavailable')
    this.openingSocket?.destroy()
    this.socket?.destroy()
  }
}

/**
 * The route's engine with the DSH chats beside the terminal ones: listed after them, opened by
 * their `dsh:` id, their writes given to the source (refused unless its socket takes writes).
 * `by` is the paired phone's name (devices.json), which the socket's answer records.
 */
export function withDsh(engine, dsh, { by = 'Phone' } = {}) {
  if (!dsh) return engine
  return {
    dshWrite: () => dsh.writable(),
    attachHello: (client) => dsh.attachHello(client),
    attachOffer: (client) => dsh.offerFor(client),
    uploadBegin: (client, terminal, params) => dsh.uploadBegin(client, terminal, params),
    uploadChunk: (client, terminal, params) => dsh.uploadChunk(client, terminal, params),
    uploadFinish: (client, terminal, params) => dsh.uploadFinish(client, terminal, params),
    uploadCancel: (client, terminal, params) => dsh.uploadCancel(client, terminal, params),
    attachmentRead: (client, terminal, params) => dsh.attachmentRead(client, terminal, params),
    openManage: (client, methods) => dsh.openManage(client, methods),
    memory: (client, method, params) => dsh.memory(client, method, params),
    schedule: (client, method, params) => dsh.schedule(client, method, params),
    settings: (client, method, params) => dsh.settings(client, method, params),
    closeClient: (client) => {
      try { dsh.closeClient(client) } finally { engine.closeClient?.(client) }
    },
    ready: () => engine.ready(),
    async list() {
      const [terminals, bots] = await Promise.all([engine.list(), dsh.list().catch(() => [])])
      return [...terminals, ...bots]
    },
    watch: (terminal, client, listener) => (isDsh(terminal) ? dsh.watch(terminal, client, listener) : engine.watch(terminal, client, listener)),
    send: (client, terminal, m) => (isDsh(terminal)
      ? dsh.write(client, terminal, 'send', { text: m?.text, id: m?.id, ...(m && Object.hasOwn(m, 'uploads') ? { uploads: m.uploads } : {}) }, { by })
      : engine.send(client, terminal, m)),
    sendHeld: (client, terminal, m) => (isDsh(terminal) ? refusedDsh(m?.id) : engine.sendHeld(client, terminal, m)),
    cancelHeld: (client, terminal, m) => (isDsh(terminal) ? refusedDsh(m?.id) : engine.cancelHeld(client, terminal, m)),
    answer: (client, terminal, a) => (isDsh(terminal)
      ? dsh.write(client, terminal, 'answer', { row: a?.row, choice: a?.choice, ...(typeof a?.text === 'string' ? { text: a.text } : {}) }, { by })
      : engine.answer(client, terminal, a)),
    interrupt: (client, terminal) => (isDsh(terminal) ? dsh.write(client, terminal, 'interrupt', {}, { by }) : engine.interrupt(client, terminal)),
  }
}
