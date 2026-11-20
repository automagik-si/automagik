// Pocket Link's chat route, `herdr-pocket/chat/1` (RFC 0015, "The phone: a chat route in Pocket
// Link"). bridge.mjs hands it a paired phone's stream once guard.mjs has admitted the key and
// read its header line; nothing here imports iroh, so `node --test` runs it.
//
// Wire: what the app already speaks to herdr-core (CoreClient.kt). A `hello` line (generation 1,
// framed) is answered with a line that also says `chat: 1` and the credit window; then frames:
// a 9-byte little-endian header (channel u32, kind u8, length u32) and the payload. JSON-RPC
// requests and answers on channel 0; each subscription's events on its own channel as JSON lines,
// sent only while the phone has credit for them (CREDIT frames add to it; it starts at CREDIT_WINDOW).
// CLOSE on a channel ends that subscription, and is answered with one CLOSE.
//
// Methods: chat.list; chat.subscribe {terminal, after?} -> {channel}; chat.backfill
// {terminal, before, limit?}; chat.send {terminal, text, id}; chat.sendHeld / chat.cancelHeld
// {terminal, id}; chat.answer {terminal, row, choice, text?}; chat.interrupt {terminal}. Every chat write
// needs a subscription to that terminal on this connection (the engine refuses others). Rows are never
// logged. A `dsh:<botId>` terminal is an Automagik Bot's chat (dsh-source.mjs): chat.send,
// chat.interrupt and chat.answer on it reach the bots-dsh socket only when that socket answered
// `write: 1`, and the hello answer then says `dshWrite: true`; otherwise they are refused
// `read-only`, and a phone that sees no `dshWrite` keeps the DSH chat read-only.
// RFC 0036 adds memory.read, memory.edit and memory.add on channel 0. They need a grant
// opened at hello for this connection's opted-in methods. Their replies are live-only.

/** Frame kinds, as herdr-core's. */
export const DATA = 0
export const CREDIT = 1
export const CLOSE = 2
/** Bytes a subscription may send before the phone grants more (returned in the hello answer). */
export const CREDIT_WINDOW = 256 * 1024
/** RFC 0015 limits. */
export const MAX_SUBSCRIPTIONS = 8
export const ROW_TEXT_MAX = 64 * 1024
export const BACKFILL_ROWS = 200
export const BACKFILL_BYTES = 1024 * 1024
export const SEND_TEXT_MAX = 32 * 1024
/** No frame from the phone is bigger (a request is small, CREDIT 4 bytes, CLOSE none): past it, the connection ends. */
export const MAX_REQUEST = 256 * 1024
/** Requests answered at once; more get `busy`. */
export const MAX_IN_FLIGHT = 16
/** Bytes written but not yet taken by the phone; past this the connection ends ('slow'). */
export const MAX_UNSENT = 4 * 1024 * 1024
/** Engines one paired phone may use at once (so one phone cannot take every session). */
export const MAX_ENGINES_PER_DEVICE = 2
/** Events waiting for credit past this: the subscription is closed ('slow'); the phone resubscribes with its cursor. */
export const MAX_QUEUED = 2 * 1024 * 1024
/** Sessions (hc session names) with an engine at once. */
export const MAX_ENGINES = 8

export const METHODS = ['chat.list', 'chat.subscribe', 'chat.backfill', 'chat.send', 'chat.sendHeld', 'chat.cancelHeld', 'chat.answer', 'chat.interrupt']
export const MEMORY_METHODS = ['memory.read', 'memory.edit', 'memory.add']
export const memoryRefused = (reason) => ({ ok: false, state: 'refused', reason })

/** Queue writes in wire order, checking whether a chunk can still go when its turn comes. */
export function chatWriter({ send, isClosed, isRevoked, onFail }) {
  let writing = Promise.resolve()
  const write = (bytes, { liveOnly = false } = {}) => (writing = writing.then(() => {
    if (isRevoked() || (liveOnly && isClosed())) return
    return send(bytes)
  }).catch(onFail))
  write.done = () => writing
  return write
}

/** One frame's bytes. */
export function frame(channel, kind, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(9)
  head.writeUInt32LE(channel, 0)
  head.writeUInt8(kind, 4)
  head.writeUInt32LE(payload.length, 5)
  return Buffer.concat([head, payload])
}

