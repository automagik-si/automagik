// The caller's Remote stream mux. Its connection, uplink inbox and heartbeat are ported from
// DeepSeek Harness, packages/api/gateway/src/stream-server.ts (MIT License, Copyright (c) 2026
// DeepSeek; see NOTICE). The changes: every stream runs as the caller's fixed Peer inside the
// caller's scope, the downlink drains into a bounded queue per socket and person, items of a
// stream the policy does not filter pass through a caller projection, and frame and stream
// counts are bounded.
import { createHash } from 'node:crypto'
import WebSocket, { WebSocketServer } from 'ws'
import { parseRemoteStreamClientMessage } from '@deepseek-ai/dsh-api-gateway/stream-protocol'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'

export const MUX_LIMITS = Object.freeze({
  heartbeatIntervalMs: 2000,
  missedHeartbeats: 2,
  streamInboxBytes: 262_144,
  maxStreamsPerSocket: 64,
  maxStreamIdBytes: 256,
  maxPayloadBytes: 1_048_576,
  maxFragmentsPerMessage: 1024,
  personQueueBytes: 8_388_608,
  // At least 64 bytes of budget per writer entry, with one quarter for each socket.
  maxWriterEntriesPerPerson: 131_072,
  maxWriterEntriesPerSocket: 32_768,
  maxWriteDelayMs: 10_000,
})

// The two streams whose items the caller projection never sees: the access snapshot and the
// forwarded-event stream, whose items DSH decides per client before they are queued.
const UNPROJECTED = new Set(['remoteAccess/follow', '$events'])
const UPLINK_DONE = Object.freeze({ value: undefined, done: true })
const MAX_RESOURCE_KEY_BYTES = 512

const personKey = principal => JSON.stringify([principal.instance, principal.person?.issuer, principal.person?.subject])

function localFailure(error) {
  const remote = remoteErrorOf(error)
  if (remote !== undefined) return { code: remote.code, message: remote.message, details: remote.details }
  return { code: 'gateway/internal', message: error instanceof Error ? error.message : String(error), details: {} }
}

