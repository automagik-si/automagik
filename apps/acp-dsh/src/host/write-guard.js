// The write-time guard (#958): no row DSH's Session reader refuses is stored for a Session a
// bridge serves. The reader (the v4 loader's lifecycle check) refuses a whole conversation for
// one bad step: a `step/end` or `turn/end` that leaves a tool call without its result, a result
// outside its call's step, a call with no advertisement, a replacement of a block that is no
// longer on the surface. The bridge writes its rows out of band, beside DSH's own loop, so any
// of those can happen when the two interleave (#842, #957).
//
// The guard stands in front of the Session's own `append` and keeps the same books the reader
// keeps, with DSH's own tracker (`ToolCallRecovery`, the one its crash recovery uses). A row
// that would break an invariant is repaired in place, never written as it is:
//
//   step/end, turn/end   every call still open gets its result first, in its own step: a
//                        started call is closed as superseded (cancelled at a turn's end), one
//                        that never started gets DSH's exact not-started repair; the marked
//                        advertisements still on the surface are hidden, one an earlier turn
//                        left (the app stopped in the middle of its call) included; a
//                        `turn/end` over an open step ends the step first
//   tool/result          one for a call that is not open, or stamped with another step than
//                        the open one, is not written; data that is not plain JSON becomes a
//                        minimal error row
//   tool/call            one with no advertisement, or already started, is refused (it throws:
//                        the bridge answers that call as not recorded)
//   assistant/message    one that advertises an id still open is refused the same way
//   developer/message    the bridge's hide of its advertisement: dropped when the block is
//                        already off the surface, restamped when its step has ended
//
// Every repair is reported: a log line and a `plugin:acp-dsh/write-guard` record (a plugin
// record is outside DSH's released schemas; a reader that does not know it skips it).
import { createDeveloperMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallRecovery, appendPluginRecord } from '@deepseek-ai/dsh-session'
import { SYNTHETIC_KIND } from './names.js'

/** The plugin record one repair leaves. */
export const GUARD_RECORD = 'plugin:acp-dsh/write-guard'
export const SUPERSEDED = Object.freeze({ name: 'BridgeCallSupersededError', code: 'BRIDGE_CALL_SUPERSEDED' })
export const CANCELLED = Object.freeze({ name: 'BridgeCallCancelledError', code: 'BRIDGE_CALL_CANCELLED' })
export const NOT_JSON = Object.freeze({ name: 'BridgeRecordError', code: 'BRIDGE_RESULT_NOT_JSON' })

// The guard a Session carries. It lives on the Session, never in this module: a plugin reload
// replaces the module while the Session lives on, and the next module must find the guard the
// previous one installed instead of stacking a second one.
const GUARD = Symbol.for('@automagik/acp-dsh/write-guard')
const BOUNDARIES = new Set(['step/end', 'turn/end'])

/** What the guard answers for a row it did not write: no seq, and the reason. */
const dropped = (type, reason) => Object.freeze({ type, dropped: true, reason, seq: undefined })

/** Whether a value is plain JSON all the way down: what a Session row may carry. */
export function isPlainJson(value, seen = new Set()) {
  if (value === null) return true
  const kind = typeof value
  if (kind === 'string' || kind === 'boolean') return true
  if (kind === 'number') return Number.isFinite(value)
  if (kind !== 'object' || seen.has(value)) return false
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.every(item => isPlainJson(item, seen))
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return false
    return Object.values(value).every(item => isPlainJson(item, seen))
  } finally {
    seen.delete(value)
  }
}

/** An error's row info as the reader accepts it: a string name, a string code when it has one. */
function plainInfo(info) {
  if (info === undefined || info === null || typeof info !== 'object') return undefined
  const plain = { name: typeof info.name === 'string' && info.name !== '' ? info.name : 'Error' }
  if (typeof info.code === 'string' && info.code !== '') plain.code = info.code
  return plain
}

const toolCallsOf = data => (Array.isArray(data?.message?.content) ? data.message.content : [])
  .filter(block => block?.type === 'tool-call' && typeof block.id === 'string')
const isSynthetic = data => data?.message?.source?.synthetic === SYNTHETIC_KIND
const isHide = (data, options) => data?.message?.source?.kind === SYNTHETIC_KIND && options?.surfaceOp?.op === 'replace'

class WriteGuard {
  constructor(session, original, own) {
    this.session = session
    this.original = original
    this.own = own
    this.holders = 0
    this.listeners = new Set()
    this.active = false
    this.log = () => {}
    this.append = (type, data, ...options) => Array.isArray(type) ? this.writeBatch(type) : this.write(type, data, options)
  }

