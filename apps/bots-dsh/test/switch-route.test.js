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
  const started = await b.rt.switchRoute('b1', 'acp-claude/default')
  assert.equal(started.status, 'switching')
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
    const started = await b.rt.switchRoute('b1', 'acp-claude/default')
    assert.equal(started.status, 'switching', scenario.name)
    await waitFor(() => b.calls.created.length === 1)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(b.calls.goals, [], scenario.name)
  }
})

test('a host without the goal service still moves the part', async () => {
  const b = bench({ withGoals: false })
  const started = await b.rt.switchRoute('b1', 'acp-claude/default')
  assert.equal(started.status, 'switching')
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
  // #1631: the attempt is in the redacted log, accepted and then completed, with the Bot,
  // both refs and the entry point, and none of the conversation or its handoff note.
  await waitFor(() => b.calls.diagnostics.length === 2)
  assert.equal(b.rt.switchingChat('b1'), false)
  assert.deepEqual(b.calls.diagnostics.map(({ level, source, bot, where, text }) => ({ level, source, bot, where, text })), [
    { level: 'info', source: 'host', bot: 'b1', where: 'switch-route', text: 'Route change deepseek/v4 → acp-claude/default accepted' },
    { level: 'info', source: 'host', bot: 'b1', where: 'switch-route', text: 'Route change deepseek/v4 → acp-claude/default completed' },
  ])
  assertNoConversation(b.calls.diagnostics)
})

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

test('a managed route change whose fresh conversation cannot take the route rolls back', async () => {
  const b = bench()
  const before = { ...b.bot }
  // The target route cannot be selected on the fresh Session (its host does not start).
  b.rt.selectSessionModel = async (id, selection) => {
    b.calls.selected.push([id, selection])
    if (id !== 's1') throw new Error('sandbox-exec: execvp() failed: Operation not permitted')
  }
  const started = await b.rt.switchRoute('b1', 'acp-claude/default')
  assert.equal(started.status, 'switching')
  assert.equal(b.bot.model, 'acp-claude/default')
  await waitFor(() => b.calls.diagnostics.length === 2)
  await waitFor(() => !b.rt.switchingChat('b1'))
  // Back on the route and Session it had; the unused fresh Session is archived, the old one kept.
  assert.deepEqual({ ...b.bot }, before)
  assert.deepEqual(b.calls.created, ['s2'])
  assert.deepEqual(b.calls.archived, ['s2'])
  assert.equal([...b.rt.switchJobs()].length, 0)
  assert.deepEqual(b.calls.diagnostics.map(entry => [entry.level, entry.where, entry.text]), [
    ['info', 'switch-route', 'Route change deepseek/v4 → acp-claude/default accepted'],
    ['warn', 'switch-route', 'Route change deepseek/v4 → acp-claude/default rolled back'],
  ])
  assertNoConversation(b.calls.diagnostics)
  assert.equal(JSON.stringify(b.calls.diagnostics).includes('sandbox-exec'), false)
  // A second pick sees the kept route and can start again.
  b.rt.selectSessionModel = async (id, selection) => { b.calls.selected.push([id, selection]) }
  assert.equal((await b.rt.switchRoute('b1', 'acp-claude/default')).status, 'switching')
})

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

test('a failed old route job preserves a newer model and effort choice', async () => {
  const b = bench()
  let release
  b.agent.whenIdle = () => new Promise(resolve => { release = resolve })
  b.rt.selectSessionModel = async () => { throw new Error('selection failed') }
  await b.rt.switchRoute('b1', 'acp-claude/default', 'high')
  b.bot.model = b.bot.appliedModel = 'deepseek/newer'
  b.bot.effort = b.bot.appliedEffort = 'low'
  release()
  await waitFor(() => !b.rt.switchingChat('b1'))
  assert.equal(b.bot.model, 'deepseek/newer')
  assert.equal(b.bot.appliedModel, 'deepseek/newer')
  assert.equal(b.bot.effort, 'low')
  assert.equal(b.bot.appliedEffort, 'low')
  assert.equal(b.bot.sessionId, 's1')
})


test('a route job that moved but failed to finish is never diagnosed as completed', async () => {
  const b = bench()
  b.rt.moveSchedules = async () => { throw new Error('private failure after the move') }
  await b.rt.switchRoute('b1', 'acp-claude/default')
  await waitFor(() => !b.rt.switchingChat('b1'))
  assert.equal(b.bot.sessionId, 's2')
  assert.deepEqual(b.calls.diagnostics.map(entry => [entry.level, entry.text]), [
    ['info', 'Route change deepseek/v4 → acp-claude/default accepted'],
    ['warn', 'Route change deepseek/v4 → acp-claude/default failed (fresh conversation did not finish)'],
  ])
  assert.equal(JSON.stringify(b.calls.diagnostics).includes('private'), false)
})

const ROUTE_A = 'deepseek/v4'
const ROUTE_B = 'acp-claude/default'

function catalogBench(t) {
  const b = bench()
  t.after(() => b.ctx.dispose())
  const live = new Set([ROUTE_A, ROUTE_B])
  let cached = [...live].map(ref => ({ ref }))
  b.calls.catalog = []
  b.calls.followups = []
  b.rt.catalog = async ({ fresh = false, remember = true } = {}) => {
    b.calls.catalog.push({ fresh, remember })
    if (fresh) cached = [...live].map(ref => ({ ref }))
    return cached
  }
  b.rt.desiredModel = async bot => {
    if (cached.some(entry => entry.ref === bot.model)) return bot.model
    if (cached.some(entry => entry.ref === bot.appliedModel)) return bot.appliedModel
    return cached[0]?.ref
  }
  const resolveAgent = b.rt.resolveAgent
  b.rt.resolveAgent = async id => {
    const agent = await resolveAgent(id)
    if (id !== 's1') agent.followup = () => { b.calls.followups.push(id) }
    return agent
  }
  return { ...b, live }
}

