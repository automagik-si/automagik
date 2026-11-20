import { randomUUID } from 'node:crypto'
import { refusal } from './refusal.js'

const LEASE_MS = 30_000
const WAIT_MS = 20_000
const CALL_MS = 10_000
const outcomes = new Set(['spoken', 'closed', 'unavailable', 'cancelled'])
const paneKey = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{22,80}$/.test(value)
const noPane = 'Open voice chat with this Bot to hear it.'

// This channel runs on the authenticated owner POST route. A pane id is a
// per-mount secret, scoped to one exact Session for the lifetime of the lease.
export function createRoleVoice(rt) {
  const panes = new Map()
  const calls = new Map()
  const origins = new Map()
  const turns = new Map()
  let activity = 0
  let stopped = false
  const eligible = (sessionId) => {
    const botId = rt.chatOwners?.get(sessionId)
    if (botId === undefined || !rt.own?.(rt.state.bots, botId) || rt.roomOwners?.has(sessionId)
      || rt.taskOwners?.has(sessionId) || rt.groupOwners?.has(sessionId) || rt.pastOwners?.has(sessionId)) return undefined
    return botId
  }
  function close(pane, outcome = 'closed') {
    panes.delete(pane.id)
    pane.wake?.()
    for (const call of calls.values()) if (call.pane === pane) call.finish(outcome)
  }
  function sweep() {
    const now = Date.now()
    for (const pane of panes.values()) if (pane.expires <= now || eligible(pane.sessionId) !== pane.botId) close(pane)
    for (const [id, origin] of origins) if (origin.expires <= now) origins.delete(id)
    for (const [id] of turns) if (eligible(id) === undefined) turns.delete(id)
  }
  const timer = setInterval(sweep, 5_000)
  timer.unref()
  function getPane({ sessionId, paneId }) {
    sweep()
    const pane = panes.get(paneId)
    return pane?.sessionId === sessionId ? pane : undefined
  }
  function presence({ sessionId, paneId, open, active }) {
    if (stopped || !paneKey(paneId) || typeof sessionId !== 'string' || typeof open !== 'boolean') return false
    const present = getPane({ sessionId, paneId })
    if (!open) {
      if (present) close(present)
      return true
    }
    const botId = eligible(sessionId)
    if (botId === undefined || (!present && (panes.has(paneId) || panes.size >= 128))) return false
    const pane = present ?? { id: paneId, sessionId, botId, active: ++activity }
    if (active === true) pane.active = ++activity
    pane.expires = Date.now() + LEASE_MS
    panes.set(paneId, pane)
    return true
  }
  function originate(sessionId, paneId, requestId) {
    if (stopped) return
    const pane = getPane({ sessionId, paneId })
    if (pane && origins.size < 256) {
      pane.active = ++activity
      origins.set(requestId, { pane, expires: Date.now() + 30 * 60_000 })
    }
  }
  function event(sessionId, event) {
    if (stopped || sessionId === undefined) return
    if (event.type === 'turn/end' && turns.delete(sessionId)) cancelInvalid()
    if (eligible(sessionId) === undefined) return
    if (event.type === 'turn/start') {
      turns.set(sessionId, { turn: event.data.turn })
    }
    if (event.type !== 'user/message' || event.data?.source?.kind !== 'user') return
    const requestId = event.data.source.rpcId
    const origin = origins.get(requestId)
    origins.delete(requestId)
    const turn = turns.get(sessionId)
    if (turn?.user) return
    turns.set(sessionId, { ...turn, user: true, ...(origin?.pane.sessionId === sessionId ? { pane: origin.pane } : {}) })
  }
  function offer(pane) {
    for (const call of calls.values()) {
      if (call.pane !== pane || call.offered) continue
      if (!call.valid()) { call.finish('cancelled'); continue }
      call.offered = true
      return { callId: call.id, turn: call.turn, expires: call.expires }
    }
    return null
  }
  async function wait(body, signal) {
    if (signal?.aborted) return null
    const pane = getPane(body)
    if (!pane) return null
    if (body.callId !== undefined) {
      const call = calls.get(body.callId)
      if (call?.pane !== pane || !call.offered || call.claimed) return null
      if (!call.valid() || call.expires <= Date.now()) { call.finish('cancelled'); return null }
      call.claimed = true
      return { text: call.text, ...call.override, expires: call.expires }
    }
    const ready = offer(pane)
    if (ready || pane.wake) return ready
    await new Promise(resolve => {
      const wake = () => {
        clearTimeout(timeout)
        signal?.removeEventListener('abort', wake)
        delete pane.wake
        resolve()
      }
      const timeout = setTimeout(wake, WAIT_MS)
      pane.wake = wake
      signal?.addEventListener('abort', wake, { once: true })
    })
    return !signal?.aborted && getPane(body) === pane ? offer(pane) : null
  }
  function acknowledge(body) {
    const pane = getPane(body)
    const call = calls.get(body.callId)
    if (!pane || call?.pane !== pane || !call.offered || !outcomes.has(body.outcome)
      || (body.outcome === 'spoken' && !call.claimed)) return false
    call.finish(call.valid() ? body.outcome : 'cancelled')
    return true
  }

  async function speak(sessionId, botId, text, override, { signal, valid }) {
    if (eligible(sessionId) !== botId) throw refusal(noPane)
    sweep()
    const turn = turns.get(sessionId)
    // Closing the originating pane never redirects its words to another window.
    const pane = turn?.pane ?? [...panes.values()].filter(candidate => candidate.sessionId === sessionId)
      .sort((a, b) => b.active - a.active)[0]
    if (!pane || panes.get(pane.id) !== pane) throw refusal(noPane)
    if (signal?.aborted || !valid()) throw refusal('Voice / Mouth speech was cancelled.')
    const admitted = () => valid() && (turn?.turn === undefined || turns.get(sessionId)?.turn === turn.turn)
    const outcome = await new Promise(resolve => {
      const id = randomUUID()
      const abort = () => finish('cancelled')
      const finish = outcome => {
        if (!calls.delete(id)) return
        clearTimeout(timeout)
        signal?.removeEventListener('abort', abort)
        resolve(outcome)
      }
      const timeout = setTimeout(() => finish('timeout'), CALL_MS)
      calls.set(id, { id, pane, text, override, valid: admitted, turn: turn?.turn, expires: Date.now() + CALL_MS, finish })
      signal?.addEventListener('abort', abort, { once: true })
      pane.wake?.()
    })
    switch (outcome) {
      case 'spoken': return 'Spoken in voice chat.'
      case 'closed': throw refusal('The voice pane closed before speaking.')
      case 'unavailable': throw refusal('Speech synthesis is unavailable in the voice pane.')
      case 'timeout': throw refusal('The voice pane did not start speaking within 10 seconds.')
      default: throw refusal('Voice / Mouth speech was cancelled.')
    }
  }

  function cancelInvalid() {
    for (const call of calls.values()) if (!call.valid()) call.finish('cancelled')
    sweep()
  }
  return {
    presence, originate, event, wait, acknowledge, speak, cancelInvalid,
    turnOf: sessionId => turns.get(sessionId)?.turn,
    dispose() {
      stopped = true
      clearInterval(timer)
      for (const pane of panes.values()) close(pane, 'cancelled')
      origins.clear()
      turns.clear()
    },
  }
}
