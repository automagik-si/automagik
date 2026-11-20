// The running bridge owns devices.json. The dialog's `forget` and `reset` commands ask it over
// bridge.sock. When they write the file themselves, devices.lock serializes those changes.
//
//   bridge.sock   one JSON line in, {"forget": "<id>"}; one line out, {"ok", "removed"} or {"ok": false, "error"}
//                 or {"reset": true} / {"adopt": true}; one line out, {"ok", "unpaired", "id"} or {"ok": false, "error"}
//                 or {"ping": true}; one line out, {"ok": true, "pid"}: bridgeState() below
//
// status.json's pid alone does not say a bridge runs: after a crash the pid can belong to another
// process. bridgeState() asks the socket, then checks the pid's start time against the one the
// bridge recorded, and serve, start, stop, status, pair, forget and reset all go by it (issue #301).
//
// No dependencies, so node --test runs it without the bridge's packages.
import { execFileSync } from 'node:child_process'
import { createConnection, createServer } from 'node:net'
import { chmodSync, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export const SOCKET = 'bridge.sock'
export const FILE = 'devices.json'
export const STATUS = 'status.json'
// How long `forget` and `reset` wait for the bridge (its loop can be busy), and the
// bridge for a request line. Under the dialog's 30s exec limit.
export const TIMEOUT = 10_000
const MAX_REQUEST = 4096
// A running bridge whose socket refuses (its backlog full): try again for this long, then fail.
export const BUSY_RETRIES = 10
export const BUSY_WAIT = 200
// How long bridgeState() waits for a ping's answer. A bridge whose loop is busy past this still
// counts as running: its socket took the connection.
export const PING_TIMEOUT = 2_000
// What Remove's error tells the person to do when a running bridge did not take the removal.
const STILL_PAIRED = 'The phone is still paired: Remove it again, or Turn off Pocket Link, Remove it, then Turn on.'
// The longest Unix socket path, in bytes, that binds where it was asked. macOS, measured on Node 22
// and 24: 104 binds; 105 fails with EINVAL on Node 24, and on Node 22 listen() reports success but
// binds the path cut short, outside the state folder. Linux: not measured here; 107, from the classic
// 108-byte sun_path less its NUL, kept on the safe side. Neither end uses a path that does not fit.
export const SOCKET_MAX = process.platform === 'darwin' ? 104 : 107
export const fits = (path) => Buffer.byteLength(path) <= SOCKET_MAX

const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback } }

/**
 * Which file is at `path` (not followed), or null when none is: its device, inode, change and birth
 * times to the nanosecond. The inode alone is not enough: Linux gives a freed inode number to the
 * next file made, so a socket bound in place of a removed one can have the removed one's inode.
 * `stat` is lstatSync; tests give another to make that reuse happen.
 */
export function fileId(path, stat = lstatSync) {
  try { const s = stat(path, { bigint: true }); return `${s.dev}:${s.ino}:${s.ctimeNs}:${s.birthtimeNs}` } catch { return null }
}

/**
 * The phones in devices.json. Every change reads the file again and writes it whole, synchronously,
 * so changes within one process never interleave. Atomic and durable: the temp file is flushed to
 * disk before the rename, and the folder after it, so a crash leaves the old list or the new one. `held` runs between a change's
 * read and its write: the moment another process's write would be lost (devices.test.mjs).
 */