  /** Read the Session's log as it stands: the open turn and step, the calls still open. */
  sync() {
    this.recovery = new ToolCallRecovery()
    this.turn = undefined
    this.step = undefined
    // callId -> name, for the report. seq -> { turn, open } for each marked advertisement on the
    // surface: its turn, and the ids of its calls that have no result yet.
    this.names = new Map()
    this.adverts = new Map()
    for (const event of this.session.snapshotEvents?.() ?? []) this.observe(event)
  }

  observe(event) {
    if (event === undefined || event === null || typeof event.type !== 'string' || event.dropped === true) return
    try {
      this.recovery.observe(event)
    } catch {
      // A row of a shape DSH's tracker does not read is not a tool row: nothing to keep of it.
    }
    const data = event.data
    switch (event.type) {
      case 'turn/start':
        this.turn = data?.turn
        this.step = undefined
        this.names.clear()
        break
      case 'turn/end':
        this.turn = undefined
        this.step = undefined
        break
      case 'step/start':
        this.step = data?.step
        break
      case 'step/end':
        this.step = undefined
        break
      case 'tool/call':
        if (typeof data?.callId === 'string') this.names.set(data.callId, data.name)
        break
      case 'tool/result':
        // The call of an advertisement has its result: nothing runs behind that block any more.
        for (const advert of this.adverts.values()) advert.open.delete(data?.message?.toolCallId)
        break
      case 'assistant/message':
        if (isSynthetic(data) && event.surfaceOp === 'append') this.adverts.set(event.seq, { turn: data.turn, open: new Set(toolCallsOf(data).map(block => block.id)) })
        break
      default:
        break
    }
    // Whatever replaces a span of the surface takes the advertisements in it off.
    const operation = event.surfaceOp
    if (operation !== null && typeof operation === 'object' && this.adverts.size > 0) {
      for (const seq of this.adverts.keys()) {
        if (seq >= operation.startSeq && seq <= operation.endSeq) this.adverts.delete(seq)
      }
    }
  }

  get open() {
    return this.turn !== undefined && this.step !== undefined ? { turn: this.turn, step: this.step } : undefined
  }

  /** Wake bridge calls only after the Session has committed its rows. */
  notify(events) {
    for (const listener of this.listeners) {
      try { listener(events) } catch {}
    }
  }

  /** Write through to the Session and keep the books. */
  commit(type, data, options = []) {
    const event = this.original.call(this.session, type, data, ...options)
    // A Session returns the committed event; anything else that stands in for one (a host that
    // answers only a seq) is read as the row that was asked for.
    const committed = typeof event?.type === 'string' ? event : { type, data, seq: event?.seq, ...options[0] }
    this.observe(committed)
    this.notify([committed])
    return event
  }

  report(kind, detail) {
    // A detail the row did not carry (a call with no name) is left out, not written as undefined.
    const data = Object.fromEntries(Object.entries({ kind, ...detail }).filter(([, value]) => value !== undefined))
    try {
      this.log(`write guard: ${kind} ${JSON.stringify(detail)}`)
    } catch {}
    try {
      appendPluginRecord(this.session, GUARD_RECORD, data)
    } catch (cause) {
      // The log line stands when the record cannot be written.
      try {
        this.log(`write guard: the record was not written: ${cause?.message ?? cause}`)
      } catch {}
    }
  }

  write(type, data, options) {
    if (!this.active) return this.original.call(this.session, type, data, ...options)
    if (BOUNDARIES.has(type)) this.closeBefore(type, data)
    else if (type === 'tool/result' && options[0]?.surfaceOp === 'append') {
      const answer = this.result(data, options)
      if (answer !== undefined) return answer
    } else if (type === 'tool/call') this.call(data)
    else if (type === 'assistant/message') this.advertise(data)
    else if (type === 'developer/message' && isHide(data, options[0])) return this.hide(data, options)
    return this.commit(type, data, options)
  }

  /** Plan guarded rows before the Session atomically validates and publishes the batch. */
  writeBatch(inputs) {
    if (!this.active) return this.original.call(this.session, inputs)
    const rows = []
    const reports = []
    const logs = []
    const start = this.session.seq
    const shadow = {
      get seq() { return start + rows.length },
      snapshotEvents: () => this.session.snapshotEvents(),
    }
    const plan = new WriteGuard(shadow, (type, data, ...options) => {
      const event = { type, data, ...options[0], seq: start + rows.length }
      rows.push([type, data, ...options])
      return event
    }, false)
    plan.sync()
    plan.active = true
    plan.report = (kind, detail) => reports.push([kind, detail])
    plan.log = message => logs.push(message)
    const selected = Array.from(inputs, input => {
      const [type, data, ...options] = input
      return plan.write(type, data, options)
    })
    // The real Session owns JSON/surface validation and atomic publication. A refusal leaves
    // both its log and this guard's books untouched; repair reports follow only a commit.
    const committed = this.original.call(this.session, rows)
    for (const event of committed) this.observe(event)
    this.notify(committed)
    for (const [kind, detail] of reports) this.report(kind, detail)
    for (const message of logs) { try { this.log(message) } catch {} }
    return selected.map(event => event?.dropped === true ? event : committed[event.seq - start])
  }

