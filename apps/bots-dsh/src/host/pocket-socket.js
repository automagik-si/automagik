// The local socket Pocket Link reads the team's Bot chats from (#517), and writes to them since RFC
// 0015's amendment (2026-11-07). A Unix domain socket in the team's home,
// `<team home>/pocket/chat.sock`: the folder is 0700 and the socket 0600, so only the person's own
// account reaches it. Never a TCP port, never on Windows.
//
// Wire: one JSON object per line each way. Requests `{ id, method, params }`; answers
// `{ id, result }` or `{ id, error: { kind, message } }`; chat events `{ channel, event }` on the
// channel the client named in its subscribe. Methods: hello, list, subscribe {terminal, channel,
// after?}, unsubscribe {channel}, backfill {channel, before, limit?}.
//
// Writes, only on a connection whose `hello` asked for them (`{ write: 1 }`) and only when the
// source takes them: send {channel, phone, text, id, by?}, interrupt {channel, phone, by?}, answer
// {channel, phone, row, choice, text?, by?}. Each names a channel this same connection subscribed
// to, never a terminal. `phone` is the paired phone's key, set by the bridge: the limits count per
// phone by it, across connections, and a write without one is refused `read-only`. `by` is the
// phone's name, for receipts only: renaming a phone, or a `by` naming another, changes no count.
// To a `hello` without `write` the answer is today's (`readOnly: true`) and every write is refused
// `read-only`, so an older bridge stays read only.
//
// Management (RFC 0036) also needs `manage: 1` in hello. The bridge opens a grant for each
// phone connection and closes it when access ends. Management calls name that grant and a Bot's
// terminal, and need no subscription. Reads have their own limit and writes share the chat
// limit. A revoked grant stays revoked for queued requests, even if its id is opened again.
import { lstatSync, unlinkSync } from 'node:fs'
import { chmod, lstat, mkdir } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { join } from 'node:path'

export const SOCKET_DIR = 'pocket'
export const SOCKET_NAME = 'chat.sock'
export const DIR_MODE = 0o700
export const SOCKET_MODE = 0o600
export const PROTOCOL = 1
export const METHODS = Object.freeze(['hello', 'list', 'subscribe', 'unsubscribe', 'backfill'])
/** The write methods, served only to a connection that asked for them in its hello. */
export const WRITE_METHODS = Object.freeze(['send', 'interrupt', 'answer'])
const MEMORY_METHODS = Object.freeze(['memory-read', 'memory-edit', 'memory-add'])
const SCHEDULE_WRITES = Object.freeze(['schedule-pause', 'schedule-resume', 'schedule-rename'])
const MANAGE_GRANT = /^[A-Za-z0-9._:-]{1,64}$/
const MEMORY_ID = /^[A-Za-z0-9_-]{1,32}$/
const MANAGE_REV = /^[0-9a-f]{16}$/
export const SCHEDULE_ID = /^schedule-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SCHEDULE_ALIAS = /^x[0-9a-f]{16}$/
export const MAX_SCHEDULE_LINE = 1024 * 1024
const MAX_GRANTS = 16
const MAX_MANAGE_READS = 60
const MAX_MANAGE_TEXT = 4 * 1024
/** Writes per paired phone (its `phone` key) in a minute, across its chats and connections. */
export const MAX_WRITES_PER_MINUTE = 20
export const WRITE_WINDOW_MS = 60_000
/** At most one interrupt per phone and chat this often. */
export const INTERRUPT_EVERY_MS = 5_000
/** A paired phone's key as the bridge sends it (an id or key fingerprint, never a name). */
export const PHONE_KEY = /^[A-Za-z0-9+/=._:-]{1,256}$/
/** One request line at most (a request is small); past it the connection ends. */
export const MAX_LINE = 64 * 1024
export const MAX_CONNECTIONS = 4
export const MAX_SUBSCRIPTIONS = 8
/** Bytes written and not yet taken by the reader; past it the connection ends. */
export const MAX_UNSENT = 4 * 1024 * 1024
/** How long a stop waits for readers to finish after it ends them; then they are cut. */
export const CLOSE_GRACE_MS = 500

export const socketPathOf = home => join(home, SOCKET_DIR, SOCKET_NAME)

const readOnly = id => ({ id, error: { kind: 'read-only', message: 'This socket only reads; answer on the computer.' } })
export const refusedWrite = (reason, extra = {}) => ({ ok: false, state: 'refused', reason, ...extra })
export const scheduleReplyCheck = Symbol('schedule reply check')

