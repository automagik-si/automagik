// The core bridge's wire (RFC 0030 delivery 1): one herdr-core connection for the Code side,
// opened with `hc connect` and spoken to in its framed protocol. The page never talks to
// herdr-core; this host half does, and relays one terminal's bytes to the pane.
//
// `hc connect` answers a JSON-RPC request per line before the frames start, then frames:
// 9 header bytes, little-endian, `int32 channel`, `uint8 kind`, `int32 length`, then the
// payload. Kind 0 is data: JSON on channel 0 (the answers to calls), terminal bytes on an
// attach's own channel. Kind 1 is credit in 4 bytes, the reader granting the core room for
// more output; kind 2 is a stream close. The attach is `observe: true`: herdr-core itself
// refuses to let this viewer type or resize, so the pane is a watcher, not a second owner.
//
// This module probes for a running core and manages its protocol connection. The
// tree and the route (code-side.js) decide which terminal may be attached.
import { spawn } from 'node:child_process'
import { probeCore } from './core-probe.js'

export const KINDS = Object.freeze({ data: 0, credit: 1, close: 2, resize: 3, focus: 4 })
/** The core's cap on one frame's payload; a header above it is a broken stream. */
export const MAX_FRAME = 16 * 1024 * 1024
/** A call the core does not answer in this long fails the whole connection. */
export const CALL_TIMEOUT_MS = 10_000
/** The first line (the hello) is a JSON object this host reads before any frame. */
export const HELLO_TIMEOUT_MS = 10_000
/** A terminal's history sent on attach, in lines. The core keeps its own bound. */
export const HISTORY_LINES = 1000

/** One frame: the 9-byte little-endian header and the payload. */
export function encodeFrame(channel, kind, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const frame = Buffer.allocUnsafe(9 + body.length)
  frame.writeInt32LE(channel, 0)
  frame.writeUInt8(kind, 4)
  frame.writeInt32LE(body.length, 5)
  body.copy(frame, 9)
  return frame
}

/** A frame's header fields: { channel, kind, length }. Throws on a length the core may not send. */
export function readHeader(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 9) throw new Error('a frame header is 9 bytes')
  const length = bytes.readInt32LE(5)
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_FRAME) throw new Error('a frame length is out of range')
  return { channel: bytes.readInt32LE(0), kind: bytes.readUInt8(4), length }
}

/** The 4-byte little-endian credit for `size` bytes. */
export function creditFrame(size) {
  const body = Buffer.allocUnsafe(4)
  body.writeInt32LE(size, 0)
  return body
}

/** A core failure as the route reports it: its kind when the core named one, never a raw message. */
export class CoreError extends Error {
  constructor(kind, message, options = {}) {
    super(message ?? kind, options)
    this.name = 'CoreError'
    this.kind = kind
  }
}

/**
 * Open one `hc connect` and read its hello.
 * @param {{ bin?: string, env?: NodeJS.ProcessEnv, cwd?: string, onStderr?: (text: string) => void, spawn?: typeof spawn }} [options]
 * @returns {Promise<CoreConnection>}
 */
export async function connectCore({ bin, env = process.env, cwd, onStderr = () => {}, spawn: spawnProcess = spawn } = {}) {
  const socket = await probeCore(env)
  if (socket === null) throw new CoreError('no-core')
  // Use the socket that answered, even when hc's first choice was stale.
  const command = bin ?? (env.HERDR_HC && String(env.HERDR_HC).trim() ? env.HERDR_HC : 'hc')
  const child = spawnProcess(command, ['connect'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, HC_SOCKET: socket }, cwd, windowsHide: true })
  const core = new CoreConnection(child, { onStderr })
  try {
    await core.start()
  } catch (error) {
    core.close()
    throw error
  }
  return core
}