  /** A `tool/result` row: returns what stands for it when it is not written as it came. */
  result(data, options) {
    const callId = data?.message?.toolCallId
    const pending = this.recovery.pendingCalls.get(callId)
    const open = this.open
    const detail = { callId, name: this.names.get(callId), turn: data?.turn, step: data?.step }
    let reason
    if (pending === undefined) reason = 'its call is not open'
    else if (open === undefined) reason = 'no step is open'
    else if (data.turn !== open.turn || data.step !== open.step || pending.turn !== open.turn || pending.step !== open.step) reason = 'its step has ended'
    // A call that never started takes only DSH's own not-started repair, which the guard writes.
    else if (pending.callSeq === undefined && data?.error?.code !== 'TOOL_NOT_STARTED') reason = 'its call never started'
    if (reason !== undefined) {
      this.report('result-dropped', { ...detail, reason })
      return dropped('tool/result', reason)
    }
    const info = plainInfo(data.error)
    const plain = { ...data, ...(info === undefined ? {} : { error: info }) }
    if (info === undefined) delete plain.error
    if (isPlainJson(plain)) return this.commit('tool/result', plain, options)
    this.report('result-replaced', { ...detail, reason: 'its data was not plain JSON' })
    return this.commit('tool/result', {
      turn: open.turn,
      step: open.step,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: 'The result of this call could not be recorded: it was not plain JSON.' }],
        isError: true,
      }),
      error: { ...NOT_JSON },
    }, options)
  }

  /** A `tool/call` row the reader would refuse is refused here: the caller answers the call. */
  call(data) {
    const pending = this.recovery.pendingCalls.get(data?.callId)
    const open = this.open
    let reason
    if (open === undefined || data?.turn !== open.turn || data?.step !== open.step) reason = 'it is not in the open step'
    else if (pending === undefined) reason = 'it has no advertisement'
    else if (pending.callSeq !== undefined) reason = 'it already started'
    if (reason === undefined) return
    this.report('call-refused', { callId: data?.callId, name: data?.name, turn: data?.turn, step: data?.step, reason })
    throw Object.assign(new Error(`the tool/call row is not loadable: ${reason}`), { code: 'BRIDGE_WRITE_REFUSED' })
  }

  /** An `assistant/message` that advertises calls: its step is open and no id is still open. */
  advertise(data) {
    const calls = toolCallsOf(data)
    if (calls.length === 0) return
    const open = this.open
    let reason
    if (open === undefined || data.turn !== open.turn || data.step !== open.step) reason = 'it is not in the open step'
    else if (calls.some(block => this.recovery.pendingCalls.has(block.id))) reason = 'it repeats a call that is still open'
    if (reason === undefined) return
    this.report('advertisement-refused', { callId: calls[0].id, name: calls[0].name, turn: data.turn, step: data.step, reason })
    throw Object.assign(new Error(`the advertisement is not loadable: ${reason}`), { code: 'BRIDGE_WRITE_REFUSED' })
  }

  /** The bridge's hide of its advertisement: only while the block is on the surface, in the open step. */
  hide(data, options) {
    const seq = options[0].surfaceOp.startSeq
    if (!this.adverts.has(seq)) return dropped('developer/message', 'its advertisement is already off the surface')
    const open = this.open
    if (open === undefined) {
      this.report('hide-dropped', { seq, turn: data?.turn, step: data?.step, reason: 'no step is open' })
      return dropped('developer/message', 'no step is open')
    }
    return this.commit('developer/message', { ...data, turn: open.turn, step: open.step }, options)
  }

  /** Before a `step/end` or `turn/end`: close what is open, so the row that follows loads. */
  closeBefore(type, data) {
    const open = this.open
    if (open === undefined) return
    const info = type === 'turn/end' ? CANCELLED : SUPERSEDED
    // DSH's own closers, for the calls that never started: the reader takes only that exact row.
    const closers = new Map()
    try {
      for (const row of this.recovery.results()) closers.set(row.data.message.toolCallId, row)
    } catch {}
    for (const [callId, pending] of this.recovery.pendingCalls) {
      const name = this.names.get(callId)
      const started = pending.callSeq !== undefined
      try {
        if (started) {
          const how = type === 'turn/end' ? 'cancelled: its turn ended' : 'superseded: its step ended'
          this.commit('tool/result', {
            turn: pending.turn,
            step: pending.step,
            message: createToolResultMessage({
              callId,
              content: [{ type: 'text', text: `${name ?? 'The call'} was still running and is closed as ${how} before it answered. A result that comes later is not recorded.` }],
              isError: true,
            }),
            error: { ...info },
          }, [{ surfaceOp: 'append', sourceEventSeqs: [pending.callSeq] }])
        } else {
          const closer = closers.get(callId)
          if (closer === undefined) throw new Error('DSH offers no closer for it')
          // The id's number is the row's own seq, as DSH's recovery writes it.
          const message = { ...closer.data.message, id: `interrupted-tool-result-${callId}-${this.session.seq}` }
          this.commit('tool/result', { ...closer.data, message }, [{ surfaceOp: 'append' }])
        }
        this.report('call-closed', { callId, name, turn: pending.turn, step: pending.step, as: started ? info.code : 'TOOL_NOT_STARTED', before: type })
      } catch (cause) {
        try {
          this.log(`write guard: an open call was not closed before ${type}: ${cause?.message ?? cause}`)
        } catch {}
      }
    }
    // An advertisement must not outlive its step: the bridge hides it after its call's result,
    // and an await sits between the two, so the step can end first.
    // One of an earlier turn is hidden here too (#971). Its bridge call never got to hide it:
    // the app stopped in the middle of the call, and what closed that turn afterwards (DSH's own
    // closers at the next start) does not know the block. The hide carries the open step's
    // stamp, as every row written now must, and is reported, since it repairs what another run
    // left.
    for (const [seq, advert] of this.adverts) {
      const stale = advert.turn !== open.turn
      // Never one whose call has no result in the log: that call may still be running. (DSH's
      // tracker forgets a call at its turn's end, so the guard keeps this count itself.)
      if (stale && advert.open.size > 0) continue
      try {
        this.commit('developer/message', {
          turn: open.turn,
          step: open.step,
          message: createDeveloperMessage({ content: [], source: { kind: SYNTHETIC_KIND } }),
        }, [{ surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] }])
        if (stale) this.report('advertisement-hidden', { seq, from: advert.turn, turn: open.turn, step: open.step, before: type })
      } catch (cause) {
        this.adverts.delete(seq)
        try {
          this.log(`write guard: an advertisement was not hidden before ${type}: ${cause?.message ?? cause}`)
        } catch {}
      }
    }
    if (type === 'turn/end' && data?.turn === open.turn) {
      try {
        this.commit('step/end', { turn: open.turn, step: open.step })
        this.report('step-closed', { turn: open.turn, step: open.step, before: type })
      } catch (cause) {
        try {
          this.log(`write guard: the open step was not ended before ${type}: ${cause?.message ?? cause}`)
        } catch {}
      }
    }
  }

  hold(log) {
    if (typeof log === 'function') this.log = log
    this.holders += 1
    if (this.active) return
    this.sync()
    this.active = true
    if (this.session.append !== this.append) this.session.append = this.append
  }

  release() {
    this.holders = Math.max(0, this.holders - 1)
    if (this.holders > 0) return
    this.active = false
    // Another wrapper on top keeps calling through this one, which now only passes rows on.
    if (this.session.append !== this.append) return
    if (this.own) this.session.append = this.original
    else delete this.session.append
    delete this.session[GUARD]
  }
}