export class ScheduleAdmissionRefusal extends Error {
  constructor(reason) {
    super(reason)
    this.reason = reason
  }
}

/**
 * The write limits one host keeps across its connections: 20 writes a minute per phone and one
 * interrupt per phone and chat every 5 s (`rate`), one write in flight per phone and chat (`busy`).
 */
export function writeLimits(now = Date.now) {
  const writes = new Map()
  const reads = new Map()
  const interrupts = new Map()
  const inFlight = new Set()
  return {
    busy: key => inFlight.has(key),
    begin: key => inFlight.add(key),
    end: key => inFlight.delete(key),
    takeRead(phone) {
      const at = now()
      const recent = (reads.get(phone) ?? []).filter(time => at - time < WRITE_WINDOW_MS)
      reads.set(phone, recent)
      if (recent.length >= MAX_MANAGE_READS) return false
      recent.push(at)
      return true
    },
    /** Count one write, or say it is past a cap (and count nothing). */
    take(phone, chat, interrupt) {
      const at = now()
      const recent = (writes.get(phone) ?? []).filter(time => at - time < WRITE_WINDOW_MS)
      writes.set(phone, recent)
      if (recent.length >= MAX_WRITES_PER_MINUTE) return false
      const last = interrupts.get(`${phone}\0${chat}`)
      if (interrupt && last !== undefined && at - last < INTERRUPT_EVERY_MS) return false
      recent.push(at)
      if (interrupt) interrupts.set(`${phone}\0${chat}`, at)
      return true
    },
  }
}

/** Whether something answers on `path` (another host serving the same team). */
function answers(path) {
  return new Promise((resolve) => {
    const probe = createConnection(path)
    probe.once('connect', () => { probe.destroy(); resolve(true) })
    probe.once('error', () => resolve(false))
  })
}

// Starts and stops on one path run one at a time in this process (`queue`): the plugin's effect
// can stop and start again while the last one is still closing, and two starts at once could
// both find the same stale socket and the second unlink the socket the first had just bound.
// Across processes (two hosts serving one team) there is no lock: a lock file left by a crash
// would need the same stale check this is. Instead the outcome is defined: a socket that
// answers is never removed (the newcomer is refused), a stale one is removed only while it is
// still the same file that was probed (same dev, inode, ctime and birth time where the system has
// one, since an inode can be reused; checked and removed in one synchronous step), and a bind
// that loses the race is refused like a live host (EADDRINUSE). What stays open: closing a
// server unlinks its path by name (libuv does that on close), so if another process replaced
// the path in between, stopping this host removes that one's socket; it restarts to serve again.
const queues = new Map()
function queue(path, step) {
  const run = (queues.get(path) ?? Promise.resolve()).then(step)
  const tail = run.catch(() => {})
  queues.set(path, tail)
  tail.then(() => { if (queues.get(path) === tail) queues.delete(path) })
  return run
}

const served = 'another host already serves this team to Pocket'

/**
 * Serve `source` (a pocket-chat.js DshChatSource) on the team home's socket. `lstat` is the
 * synchronous lstat of the stale socket's re-check (tests stand in for it); `now` the clock of the
 * write limits.
 * @param {{ home: string, source: any, log?: (...args: any[]) => void, lstat?: typeof lstatSync, now?: () => number }} options
 * @returns {Promise<{ path: string, close(): Promise<void> }>}
 */
export function startPocketSocket({ home, source, log = () => {}, lstat: lstatNow = lstatSync, now = Date.now }) {
  return queue(socketPathOf(home), () => start({ home, source, log, lstatNow, now }))
}

const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.ctimeMs === b.ctimeMs && a.birthtimeMs === b.birthtimeMs

