// What a phone can make the bridge do before it is trusted, and how much: a deadline on the
// handshake and the first line, a cap on connections, a throttle on the log lines a stranger can
// cause and a size cap on the log. bridge.mjs hands it iroh's objects; nothing here imports iroh,
// so `node --test` runs it without npm.
import { closeSync, constants, fchmodSync, fstatSync, ftruncateSync, lstatSync, openSync, readSync, writeFileSync } from 'node:fs'

/** The handshake, the first stream and its header line, together; and a whole pairing. */
export const HANDSHAKE_MS = 10_000
/** Connections still in that phase. */
export const MAX_PENDING = 16
/** Connections in that phase from one address: an IPv4 address, an IPv6 /64, or over a relay the key it claims. */
export const MAX_PER_ADDRESS = 4
/** Every connection, open sessions included. */
export const MAX_OPEN = 64
/** A header line is at most this many bytes. */
export const MAX_LINE = 4096
/** The log is copied to <log>.1 and emptied past this size. */
export const LOG_MAX = 1024 * 1024

function checkLog(path, file) {
  if (!file.isFile() || file.nlink !== 1 || file.uid !== process.getuid()) {
    throw new Error(`Unsafe Pocket Link log destination: ${path}`)
  }
  return file
}

function logInfo(path) {
  try { return checkLog(path, lstatSync(path)) } catch (e) { if (e.code !== 'ENOENT') throw e }
}

export function assertSafeLogs(path) {
  logInfo(path)
  logInfo(`${path}.1`)
}

function openLog(path, flags) {
  const fd = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
  try { checkLog(path, fstatSync(fd)); return fd } catch (e) { closeSync(fd); throw e }
}

export const openAppendLog = path => openLog(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT)

/** One line of JSON from a stream, at most MAX_LINE bytes; the rest of what was read comes back too. */
export async function readLine(recv) {
  let buf = Buffer.alloc(0)
  while (!buf.includes(10)) {
    if (buf.length > MAX_LINE) throw new Error('header too long')
    const chunk = await recv.read(MAX_LINE)
    if (!chunk || chunk.length === 0) throw new Error('closed before its header')
    buf = Buffer.concat([buf, Buffer.from(chunk)])
  }
  const end = buf.indexOf(10)
  return { value: JSON.parse(buf.subarray(0, end).toString('utf8')), rest: buf.subarray(end + 1) }
}

/**
 * The connection cap: `enter(address)` gives a slot, or null when full (in all, pending, or pending
 * from that address). A slot is pending until `trusted()`.
 */
export function slots({ pending: maxPending = MAX_PENDING, open: maxOpen = MAX_OPEN, perAddress = MAX_PER_ADDRESS } = {}) {
  let pending = 0, open = 0
  const from = new Map()
  return {
    counts: () => ({ pending, open }),
    enter(address = '?') {
      if (pending >= maxPending || open >= maxOpen || (from.get(address) ?? 0) >= perAddress) return null
      pending++; open++; from.set(address, (from.get(address) ?? 0) + 1)
      let waiting = true, done = false
      const settle = () => {
        if (!waiting) return
        waiting = false; pending--
        const n = from.get(address) - 1
        if (n) from.set(address, n); else from.delete(address)
      }
      return { trusted: settle, done() { if (done) return; done = true; settle(); open-- } }
    },
  }
}

