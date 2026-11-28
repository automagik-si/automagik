import { setTimeout as delay } from 'node:timers/promises'
import { classify, DecisionProviderError } from './classify.js'

export function abortable(pending, signal, reason = () => signal.reason) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(reason())
    const finish = settle => value => {
      signal.removeEventListener('abort', abort)
      settle(value)
    }
    pending.then(finish(resolve), finish(reject))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

export async function retrying(reg, call, key, signal, deadlineAt, onAttempt = () => {}) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    if (Date.now() >= deadlineAt) throw new DecisionProviderError('timeout')
    try {
      onAttempt()
      const result = await reg.provider.evaluate(call, key, signal)
      signal.throwIfAborted()
      if (Date.now() >= deadlineAt) throw new DecisionProviderError('timeout')
      return result
    } catch (error) {
      signal.throwIfAborted()
      const { reason, httpStatus, retryAfterMs } = classify(error)
      const retry = (reason === 'rate-limited' && httpStatus === 429)
        || (reason === 'overloaded' && httpStatus === 529)
      if (!retry || attempt === 2) throw error
      const wait = retryAfterMs ?? Math.random() * 150 * 2 ** attempt
      if (deadlineAt - Date.now() < wait + 250) throw error
      if (wait > 0) await delay(wait, undefined, { signal })
    }
  }
}

export function gateOf(maxConcurrent) {
  let active = 0
  const queue = new Set()

  function release() {
    active--
    for (const next of queue) {
      if (next()) break
    }
  }

  return {
    run(deadlineAt, fn, signal, timeoutReason) {
      if (signal?.aborted) return Promise.reject(signal.reason)
      if (Date.now() >= deadlineAt) return Promise.reject(new DecisionProviderError('busy'))
      const run = () => {
        active++
        // A cancelled caller can leave while its attempt is unwinding. The slot
        // stays taken until the provider itself has settled.
        const pending = Promise.resolve().then(fn).finally(release)
        return signal ? abortable(pending, signal) : pending
      }
      if (active < maxConcurrent) return run()

      return new Promise((resolve, reject) => {
        const busy = () => new DecisionProviderError('busy')
        const remove = () => {
          queue.delete(start)
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
        }
        const abort = () => {
          remove()
          reject(signal.reason === timeoutReason ? busy() : signal.reason)
        }
        const start = () => {
          remove()
          if (Date.now() >= deadlineAt) {
            reject(busy())
            return false
          }
          resolve(run())
          return true
        }
        const timer = setTimeout(() => {
          remove()
          reject(busy())
        }, Math.max(0, deadlineAt - Date.now()))
        queue.add(start)
        signal?.addEventListener('abort', abort, { once: true })
      })
    },
  }
}

export class Breaker {
  #failures = 0
  #openUntil
  #probe = false
  #epoch = 0

  constructor({ failures = 5, cooldownMs = 30_000 } = {}) {
    this.limit = failures
    this.cooldownMs = cooldownMs
  }

  get epoch() { return this.#epoch }

  snapshot() {
    if (this.#openUntil === undefined) return { breaker: 'closed' }
    if (Date.now() < this.#openUntil) return { breaker: 'open', openUntil: this.#openUntil }
    return { breaker: 'half-open' }
  }

  allows() {
    if (this.#openUntil === undefined) return true
    if (this.#probe || Date.now() < this.#openUntil) return false
    this.#probe = true
    return true
  }

  success(epoch = this.#epoch) {
    if (epoch !== this.#epoch) return
    if (this.#probe) this.#epoch++
    this.#failures = 0
    this.#openUntil = undefined
    this.#probe = false
  }

  failure(retryAfterMs, epoch = this.#epoch) {
    if (epoch !== this.#epoch) return
    this.#failures++
    if (!this.#probe && this.#failures < this.limit) return
    this.#epoch++
    this.#probe = false
    this.#openUntil = Date.now() + Math.max(this.cooldownMs, retryAfterMs ?? 0)
  }

  neutral(epoch = this.#epoch) {
    if (epoch !== this.#epoch || !this.#probe) return
    this.#epoch++
    this.#probe = false
  }
}