async function start({ home, source, log, lstatNow, now }) {
  const dir = join(home, SOCKET_DIR)
  await mkdir(dir, { recursive: true, mode: DIR_MODE })
  const folder = await lstat(dir)
  if (!folder.isDirectory()) throw new Error('the Pocket socket folder is not a folder')
  await chmod(dir, DIR_MODE)
  const path = socketPathOf(home)
  const existing = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (existing) {
    if (!existing.isSocket()) throw new Error('something that is not a socket is at the Pocket socket path')
    if (await answers(path)) throw new Error(served)
    // Only the stale socket that was probed, and with no await before the bind below.
    const now = (() => { try { return lstatNow(path) } catch { return null } })()
    if (now && sameFile(now, existing)) unlinkSync(path)
  }
  const connections = new Set()
  const limits = writeLimits(now)
  const server = createServer(socket => {
    if (connections.size >= MAX_CONNECTIONS) { socket.destroy(); return }
    const connection = serve(socket, source, log, limits)
    connections.add(connection)
    socket.once('close', () => { connections.delete(connection); connection.close() })
  })
  await new Promise((resolve, reject) => {
    server.once('error', error => reject(error?.code === 'EADDRINUSE' ? new Error(served) : error))
    server.listen(path, () => { server.removeAllListeners('error'); resolve() })
  })
  // The folder is already 0700, so nobody else could reach the socket before this.
  await chmod(path, SOCKET_MODE)
  let closing
  return {
    path,
    close() {
      closing ??= queue(path, async () => {
        // Readers are ended, then cut after a short grace: a stop (and the start queued behind it)
        // never waits on a reader that does not end its side.
        for (const connection of connections) connection.end()
        const cut = setTimeout(() => { for (const connection of connections) connection.destroy() }, CLOSE_GRACE_MS)
        // Closing removes the socket file too (libuv unlinks the bound path).
        await new Promise(resolve => server.close(() => resolve()))
        clearTimeout(cut)
      })
      return closing
    },
  }
}

