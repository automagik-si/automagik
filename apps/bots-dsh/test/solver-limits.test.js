import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { ROUTE } from '../src/host/constants.js'
import { questionReply } from '../src/host/parts.js'
import { answerSender } from '../src/host/turns.js'
import { reviewMarkText, solverAutoView } from '../src/client/solver-draft.js'
import { solverInstructions } from '../src/shared/solver-method.js'
import { fakeContext } from './fake-ctx.js'

const solverModel = { provider: 'fake', model: 'solver-model' }
const reviewerModel = { provider: 'fake', model: 'reviewer-model' }
const content = text => [{ type: 'text', text }]

function fixture(t, home = mkdtempSync(join(tmpdir(), 'solver-limits-'))) {
  const ctx = fakeContext()
  const agents = new Map()
  let identity
  ctx.acpAgents = {
    botIdentity: read => { identity = read },
    rolePromptProviders: ['acp-claude', 'acp-codex'],
  }
  const get = ctx.get
  ctx.get = name => name === 'acpAgents' ? ctx.acpAgents : get(name)
  const sessionOf = id => agentOf(id).session
  function agentOf(id) {
    if (!agents.has(id)) {
      const model = id === 'reviewer' ? reviewerModel : solverModel
      agents.set(id, {
        id, model: { current: () => model },
        session: { id, requestHeader: () => ({ config: model }) },
        ctx: { tools: { restrict: () => () => {} }, effect: run => run() },
        followup(message) { this.message = message },
      })
    }
    return agents.get(id)
  }
  Object.assign(ctx, {
    workspaceRegistry: { get: () => ({ path: home }) },
    sessionController: {
      create: async options => ({ sessionId: options.sessionId }),
      resolveAgent: async id => ({ agent: agentOf(id) }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { get: sessionOf, flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => {
    if (options.path === ROUTE) route = options
    return register(options)
  }
  apply(ctx, { home })
  let disposed = false
  const close = async () => { if (!disposed) { disposed = true; await ctx.dispose() } }
  t.after(close)
  const rt = ctx.provided.get('omniTeam')
  let seq = 0
  const event = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      listener(sessionOf(id), { type, data, seq: ++seq, time: 100 })
    }
  }
  const person = (text, id = 'solver') => event(id, 'user/message', { content: content(text), source: { kind: 'user' } })
  const botMessage = () => event('solver', 'user/message', { content: content('New Bot work.'), source: {
    kind: 'bot', role: 'request', senderSessionId: 'other',
  } })
  const finish = (id, text) => {
    event(id, 'assistant/message', { message: { content: content(text) } })
    event(id, 'turn/end', { reason: { kind: 'completed' } })
  }
  const tool = (name, args, id = 'solver', callId = `call-${++seq}`) => {
    const definition = rt.teamTools.find(entry => entry.name === name)
    assert.ok(definition, `${name} is registered`)
    return definition.execute(args, { agent: agentOf(id), callId })
  }
  const execute = (name, args, id = 'solver', callId = `call-${++seq}`) =>
    ctx.listeners.get('tools/execute')[0]({ name, arguments: args, agent: agentOf(id), callId }, async () => 'ran')
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const progress = (action, args = {}, id = 'solver') => tool('solver_progress', { action, ...args }, id)
  return { ctx, rt, home, agentOf, event, person, execute, tool, call, progress, botMessage, finish, close,
    identity: id => identity?.(id),
  }
}

async function setup(t, extra = {}) {
  const h = fixture(t)
  t.after(() => rmSync(h.home, { recursive: true, force: true, maxRetries: 5 }))
  await h.rt.load()
  h.rt.state.reviewGuardMigrated = true
  const put = (id, fields) => h.rt.state.bots[id] = {
    id, name: id, role: 'Helper', instructions: 'Fake.', shell: true, createdAt: 1, ...fields,
  }
  mkdirSync(join(h.home, 'workspace'))
  put('solver', { role: 'Solver', reviewerId: 'reviewer', workDir: join(h.home, 'workspace'), ...extra })
  put('reviewer', {})
  put('other', {})
  await h.rt.save({ required: true })
  h.person('Do the task.')
  return h
}

const requestOf = async h => /^Request: ([\w-]+)/.exec(await h.progress('status'))?.[1]
const plan = (h, request, checks = ['check-a', 'check-b']) => h.progress('plan', { request, checks })
async function runCheck(h, request, run, pass, check = 'check-a') {
  await h.progress('start', { request, run, checks: [check] })
  return h.progress('checks', { request, run, results: [{ check, pass }] })
}

test('Normal holds the fourth failure and deduplicates the run', async t => {
  const h = await setup(t)
  const request = await requestOf(h)
  assert.ok(request)
  await plan(h, request)
  for (const [run, pass] of [['one', false], ['two', false], ['pass', true], ['three', false]]) {
    assert.match(await runCheck(h, request, run, pass), /Recorded/)
  }
  assert.match(await h.progress('checks', { request, run: 'three', results: [{ check: 'check-a', pass: false }] }), /Recorded/)
  assert.match(await runCheck(h, request, 'four', false), /failed after 3 fix attempts/)
  await assert.rejects(h.execute('write', { file_path: 'out' }), /exact decision/)
  assert.equal(await h.execute('read', {}), 'ran')
  h.person('Use the new input.')
  await h.rt.save({ required: true })
  assert.equal(await h.execute('write', { file_path: 'out' }), 'ran')
})

test('Only a current affirmative person instruction enables request Auto', async t => {
  const h = await setup(t)
  const request = await requestOf(h)
  for (const text of ['Do not work alone until delivered.', 'Example: "work alone until delivered".']) {
    h.person(text)
    assert.match(await h.progress('auto', { request, quote: 'work alone until delivered' }), /own words/)
  }
  h.person('Work alone until delivered.')
  assert.match(await h.progress('auto', { request, quote: 'Work alone until delivered.' }), /Recorded/)
  await plan(h, request)
  for (let i = 0; i < 10; i++) assert.match(await runCheck(h, request, `run-${i}`, false), /Recorded/)
  assert.equal(await h.execute('write', { file_path: 'out' }), 'ran')
  h.event('solver', 'turn/start', { turn: 1 })
  h.finish('solver', 'Outcome with unresolved checks.')
  h.event('solver', 'turn/start', { turn: 2 })
  assert.match(h.rt.roleRuntime.prompt('solver', h.agentOf('solver')), /Limits: 3 fix attempts/)
})

test('The attempt hold survives Bot traffic, a role change and a restart until its question is answered', async t => {
  let h = await setup(t, { reviewGuard: true })
  const request = await requestOf(h)
  for (const run of ['one', 'two']) assert.match(await h.progress('replan', { request, run }), /Recorded/)
  assert.match(await h.progress('replan', { request, run: 'two' }), /Recorded/)
  assert.match(await h.progress('replan', { request, run: 'three' }), /3rd re-plan/)
  const bot = h.rt.botOf('solver')
  const track = bot.reviewTrack
  h.rt.openWork('review-old', { from: bot.id, to: 'reviewer' })
  answerSender(h.rt, 'reviewer', { exchangeId: 'review-old', senderSessionId: bot.id }, 'SHIP')
  for (const name of ['write', 'edit', 'bash', 'start_task', 'remember', 'subagent']) {
    await assert.rejects(h.execute(name, { file_path: 'out' }), /attempt limit/)
  }
  for (const [name, args] of [['read', {}], ['ask_user', {}], ['solver_progress', {}],
    ['write', { file_path: '.solver/notes.md' }], ['message_bot', { to: 'reviewer' }]]) {
    assert.equal(await h.execute(name, args), 'ran', name)
  }
  const guard = h.ctx.listeners.get('tools/pre-execute').find(fn => fn.name === 'reviewGuardGate')
  const exec = { name: 'mcp__dsh__write', arguments: { file_path: 'out' }, agent: h.agentOf('solver'), callId: 'step' }
  assert.equal((await guard(exec, () => ({ kind: 'allow' }))).kind, 'deny')
  const child = h.agentOf('child')
  child.session.header = { origin: 'subagent', parentSession: 'solver' }
  const ask = request => h.ctx.listeners.get('approval/request').at(-1)(request, () => 'allowed')
  assert.equal(await ask({ toolName: 'acp_tool', callId: 'native', agent: child, mirrorCall: { kind: 'edit', title: 'Write' } }), 'rejected')
  const bridge = { toolName: 'write', callId: 'bridge', agent: child, bridgeCall: {} }
  assert.equal(await ask(bridge), 'rejected')
  assert.match(bridge.bridgeCall.refused.reason, /exact decision/)
  assert.match(await h.progress('status', {}, 'other'), /Only a Solver/)
  h.rt.state.rooms.room = { id: 'room', members: [bot.id], sessions: { [bot.id]: 'group-solver' } }
  await h.rt.save({ required: true })
  assert.match(await h.progress('status', {}, 'group-solver'), /Only a Solver/)
  await h.tool('ask_user', { question: 'Example: work alone until delivered?', options: [{ label: 'Use the input' }] }, bot.id, 'question')
  h.botMessage()
  h.event(bot.id, 'user/message', { content: content('Work alone until delivered.'), source: { kind: 'user', resumed: true } })
  h.finish(bot.id, 'I need the decision.')
  assert.equal(bot.reviewTrack.solver.request, track.solver.request)
  assert.equal(bot.reviewTrack.last, undefined)
  assert.equal(bot.reviewTrack.solver.replans, 3)
  bot.role = 'Helper'
  await h.rt.save({ required: true })
  await h.close()
  h = fixture(t, h.home)
  await h.rt.load()
  assert.equal(await requestOf(h), request)
  const saved = h.rt.botOf(bot.id)
  const storedCard = h.rt.state.questions[bot.id]
  assert.ok(storedCard)
  const stale = questionReply({ ...storedCard, callId: 'stale' }, { selected: ['Use the input'] })
  h.event(bot.id, 'user/message', { ...stale, content: content(stale.text) })
  await assert.rejects(h.execute('write', { file_path: 'out' }), /attempt limit/)
  await h.rt.answerQuestion(bot.id, storedCard.id, { selected: ['Use the input'] })
  const answer = h.agentOf(bot.id).message
  h.event(bot.id, 'user/message', answer)
  await h.rt.save({ required: true })
  assert.equal(saved.reviewTrack.solver.replans, 0)
  assert.equal(saved.reviewTrack.solver.limit, undefined)
  assert.match(await h.progress('auto', { request, quote: 'work alone until delivered' }), /own words/)
  await assert.rejects(h.execute('write', { file_path: 'out' }), /review guard holds/)
  assert.equal((await h.call('update-bot', { id: bot.id, solverAuto: true })).ok, true)
  await assert.rejects(h.execute('write', { file_path: 'out' }), /review guard holds/)
})

test('Only current complete checks and an independent designated SHIP mark Done', async t => {
  const h = await setup(t)
  t.mock.method(Date, 'now', () => 100)
  const request = await requestOf(h)
  const bot = h.rt.botOf('solver')
  bot.reviewTrack.requestAt = Date.now()
  const deliveries = []
  h.rt.deliver = async message => { deliveries.push(message); return true }
  const review = async kind => {
    await h.tool('message_bot', { to: 'reviewer', message: 'Please verify this evidence.',
      solver_review: kind, solver_request: request, reply_to: 'me' })
    return deliveries.at(-1).exchangeId
  }
  const verdict = (exchangeId, text, model = reviewerModel.model) => answerSender(h.rt, 'reviewer', {
    exchangeId, senderSessionId: 'solver',
  }, text, undefined, undefined, model)
  await plan(h, request)
  const planExchange = await review('plan')
  assert.match(deliveries.at(-1).text, /Agreed check IDs: check-a, check-b/)
  verdict(planExchange, 'SHIP')
  await h.progress('start', { request, run: 'native', checks: ['check-a'] })
  const mirror = { kind: 'execute', title: 'Run check', input: { command: 'fake check' } }
  const agent = h.agentOf('solver')
  const executeHook = h.ctx.listeners.get('tools/execute')[0]
  assert.equal(await executeHook({ name: 'acp_tool', arguments: mirror, agent, callId: 'native' }, async () => {
    assert.equal(await h.rt.reviewGuardAsk({ toolName: 'acp_tool', mirrorCall: mirror, agent, callId: 'native' }), undefined)
    assert.match(await h.progress('checks', { request, run: 'native', results: [{ check: 'check-a', pass: true }] }), /finish/)
    return 'ran'
  }), 'ran')
  await h.progress('checks', { request, run: 'native', results: [{ check: 'check-a', pass: true }] })
  await h.progress('start', { request, run: 'incomplete', checks: ['check-a', 'check-b'] })
  assert.match(await h.progress('checks', { request, run: 'incomplete', results: [{ check: 'check-a', pass: false }] }), /every check/)
  assert.equal(Object.keys(bot.reviewTrack.solver.attempts).length, 0)
  assert.match(await h.progress('replan', { request, run: 'too-soon' }), /Record the open run/)
  assert.equal(await h.execute('bash', { command: 'fake check' }), 'ran')
  await assert.rejects(h.execute('bash', { command: 'fake second attempt' }), /Finish recording/)
  await h.progress('checks', { request, run: 'incomplete', results: [{ check: 'check-a', pass: false }, { check: 'check-b', pass: true }] })
  await runCheck(h, request, 'pass-a', true)
  await assert.rejects(review('result'), /every agreed check/)
  await runCheck(h, request, 'pass-b', true, 'check-b')
  await runCheck(h, request, 'new-failure', false)
  await assert.rejects(review('result'), /every agreed check/)
  await runCheck(h, request, 'repass-a', true)
  await runCheck(h, request, 'repass-b', true, 'check-b')
  let exchange = await review('result')
  h.rt.openWork('late-plan', { from: 'solver', to: 'reviewer' })
  verdict('late-plan', 'SHIP')
  assert.equal(bot.reviewTrack.solver.review.verdict, undefined)
  verdict(exchange, 'SHIP', solverModel.model)
  assert.equal(bot.reviewTrack.solver.review.verdict, 'unverified')
  exchange = await review('result')
  verdict(exchange, '> SHIP')
  assert.equal(bot.reviewTrack.solver.review.verdict, 'unverified')
  exchange = await review('result')
  verdict(exchange, 'FIX-FIRST')
  assert.equal(bot.reviewTrack.solver.review.verdict, 'FIX-FIRST')
  exchange = await review('result')
  verdict(exchange, 'SHIP')
  await h.execute('mcp__dsh__write', { file_path: 'out' })
  assert.equal(bot.reviewTrack.solver.review, undefined)
  await runCheck(h, request, 'final-a', true)
  await runCheck(h, request, 'final-b', true, 'check-b')
  exchange = await review('result')
  h.event('reviewer', 'user/message', { content: content('Review the agreed checks.'), source: {
    kind: 'bot', role: 'request', senderSessionId: 'solver', exchangeId: exchange,
  } })
  h.event('reviewer', 'turn/start', { turn: 2 })
  h.finish('reviewer', 'SHIP\nEvidence verified.')
  h.event('solver', 'turn/start', { turn: 3 })
  h.finish('solver', 'Reviewed delivery.')
  const mark = bot.reviewTrack.last
  assert.equal(mark.done, true)
  assert.deepEqual(mark.reviewer, { id: 'reviewer', name: 'reviewer', model: reviewerModel.model })
  h.rt.botOf('reviewer').name = 'Renamed'
  assert.match(reviewMarkText({ ...bot, reviewMark: mark }, { byId: h.rt.state.bots }), /every check passed and reviewer approved/)
})

test('Auto setting permissions, Bot-started requests, and written method delivery', async t => {
  let h = await setup(t, { role: '', instructions: solverInstructions(), permission: 'full' })
  let request = await requestOf(h)
  const normal = h.rt.roleRuntime.prompt('solver', h.agentOf('solver'))
  assert.equal(normal.match(/3 fix attempts/g)?.length, 1)
  assert.equal(h.rt.roleRuntime.instructionsFor('solver', h.rt.botOf('solver')), solverInstructions())
  assert.equal(h.identity('solver').rolePrompt, normal)
  assert.equal(h.identity('solver').solverLimitsPrompt, normal)
  assert.match(solverAutoView({ role: 'Solver', model: 'acp-omp/default', nativeTools: true, nativeToolsAgent: 'acp-omp' }, {}, 'ask').lines.join(' '), /prompt-only/)
  assert.match(solverAutoView({ role: 'Solver' }, {}, 'full').lines.join(' '), /prompt-only/)
  for (const name of ['create_bot', 'update_bot']) {
    await assert.rejects(h.tool(name, { name: 'Other', role: 'Solver', instructions: 'Fake.', solverAuto: true }), /Only the person/)
  }
  assert.equal((await h.call('update-bot', { id: 'solver', solverAuto: true, role: 'Solver' })).ok, false)
  assert.equal((await h.call('update-bot', { id: 'other', solverAuto: true })).ok, false)
  const copySave = h.rt.saveCopy
  h.rt.saveCopy = async () => { throw new Error('Fixture storage refused write') }
  await assert.rejects(plan(h, request), /storage refused/)
  assert.equal(h.rt.botOf('solver').reviewTrack.solver.plan, undefined)
  h.rt.saveCopy = copySave
  h.person('Work alone until delivered.')
  await h.rt.save({ required: true })
  await h.close()
  h = fixture(t, h.home)
  await h.rt.load()
  assert.match(await h.progress('auto', { request, quote: 'Work alone until delivered.' }), /own words/)
  // A delivery with no checks stays unmarked; its next Bot request has no Auto authority.
  h.event('solver', 'turn/start', { turn: 1 })
  h.finish('solver', 'Unable to finish.')
  const solver = h.rt.botOf('solver')
  assert.equal(solver.reviewTrack.last.done, undefined)
  assert.equal(solver.reviewTrack.outcome.reason, 'checks')
  h.botMessage()
  assert.notEqual(await requestOf(h), request)
  request = await requestOf(h)
  h.person('Work alone until delivered.')
  assert.match(await h.progress('auto', { request, quote: 'Work alone until delivered.' }), /came from a Bot/)
  assert.equal((await h.call('update-bot', { id: 'solver', solverAuto: true })).ok, true)
  assert.match(h.rt.roleRuntime.prompt('solver', h.agentOf('solver')), /Auto is on/)
  await plan(h, request, ['check-a'])
  for (let i = 0; i < 10; i++) assert.match(await runCheck(h, request, `run-${i}`, false), /Recorded/)
  assert.equal(await h.execute('write', { file_path: 'out' }), 'ran')
})

test('Native omp accepts direct person Auto while the host withholds Done without review evidence', async t => {
  const h = await setup(t, { model: 'acp-omp/default', reviewerId: undefined })
  h.person('Work alone until delivered.')
  await h.rt.save({ required: true })
  assert.match(await h.progress('status'), /Mode: Auto/)
  h.event('solver', 'turn/start', { turn: 1 })
  h.finish('solver', 'Outcome with a check the host cannot verify.')
  const track = h.rt.botOf('solver').reviewTrack
  assert.equal(track.last.review, 'fresh')
  assert.equal(track.last.done, undefined)
})
