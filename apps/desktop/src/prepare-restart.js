import { randomUUID } from 'node:crypto'

const pending = new WeakMap()
const reasons = new Set(['force', 'app-update', 'lane', 'restart', 'quit'])

/** Give the plugins a bounded chance to stop before the process is killed. */
export function prepareRestart(child, { reason = 'restart', timeoutMs = 6000, timers = globalThis } = {}) {
  if (!child) return Promise.resolve({ ok: false, why: 'no-child' })
  if (pending.has(child)) return pending.get(child)
  if (!child.connected || typeof child.send !== 'function') return Promise.resolve({ ok: false, why: 'no-ipc' })
  let finish
  const promise = new Promise(resolve => { finish = resolve })
  pending.set(child, promise)
  const id = randomUUID()
  let settled = false
  let timer
  const done = (answer) => {
    if (settled) return
    settled = true
    timers.clearTimeout(timer)
    child.removeListener('message', message)
    child.removeListener('exit', exit)
    child.removeListener('disconnect', disconnect)
    pending.delete(child)
    finish(answer)
  }
  const message = reply => {
    if (reply?.type === 'automagik:prepared-restart' && reply.id === id) done({ ok: true, result: reply.result })
  }
  const exit = () => done({ ok: false, why: 'exit' })
  const disconnect = () => done({ ok: false, why: 'no-ipc' })
  child.on('message', message)
  child.on('exit', exit)
  child.on('disconnect', disconnect)
  timer = timers.setTimeout(() => done({ ok: false, why: 'timeout' }), timeoutMs)
  try {
    child.send({ type: 'automagik:prepare-restart', id, protocol: 1, reason: reasons.has(reason) ? reason : 'restart' }, error => {
      if (error) disconnect()
    })
  } catch { disconnect() }
  return promise
}
