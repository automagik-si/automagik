import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { cpSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SOURCE_KIND } from '../src/host/constants.js'
import { fakeContext } from './fake-ctx.js'

const empty = () => ({ events: [], inbox: { nextStep: [], nextTurn: [] } })
const missing = () => Object.assign(new Error('Session not found'), { code: 'session/not-found' })
const hung = () => new Promise(() => {})

export function durableDsh({ pageSize = 4, saved = new Map() } = {}) {
  const ctx = fakeContext()
  const live = new Map()
  const sends = []
  const resolutions = []
  let next = 0

  function add(id, stored = empty(), cwd = tmpdir()) {
    const { events, inbox } = structuredClone(stored)
    const s = { events, inbox, claimed: [], status: 'idle', durable: structuredClone(stored), flush: 'ok' }
    live.set(id, s)
    const session = {
      id, header: { cwd },
      get seq() { return events.length },
      eventAt: seq => events[seq],
      deriveMessages: () => events.filter(event => event.type === 'user/message').map(event => event.data),
      requestHeader: () => undefined,
    }
    const discard = message => ctx.emit('agent/inbox/discarded', { agent, message })
    const insert = message => ctx.emit('agent/inbox/inserted', { agent, message })
    const listOf = target => target === 'next-step' ? inbox.nextStep : inbox.nextTurn
    const agent = {
      id, session, inbox, get status() { return s.status },
      ctx: { tools: { register: () => () => {}, restrict: () => () => {} } },
      whenIdle: () => s.idle?.promise ?? Promise.resolve(),
      cancel() {},
      send(message, target, wake) {
        listOf(target).push(message)
        insert(message)
        sends.push({ sessionId: id, id: message.id, exchangeId: message.source?.exchangeId, target, wake, message })
      },
      followup(message) { agent.send(message, 'next-turn', true) },
      steer(message) { agent.send(message, 'next-step', true) },
      inject(message) { agent.send(message, 'next-step', false) },
    }
    s.agent = agent
    Object.assign(inbox, {
      prepend(target, message) { listOf(target).unshift(message); insert(message) },
      remove(messageId) {
        for (const list of [inbox.nextStep, inbox.nextTurn]) {
          const i = list.findIndex(message => message.id === messageId)
          if (i === -1) continue
          const [message] = list.splice(i, 1)
          discard(message)
          return true
        }
        return false
      },
      replace(messageId, replacement) {
        for (const list of [inbox.nextStep, inbox.nextTurn]) {
          const i = list.findIndex(message => message.id === messageId)
          if (i === -1) continue
          const [message] = list.splice(i, 1, replacement)
          discard(message)
          insert(replacement)
          return true
        }
        return false
      },
    })
    return s
  }
  for (const [id, stored] of saved) add(id, stored, stored.cwd)

  const state = id => live.get(id)
  const agentOf = id => state(id)?.agent
  const persist = (id) => {
    const { events, inbox, agent } = state(id)
    state(id).durable = structuredClone({
      events, inbox: { nextStep: inbox.nextStep, nextTurn: inbox.nextTurn }, cwd: agent.session.header.cwd,
    })
  }

  function emit(id, type, data) {
    const s = state(id)
    const event = { seq: s.events.length, type, time: Date.now(), data }
    s.events.push(event)
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener(s.agent.session, event)
    }
  }

  function claim(id) {
    const s = state(id)
    s.status = 'running'
    s.idle ??= Promise.withResolvers()
    s.turn = (s.turn ?? 0) + 1
    s.claimed = [...s.inbox.nextStep.splice(0), ...s.inbox.nextTurn.splice(0, 1)]
    for (const message of s.claimed) ctx.emit('agent/inbox/claimed', { agent: s.agent, message, turn: s.turn })
  }

  function release(id) {
    const s = state(id)
    s.claimed = []
    s.status = 'idle'
    s.idle?.resolve()
    s.idle = undefined
  }

  function receive(id) {
    const s = state(id)
    emit(id, 'turn/start', { turn: s.turn })
    for (const { id: messageId, content, source } of s.claimed) emit(id, 'user/message', { id: messageId, content, source, turn: s.turn })
    emit(id, 'turn/end', { turn: s.turn, reason: { kind: 'completed' } })
    release(id)
  }

  const take = (id) => { claim(id); receive(id) }
  const drain = () => {
    for (const [id, { inbox }] of live) {
      while (inbox.nextStep.length > 0 || inbox.nextTurn.length > 0) take(id)
      persist(id)
    }
  }

  const events = async ({ address: { sessionId }, throughSeq = Infinity, beforeSeq = Infinity, maxMessages }, signal) => {
    signal?.throwIfAborted()
    const s = state(sessionId)
    if (s === undefined || s.historyMissing) throw missing()
    if (s.historyError) throw s.historyError
    const first = s.firstRead
    s.firstRead = undefined
    first?.()
    const eligible = s.events.filter(event => event.seq <= throughSeq && event.seq < beforeSeq)
    const records = eligible.slice(-Math.min(pageSize, maxMessages)).map(event => ({ event }))
    return { records, hasMore: eligible.length > records.length, cursor: records[0]?.event.seq }
  }

  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      async resolveAgent(id) {
        resolutions.push(id)
        const s = state(id)
        if (s?.hanging) return await hung()
        if (s === undefined || s.resolveMissing) return { error: { code: missing().code, message: missing().message } }
        return { agent: s.agent }
      },
      async projections({ sessionId }, signal) {
        signal?.throwIfAborted()
        return live.has(sessionId) ? { kind: 'sequenced', values: {} } : null
      },
      events, page: events,
      async create() { const id = `new-${++next}`; add(id); return { sessionId: id } },
      async selectModel() {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: {
      get: id => agentOf(id)?.session,
      async flush({ id }) {
        const mode = state(id).flush
        if (mode === 'hang') return await hung()
        if (mode === 'false') return false
        if (mode === 'reject') throw new Error('flush rejected')
        persist(id)
        return true
      },
    },
  })

  const queue = (id, exchangeId, { target = 'next-turn', role = 'task-done', kind = SOURCE_KIND, text = exchangeId } = {}) => {
    const message = createUserMessage({ source: { kind, role, exchangeId }, content: [{ type: 'text', text }] })
    agentOf(id).inbox.prepend(target, message)
    return message
  }

  return { ctx, add, state, agentOf, sends, resolutions, persist, claim, receive, release, take, drain, emit, queue,
    flushMode: (id, mode) => { state(id).flush = mode },
    onFirstRead: (id, fn) => { state(id).firstRead = fn },
    hang: (id) => { state(id).hanging = true },
    crash: () => durableDsh({ pageSize, saved: new Map([...live].map(([id, s]) => [id, s.durable])) }),
    durableEvents: () => [...live.values()].flatMap(s => s.durable.events),
  }
}

export function crashCopy(home) {
  const copy = mkdtempSync(join(tmpdir(), 'wake-crash-'))
  cpSync(home, copy, { recursive: true, filter: source => !source.endsWith('state.lock') })
  return copy
}

export function userMessages(dsh, exchangeId) {
  return dsh.durableEvents().filter(event => event.type === 'user/message' && event.data?.source?.exchangeId === exchangeId).length
}