const credit = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b }

/** A row as sent: a text longer than ROW_TEXT_MAX is cut, and says so ("open in terminal"). */
export function cutRow(row) {
  if (typeof row?.text !== 'string' || row.text.length <= ROW_TEXT_MAX) return row
  return { ...row, text: `${row.text.slice(0, ROW_TEXT_MAX)}…`, cut: true }
}

/** The newest rows that fit a page: at most BACKFILL_ROWS and BACKFILL_BYTES of JSON. */
export function page(rows) {
  const out = []
  let bytes = 0
  for (let i = rows.length - 1; i >= 0 && out.length < BACKFILL_ROWS; i--) {
    const r = cutRow(rows[i])
    const size = Buffer.byteLength(JSON.stringify(r))
    if (bytes + size > BACKFILL_BYTES) break
    bytes += size
    out.unshift(r)
  }
  return out
}

const errorOf = (id, kind, message = kind) => ({ jsonrpc: '2.0', id, error: { code: -32000, message, data: { kind } } })

/**
 * One phone connection on the chat route.
 * @param {{ engine: any, write(bytes: Buffer, opts?: {liveOnly?: boolean}): (Promise<void> | void), end(reason: string): void, log?: (l: string) => void,
 *   device?: string, window?: number, maxQueued?: number, maxUnsent?: number }} options
 *   device: the paired key guard.mjs admitted (stable across reconnects): message ids are kept under it
 *   write: bytes to the phone, in order; a promise that settles once they are taken counts them
 *   as unsent until then. end: close the connection
 */
export class ChatConnection {
  constructor({ engine, write, end, log = () => {}, device, window = CREDIT_WINDOW, maxQueued = MAX_QUEUED, maxUnsent = MAX_UNSENT }) {
    Object.assign(this, { engine, sendBytes: write, endConn: end, log, window, maxQueued, maxUnsent })
    /** What the phone sent and is not read yet: chunks, joined only as far as a frame needs. */
    this.chunks = []
    this.length = 0
    this.unsent = 0
    this.inFlight = 0
    this.framed = false
    this.negotiating = false
    this.closed = false
    /** channel -> { terminal, handle, credit, queue: Buffer[], queued } */
    this.subs = new Map()
    /** terminal -> channel */
    this.byTerminal = new Map()
    this.nextChannel = 1
    this.client = { connection: this, device, closed: false }
  }

  /** Bytes to the phone, counted until taken: a phone that stops reading cannot grow memory. */
  write(bytes, opts) {
    if (this.closed) return
    this.unsent += bytes.length
    if (this.unsent > this.maxUnsent) { this.close('slow'); return }
    const done = () => { this.unsent -= bytes.length }
    const p = this.sendBytes(bytes, opts)
    if (p && typeof p.then === 'function') p.then(done, done)
    else done()
  }

  /** The first `n` bytes read and not yet taken, as one buffer (joins only those chunks). */
  peek(n) {
    if (this.chunks[0]?.length >= n) return this.chunks[0].subarray(0, n)
    const parts = []
    let got = 0
    for (const c of this.chunks) { parts.push(c); got += c.length; if (got >= n) break }
    const joined = Buffer.concat(parts)
    this.chunks.splice(0, parts.length, joined)
    return joined.subarray(0, n)
  }

  /** Take the first `n` bytes. */
  take(n) {
    const out = Buffer.from(this.peek(n))
    const first = this.chunks[0]
    if (first.length === n) this.chunks.shift()
    else this.chunks[0] = first.subarray(n)
    this.length -= n
    return out
  }

  /** Bytes from the phone. */
  feed(bytes) {
    if (this.closed) return
    const b = Buffer.from(bytes)
    if (b.length) { this.chunks.push(b); this.length += b.length }
    try {
      if (!this.framed && !this.negotiating) this.readHello()
      if (this.negotiating && this.length > MAX_REQUEST) return this.close('hello too long')
      while (this.framed && !this.closed && this.length >= 9) {
        const head = this.peek(9)
        const channel = head.readUInt32LE(0)
        const kind = head.readUInt8(4)
        const length = head.readUInt32LE(5)
        if (length > MAX_REQUEST) return this.close('frame too big')
        if (this.length < 9 + length) return
        this.take(9)
        this.onFrame(channel, kind, this.take(length))
      }
    } catch (e) {
      this.log(`chat: bad input: ${e.message}`)
      this.close('bad request')
    }
  }

