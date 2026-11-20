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
// A writable socket gets a second hello asking for memory management (RFC 0036). A phone
// opts in at chat hello and gets one grant, tied to its connection and team home. Closing
// the grant needs an ack in 500 ms; otherwise the socket is dropped.
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
import { cutRow, MEMORY_METHODS, memoryRefused, page } from './chat.mjs'

export const PREFIX = 'dsh:'
export const ANSWER_ON_COMPUTER = 'Answer on the computer'
/** One answer at most, in milliseconds. */
export const REQUEST_MS = 5000
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
const MEMORY_TEXT_MAX = 4096
const MEMORY_ID = /^[A-Za-z0-9_-]{1,32}$/
const MEMORY_REV = /^[0-9a-f]{16}$/
const socketMethod = (method) => method.replace('.', '-')
const writableHello = (hello) => hello?.readOnly === false && hello?.write === 1
const validHello = (hello) => hello?.protocol === 1 && (hello.readOnly === true || writableHello(hello))
const socketError = (kind, written = false) => Object.assign(new Error(kind), { kind, written })
const memoryOffline = (reading, written) => (!reading && written ? { ok: false, state: 'unknown', reason: 'offline' } : memoryRefused('offline'))

export const isDsh = (terminal) => typeof terminal === 'string' && terminal.startsWith(PREFIX)

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

const rowsCut = (e) => (Array.isArray(e?.rows) ? { ...e, rows: e.rows.map(cutRow) } : e)