/** One framed connection to this computer's core. */
export class CoreConnection {
  constructor(child, { onStderr = () => {} } = {}) {
    this.child = child
    this.onStderr = onStderr
    this.hello = null
    this.nextId = 1
    this.pending = new Map()
    this.channels = new Map()
    // Frames of a channel no one watches yet: the attach's first paint can arrive in the
    // same read as the reply that names its channel, before `watch` runs. Bounded.
    this.early = new Map()
    this.earlyBytes = 0
    this.buffer = Buffer.alloc(0)
    this.started = false
    this.closed = false
    this.lost = null
    child.stdout.on('data', chunk => this.receive(chunk))
    child.stderr.on('data', chunk => {
      try { this.onStderr(String(chunk).slice(0, 2000)) } catch { /* a logger must not break the bridge */ }
    })
    child.stdin.on('error', () => { /* the close path reports the loss */ })
    child.on('error', error => this.fail(new CoreError('core-unavailable', 'herdr-core could not start', { cause: error })))
    child.on('exit', (code, signal) => {
      if (!this.closed) this.fail(new CoreError('core-exit', `herdr-core exited (${signal ?? code ?? 'unknown'})`))
    })
  }

  /** Whether the connection still answers. */
  get alive() { return this.started && !this.closed }

  /** The hello, once read: { core: { id, name }, version, features, framed, generation }. */
  get info() { return this.hello }