export function store(path, { held = () => {} } = {}) {
  const list = () => { const v = readJson(path, []); return Array.isArray(v) ? v : [] }
  const read = () => { const all = list(); held(); return all }
  const write = (value) => {
    const tmp = `${path}.${process.pid}.tmp`
    const fd = openSync(tmp, 'w', 0o600)
    try { writeSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(tmp, path)
    // The rename itself; a filesystem that can't fsync a folder still has the flushed file.
    let dirFd = null
    try { dirFd = openSync(dirname(path), 'r'); fsyncSync(dirFd) } catch {} finally { if (dirFd !== null) closeSync(dirFd) }
  }
  return {
    list,
    /** Adds the phone, replacing one with the same id. */
    add: (device) => write([...read().filter((d) => d.id !== device.id), device]),
    /** A phone's last-seen time; a phone that is no longer listed stays removed. */
    touch: (id, now = Date.now()) => { const all = read(); if (all.some((d) => d.id === id)) write(all.map((d) => (d.id === id ? { ...d, seen: now } : d))) },
    /** True when the phone was listed. */
    remove: (id) => { const all = read(); const kept = all.filter((d) => d.id !== id); if (kept.length !== all.length) write(kept); return kept.length !== all.length },
    clear: () => { const count = read().length; write([]); return count },
  }
}

/** Serializes file changes by commands that cannot leave the write to a running bridge. */
export async function withLock(dir, fn) {
  const path = join(dir, 'devices.lock')
  const deadline = Date.now() + 3000
  let fd
  for (;;) {
    try { fd = openSync(path, 'wx', 0o600); break } catch (e) { if (e.code !== 'EEXIST') throw e }
    if (Date.now() >= deadline) throw new Error('Another change to the paired phones is running. Try again.')
    const own = fileId(path)
    if (!own) continue
    const { pid } = readJson(path, {}) ?? {}
    let age
    try { age = Date.now() - statSync(path).mtimeMs } catch (e) { if (e.code === 'ENOENT') continue; throw e }
    // A new owner may still be writing its pid.
    if (age > 30_000 || (Number.isInteger(pid) && pid > 0 && !defaultAlive(pid))) {
      if (fileId(path) === own) try { unlinkSync(path) } catch (e) { if (e.code !== 'ENOENT') throw e }
      continue
    }
    await delay(50)
  }
  try {
    // Record ownership before doing any work that another command might have to wait for.
    writeSync(fd, JSON.stringify({ pid: process.pid }))
    return await fn()
  } finally {
    const own = fileId(path, (_, options) => fstatSync(fd, options))
    closeSync(fd)
    if (own && fileId(path) === own) try { unlinkSync(path) } catch (e) { if (e.code !== 'ENOENT') throw e }
  }
}

/**
 * The bridge's end of bridge.sock: `forget(id)` removes the phone (and ends its sessions) and
 * returns whether it was listed. A stale socket from a bridge that died is replaced. Resolves to
 * the server once it listens; the socket is the owner's only (and the state folder is 0700).
 */
export function listen(path, { forget, reset, adopt, log = () => {}, pid = process.pid }) {
  if (!fits(path)) return Promise.reject(new Error(`${path} is ${Buffer.byteLength(path)} bytes, too long for a socket (at most ${SOCKET_MAX})`))
  try { unlinkSync(path) } catch {}
  const server = createServer((sock) => {
    sock.setEncoding('utf8')
    sock.setTimeout(TIMEOUT, () => sock.destroy())
    sock.on('error', () => {})
    let buf = ''
    const onData = async (chunk) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl < 0) { if (buf.length > MAX_REQUEST) sock.destroy(); return }
      sock.off('data', onData)
      let answer
      try {
        const request = JSON.parse(buf.slice(0, nl))
        if (request?.ping === true) answer = { ok: true, pid }
        else if (request?.reset === true && reset) answer = { ok: true, ...(await reset()) }
        else if (request?.adopt === true && adopt) answer = { ok: true, ...(await adopt()) }
        else if (typeof request?.forget !== 'string' || request.forget === '') throw new Error('unknown request')
        else answer = { ok: true, removed: Boolean(forget(request.forget)) }
      } catch (e) { answer = { ok: false, error: e.message } }
      sock.end(JSON.stringify(answer) + '\n')
    }
    sock.on('data', onData)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.off('error', reject)
      server.on('error', (e) => log('control:', e.message))
      try { chmodSync(path, 0o600) } catch {}
      server.socketId = fileId(path)
      resolve(server)
    })
  })
}

/**
 * For the bridge's exit: removes bridge.sock only while it is still this server's (fileId), never
 * one a later bridge has put in its place.
 */
export function unlinkOwn(server, path, { stat = lstatSync } = {}) {
  try { if (server?.socketId && fileId(path, stat) === server.socketId) unlinkSync(path) } catch {}
}

/**
 * Sends one request to the bridge and resolves to its answer, or to null when nothing took it:
 * no socket, a path too long for one (no bridge can listen there), or one that refuses (a bridge
 * that died, or one too busy to accept: `forget` tells these apart). Rejects when a bridge took the request but gives no answer within `timeout`.
 */