export class DshSource {
  /**
   * `paths` are tried in order (socketPaths); `path` is one place only.
   * @param {{ path?: string, paths?: string[], connect?: typeof createConnection, check?: (path: string) => boolean, log?: (...a: any[]) => void, requestMs?: number, now?: () => number }} [options]
   */
  constructor({ path, paths = path === undefined ? socketPaths() : [path], connect = createConnection, check = ownerOnly, log = () => {}, requestMs = REQUEST_MS, now = Date.now } = {}) {
    Object.assign(this, { paths, connect, check, log, requestMs, now })
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
    this.opening = new Promise((done) => {
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
          let hello = await this.ask(socket, 'hello', { write: 1 })
          if (validHello(hello) && writableHello(hello) && !this.stopped && !socket.destroyed) {
            hello = await this.ask(socket, 'hello', { write: 1, manage: 1 })
          }
          if (!validHello(hello)) {
            this.log('chat: the DSH socket answers neither read-only nor write: 1; not used')
            socket.destroy()
            return
          }
          if (this.stopped || socket.destroyed) return
          const methods = Array.isArray(hello.methods) ? hello.methods : []
          const manageMethods = Array.isArray(hello.manageMethods) ? hello.manageMethods : []
          this.writes = new Set(writableHello(hello) ? Object.values(WRITE_METHODS).filter((m) => methods.includes(m)) : [])
          this.manages = new Set(writableHello(hello) && hello.manage === 1 ? MEMORY_METHODS.filter((m) => manageMethods.includes(socketMethod(m))) : [])
          this.path = path
          if (this.team?.path !== path) this.team = { path }
          this.socket = socket
          done(socket)
        } catch {
          socket.destroy()
        }
      })
    }).finally(() => { this.opening = null; this.openingSocket = null })
    return this.opening
  }

  ask(socket, method, params, { timeout = this.requestMs, accept } = {}) {
    if (!socket || socket.destroyed) return Promise.reject(socketError('unavailable'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const p = { socket, resolve, reject, accept, written: false }
      p.fail = (kind) => {
        if (!this.pending.delete(id)) return
        clearTimeout(p.timer)
        reject(socketError(kind, p.written))
      }
      p.timer = setTimeout(() => p.fail('timeout'), timeout)
      p.timer.unref?.()
      this.pending.set(id, p)
      try {
        socket.write(`${JSON.stringify({ id, method, params })}\n`, (error) => { if (error) p.fail('unavailable') })
        p.written = true
      } catch {
        p.fail('unavailable')
      }
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
      this.pending.delete(m.id)
      clearTimeout(p.timer)
      if (m.error) p.reject(Object.assign(new Error(String(m.error.message ?? m.error.kind)), { kind: m.error.kind, detail: m.error }))
      else p.resolve(m.result)
      return
    }
    const sub = Number.isSafeInteger(m?.channel) ? this.subs.get(m.channel) : null
    if (sub?.socket !== socket || !m.event || typeof m.event.type !== 'string') return
    const e = rowsCut(m.event)
    if (e.type === 'snapshot' || e.type === 'status') sub.status = e.status ?? sub.status
    if (e.type === 'snapshot' || e.type === 'approval') sub.approval = e.type === 'snapshot' ? e.approval : (e.row?.open === false ? null : e.row)
    try { sub.listener(e) } catch {}
  }

  onClose(socket) {
    if (this.socket === socket) { this.socket = null; this.writes.clear(); this.manages.clear() }
    for (const p of this.pending.values()) if (p.socket === socket) p.fail('unavailable')
    for (const [client, grant] of this.grants) {
      if (grant.socket !== socket) continue
      grant.state = 'closed'
      this.grants.delete(client)
    }
    for (const [channel, sub] of this.subs) {
      if (sub.socket !== socket) continue
      this.subs.delete(channel)
      try { sub.listener({ type: 'gone', reason: 'unavailable' }) } catch {}
    }
  }

  liveClient(client, socket) {
    return !client.closed && !this.stopped && socket === this.socket && Boolean(socket && !socket.destroyed)
  }

  /** Open a grant before answering the phone's hello, when there is a method to negotiate. */
  openManage(client, requested) {
    const { socket, team } = this
    if (typeof client.device !== 'string' || !client.device || !this.liveClient(client, socket)) return null
    const methods = requested.filter((method) => this.manages.has(method))
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
      const accept = (result) => result && typeof result === 'object' && !Array.isArray(result) && Object.keys(result).length === 0
      this.ask(socket, 'manage-close', { grant: id }, { timeout: CLOSE_MS, accept }).catch(() => socket.destroy())
    }
  }

  closeClient(client) {
    this.negotiated.delete(client)
    const grant = this.grants.get(client)
    if (grant) this.releaseGrant(grant)
  }

  async memory(client, method, params) {
    const agreed = this.negotiated.get(client)
    if (client.closed || !agreed?.methods.has(method) || agreed.team !== this.team) return memoryRefused('read-only')
    const socket = await this.open().catch(() => null)
    if (!this.liveClient(client, socket) || agreed.team !== this.team || !this.manages.has(method)) return memoryRefused('read-only')
    const grant = await this.openGrant(client, socket)
    if (!this.liveClient(client, socket) || grant?.state !== 'open') return memoryRefused('read-only')

    const { terminal, id, rev, text } = params
    const reading = method === 'memory.read'
    const editing = method === 'memory.edit'
    if (!isDsh(terminal) || terminal.length <= PREFIX.length || terminal.length > 128 ||
      (!reading && (typeof text !== 'string' || Buffer.byteLength(text) > MEMORY_TEXT_MAX)) ||
      (editing && (typeof id !== 'string' || !MEMORY_ID.test(id) || typeof rev !== 'string' || !MEMORY_REV.test(rev)))) {
      return memoryRefused('invalid')
    }
    const key = client.device
    const now = this.now()
    const phone = this.phoneState(key, now)
    const times = reading ? phone.reads : phone.times
    if (phone.memoryBusy.has(terminal)) return memoryRefused('busy')
    if (times.length >= (reading ? READS_PER_MINUTE : WRITES_PER_MINUTE)) return memoryRefused('rate')
    if (!this.liveClient(client, socket) || grant.state !== 'open') return memoryRefused('read-only')
    times.push(now)
    phone.memoryBusy.add(terminal)
    try {
      const result = await this.ask(socket, socketMethod(method), { grant: grant.id, terminal, ...(reading ? {} : { text }), ...(editing ? { id, rev } : {}) })
      if (client.closed) return memoryRefused('read-only')
      return this.liveClient(client, socket) ? result : memoryOffline(reading, true)
    } catch (error) {
      if (client.closed) return memoryRefused('read-only')
      if (error.detail) return memoryRefused(typeof error.kind === 'string' && error.kind ? error.kind : 'failed')
      return memoryOffline(reading, error.written)
    } finally {
      phone.memoryBusy.delete(terminal)
      this.trimPhone(key, phone, this.now())
    }
  }

  trimPhone(key, phone, now) {
    phone.times = phone.times.filter((t) => now - t < 60_000)
    phone.reads = phone.reads.filter((t) => now - t < 60_000)
    for (const [terminal, at] of phone.interrupts) if (now - at >= INTERRUPT_MS) phone.interrupts.delete(terminal)
    if (!phone.times.length && !phone.reads.length && !phone.interrupts.size && !phone.busy.size && !phone.memoryBusy.size) this.phones.delete(key)
  }

  phoneState(key, now) {
    const phone = this.phones.get(key) ?? { times: [], reads: [], interrupts: new Map(), busy: new Set(), memoryBusy: new Set() }
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

  /**
   * A subscription handle in the engine's shape. The snapshot comes from the socket, so the route
   * calls start(after) instead of building one (`streamsSnapshot`).
   */
  watch(terminal, client, listener) {
    const channel = this.nextChannel++
    const sub = { socket: null, listener, status: null, approval: null, client, terminal }
    return {
      streamsSnapshot: true,
      start: async (after) => {
        this.subs.set(channel, sub)
        try {
          const socket = await this.open()
          if (this.subs.get(channel) !== sub) return
          sub.socket = socket
          await this.ask(socket, 'subscribe', { terminal, channel, ...(typeof after === 'string' ? { after } : {}) })
        } catch (error) {
          if (!this.subs.delete(channel)) return
          try { listener({ type: 'gone', reason: error.kind ?? 'unavailable' }) } catch {}
        }
      },
      rows: () => null,
      screen: () => [],
      status: () => sub.status,
      approval: () => sub.approval,
      held: () => [],
      backfill: async (before, limit) => {
        const result = await this.ask(sub.socket, 'backfill', { channel, before, limit })
        return page(Array.isArray(result?.rows) ? result.rows : [])
      },
      close: () => {
        if (this.subs.delete(channel) && sub.socket) this.ask(sub.socket, 'unsubscribe', { channel }).catch(() => {})
      },
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
    const socket = this.socket
    if (!socket || socket.destroyed || !this.writes.has(method)) return refusedDsh(id)
    const key = client?.device
    if (typeof key !== 'string' || !key) return refusedDsh(id)
    const channel = [...this.subs.entries()].find(([, s]) => s.socket === socket && s.client === client && s.terminal === terminal)?.[0]
    if (channel === undefined) return refused('not-watching', id)
    const now = this.now()
    const phone = this.phoneState(key, now)
    if (phone.busy.has(terminal)) return refused('busy', id)
    if (phone.times.length >= WRITES_PER_MINUTE) return refused('rate', id)
    if (method === 'interrupt' && now - (phone.interrupts.get(terminal) ?? -Infinity) < INTERRUPT_MS) return refused('rate', id)
    phone.times.push(now)
    if (method === 'interrupt') phone.interrupts.set(terminal, now)
    phone.busy.add(terminal)
    try {
      const result = await this.ask(socket, method, { channel, ...params, by, phone: key })
      if (!result || typeof result !== 'object' || Array.isArray(result)) return refused('failed', id)
      return id === undefined || Object.hasOwn(result, 'id') ? result : { ...result, id }
    } catch (error) {
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
    openManage: (client, methods) => dsh.openManage(client, methods),
    memory: (client, method, params) => dsh.memory(client, method, params),
    closeClient: (client) => {
      try { dsh.closeClient(client) } finally { engine.closeClient?.(client) }
    },
    ready: () => engine.ready(),
    async list() {
      const [terminals, bots] = await Promise.all([engine.list(), dsh.list().catch(() => [])])
      return [...terminals, ...bots]
    },
    watch: (terminal, client, listener) => (isDsh(terminal) ? dsh.watch(terminal, client, listener) : engine.watch(terminal, client, listener)),
    send: (client, terminal, m) => (isDsh(terminal) ? dsh.write(client, terminal, 'send', { text: m?.text, id: m?.id }, { by }) : engine.send(client, terminal, m)),
    sendHeld: (client, terminal, m) => (isDsh(terminal) ? refusedDsh(m?.id) : engine.sendHeld(client, terminal, m)),
    cancelHeld: (client, terminal, m) => (isDsh(terminal) ? refusedDsh(m?.id) : engine.cancelHeld(client, terminal, m)),
    answer: (client, terminal, a) => (isDsh(terminal)
      ? dsh.write(client, terminal, 'answer', { row: a?.row, choice: a?.choice, ...(typeof a?.text === 'string' ? { text: a.text } : {}) }, { by })
      : engine.answer(client, terminal, a)),
    interrupt: (client, terminal) => (isDsh(terminal) ? dsh.write(client, terminal, 'interrupt', {}, { by }) : engine.interrupt(client, terminal)),
  }
}
