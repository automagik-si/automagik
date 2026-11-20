// RFC 0030 Q7a: the parts module refuses a crossing on a chat with history. After
// New conversation, a crossing can apply in place while the fresh part has nothing said.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import * as instructions from '@deepseek-ai/dsh-agent-instructions'
import * as skill from '@deepseek-ai/dsh-tool-skill'
import { install as installFallback } from '../src/host/fallback.js'
import { install as installMemory } from '../src/host/memory.js'
import { install, saidSomething } from '../src/host/parts.js'
import { textOf } from '../src/host/text.js'
import { install as installClock } from '../src/host/time-context.js'
import { fakeContext } from './fake-ctx.js'

const historyRefusal = { code: 'bot/refused', reason: 'needs-new-conversation' }

const NOTE = [
  '## Goals', '- carry on', '## Constraints and preferences', '- none', '## Progress', '- Done: none',
  '## Decisions', '- none', '## Facts to keep', '- none', '## Open threads', '- none',
  '## Next step', '- none', '## Where to look', '- none',
].join('\n')

function bench({ goal, withGoals = true } = {}) {
  const calls = { notes: 0, created: [], selected: [], archived: [], notesAsked: [], goals: [], resolved: [], diagnostics: [] }
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
  // DSH's goal service: the goal belongs to the Session the Agent runs.
  const goals = {
    get: agent => (goal !== undefined && agent?.session?.id === 's1' ? goal : undefined),
    create: (agent, request) => { calls.goals.push([agent.session.id, request]); return { id: 'goal-2', revision: 1, phase: 'active', ...request } },
  }
  const ctx = fakeContext({ services: { tokenMeter: { measure: () => ({ totalTokens: 1000 }) }, ...(withGoals ? { goals } : {}) } })
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
    // diagnostics.js's redacted log, as the route attempt records into it.
    noteFailure: entry => { calls.diagnostics.push(entry) },
    renewMemory() {},
    resolveAgent: async id => {
      calls.resolved.push(id)
      return id === 's1' ? agent : {
        ...agent, id, session: { ...session, id },
        inbox: { nextStep: [], nextTurn: [], remove() {}, unshift() {} },
      }
    },
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
    cachedCatalog: () => ['deepseek/v4', 'acp-claude/default', 'acp-codex/gpt-6.2-sol', 'deepseek-official/deepseek-flash'].map(ref => ({ ref })),
    resolveModel: async ref => ref,
    noteModelChoice: () => {},
    createSession: async () => { const id = `s${++fresh}`; calls.created.push(id); return id },
  }
  install(rt)
  ctx.emit('agent/created', { agent })
  return { rt, ctx, agent, bot, calls }
}

// A goal is the Session's, so the part that takes over starts with none: an active one moves
// with the conversation, carrying the rounds it has left, or a long loop ends at the handoff.
test('an active goal moves to the fresh part with the rounds it has left', async () => {
  const b = bench({ goal: { id: 'goal-1', revision: 4, objective: 'ship the release', phase: 'active', maxGoalRounds: 256, roundsStarted: 6 } })
  await assert.rejects(b.rt.switchRoute('b1', 'acp-claude/default'), historyRefusal)
  await b.rt.startFresh('b1')
  await waitFor(() => b.calls.goals.length === 1)
  assert.deepEqual(b.calls.goals, [['s2', { objective: 'ship the release', maxGoalRounds: 250 }]])
})

// "New session" in a Bot's chat takes the same path with no model call, so the goal follows too.
test('a manual new part carries the goal as well', async () => {
  const b = bench({ goal: { id: 'goal-1', revision: 1, objective: 'ship the release', phase: 'active', maxGoalRounds: 40, roundsStarted: 2 } })
  assert.equal(await b.rt.newPart('s1'), true)
  await waitFor(() => b.calls.goals.length === 1)
  assert.deepEqual(b.calls.goals, [['s2', { objective: 'ship the release', maxGoalRounds: 38 }]])
})

