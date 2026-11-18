// A route change is the one pick that starts a new conversation (RFC 0030, Decided 6 and
// 10): the old harness writes the handoff note, a fresh part opens with it, and the Bot's
// model record moves only with it. This runs the installed parts module on fakes.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install, saidSomething } from '../src/host/parts.js'
import { fakeContext } from './fake-ctx.js'

const NOTE = [
  '## Goals', '- carry on', '## Constraints and preferences', '- none', '## Progress', '- Done: none',
  '## Decisions', '- none', '## Facts to keep', '- none', '## Open threads', '- none',
  '## Next step', '- none', '## Where to look', '- none',
].join('\n')

function bench() {
  const calls = { notes: 0, created: [], selected: [], archived: [], notesAsked: [] }
  const session = {
    id: 's1',
    requestHeader: () => ({ config: { provider: 'deepseek', model: 'v4', maxTokens: 1000 } }),
    deriveMessages: () => [
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'ship it' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'on it' }] },
    ],
    toolHistory: () => [],
  }
  const agent = {
    id: 's1', session, status: 'idle',
    whenIdle: async () => {},
    runMaintenance: async job => job(new AbortController().signal),
    inbox: { nextStep: [], nextTurn: [], remove() {}, unshift() {} },
    followup() {}, inject() {}, send() {},
  }
  const ctx = fakeContext({ services: { tokenMeter: { measure: () => ({ totalTokens: 1000 }) } } })
  ctx.sessions = { list: () => [session], flush: async () => {} }
  ctx.llm = {
    resolveModelInfo: async () => ({ context: { contextWindow: 100000 }, defaultMaxTokens: 1000 }),
    stream: (options) => {
      calls.notes += 1
      calls.notesAsked.push(options)
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: NOTE }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  ctx.workspaceRegistry = { archiveSession: async (id) => { calls.archived.push(id) } }
  const bot = { id: 'b1', name: 'Ops', createdAt: 1, sessionId: 's1', model: 'deepseek/v4', appliedModel: 'deepseek/v4' }
  let fresh = 1
  const rt = {
    ctx, config: {}, state: { switching: {}, bots: { b1: bot }, questions: {}, views: {} },
    botOf: id => rt.state.bots[id],
    roomOf: () => undefined,
    chatOf: id => rt.state.bots[id]?.sessionId,
    selfOf: id => (id === 's1' || id === 's2' ? 'b1' : undefined),
    chatOwners: new Map([['s1', 'b1']]),
    groupOwners: new Map(),
    pastOwners: new Map(),
    isBotSession: id => id === 's1' || id === 's2',
    readOnly: () => undefined,
    load: async () => {},
    save: async () => {},
    warn() {},
    renewMemory() {},
    resolveAgent: async id => (id === 's1' ? agent : {
      ...agent, id, session: { ...session, id },
      inbox: { nextStep: [], nextTurn: [], remove() {}, unshift() {} },
    }),
    tagUsage: messages => messages,
    teamFolder: () => '/team',
    isFolder: async () => false,
    workDirOf: () => undefined,
    desiredModel: async () => bot.model,
    desiredEffort: async () => bot.effort,
    resolveEffort: async (ref, effort) => effort,
    selectSessionModel: async (id, selection) => { calls.selected.push([id, selection]) },
    applyPermission: async () => {},
    applyToolDeny: async () => {},
    ensureCapabilities: async () => {},
    moveSchedules: async () => {},
    eventsBackwards: async function* () {},
    resolveModel: async ref => ref,
    noteModelChoice: () => {},
    createSession: async () => { const id = `s${++fresh}`; calls.created.push(id); return id },
  }
  install(rt)
  ctx.emit('agent/created', { agent })
  return { rt, ctx, agent, bot, calls }
}