/** The /64 an IPv6 address is in, as its first four groups: one host usually gets a whole /64. */
function ipv6Net(ip) {
  const [head, tail] = ip.split('%')[0].split('::')
  const left = head ? head.split(':') : []
  const right = tail === undefined ? [] : tail ? tail.split(':') : []
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
  return groups.slice(0, 4).map(g => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64'
}

/**
 * Where an incoming connection comes from, before its handshake: the IPv4 address or IPv6 /64 of a
 * direct one, the key a relayed one claims (the relay itself is shared by everyone, the owner's
 * phones too).
 */
export function addressOf(addr) {
  if (addr?.kind === 'ip' && addr.addr) {
    const ip = addr.addr.replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1')
    if (!ip.includes(':')) return `ip:${ip}`
    const v4 = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
    return v4 ? `ip:${v4[1]}` : `ip:${ipv6Net(ip)}`
  }
  if (addr?.kind === 'relay' && addr.endpointId) return `relay:${addr.endpointId}`
  return addr?.kind ?? '?'
}

/**
 * At most `burst` lines of each kind per `per` ms; the first line after a quiet spell says how many
 * were left out. For what any peer can cause: refusals, timeouts, bad headers.
 */
export function throttle(log, { burst = 5, per = 60_000, now = Date.now } = {}) {
  const kinds = new Map()
  return (kind, ...args) => {
    const t = now()
    let k = kinds.get(kind)
    if (!k || t - k.since >= per) {
      const skipped = k?.skipped ?? 0
      k = { since: t, count: 0, skipped: 0 }
      kinds.set(kind, k)
      if (skipped) log(`${kind}: ${skipped} more like this in the last minute`)
    }
    if (k.count < burst) { k.count++; log(`${kind}:`, ...args) } else k.skipped++
  }
}

/**
 * Keeps a log under `max` bytes: copies it to <path>.1 (0600) and empties it in place. The
 * service's stderr is opened to append (launchd, `start`), so it keeps writing at the new end.
 */
export function rotateLog(path, max = LOG_MAX) {
  const file = logInfo(path)
  if (!file || file.size <= max) return false
  const from = openLog(path, constants.O_RDWR)
  try {
    const to = openLog(`${path}.1`, constants.O_WRONLY | constants.O_CREAT)
    try {
      fchmodSync(to, 0o600)
      ftruncateSync(to, 0)
      const chunk = Buffer.alloc(64 * 1024)
      for (let offset = 0; offset < file.size;) {
        const count = readSync(from, chunk, 0, Math.min(chunk.length, file.size - offset), offset)
        if (!count) break
        writeFileSync(to, chunk.subarray(0, count))
        offset += count
      }
      ftruncateSync(from, 0)
      return true
    } finally { closeSync(to) }
  } finally { closeSync(from) }
}

const closeConn = (conn, why) => { try { conn.close(1n, [...Buffer.from(why)]) } catch {} }

/**
 * One incoming connection. One whose source address isn't validated yet is sent a QUIC retry
 * first, so a spoofed source never takes a slot; it comes back as a new, validated one. Over the
 * cap (see `slots`) it is refused before its handshake. Then,
 * within `ms`: the handshake, `admit(peer)` (false closes it with `closing` before anything is
 * read), the first stream and its header line. A route with `timed` (pairing) also runs, and waits
 * for the phone to hang up, inside that deadline; a session runs untimed once its header is in.
 *
 * `routes`: { [alpn]: { admit(peer), closing, run({ conn, bi, value, rest, peer }), timed } }.
 * `refused(kind, ...why)` gets what a stranger can cause; it should be throttled. `log` gets a
 * trusted session's own errors, unthrottled.
 * Resolves when the connection is done with; never rejects.
 */
export async function acceptOne(incoming, { routes, cap, refused, log = refused, ms = HANDSHAKE_MS }) {
  const validated = await Promise.resolve().then(() => incoming.remoteAddrValidated()).catch(() => false)
  if (!validated) {
    try { await incoming.retry(); return } catch {} // only fails for one already validated: go on
  }
  const address = await Promise.resolve().then(() => incoming.remoteAddr()).then(addressOf, () => '?')
  const slot = cap.enter(address)
  if (!slot) {
    refused('refused', 'too many connections')
    await Promise.resolve().then(() => incoming.refuse()).catch(() => {})
    return
  }
  let conn = null, expired = false, timer
  const late = () => { if (expired) { if (conn) closeConn(conn, 'too slow'); throw new Error('too slow') } }
  const work = (async () => {
    const accepting = await incoming.accept(); late()
    const alpn = Buffer.from(await accepting.alpn()).toString(); late()
    conn = await accepting.connect(); late()
    const peer = conn.remoteId().toString()
    const route = routes[alpn]
    if (!route || !route.admit(peer)) { closeConn(conn, route?.closing ?? 'not paired'); return { refusedPeer: peer, why: route?.closing ?? 'not paired' } }
    const bi = await conn.acceptBi(); late()
    const { value, rest } = await readLine(bi.recv); late()
    const job = { conn, bi, value, rest, peer }
    if (!route.timed) return { route, job }
    await route.run(job); late()
    await conn.closed().catch(() => {})
    return {}
  })()
  let out
  try {
    out = await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new Error(`nothing within ${ms / 1000} s`)) }, ms)
    })])
  } catch (e) {
    // Whatever went wrong, the connection goes too: one left open would sit outside the cap.
    if (conn) closeConn(conn, expired ? 'too slow' : 'bad request')
    refused('connection', e.message)
    slot.done()
    return
  } finally {
    clearTimeout(timer)
    work.catch(() => {})
  }
  try {
    if (out.refusedPeer) { refused('refused', `${out.why}:`, out.refusedPeer.slice(0, 10)); return }
    if (!out.route) return
    slot.trusted()
    await out.route.run(out.job)
  } catch (e) {
    closeConn(out.job.conn, 'failed')
    log('session:', e.message)
  } finally {
    slot.done()
  }
}

/** The routes the bridge serves, by ALPN. */
export const ALPN = Object.freeze({ session: 'herdr-pocket/1', pair: 'herdr-pocket/pair/1', chat: 'herdr-pocket/chat/1' })

/**
 * The bridge's route table: pairing while a code is live (timed), and the terminal session and
 * the chat for paired keys only (untimed once the header is in). The chat is admitted by the very
 * same check as the session: a key not in devices.json is closed before anything is read.
 * @param {{ paired(id: string): boolean, codeLive(): boolean, pair: Function, session: Function, chat: Function }} r
 */
export function routesFor({ paired, codeLive, pair, session, chat }) {
  return {
    [ALPN.pair]: { admit: () => codeLive(), closing: 'No pairing code is live. Make a new one on the desktop.', run: pair, timed: true },
    [ALPN.session]: { admit: (id) => paired(id), closing: 'not paired', run: session, timed: false },
    [ALPN.chat]: { admit: (id) => paired(id), closing: 'not paired', run: chat, timed: false },
  }
}

/**
 * End what removed phones still have open: every entry of `live` ({ phone, end() }) whose phone
 * is not among `paired` ids. bridge.mjs runs it every second, for terminal sessions and chats alike.
 * @returns {number} how many were ended
 */
export function endRemoved(live, paired, log = () => {}) {
  let n = 0
  for (const s of [...live]) {
    if (paired.has(s.phone)) continue
    live.delete(s)
    log('session: ended for a removed phone', String(s.phone).slice(0, 10))
    try { s.end() } catch {}
    n += 1
  }
  return n
}

/**
 * The hc session a phone's header names, for the terminal session and the chat alike: letters,
 * digits, `_`, `.` and `-`, 1 to 64, but never only dots (`.` and `..` are no names). Else 'default'.
 */
export function sessionName(value) {
  const s = value?.session
  return typeof s === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(s) && !/^\.+$/.test(s) ? s : 'default'
}