function rawText(data) {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

// A passive reader of the client's frame headers. It counts the frames of one message without
// consuming any bytes and reports the first message with more than `limit` frames. Control
// frames may interleave a fragmented message and do not count.
export function fragmentCounter(limit, exceeded) {
  let header = Buffer.alloc(0)
  let skip = 0
  let frames = 0
  let done = false
  return chunk => {
    let offset = 0
    while (!done && offset < chunk.length) {
      if (skip > 0) {
        const step = Math.min(skip, chunk.length - offset)
        skip -= step
        offset += step
        continue
      }
      const needed = header.length < 2 ? 2 : 2 + ((header[1] & 0x7f) === 126 ? 2 : (header[1] & 0x7f) === 127 ? 8 : 0) +
        (header[1] & 0x80 ? 4 : 0)
      const take = Math.min(needed - header.length, chunk.length - offset)
      header = Buffer.concat([header, chunk.subarray(offset, offset + take)])
      offset += take
      if (header.length < 2) continue
      const size = header[1] & 0x7f
      const full = 2 + (size === 126 ? 2 : size === 127 ? 8 : 0) + (header[1] & 0x80 ? 4 : 0)
      if (header.length < full) continue
      const length = size === 126 ? header.readUInt16BE(2) : size === 127 ? Number(header.readBigUInt64BE(2)) : size
      const fin = (header[0] & 0x80) !== 0
      const opcode = header[0] & 0x0f
      header = Buffer.alloc(0)
      skip = length
      if (opcode < 8) {
        frames = opcode === 0 ? frames + 1 : 1
        if (frames > limit) {
          done = true
          exceeded()
          return
        }
        if (fin) frames = 0
      }
    }
  }
}

// The bounded single-consumer uplink queue of one logical stream (DSH's UplinkInbox).
class UplinkInbox {
  queue = []
  bytes = 0
  ended = false
  closed = false
  taken = false
  failure
  wake

  constructor(maxBytes, endpoint, onViolation) {
    this.maxBytes = maxBytes
    this.endpoint = endpoint
    this.onViolation = onViolation
  }

  push(value, frameBytes) {
    if (this.failure !== undefined || this.closed) return
    if (this.ended) {
      this.violate(new RemoteError('gateway/protocol', 'api gateway: Remote stream uplink item after end', { endpoint: this.endpoint }))
      return
    }
    if (this.bytes + frameBytes > this.maxBytes) {
      this.violate(new RemoteError('gateway/uplink-overflow',
        `api gateway: Remote stream uplink exceeded ${String(this.maxBytes)} buffered bytes`, { endpoint: this.endpoint }))
      return
    }
    this.queue.push({ value, bytes: frameBytes })
    this.bytes += frameBytes
    this.signal()
  }

  end() {
    if (this.ended) return
    this.ended = true
    this.signal()
  }

  fail(error) {
    if (this.failure !== undefined) return
    this.failure = error
    this.queue = []
    this.bytes = 0
    this.signal()
  }

  [Symbol.asyncIterator]() {
    if (this.taken) throw new Error('api gateway: Remote stream uplink inbox already has a consumer')
    this.taken = true
    return this
  }

  async next() {
    while (true) {
      if (this.closed) return UPLINK_DONE
      const entry = this.queue.shift()
      if (entry !== undefined) {
        this.bytes -= entry.bytes
        return { value: entry.value, done: false }
      }
      if (this.failure !== undefined) throw this.failure
      if (this.ended) return UPLINK_DONE
      if (this.wake !== undefined) throw new Error('api gateway: Remote stream uplink inbox has one pending read')
      await new Promise(resolve => { this.wake = resolve })
    }
  }

  return() {
    this.closed = true
    this.queue = []
    this.bytes = 0
    this.signal()
    return Promise.resolve(UPLINK_DONE)
  }

  violate(error) {
    this.fail(error)
    this.onViolation(error)
  }

  signal() {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}

/**
 * @param options.wireStream - the gateway's `wireStream`, or a function resolving it from the admitted binding.
 * @param options.scope - the activation's caller scope.
 * @param options.registry - the caller Peer registry; a socket's Peer must be live at every open.
 * @param options.ready - whether the adapter admits callers now.
 * @param options.project - the caller projection ({ principal, endpoint, resourceKey, item }) => item | undefined.
 * Both project() and end() use the endpoint's resourceKey: for session/follow it is the
 * Session ID named by the request address. Global streams have no resourceKey.
 */
export function createMux({ wireStream, scope, registry, ready, project, limits: overrides = {} }) {
  const limits = { ...MUX_LIMITS, ...overrides }
  const gateway = typeof wireStream === 'function' ? wireStream : () => wireStream
  const failure = (conn, error) => (conn.wire?.failure ?? localFailure)(error)
  const server = new WebSocketServer({
    noServer: true, clientTracking: false, perMessageDeflate: false, autoPong: false, maxPayload: limits.maxPayloadBytes,
  })
  const connections = new Set()
  const people = new Map()
  let heartbeat
  let closed = false

  function startHeartbeat() {
    if (heartbeat !== undefined) return
    heartbeat = setInterval(() => {
      for (const conn of connections) {
        if (!live(conn) || conn.ws.readyState !== WebSocket.OPEN) continue
        if (conn.missed >= limits.missedHeartbeats) {
          setImmediate(() => { if (conn.missed >= limits.missedHeartbeats) conn.ws.terminate() })
          continue
        }
        conn.missed++
        queueFrame(conn, { method: 'ping', data: undefined, bytes: 2 })
      }
    }, limits.heartbeatIntervalMs)
    heartbeat.unref()
  }

  const unsent = conn => conn.queuedBytes + (conn.inflight?.bytes ?? 0) + conn.closeBytes
  const entries = conn => conn.queue.length + Number(conn.inflight !== undefined) + Number(conn.closeBytes > 0)
  const bytes = account => account.bytes + account.openBytes + account.streamBytes

  // Count queued frames and writes awaiting completion across the person's sockets.
  function enforce(account) {
    while (bytes(account) > limits.personQueueBytes || account.entries > limits.maxWriterEntriesPerPerson) {
      const size = account.entries > limits.maxWriterEntriesPerPerson ? entries : unsent
      let worst
      for (const conn of account.sockets) {
        if (worst === undefined || size(conn) > size(worst)) worst = conn
      }
      if (!worst || !size(worst)) return
      if (worst.dead) terminate(worst)
      else shut(worst, 1008, 'downlink queue limit')
    }
  }

  function releaseFrame(conn, frame, finalize = true) {
    conn.account.bytes -= frame.bytes
    conn.account.entries--
    if (frame.reservation !== undefined) conn.refusals.delete(frame.reservation)
    if (frame.stream) frame.stream.frames--
    if (finalize) reap(conn, frame.stream)
  }

  function clearWrites(conn) {
    if (conn.inflight) releaseFrame(conn, conn.inflight)
    conn.inflight = undefined
    if (conn.closeBytes) {
      conn.account.bytes -= conn.closeBytes
      conn.account.entries--
      conn.closeBytes = 0
    }
    clearTimeout(conn.delayTimer)
  }

  function terminate(conn) {
    drop(conn)
    clearWrites(conn)
    conn.ws.terminate()
  }

  function reap(conn, stream) {
    if (!stream || stream.source || stream.frames !== 0 || conn.streams.get(stream.id) !== stream) return
    conn.streams.delete(stream.id)
    conn.account.streamBytes -= stream.retainedBytes
  }

  // ws also calls close() when its receiver sees a Close or a protocol error. All of
  // those paths use this budget and deadline, including a Close behind a stalled send.
  function shut(conn, code, reason) {
    if (conn.dead) {
      if (conn.ws.readyState === WebSocket.CLOSING) conn.closeSocket(code, reason)
      return
    }
    drop(conn)
    for (const stream of conn.streams.values()) stop(stream, new Error(reason))
    const closeBytes = code === undefined ? 2 : 4 + Buffer.byteLength(reason ?? '')
    const age = conn.inflight ? performance.now() - conn.inflight.queuedAt : 0
    if (conn.ws.readyState !== WebSocket.OPEN || bytes(conn.account) + closeBytes > limits.personQueueBytes ||
        conn.account.entries >= limits.maxWriterEntriesPerPerson || entries(conn) >= limits.maxWriterEntriesPerSocket ||
        age >= limits.maxWriteDelayMs) {
      terminate(conn)
      return
    }
    conn.closeBytes = closeBytes
    conn.account.bytes += closeBytes
    conn.account.entries++
    conn.delayTimer = setTimeout(() => terminate(conn), limits.maxWriteDelayMs - age).unref()
    conn.closeSocket(code, reason)
  }

  function drop(conn) {
    if (conn.dead) return
    conn.dead = true
    for (const frame of conn.queue) releaseFrame(conn, frame)
    conn.queue = []
    conn.queuedBytes = 0
    conn.delayFrame = undefined
    clearTimeout(conn.delayTimer)
  }

  function dropQueued(conn, stream) {
    const kept = []
    for (const frame of conn.queue) {
      if (frame.stream === stream) {
        conn.queuedBytes -= frame.bytes
        releaseFrame(conn, frame, false)
      } else kept.push(frame)
    }
    conn.queue = kept
    armDelay(conn)
  }

  function enqueue(conn, message, reservation, stream = conn.streams.get(message.streamId)) {
    if (conn.dead) return
    let data
    try {
      data = JSON.stringify(message)
    } catch (cause) {
      throw new Error('api gateway: Remote stream item is not JSON serializable', { cause })
    }
    const bytes = Buffer.byteLength(data, 'utf8')
    queueFrame(conn, { method: 'send', data, bytes, stream, reservation })
  }

  function queueFrame(conn, frame) {
    if (!live(conn)) return
    frame.queuedAt = performance.now()
    if (frame.stream) frame.stream.frames++
    conn.queue.push(frame)
    conn.queuedBytes += frame.bytes
    conn.account.bytes += frame.bytes
    conn.account.entries++
    armDelay(conn)
    if (entries(conn) > limits.maxWriterEntriesPerSocket) shut(conn, 1008, 'downlink queue limit')
    enforce(conn.account)
    write(conn).catch(() => { shut(conn, 1011, 'Remote stream write failed') })
  }

  // A frame unsent for maxWriteDelayMs, queued or awaiting its send callback, closes its socket.
  function armDelay(conn) {
    if (conn.dead) return
    const oldest = conn.inflight ?? conn.queue[0]
    if (oldest === conn.delayFrame) return
    clearTimeout(conn.delayTimer)
    conn.delayFrame = oldest
    if (oldest === undefined) return
    const remaining = () => limits.maxWriteDelayMs - (performance.now() - oldest.queuedAt)
    const expire = () => {
      if (conn.dead || (conn.inflight ?? conn.queue[0]) !== oldest) return
      // Timers use whole milliseconds, so the callback can run before the write deadline.
      const delay = remaining()
      if (delay > 0) conn.delayTimer = setTimeout(expire, Math.ceil(delay)).unref()
      else shut(conn, 1008, 'downlink write timed out')
    }
    conn.delayTimer = setTimeout(expire, Math.ceil(remaining())).unref()
  }

  // One writer per socket sends its queue in order, one frame at a time.
  async function write(conn) {
    if (conn.writing) return
    conn.writing = true
    try {
      while (live(conn) && conn.queue.length && conn.ws.readyState === WebSocket.OPEN) {
        const frame = conn.queue.shift()
        conn.queuedBytes -= frame.bytes
        conn.inflight = frame
        const error = await new Promise(resolve => {
          let queued = false
          conn.ws[frame.method](frame.data, error => {
            // A write that did not complete at once counts as peer activity, as in DSH.
            if (!error && queued && frame.method === 'send') conn.missed = 0
            resolve(error)
          })
          queued = conn.ws.bufferedAmount > 0
        })
        if (conn.inflight === frame) {
          conn.inflight = undefined
          releaseFrame(conn, frame)
        }
        armDelay(conn)
        if (error) { shut(conn, 1011, 'Remote stream write failed'); break }
      }
    } finally {
      conn.writing = false
    }
  }

  function sendFailure(conn, streamId, error, reservation) {
    if (!live(conn) || conn.ws.readyState !== WebSocket.OPEN) return
    try {
      enqueue(conn, { type: 'error', streamId, error: failure(conn, error) }, reservation)
    } catch {
      shut(conn, 1011, 'Remote stream failure could not be delivered')
    }
  }

  function live(conn) {
    if (conn.dead) return false
    if (conn.binding && ready() === conn.binding && registry.live(conn.peer)) return true
    shut(conn, 1011, 'caller admission closed')
    return false
  }

  function stop(stream, reason) {
    stream.ended = true
    if (stream.source) {
      stream.source.abort.abort(reason)
      stream.source.inbox.fail(reason)
    }
  }

  function releaseOpen(conn, source) {
    conn.account.openBytes -= source.open.bytes
    source.open = undefined
  }

  async function pump(conn, stream, source) {
    const { principal, peer } = conn
    const { id: streamId, endpoint, resourceKey } = stream
    const { abort, inbox } = source
    let outcome
    try {
      let items
      try {
        if (conn.wire === undefined) {
          throw new RemoteError('gateway/service-unavailable', 'api gateway: the Remote gateway is unavailable', { endpoint })
        }
        const opening = conn.wire.open(endpoint, source.open.payload, inbox, peer, abort.signal)
        source.open.payload = undefined
        items = await opening
      } finally {
        releaseOpen(conn, source)
      }
      const projected = principal.kind !== 'owner' && !UNPROJECTED.has(endpoint)
      for await (const value of items) {
        if (stream.ended || abort.signal.aborted || !live(conn)) break
        let item = value
        if (projected) {
          // Without a caller projection no item of such a stream reaches a caller: it ends.
          if (project === undefined) break
          try {
            item = project({ principal, endpoint, resourceKey, item: value })
          } catch (cause) {
            throw new RemoteError('gateway/internal', `api gateway: ${endpoint}: caller projection failed`, { endpoint }, { cause })
          }
          if (item === undefined) continue
        }
        // end() may have run while the projection or the iterator held this item.
        if (stream.ended || abort.signal.aborted || !live(conn)) break
        enqueue(conn, { type: 'item', streamId, value: item })
      }
      outcome = { failed: false }
    } catch (error) {
      outcome = { failed: true, error }
    }
    inbox.fail(new Error('Remote stream ended'))
    if (stream.ended || !live(conn)) return
    if (abort.signal.aborted) {
      const reason = abort.signal.reason
      if (remoteErrorOf(reason) !== undefined) sendFailure(conn, streamId, reason)
      return
    }
    if (outcome.failed) {
      sendFailure(conn, streamId, outcome.error)
      return
    }
    try {
      enqueue(conn, { type: 'end', streamId })
    } catch (error) {
      sendFailure(conn, streamId, error)
    }
  }

  function openStream(conn, { streamId, endpoint, payload }, messageBytes) {
    const longId = Buffer.byteLength(streamId) > limits.maxStreamIdBytes
    // Keep the refusal key bounded even when the protocol error echoes an oversized ID.
    const reservation = longId ? '#' + createHash('sha256').update(streamId, 'utf16le').digest('hex') : ':' + streamId
    if (conn.streams.has(streamId) || conn.refusals.has(reservation)) {
      throw new Error('api gateway: duplicate Remote stream id')
    }
    const refuse = message => {
      conn.refusals.add(reservation)
      sendFailure(conn, streamId, new RemoteError('gateway/protocol', message, { endpoint }), reservation)
    }
    if (longId) return refuse(`api gateway: a Remote stream id holds at most ${limits.maxStreamIdBytes} bytes`)
    if (conn.streams.size >= limits.maxStreamsPerSocket) {
      return refuse(`api gateway: a socket holds at most ${limits.maxStreamsPerSocket} Remote streams`)
    }
    let resourceKey, resourceBytes = 0
    if (endpoint === 'session/follow') {
      // Use the same address as DSH's Session resource resolver and follow method.
      const address = payload?.args?.request?.address
      const id = address?.kind === 'session' ? address.sessionId
        : address?.kind === 'subagent' ? address.childSessionId : undefined
      if (typeof id !== 'string' || !id || !id.isWellFormed() || Buffer.byteLength(id) > MAX_RESOURCE_KEY_BYTES) {
        return refuse(`api gateway: a Session address needs a nonempty resource key of at most ${MAX_RESOURCE_KEY_BYTES} bytes`)
      }
      const encoded = Buffer.from(id)
      resourceKey = encoded.toString()
      resourceBytes = encoded.length
    }
    if (bytes(conn.account) + messageBytes > limits.personQueueBytes) {
      return refuse('api gateway: the caller has too many pending Remote stream arguments')
    }
    const abort = new AbortController()
    const inbox = new UplinkInbox(limits.streamInboxBytes, endpoint, error => { abort.abort(error) })
    const retainedBytes = Buffer.byteLength(endpoint) + resourceBytes
    // Charge the wire size through DSH's open. Once the pump finishes, only the
    // withdrawal keys and frame count can stay in the stream table.
    const source = { abort, inbox, open: { payload, bytes: messageBytes - retainedBytes } }
    const stream = { id: streamId, endpoint, resourceKey, retainedBytes, source, ended: false, frames: 0 }
    conn.account.openBytes += source.open.bytes
    conn.account.streamBytes += retainedBytes
    conn.streams.set(streamId, stream)
    source.done = scope.run(conn.principal, () => pump(conn, stream, source), { session: conn.session })
    const finish = () => { stream.source = undefined; reap(conn, stream) }
    source.done.then(finish, finish)
  }

  function receive(conn, text) {
    const message = parseRemoteStreamClientMessage(text)
    switch (message.type) {
      case 'open':
        openStream(conn, message, Buffer.byteLength(text))
        return
      case 'item':
        conn.streams.get(message.streamId)?.source?.inbox.push(message.value, Buffer.byteLength(text, 'utf8'))
        return
      case 'end':
        conn.streams.get(message.streamId)?.source?.inbox.end()
        return
      case 'cancel': {
        const stream = conn.streams.get(message.streamId)
        if (stream === undefined) return
        stop(stream, new Error('Remote stream cancelled'))
        dropQueued(conn, stream)
        reap(conn, stream)
        return
      }
      default:
        throw new Error('api gateway: unknown Remote stream client message')
    }
  }

  async function serve(ws, tap, { peer, principal, session, control, binding }) {
    const key = personKey(principal)
    let account = people.get(key)
    if (account === undefined) people.set(key, account = { bytes: 0, entries: 0, openBytes: 0, streamBytes: 0, sockets: new Set() })
    const conn = {
      ws, peer, principal, session, account, streams: new Map(), refusals: new Set(),
      queue: [], queuedBytes: 0, inflight: undefined,
      binding, wire: gateway(binding), closeSocket: ws.close.bind(ws), closeBytes: 0,
      missed: 0, dead: false, writing: false, delayTimer: undefined, delayFrame: undefined,
    }
    ws.close = (code, reason) => shut(conn, code, reason)
    account.sockets.add(conn)
    connections.add(conn)
    if (control) control.close = (code, reason) => shut(conn, code, reason)
    // Close the socket when the Peer's scope is disposed, as DSH binds it.
    let unbind
    try {
      unbind = peer.ctx.effect(() => () => { shut(conn, 1001, 'peer left') }, 'multiuser-dsh: caller stream socket bound to its Peer')
    } catch {
      shut(conn, 1001, 'peer left')
    }
    const closedSocket = new Promise(resolve => { ws.once('close', resolve) })
    ws.on('error', () => { setTimeout(() => ws.terminate(), 1000).unref() })
    ws.on('pong', () => { if (live(conn)) conn.missed = 0 })
    ws.on('ping', data => queueFrame(conn, { method: 'pong', data: Buffer.from(data), bytes: data.length + 2 }))
    ws.on('message', (data, isBinary) => {
      if (tap.exceeded || !live(conn) || ws.readyState !== WebSocket.OPEN) return
      conn.missed = 0
      if (isBinary) {
        ws.close(1003, 'text messages required')
        return
      }
      try {
        receive(conn, rawText(data))
      } catch {
        ws.close(1008, 'invalid Remote stream request')
      }
    })
    startHeartbeat()
    try {
      await closedSocket
    } finally {
      drop(conn)
      clearWrites(conn)
      const active = [...conn.streams.values()].filter(stream => stream.source)
      for (const stream of active) stop(stream, new Error('Remote stream socket closed'))
      await Promise.allSettled(active.map(stream => stream.source.done))
      connections.delete(conn)
      account.sockets.delete(conn)
      if (!account.sockets.size && people.get(key) === account) people.delete(key)
      try { unbind?.() } catch {}
      registry.remove(peer)
      await peer.dispose().catch(() => {})
    }
  }

  return {
    // Resolves once the socket closed, its streams settled, its Peer was disposed and its
    // registry entry removed; also when the handshake fails.
    handleUpgrade(req, socket, head, { peer, principal, session, control, binding }) {
      const { promise, resolve } = Promise.withResolvers()
      if (closed || socket.closed) {
        socket.destroy()
        resolve()
        return promise
      }
      let upgraded = false
      socket.once('close', () => { if (!upgraded) resolve() })
      try {
        server.handleUpgrade(req, socket, head, ws => {
          upgraded = true
          // A message over the frame limit destroys the socket; ws may still deliver it from the
          // same chunk, so the connection drops every message once the tap fired.
          const tap = { exceeded: false }
          // ws unshifted `head` before it attached its reader, so the tap reads it first.
          socket.prependListener('data', fragmentCounter(limits.maxFragmentsPerMessage, () => {
            tap.exceeded = true
            socket.destroy()
          }))
          serve(ws, tap, { peer, principal, session, control, binding }).then(resolve, resolve)
        })
      } catch {
        socket.destroy()
        resolve()
      }
      return promise
    },
    // Withdraw the matching streams at once: their iterators abort, their queued frames are
    // dropped and the client gets one remote-access/denied failure for each. The predicate
    // receives { principal, session, peer, endpoint, streamId, resourceKey }.
    end(predicate, reason = 'access withdrawn') {
      let count = 0
      for (const conn of connections) {
        for (const [streamId, stream] of conn.streams) {
          if (stream.ended || !predicate({
            principal: conn.principal, session: conn.session, peer: conn.peer,
            endpoint: stream.endpoint, streamId, resourceKey: stream.resourceKey,
          })) continue
          count++
          stop(stream, new Error(reason))
          dropQueued(conn, stream)
          if (!conn.dead) {
            enqueue(conn, { type: 'error', streamId, error: failure(conn, new RemoteError('remote-access/denied',
              `remote access: ${stream.endpoint}: access denied (${reason})`, { action: stream.endpoint, reason })) }, undefined, stream)
          }
          reap(conn, stream)
        }
      }
      return count
    },
    closeStaleBindings(binding) {
      for (const conn of connections) {
        if (conn.binding !== binding) shut(conn, 1011, 'caller admission closed')
      }
    },
    async close() {
      closed = true
      clearInterval(heartbeat)
      heartbeat = undefined
      const settling = []
      for (const conn of connections) {
        settling.push(...[...conn.streams.values()].map(stream => stream.source?.done))
        shut(conn, 1011, 'adapter unloaded')
      }
      await Promise.all(settling)
    },
    get size() {
      return connections.size
    },
  }
}