test('a goal that is not active, or a part with no goal, carries nothing', async () => {
  for (const scenario of [
    { name: 'paused', goal: { id: 'goal-1', revision: 2, objective: 'ship', phase: 'paused', maxGoalRounds: 256, roundsStarted: 1 } },
    { name: 'complete', goal: { id: 'goal-1', revision: 2, objective: 'ship', phase: 'complete', maxGoalRounds: 256, roundsStarted: 9 } },
    { name: 'spent', goal: { id: 'goal-1', revision: 2, objective: 'ship', phase: 'active', maxGoalRounds: 9, roundsStarted: 9 } },
    { name: 'none', goal: undefined },
  ]) {
    const b = bench({ goal: scenario.goal })
    await assert.rejects(b.rt.switchRoute('b1', 'acp-claude/default'), historyRefusal, scenario.name)
    await b.rt.startFresh('b1')
    await waitFor(() => b.calls.created.length === 1)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(b.calls.goals, [], scenario.name)
  }
})

test('a host without the goal service still moves the part', async () => {
  const b = bench({ withGoals: false })
  await assert.rejects(b.rt.switchRoute('b1', 'acp-claude/default'), historyRefusal)
  await b.rt.startFresh('b1')
  await waitFor(() => b.calls.created.length === 1)
  assert.deepEqual(b.calls.goals, [])
})