/** One reader of the socket (and writer, when its hello asked and the source takes writes). */
function serve(socket, source, log, limits) {
  let buffer = ''
  let closed = false
  let writes = false
  let manageMethods = []
  let ending = false
  let generation = 0
  const grants = new Map()
  const closeGrant = (id) => {
    const grant = grants.get(id)
    if (grant === undefined) return
    grant.open = false
    grants.delete(id)
    for (const controller of grant.controllers) controller.abort(new ScheduleAdmissionRefusal('revoked'))
  }
  const revoke = () => {
    for (const id of grants.keys()) closeGrant(id)
  }
  const finish = () => {
    ending = true
    manageMethods = []
    revoke()
  }
  /** channel -> handle (or a pending marker while its watch opens) */
  const subs = new Map()
  /** channel -> the terminal it watches */
  const terminals = new Map()
  const write = (message) => {
    if (closed || socket.destroyed) return
    if (socket.writableLength > MAX_UNSENT) { end(); return }
    socket.write(`${JSON.stringify(message)}\n`)
  }
  const close = () => {
    if (closed) return
    closed = true
    finish()
    for (const handle of subs.values()) handle?.close?.()
    subs.clear()
    terminals.clear()
  }
  const end = () => { close(); socket.destroy() }

  async function memoryRequest(id, method, params) {
    const reply = (result) => { if (!ending) write({ id, result }) }
    const grant = grants.get(params.grant)
    if (!grant?.open) return reply(refusedWrite('revoked'))
    const { terminal, text, id: entryId, rev } = params
    const reading = method === 'memory-read'
    const editing = method === 'memory-edit'
    if (typeof terminal !== 'string' || !terminal.startsWith('dsh:') || terminal.length === 4
      || (!reading && (typeof text !== 'string' || Buffer.byteLength(text) > MAX_MANAGE_TEXT))
      || (editing && (typeof entryId !== 'string' || !MEMORY_ID.test(entryId) || typeof rev !== 'string' || !MANAGE_REV.test(rev)))) {
      return reply(refusedWrite('invalid'))
    }
    const botId = terminal.slice(4)
    const key = `manage\0${grant.phone}\0${terminal}`
    if (limits.busy(key)) return reply(refusedWrite('busy'))
    if (!(reading ? limits.takeRead(grant.phone) : limits.take(grant.phone, terminal, false))) return reply(refusedWrite('rate'))
    const allowed = () => {
      if (!grant.open) return 'revoked'
      try { return source.memoryAllowed(botId) } catch { return 'unavailable' }
    }
    limits.begin(key)
    try {
      // Count the id, envelope and newline, leaving the result's bytes to the projector.
      const overhead = Buffer.byteLength(JSON.stringify({ id, result: null })) - 4 + 1
      const result = await source.manageMemory(method.slice(7), { botId, id: entryId, rev, text, allowed, overhead })
      // Nothing asynchronous can run between the final check and the socket write.
      if (result.memory !== undefined || result.state === 'saved') {
        const reason = allowed()
        if (reason !== undefined) return reply(refusedWrite(reason, result.state === 'saved' ? { applied: true } : undefined))
      }
      return reply(result)
    } catch {
      log('pocket memory: unavailable')
      return reply(refusedWrite('unavailable'))
    } finally {
      limits.end(key)
    }
  }

  async function scheduleRequest(id, method, params) {
    const reply = (result) => { if (!ending) write({ id, result }) }
    let applied
    try {
      const grant = grants.get(params.grant)
      if (!grant?.open) return reply(refusedWrite('revoked'))
      const { terminal, id: taskId, rev, title } = params
      const reading = method === 'schedule-list'
      if (typeof terminal !== 'string' || !terminal.startsWith('dsh:') || terminal.length === 4
        || ((!reading || taskId !== undefined) && (typeof taskId !== 'string' || (!SCHEDULE_ID.test(taskId) && !SCHEDULE_ALIAS.test(taskId))))
        || (!reading && (typeof rev !== 'string' || !MANAGE_REV.test(rev)))
        || (method === 'schedule-rename' && (typeof title !== 'string' || Buffer.byteLength(title) > MAX_MANAGE_TEXT))) {
        return reply(refusedWrite('invalid'))
      }
      const botId = terminal.slice(4)
      const key = `manage\0${grant.phone}\0${terminal}`
      if (limits.busy(key)) return reply(refusedWrite('busy'))
      if (!(reading ? limits.takeRead(grant.phone) : limits.take(grant.phone, terminal, false))) return reply(refusedWrite('rate'))
      const allowed = (scheduleAvailable = true) => {
        if (!grant.open) return 'revoked'
        try { return source.schedulesAllowed(botId, scheduleAvailable) } catch { return 'unavailable' }
      }
      const controller = new AbortController()
      if (!reading) grant.controllers.add(controller)
      limits.begin(key)
      try {
        const overhead = Buffer.byteLength(JSON.stringify({ id, result: null })) - 4 + 1
        const { [scheduleReplyCheck]: check, ...result } = await source.manageSchedules(method.slice(9), { botId, id: taskId, rev, title, allowed, controller, overhead })
        // An unconfirmed edit can still have landed after authority was lost.
        if (result.state === 'unknown') return reply(result)
        if (result.state === 'saved') applied = { applied: true }
        const reason = allowed()
        if (reason !== undefined) return reply(refusedWrite(reason, applied))
        return reply(check ? check(result) : result)
      } finally {
        grant.controllers.delete(controller)
        limits.end(key)
      }
    } catch {
      log('pocket schedules: unavailable')
      return reply(refusedWrite('unavailable', applied))
    }
  }

  async function request(message) {
    const id = message?.id ?? null
    const params = message?.params && typeof message.params === 'object' ? message.params : {}
    switch (message?.method) {
      case 'hello':
        // Writes only for a bridge that asks, and only when the source takes them: an older
        // bridge, which drops any socket that is not `readOnly: true`, gets today's answer.
        writes = params.write === 1 && source.writable === true
        revoke()
        generation += 1
        manageMethods = []
        if (!ending && writes && params.manage === 1) {
          if (source.manages === true) manageMethods.push(...MEMORY_METHODS)
          if (source.listsSchedules === true) manageMethods.push('schedule-list')
          if (source.writesSchedules === true) manageMethods.push(...SCHEDULE_WRITES)
          if (manageMethods.length > 0) manageMethods.unshift('manage-open', 'manage-close')
        }
        return writes
          ? { id, result: { protocol: PROTOCOL, readOnly: false, write: 1, methods: [...METHODS, ...WRITE_METHODS], dedupe: 'log', ...(manageMethods.length > 0 ? { manage: 1, manageMethods } : {}) } }
          : { id, result: { protocol: PROTOCOL, readOnly: true, methods: METHODS } }
      case 'manage-close':
        closeGrant(params.grant)
        return { id, result: {} }
      case 'manage-open': {
        if (!manageMethods.includes('manage-open')) return readOnly(id)
        const { grant, phone } = params
        if (typeof grant !== 'string' || !MANAGE_GRANT.test(grant) || typeof phone !== 'string' || !PHONE_KEY.test(phone)) {
          return { id, error: { kind: 'invalid_params', message: 'grant, phone' } }
        }
        if (grants.has(grant)) return { id, error: { kind: 'invalid_params', message: 'grant in use' } }
        if (grants.size >= MAX_GRANTS) return { id, error: { kind: 'too_many', message: `at most ${MAX_GRANTS} grants` } }
        grants.set(grant, { id: grant, phone, generation, open: true, controllers: new Set() })
        return { id, result: { grant } }
      }
      case 'memory-read':
      case 'memory-edit':
      case 'memory-add':
        if (!manageMethods.includes(message.method)) return readOnly(id)
        return memoryRequest(id, message.method, params)
      case 'schedule-list':
      case 'schedule-pause':
      case 'schedule-resume':
      case 'schedule-rename':
        if (!manageMethods.includes(message.method)) return readOnly(id)
        return scheduleRequest(id, message.method, params)
      case 'list':
        return { id, result: { terminals: await source.list() } }
      case 'subscribe': {
        const { terminal, channel, after } = params
        if (typeof terminal !== 'string' || !Number.isSafeInteger(channel) || channel <= 0) return { id, error: { kind: 'invalid_params', message: 'terminal, channel' } }
        if (subs.has(channel)) return { id, error: { kind: 'invalid_params', message: 'channel in use' } }
        if (subs.size >= MAX_SUBSCRIPTIONS) return { id, error: { kind: 'too_many', message: `at most ${MAX_SUBSCRIPTIONS} subscriptions` } }
        subs.set(channel, null)
        const handle = await source.watch(terminal, event => write({ channel, event }), { after: typeof after === 'string' ? after : undefined })
        if (!handle.ok) { subs.delete(channel); return { id, error: { kind: handle.reason, message: handle.reason } } }
        if (closed || !subs.has(channel)) { handle.close(); return { id, error: { kind: 'closed', message: 'closed' } } }
        subs.set(channel, handle)
        terminals.set(channel, terminal)
        return { id, result: { channel } }
      }
      case 'unsubscribe': {
        const handle = subs.get(params.channel)
        subs.delete(params.channel)
        terminals.delete(params.channel)
        // Ends the channel's writes too: one in flight is aborted, a later one is `not-watching`.
        handle?.close()
        return { id, result: {} }
      }
      case 'send':
      case 'interrupt':
      case 'answer': {
        if (!writes) return readOnly(id)
        const method = message.method
        const ref = method === 'send' && typeof params.id === 'string' ? { id: params.id } : {}
        // No paired phone's key, no write: never counted per connection, never by name.
        if (typeof params.phone !== 'string' || !PHONE_KEY.test(params.phone)) return { id, result: refusedWrite('read-only', ref) }
        const phone = params.phone
        const handle = subs.get(params.channel)
        if (!handle || typeof handle[method] !== 'function') return { id, result: refusedWrite('not-watching', ref) }
        const by = typeof params.by === 'string' && params.by !== '' ? params.by : undefined
        const chat = terminals.get(params.channel)
        const key = `${phone}\0${chat}`
        if (limits.busy(key)) return { id, result: refusedWrite('busy', ref) }
        if (!limits.take(phone, chat, method === 'interrupt')) return { id, result: refusedWrite('rate', ref) }
        limits.begin(key)
        try {
          const args = method === 'send'
            ? { text: params.text, id: params.id, ...(by ? { by } : {}) }
            : method === 'answer'
              ? { row: params.row, choice: params.choice, ...(params.text === undefined ? {} : { text: params.text }), ...(by ? { by } : {}) }
              : undefined
          return { id, result: await handle[method](args) }
        } finally {
          limits.end(key)
        }
      }
      case 'backfill': {
        const handle = subs.get(params.channel)
        if (!handle) return { id, error: { kind: 'not_watching', message: 'not_watching' } }
        if (typeof params.before !== 'string') return { id, error: { kind: 'invalid_params', message: 'before' } }
        return { id, result: { rows: await handle.backfill(params.before, params.limit) } }
      }
      default:
        return readOnly(id)
    }
  }

  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buffer += chunk
    if (buffer.length > MAX_LINE && !buffer.includes('\n')) { end(); return }
    let at
    while ((at = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (line.length > MAX_LINE) { end(); return }
      if (!line.trim()) continue
      let message
      try { message = JSON.parse(line) } catch { end(); return }
      request(message).then(reply => { if (reply !== undefined) write(reply) }, (error) => {
        log('pocket chat: %s', error?.message ?? error)
        write({ id: message?.id ?? null, error: { kind: 'failed', message: 'failed' } })
      })
    }
  })
  socket.on('end', finish)
  socket.on('error', () => close())
  return { close, end: () => { finish(); socket.end() }, destroy: () => socket.destroy() }
}