export function ask(path, request, { timeout = TIMEOUT } = {}) {
  if (!fits(path)) return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const sock = createConnection(path)
    let buf = '', connected = false, done = false
    const finish = (fn, value) => { if (done) return; done = true; clearTimeout(timer); sock.destroy(); fn(value) }
    const timer = setTimeout(() => finish(reject, new Error('The bridge did not answer.')), timeout)
    sock.setEncoding('utf8')
    sock.on('connect', () => { connected = true; sock.write(JSON.stringify(request) + '\n') })
    sock.on('data', (chunk) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      try { finish(resolve, JSON.parse(buf.slice(0, nl))) } catch { finish(reject, new Error('The bridge gave an answer it could not read.')) }
    })
    sock.on('error', (e) => {
      if (!connected && ['ENOENT', 'ECONNREFUSED', 'ENOTSOCK', 'EAGAIN', 'EINVAL', 'ENAMETOOLONG'].includes(e.code)) finish(resolve, null)
      else finish(reject, new Error(`The bridge did not answer: ${e.message}`))
    })
    sock.on('close', () => finish(reject, new Error('The bridge hung up without an answer.')))
  })
}

const defaultAlive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

// ps in UTC and the C locale: the bridge (a login service) and the dialog's commands may run with
// another TZ or LANG, and lstart is printed in local time.
const ps = (pid, field) => {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', `${field}=`], {
      encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH || '/usr/bin:/bin', TZ: 'UTC', LC_ALL: 'C' },
    }).trim()
    return out === '' ? null : out
  } catch { return null }
}

/** When process `pid` started, as ps prints it (to the second, UTC); null when ps can't say. */
export const startedAt = (pid) => ps(pid, 'lstart')

/** Process `pid`'s command line; null when it can't be read. */
export function commandOf(pid) {
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim() || null } catch {}
  return ps(pid, 'command')
}

/** A command line that runs the bridge: `<node> …/bridge.mjs serve`. */
export const servesBridge = (command) => /(^|[\s/])bridge\.mjs\s+serve(\s|$)/.test(command)

/**
 * Whether a bridge runs for the state folder `dir`. status.json names the bridge's pid; that pid
 * still alive is not enough, since after a crash it can be another process's. So:
 * - No status.json, or no pid in it: none runs.
 * - bridge.sock answers a ping, or takes the connection without answering in time (a busy loop):
 *   a bridge runs. A bridge from before the ping answers {ok: false} and runs too.
 * - Nothing takes it (no socket, a path too long for one, or one that refuses: a bridge that died,
 *   or one too busy to accept), so the pid decides. Gone, or `self` (a serve given the pid an
 *   earlier bridge had): none runs. Alive: its start time must be the one the bridge recorded in
 *   status.json (`pidStart`); a status.json from before that field goes by the command line.
 *   Either one unreadable still counts as running, as before this check (never a second bridge),
 *   but that pid is not given to be signalled. Otherwise it is not the bridge.
 * Resolves to {running, pid, stale}: `pid` is the one that may be signalled, only one the ping
 * gave or the start time or command line verified, else null; `stale` when status.json names a
 * pid that is not a running bridge.
 */
export async function bridgeState({ dir, self = null, alive = defaultAlive, started = startedAt, command = commandOf, timeout = PING_TIMEOUT }) {
  const status = readJson(join(dir, STATUS), {})
  const named = Number.isInteger(status?.pid) && status.pid > 0 ? status.pid : null
  if (named === null) return { running: false, pid: null, stale: false }
  const live = named !== self && alive(named)
  const ours = () => {
    if (!live) return false
    if (typeof status.pidStart === 'string' && status.pidStart !== '') {
      const now = started(named)
      return now === null ? null : now === status.pidStart
    }
    const line = command(named)
    return line === null ? null : servesBridge(line)
  }
  // Only a pid verified as the bridge's may be signalled; an unreadable check (null) is not.
  const verified = () => (ours() === true ? named : null)
  const sock = join(dir, SOCKET)
  const socketId = fileId(sock)
  let answer
  try { answer = await ask(sock, { ping: true }, { timeout }) } catch {
    // Something listens on the bridge's socket but did not answer in time: a busy bridge.
    return { running: true, pid: verified(), stale: false }
  }
  if (answer) return { running: true, pid: Number.isInteger(answer.pid) && answer.pid > 0 ? answer.pid : verified(), stale: false }
  const own = ours()
  // Nothing took the ping and the pid is not the bridge: bridge.sock, if any, is a dead bridge's.
  if (own === false) return { running: false, pid: null, stale: true, stalePid: named, socketId }
  return { running: true, pid: own === true ? named : null, stale: false }
}