const waitFor = async (check, timeout = 2000) => {
  const at = Date.now()
  while (!check()) {
    if (Date.now() - at > timeout) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('a route change writes the note first and moves the Bot to a fresh part', async () => {
  const b = bench()
  const started = await b.rt.switchRoute('b1', 'acp-claude/default')
  assert.equal(started.status, 'switching')
  assert.equal(started.model, 'acp-claude/default')
  await waitFor(() => b.bot.sessionId === 's2' && b.calls.archived.length > 0)
  assert.equal(b.calls.notes, 1)
  assert.deepEqual(b.calls.created, ['s2'])
  assert.deepEqual(b.calls.archived, ['s1'])
  assert.equal(b.bot.model, 'acp-claude/default')
  assert.equal(b.bot.appliedModel, 'acp-claude/default')
  // The note is asked of the old route, from the old Session's own prefix.
  assert.equal(b.calls.notesAsked[0].provider, 'deepseek')
  assert.equal(b.calls.notesAsked[0].model, 'v4')
  // The fresh part is selected on the new route.
  assert.deepEqual(b.calls.selected, [['s2', { provider: 'acp-claude', model: 'default' }]])
  assert.equal(b.bot.segments.at(-1).sessionId, 's1')
  assert.match(b.bot.segments.at(-1).note, /## Goals/)
})

test('a model change inside the route is refused by the route endpoint', async () => {
  const b = bench()
  await assert.rejects(b.rt.switchRoute('b1', 'deepseek/v4-pro'), { code: 'bot/refused' })
  assert.equal(b.bot.model, 'deepseek/v4')
  assert.equal(b.calls.notes, 0)
})

test('a pinned conversation cannot move its route', async () => {
  const b = bench()
  b.bot.sessionPinned = true
  await assert.rejects(b.rt.switchRoute('b1', 'acp-claude/default'), { code: 'bot/refused' })
  assert.equal(b.bot.model, 'deepseek/v4')
})

test('a thinking level picked with the crossing reaches the fresh part', async () => {
  const b = bench()
  const started = await b.rt.switchRoute('b1', 'acp-claude/default', 'high')
  assert.equal(started.effort, 'high')
  await waitFor(() => b.bot.sessionId === 's2' && b.calls.archived.length > 0)
  assert.equal(b.bot.model, 'acp-claude/default')
  assert.equal(b.bot.effort, 'high')
  assert.equal(b.bot.appliedModel, 'acp-claude/default')
  assert.equal(b.bot.appliedEffort, 'high')
  assert.deepEqual(b.calls.selected, [['s2', { provider: 'acp-claude', model: 'default', reasoningEffort: 'high' }]])
})

test('anything a person or another Bot said calls for a note; the team kickoff and context do not', () => {
  const user = source => ({ role: 'user', source })
  assert.equal(saidSomething([user({ kind: 'user' })]), true)
  assert.equal(saidSomething([user({ kind: 'user-question-reply' })]), true)
  assert.equal(saidSomething([user({ kind: 'schedule' })]), true)
  assert.equal(saidSomething([user({ kind: 'bot', role: 'post' })]), true)
  assert.equal(saidSomething([user({ kind: 'bot', role: 'kickoff' })]), false)
  assert.equal(saidSomething([user({ kind: 'runtime-context' })]), false)
  assert.equal(saidSomething([{ role: 'user', source: { kind: 'user', handoff: true } }]), false)
  assert.equal(saidSomething([]), false)
  assert.equal(saidSomething(undefined), false)
})

test('the switch trigger is true for a route change and false for a plain new conversation', async () => {
  const route = bench()
  let releaseRoute
  const heldRoute = new Promise(resolve => { releaseRoute = resolve })
  route.agent.whenIdle = async () => { await heldRoute }
  await route.rt.switchRoute('b1', 'acp-claude/default')
  // The old part is still current while the fresh part waits: the target switch is visible.
  assert.equal(route.rt.switchingChat('b1'), true)
  releaseRoute()
  await waitFor(() => route.bot.sessionId === 's2' && route.calls.archived.length > 0)
  assert.equal(route.rt.switchingChat('b1'), false)

  const fresh = bench()
  let releaseFresh
  const heldFresh = new Promise(resolve => { releaseFresh = resolve })
  fresh.agent.whenIdle = async () => { await heldFresh }
  await fresh.rt.startFresh('b1')
  // A plain New conversation has no target route: it is never a route-switch window.
  assert.equal(fresh.rt.switchingChat('b1'), false)
  releaseFresh()
  await waitFor(() => fresh.bot.sessionId === 's2')
  assert.equal(fresh.rt.switchingChat('b1'), false)
})

test('handoff notes retry transient transport failures without changing route or budget', async t => {
  const b = bench(); t.after(() => b.ctx.dispose())
  let attempts = 0
  const stream = b.ctx.llm.stream
  const requests = []
  b.ctx.llm.providerRetryPolicy = () => ({ mode: 'normal', maxRetries: 1, retryableCodes: ['TRANSPORT'], initialDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 })
  b.ctx.llm.stream = async function* (options) {
    requests.push(options)
    if (++attempts === 1) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'temporary failure' } } }
    } else yield* stream(options)
  }
  await b.rt.switchRoute('b1', 'acp-claude/default')
  await waitFor(() => b.bot.sessionId === 's2' && b.calls.archived.length > 0)
  assert.equal(attempts, 2)
  assert.equal(requests[0], requests[1])
  assert.match(b.bot.segments.at(-1).note, /## Goals/)
})