  /** Write the hello and read its one-line answer; then frames begin. */
  start() {
    if (this.started) return Promise.resolve(this.hello)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new CoreError('core-timeout', 'herdr-core did not answer')), HELLO_TIMEOUT_MS)
      const settle = (value, error) => {
        clearTimeout(timer)
        this.helloWaiter = null
        if (error) reject(error)
        else resolve(value)
      }
      this.helloWaiter = settle
      this.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'hello', params: { framed: true, generation: 1 } }) + '\n')
    })
  }

  /** One JSON-RPC call. Resolves its `result`; rejects a CoreError of the core's kind. */
  call(method, params = {}, { timeoutMs = CALL_TIMEOUT_MS } = {}) {
    if (!this.started || this.closed) return Promise.reject(new CoreError('core-closed', 'herdr-core is not connected'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CoreError('core-timeout', `herdr-core did not answer ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      // After the hello line every call is a DATA frame on channel 0, as herdr-core reads it.
      this.writeFrame(0, KINDS.data, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8'))
    })
  }

  /**
   * Attach to one terminal, watching only.
   * @param {{ terminal: string, cols: number, rows: number, history?: number, timeoutMs?: number }} options
   * @returns {Promise<{ channel: number, terminal: object }>} the stream channel and the terminal
   */
  async attach({ terminal, cols, rows, history = HISTORY_LINES, observe = true, timeoutMs = CALL_TIMEOUT_MS }) {
    const result = await this.call('terminal.attach', {
      terminal,
      cols,
      rows,
      history,
      // A watcher (`observe: true`, the Code pane's default) is never allowed to type or
      // resize; the typing piece passes `observe: false` for the one viewer that types.
      observe: observe !== false,
      resize_notifications: true,
    }, { timeoutMs })
    if (!Number.isSafeInteger(result?.channel)) throw new CoreError('core-refused', 'herdr-core attached no stream')
    return { channel: result.channel, terminal: result.terminal ?? null }
  }

  /** Hear one attached stream: `onData(buffer)` for its bytes, `onClose(reason)` when it ends. */
  watch(channel, { onData, onClose = () => {} }) {
    const handler = { onData, onClose }
    this.channels.set(channel, handler)
    const early = this.early.get(channel)
    if (early) {
      this.early.delete(channel)
      for (const frame of early) {
        this.earlyBytes -= frame.payload.length
        if (frame.kind === KINDS.data) onData(frame.payload)
        else if (frame.kind === KINDS.close) {
          this.channels.delete(channel)
          let reason = 'closed'
          try { reason = String(JSON.parse(frame.payload.toString('utf8'))?.reason ?? 'closed') } catch { /* a bare close */ }
          onClose(reason)
          break
        }
      }
    }
    return () => { this.channels.delete(channel) }
  }

  /** Grant the core room for `size` bytes this viewer has taken. */
  credit(channel, size = 0) {
    if (!Number.isSafeInteger(size) || size <= 0) return
    this.writeFrame(channel, KINDS.credit, creditFrame(size))
  }

  /** Close one attached stream (its terminal keeps running). */
  detach(channel) {
    if (!this.channels.has(channel)) return
    this.channels.delete(channel)
    this.writeFrame(channel, KINDS.close)
  }

  /** End the connection: every stream closes, the terminal keeps running, the process goes. */
  close() {
    if (this.closed) return
    this.closed = true
    for (const channel of this.channels.keys()) {
      try { this.writeFrame(channel, KINDS.close) } catch { /* the process is going */ }
    }
    this.channels.clear()
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new CoreError('core-closed', 'herdr-core connection closed'))
    }
    this.pending.clear()
    this.helloWaiter?.(null, new CoreError('core-closed', 'herdr-core connection closed'))
    this.helloWaiter = null
    try { this.child.stdin.end() } catch { /* already gone */ }
    const child = this.child
    const kill = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, 2000)
    kill.unref?.()
    child.once('exit', () => clearTimeout(kill))
    try { child.kill('SIGTERM') } catch { /* gone */ }
  }

  /** Everything the core sent: the hello line first, then frames. */
  receive(chunk) {
    if (this.closed) return
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    if (!this.started) {
      const end = this.buffer.indexOf(10)
      if (end === -1) return
      const line = this.buffer.subarray(0, end).toString('utf8')
      this.buffer = this.buffer.subarray(end + 1)
      this.acceptHello(line)
      if (!this.started) return
    }
    while (this.buffer.length >= 9) {
      let header
      try { header = readHeader(this.buffer) } catch (error) { this.fail(new CoreError('core-protocol', error.message)); return }
      if (this.buffer.length < 9 + header.length) return
      const payload = this.buffer.subarray(9, 9 + header.length)
      this.buffer = this.buffer.subarray(9 + header.length)
      this.dispatch(header, payload)
      if (this.closed) return
    }
  }

  acceptHello(line) {
    let reply = null
    try { reply = JSON.parse(line) } catch { /* reported below */ }
    if (!reply || typeof reply !== 'object') return this.fail(new CoreError('core-protocol', 'herdr-core sent no hello'))
    if (reply.error) return this.fail(new CoreError('core-refused', String(reply.error?.message ?? 'herdr-core refused the hello')))
    const result = reply.result
    if (result?.framed !== true || result?.generation !== 1) return this.fail(new CoreError('core-protocol', 'herdr-core does not speak the framed protocol'))
    this.hello = result
    this.started = true
    this.helloWaiter?.(result, null)
    this.helloWaiter = null
  }

  dispatch(header, payload) {
    if (header.channel === 0) {
      if (header.kind !== KINDS.data) return
      let answer = null
      try { answer = JSON.parse(payload.toString('utf8')) } catch { return }
      const entry = this.pending.get(answer?.id)
      if (!entry) return
      this.pending.delete(answer.id)
      clearTimeout(entry.timer)
      if (answer.error) entry.reject(new CoreError(String(answer.error?.data?.kind ?? 'core-refused'), String(answer.error?.message ?? 'herdr-core refused it')))
      else entry.resolve(answer.result ?? null)
      return
    }
    const channel = this.channels.get(header.channel)
    if (!channel) {
      // The attach's first paint can share a read with the reply that names its channel:
      // keep it, bounded, until `watch` claims it.
      if (header.kind !== KINDS.data && header.kind !== KINDS.close) return
      if (this.earlyBytes + payload.length > MAX_FRAME) return
      const list = this.early.get(header.channel) ?? []
      list.push({ kind: header.kind, payload: Buffer.from(payload) })
      this.early.set(header.channel, list)
      this.earlyBytes += payload.length
      return
    }
    if (header.kind === KINDS.data) channel.onData(payload)
    else if (header.kind === KINDS.close) {
      let reason = 'closed'
      try { reason = String(JSON.parse(payload.toString('utf8'))?.reason ?? 'closed') } catch { /* a bare close */ }
      this.channels.delete(header.channel)
      channel.onClose(reason)
    }
  }

  fail(error) {
    if (this.closed) return
    this.lost = error
    const channels = [...this.channels.values()]
    this.close()
    for (const channel of channels) channel.onClose(error.kind)
  }

  write(text) {
    if (this.closed) return
    try { this.child.stdin.write(text) } catch { this.fail(new CoreError('core-closed', 'herdr-core connection closed')) }
  }

  writeFrame(channel, kind, payload) {
    if (this.closed) return
    try { this.child.stdin.write(encodeFrame(channel, kind, payload)) } catch { this.fail(new CoreError('core-closed', 'herdr-core connection closed')) }
  }
}

/**
 * Run one read-only call on its own connection, then close it: the tree asks for the
 * terminal list, and nothing of that connection outlives the answer.
 */
export async function withCore(fn, options = {}) {
  const core = await connectCore(options)
  try { return await fn(core) } finally { core.close() }
}