/**
 * Guard one Session's writes for as long as something holds it (one hold per live bridge).
 * @param {any} session the DSH Session a bridge writes on
 * @param {{ log?: (message: string) => void }} [options]
 * @returns {{ release(): void, subscribe(listener: Function): Function } | undefined} the hold; undefined when the Session cannot be guarded
 */
export function guardSession(session, { log } = {}) {
  if (session === undefined || session === null || typeof session.append !== 'function') return undefined
  try {
    let guard = session[GUARD]
    if (guard === undefined) {
      guard = new WriteGuard(session, session.append, Object.hasOwn(session, 'append'))
      Object.defineProperty(session, GUARD, { value: guard, configurable: true, writable: true })
    }
    guard.hold(log)
    let released = false
    return {
      // A guard an older copy of this module left on the Session (a plugin reload with a call
      // in flight) has no listeners: the caller then polls instead.
      subscribe(listener) {
        if (!(guard.listeners instanceof Set) || typeof guard.notify !== 'function') return undefined
        guard.listeners.add(listener)
        return () => guard.listeners.delete(listener)
      },
      release() {
        if (released) return
        released = true
        guard.release()
      },
    }
  } catch (cause) {
    try {
      log?.(`the bridge cannot guard this Session's writes: ${cause?.message ?? cause}`)
    } catch {}
    return undefined
  }
}
