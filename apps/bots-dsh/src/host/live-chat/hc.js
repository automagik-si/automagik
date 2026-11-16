// How the chat engine talks to herdr-core (RFC 0015 delivery 3): the seam every other chat module
// uses, and its one real implementation, plain-mode JSON-RPC over `hc connect` (one message per
// line; `hello` with generation 1 and no framing). Tests pass a fake with the same two methods
// (fake-hc.mjs); nothing here is reached in a test except through a stand-in `hc` script.
//
//   call(method, params) -> Promise<result>     one request on a shared connection
//   subscribe(params, onMessage) -> { close }   events.subscribe on a connection of its own, since a
//                                               plain-mode subscription carries only notifications
//
// onMessage receives { type: 'snapshot', seq, terminals }, { type: 'event', terminal, seq, kind,
// data }, { type: 'heartbeat', seq }, { type: 'missed', seq, terminals } and, once,
// { type: 'closed', reason }.
import { spawn as nodeSpawn } from 'node:child_process'

/** A line from hc longer than this ends the connection (file.read stops at 8 MB of text). */
export const MAX_LINE = 64 * 1024 * 1024
/** A call with no answer by then is rejected. */
export const CALL_MS = 30_000

/**
 * @typedef {{ call(method: string, params?: object): Promise<any>,
 *   subscribe(params: object, onMessage: (m: any) => void): { close(): void },
 *   close(): void }} Hc
 */

/**
 * One `hc connect` child speaking JSON-RPC lines. `onLine` gets every parsed message; `onExit`
 * runs once. Writes before the child is up are queued by the pipe.
 */
function line({ hcPath, env, spawn, onLine, onExit, maxLine = MAX_LINE }) {
  const child = spawn(hcPath, ['connect'], { stdio: ['pipe', 'pipe', 'ignore'], env })
  let buffered = ''
  let ended = false
  const end = (reason) => {
    if (ended) return
    ended = true
    try { child.kill() } catch {}
    onExit(reason)
  }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffered += chunk
    if (buffered.length > maxLine) return end('line too long')
    let at
    while ((at = buffered.indexOf('\n')) !== -1) {
      const text = buffered.slice(0, at)
      buffered = buffered.slice(at + 1)
      if (!text.trim()) continue
      let message
      try { message = JSON.parse(text) } catch { return end('not JSON') }
      onLine(message)
    }
  })
  child.on('error', (e) => end(e.code === 'ENOENT' ? 'hc not found' : 'hc failed'))
  child.on('exit', () => end('hc exited'))
  child.stdin.on('error', () => end('hc closed'))
  const write = (message) => {
    if (ended) return false
    try { child.stdin.write(JSON.stringify(message) + '\n') } catch { end('hc closed'); return false }
    return true
  }
  write({ jsonrpc: '2.0', id: 0, method: 'hello', params: { generation: 1 } })
  return { write, close: () => end('closed') }
}

/**
 * The real seam: `hc connect` children. `env` is passed as is (the bridge picks HC_SESSION).
 * @param {{ hcPath?: string, env?: NodeJS.ProcessEnv, spawn?: typeof nodeSpawn, callMs?: number, maxLine?: number }} [options]
 * @returns {Hc}
 */
export function connectHc({ hcPath = 'hc', env = process.env, spawn = nodeSpawn, callMs = CALL_MS, maxLine = MAX_LINE } = {}) {
  /** @type {null | { write(m: object): boolean, close(): void }} */
  let calls = null
  let nextId = 1
  /** @type {Map<number, { resolve(v: any): void, reject(e: Error): void, timer: any }>} */
  const pending = new Map()
  const subscriptions = new Set()

  const failAll = (reason) => {
    for (const [id, p] of pending) { clearTimeout(p.timer); pending.delete(id); p.reject(new Error(reason)) }
  }
  const callLine = () => calls ??= line({
    hcPath, env, spawn, maxLine,
    onLine: (m) => {
      if (typeof m?.id !== 'number' || m.id === 0) return
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      clearTimeout(p.timer)
      if (m.error) {
        const e = new Error(String(m.error.message ?? 'hc error'))
        e.kind = m.error.data?.kind
        p.reject(e)
      } else p.resolve(m.result)
    },
    // The next call starts a fresh child.
    onExit: (reason) => { calls = null; failAll(reason) }
  })

  return {
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = nextId++
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('hc timed out')) }, callMs)
        timer.unref?.()
        pending.set(id, { resolve, reject, timer })
        if (!callLine().write({ jsonrpc: '2.0', id, method, params })) {
          clearTimeout(timer); pending.delete(id); reject(new Error('hc closed'))
        }
      })
    },
    subscribe(params, onMessage) {
      let closed = false
      const conn = line({
        hcPath, env, spawn, maxLine,
        onLine: (m) => {
          if (closed) return
          if (m.id === 1) {
            if (m.error) { conn.close(); return }
            onMessage({ type: 'snapshot', seq: m.result?.seq ?? 0, terminals: m.result?.terminals ?? [] })
            return
          }
          const p = m.params ?? {}
          if (m.method === 'event') onMessage({ type: 'event', terminal: p.terminal, seq: p.seq, kind: p.type, data: p.data ?? {} })
          else if (m.method === 'heartbeat') onMessage({ type: 'heartbeat', seq: p.seq })
          else if (m.method === 'missed') onMessage({ type: 'missed', seq: p.seq ?? 0, terminals: p.terminals ?? [] })
        },
        onExit: (reason) => {
          subscriptions.delete(handle)
          if (!closed) { closed = true; onMessage({ type: 'closed', reason }) }
        }
      })
      conn.write({ jsonrpc: '2.0', id: 1, method: 'events.subscribe', params })
      const handle = { close: () => { closed = true; conn.close() } }
      subscriptions.add(handle)
      return handle
    },
    close() {
      for (const s of subscriptions) s.close()
      calls?.close()
      calls = null
      failAll('closed')
    }
  }
}

/** `t7` -> { machine: null, id: 't7' }; `box/t7` -> { machine: 'box', id: 't7' }. */
export function addressParts(address) {
  const at = typeof address === 'string' ? address.indexOf('/') : -1
  return at === -1 ? { machine: null, id: address } : { machine: address.slice(0, at), id: address.slice(at + 1) }
}