const waitFor = async (check, timeout = 2000) => {
  const at = Date.now()
  while (!check()) {
    if (Date.now() - at > timeout) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

// What a route-change record must never carry: the chat, the note, or anything secret-shaped.
function assertNoConversation(entries) {
  const logged = JSON.stringify(entries)
  for (const text of ['ship it', 'on it', '## Goals', 'carry on', 'sk-', 'Bearer']) assert.equal(logged.includes(text), false, text)
}

// #1631: the host's refusals are terminal, nothing written and no job left pending.
function assertUntouched(b, before) {
  assert.deepEqual({ ...b.bot }, before)
  assert.equal(b.calls.notes, 0)
  assert.deepEqual(b.calls.created, [])
  assert.deepEqual(b.calls.selected, [])
  assert.deepEqual(b.calls.archived, [])
  assert.equal(b.rt.switchingChat('b1'), false)
  assert.equal([...b.rt.switchJobs()].length, 0)
}

test('a conversation whose host cannot start refuses the route change before anything is written', async () => {
  const b = bench()
  const before = { ...b.bot }
  b.rt.resolveAgent = async () => { throw new Error('sandbox-exec: execvp() of codex failed: Operation not permitted') }
  await assert.rejects(b.rt.switchRoute('b1', 'acp-claude/default'), {
    code: 'bot/refused', message: "Ops's current conversation could not be opened, so its route was kept.",
  })
  assertUntouched(b, before)
  assert.deepEqual(b.calls.diagnostics.map(entry => [entry.level, entry.text]), [
    ['warn', 'Route change deepseek/v4 → acp-claude/default refused (conversation unavailable)'],
  ])
  assert.equal(JSON.stringify(b.calls.diagnostics).includes('sandbox-exec'), false)
})

test('a conversation with history but no handoff hook refuses before a job starts', async () => {
  for (const missing of ['whenIdle', 'runMaintenance']) {
    const b = bench()
    const before = { ...b.bot }
    delete b.agent[missing]
    await assert.rejects(b.rt.switchRoute('b1', 'acp-claude/default'), {
      code: 'bot/refused', message: "Ops's current conversation cannot hand off to a new route.",
    }, missing)
    assertUntouched(b, before)
    assert.deepEqual(b.calls.diagnostics.map(entry => entry.text), [
      'Route change deepseek/v4 → acp-claude/default refused (handoff unavailable)',
    ], missing)
  }
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

// #1631: an ACP-hosted Bot (adopted, pinned) picked onto a native route. The refusal is
// immediate and final: no agent lookup, no note, no Session, settings and history as they were.
test('a pinned ACP-hosted Bot is refused a native route at once, with nothing written', async () => {
  const b = bench()
  Object.assign(b.bot, { model: 'acp-codex/gpt-6.2-sol', appliedModel: 'acp-codex/gpt-6.2-sol', effort: 'high', appliedEffort: 'high', sessionPinned: true })
  const before = { ...b.bot }
  const history = JSON.stringify(b.agent.session.deriveMessages())
  await assert.rejects(b.rt.switchRoute('b1', 'deepseek-official/deepseek-flash'), {
    code: 'bot/refused', message: 'Ops speaks in the conversation its host runs, so it cannot start a new one here.',
  })
  assert.deepEqual(b.calls.resolved, [])
  assertUntouched(b, before)
  assert.equal(JSON.stringify(b.agent.session.deriveMessages()), history)
  assert.deepEqual(b.calls.diagnostics.map(({ level, source, bot, where, text }) => ({ level, source, bot, where, text })), [{
    level: 'warn', source: 'host', bot: 'b1', where: 'switch-route',
    text: 'Route change acp-codex/gpt-6.2-sol → deepseek-official/deepseek-flash refused (pinned conversation)',
  }])
  assertNoConversation(b.calls.diagnostics)
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

test('the switch trigger is false for a plain new conversation', async () => {
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
  await assert.rejects(b.rt.switchRoute('b1', 'acp-claude/default'), historyRefusal)
  await b.rt.newPart('s1')
  await waitFor(() => b.bot.sessionId === 's2' && b.calls.archived.length > 0)
  assert.equal(attempts, 2)
  assert.equal(requests[0], requests[1])
  assert.match(b.bot.segments.at(-1).note, /## Goals/)
})

// Ref shape alone is not validation: a credential/path can look exactly like a model.
test('pinned route diagnostics omit hostile and unlisted ref-shaped input without resolving it', async () => {
  for (const model of ['acp-claude/sk-secret', 'private/path/to/chat', 'Bearer secret', 'x/' + 'a'.repeat(201), { secret: 'chat' }]) {
    const b = bench()
    b.bot.sessionPinned = true
    b.rt.resolveModel = async () => { assert.fail('pinned refusal must not refresh the catalog') }
    await assert.rejects(b.rt.switchRoute('b1', model), { code: 'bot/refused' })
    assert.deepEqual(b.calls.resolved, [])
    assert.equal(b.calls.diagnostics[0].text, 'Route change deepseek/v4 → (unavailable ref) refused (pinned conversation)')
  }
})

test('a kickoff-only crossing needs no handoff hooks and restores a failed selection', async () => {
  const b = bench()
  b.agent.session.deriveMessages = () => [{ role: 'user', source: { kind: 'bot', role: 'kickoff' }, content: [] }]
  delete b.agent.whenIdle
  delete b.agent.runMaintenance
  const before = { ...b.bot }
  b.rt.applyModel = async () => { throw new Error('private selection failure') }
  await assert.rejects(b.rt.switchRoute('b1', 'acp-claude/default'), /private selection failure/)
  assertUntouched(b, before)
  b.rt.applyModel = async bot => { bot.appliedModel = bot.model }
  assert.equal((await b.rt.switchRoute('b1', 'acp-claude/default')).status, 'switched')
  assert.equal(b.bot.appliedModel, 'acp-claude/default')
  assert.equal(b.calls.notes, 0)
  assert.deepEqual(b.calls.created, [])
  assert.deepEqual(b.calls.diagnostics.map(entry => entry.text), [
    'Route change deepseek/v4 → acp-claude/default rolled back (in-place selection failed)',
    'Route change deepseek/v4 → acp-claude/default completed (conversation had no exchange to hand off)',
  ])
})

const ROUTE_A = 'deepseek/v4'
const ROUTE_B = 'acp-claude/default'

const userMessage = (kind, text, source = {}) => ({
  role: 'user', source: { kind, ...source }, content: [{ type: 'text', text }],
})

test('a native kickoff answered by the fallback leaves history that blocks an ACP pick', async t => {
  const b = bench()
  t.after(() => b.ctx.dispose())
  const messages = [userMessage('bot', 'Team kickoff.', { role: 'kickoff' })]
  b.agent.session.deriveMessages = () => messages
  let selection = { provider: 'deepseek', model: 'v4' }
  b.agent.model = { current: () => selection, select: route => { selection = route } }
  b.rt.defaultModel = async () => 'deepseek-official/deepseek-flash'
  const idle = Promise.withResolvers()
  const followed = Promise.withResolvers()
  b.agent.whenIdle = () => idle.promise
  b.agent.followup = message => { messages.push(message); followed.resolve(message) }
  installFallback(b.rt)
  const requestError = b.ctx.listeners.get('agent/request-error').at(-1)
  const turnEvent = b.ctx.listeners.get('session/event').at(-1)
  const failure = { code: 'SERVER', message: 'Provider temporarily unavailable' }
  await requestError({ agent: b.agent, turn: 1, step: 1, failure, signal: new AbortController().signal }, async () => undefined)
  turnEvent(b.agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: failure } } })
  idle.resolve()
  const notice = await followed.promise
  assert.deepEqual(notice.source, {
    kind: 'model-selection', form: 'notice', summary: 'deepseek/v4 failed → deepseek-official/deepseek-flash',
  })
  assert.match(textOf(notice.content), /^\[model fallback: .*Provider temporarily unavailable/)
  assert.deepEqual(selection, { provider: 'deepseek-official', model: 'deepseek-flash' })
  messages.push({ role: 'assistant', source: selection, content: [{ type: 'text', text: 'The fallback answered the kickoff.' }] })
  turnEvent(b.agent.session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'stop' } } })
  assert.deepEqual(selection, { provider: 'deepseek', model: 'v4' })

  const before = structuredClone(b.bot)
  b.rt.applyModel = async bot => { bot.appliedModel = bot.model }
  await assert.rejects(b.rt.switchRoute('b1', ROUTE_B), historyRefusal)
  assertUntouched(b, before)
})

test('a populated crossing refuses before clearing Auto, saving, or selecting anything', async t => {
  const b = bench()
  t.after(() => b.ctx.dispose())
  b.agent.whenIdle = () => new Promise(() => {})
  const before = structuredClone(b.bot)
  const mutations = []
  for (const method of ['clearAuto', 'noteModelChoice', 'save', 'applyModel']) b.rt[method] = () => mutations.push(method)
  await assert.rejects(b.rt.switchRoute('b1', ROUTE_B, 'high'), {
    ...historyRefusal,
    message: `${b.bot.name}'s conversation has history, so changing to ACP needs a new conversation. Use New conversation, then pick ACP.`,
  })
  assertUntouched(b, before)
  assertNoConversation(b.calls.diagnostics)
  assert.deepEqual(mutations, [])
  assert.deepEqual(b.calls.diagnostics.map(({ level, where, text }) => [level, where, text]), [
    ['warn', 'switch-route', `Route change ${ROUTE_A} → ${ROUTE_B} refused (needs-new-conversation)`],
  ])
})

test('a crossing refusal tells the person to pause an active goal before New conversation', async t => {
  const b = bench({ goal: { phase: 'active', objective: 'Finish the work' } })
  t.after(() => b.ctx.dispose())
  b.agent.whenIdle = () => new Promise(() => {})
  b.agent.session.deriveMessages = () => [userMessage('goal', 'Work on the current goal.')]
  await assert.rejects(b.rt.switchRoute('b1', ROUTE_B), {
    ...historyRefusal,
    message: `${b.bot.name}'s conversation has history, so changing to ACP needs a new conversation. Use New conversation, then pick ACP (pause an active goal first).`,
  })
})

for (const [kind, service] of [
  ['replay throws', { get() { throw new Error('Goal replay failed') } }],
  ['reader unavailable', {}],
  ['state unreadable', { get: () => ({}) }],
]) {
  test(`a crossing still refuses and includes the pause hint when goal ${kind}`, async t => {
    const b = bench({ withGoals: false })
    t.after(() => b.ctx.dispose())
    b.ctx.provide('goals', service)
    const before = structuredClone(b.bot)
    await assert.rejects(b.rt.switchRoute('b1', ROUTE_B), {
      ...historyRefusal,
      message: `${b.bot.name}'s conversation has history, so changing to ACP needs a new conversation. Use New conversation, then pick ACP (pause an active goal first).`,
    })
    assertUntouched(b, before)
    assert.deepEqual(b.calls.diagnostics.map(entry => entry.text), [
      `Route change ${ROUTE_A} → ${ROUTE_B} refused (needs-new-conversation)`,
    ])
  })
}

async function freshPart(t, { rollover = false } = {}) {
  const b = bench()
  t.after(() => b.ctx.dispose())
  const resolve = b.rt.resolveAgent
  const messages = []
  const fresh = await resolve('s2')
  fresh.session.deriveMessages = () => messages
  fresh.followup = message => messages.push(message)
  b.rt.resolveAgent = id => id === 's2' ? Promise.resolve(fresh) : resolve(id)
  if (rollover) await b.rt.newPart('s1')
  else await b.rt.startFresh('b1')
  await waitFor(() => b.bot.sessionId === 's2' && b.calls.archived.includes('s1') && [...b.rt.switchJobs()].length === 0)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].source.handoff, true)
  b.rt.chatOwners.set('s2', 'b1')
  fresh.whenIdle = () => new Promise(() => {})
  b.rt.applyModel = async bot => { bot.appliedModel = bot.model }
  return { ...b, fresh, messages }
}