  readHello() {
    if (!this.length) return
    const all = this.peek(Math.min(this.length, MAX_REQUEST + 1))
    const at = all.indexOf(10)
    if (at === -1) { if (this.length > MAX_REQUEST) this.close('hello too long'); return }
    const line = this.take(at + 1).subarray(0, at).toString('utf8')
    let m
    try { m = JSON.parse(line) } catch { return this.close('bad hello') }
    if (m?.method !== 'hello' || m.params?.generation !== 1 || m.params?.framed !== true) {
      this.write(Buffer.from(JSON.stringify(errorOf(m?.id ?? null, 'unsupported', 'chat/1 needs hello with generation 1, framed')) + '\n'))
      return this.close('unsupported')
    }
    const result = {
      generation: 1, framed: true, chat: 1, credit: this.window, methods: METHODS, ...(this.engine.dshWrite?.() === true ? { dshWrite: true } : {}),
      limits: { subscriptions: MAX_SUBSCRIPTIONS, rowText: ROW_TEXT_MAX, backfillRows: BACKFILL_ROWS, backfillBytes: BACKFILL_BYTES, sendText: SEND_TEXT_MAX },
    }
    const answer = (manage) => {
      if (this.closed) return
      if (manage?.length) result.manage = manage
      this.write(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n'))
      this.framed = true
    }
    const requested = Array.isArray(m.params.manage) ? MEMORY_METHODS.filter((method) => m.params.manage.includes(method)) : []
    if (!requested.length) return answer()
    this.negotiating = true
    let opening
    try { opening = this.engine.openManage?.(this.client, requested) } catch {}
    if (!opening) {
      this.negotiating = false
      return answer()
    }
    const finish = (manage) => {
      if (this.closed) return
      this.negotiating = false
      answer(manage)
      this.feed(Buffer.alloc(0))
    }
    Promise.resolve(opening).catch(() => {}).then(finish).catch(() => this.close('hello failed'))
  }

  onFrame(channel, kind, payload) {
    if (channel === 0) {
      if (kind !== DATA) return
      let m
      try { m = JSON.parse(payload.toString('utf8')) } catch { return this.close('bad request') }
      const liveOnly = typeof m?.method === 'string' && m.method.startsWith('memory.')
      const opts = liveOnly ? { liveOnly: true } : undefined
      if (this.inFlight >= MAX_IN_FLIGHT) { this.reply(errorOf(m?.id ?? null, 'busy', `at most ${MAX_IN_FLIGHT} requests at once`), opts); return }
      this.inFlight += 1
      this.request(m)
        .then((answer) => this.reply(answer, opts), (e) => {
          this.log(liveOnly ? 'chat: memory request failed' : `chat: ${e.message}`)
          this.reply(errorOf(m?.id ?? null, 'failed'), opts)
        })
        .finally(() => { this.inFlight -= 1 })
      return
    }
    const sub = this.subs.get(channel)
    if (!sub) return
    // Credit never grows past the window: a phone cannot ask for more than it was given.
    if (kind === CREDIT && payload.length >= 4) { sub.credit = Math.min(sub.credit + payload.readUInt32LE(0), this.window); this.pump(channel) }
    else if (kind === CLOSE) this.unsubscribe(channel, { answer: true })
  }

  reply(m, opts) { if (!this.closed) this.write(frame(0, DATA, Buffer.from(JSON.stringify(m))), opts) }

  async request(m) {
    const id = m?.id ?? null
    const p = m?.params && typeof m.params === 'object' ? m.params : {}
    const ok = (result) => ({ jsonrpc: '2.0', id, result })
    const terminal = typeof p.terminal === 'string' && p.terminal.length <= 128 ? p.terminal : null
    switch (m?.method) {
      case 'chat.list':
        // A just-made engine has not heard from herdr-core yet: wait for its first snapshot.
        await this.engine.ready()
        // The DSH chats (dsh-source.mjs) are listed over a socket: list() may be async.
        return ok({ terminals: await this.engine.list() })
      case 'chat.subscribe': {
        if (!terminal) return errorOf(id, 'invalid_params', 'terminal')
        if (this.byTerminal.has(terminal)) return ok({ channel: this.byTerminal.get(terminal) })
        if (this.subs.size >= MAX_SUBSCRIPTIONS) return errorOf(id, 'too_many', `at most ${MAX_SUBSCRIPTIONS} subscriptions`)
        const channel = this.subscribe(terminal, typeof p.after === 'string' ? p.after : null)
        return channel === null ? errorOf(id, 'too_many', 'this session holds too many terminals') : ok({ channel })
      }
      case 'chat.backfill': {
        const sub = terminal && this.subs.get(this.byTerminal.get(terminal))
        if (!sub) return errorOf(id, 'not_watching')
        if (typeof p.before !== 'string') return errorOf(id, 'invalid_params', 'before')
        const limit = Math.min(Math.max(1, Number.isInteger(p.limit) ? p.limit : 50), BACKFILL_ROWS)
        return ok({ rows: page(await sub.handle.backfill(p.before, limit)) })
      }
      case 'chat.send': {
        if (!terminal || typeof p.id !== 'string') return errorOf(id, 'invalid_params')
        if (typeof p.text !== 'string' || Buffer.byteLength(p.text, 'utf8') > SEND_TEXT_MAX) return ok({ state: 'refused', id: p.id, reason: 'too-long' })
        return ok(await this.engine.send(this.client, terminal, { text: p.text, id: p.id }))
      }
      case 'chat.sendHeld':
        if (!terminal || typeof p.id !== 'string') return errorOf(id, 'invalid_params')
        return ok(await this.engine.sendHeld(this.client, terminal, { id: p.id }))
      case 'chat.cancelHeld':
        if (!terminal || typeof p.id !== 'string') return errorOf(id, 'invalid_params')
        return ok(await this.engine.cancelHeld(this.client, terminal, { id: p.id }))
      case 'chat.answer':
        if (!terminal || typeof p.row !== 'string' || typeof p.choice !== 'string') return errorOf(id, 'invalid_params')
        // text: a question's free-text answer (choice 'other', chat/question.js); nothing else reads it.
        if (p.text !== undefined && typeof p.text !== 'string') return errorOf(id, 'invalid_params')
        if (typeof p.text === 'string' && Buffer.byteLength(p.text, 'utf8') > SEND_TEXT_MAX) return ok({ ok: false, reason: 'too-long' })
        return ok(await this.engine.answer(this.client, terminal, { row: p.row, choice: p.choice, ...(typeof p.text === 'string' ? { text: p.text } : {}) }))
      case 'chat.interrupt':
        if (!terminal) return errorOf(id, 'invalid_params')
        return ok(await this.engine.interrupt(this.client, terminal))
      case 'memory.read':
      case 'memory.edit':
      case 'memory.add':
        return ok(this.engine.memory ? await this.engine.memory(this.client, m.method, p) : memoryRefused('read-only'))
      default:
        return errorOf(id, 'unknown_method', String(m?.method ?? ''))
    }
  }

  subscribe(terminal, after) {
    const channel = this.nextChannel++
    const sub = { terminal, handle: null, credit: this.window, queue: [], queued: 0 }
    sub.handle = this.engine.watch(terminal, this.client, (e) => this.event(channel, e))
    if (!sub.handle) return null
    this.subs.set(channel, sub)
    this.byTerminal.set(terminal, channel)
    // A source that sends its own snapshot (a DSH chat, dsh-source.mjs) is started with the cursor.
    if (sub.handle.streamsSnapshot) { sub.handle.start(after); return channel }
    // First: where the chat stands. A cursor still held gets what it missed; one that is not (the
    // bridge restarted, or it fell out of the last 500 rows) gets reset and the latest page.
    const missed = after ? sub.handle.rows(after) : null
    const reset = Boolean(after) && missed === null
    this.event(channel, {
      type: 'snapshot', reset,
      rows: missed && !reset ? page(missed) : page(sub.handle.rows() ?? []),
      screen: sub.handle.screen().map(cutRow), status: sub.handle.status(), approval: sub.handle.approval(),
      question: sub.handle.question?.() ?? null, held: sub.handle.held()
    })
    return channel
  }

  /** One engine event to a subscription, as a JSON line, queued until there is credit. */
  event(channel, e) {
    const sub = this.subs.get(channel)
    if (!sub || this.closed) return
    const out = e.type === 'rows' || e.type === 'screen' ? { ...e, rows: e.rows.map(cutRow) } : e
    const bytes = Buffer.from(JSON.stringify(out) + '\n')
    sub.queue.push(bytes)
    sub.queued += bytes.length
    if (sub.queued > this.maxQueued) { this.unsubscribe(channel, { answer: true, reason: 'slow' }); return }
    this.pump(channel)
  }

  pump(channel) {
    const sub = this.subs.get(channel)
    // An event bigger than the whole window (a full snapshot page) goes when the credit is at the
    // window; the credit goes below zero and the phone's grants bring it back.
    while (sub && sub.queue.length && (sub.queue[0].length <= sub.credit || sub.credit >= this.window)) {
      const bytes = sub.queue.shift()
      sub.queued -= bytes.length
      sub.credit -= bytes.length
      this.write(frame(channel, DATA, bytes))
    }
  }

  unsubscribe(channel, { answer = false, reason } = {}) {
    const sub = this.subs.get(channel)
    if (!sub) return
    this.subs.delete(channel)
    this.byTerminal.delete(sub.terminal)
    sub.handle?.close()
    if (answer && !this.closed) this.write(frame(channel, CLOSE, reason ? Buffer.from(JSON.stringify({ reason })) : Buffer.alloc(0)))
  }

  /** End the connection: every subscription leaves its terminal (which the engine then holds). */
  close(reason = 'closed') {
    if (this.closed) return
    this.client.closed = true
    this.closed = true
    this.chunks = []
    this.length = 0
    try {
      for (const channel of this.subs.keys()) {
        try { this.unsubscribe(channel) } catch {}
      }
    } finally {
      try { this.engine.closeClient?.(this.client) } finally { this.endConn(reason) }
    }
  }
}

/**
 * One engine per hc session name, made on first use, closed once its last chat connection has
 * closed and its hold (10 minutes after the last client) is over. At most MAX_ENGINES: past that,
 * an engine no connection uses is closed first; if every one is in use, the new one is refused.
 */
export class ChatEngines {
  /** @param {{ make(name: string): any, max?: number, perDevice?: number }} options  make: a new engine for a session name */
  constructor({ make, max = MAX_ENGINES, perDevice = MAX_ENGINES_PER_DEVICE }) {
    Object.assign(this, { make, max, perDevice })
    /** name -> { engine, connections: Set } */
    this.byName = new Map()
  }