/**
 * Removes what a stale bridgeState() found: bridge.sock while it is still the file that refused
 * the ping (fileId; a bridge starting now binds a new one), and status.json while it still names
 * the stale pid. `stat` as in fileId.
 */
export function clearStale(dir, state, { stat = lstatSync } = {}) {
  if (!state?.stale) return
  const sock = join(dir, SOCKET), status = join(dir, STATUS)
  if (state.socketId) try { if (fileId(sock, stat) === state.socketId) unlinkSync(sock) } catch {}
  try { if (readJson(status, {}).pid === state.stalePid) unlinkSync(status) } catch {}
}

/**
 * For `serve` and `start`: whether a bridge already runs. When none does, what a stale one left
 * is cleared first, so a new bridge binds a fresh socket and status.json.
 */
export async function claim(options) {
  const state = await bridgeState(options)
  if (!state.running) clearStale(options.dir, state)
  return state
}

/**
 * `bridge.mjs stop`: signals the bridge, only a pid bridgeState() verified, never one a crash left
 * to another process; then that process's stale socket and status.json are cleared instead.
 * Resolves to {stopped: pid or null, running}.
 */
export async function stopBridge({ kill = (pid) => process.kill(pid, 'SIGTERM'), ...options }) {
  const state = await bridgeState(options)
  if (!state.running) { clearStale(options.dir, state); return { stopped: null, running: false } }
  if (state.pid === null) return { stopped: null, running: true }
  try { kill(state.pid) } catch {}
  return { stopped: state.pid, running: true }
}

/**
 * `bridge.mjs forget <id>`: removes a paired phone from the state folder `dir`.
 * - A bridge runs (bridgeState()): it removes the phone and ends its sessions; this
 *   waits for its answer and never writes the file itself. A socket that is there but refuses (a
 *   busy bridge) is tried again for BUSY_RETRIES x BUSY_WAIT ms, then this fails.
 * - None answers on bridge.sock (none runs, an older one without the socket that a mod update left
 *   running, or a state folder whose bridge.sock path does not `fit`), or status.json's pid is
 *   another process's now (bridgeState()): this writes the file, then tells a bridge that started
 *   meanwhile too.
 * Resolves to {ok: true, removed, via: 'bridge' | 'file'}; rejects when the bridge refuses or
 * gives no answer, and then nothing was written.
 */
export async function forget({ dir, id, alive = defaultAlive, started = startedAt, command = commandOf, timeout = TIMEOUT, retries = BUSY_RETRIES, wait = BUSY_WAIT }) {
  if (typeof id !== 'string' || id === '') throw new Error('forget needs the id of a paired phone')
  const sock = join(dir, SOCKET)
  const state = await bridgeState({ dir, alive, started, command, timeout: Math.min(timeout, PING_TIMEOUT) })
  if (state.running) {
    const who = state.pid ? ` (pid ${state.pid})` : ''
    for (let i = 0; ; i++) {
      let answer
      try { answer = await ask(sock, { forget: id }, { timeout }) } catch (e) { throw new Error(`${e.message.replace(/^The bridge/, `The bridge${who}`)} ${STILL_PAIRED}`) }
      if (answer) {
        if (!answer.ok) throw new Error(`The bridge${who} refused the removal: ${answer.error || 'no reason given'}. ${STILL_PAIRED}`)
        return { ok: true, removed: Boolean(answer.removed), via: 'bridge' }
      }
      // No socket at all (an older bridge without one, or a path too long for one): the file, below.
      if (!fits(sock) || !existsSync(sock)) break
      if (i >= retries) throw new Error(`The bridge${who} is busy and did not take the removal. ${STILL_PAIRED}`)
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
  const removed = await withLock(dir, () => store(join(dir, FILE)).remove(id))
  // A bridge that bound the socket after the check above may have read the list before this write.
  const late = await ask(sock, { forget: id }, { timeout }).catch(() => null)
  return { ok: true, removed: removed || Boolean(late?.removed), via: 'file' }
}