test('a new conversation takes the second pick in place with opening context and saved recall', async t => {
  const b = await freshPart(t)
  const home = mkdtempSync(join(tmpdir(), 'crossing-context-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const agentFile = join(home, 'AGENTS.md')
  writeFileSync(agentFile, 'Use the workspace conventions.')
  b.ctx.provide('fs', {
    resolve: async path => path,
    stat: async path => {
      const stat = path === agentFile ? statSync(path) : undefined
      return stat && { type: 'file', size: stat.size, version: '1' }
    },
    streamText: async function* (path) { yield readFileSync(path, 'utf8') },
  })
  b.ctx.workingDirectory = { ensure: async () => home }
  b.fresh.session.surface = { nodes: [] }
  b.fresh.session.seq = 0
  b.ctx.tools.get = name => b.ctx.registeredTools.get(name)
  b.ctx.skills = { snapshot: async () => ({
    skills: [{ name: 'check-work', description: 'Check the workspace', invocation: { modelInvocable: true } }],
    complete: true,
  }) }
  b.rt.home = home
  b.rt.state.prefs = { memoryAutoRecall: true }
  b.rt.state.rooms = {}
  b.rt.teamTools = []
  b.rt.isMain = () => true
  b.rt.isPrivate = () => false
  b.rt.backgroundModel = async () => undefined
  const hooks = []
  for (const register of [
    () => instructions.apply(b.ctx, { dshHome: home, agentsHome: home, maxBytes: 4096 }),
    () => skill.apply(b.ctx),
    () => installModelSelection(b.ctx),
    () => installClock(b.rt),
    () => installMemory(b.rt),
  ]) {
    const prior = new Set(b.ctx.listeners.get('agent/pre-step'))
    register()
    hooks.push(...b.ctx.listeners.get('agent/pre-step').filter(listener => !prior.has(listener)))
  }
  const saved = 'Start each fresh conversation in Portuguese.'
  await b.rt.memoryAdd({ botId: b.bot.id, scope: 'own', topic: 'preferences', text: saved })
  const opening = b.messages[0]
  const payload = {
    agent: b.fresh, step: 1, signal: new AbortController().signal, messages: [opening],
    modelSelection: { provider: 'deepseek', model: 'v4-pro' },
  }
  const context = await hooks.reduceRight((next, hook) => () => hook(payload, next),
    async () => ({ kind: 'enter', messages: [opening] }))()
  const snapshots = [
    ...context.messages.filter(message => message !== opening),
    userMessage('time-context', 'Current time: 12:00.'),
    userMessage('tmux-context', 'Current tmux pane: %12.'),
    userMessage('runtime-context', 'Current session environment.'),
    userMessage('working-directory', 'The working directory changed.'),
    userMessage('plan-mode', 'The user switched this session to plan mode.'),
    userMessage('bot', 'Team kickoff.', { role: 'kickoff' }),
  ]
  const snapshot = kind => snapshots.find(message => message.source.kind === kind)
  assert.match(textOf(snapshot('agent-instructions')?.content), /Use the workspace conventions/)
  assert.match(textOf(snapshot('skill-catalog')?.content), /check-work/)
  assert.deepEqual(snapshot('model-selection')?.source, { kind: 'model-selection', form: 'notice', summary: 'v4 → v4-pro' })
  assert.match(textOf(snapshot('model-selection').content), /^\[model changed: assistant turns above this point/)
  assert.match(textOf(snapshot('ds-bot-memory-recall')?.content), /Start each fresh conversation in Portuguese/)
  assert.ok(snapshot('ds-bot-time-context'))
  b.messages.push(...snapshots, { role: 'assistant', content: [{ type: 'text', text: 'Ready.' }] })
  const result = await b.rt.switchRoute('b1', ROUTE_B)
  assert.equal(result.status, 'switched')
  assert.equal(b.bot.sessionId, 's2')
  assert.equal(b.bot.appliedModel, ROUTE_B)
  assert.deepEqual(b.calls.created, ['s2'])
})

test('a rollover carrying an earlier exchange refuses a crossing', async t => {
  const b = await freshPart(t, { rollover: true })
  assert.match(textOf(b.messages[0].content), /carry on/)
  await assert.rejects(b.rt.switchRoute('b1', ROUTE_B), historyRefusal)
})

for (const [label, edit] of [
  ['edited text', text => text + ' '],
  ['another part number', text => text.replaceAll('part 2', 'part 9')],
  ['a legacy package', () => '[Handoff] Pick up where the previous conversation stopped.'],
]) {
  test(`a handoff with ${label} counts as crossing history`, async t => {
    const b = await freshPart(t)
    const original = b.messages[0]
    b.messages[0] = userMessage(original.source.kind, edit(original.content[0].text), original.source)
    await assert.rejects(b.rt.switchRoute('b1', ROUTE_B), historyRefusal)
  })
}

test('a handoff with a context source still needs to match the exact opening', async t => {
  const b = await freshPart(t)
  b.messages[0] = userMessage('runtime-context', 'Continue the earlier work.', { handoff: true })
  await assert.rejects(b.rt.switchRoute('b1', ROUTE_B), historyRefusal)
})

for (const kind of ['schedule', 'tool-jobs', 'user-approval', 'tool-goal', 'goal', 'repeat-tool-reminder',
  'dsh-session-title-llm', 'model-selection', 'unknown-kind']) {
  test(`a fresh opening with ${kind} still has crossing history`, async t => {
    const b = await freshPart(t)
    b.messages.push(userMessage(kind, 'Work or conversation content.'))
    await assert.rejects(b.rt.switchRoute('b1', ROUTE_B), historyRefusal)
  })
}
