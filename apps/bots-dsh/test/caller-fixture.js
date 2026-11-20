import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { roleOf, visibleBotIds } from '../../multiuser-dsh/src/access.js'
import { createSeen } from '../../multiuser-dsh/src/seen.js'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { until } from './until.js'

export const identity = { issuer: 'https://issuer.invalid', subject: 'pat' }
export const member = { kind: 'automagik', instance: 'fixture', person: { ...identity, roles: ['member'] } }
export const guest = { ...member, person: { ...identity, roles: ['guest'] } }
export const stranger = { ...guest, person: { ...guest.person, subject: 'stranger' } }
export const owners = { mode: 'owners', allow: [] }
export const workspace = { mode: 'workspace', allow: [] }
export const allowlist = { mode: 'allowlist', allow: [{ ...identity, role: 'member' }] }
export const code = expected => ({ code: 'bot/' + expected })

export function serviceStub({ multiuser = true, onProvide } = {}) {
  let provider
  const seen = createSeen()
  seen.record(member.person)
  return {
    version: 2, multiuser, current: () => undefined, roleOf, seen: seen.list,
    visibleBotIds: principal => visibleBotIds(principal, provider),
    hasProvider: () => provider !== undefined,
    provide(next) {
      if (provider !== undefined) throw new Error('already registered')
      onProvide?.()
      provider = next
      return () => { if (provider === next) provider = undefined }
    },
    invalidate() {},
  }
}

export function fixture(t, { service = serviceStub(), seed, beforeLoad } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'caller-bots-'))
  const statePath = join(home, 'state.json')
  const saved = () => JSON.parse(readFileSync(statePath, 'utf8'))
  const bot = (id, name, createdAt) => ({ id, name, role: 'Helper', model: 'deepseek/v4', sessionId: id, createdAt, color: 'blue', capabilities: [] })
  const team = {
    version: 2, revision: 1, autoStamp: 1, whaleStored: true, workspaceId: 'w1', mainBotIds: ['a'],
    bots: { a: bot('a', 'Chief', 1), b: bot('b', 'Writer', 2) },
    rooms: {}, capabilities: { items: {} }, providersSeen: ['deepseek'], exchanges: [], exchangeTurns: {}, questions: {}, views: {}, prefs: {},
  }
  seed?.(team)
  writeFileSync(statePath, JSON.stringify(team))
  const logs = new Map()
  const agents = new Map()
  const warnings = []
  const archived = []
  const created = []
  const reads = []
  const routes = new Map()
  const goals = new Map()
  const services = { automagikCaller: service, goals }
  const ctx = fakeContext({ services })
  ctx.logger.warn = (...args) => warnings.push(args.join(' '))
  ctx.connection.fetch.register = route => { routes.set(route.path, route); return () => routes.delete(route.path) }
  function event(id, type, data, { notify = true } = {}) {
    const list = logs.get(id) ?? []
    const value = { type, data, seq: (list.at(-1)?.seq ?? 0) + 1, time: list.length + 1 }
    list.push(value)
    logs.set(id, list)
    if (notify) for (const listener of ctx.listeners.get('session/event') ?? []) listener({ id }, value)
    return value
  }
  const events = async ({ address, beforeSeq, maxMessages }) => {
    reads.push(address.sessionId)
    const items = (logs.get(address.sessionId) ?? []).filter(item => beforeSeq === undefined || item.seq < beforeSeq)
    return { records: items.slice(-maxMessages).map(event => ({ event })), hasMore: items.length > maxMessages }
  }
  function agentOf(id) {
    if (!agents.has(id)) {
      const nextStep = []
      const nextTurn = []
      const enqueue = message => event(id, 'user/message', message)
      agents.set(id, {
        id, session: { id, header: { cwd: home }, requestHeader() {}, deriveMessages: () => [] },
        status: 'idle', ctx: { tools: { register: () => () => {} } },
        followup: enqueue, inject: enqueue, steer: enqueue, cancel() {},
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: {
          nextStep, nextTurn,
          remove(id) {
            for (const messages of [nextStep, nextTurn]) {
              const index = messages.findIndex(message => message.id === id)
              if (index >= 0) { messages.splice(index, 1); return true }
            }
            return false
          },
        },
      })
    }
    return agents.get(id)
  }
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v4' }],
      resolveModelInfo: async () => ({}),
    },
    workspaceRegistry: {
      get: id => id === 'w1' ? { id, path: home } : undefined,
      list: () => [{ id: 'w1', path: home }], resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }), archiveSession: async id => { archived.push(id) },
      unarchiveSession: async () => {},
    },
    agents: { resume: async id => agentOf(id) },
    sessionController: {
      create: async () => {
        const sessionId = 'fresh-' + (created.length + 1)
        created.push(sessionId)
        return { sessionId }
      },
      resolveAgent: async id => ({ agent: agentOf(id) }),
      selectModel: async () => {},
      events, page: events,
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home, github: false, updateCheck: false })
  beforeLoad?.(rt)
  t.after(async () => {
    rt.dispose()
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const call = async (endpoint, payload) => {
    const route = routes.get('/api/omni-ui')
    const request = new Request('http://localhost/api/omni-ui', { method: 'POST', body: JSON.stringify({ endpoint, payload }) })
    return (await route.fetch(request)).json()
  }
  const emitService = async next => {
    services.automagikCaller = next
    ctx.emit('internal/service', 'automagikCaller')
    await rt.peopleQueue(() => {})
  }
  const start = async () => { await rt.load(); await rt.peopleQueue(() => {}) }
  const finishSwitch = async () => {
    await until(() => [...rt.switchJobs()].length === 0, { label: 'switch to settle' })
    await rt.peopleQueue(() => {})
    await rt.save()
  }
  const open = async (id = 'b', people = workspace) => {
    await rt.setPeople(id, people)
    await finishSwitch()
    return rt.chatOf(id)
  }
  const readable = id => rt.readableParts(id ?? 'b').map(part => part.sessionId)
  const edit = async change => {
    const next = saved()
    change(next)
    writeFileSync(statePath, JSON.stringify(next, null, 2))
    // Both saves see the same external edit before either adoption settles.
    await Promise.allSettled([rt.save(), rt.save()])
    await rt.refresh()
    await rt.peopleQueue(() => {})
  }
  return { rt, ctx, service, statePath, saved, team, logs, agents, created, archived, warnings, goals, reads, routes,
    agentOf, event, start, call, emitService, finishSwitch, open, readable, edit }
}