  /**
   * The engine for a session, for one more connection of `device`; null when every engine is in
   * use, or when that device already uses `perDevice` other sessions.
   */
  acquire(name, connection, device = connection) {
    const others = [...this.byName.entries()].filter(([n, x]) => n !== name && [...x.connections].some((c) => x.devices.get(c) === device))
    if (others.length >= this.perDevice) return null
    let e = this.byName.get(name)
    if (!e) {
      if (this.byName.size >= this.max) {
        const idle = [...this.byName.entries()].find(([, x]) => !x.connections.size)
        if (!idle) return null
        this.closeEngine(idle[0])
      }
      e = { engine: this.make(name), connections: new Set(), devices: new Map() }
      e.engine.onEmpty = () => { if (!e.connections.size && this.byName.get(name) === e) this.closeEngine(name) }
      this.byName.set(name, e)
    }
    e.connections.add(connection)
    e.devices.set(connection, device)
    return e.engine
  }

  release(name, connection) {
    const e = this.byName.get(name)
    if (!e) return
    e.connections.delete(connection)
    e.devices.delete(connection)
    if (!e.connections.size && e.engine.empty) this.closeEngine(name)
  }

  closeEngine(name) {
    const e = this.byName.get(name)
    if (!e) return
    this.byName.delete(name)
    try { e.engine.close() } catch {}
  }

  closeAll() { for (const name of [...this.byName.keys()]) this.closeEngine(name) }
}
