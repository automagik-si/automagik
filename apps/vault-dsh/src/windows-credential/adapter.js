import { createLifecycle, untilAbort } from '../lifecycle.js'
import { connection, parseResponse, provider, validTarget } from './parse.js'
import { createRunner } from './run.js'

const fail = code => ({ ok: false, code })

export function createWindowsCredential({ idleLockMinutes = 5 } = {}, {
  timers = globalThis, timeouts = { probe: 30_000, meta: 15_000, read: 15_000 },
  runner = createRunner({ timers }), run = runner.run,
} = {}) {
  const state = createLifecycle({ idleLockMinutes, timers, timeouts, run: ([op, target], limits) => run(op, target, limits) })
  const validUnlock = options => (options.connection === undefined || options.connection === connection)
    && options.password === undefined && options.token === undefined
  let blocked = false
  let bindingSignal
  let binding
  let probe
  const availability = () => runner.availability() ?? (blocked ? 'blocked' : undefined)

  function status() {
    const code = availability()
    if (code !== undefined) throw Object.assign(new Error('Windows Credential Manager is unavailable.'), { code })
    return { state: state.credential === undefined ? 'locked' : 'unlocked' }
  }

  // The service starts preflight while the previous selection is still live.
  function preflight(options, current) {
    const excluded = runner.availability()
    if (excluded) return fail(excluded)
    if (!validUnlock(options)) return fail('refused')
    const gate = state.signal
    if (options.signal?.aborted || state.disposed) return fail('locked')
    probe?.abort()
    const attempt = new AbortController()
    probe = attempt
    const signal = AbortSignal.any([gate, attempt.signal, ...(options.signal ? [options.signal] : [])])
    return (async () => {
      let answer, timedOut
      try {
        const job = state.child(['probe', ''], 'probe', signal)
        const result = await untilAbort(job, signal, { failure: 'canceled' })
        timedOut = result.failure === 'timeout'
        answer = parseResponse('probe', result)
      } catch { answer = fail('blocked') }
      if (signal.aborted || !current() || probe !== attempt) return fail('locked')
      probe = undefined
      const code = runner.availability()
      if (code) return fail(code)
      blocked = answer.ok !== true
      if (timedOut) void state.invalidate()
      return blocked ? fail('blocked') : { ok: true }
    })()
  }

  function unlock() {
    const code = availability()
    if (code) return fail(code)
    if (state.disposed) return fail('locked')
    void state.invalidate()
    state.set(Symbol(), connection)
    return { ok: true }
  }

  function lookup(ref, op, caller) {
    const code = availability()
    if (code) return fail(code)
    if (state.credential === undefined) return fail('locked')
    if (ref.connection !== connection) return fail('refused')
    const target = op === 'read' ? ref.item : ref.target
    if (!validTarget(target) || (op === 'read' && ref.field !== 'password')) return fail('refused')
    const gate = state.signal
    const signal = caller ? AbortSignal.any([gate, caller]) : gate
    const invalidate = () => { if (!gate.aborted) void state.invalidate() }
    let blockedHere = false
    const job = state.reads(async () => {
      if (signal.aborted || availability()) return fail('refused')
      try {
        const result = await state.child([op, target], op, signal, { onTimeout: invalidate })
        if (result.failure === 'timeout') invalidate()
        if (signal.aborted || availability()) return fail('refused')
        const answer = parseResponse(op, result)
        if (!answer.ok) {
          if (answer.code === 'blocked') {
            blocked = blockedHere = true
            invalidate()
          }
          if (op === 'meta' && answer.code === 'revoked') return { ok: true, items: [] }
          return answer
        }
        if (op === 'meta') return { ok: true, items: [{ id: target, target, userName: answer.userName, fields: ['password'] }] }
        state.renewIdle()
        return answer
      } catch { return fail('refused') }
    })
    return untilAbort(job, signal, fail('refused')).then(answer => blockedHere ? fail('blocked') : answer)
  }

  return {
    availability, status, validUnlock, preflight, unlock,
    get connection() { return state.connection },
    // A closed gate has its own token to fence a pending probe.
    get binding() {
      if (bindingSignal !== state.signal) {
        bindingSignal = state.signal
        binding = Symbol()
      }
      return binding
    },
    read: (ref, options) => ref?.provider === provider
      ? lookup(ref, 'read', options?.signal ?? ref.signal) : fail('refused'),
    listItems: (ref = {}) => lookup(ref, 'meta', ref.signal),
    retire: state.lock,
    async prepareQuit() {
      const gate = await state.dispose()
      const cleanup = await runner.prepareQuit()
      return { ...cleanup, ok: gate.ok && cleanup.ok }
    },
  }
}