async function switchToTarget(b, effort) {
  assert.equal((await b.rt.switchRoute('b1', ROUTE_B, effort)).status, 'switching')
}

function assertRolledBack(b, before, reason = 'target not served') {
  assert.deepEqual(b.bot, before)
  assert.equal([...b.rt.switchJobs()].length, 0)
  assert.deepEqual(b.calls.diagnostics.map(({ level, text }) => [level, text]), [
    ['info', `Route change ${ROUTE_A} → ${ROUTE_B} accepted`],
    ['warn', `Route change ${ROUTE_A} → ${ROUTE_B} rolled back (${reason})`],
  ])
}

test('a route change checks the live catalog before creating the fresh part', async t => {
  const b = catalogBench(t)
  const before = { ...b.bot }
  const idle = Promise.withResolvers()
  b.agent.whenIdle = () => idle.promise
  await switchToTarget(b)
  b.live.delete(ROUTE_B)
  assert.equal(await b.rt.desiredModel(b.bot), ROUTE_B)
  idle.resolve()
  await waitFor(() => !b.rt.switchingChat('b1'))
  assert.deepEqual(b.calls.catalog, [{ fresh: true, remember: false }])
  assert.deepEqual(b.calls.created, [])
  assert.deepEqual(b.calls.selected, [])
  assert.deepEqual(b.calls.archived, [])
  assertRolledBack(b, before)

  b.live.add(ROUTE_B)
  await switchToTarget(b)
  await waitFor(() => !b.rt.switchingChat('b1'))
})

test('a target dropped during Session creation never selects the old route', async t => {
  const b = catalogBench(t)
  const before = { ...b.bot }
  const createSession = b.rt.createSession
  b.rt.createSession = async (...args) => {
    const id = await createSession(...args)
    b.live.delete(ROUTE_B)
    await b.rt.catalog({ fresh: true, remember: false })
    return id
  }
  const selectSessionModel = b.rt.selectSessionModel
  b.rt.selectSessionModel = async (id, selection) => {
    await selectSessionModel(id, selection)
    if (!b.live.has(`${selection.provider}/${selection.model}`)) throw new Error('model is unavailable')
  }
  await switchToTarget(b)
  await waitFor(() => !b.rt.switchingChat('b1'))
  assert.deepEqual(b.calls.created, ['s2'])
  assert.deepEqual(b.calls.selected, [['s2', { provider: 'acp-claude', model: 'default' }]])
  assert.deepEqual(b.calls.archived, ['s2'])
  assertRolledBack(b, before)
})

test('a target dropped after selection rolls back before sending the handoff', async t => {
  const b = catalogBench(t)
  const before = { ...b.bot }
  const saved = []
  b.rt.save = async () => {
    if (!b.live.has(ROUTE_B)) saved.push({ ...b.bot })
  }
  b.rt.applyPermission = async () => { b.live.delete(ROUTE_B) }
  await switchToTarget(b, 'high')
  await waitFor(() => !b.rt.switchingChat('b1'))
  assert.deepEqual(b.calls.selected, [['s2', { provider: 'acp-claude', model: 'default', reasoningEffort: 'high' }]])
  assert.deepEqual(b.calls.followups, [])
  assert.deepEqual(b.calls.archived, ['s2'])
  assert.deepEqual(saved[0], { ...before, model: ROUTE_B, effort: 'high' })
  assertRolledBack(b, before)
})

test('an empty live catalog rolls back before creating a fresh part', async t => {
  const b = catalogBench(t)
  const before = { ...b.bot }
  b.live.clear()
  await switchToTarget(b)
  await waitFor(() => !b.rt.switchingChat('b1'))
  assert.deepEqual(b.calls.created, [])
  assert.deepEqual(b.calls.selected, [])
  assert.deepEqual(b.calls.archived, [])
  assertRolledBack(b, before)
})

test('a route change rolls back when catalog availability is unknown', async t => {
  const b = catalogBench(t)
  const before = { ...b.bot }
  b.rt.catalog = async () => { throw new Error('catalog unavailable') }
  await switchToTarget(b)
  await waitFor(() => !b.rt.switchingChat('b1'))
  assert.deepEqual(b.calls.created, [])
  assert.deepEqual(b.calls.selected, [])
  assert.deepEqual(b.calls.archived, [])
  assertRolledBack(b, before, 'target availability unknown')
})

test('a route change completes when the target stays served', async t => {
  const b = catalogBench(t)
  await switchToTarget(b)
  await waitFor(() => !b.rt.switchingChat('b1'))
  assert.deepEqual(b.calls.archived, ['s1'])
  assert.equal(b.bot.sessionId, 's2')
  assert.equal(b.bot.appliedModel, ROUTE_B)
  assert.deepEqual(b.calls.diagnostics.map(({ level, text }) => [level, text]), [
    ['info', `Route change ${ROUTE_A} → ${ROUTE_B} accepted`],
    ['info', `Route change ${ROUTE_A} → ${ROUTE_B} completed`],
  ])
})

test('a no-note route change rolls back without waiting for a first answer', async t => {
  const b = catalogBench(t)
  const before = { ...b.bot }
  b.rt.answersAside = ref => ref !== ROUTE_A
  b.rt.applyPermission = async () => { b.live.delete(ROUTE_B) }
  await switchToTarget(b)
  await waitFor(() => !b.rt.switchingChat('b1'))
  assert.equal(b.calls.notes, 0)
  assert.deepEqual(b.calls.archived, ['s2'])
  assert.equal(b.rt.awaitingFirstAnswer('s2'), false)
  assertRolledBack(b, before)
})
