function serial() {
  let tail = Promise.resolve()
  const enqueue = work => {
    const job = tail.then(work)
    tail = job.then(() => {}, () => {})
    return job
  }
  enqueue.settled = () => tail
  return enqueue
}

// The queue retains the work until its child closes, even when its caller stops waiting.
export async function untilAbort(job, signal, fallback) {
  if (signal.aborted) return fallback
  let abort
  try {
    return await Promise.race([job, new Promise(resolve => {
      abort = () => resolve(fallback)
      signal.addEventListener('abort', abort, { once: true })
    })])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

export function createLifecycle({ idleLockMinutes = 5, timers = globalThis, run, timeouts, cleanup, onIdle }) {
  const idleMs = (Number.isFinite(idleLockMinutes) ? Math.min(480, Math.max(1, idleLockMinutes)) : 5) * 60000
  const lifecycle = serial()
  const children = new Set()
  let generation = new AbortController()
  let credential
  let connection
  let idle
  let disposed = false

  function invalidate() {
    const previous = generation
    generation = new AbortController()
    credential = undefined
    connection = undefined
    timers.clearTimeout(idle)
    idle = undefined
    const closing = [...children]
    previous.abort()
    return Promise.allSettled(closing)
  }

  function child(args, kind, signal, options = {}) {
    const job = run(args, { ...options, timeout: timeouts[kind], signal })
    children.add(job)
    const forget = () => children.delete(job)
    void job.then(forget, forget)
    return job
  }

  async function finish(closing) {
    await closing
    return cleanup === undefined ? true : cleanup()
  }

  function lock() {
    const closing = invalidate()
    return lifecycle(() => finish(closing))
  }

  function renewIdle(maxMs = idleMs) {
    timers.clearTimeout(idle)
    idle = timers.setTimeout(() => { void (onIdle ?? lock)() }, Math.min(idleMs, maxMs))
    idle.unref?.()
  }

  return {
    get signal() { return generation.signal },
    get credential() { return credential },
    get connection() { return connection },
    get disposed() { return disposed },
    set(value, label, maxIdleMs) {
      credential = value
      connection = label
      renewIdle(maxIdleMs)
    },
    invalidate, child, finish, lock, renewIdle, lifecycle, reads: serial(),
    async dispose() {
      disposed = true
      return { ok: await lock() }
    },
  }
}
