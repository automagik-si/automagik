import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createScope } from '@deepseek-ai/dsh-scope'
import { fileURLToPath } from 'node:url'
import { apply as applyAcp } from '../../acp-dsh/index.js'
import { Session } from '@deepseek-ai/dsh-session'
import * as native from '@deepseek-ai/dsh-tool-executor-native'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import { AgentRun } from '../../acp-dsh/src/host/acp.js'
import { AcpAdapter } from '../../acp-dsh/src/host/adapter.js'
import { callArguments } from '../../acp-dsh/src/host/tool.js'
import { apply } from '../index.js'
import { ROUTE, STEER_CUT } from '../src/host/constants.js'
import { questionReply } from '../src/host/parts.js'
import { answerSender } from '../src/host/turns.js'
import { DICTIONARY, installLocale } from '../src/client/i18n.js'
import { reviewMarkText, solverAutoView } from '../src/client/solver-draft.js'
import { stopLine } from '../src/client/stops.js'
import { guardVerdictOf } from '../src/shared/review-guard.js'
import { verdictOf } from '../src/shared/review-mark.js'
import { solverInstructions } from '../src/shared/solver-method.js'
import { fakeContext } from './fake-ctx.js'
import { immediate, until } from './until.js'
import { ptBrLocale } from './fixtures/pt-br-locale.js'
import { NewSolver, mount, all, text } from './fixtures/solver-dialog.mjs'

const solverModel = { provider: 'fake', model: 'solver-model' }
const reviewerModel = { provider: 'fake', model: 'reviewer-model' }
const refOf = ({ provider, model }) => `${provider}/${model}`
const content = text => [{ type: 'text', text }]

function fixture(t, home = mkdtempSync(join(tmpdir(), 'solver-limits-')), { liveTurn, configure } = {}) {
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
  if (liveTurn !== undefined) {
    const agent = agentOf('solver')
    agent.status = 'running'
    agent.session.seq = 1
    agent.session.eventAt = seq => seq === 0 ? { type: 'turn/start', data: { turn: liveTurn } } : undefined
    ctx.provided.set('agents', { list: () => [agent] })
  }
  configure?.(ctx, agentOf)
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
  const takeInput = (id, message) => {
    ctx.emit('agent/inbox/claimed', { agent: agentOf(id), message })
    event(id, 'user/message', message)
  }
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
  return { ctx, rt, home, agentOf, event, person, takeInput, execute, tool, call, progress, botMessage, finish, close,
    identity: id => identity?.(id),
  }
}

async function setup(t, extra = {}, turn) {
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
  if (turn !== undefined) h.event('solver', 'turn/start', { turn })
  h.person('Do the task.')
  return h
}

const requestOf = async h => /^Request: ([\w-]+)/.exec(await h.progress('status'))?.[1]
const plan = (h, request, checks = ['check-a', 'check-b'], commands = checks.map(check => ({ check, command: `fake ${check}` }))) =>
  h.progress('plan', { request, checks, commands })
async function runCheck(h, request, run, pass, check = 'check-a') {
  await h.progress('start', { request, run, checks: [check] })
  return h.progress('checks', { request, run, results: [{ check, pass }] })
}


const results = (check = 'check-a', pass = true) => [{ check, pass }]
async function checked(h, request, run, { check = 'check-a', command = `fake ${check}`, exitCode = 0, work } = {}) {
  await h.progress('start', { request, run, checks: [check] })
  const cwd = h.rt.botOf('solver').workDir
  await h.ctx.listeners.get('tools/execute')[0]({
    name: 'bash', arguments: { command }, agent: h.agentOf('solver'), callId: run,
  }, async () => {
    work?.(cwd)
    return { isError: false, value: { kind: 'foreground', cwd, exitCode, signal: null, timedOut: false, aborted: false } }
  })
  return h.progress('checks', { request, run, results: results(check, exitCode === 0) })
}

async function reviewedPlan(h, checks, commands, { legacyPlan } = {}) {
  const request = await requestOf(h)
  const exchange = (kind, text = 'Verify the evidence.') => h.tool('message_bot', {
    to: 'reviewer', message: text, solver_review: kind, solver_request: request, reply_to: 'me',
  })
  const verdict = (exchangeId, model = refOf(reviewerModel)) => answerSender(h.rt, 'reviewer', {
    exchangeId, senderSessionId: 'solver',
  }, 'SHIP', undefined, undefined, model)
  const delivered = []
  h.rt.deliver = async message => { delivered.push(message); return true }
  assert.match(await plan(h, request, checks, legacyPlan ? undefined : commands), /^Recorded\./)
  if (legacyPlan) {
    // An older plan could already contain this raw command before registration checked its syntax.
    h.rt.botOf('solver').reviewTrack.solver.plan.commands = Object.fromEntries(commands.map(({ check, command }) => [check, command]))
  }
  await exchange('plan')
  verdict(delivered.at(-1).exchangeId)
  return { request, send: exchange, verdict, delivered }
}

const reviewShip = 'Verdict: SHIP\nEvidence verified.'
const noSolverRequest = 'There is no active Solver request in this chat.'

async function reviewReplyFixture(t, averageCommand = 'node --test average.test.mjs') {
  const h = await setup(t, { reviewGuard: true }, 2)
  const request = await requestOf(h)
  assert.ok(request, 'turn 2 has an active request')
  assert.match(await plan(h, request, ['average-test', 'diff-check'], [
    { check: 'average-test', command: averageCommand },
    { check: 'diff-check', command: 'git diff --check' },
  ]), /^Recorded\./)
  const deliver = h.rt.deliver
  const deliveries = []
  h.rt.deliver = (message, options) => {
    const sent = deliver(message, options)
    deliveries.push({ message, sent })
    return sent
  }
  const review = async kind => {
    await h.tool('message_bot', { to: 'reviewer', message: `Review the ${kind}.`,
      solver_review: kind, solver_request: request, reply_to: 'me' })
    return deliveries.at(-1).message.exchangeId
  }
  const answer = (exchangeId, shouldSend, model = refOf(reviewerModel)) => {
    const input = h.agentOf('reviewer').message
    assert.equal(input.source.exchangeId, exchangeId)
    h.takeInput('reviewer', input)
    answerSender(h.rt, 'reviewer', { exchangeId, senderSessionId: 'solver' },
      reviewShip, undefined, shouldSend, model)
    return deliveries.at(-1)
  }
  const track = () => h.rt.botOf('solver').reviewTrack
  const openReply = async (turn, { message, sent }) => {
    assert.equal(await sent, message.exchangeId)
    const input = h.agentOf('solver').message
    assert.equal(input.source.exchangeId, message.exchangeId)
    h.event('solver', 'turn/start', { turn })
    h.takeInput('solver', input)
  }
  return { h, request, review, answer, track, openReply, deliveries }
}

for (const timing of ['before', 'after']) {
  test(`Stage 6 review reply PLAN answers ${timing} the waiting turn ends`, async t => {
    const { h, request, review, answer, track, openReply } = await reviewReplyFixture(t)
    const exchange = await review('plan')
    let reply
    if (timing === 'before') reply = answer(exchange)
    assert.equal(await requestOf(h), request)
    h.finish('solver', 'The plan is with the designated reviewer. I am waiting for its verdict.')
    const { delivered, last } = track()
    if (timing === 'after') reply = answer(exchange)
    await openReply(3, reply)
    const start = await h.progress('start', { request, run: 'run-1', checks: ['average-test'] })
    const status = await h.progress('status')
    t.diagnostic(`turn 2 delivered=${delivered === true} mark=${JSON.stringify(last ?? null)}; turn 3 start=${start}; status=${status.split('\n')[0]}`)
    assert.match(start, /^Recorded\./, 'the next turn can start a check for the same request')
    assert.equal(status.split('\n')[0], `Request: ${request}`)
    assert.notEqual(delivered, true, 'the waiting turn did not deliver')
  })
}

for (const release of ['consumption', 'abandonment', 'delivery failure', 'discard', 'input failure']) {
  test(`Stage 6 review reply RESULT waits for ${release}`, async t => {
    const native = release === 'consumption'
    const averageCommand = native ? stage6CommandIn(checkDirectory(t)) : 'node --test average.test.mjs'
    const { h, request, review, answer, track, openReply, deliveries } = await reviewReplyFixture(t, averageCommand)
    const planExchange = await review('plan')
    const earlyPlan = release === 'consumption' ? answer(planExchange) : undefined
    h.finish('solver', 'Waiting for plan review.')
    await openReply(3, earlyPlan ?? answer(planExchange))
    const oldReply = h.agentOf('solver').message
    const checks = [
      { run: 'test', check: 'average-test', command: averageCommand },
      { run: 'diff', check: 'diff-check', command: 'git diff --check' },
    ]
    if (native) {
      const { mirror } = await nativeMirror(t, h)
      for (const { run, check, command } of checks) {
        assert.match(await h.progress('start', { request, run, checks: [check] }), /^Recorded\./)
        assert.equal((await mirror(run, { command: `/bin/bash -lc '${command}'` })).isError, false)
        assert.match(await h.progress('checks', { request, run, results: results(check) }), /^Recorded\./)
      }
    } else {
      for (const { run, check, command } of checks) {
        assert.match(await checked(h, request, run, { check, command }), /^Recorded\./)
      }
    }
    const exchange = await review('result')
    const solver = h.agentOf('solver')
    if (release === 'delivery failure') {
      const followup = solver.followup
      let failed = false
      t.mock.method(solver, 'followup', message => {
        if (message.source.replyTo === exchange && !failed) {
          failed = true
          throw new Error('Fixture reply delivery failed')
        }
        followup.call(solver, message)
      })
    }
    const reply = answer(exchange, release === 'abandonment' ? () => false : undefined)
    h.finish('solver', 'Waiting for result review.')
    assert.notEqual(track().delivered, true, 'the waiting turn did not deliver')
    if (release === 'consumption') {
      assert.equal(await reply.sent, reply.message.exchangeId)
      h.event('solver', 'turn/start', { turn: 4 })
      const input = solver.message
      const forged = { ...input, source: { ...input.source, reviewReceipt: 'forged' } }
      h.ctx.emit('agent/inbox/discarded', { agent: solver, message: forged })
      h.rt.wakeLog.quiet(() => h.ctx.emit('agent/inbox/discarded', { agent: solver, message: input }))
      // Even a copied source and message ID require the actual inbox claim.
      h.event('solver', 'user/message', structuredClone(input))
      h.takeInput('solver', forged)
      h.takeInput('solver', oldReply)
      h.finish('solver', 'The genuine reply is still in the inbox.')
      assert.notEqual(track().delivered, true, 'forged inputs, older exchanges and an inbox move keep the hold')
      const unrelated = await h.rt.deliver({ fromId: 'other', toId: 'solver', role: 'reply',
        replyTo: 'other-work', text: 'A reply for different work.' })
      assert.equal(solver.message.source.exchangeId, unrelated)
      h.event('solver', 'turn/start', { turn: 5 })
      h.takeInput('solver', solver.message)
      h.takeInput('solver', input)
    } else if (release === 'delivery failure') {
      await assert.rejects(reply.sent, /Fixture reply delivery failed/)
      const failureNotice = deliveries.at(-1)
      assert.notEqual(failureNotice.message.exchangeId, reply.message.exchangeId)
      await failureNotice.sent
      assert.match(solver.message.content[0].text, /could not send its reply/)
      h.event('solver', 'turn/start', { turn: 4 })
      h.takeInput('solver', solver.message)
    } else {
      if (release === 'abandonment') {
        assert.equal(await reply.sent, undefined)
      } else {
        assert.equal(await reply.sent, reply.message.exchangeId)
        if (release === 'discard') h.ctx.emit('agent/inbox/discarded', { agent: solver, message: solver.message })
        else {
          h.event('solver', 'turn/start', { turn: 4 })
          h.ctx.emit('agent/inbox/claimed', { agent: solver, message: solver.message })
          h.event('solver', 'turn/end', { reason: { kind: 'error', error: { code: 'UNKNOWN' } } })
        }
      }
    }
    assert.equal(await requestOf(h), request)
    if (release === 'consumption' || release === 'delivery failure') {
      h.finish('solver', 'Both reviews approved and both checks passed.')
    } else {
      // Test terminal release on the same request, without a new person message overriding the hold.
      h.rt.reviewTurnEnd('solver', { completed: true, wroteText: true, model: refOf(solverModel), request })
    }
    const mark = track().last
    assert.equal(track().delivered, true)
    assert.equal(mark.done, true)
    assert.equal(mark.resultExchangeId, exchange)
    assert.equal(mark.reviewer.model, refOf(reviewerModel))
    h.event('solver', 'turn/start', { turn: 6 })
    h.finish('solver', 'Already delivered.')
    assert.deepEqual(track().last, mark)
    assert.equal(await h.progress('status'), noSolverRequest)
  })
}

test('Stage 6 review reply preserves person interruption and request replacement', async t => {
  const { h, request, review, answer, track, openReply } = await reviewReplyFixture(t)
  const exchange = await review('plan')
  const time = t.mock.method(Date, 'now', () => h.rt.state.works[exchange].at + 1)
  h.person('Deliver now, please.')
  time.mock.restore()
  const reply = answer(exchange)
  h.finish('solver', 'Delivered at the person’s request.')
  assert.equal(track().delivered, true)

  h.event('solver', 'turn/start', { turn: 3 })
  h.person('This is a new request.')
  const replacement = await requestOf(h)
  assert.ok(replacement && replacement !== request)
  h.event('solver', 'turn/end', { reason: { kind: 'completed' } })
  await openReply(4, reply)
  h.finish('solver', 'Finished reading the earlier review.')
  assert.equal(await requestOf(h), replacement)
  assert.notEqual(track().delivered, true)
})

test('Rebase R2 preserves a matching verdict and the durable progress write at commit', async t => {
  const { h, request, review, answer, track } = await reviewReplyFixture(t)
  const exchange = await review('plan')
  h.person('Work alone until delivered.')
  const atCommit = Promise.withResolvers()
  const release = Promise.withResolvers()
  const saveCopy = h.rt.saveCopy
  h.rt.saveCopy = (change, options) => saveCopy(change, {
    ...options, beforeCommit: async () => {
      atCommit.resolve()
      await release.promise
      return options.beforeCommit()
    },
  })
  const write = h.progress('auto', { request, quote: 'Work alone until delivered.' })
  await atCommit.promise
  const reply = answer(exchange)
  release.resolve()
  assert.match(await write, /^Recorded\./)
  h.finish('solver', 'Waiting for plan review.')
  await reply.sent
  await h.rt.save({ required: true, durable: true })
  assert.equal(track().solver.plan.accepted, true)
  assert.equal(track().solver.auto, true)
  const saved = JSON.parse(readFileSync(join(h.home, 'state.json'), 'utf8')).bots.solver.reviewTrack
  assert.equal(saved.solver.plan.review.verdict, 'SHIP')
  assert.equal(saved.solver.auto, true)
})

test('Rebase R2 holds delivery during reply note adoption and releases a pre-inbox rejection', async t => {
  for (const accepted of [true, false]) await t.test(accepted ? 'claimed reply' : 'definite rejection', async t => {
    const { h, request, review, answer, track, openReply } = await reviewReplyFixture(t)
    const exchange = await review('plan')
    let adoptedNotes = false
    const adopted = h.rt.reloadDeliveryNotes(() => { adoptedNotes = true })
    const reply = answer(exchange, () => accepted)
    assert.equal(h.rt.deliveryNote(reply.message.exchangeId), undefined)
    h.finish('solver', 'Waiting for plan review.')
    const before = track().last
    assert.equal(adoptedNotes, false)
    await adopted
    assert.equal(adoptedNotes, true)
    assert.equal(before, undefined, 'the waiting turn must not deliver during adoption')
    if (accepted) {
      await openReply(3, reply)
      h.finish('solver', 'Delivered after reading the PLAN.')
    } else {
      assert.equal(await reply.sent, undefined)
      h.rt.reviewTurnEnd('solver', { completed: true, wroteText: true, request })
    }
    const mark = track().last
    assert.ok(mark)
    assert.equal(track().delivered, true)
    h.rt.reviewTurnEnd('solver', { completed: true, wroteText: true, request })
    assert.equal(track().last, mark)
  })
})

test('Stage 6 review reply stays pending in the delivery notes across restart', async t => {
  const { h, request, review, answer, track } = await reviewReplyFixture(t)
  const exchange = await review('plan')
  const reply = answer(exchange)
  h.finish('solver', 'Waiting for plan review.')
  assert.notEqual(track().delivered, true)
  assert.equal(await reply.sent, reply.message.exchangeId)
  await h.rt.save({ required: true, durable: true })
  assert.equal(await h.rt.flushUpdateNotes(), true)
  await h.close()

  const next = fixture(t, h.home)
  await next.rt.load()
  const boundEnd = () => next.rt.reviewTurnEnd('solver', { completed: true, wroteText: true, model: refOf(solverModel), request })
  boundEnd()
  assert.equal(await requestOf(next), request)
  // The boot replay timer is unref'ed by the plugin. Keep the fake test alive until it finishes.
  const keepAlive = setInterval(() => {}, 1000)
  try {
    assert.deepEqual((await next.rt.resumesDone).resent, ['solver'])
  } finally {
    clearInterval(keepAlive)
  }
  const input = next.agentOf('solver').message
  assert.equal(input.source.exchangeId, reply.message.exchangeId)
  next.event('solver', 'turn/start', { turn: 3 })
  next.takeInput('solver', input)
  next.finish('solver', 'Delivered after reading the saved review reply.')
  assert.equal(await next.progress('status'), noSolverRequest)
})

test('Stage 6 round 2 keeps a review reply through an ordinary inbox move and releases a withdrawal', async t => {
  const { h, request, review, answer, track } = await reviewReplyFixture(t)
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  const loop = await mountAgentLoopTestHarness(ctx)
  const { inbox } = await loop.create('solver')
  const solver = h.agentOf('solver')
  for (const event of ['agent/inbox/inserted', 'agent/inbox/discarded']) {
    ctx.on(event, ({ message }) => h.ctx.emit(event, { agent: solver, message }))
  }
  solver.inbox = inbox
  solver.followup = message => inbox.append('next-turn', message)

  const reply = answer(await review('plan'))
  h.finish('solver', 'Waiting for plan review.')
  await reply.sent
  const [original] = inbox.nextTurn
  assert.equal(original.source.exchangeId, reply.message.exchangeId)
  assert.equal(inbox.remove(original.id), true)
  inbox.append('next-step', original)
  const edited = { ...original, id: `${original.id}-edited` }
  assert.equal(inbox.replace(original.id, edited), true)
  await immediate()
  const closeRequest = () => h.rt.reviewTurnEnd('solver', { completed: true, wroteText: true, model: refOf(solverModel), request })
  closeRequest()
  assert.equal(await requestOf(h), request, 'ordinary move and replacement keep the queued reply unread')

  const other = await h.rt.deliver({ fromId: 'other', toId: 'solver', role: 'reply', text: 'Unrelated reply.' })
  assert.equal(inbox.remove(edited.id), true)
  await immediate()
  assert.equal(h.rt.deliveryNote(reply.message.exchangeId), undefined)
  assert.ok(h.rt.deliveryNote(other), 'withdrawing the review reply leaves the unrelated note')
  closeRequest()
  assert.equal(track().delivered, true)
})

test('Rebase R2 keeps a matching receipt while its sibling is withdrawn', async t => {
  const { h, request, review, answer } = await reviewReplyFixture(t)
  const reply = answer(await review('plan'))
  h.finish('solver', 'Waiting for plan review.')
  await reply.sent
  const agent = h.agentOf('solver')
  const original = agent.message
  const pending = { ...original, id: 'pending-sibling' }
  const withdrawn = { ...original, id: 'withdrawn-sibling' }
  agent.inbox = { nextTurn: [pending], nextStep: [] }
  h.ctx.emit('agent/inbox/discarded', { agent, message: withdrawn })
  await immediate()
  assert.ok(h.rt.deliveryNote(reply.message.exchangeId), 'an already pending sibling keeps the receipt')

  agent.inbox.nextTurn.pop()
  h.event('solver', 'turn/start', { turn: 3 })
  h.ctx.emit('agent/inbox/claimed', { agent, message: pending, turn: 3 })
  h.ctx.emit('agent/inbox/discarded', { agent, message: withdrawn })
  await immediate()
  assert.ok(h.rt.deliveryNote(reply.message.exchangeId), 'an outstanding claim keeps the receipt')
  h.event('solver', 'user/message', pending)
  assert.equal(h.rt.deliveryNote(reply.message.exchangeId), undefined)
  assert.match(await h.progress('start', { request, run: 'kept-receipt', checks: ['average-test'] }), /^Recorded\./)
})

test('Stage 6 round 2 keeps an accepted reply after a later delivery failure', async t => {
  for (const failure of ['later enqueue', 'Session flush']) {
    await t.test(failure, async t => {
      const { h, request, review, answer, deliveries } = await reviewReplyFixture(t)
      const exchange = await review('plan')
      const solver = h.agentOf('solver')
      const inbox = []
      solver.inbox = { nextTurn: inbox, nextStep: [] }
      solver.followup = message => {
        if (message.source.senderSessionId === 'other') throw new Error('Fixture later enqueue failed')
        inbox.push(message)
        h.ctx.emit('agent/inbox/inserted', { agent: solver, message })
      }
      let failed = false
      if (failure === 'Session flush') {
        h.ctx.sessions.flush = async session => {
          if (!failed && session.id === 'solver' && inbox.length > 0) {
            failed = true
            throw new Error('Fixture Session flush failed')
          }
        }
      }
      const reply = answer(exchange)
      const later = failure === 'later enqueue' ? h.rt.deliver({
        fromId: 'other', toId: 'solver', role: 'reply', text: 'Later batch item.',
      }) : undefined
      const rejected = later && assert.rejects(later, /Fixture later enqueue failed/)
      h.finish('solver', 'Waiting for plan review.')
      await reply.sent.catch(() => {})
      await rejected
      if (failure === 'Session flush') assert.equal(failed, true)
      assert.ok(h.rt.deliveryNote(reply.message.exchangeId), 'the accepted reply still holds the request')
      assert.equal(deliveries.filter(item => item.message.replyTo === exchange).length, 1, 'no actionable fallback')
      assert.equal(inbox.length, 1)
      const [input] = inbox
      h.event('solver', 'turn/start', { turn: 3 })
      h.takeInput('solver', { ...input, source: { ...input.source, reviewReceipt: 'stale' } })
      h.rt.reviewTurnEnd('solver', { completed: true, wroteText: true, model: refOf(solverModel), request })
      assert.equal(await requestOf(h), request)
      h.takeInput('solver', inbox.shift())
      assert.equal(h.rt.deliveryNote(reply.message.exchangeId), undefined)
      assert.match(await h.progress('start', { request, run: 'run-after-failure', checks: ['average-test'] }), /^Recorded\./)
    })
  }
})

test('Stage 6 round 2 delivers the original request once after restarting a consumed RESULT turn', async t => {
  const { h, request, review, answer, track, openReply } = await reviewReplyFixture(t)
  const planExchange = await review('plan')
  h.finish('solver', 'Waiting for plan review.')
  await openReply(3, answer(planExchange))
  assert.match(await checked(h, request, 'test', { check: 'average-test', command: 'node --test average.test.mjs' }), /^Recorded\./)
  assert.match(await checked(h, request, 'diff', { check: 'diff-check', command: 'git diff --check' }), /^Recorded\./)
  const resultExchange = await review('result')
  const reply = answer(resultExchange)
  h.finish('solver', 'Waiting for result review.')
  await openReply(4, reply)
  assert.equal(h.rt.deliveryNote(reply.message.exchangeId), undefined, 'RESULT already became turn input')
  assert.notEqual(track().delivered, true)
  h.event('solver', 'turn/end', { reason: { kind: 'interrupted' } })
  await h.rt.save({ required: true, durable: true })
  assert.equal(await h.rt.flushUpdateNotes(), true)
  await h.close()

  const next = fixture(t, h.home)
  await next.rt.load()
  const keepAlive = setInterval(() => {}, 1000)
  try {
    assert.deepEqual((await next.rt.resumesDone).resumed, ['solver'])
  } finally {
    clearInterval(keepAlive)
  }
  const input = next.agentOf('solver').message
  assert.equal(input.source.role, 'resume')
  assert.equal(await requestOf(next), request)
  next.event('solver', 'turn/start', { turn: 5 })
  next.event('solver', 'user/message', structuredClone(input))
  next.takeInput('solver', { ...input, id: 'different-continuation' })
  next.finish('solver', 'A matching-looking continuation did not authorize delivery.')
  assert.equal(await requestOf(next), request)

  next.event('solver', 'turn/start', { turn: 6 })
  next.takeInput('solver', input)
  next.finish('solver', 'Both reviews approved and both checks passed.')
  const resumedTrack = () => next.rt.botOf('solver').reviewTrack
  const mark = resumedTrack().last
  assert.equal(resumedTrack().solver.request, request)
  assert.equal(resumedTrack().delivered, true)
  assert.equal(mark.done, true)
  assert.equal(mark.resultExchangeId, resultExchange)
  next.event('solver', 'turn/start', { turn: 7 })
  next.takeInput('solver', input)
  next.finish('solver', 'This continuation already delivered.')
  assert.deepEqual(resumedTrack().last, mark)
  assert.equal(await next.progress('status'), noSolverRequest)
  assert.equal(await next.rt.flushUpdateNotes(), true)
  await next.close()
})

test('Rebase R2 recovers a moved RESULT continuation only from its current claim', async t => {
  const { h, request, resultExchange, openReply, reply } = await pendingResultReply(t)
  await openReply(4, reply)
  h.event('solver', 'turn/end', { reason: { kind: 'interrupted' } })
  await h.rt.save({ required: true, durable: true })
  assert.equal(await h.rt.flushUpdateNotes(), true)
  await h.close()

  const next = fixture(t, h.home)
  await next.rt.load()
  const keepAlive = setInterval(() => {}, 1000)
  try {
    assert.deepEqual((await next.rt.resumesDone).resumed, ['solver'])
  } finally {
    clearInterval(keepAlive)
  }
  const agent = next.agentOf('solver')
  const original = agent.message
  const moved = { ...original, id: 'forwarded-continuation' }
  agent.inbox = { nextTurn: [moved], nextStep: [] }
  next.ctx.emit('agent/inbox/discarded', { agent, message: original })
  next.ctx.emit('agent/inbox/inserted', { agent, message: moved })
  await immediate()
  assert.ok(next.rt.deliveryNote(original.source.exchangeId), 'the note survives the inbox ID change')
  assert.equal(next.rt.takeReviewContinuation('solver', moved), undefined, 'forwarding alone is not consumption')
  assert.equal(await requestOf(next), request)
  next.event('solver', 'turn/start', { turn: 5 })
  agent.inbox.nextTurn.pop()
  next.ctx.emit('agent/inbox/claimed', { agent, message: moved, turn: 5 })
  assert.equal(next.rt.takeReviewContinuation('solver', original), undefined, 'the old ID was not claimed')
  next.event('solver', 'user/message', moved)
  next.finish('solver', 'Delivered after recovering and reading the moved RESULT.')
  const track = next.rt.botOf('solver').reviewTrack
  assert.equal(track.solver.request, request)
  assert.equal(track.last?.done, true)
  assert.equal(track.last.resultExchangeId, resultExchange)
  assert.equal(next.rt.takeReviewContinuation('solver', moved), undefined)
  assert.equal(await next.rt.flushUpdateNotes(), true)
  await next.rt.save({ required: true, durable: true })
  await next.close()
})

async function pendingResultReply(t) {
  const { h, request, review, answer, track, openReply } = await reviewReplyFixture(t)
  const planExchange = await review('plan')
  h.finish('solver', 'Waiting for plan review.')
  await openReply(3, answer(planExchange))
  assert.match(await checked(h, request, 'test', { check: 'average-test', command: 'node --test average.test.mjs' }), /^Recorded\./)
  assert.match(await checked(h, request, 'diff', { check: 'diff-check', command: 'git diff --check' }), /^Recorded\./)
  const resultExchange = await review('result')
  const reply = answer(resultExchange)
  h.finish('solver', 'Waiting for result review.')
  return { h, request, resultExchange, openReply, reply, track }
}

test('Rebase R2 authenticates new claims and consumed RESULT on the actual adopted turn', async t => {
  for (const consumed of [false, true]) await t.test(consumed ? 'long consumed turn' : 'new numbered claim', async t => {
    const { h, resultExchange, openReply, reply } = await pendingResultReply(t)
    await reply.sent
    const input = h.agentOf('solver').message
    if (consumed) await openReply(4, reply)
    await h.rt.save({ required: true, durable: true })
    assert.equal(await h.rt.flushUpdateNotes(), true)
    await h.close()

    const next = fixture(t, h.home, { liveTurn: 4 })
    const agent = next.agentOf('solver')
    if (consumed) {
      const start = agent.session.eventAt(0)
      agent.session.seq = 450
      agent.session.eventAt = seq => seq === 0 ? start : { type: 'step/start' }
    }
    await next.rt.load()
    await immediate()
    if (!consumed) {
      next.ctx.emit('agent/inbox/claimed', { agent, message: input, turn: 5 })
      next.event('solver', 'user/message', input)
      assert.equal(next.rt.live.get('solver')?.consumedResult, undefined)
      assert.ok(next.rt.deliveryNote(reply.message.exchangeId), 'the wrong-turn claim cannot consume the reply')
      next.ctx.emit('agent/inbox/claimed', { agent, message: input, turn: 4 })
      next.event('solver', 'user/message', input)
    }
    next.finish('solver', 'Delivered on the adopted RESULT turn.')
    assert.equal(next.rt.botOf('solver').reviewTrack.last?.done, true)
    assert.equal(next.rt.botOf('solver').reviewTrack.last.resultExchangeId, resultExchange)
    assert.equal(await next.rt.flushUpdateNotes(), true)
    await next.rt.save({ required: true, durable: true })
    await next.close()
  })
})

test('Stage 6 reload adopts a live turn only when it consumed the current RESULT', async t => {
  const { h, request, review, answer, track, openReply } = await reviewReplyFixture(t)
  const planExchange = await review('plan')
  h.finish('solver', 'Waiting for plan review.')
  await openReply(3, answer(planExchange))
  assert.match(await checked(h, request, 'test', { check: 'average-test', command: 'node --test average.test.mjs' }), /^Recorded\./)
  assert.match(await checked(h, request, 'diff', { check: 'diff-check', command: 'git diff --check' }), /^Recorded\./)
  const resultExchange = await review('result')
  const reply = answer(resultExchange)
  h.finish('solver', 'Waiting for result review.')
  await openReply(4, reply)
  assert.notEqual(track().delivered, true)
  assert.equal(await h.rt.flushUpdateNotes(), true)
  await h.close()

  const next = fixture(t, h.home, { liveTurn: 4 })
  await next.rt.load()
  await immediate()
  const agent = next.agentOf('solver')
  const trackNow = () => next.rt.botOf('solver').reviewTrack
  assert.equal(next.rt.live.get('solver')?.consumedResult?.request, request)
  const eventAt = agent.session.eventAt
  agent.session.eventAt = () => ({ type: 'turn/start', data: { turn: 5 } })
  assert.equal(next.rt.consumedReviewResultForLiveTurn(agent), undefined)
  agent.session.eventAt = eventAt
  next.finish('solver', 'Both reviews approved and both checks passed.')
  const mark = trackNow().last
  assert.equal(mark.done, true)
  assert.equal(mark.resultExchangeId, resultExchange)
  next.event('solver', 'turn/start', { turn: 5 })
  next.finish('solver', 'This request has already been delivered.')
  assert.deepEqual(trackNow().last, mark)
})

const codexCapture = JSON.parse(readFileSync(new URL(
  '../../acp-dsh/test/fixtures/permission-payloads/codex-acp-2.6.0.json', import.meta.url)))
const codexUpdates = codexCapture.cases.find(item => item.name === 'agent: write outside the workspace').updates
const codexExecute = codexUpdates.find(update => update.kind === 'execute')
const codexExit = codexUpdates.find(update => update._meta?.terminal_exit)

async function nativeMirror(t, h, provider = 'acp-codex') {
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() {}, section() {} })
  await ctx.plugin(ToolsService)
  await ctx.plugin(native)
  let agents
  await ctx.plugin({ name: 'solver-fixture-agents', inject: ['tools'], apply(child) { agents = child } })
  for (const listener of h.ctx.listeners.get('tools/execute')) ctx.on('tools/execute', listener)
  const agent = h.agentOf('solver')
  const cwd = h.rt.botOf('solver').workDir
  agent.session = Session.create(agent.id)
  agent.session.append('request/header', { header: { config: { provider, model: 'default' } } })
  const codex = provider === 'acp-codex'
  const name = codex ? 'Codex fixture' : 'Claude fixture'
  const scope = createScope(agents, agent)
  agent.ctx = scope.ctx
  const adapter = new AcpAdapter(ctx, new Map([[provider, { name }]]))
  adapter.registerMirror(agent)
  t.after(async () => { adapter.dispose(); await scope.dispose(); await ctx.fiber.dispose() })
  const signal = new AbortController().signal
  const resolve = () => ctx.tools.resolve({ agent, modelSelection: { provider, model: 'default' }, signal })

  async function mirror(runId, { command = "/bin/bash -lc 'fake check-a'", exit = 0, adjust, beforeExit, beforeMirror } = {}) {
    const opened = structuredClone(codexExecute)
    const finished = structuredClone(codexExit)
    opened.rawInput = { command, cwd }
    opened._meta.terminal_info.cwd = cwd
    finished._meta.terminal_exit.exit_code = exit
    if (exit !== 0) finished.status = 'failed'
    const exitSession = adjust?.(opened, finished)
    return mirrorUpdates(runId, opened, finished, { exitSession, beforeExit, beforeMirror })
  }

  async function mirrorUpdates(runId, opened, finished, { exitSession, beforeExit, beforeMirror } = {}) {
    const run = new AgentRun({ name, cwd })
    run.sessionId = 'native-session'
    await run.onUpdate(opened, run.sessionId)
    const tool = run.tools.get(opened.toolCallId)
    const args = callArguments(tool)
    await beforeExit?.()
    await run.onUpdate(finished, exitSession ?? run.sessionId)
    await beforeMirror?.()
    // The adapter's stream advertises this pairing when it ends a step at the mirror.
    assert.deepEqual(await run.next(signal), { type: 'tool', id: tool.id })
    const id = `acp-${runId}`
    adapter.live.set(agent.id, { run, name, native: true, calls: new Set([id]), toolIds: new Map([[id, tool.id]]) })
    const toolSet = await resolve()
    try {
      const batch = await ctx.tools.execute({ calls: [{ id, name: 'acp_tool', arguments: JSON.stringify(args) }], agent, signal, toolSet })
      return batch.results[0].result
    } finally {
      toolSet.dispose()
    }
  }
  return { cwd, mirror, mirrorUpdates }
}

async function nativeCheck(t, agreed = 'fake check-a', { legacyPlan, provider } = {}) {
  const h = await setup(t)
  const { request, send, delivered } = await reviewedPlan(h, ['check-a'], [{ check: 'check-a', command: agreed }], { legacyPlan })
  const { cwd, mirror } = await nativeMirror(t, h, provider)
  const report = (run, pass = true) => h.progress('checks', { request, run, results: results('check-a', pass) })
  const start = run => h.progress('start', { request, run, checks: ['check-a'] })
  const savedPending = () => JSON.parse(readFileSync(join(h.home, 'state.json'), 'utf8')).bots.solver.reviewTrack.solver.pending
  return { cwd, start, report, mirror, send, savedPending, bot: () => h.rt.botOf('solver'), host: h, delivered }
}

// Literal from the 5bb4badb6 investigation. Only the agreed directory is replaced
// in portable cases, because the mirror checks that it exists and never executes the command.
const stage6Directory = '/tmp/automagik-solver-combined-3-t422'
const stage6Agreed = 'cd /tmp/automagik-solver-combined-3-t422 && scripts/capped-run -- /bin/bash /tmp/automagik-2056-limits-auto-5bb4badb-git-scratch/check.sh'
const stage6CommandIn = directory => stage6Agreed.replace(stage6Directory, directory)
const checkDirectory = t => {
  const directory = mkdtempSync(join(tmpdir(), 'solver-agreed-cwd-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}
const claudeBashInput = JSON.parse(readFileSync(new URL(
  '../src/host/live-chat/fixtures/claude.jsonl', import.meta.url), 'utf8').split('\n')[3])
  .message.content.find(block => block.type === 'tool_use' && block.name === 'Bash').input

test('stage verdicts take a Claude native Solver through replan, admitted work and Done', async t => {
  const { h, request, review, track, openReply, deliveries } = await reviewReplyFixture(t)
  const { cwd, mirrorUpdates } = await nativeMirror(t, h, 'acp-claude')
  const headers = []
  const answer = async (kind, turn, text) => {
    const exchangeId = await review(kind)
    const input = h.agentOf('reviewer').message
    assert.equal(input.source.exchangeId, exchangeId)
    headers.push([kind.toUpperCase(), input.content.map(part => part.text).join('\n')])
    h.finish('solver', `Waiting for ${kind} review.`)
    h.event('reviewer', 'turn/start', { turn: turn - 1 })
    h.takeInput('reviewer', input)
    h.finish('reviewer', text)
    const reply = deliveries.at(-1)
    assert.equal(reply.message.replyTo, exchangeId)
    assert.ok(reply.message.reviewReceipt)
    await openReply(turn, reply)
    return exchangeId
  }
  const bash = id => {
    const toolCallId = `toolu_${id}`
    const command = 'cat average.mjs'
    const _meta = { claudeCode: { toolName: 'Bash' } }
    return mirrorUpdates(id, {
      sessionUpdate: 'tool_call', toolCallId, title: command, kind: 'execute', status: 'in_progress',
      rawInput: { ...claudeBashInput, command }, _meta,
    }, {
      sessionUpdate: 'tool_call_update', toolCallId, status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'export const average = xs => xs.reduce((a, b) => a + b, 0) / xs.length' } }], _meta,
    })
  }
  writeFileSync(join(cwd, 'average.mjs'), 'export const average = xs => xs.reduce((a, b) => a + b, 0) / xs.length\n')
  const held = await bash('before_plan')
  assert.equal(held.isError, true)
  assert.match(held.content[0].text, /review guard holds work/)

  const fix = await answer('plan', 3, 'PLAN FIX-FIRST\nUse the exact test path.')
  const first = structuredClone(track().solver.plan)
  assert.equal(first.review.exchangeId, fix)
  assert.match(await h.progress('replan', { request, run: 'replan-1' }), /^Recorded\./)
  const checks = [
    { check: 'average-test', command: 'node --test ./average.test.mjs' },
    { check: 'diff-check', command: 'git diff --check' },
  ]
  assert.match(await plan(h, request, checks.map(({ check }) => check), checks), /^Recorded\./)
  const ship = await answer('plan', 4, 'PLAN SHIP\nThe revised plan matches the request.')
  assert.notEqual(fix, ship)
  assert.equal(track().solver.plan.review.exchangeId, ship)
  const work = await bash('after_plan')
  assert.deepEqual({
    firstVerdict: first.review.verdict, firstAccepted: first.accepted,
    revisedVerdict: track().solver.plan.review.verdict, revisedAccepted: track().solver.plan.accepted,
    guardOpened: typeof track().planVerdictAt === 'number', advisory: track().verdicts.map(({ verdict }) => verdict),
    nativeWorkAdmitted: work.isError === false,
  }, {
    firstVerdict: 'FIX-FIRST', firstAccepted: false,
    revisedVerdict: 'SHIP', revisedAccepted: true,
    guardOpened: true, advisory: ['FIX-FIRST', 'SHIP'], nativeWorkAdmitted: true,
  }, 'the two bound PLAN verdicts are recorded and the Claude Bash mirror is admitted')
  assert.ok(track().firstWorkAt)

  // A Claude Bash completion carries text. Verify checks through the foreground tool
  // with an observed exit code, without attributing a terminal exit to the Claude update.
  for (const check of checks) {
    assert.match(await checked(h, request, check.check, check), /^Recorded\./)
  }
  assert.deepEqual(track().solver.passed, checks.map(({ check }) => check))
  const result = await answer('result', 5, 'RESULT SHIP\nBoth current checks pass.')
  const recorded = track().solver.review
  assert.equal(recorded.exchangeId, result)
  assert.equal(recorded.revision, track().solver.revision)
  assert.equal(recorded.verdict, 'SHIP')
  assert.equal(recorded.reviewer.id, 'reviewer')
  assert.notEqual(recorded.reviewer.model, recorded.solverModel)
  assert.deepEqual(track().verdicts.map(({ verdict }) => verdict), ['FIX-FIRST', 'SHIP', 'SHIP'])
  h.finish('solver', 'Delivered after independent result review.')
  assert.equal(track().last?.done, true)
  assert.equal(track().last.resultExchangeId, result)
  assert.equal(track().delivered, true)
  for (const [stage, header] of headers) {
    assert.match(header, new RegExp(`First line: exactly one of \`${stage} SHIP\`, \`${stage} FIX-FIRST\`, or \`${stage} BLOCKED\`\\.`))
  }
})

test('stage verdict parsers keep legacy forms and refuse wrong or unbound stages', () => {
  const parse = (text, stage) => [verdictOf(text, stage), guardVerdictOf(text, 'reviewer', stage)]
  for (const stage of ['plan', 'result']) {
    assert.deepEqual(parse('SHIP\nEvidence.', stage), ['SHIP', 'SHIP'])
    assert.deepEqual(parse('Verdict: FIX-FIRST\nEvidence.', stage), ['FIX-FIRST', 'FIX-FIRST'])
    assert.deepEqual(parse(`${stage.toUpperCase()} SHIP\nVerdict: BLOCKED`, stage), ['BLOCKED', 'SHIP'])
    for (const verdict of ['SHIP', 'FIX-FIRST', 'BLOCKED']) {
      const line = `${stage.toUpperCase()} ${verdict}`
      const other = stage === 'plan' ? 'result' : 'plan'
      assert.deepEqual(parse(`${line}\r\nVerdict: SHIP`, stage), [verdict, verdict])
      assert.deepEqual(parse(`${line}\nVerdict: SHIP`, other), [undefined, undefined])
      assert.deepEqual(parse(`${line}\nVerdict: SHIP`), [undefined, undefined])
    }
    for (const line of [`${stage.toUpperCase()}: SHIP`, `${stage.toUpperCase()}  SHIP`, `${stage.toUpperCase()} SHIP `, ` ${stage.toUpperCase()} SHIP`,
      `${stage.toUpperCase()} SHIP.`, `**${stage.toUpperCase()} SHIP**`, `${stage} SHIP`, `\n${stage.toUpperCase()} SHIP`]) {
      assert.deepEqual(parse(line, stage), [undefined, undefined], JSON.stringify(line))
    }
  }
})

test('stage verdict replies cannot borrow a later legacy label in the Solver host', async t => {
  const { h, request, review, track, openReply, deliveries } = await reviewReplyFixture(t)
  let turn = 2
  const answer = async (kind, text) => {
    const before = track().verdicts.map(({ verdict }) => verdict)
    const exchangeId = kind ? await review(kind) : undefined
    if (!kind) await h.tool('message_bot', { to: 'reviewer', message: 'Ordinary review.', reply_to: 'me', when: 'queue' })
    const input = h.agentOf('reviewer').message
    assert.equal(input.source.exchangeId, exchangeId ?? deliveries.at(-1).message.exchangeId)
    h.finish('solver', 'Waiting for the reviewer.')
    h.event('reviewer', 'turn/start', { turn })
    h.takeInput('reviewer', input)
    h.finish('reviewer', text)
    const reply = deliveries.at(-1)
    assert.equal(Boolean(reply.message.reviewReceipt), Boolean(kind))
    await openReply(++turn, reply)
    return before
  }
  const rejectStage = async (kind, firstLine) => {
    const before = await answer(kind, `${firstLine}\nVerdict: SHIP`)
    assert.deepEqual(track().verdicts.map(({ verdict }) => verdict), before, firstLine)
  }
  await rejectStage(undefined, 'PLAN SHIP')
  await rejectStage('plan', 'RESULT SHIP')
  assert.equal(track().solver.plan.review.verdict, 'unverified')
  assert.equal(track().planVerdictAt, undefined)
  await answer('plan', ' PLAN SHIP\nThe leading space survives verdict parsing.')
  assert.equal(track().solver.plan.review.verdict, 'unverified')
  await answer('plan', 'PLAN SHIP\nVerdict: FIX-FIRST')
  assert.equal(track().solver.plan.review.verdict, 'FIX-FIRST')
  assert.equal(track().solver.plan.accepted, false)
  await answer('plan', 'SHIP\nLegacy approval.')
  assert.equal(track().solver.plan.accepted, true)
  assert.match(await checked(h, request, 'test', { check: 'average-test', command: 'node --test average.test.mjs' }), /^Recorded\./)
  assert.match(await checked(h, request, 'diff', { check: 'diff-check', command: 'git diff --check' }), /^Recorded\./)
  await rejectStage(undefined, 'RESULT SHIP')
  await rejectStage('result', 'PLAN SHIP')
  assert.equal(track().solver.review.verdict, 'unverified')
  await answer('result', 'RESULT SHIP ')
  assert.equal(track().solver.review.verdict, 'unverified')
  await answer('result', 'RESULT SHIP\nVerdict: BLOCKED')
  assert.equal(track().solver.review.verdict, 'BLOCKED')
  h.finish('solver', 'The result review is unverified.')
  assert.equal(track().last?.done, undefined)
})

test('stage verdict correction: a stopped joined request receives a notice without approval', async t => {
  const { h, review, track, deliveries } = await reviewReplyFixture(t)
  h.event('reviewer', 'turn/start', { turn: 1 })
  h.person('Unrelated work.', 'reviewer')
  const exchange = await review('plan')
  h.finish('solver', 'Waiting for review.')
  h.takeInput('reviewer', h.agentOf('reviewer').message)
  assert.equal(h.rt.live.get('reviewer').joined[0].info.exchangeId, exchange)
  h.event('reviewer', 'assistant/message', { message: { content: content('PLAN SHIP') } })
  h.event('reviewer', 'turn/end', { reason: { kind: 'aborted', reason: { kind: 'user' } } })
  const { message, sent } = deliveries.at(-1)
  assert.equal(await sent, message.exchangeId)
  const input = h.agentOf('solver').message
  assert.equal(input.source.replyTo, exchange)
  assert.ok(input.source.reviewReceipt)
  assert.match(input.content[0].text, /reviewer was stopped before it could answer your message\.$/)
  assert.doesNotMatch(input.content[0].text, /PLAN SHIP/)
  assert.equal(h.rt.state.works[exchange], undefined)
  assert.deepEqual({ accepted: track().solver.plan.accepted, review: track().solver.plan.review.verdict,
    strict: track().planVerdictAt, marks: track().verdicts }, {
    accepted: false, review: 'unverified', strict: undefined, marks: [],
  })
})

const reviewSteerCut = { kind: 'aborted', reason: { kind: 'hook', reason: STEER_CUT } }
const heldReviewer = { provider: 'acp-claude', model: 'sonnet' }
const heldReviewerIdentity = 'acp-claude/claude-sonnet-5-5'

async function heldReviewReply(t, heldText, {
  kind = 'plan', missingHeldRoute = false, displayText = heldText.trim(), childText = 'The fixture is present.', writtenRetry = false,
} = {}) {
  const { h, request, review, track, openReply, deliveries } = await reviewReplyFixture(t)
  if (kind === 'result') {
    await review('plan')
    h.finish('solver', 'Waiting for plan review.')
    h.event('reviewer', 'turn/start', { turn: 1 })
    h.takeInput('reviewer', h.agentOf('reviewer').message)
    h.finish('reviewer', 'SHIP')
    await openReply(3, deliveries.at(-1))
    assert.match(await checked(h, request, 'test', { check: 'average-test', command: 'node --test average.test.mjs' }), /^Recorded\./)
    assert.match(await checked(h, request, 'diff', { check: 'diff-check', command: 'git diff --check' }), /^Recorded\./)
  }
  if (kind === 'result') {
    h.agentOf('reviewer').session.requestHeader = () => missingHeldRoute ? undefined : { config: heldReviewer }
  }
  const exchange = await review(kind)
  h.finish('solver', 'Waiting for review.')
  let turn = 2
  h.event('reviewer', 'turn/start', { turn })
  h.takeInput('reviewer', h.agentOf('reviewer').message)
  if (writtenRetry) {
    h.finish('reviewer', '<tool_call><function=read>')
    assert.equal(await deliveries.at(-1).sent, exchange)
    const retry = h.agentOf('reviewer').message
    assert.equal(retry.source.retried, true)
    assert.equal(retry.source.exchangeId, exchange)
    assert.match(retry.content[0].text, /wrote a tool call as plain text/)
    h.event('reviewer', 'turn/start', { turn: ++turn })
    h.takeInput('reviewer', retry)
  }
  await h.tool('message_bot', { to: 'other', message: 'Check the fixture.', reply_to: 'me', when: 'queue' }, 'reviewer')
  assert.equal(h.rt.waitsWork(exchange), true)
  h.finish('reviewer', heldText)
  // The silent turn uses a different route, equal to the Solver's.
  h.agentOf('reviewer').session.requestHeader = () => ({ config: solverModel })
  assert.equal(h.rt.state.works[exchange].held, displayText)
  h.event('other', 'turn/start', { turn: 1 })
  h.takeInput('other', h.agentOf('other').message)
  h.finish('other', childText)
  await deliveries.at(-1).sent
  const child = h.agentOf('reviewer').message
  assert.equal(child.source.work, exchange)
  h.event('reviewer', 'turn/start', { turn: turn + 1 })
  h.takeInput('reviewer', child)
  assert.equal(h.rt.waitsWork(exchange), false)
  return { h, child, exchange, track, deliveries, openReply }
}

function assertHeldDelivery(input, exchange, heldText) {
  assert.equal(input.source.replyTo, exchange)
  assert.ok(input.source.reviewReceipt)
  assert.ok(input.content[0].text.includes(`${heldText.trim()}\n\n[Handed back to reviewer for this work]\n\nother:\nThe fixture is present.`))
}

function assertHeldPlanVerdict(track, expected) {
  assert.deepEqual({ accepted: track.solver.plan.accepted, review: track.solver.plan.review.verdict,
    strict: typeof track.planVerdictAt === 'number', marks: track.verdicts.map(({ verdict }) => verdict) }, expected)
}

const heldPlanApproved = { accepted: true, review: 'SHIP', strict: true, marks: ['SHIP'] }
const heldPlanUnverified = { accepted: false, review: 'unverified', strict: false, marks: [] }

test('stage verdict correction: a silent continuation uses the held reviewer first line', async t => {
  for (const [heldText, expected, steer, response = ''] of [
    ['PLAN SHIP', heldPlanApproved],
    ['RESULT SHIP\nVerdict: SHIP', heldPlanUnverified, true],
    [' PLAN SHIP', heldPlanUnverified],
    ['PLAN SHIP\nVerdict: FIX-FIRST', { accepted: false, review: 'FIX-FIRST', strict: true, marks: ['FIX-FIRST'] }],
    ['PLAN SHIP', heldPlanUnverified, false, 'RESULT SHIP\nVerdict: SHIP'],
  ]) {
    const { h, exchange, track, deliveries } = await heldReviewReply(t, heldText)
    if (steer) {
      h.rt.markSteerCut('reviewer')
      h.event('reviewer', 'assistant/message', { message: { content: content('PLAN SHIP') } })
      h.event('reviewer', 'turn/end', { reason: reviewSteerCut })
      h.event('reviewer', 'turn/start', { turn: 4 })
      h.person('Finish the review.', 'reviewer')
    }
    h.finish('reviewer', response)
    const { message, sent } = deliveries.at(-1)
    assert.equal(await sent, message.exchangeId)
    assert.equal(h.rt.state.works[exchange], undefined)
    assertHeldDelivery(h.agentOf('solver').message, exchange, response || heldText)
    assertHeldPlanVerdict(track(), expected)
    await h.close()
  }
  const result = 'RESULT SHIP\nVerdict: SHIP'
  for (const [missingHeldRoute, expected] of [[true, 'unverified'], [false, 'SHIP']]) {
    const { h, exchange, track, deliveries } = await heldReviewReply(t, result, { kind: 'result', missingHeldRoute })
    h.finish('reviewer', '')
    const { message, sent } = deliveries.at(-1)
    assert.equal(await sent, message.exchangeId)
    const input = h.agentOf('solver').message
    assertHeldDelivery(input, exchange, result)
    const review = track().solver.review
    assert.equal(review.verdict, expected, 'RESULT uses the route of the turn that wrote the held reply')
    assert.equal(review.reviewer?.model, expected === 'SHIP' ? heldReviewerIdentity : undefined)
    assert.equal(review.unverified, expected === 'SHIP' ? undefined : 'model')
    assert.equal(modelWarningCount(input), expected === 'SHIP' ? 0 : 1)
    await h.close()
  }
})

test('stage verdict exception: a held RESULT veto beyond the display cap withholds Done', async t => {
  const reply = readFileSync(new URL('./fixtures/held-result-2329.txt', import.meta.url), 'utf8')
  const displayText = reply.slice(0, 2000)
  const { h, exchange, track, deliveries, openReply } = await heldReviewReply(t, reply, {
    kind: 'result', displayText,
  })
  h.finish('reviewer', '')
  await openReply(4, deliveries.at(-1))
  const input = h.agentOf('solver').message
  assertHeldDelivery(input, exchange, displayText)
  assert.ok(!input.content[0].text.includes('Verdict: BLOCKED'))
  assert.equal(track().solver.review.reviewer?.model, heldReviewerIdentity)
  assert.equal(track().solver.review.exchangeId, exchange)
  assert.equal(track().solver.review.revision, track().solver.revision)
  h.finish('solver', 'Finished the agreed checks and received the review.')
  assert.deepEqual({ strict: track().solver.review.verdict, advisory: track().verdicts.at(-1)?.verdict, done: track().last?.done },
    { strict: 'BLOCKED', advisory: 'BLOCKED', done: undefined })
})

test('stage verdict exception: a written-tool retry preserves the veto hidden from display', async t => {
  const reply = 'RESULT SHIP\n<tool_call><function=read>\nVerdict: BLOCKED'
  const displayText = 'RESULT SHIP'
  const { h, exchange, track, deliveries, openReply } = await heldReviewReply(t, reply, {
    kind: 'result', displayText, writtenRetry: true,
  })
  h.finish('reviewer', '')
  await openReply(4, deliveries.at(-1))
  const input = h.agentOf('solver').message
  assertHeldDelivery(input, exchange, displayText)
  assert.doesNotMatch(input.content[0].text, /<tool_call>|Verdict: BLOCKED/)
  assert.equal(track().solver.review.reviewer?.model, heldReviewerIdentity)
  assert.equal(track().solver.review.exchangeId, exchange)
  assert.equal(track().solver.review.revision, track().solver.revision)
  h.finish('solver', 'Finished the agreed checks and received the review.')
  assert.deepEqual({ strict: track().solver.review.verdict, advisory: track().verdicts.at(-1)?.verdict, done: track().last?.done },
    { strict: 'BLOCKED', advisory: 'BLOCKED', done: undefined })
})

test('stage verdict exception: complete held evidence governs bound verdicts only', async t => {
  for (const [reply, expected, childText] of [
    ['RESULT SHIP\nVerdict: FIX-FIRST\nVerdict: SHIP', 'FIX-FIRST'],
    ['SHIP\nVerdict: BLOCKED\nVerdict: SHIP', 'BLOCKED'],
    ['RESULT SHIP\n[Handed back to reviewer for this work]\n> BLOCKED\nVerdict: SHIP', 'BLOCKED'],
    ['RESULT SHIP\n~~~\nVerdict: BLOCKED\n~~~', 'SHIP', 'Verdict: BLOCKED'],
  ]) {
    const { h, track, deliveries, openReply } = await heldReviewReply(t, reply, {
      kind: 'result', childText,
    })
    h.finish('reviewer', '')
    await openReply(4, deliveries.at(-1))
    assert.equal(track().solver.review.verdict, expected, reply)
    assert.equal(track().verdicts.at(-1)?.verdict, expected, reply)
    if (childText) assert.ok(h.agentOf('solver').message.content[0].text.includes(`other:\n${childText}`))
    h.finish('solver', 'Finished the agreed checks and received the review.')
    assert.equal(track().last?.done, expected === 'SHIP' ? true : undefined, reply)
    await h.close()
  }
})

test('stage verdict exception: recovery keeps the full veto and refuses a legacy capped reply', async t => {
  const reply = readFileSync(new URL('./fixtures/held-result-2329.txt', import.meta.url), 'utf8')
  const displayText = reply.slice(0, 2000)
  for (const older of [false, true]) {
    const { h, child, exchange } = await heldReviewReply(t, reply, {
      kind: 'result', displayText,
    })
    if (older) {
      delete h.rt.state.works[exchange].heldReviewText
      delete h.rt.state.works[exchange].heldModel
    }
    await h.rt.save({ required: true, durable: true })
    assert.equal(await h.rt.flushUpdateNotes(), true)
    const state = JSON.parse(readFileSync(join(h.home, 'state.json'), 'utf8'))
    assert.equal(state.works[exchange].heldReviewText, older ? undefined : reply)
    await h.close()
    const end = { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } }
    const next = fixture(t, h.home, { configure(ctx) {
      ctx.sessionController.inspect = async id => ({ events: id === 'reviewer'
        ? [{ type: 'turn/start', data: { turn: 3 } }, { type: 'user/message', data: child }, end] : [] })
    } })
    await next.rt.load()
    next.event('reviewer', end.type, end.data)
    const keepAlive = setInterval(() => {}, 1000)
    try { await next.rt.resumesDone } finally { clearInterval(keepAlive) }
    const solver = next.agentOf('solver')
    await until(() => solver.message?.source.replyTo === exchange)
    assertHeldDelivery(solver.message, exchange, displayText)
    const track = next.rt.botOf('solver').reviewTrack
    assert.equal(track.solver.review.verdict, older ? 'unverified' : 'BLOCKED')
    assert.equal(track.verdicts.at(-1)?.verdict, older ? 'SHIP' : 'BLOCKED')
    assert.equal(track.solver.review.reviewer?.model, older ? undefined : heldReviewerIdentity)
    await next.close()
  }
})

test('stage verdict correction: recovery uses the held line for the reply reconciled from the log', async t => {
  for (const [heldText, expected, { steer, older, recorded, legacy, kind = 'plan' } = {}] of [
    ['RESULT SHIP\nVerdict: SHIP', heldPlanUnverified, { steer: true }],
    ['PLAN SHIP', heldPlanApproved],
    ['PLAN SHIP\nVerdict: SHIP', heldPlanUnverified, { older: true }],
    ['Verdict: SHIP', heldPlanApproved, { older: true }],
    ['RESULT SHIP', 'SHIP', { kind: 'result' }],
    ['RESULT SHIP', 'SHIP', { kind: 'result', legacy: true }],
    ['Waiting for evidence.', 'SHIP', { kind: 'result', recorded: true }],
  ]) {
    const { h, child, exchange } = await heldReviewReply(t, heldText, { kind })
    if (older) delete h.rt.state.works[exchange].heldFirstLine
    const progress = h.rt.botOf('solver').reviewTrack.solver
    const workAt = h.rt.state.works[exchange].at
    if (legacy) progress.review.solverModel = solverModel.model
    const context = route => ({ type: 'request/context', data: route })
    const recordedRoute = { provider: 'acp-omp', model: 'default' }
    const solverLog = legacy ? [
      { type: 'turn/start', data: { turn: 3 } },
      context(solverModel),
      { type: 'tool/call', time: workAt, data: { name: 'mcp__dsh__message_bot',
        arguments: JSON.stringify({ solver_review: 'result', solver_request: progress.request }) } },
      { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } },
      { type: 'turn/start', data: { turn: 4 } },
      context({ provider: 'acp-omp', model: 'default' }),
    ] : []
    // Omni closes while the reviewer's continuation is running. Only DSH sees it finish.
    const end = { type: 'turn/end', data: { turn: steer ? 4 : 3, reason: { kind: 'completed' } } }
    const log = [{ type: 'turn/start', data: { turn: 3 } }, { type: 'user/message', data: child },
      context(recorded ? recordedRoute : solverModel)]
    if (recorded) log.push({ type: 'assistant/message', data: { message: { content: content('RESULT SHIP') } } })
    if (steer) log.push({ type: 'step/start' },
      { type: 'assistant/message', data: { message: { content: content('PLAN SHIP') } } },
      { type: 'turn/end', data: { turn: 3, reason: reviewSteerCut } }, { type: 'turn/start', data: { turn: 4 } })
    log.push(end, { type: 'turn/start', data: { turn: 5 } }, context(solverModel))
    await h.rt.save({ required: true, durable: true })
    assert.equal(await h.rt.flushUpdateNotes(), true)
    const state = JSON.parse(readFileSync(join(h.home, 'state.json'), 'utf8'))
    const notes = JSON.parse(readFileSync(join(h.home, 'inflight.json'), 'utf8'))
    assert.equal(state.works[exchange].held, heldText)
    if (kind === 'result') assert.equal(state.works[exchange].heldModel, heldReviewerIdentity)
    assert.equal(notes.turns.reviewer.trigger.exchangeId, child.source.exchangeId)
    await h.close()
    const inspected = []
    const next = fixture(t, h.home, { configure(ctx) {
      ctx.sessionController.inspect = async id => {
        inspected.push(id)
        return { events: id === 'reviewer' ? log : solverLog }
      }
    } })
    await next.rt.load()
    next.event('reviewer', end.type, end.data)
    const keepAlive = setInterval(() => {}, 1000)
    try { await next.rt.resumesDone } finally { clearInterval(keepAlive) }
    assert.ok(inspected.includes('reviewer'))
    const solver = next.agentOf('solver')
    await until(() => solver.message?.source.replyTo === exchange)
    assert.equal(next.rt.state.works[exchange], undefined)
    assertHeldDelivery(solver.message, exchange, recorded ? 'RESULT SHIP' : heldText)
    const track = next.rt.botOf('solver').reviewTrack
    if (kind === 'plan') {
      assertHeldPlanVerdict(track, expected)
    } else {
      assert.equal(track.solver.review.verdict, expected)
      assert.equal(track.solver.review.solverModel, refOf(solverModel))
      assert.equal(track.solver.review.reviewer?.model, recorded ? refOf(recordedRoute) : heldReviewerIdentity)
      assert.equal(track.solver.review.receipt, solver.message.source.reviewReceipt)
      assert.equal(modelWarningCount(solver.message), 0)
      next.event('solver', 'turn/start', { turn: 6 })
      next.takeInput('solver', solver.message)
      next.finish('solver', 'Delivered after recovering RESULT.')
      assert.equal(next.rt.botOf('solver').reviewTrack.last?.done, true)
    }
    await next.close()
  }
})

test('Ruling B records the agreed outside check in Codex, Claude and zsh literal forms', async t => {
  const agreed = stage6CommandIn(checkDirectory(t))
  const codex = await nativeCheck(t, agreed)
  const variants = [
    ['codex-bare', agreed],
    ['codex-wrapped', `/bin/bash -lc '${agreed}'`],
    ['zsh-bare', `zsh -lc '${agreed}'`],
    ['zsh-bin', `/bin/zsh -lc "${agreed}"`],
    ['zsh-usr-bin', `/usr/bin/zsh -lc '${agreed}'`],
  ]
  for (const [run, command] of variants) {
    const held = await codex.mirror(`before-${run}`, { command })
    assert.equal(held.isError, true, run)
    assert.match(held.content[0].text, /Start a check run/)
    assert.match(await codex.start(run), /^Recorded\./)
    assert.equal((await codex.mirror(run, { command })).isError, false)
    assert.match(await codex.report(run), /^Recorded\./)
    assert.deepEqual(codex.bot().reviewTrack.solver.passed, ['check-a'])
  }

  const claude = await nativeCheck(t, agreed, { provider: 'acp-claude' })
  const adjust = opened => { opened.rawInput = { ...claudeBashInput, command: agreed } }
  assert.match(await claude.start('claude-bare'), /^Recorded\./)
  assert.equal((await claude.mirror('claude-bare', { adjust })).isError, false)
  assert.match(await claude.report('claude-bare'), /^Recorded\./)
  assert.deepEqual(claude.bot().reviewTrack.solver.passed, ['check-a'])

  const wrappedPlan = `/usr/bin/zsh -lc 'cd .. && fake check-a'`
  const wrapped = await nativeCheck(t, wrappedPlan)
  const absolute = `cd '${dirname(wrapped.cwd)}' && fake check-a`
  assert.equal((await wrapped.mirror('relative-before-start', { command: absolute })).isError, true)
  assert.match(await wrapped.start('relative-agreement'), /^Recorded\./)
  await wrapped.mirror('relative-agreement', { command: absolute })
  assert.match(await wrapped.report('relative-agreement'), /^Recorded\./)

  const request = await requestOf(wrapped.host)
  await assert.rejects(wrapped.host.execute('bash', { command: wrappedPlan }), /Start a check run/)
  assert.match(await checked(wrapped.host, request, 'dsh-exact', { command: wrappedPlan }), /^Recorded\./)
})

test('Ruling B refuses ambiguous plans and native outcomes outside the exact agreement', async t => {
  const directory = checkDirectory(t)
  const agreed = stage6CommandIn(directory)
  const bare = agreed.split(' && ')[1]
  const ambiguous = [
    ['chain', `${agreed} && true`],
    ['pipe', `${agreed} | cat`],
    ['redirect', `${agreed} > result.txt`],
    ['second-cd', `cd ${directory} && cd . && ${bare}`],
    ['nested', `zsh -lc "bash -lc '${agreed}'"`],
    ['wrapper-args', `bash -lc '${agreed}' extra`],
    ['malformed', `zsh -lc '${agreed}`],
    ['cdpath', `cd relative && ${bare}`],
  ]
  const host = await setup(t)
  const request = await requestOf(host)
  for (const [run, command] of ambiguous) {
    assert.match(await plan(host, request, ['check-a'], [{ check: 'check-a', command }]), /ambiguous|CDPATH/i, run)
    assert.equal(host.rt.botOf('solver').reviewTrack.solver.plan, undefined)
  }

  const h = await nativeCheck(t, agreed)
  const wrong = [
    ...ambiguous,
    ['extra-argument', `${agreed} extra`],
    ['different-cd', stage6CommandIn(checkDirectory(t))],
    ['no-cd', bare, opened => {
      opened.rawInput.cwd = directory
      opened._meta.terminal_info.cwd = directory
    }],
    ['missing-cwd', agreed, opened => {
      delete opened.rawInput.cwd
      delete opened._meta.terminal_info.cwd
    }],
    ['conflicting-cwd', agreed, opened => { opened.rawInput.cwd = directory }],
  ]
  for (const [run, command, adjust] of wrong) {
    assert.match(await h.start(run), /^Recorded\./)
    await h.mirror(run, { command, adjust })
    assert.match(await h.report(run), /^No verified passing evidence/, run)
    assert.deepEqual(h.bot().reviewTrack.solver.passed, [])
  }
  rmSync(directory, { recursive: true })
  assert.match(await h.start('missing-directory'), /^Recorded\./)
  await h.mirror('missing-directory', { command: agreed })
  assert.match(await h.report('missing-directory'), /no verified passing evidence.*working directory/i)
  await assert.rejects(h.send('result'), /every agreed check/)
})

test('Ruling B round 2 requires literal shell arguments in plans and native evidence', async t => {
  const invalid = [
    `bash '-c' 'fake check-a'`,
    `zsh -l"c" 'fake check-a'`,
    String.raw`/bin/sh -\c 'fake check-a'`,
    `bash -o pipefail "-c" 'fake check-a'`,
    `fish '--command=fake check-a'`,
    'fake check-a *.mjs',
    'fake check-a file?.mjs src/[ab].mjs',
    'fake check-a {one,two} ~/tests',
    'fake check-a # ignored',
  ]
  const accepted = []
  for (const command of invalid) {
    const host = await setup(t)
    const reply = await plan(host, await requestOf(host), ['check-a'], [{ check: 'check-a', command }])
    if (!/Cannot register check "check-a"\. The command boundaries are ambiguous\./.test(reply)) {
      accepted.push({ stage: 'plan', command, reply })
    }
  }

  for (const command of [invalid[0], invalid[5]]) {
    const legacy = await nativeCheck(t, command, { legacyPlan: true })
    const held = await legacy.mirror('legacy-before-start', { command })
    assert.equal(held.isError, true)
    assert.match(held.content[0].text, /Start a check run/)
    const wrapped = `/bin/bash -lc "${command}"`
    assert.match(await legacy.start('legacy-outcome'), /^Recorded\./)
    assert.equal((await legacy.mirror('legacy-outcome', { command: wrapped })).isError, false)
    const reply = await legacy.report('legacy-outcome')
    if (!/^No verified passing evidence.*command boundaries are ambiguous/.test(reply)) {
      accepted.push({ stage: 'legacy outcome', command, reply })
    }
  }

  const literal = String.raw`fake check-a "*.mjs; ? [ab]" escaped\ space \*`
  const h = await nativeCheck(t, literal)
  const wrapped = `/bin/zsh -lc '${literal}'`
  const held = await h.mirror('quoted-before-start', { command: wrapped })
  assert.equal(held.isError, true)
  assert.match(held.content[0].text, /Start a check run/)
  assert.match(await h.start('changed-quoting'), /^Recorded\./)
  await h.mirror('changed-quoting', { command: literal.replace('"*.mjs; ? [ab]"', "'*.mjs; ? [ab]'") })
  assert.match(await h.report('changed-quoting'), /observed command does not match one agreed check/)
  assert.match(await h.start('quoted'), /^Recorded\./)
  assert.equal((await h.mirror('quoted', { command: wrapped })).isError, false)
  assert.match(await h.report('quoted'), /^Recorded\./)
  assert.deepEqual(h.bot().reviewTrack.solver.passed, ['check-a'])

  assert.deepEqual(accepted, [])
})

test('Done rule preserves a trailing nonbreaking space in the agreed check argument', async t => {
  const command = 'fake check-a\u00a0'
  const h = await nativeCheck(t, command)
  assert.equal(h.bot().reviewTrack.solver.plan.commands['check-a'], command)

  assert.match(await h.start('changed-argument'), /^Recorded\./)
  assert.equal((await h.mirror('changed-argument', { command: 'fake check-a' })).isError, false)
  assert.match(await h.report('changed-argument'), /observed command does not match one agreed check/)
  assert.deepEqual(h.bot().reviewTrack.solver.passed, [])

  assert.match(await h.start('agreed-argument'), /^Recorded\./)
  assert.equal((await h.mirror('agreed-argument', { command })).isError, false)
  assert.match(await h.report('agreed-argument'), /^Recorded\./)
  assert.deepEqual(h.bot().reviewTrack.solver.passed, ['check-a'])
})

test('Ruling B round 2 requires an initial native directory with an absolute agreed target', async t => {
  const agreed = stage6CommandIn(checkDirectory(t))
  const h = await nativeCheck(t, agreed)
  const file = join(checkDirectory(t), 'starting-cwd')
  writeFileSync(file, 'A file cannot be the shell working directory.\n')
  assert.match(await h.start('file-cwd'), /^Recorded\./)
  const result = await h.mirror('file-cwd', { command: agreed, adjust: opened => {
    opened.rawInput.cwd = file
    opened._meta.terminal_info.cwd = file
  } })
  assert.equal(result.isError, false)
  assert.match(await h.report('file-cwd'), /No verified passing evidence.*working directory could not be verified as the agreed directory/)
  assert.deepEqual(h.bot().reviewTrack.solver.passed, [])
})

test('MISSING_PASS records the Codex ACP check on the original result', async t => {
  const h = await nativeCheck(t)
  assert.match(await h.start('unchanged'), /Recorded/)
  const result = await h.mirror('unchanged', { command: "/bin/bash -lc 'cd . && fake check-a'" })
  assert.equal(result.isError, false)
  assert.match(await h.report('unchanged'), /Recorded/)
  assert.deepEqual(result.value.terminalOutcome, {
    sessionId: 'solver', callId: 'acp-unchanged', toolCallId: codexExecute.toolCallId,
    terminalId: codexExecute._meta.terminal_info.terminal_id, cwd: h.cwd, exitCode: 0,
  })
  assert.deepEqual(h.bot().reviewTrack.solver.passed, ['check-a'])
  assert.equal(h.bot().reviewTrack.solver.review, undefined)
  await h.send('result')
  const denied = await h.mirror('without-start')
  assert.equal(denied.isError, true)
  assert.match(denied.content[0].text, /Start a check run/)

  assert.match(await h.start('changed'), /Recorded/)
  const { startSnapshot, revision } = h.savedPending()
  assert.match(startSnapshot, /^[a-f0-9]{64}$/)
  const changed = await h.mirror('changed', { beforeMirror: async () => {
    writeFileSync(join(h.cwd, 'result'), 'changed before the mirror')
    assert.match(await h.start('changed'), /already open/)
  } })
  assert.equal(changed.isError, false)
  assert.equal(h.savedPending().startSnapshot, startSnapshot)
  assert.equal(h.savedPending().revision, revision)
  assert.match(await h.report('changed'), /no verified passing evidence.*changed/i)
  await assert.rejects(h.send('result'), /every agreed check/)

  assert.match(await h.start('nonzero'), /Recorded/)
  assert.equal((await h.mirror('nonzero', { exit: 1 })).isError, false)
  assert.match(await h.report('nonzero'), /contradicts.*outcome/i)
  assert.match(await h.report('nonzero', false), /Recorded/)
  await assert.rejects(h.send('result'), /every agreed check/)

  assert.match(await h.start('changed-before-report'), /Recorded/)
  await h.mirror('changed-before-report', { adjust: opened => {
    opened.rawInput = { cmd: 'fake check-a', cwd: h.cwd }
  } })
  writeFileSync(join(h.cwd, 'result'), 'changed after the mirror')
  assert.match(await h.report('changed-before-report'), /changed between the outcome and the report/i)
})

test('MISSING_PASS withholds ACP evidence for an ambiguous shell unwrap', async t => {
  const h = await nativeCheck(t)
  assert.match(await h.start('ambiguous'), /Recorded/)
  const result = await h.mirror('ambiguous', { command: "/bin/bash -lc 'fake check-a' && true" })
  assert.equal(result.isError, false)
  assert.match(await h.report('ambiguous'), /no verified passing evidence.*ambiguous/i)
  assert.match(await h.start('outside'), /Recorded/)
  await h.mirror('outside', { command: 'cd .. && fake check-a' })
  assert.match(await h.report('outside'), /no verified passing evidence.*working directory/i)
  await assert.rejects(h.send('result'), /every agreed check/)
})

test('MISSING_PASS explains why a completed ACP card without trusted exit data cannot pass', async t => {
  const h = await nativeCheck(t)
  assert.match(await h.start('missing-exit'), /Recorded/)
  const result = await h.mirror('missing-exit', { adjust: (_opened, finished) => { delete finished._meta.terminal_exit } })
  assert.equal(result.isError, false)
  assert.equal(result.value.status, 'completed')
  assert.match(await h.report('missing-exit'), /no verified passing evidence.*exit.*missing/i)
  assert.match(await h.report('missing-exit'), /exit.*missing/i)
  for (const [run, adjust, reason] of [
    ['wrong-terminal', (_opened, finished) => { finished._meta.terminal_exit.terminal_id = 'other-terminal' }, /exit does not match/i],
    ['wrong-tool', (_opened, finished) => { finished.toolCallId = 'other-tool' }, /exit.*missing/i],
    ['wrong-session', () => 'other-session', /exit.*missing/i],
    ['interrupted', (_opened, finished) => { finished._meta.terminal_exit.signal = 'SIGTERM' }, /execution was interrupted/i],
  ]) {
    assert.match(await h.start(run), /Recorded/)
    await h.mirror(run, { adjust })
    assert.match(await h.report(run), reason)
  }
  await assert.rejects(h.send('result'), /every agreed check/)
})

test('MISSING_PASS r2 refuses an ACP check started before its Solver run', async t => {
  const h = await nativeCheck(t)
  const resultPath = join(h.cwd, 'result')
  for (const [run, boundary] of [['completed-early', 'beforeMirror'], ['started-early', 'beforeExit']]) {
    writeFileSync(resultPath, 'result at native start')
    const result = await h.mirror(run, { [boundary]: async () => {
      writeFileSync(resultPath, 'different result at Solver start')
      assert.match(await h.start(run), /Recorded/)
      assert.match(await h.start(run), /already open/)
    } })
    assert.equal(result.isError, false)
    assert.match(await h.report(run), /no verified passing evidence.*native execution started before/i)
    assert.deepEqual(h.bot().reviewTrack.solver.passed, [])
  }
  assert.match(await h.start('completion-only'), /Recorded/)
  await h.mirror('completion-only', { adjust: opened => {
    opened.status = 'pending'
    opened.rawInput.startedAt = Date.now()
  } })
  assert.match(await h.report('completion-only'), /no verified passing evidence.*native execution start.*missing/i)
  await assert.rejects(h.send('result'), /every agreed check/)
})

test('MISSING_PASS r2 requires a CDPATH-independent directory with only initial cwd', async t => {
  const h = await nativeCheck(t)
  const child = join(h.cwd, 'check-dir')
  mkdirSync(child)
  assert.match(await h.start('cdpath'), /Recorded/)
  assert.equal((await h.mirror('cdpath', { command: "/bin/bash -lc 'cd check-dir && fake check-a'" })).isError, false)
  assert.match(await h.report('cdpath'), /no verified passing evidence.*CDPATH/i)
  assert.deepEqual(h.bot().reviewTrack.solver.passed, [])
  for (const [run, operand] of [['explicit-relative', './check-dir'], ['absolute', child]]) {
    assert.match(await h.start(run), /Recorded/)
    await h.mirror(run, { command: `cd '${operand}' && fake check-a` })
    assert.match(await h.report(run), /Recorded/)
  }
})

test('MISSING_PASS r2 holds exact ACP commands before start', async t => {
  for (const [kind, command] of [['pipeline', 'fake check-a | cat'], ['wrapper', "/bin/bash -lc 'fake check-a'"]]) {
    await t.test(kind, async sub => {
      const h = await nativeCheck(sub, command, { legacyPlan: kind === 'pipeline' })
      const result = await h.mirror('without-start', { command: `  ${command}  ` })
      assert.equal(result.isError, true)
      assert.match(result.content[0].text, /Start a check run/)
      if (kind === 'pipeline') {
        assert.match(await h.start('with-start'), /Recorded/)
        await h.mirror('with-start', { command })
        assert.match(await h.report('with-start'), /no verified passing evidence.*ambiguous/i)
      }
    })
  }
})

test('Stage 6 result-changed records a native check after transient root churn', async t => {
  const h = await nativeCheck(t)
  const placeholder = join(h.cwd, 'sandbox-placeholder')
  // Guarantee that the temporary entry advances the root's mtime even on fast runs.
  utimesSync(h.cwd, 1, 1)
  assert.match(await h.start('root-churn'), /Recorded/)
  const result = await h.mirror('root-churn', { beforeExit: () => {
    writeFileSync(placeholder, '')
    rmSync(placeholder)
  } })
  assert.equal(result.isError, false)
  assert.match(await h.report('root-churn'), /Recorded/)
})

test('Stage 6 result-changed refuses a native check after a result file edit', async t => {
  const h = await nativeCheck(t)
  const file = join(h.cwd, 'result')
  writeFileSync(file, 'original result')
  assert.match(await h.start('file-edit'), /Recorded/)
  const result = await h.mirror('file-edit', { beforeExit: () => {
    writeFileSync(file, 'changed result file')
  } })
  assert.equal(result.isError, false)
  assert.match(await h.report('file-edit'), /no verified passing evidence.*result changed between the start and the outcome/i)
  assert.deepEqual(h.bot().reviewTrack.solver.passed, [])
})

test('Stage 6 full chain keeps native check and review evidence through unchanged commands and delivery', async t => {
  const churn = cwd => () => {
    const placeholder = join(cwd, '.codex')
    writeFileSync(placeholder, '')
    rmSync(placeholder)
  }
  const pass = async fixture => {
    writeFileSync(join(fixture.cwd, 'average.mjs'), 'fixed')
    assert.match(await fixture.start('pass-a'), /^Recorded\./)
    assert.equal((await fixture.mirror('pass-a', { beforeExit: churn(fixture.cwd) })).isError, false)
    assert.match(await fixture.report('pass-a'), /^Recorded\./)
    const progress = fixture.bot().reviewTrack.solver
    assert.deepEqual(progress.passed, ['check-a'])
    assert.match(progress.snapshot, /^[a-f0-9]{64}$/)
    return progress.snapshot
  }
  const h = await nativeCheck(t)
  const snapshot = await pass(h)
  const status = await h.mirror('status', { command: "/bin/bash -lc 'git status --short'", beforeExit: churn(h.cwd) })
  assert.equal(status.isError, false)
  assert.deepEqual(h.bot().reviewTrack.solver.passed, ['check-a'], 'accepted pass must survive git status before result handoff')
  assert.equal(h.bot().reviewTrack.solver.snapshot, snapshot)
  assert.match(await h.report('pass-a'), /^Recorded\./)

  await h.send('result')
  const exchangeId = h.delivered.at(-1).exchangeId
  const { host } = h
  host.agentOf('reviewer').session.requestHeader = () => ({ config: { provider: 'acp-claude', model: 'default' } })
  host.event('reviewer', 'user/message', { content: content('Review the result.'), source: {
    kind: 'bot', role: 'request', senderSessionId: 'solver', exchangeId,
  } })
  host.event('reviewer', 'turn/start', { turn: 2 })
  host.finish('reviewer', 'Verdict: SHIP\nEvidence verified.')
  const review = h.bot().reviewTrack.solver.review
  assert.equal(review.verdict, 'SHIP')
  assert.equal(review.solverModel, 'acp-codex/default')
  assert.equal(review.reviewer.model, 'acp-claude/default')

  const diff = await h.mirror('diff', { command: "/bin/bash -lc 'git diff'", beforeExit: churn(h.cwd) })
  assert.equal(diff.isError, false)
  assert.deepEqual(h.bot().reviewTrack.solver.review, review)
  host.event('solver', 'turn/start', { turn: 3 })
  host.finish('solver', 'Delivered: both reviews SHIP, checks passed.')
  assert.equal(h.bot().reviewTrack.last.done, true)
  assert.equal(h.bot().reviewTrack.last.resultExchangeId, exchangeId)
  assert.equal(h.bot().reviewTrack.delivered, true)

  const changed = await nativeCheck(t)
  await pass(changed)
  const edit = await changed.mirror('edit-by-shell', {
    command: "/bin/bash -lc 'echo x >> average.mjs'",
    beforeExit: () => writeFileSync(join(changed.cwd, 'average.mjs'), 'changed'),
  })
  assert.equal(edit.isError, false)
  await assert.rejects(changed.send('result'), /Record current passing runs for every agreed check/)
  assert.match(await changed.report('pass-a'), /stale.*start a new run/i)
  assert.deepEqual(changed.bot().reviewTrack.solver.passed, [])
  const saved = JSON.parse(readFileSync(join(changed.host.home, 'state.json'), 'utf8')).bots.solver.reviewTrack.solver
  assert.deepEqual(saved.passed, [])
  assert.equal(saved.snapshot, undefined)

  await t.test('a computer-use launch invalidates passes and review at admission', async sub => {
    const launch = await nativeCheck(sub)
    await pass(launch)
    await launch.send('result')
    const { host } = launch
    const execute = host.ctx.listeners.get('tools/execute')[0]
    assert.equal(await execute({
      name: 'cua_driver_native__launch_app', arguments: { app: 'Fixture' },
      agent: host.agentOf('solver'), callId: 'launch-app',
    }, async () => {
      const progress = launch.bot().reviewTrack.solver
      assert.deepEqual(progress.passed, [])
      assert.equal(progress.review, undefined)
      return 'ran'
    }), 'ran')
  })

  await t.test('a legacy run cannot borrow a later pass at the same snapshot', async sub => {
    const legacy = await setup(sub)
    const { request } = await reviewedPlan(legacy, ['check-a'])
    const progress = () => legacy.rt.botOf('solver').reviewTrack.solver
    const replay = run => legacy.progress('checks', { request, run, results: results() })
    assert.match(await checked(legacy, request, 'legacy-a'), /^Recorded\./)
    const snapshot = progress().snapshot
    assert.equal(await legacy.execute('write', { file_path: 'out' }), 'ran')
    // Pre-upgrade invalidation kept the old report without a revision or stale marker.
    delete progress().runs['legacy-a'].revision
    delete progress().legacyRunsStale
    assert.match(await checked(legacy, request, 'current-a'), /^Recorded\./)
    assert.equal(progress().snapshot, snapshot)
    assert.match(await replay('legacy-a'), /stale.*start a new run/i)
    assert.match(await replay('current-a'), /^Recorded\./)
  })

  await t.test('a run cannot borrow a replacement pass in the same revision', async sub => {
    const retry = await setup(sub)
    const { request } = await reviewedPlan(retry)
    const progress = () => retry.rt.botOf('solver').reviewTrack.solver
    const replay = (run, check) => retry.progress('checks', { request, run, results: results(check) })
    assert.match(await checked(retry, request, 'old-a'), /^Recorded\./)
    assert.match(await checked(retry, request, 'current-b', { check: 'check-b' }), /^Recorded\./)
    const { revision, snapshot } = progress()
    assert.match(await runCheck(retry, request, 'unverified-a', true), /no verified passing evidence/i)
    assert.deepEqual(progress().passed, ['check-b'])
    assert.match(await replay('old-a'), /stale.*start a new run/i)
    assert.match(await checked(retry, request, 'current-a'), /^Recorded\./)
    assert.equal(progress().revision, revision)
    assert.equal(progress().snapshot, snapshot)
    assert.match(await replay('old-a'), /stale.*start a new run/i)
    assert.match(await replay('current-a'), /^Recorded\./)
    assert.match(await replay('current-b', 'check-b'), /^Recorded\./)
  })
})

test('LA-1 requires completed passing evidence on the same result', async t => {
  const h = await setup(t)
  const { request, send } = await reviewedPlan(h)
  assert.match(await h.progress('plan', {
    request, checks: ['check-a'], commands: [{ check: 'different', command: 'fake check-a' }],
  }), /one command for each agreed check ID/)
  await h.progress('start', { request, run: 'unexecuted', checks: ['check-a'] })
  const unexecuted = await h.progress('checks', { request, run: 'unexecuted', results: results() })
  assert.match(unexecuted, /no verified passing evidence/i)
  assert.match(await checked(h, request, 'wrong-command', { command: 'unrelated successful command' }), /no verified passing evidence/i)
  await assert.rejects(send('result'), /every agreed check/)
})

test('LA-1 a regenerating check invalidates the earlier pass', async t => {
  const h = await setup(t)
  const { request, send } = await reviewedPlan(h)
  assert.match(await checked(h, request, 'first-a'), /Recorded/)
  await checked(h, request, 'rewrites', { check: 'check-b',
    work: cwd => writeFileSync(join(cwd, 'out'), 'regenerated') })
  await assert.rejects(send('result'), /every agreed check/)
  assert.match(await checked(h, request, 'current-a'), /Recorded/)
  assert.match(await checked(h, request, 'current-b', { check: 'check-b' }), /Recorded/)
  await send('result')
})

test('LA-1 rejects a pass that contradicts the executed check', async t => {
  const h = await setup(t)
  const { request, send } = await reviewedPlan(h, ['check-a'])
  await h.progress('start', { request, run: 'nonzero', checks: ['check-a'] })
  const cwd = h.rt.botOf('solver').workDir
  await h.ctx.listeners.get('tools/execute')[0]({
    name: 'bash', arguments: { command: 'fake check-a' }, agent: h.agentOf('solver'), callId: 'nonzero',
  }, async () => ({ isError: false, value: { kind: 'foreground', cwd, exitCode: 1, signal: null, timedOut: false, aborted: false } }))
  assert.match(await h.progress('checks', { request, run: 'nonzero', results: results() }), /contradicts.*outcome/i)
  assert.match(await h.progress('checks', { request, run: 'nonzero', results: results('check-a', false) }), /Recorded/)
  await assert.rejects(send('result'), /every agreed check/)
})

test('LA-2 an undelivered designation can be retried after restart', async t => {
  let h = await setup(t)
  const request = await requestOf(h)
  await plan(h, request)
  const send = () => h.tool('message_bot', { to: 'reviewer', message: 'Review the plan.',
    solver_review: 'plan', solver_request: request, reply_to: 'me' })
  h.rt.attachLong = async () => undefined
  assert.equal((await send()).sent, false)
  await h.close()
  h = fixture(t, h.home)
  await h.rt.load()
  const messages = []
  const deliver = h.rt.deliver
  h.rt.deliver = async message => { messages.push(message); return deliver(message) }
  assert.match(await send(), /Delivered|Queued/)
  assert.equal(messages.length, 1)
  await assert.rejects(send(), /already waiting/)
  assert.equal(h.rt.botOf('solver').reviewTrack.solver.plan.review.exchangeId, messages[0].exchangeId)
})

test('LA-3 a reply to another Bot leaves the person budget open', async t => {
  const h = await setup(t)
  const request = await requestOf(h)
  await h.progress('replan', { request, run: 'first' })
  h.botMessage()
  h.event('solver', 'turn/start', { turn: 1 })
  h.finish('solver', 'Reply to the other Bot.')
  h.person('Continue my task.')
  assert.equal(await requestOf(h), request)
  assert.equal(h.rt.botOf('solver').reviewTrack.solver.replans, 1)
})

test('LA-3 a failed card release leaves the decision retryable', async t => {
  const h = await setup(t)
  const request = await requestOf(h)
  await plan(h, request)
  assert.match(await runCheck(h, request, 'failed-once', false), /Recorded/)
  for (const run of ['one', 'two', 'three']) await h.progress('replan', { request, run })
  await h.tool('ask_user', { question: 'Which input?', options: [{ label: 'Use it' }] }, 'solver', 'question')
  const card = h.rt.state.questions.solver
  const saveCopy = h.rt.saveCopy
  h.rt.saveCopy = async () => { throw new Error('Fixture release save failed') }
  await assert.rejects(h.rt.answerQuestion('solver', card.id, { selected: ['Use it'] }), /release save failed/)
  assert.equal(h.rt.state.questions.solver, card)
  assert.equal(h.agentOf('solver').message, undefined)
  h.rt.saveCopy = saveCopy
  await h.rt.answerQuestion('solver', card.id, { selected: ['Use it'] })
  const progress = h.rt.botOf('solver').reviewTrack.solver
  assert.equal(progress.replans, 0)
  assert.equal(progress.attempts['check-a'], 1)
})

test('LA-5 mediated retries require an open run and ordinary plan work stays available', async t => {
  const h = await setup(t)
  const { request } = await reviewedPlan(h, ['check-a'])
  assert.equal(await h.execute('write', { file_path: 'out' }), 'ran')
  await assert.rejects(h.execute('bash', { command: 'fake check-a' }), /start.*run/i)
  assert.match(await checked(h, request, 'first', { exitCode: 1 }), /Recorded/)
  assert.match(await h.progress('checks', { request, run: 'first', results: results('check-a', false) }), /Recorded/)
  assert.equal(h.rt.botOf('solver').reviewTrack.solver.attempts['check-a'], 1)
  await assert.rejects(h.execute('bash', { command: 'fake check-a' }), /start.*run/i)
})

test('Stage 6 ACP requires an open run for an exact agreed command after trimming', async t => {
  const h = await setup(t, { reviewGuard: true })
  await reviewedPlan(h, ['check-a'])
  await assert.rejects(h.execute('bash', { command: '  fake check-a\n' }), /start.*run/i)
  await assert.rejects(h.execute('acp_tool', { kind: 'execute', title: 'Run tests', input: { command: '  fake check-a\n' } }), /start.*run/i)
  assert.equal(await h.execute('acp_tool', { kind: 'execute', input: { command: 'fake  check-a' } }), 'ran')
})

test('Stage 6 ACP allows ordinary commands after plan SHIP', async t => {
  const h = await setup(t, { reviewGuard: true })
  await reviewedPlan(h, ['check-a'])
  assert.equal(h.rt.botOf('solver').reviewTrack.solver.plan.accepted, true)
  assert.equal(await h.execute('bash', { command: 'git status' }), 'ran')
  assert.equal(await h.execute('acp_tool', { kind: 'execute', title: 'fake check-a', input: { cmd: 'git status' } }), 'ran')
  assert.equal(await h.execute('acp_tool', { kind: 'execute', title: 'fake check-a', input: null }), 'ran')
})

test('Stage 6 ACP says the native command may already have run and keeps confirmed refusal counts separate', async t => {
  const h = await setup(t, { reviewGuard: true })
  await reviewedPlan(h, ['check-a'])
  h.event('solver', 'turn/start', { turn: 1 })
  const mirror = { kind: 'execute', title: 'Run tests', input: { cmd: 'fake check-a' } }
  await assert.rejects(h.execute('acp_tool', mirror), /start.*run/i)
  const [single] = h.rt.stopsView()
  assert.equal(single.why, 'rule')
  assert.equal(single.mayHaveRun, true)
  await assert.rejects(h.execute('bash', { command: 'fake check-a' }), /start.*run/i)
  await assert.rejects(h.execute('acp_tool', mirror), /start.*run/i)
  await assert.rejects(h.execute('bash', { command: 'fake check-a' }), /start.*run/i)
  const stops = h.rt.stopsView()
  assert.deepEqual(stops.map(({ why, count, mayHaveRun }) => [why, count, mayHaveRun === true]), [
    ['rule', 2, true], ['rule', 2, false],
  ])
  const english = [
    'acp_tool may already have run (a rule here refused it)',
    '2 steps may already have run (a rule here refused it)',
    '2 steps did not run: a rule here refused it',
  ]
  assert.equal(h.rt.stopLineOfTurn('solver', 1), english.slice(1).join(' · '))
  const pt = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url), 'utf8'))
  for (const [dictionary, expected] of [[{}, english], [pt, [
    'acp_tool pode já ter sido executada (uma regra aqui recusou)',
    '2 etapas podem já ter sido executadas (uma regra aqui recusou)',
    '2 etapas não foram executadas: uma regra aqui recusou',
  ]], [DICTIONARY.zh, [
    'acp_tool 可能已执行（这里的一条规则拒绝了它）',
    '2 个步骤可能已执行（这里的一条规则拒绝了它）',
    '2 个步骤未执行：这里的一条规则拒绝了它',
  ]]]) {
    const dispose = installLocale({ register: () => () => {}, bind: () => (key, params) =>
      (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => params?.[name] ?? match) })
    try {
      assert.deepEqual([single, ...stops].map(stopLine), expected)
    } finally {
      dispose()
    }
  }
})

test('LA-5 a person message during durable progress preserves its count', async t => {
  const h = await setup(t)
  const request = await requestOf(h)
  const saveCopy = h.rt.saveCopy
  h.rt.saveCopy = (change, options) => saveCopy(change, { ...options, afterPublish: () => h.person('Keep going.') })
  assert.match(await h.progress('replan', { request, run: 'overlap' }), /Recorded/)
  h.rt.saveCopy = saveCopy
  await h.rt.save({ required: true, durable: true })
  assert.equal(h.rt.botOf('solver').reviewTrack.solver.replans, 1)
  assert.equal(JSON.parse(readFileSync(join(h.home, 'state.json'), 'utf8')).bots.solver.reviewTrack.solver.replans, 1)
})

test('Normal holds the fourth failure and deduplicates the run', async t => {
  const h = await setup(t)
  const request = await requestOf(h)
  assert.ok(request)
  await plan(h, request)
  for (const [run, pass] of [['one', false], ['two', false], ['pass', true], ['three', false]]) {
    assert.match(await checked(h, request, run, { exitCode: pass ? 0 : 1 }), /Recorded/)
  }
  assert.match(await h.progress('checks', { request, run: 'three', results: [{ check: 'check-a', pass: false }] }), /Recorded/)
  assert.match(await checked(h, request, 'four', { exitCode: 1 }), /failed after 3 fix attempts/)
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

test('Skills loads are reads under the Solver attempt hold and preserve check evidence', async t => {
  for (const name of ['load_skill', 'mcp__dsh__load_skill']) {
    await t.test(name, async sub => {
      const h = await setup(sub, { reviewGuard: true })
      const { request, send, verdict, delivered } = await reviewedPlan(h, ['check-a'])
      assert.match(await checked(h, request, 'skill-read-pass'), /^Recorded\./)
      await send('result')
      verdict(delivered.at(-1).exchangeId)
      const bot = h.rt.botOf('solver')
      const progress = () => bot.reviewTrack.solver
      const before = structuredClone(progress())
      assert.deepEqual(before.passed, ['check-a'])
      assert.equal(before.review.verdict, 'SHIP')

      progress().limit = { kind: 'replan', at: bot.reviewTrack.requestAt }
      const reads = { relevant: false, checkCommand: false, compareResult: false }
      for (const read of ['recall', 'solver_progress']) {
        const { relevant, checkCommand, compareResult } = h.rt.solverCall(bot, read, {})
        assert.deepEqual({ relevant, checkCommand, compareResult }, reads, read)
        assert.equal(await h.execute(read, {}), 'ran', read)
      }
      for (const [work, args] of [
        ['remember', {}], ['write', { file_path: 'out' }], ['bash', { command: 'fake work' }],
      ]) {
        assert.equal(h.rt.solverCall(bot, work, args).relevant, true, work)
        await assert.rejects(h.execute(work, args), /attempt limit/, work)
      }

      const args = { name: 'planning-notes' }
      const { relevant, checkCommand, compareResult } = h.rt.solverCall(bot, name, args)
      const underLimit = await h.execute(name, args).catch(error => error.message)
      const afterHeldRead = structuredClone(progress())
      delete afterHeldRead.limit
      delete progress().limit
      assert.equal(await h.execute(name, args), 'ran')
      assert.deepEqual({
        classification: { relevant, checkCommand, compareResult },
        underLimit,
        passed: progress().passed,
        verdict: progress().review?.verdict,
      }, { classification: reads, underLimit: 'ran', passed: ['check-a'], verdict: 'SHIP' })
      assert.deepEqual(afterHeldRead, before)
      assert.deepEqual(progress(), before)
    })
  }
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
  for (const name of ['write', 'edit', 'bash', 'create_bot', 'remember', 'subagent']) {
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
  h.rt.indexSessions()
  try {
    assert.match(await h.progress('status', {}, 'group-solver'), /Only a Solver/)
  } finally {
    delete h.rt.state.rooms.room
    h.rt.indexSessions()
  }
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
  const deliver = h.rt.deliver
  h.rt.deliver = async message => { deliveries.push(message); return deliver(message) }
  const review = async kind => {
    await h.tool('message_bot', { to: 'reviewer', message: 'Please verify this evidence.',
      solver_review: kind, solver_request: request, reply_to: 'me' })
    return deliveries.at(-1).exchangeId
  }
  const verdict = (exchangeId, text, model = refOf(reviewerModel)) => answerSender(h.rt, 'reviewer', {
    exchangeId, senderSessionId: 'solver',
  }, text, undefined, undefined, model)
  await plan(h, request)
  const planExchange = await review('plan')
  assert.match(deliveries.at(-1).text, /Agreed check IDs: check-a, check-b/)
  assert.match(deliveries.at(-1).text, /Agreed check commands: \{"check-a":"fake check-a","check-b":"fake check-b"\}/)
  verdict(planExchange, 'SHIP')
  await h.progress('start', { request, run: 'native', checks: ['check-a'] })
  const mirror = { id: 'child-a', kind: 'execute', title: 'Run check', input: { command: 'fake check' } }
  const agent = h.agentOf('solver')
  const executeHook = h.ctx.listeners.get('tools/execute')[0]
  assert.equal(await executeHook({ name: 'acp_tool', arguments: mirror, agent, callId: 'native' }, async () => {
    assert.equal(await h.rt.reviewGuardAsk({ toolName: 'acp_tool', mirrorCall: mirror, agent, callId: 'parent' }), undefined)
    const otherChild = { ...mirror, id: 'child-b' }
    const held = await h.rt.reviewGuardAsk({ toolName: 'acp_tool', mirrorCall: otherChild, agent, callId: 'parent' })
    assert.match(held.text, /Finish recording/)
    assert.equal(otherChild.refused.reason, held.text)
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
  await checked(h, request, 'pass-a')
  await assert.rejects(review('result'), /every agreed check/)
  await checked(h, request, 'pass-b', { check: 'check-b' })
  await checked(h, request, 'new-failure', { exitCode: 1 })
  await assert.rejects(review('result'), /every agreed check/)
  await checked(h, request, 'repass-a')
  await checked(h, request, 'repass-b', { check: 'check-b' })
  let exchange = await review('result')
  h.rt.openWork('late-plan', { from: 'solver', to: 'reviewer' })
  verdict('late-plan', 'SHIP')
  assert.equal(bot.reviewTrack.solver.review.verdict, undefined)
  verdict(exchange, 'SHIP', refOf(solverModel))
  assert.equal(bot.reviewTrack.solver.review.verdict, 'unverified')
  assert.equal(bot.reviewTrack.solver.review.unverified, 'same')
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
  await checked(h, request, 'final-a')
  await checked(h, request, 'final-b', { check: 'check-b' })
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
  assert.deepEqual(mark.reviewer, { id: 'reviewer', name: 'reviewer', model: refOf(reviewerModel) })
  h.rt.botOf('reviewer').name = 'Renamed'
  const displayed = reviewMarkText({ ...bot, reviewMark: mark }, { byId: h.rt.state.bots })
  assert.match(displayed, /every check passed and reviewer approved/)
  assert.doesNotMatch(displayed, /result unreviewed/i)
  assert.equal(displayed, 'Plan and result reviewed by reviewer.\nDone: every check passed and reviewer approved.')
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
  h.person('Continue the task.')
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

const configuredSolver = 'acp-codex/gpt-6-sol'
const configuredReviewer = 'acp-claude/claude-sonnet-5-5'
const aliasReviewer = 'acp-claude/sonnet'
const wireFixture = fileURLToPath(new URL('./fixtures/solver-identity-acp.mjs', import.meta.url))

async function pickDialogModel(node, provider, label, withLevel) {
  const component = node.type(node.props)
  const menu = mount(component.type, component.props)
  const find = predicate => {
    // A stand-in DOM anchor lets the actual menu mount its portal.
    const attach = tree => all(tree, child => child.props?.ref && Object.hasOwn(child.props.ref, 'current'))
      .forEach(({ props }) => { props.ref.current ??= { contains: () => false, getBoundingClientRect: () => ({ width: 100, right: 400, top: 150, bottom: 180 }) } })
    attach(menu.render())
    const tree = menu.render()
    const step = all(tree, child => child.type?.name === 'ModelSteps')[0]
    return all(step ? step.type(step.props) : tree, predicate)
  }
  find(child => child.props?.className === 'bt-model-trigger')[0].props.onClick({})
  find(child => child.props?.['data-route'] === 'acp')[0].props.onClick()
  find(child => child.props?.key === provider)[0].props.onClick()
  const rows = find(child => child.props?.role === 'menuitemradio' && text(child) === label)
  assert.equal(rows.length, 1)
  rows[0].props.onClick()
  await immediate()
  if (withLevel) find(child => child.props?.role === 'menuitemradio' && text(child) === 'Default')[0]?.props.onClick()
  return rows[0].props.title
}

function wireHost(t, home = mkdtempSync(join(tmpdir(), 'solver-pin-wire-')), acknowledgement = 'selected', configure, codexAcknowledgement = 'selected') {
  const traces = Object.fromEntries(['acp-claude', 'acp-codex'].map(provider => [provider, join(home, provider + '.jsonl')]))
  for (const path of Object.values(traces)) writeFileSync(path, '')
  const connector = (provider, ack) => {
    const path = join(home, provider + '.mjs')
    writeFileSync(path, `process.argv.splice(2, Infinity, ...${JSON.stringify([traces[provider], provider, ack])}); await import(${JSON.stringify(wireFixture)});\n`)
    return path
  }
  const connectors = {
    '@agentclientprotocol/claude-agent-acp': connector('acp-claude', acknowledgement),
    '@agentclientprotocol/codex-acp': connector('acp-codex', codexAcknowledgement),
  }
  let adapter
  let serial = 0
  const selections = []
  const h = fixture(t, home, { configure(ctx, agentOf) {
    ctx.workspaceRegistry.resolveByPath = () => undefined
    ctx.workspaceRegistry.register = async () => ({ id: 'team' })
    ctx.sessionController.create = async () => ({ sessionId: `wire-bot-${++serial}` })
    ctx.sessionController.selectModel = async ({ sessionId, provider, model }) => {
      selections.push({ sessionId, provider, model })
      agentOf(sessionId).session.requestHeader = () => ({ config: { provider, model } })
    }
    ctx.agents = { get: id => {
      const agent = agentOf(id)
      agent.ctx.tools.register ??= () => () => {}
      return agent
    }, list: () => [] }
    ctx.llm.listProviders = () => ctx.adapters?.at(-1)?.routes.map(id => ({ id, name: id })) ?? []
    ctx.llm.listModels = (provider) => adapter.listModels(provider)
    ctx.llm.resolveModelInfo = (provider, model) => adapter.resolveModel(provider, model)
    applyAcp(ctx, { dshTools: false }, {
      store: { binOf: pkg => connectors[pkg] ? { path: connectors[pkg], version: '1.0.0' } : undefined, update: async () => {} },
      find: name => ['claude', 'codex'].includes(name) ? '/bin/false' : undefined,
      signedIn: async () => true,
    })
    adapter = ctx.adapters?.at(-1)?.adapter
    ctx.acpAgents = ctx.provided.get('acpAgents')
    // The fake adapters run without native tool launch settings.
    ctx.acpAgents.botIdentity = () => () => {}
    configure?.(ctx, agentOf)
  } })
  const wire = provider => readFileSync(traces[provider], 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  return { h, adapter, wire, selections }
}

async function dialogWire(t, acknowledgement, reviewerLabel = 'Sonnet 5.5', {
  solverRef = configuredSolver, solverLabel = 'GPT-6 Sol', existingReviewer,
} = {}) {
  const home = mkdtempSync(join(tmpdir(), 'solver-dialog-wire-'))
  const cwd = mkdtempSync(join(tmpdir(), 'solver-dialog-project-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const { h, adapter, wire } = wireHost(t, home, acknowledgement)
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  await h.rt.load()
  h.rt.state.reviewGuardMigrated = true
  h.rt.state.prefs.roles = false
  // Keep bootstrap from creating an unrelated Main Bot.
  h.rt.state.mainBotIds = ['main']
  h.rt.state.bots.main = { id: 'main', name: 'Main', createdAt: 1 }
  if (existingReviewer) {
    h.rt.state.bots.reviewer = { id: 'reviewer', name: 'Existing reviewer', role: 'Reviewer', model: existingReviewer, createdAt: 1 }
  }
  await h.rt.save({ required: true })
  const rows = await h.rt.catalog({ fresh: true })
  assert.ok(rows.some(row => row.ref === solverRef), JSON.stringify(rows))
  const roster = { bots: Object.values(h.rt.state.bots), mainBotIds: ['main'], models: rows, prefs: { roles: false } }
  const creates = []
  const failures = []
  let solver
  const action = async (endpoint, payload) => {
    const response = await h.call(endpoint, payload)
    if (!response.ok) {
      failures.push(response.error)
      throw response.error
    }
    return response.value
  }
  const actions = {
    pets: async () => [],
    createBot: async payload => {
      creates.push({ payload, bot: await action('create-bot', payload) })
      return creates.at(-1).bot
    },
    deleteBot: id => action('delete-bot', { id }),
    teamState: () => ({ bots: [] }),
    send: async (id, value) => h.person(value, id),
  }
  const dialog = mount(NewSolver, { roster, actions, brief: 'Do the task.', onBack() {}, onCreated: bot => { solver = bot } })
  const find = predicate => all(dialog.render(), predicate)[0]
  const picker = id => find(node => node.props?.bot?.id === id && typeof node.props.onPick === 'function')
  // Keep the project on a real scratch directory so the agreed check can verify its snapshot.
  find(node => node.type?.name === 'FolderMenu').props.onPick(cwd)
  const solverRow = await pickDialogModel(picker('new-bot'), solverRef.split('/')[0], solverLabel, true)
  find(node => node.type === 'select').props.onChange({ target: { value: existingReviewer ? 'bot:reviewer' : 'new' } })
  const reviewerRow = existingReviewer ? undefined : await pickDialogModel(picker('new-reviewer'), 'acp-claude', reviewerLabel, false)
  const create = find(node => node.type === 'button' && node.props.className?.includes('bt-create-go'))
  assert.equal(Boolean(create.props.disabled), false, text(dialog.render()))
  create.props.onClick()
  await until(() => solver || failures.length || find(node => node.props?.role === 'alert') || find(node => node.type === 'button' && text(node) === 'Done'))
  assert.deepEqual(failures, [])
  if (!solver) find(node => node.type === 'button' && text(node) === 'Done')?.props.onClick()
  assert.ok(solver, text(dialog.render()))
  const reviewer = existingReviewer ? h.rt.botOf('reviewer') : creates.find(entry => entry.payload.role === 'Reviewer').bot
  const bot = h.rt.botOf(solver.id)
  const agent = id => h.agentOf(id)
  const progress = (kind, args = {}) => h.progress(kind, args, solver.id)
  const prompt = async (id, input, reasoningEffort) => {
    const ref = h.rt.botOf(id).model
    const slash = ref.indexOf('/')
    const provider = ref.slice(0, slash)
    const model = ref.slice(slash + 1)
    agent(id).session.requestHeader = () => ({ config: { provider, model } })
    const messages = [{ role: 'user', content: input.content, source: input.source }]
    const chunks = []
    for await (const chunk of adapter.stream({ provider, model, sessionId: id, messages, reasoningEffort, signal: AbortSignal.timeout(5000) })) chunks.push(chunk)
    return { chunks, text: chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block.text ?? '').join('') }
  }
  return { h, bot, solver, reviewer, solverRow, reviewerRow, creates, wire, agent, progress, prompt, adapter, cwd, solverRef }
}

async function dialogResult(f, { beforeReply, takeResult = true, resultEffort } = {}) {
  const { h, bot, solver, reviewer, progress, agent } = f
  h.event(solver.id, 'turn/start', { turn: 2 })
  const opening = await f.prompt(solver.id, { content: content('Do the task.'), source: { kind: 'user' } })
  assert.equal(bot.model, f.solverRef)
  assert.match(opening.text, /SHIP/, JSON.stringify({ model: bot.model, row: f.solverRow, chunks: opening.chunks }))
  const request = /^Request: ([\w-]+)/.exec(await progress('status'))?.[1]
  assert.ok(request)
  const check = 'average-test'
  const command = 'node --test average.test.mjs'
  assert.match(await progress('plan', { request, checks: [check], commands: [{ check, command }] }), /^Recorded\./)
  const deliveries = []
  const deliver = h.rt.deliver
  h.rt.deliver = (message, options) => {
    const sent = deliver(message, options)
    deliveries.push({ message, sent })
    return sent
  }
  const review = async (kind, turn) => {
    await h.tool('message_bot', { to: reviewer.id, message: `Review the ${kind}.`, solver_review: kind, solver_request: request, reply_to: 'me' }, solver.id)
    const original = deliveries.at(-1)
    await original.sent
    const input = agent(reviewer.id).message
    assert.equal(input.source.exchangeId, original.message.exchangeId)
    h.finish(solver.id, `Waiting for ${kind} review.`)
    h.event(reviewer.id, 'turn/start', { turn })
    h.takeInput(reviewer.id, input)
    const answer = await f.prompt(reviewer.id, input, kind === 'result' ? resultEffort : undefined)
    assert.equal(answer.text, reviewShip, JSON.stringify(answer.chunks))
    const release = kind === 'result' ? await beforeReply?.(request) : undefined
    h.finish(reviewer.id, answer.text)
    const reply = deliveries.at(-1)
    await release?.(reply)
    assert.equal(await reply.sent, reply.message.exchangeId)
    const actual = agent(solver.id).message
    assert.equal(actual.source.replyTo, original.message.exchangeId)
    if (kind !== 'result' || takeResult) {
      h.event(solver.id, 'turn/start', { turn: turn + 1 })
      h.takeInput(solver.id, actual)
    }
    return { exchangeId: original.message.exchangeId, actual }
  }
  await review('plan', 2)
  assert.equal(bot.reviewTrack.solver.plan.accepted, true)
  assert.match(await progress('start', { request, run: 'observed', checks: [check] }), /^Recorded\./)
  await h.ctx.listeners.get('tools/execute')[0]({
    name: 'bash', arguments: { command }, agent: agent(solver.id), callId: 'observed',
  }, async () => ({ isError: false, value: { kind: 'foreground', cwd: f.cwd, exitCode: 0, signal: null, timedOut: false, aborted: false } }))
  assert.match(await progress('checks', { request, run: 'observed', results: [{ check, pass: true }] }), /^Recorded\./)
  return review('result', 3)
}

test('Owner LA-2 delivers once from the dialog with a raw Solver alias and an existing alias reviewer', async t => {
  const f = await dialogWire(t, 'selected', undefined, {
    solverRef: 'acp-claude/opus', solverLabel: 'Opus', existingReviewer: 'acp-claude/sonnet',
  })
  const { h, bot, solver, reviewer } = f
  assert.deepEqual(f.creates.map(entry => entry.payload.model), ['acp-claude/opus'])
  assert.equal(bot.model, 'acp-claude/opus')
  assert.equal(bot.reviewerId, reviewer.id)
  assert.equal(reviewer.model, 'acp-claude/sonnet')
  const { exchangeId, actual } = await dialogResult(f)
  assert.equal(actual.source.reviewFeedback, undefined)
  assert.ok(actual.source.reviewReceipt)
  const result = bot.reviewTrack.solver.review
  assert.equal(result.receipt, actual.source.reviewReceipt)
  assert.equal(result.verdict, 'SHIP')
  assert.equal(result.solverModel, 'acp-claude/claude-opus-5-5')
  assert.equal(result.reviewer.model, heldReviewerIdentity)
  assert.deepEqual(new Set(f.wire('acp-claude').filter(row => row.method === 'session/prompt').map(row => row.selected)),
    new Set(['opus', 'sonnet']))
  h.finish(solver.id, 'Delivered after the designated RESULT.')
  const mark = bot.reviewTrack.last
  assert.equal(mark?.done, true)
  assert.equal(mark.resultExchangeId, exchangeId)
  assert.equal(bot.reviewTrack.delivered, true)
  h.event(solver.id, 'turn/start', { turn: 5 })
  h.finish(solver.id, 'Already delivered.')
  assert.equal(bot.reviewTrack.last, mark)
})

test('RESULT independence uses the chosen provider and full model ID', async t => {
  for (const [name, solver, reviewer, same = false] of [
    ['Antigravity and omp', ['acp-antigravity', 'default'], ['acp-omp', 'default']],
    ['native DSH', ['anthropic', 'claude-opus-5-5'], ['deepseek', 'deepseek-v4']],
    ['ACP Hermes', ['acp-hermes', 'vendor/remote/model'], ['acp-hermes', 'vendor/local/model']],
    ['same model across agents', ['acp-claude', 'opus'], ['anthropic', 'claude-opus-5-5']],
    ['different dated IDs', ['anthropic', 'model-20261001'], ['anthropic', 'model-20261101']],
    ['identical native refs', ['deepseek', 'deepseek-v4'], ['deepseek', 'deepseek-v4'], true],
    ['context suffix', ['anthropic', 'model-20261001'], ['ANTHROPIC', 'model-20261001[1m]'], true],
    ['an alias and its pin', ['acp-claude', 'sonnet'], ['acp-claude', 'claude-sonnet-5-5'], true],
  ]) {
    await t.test(name, async t => {
      const { h, request, review, answer, track, openReply, deliveries } = await reviewReplyFixture(t)
      const route = ([provider, model]) => () => ({ config: { provider, model } })
      h.agentOf('solver').session.requestHeader = route(solver)
      h.agentOf('reviewer').session.requestHeader = route(reviewer)
      const planExchange = await review('plan')
      h.finish('solver', 'Waiting for the plan.')
      await openReply(3, answer(planExchange))
      assert.match(await checked(h, request, 'test', { check: 'average-test', command: 'node --test average.test.mjs' }), /^Recorded\./)
      assert.match(await checked(h, request, 'diff', { check: 'diff-check', command: 'git diff --check' }), /^Recorded\./)
      const exchange = await review('result')
      h.finish('solver', 'Waiting for the result.')
      h.event('reviewer', 'turn/start', { turn: 2 })
      h.takeInput('reviewer', h.agentOf('reviewer').message)
      h.event('reviewer', 'assistant/message', { message: { content: content('RESULT SHIP') } })
      // The answering text is already recorded when the picker changes.
      h.rt.botOf('reviewer').model = 'later/picker'
      h.agentOf('reviewer').session.requestHeader = route(same ? ['later', 'picker'] : solver)
      h.event('reviewer', 'turn/end', { reason: { kind: 'completed' } })
      const reply = deliveries.at(-1)
      await openReply(4, reply)
      const result = track().solver.review
      assert.equal(result.verdict, same ? 'unverified' : 'SHIP')
      assert.equal(result.unverified, same ? 'same' : undefined)
      assert.equal(h.agentOf('solver').message.source.reviewFeedback, same ? 'same' : undefined)
      if (same) assert.match(h.agentOf('solver').message.content.at(-1).text, /same model as the Solver/)
      else assert.equal(result.reviewer.model, reviewer[0] === 'acp-claude' ? 'acp-claude/claude-opus-5-5' : reviewer.join('/'))
      h.finish('solver', 'Reviewed the RESULT.')
      assert.equal(track().last?.done, same ? undefined : true)
      if (!same) assert.equal(track().last.resultExchangeId, exchange)
    })
  }
})

test('New Solver picks the live Claude option and delivers Done once for that RESULT exchange', async t => {
  const f = await dialogWire(t)
  const { h, bot, solver, reviewer } = f
  const { exchangeId } = await dialogResult(f)
  const prompts = f.wire('acp-claude').filter(e => e.method === 'session/prompt')
  const selected = f.wire('acp-claude').find(e => e.method === 'session/set_config_option' && e.sessionId === prompts.at(-1)?.sessionId)
  assert.equal(selected?.value, 'sonnet')
  assert.equal(selected.selected, 'sonnet')
  t.diagnostic(JSON.stringify({ solverRow: f.solverRow, reviewerRow: f.reviewerRow, saved: reviewer.model, selected, recorded: bot.reviewTrack.solver.review }))
  h.finish(solver.id, 'Delivered after the RESULT reply.')
  assert.equal(bot.reviewTrack.last?.done, true, JSON.stringify({ mark: bot.reviewTrack.last, outcome: bot.reviewTrack.outcome }))
  assert.equal(bot.reviewTrack.last.resultExchangeId, exchangeId)
  assert.equal(bot.reviewTrack.delivered, true)
  assert.equal(reviewer.model, configuredReviewer)
  assert.equal(f.creates[0].payload.model, configuredReviewer)
  const mark = bot.reviewTrack.last
  h.event(solver.id, 'turn/start', { turn: 5 })
  h.finish(solver.id, 'Already delivered.')
  assert.equal(bot.reviewTrack.last, mark)
})

test('New Solver requires Claude wire acknowledgement in its answering session', async t => {
  for (const outcome of ['echo-only', 'different', 'already-current']) {
    await t.test(outcome, async t => {
      const f = await dialogWire(t, outcome)
      const answer = await f.prompt(f.reviewer.id, { content: content('Review this.'), source: { kind: 'user' } })
      const wire = f.wire('acp-claude')
      if (outcome === 'already-current') {
        assert.equal(answer.text, reviewShip)
        assert.ok(wire.some(row => row.method === 'session/prompt' && row.selected === 'sonnet'))
        assert.equal(f.adapter.live.get(f.reviewer.id).run.acknowledgedModel(), 'claude-sonnet-5-5')
      } else {
        assert.match(answer.chunks.at(-1).reason.failure.message, /did not acknowledge the pinned Sonnet/)
        assert.equal(wire.filter(row => row.method === 'session/prompt').length, 0)
        assert.equal(f.adapter.live.get(f.reviewer.id).run.acknowledgedModel(), undefined)
        assert.equal(f.adapter.live.get(f.reviewer.id).run.option('model').currentValue, outcome === 'echo-only' ? 'sonnet' : 'default')
      }
    })
  }
})

test('a missing answering route gives the exact RESULT input a durable unverified notice', async t => {
  const f = await dialogWire(t)
  const { h, bot, solver, reviewer } = f
  const result = await dialogResult(f, { takeResult: false, async beforeReply(request) {
    f.agent(reviewer.id).session.requestHeader = () => undefined
    h.person('Work alone until delivered.', solver.id)
    const atCommit = Promise.withResolvers()
    const releaseProgress = Promise.withResolvers()
    const saveCopy = h.rt.saveCopy
    h.rt.saveCopy = (change, options) => saveCopy(change, {
      ...options, beforeCommit: async () => {
        atCommit.resolve()
        await releaseProgress.promise
        options.beforeCommit()
      },
    })
    const write = f.progress('auto', { request, quote: 'Work alone until delivered.' })
    await atCommit.promise
    const saved = h.rt.save
    const gate = Promise.withResolvers()
    let waiting = false
    h.rt.save = async options => {
      if (options?.required && options.durable && bot.reviewTrack.solver.review?.unverified === 'model') {
        waiting = true
        await gate.promise
      }
      return saved(options)
    }
    return async reply => {
      assert.equal(bot.reviewTrack.solver.review.verdict, undefined, 'the verdict waits for the current progress write')
      assert.notEqual(f.agent(solver.id).message?.source.exchangeId, reply.message.exchangeId)
      h.rt.saveCopy = saveCopy
      releaseProgress.resolve()
      assert.match(await write, /^Recorded\./)
      await until(() => waiting)
      assert.notEqual(f.agent(solver.id).message?.source.exchangeId, reply.message.exchangeId)
      assert.equal(bot.reviewTrack.delivered, undefined)
      h.rt.save = saved
      gate.resolve()
    }
  } })
  const { exchangeId, actual } = result
  const feedback = '[Automagik: RESULT review is unverified. The reviewer’s effective model could not be verified. Keep this request unmarked Done.]'
  assert.equal(actual.content.at(-1).text, feedback)
  assert.match(actual.content[0].text, /Verdict: SHIP\nEvidence verified\./)
  assert.equal(actual.source.replyTo, exchangeId)
  assert.ok(actual.source.reviewReceipt)
  const disk = JSON.parse(readFileSync(join(h.home, 'state.json'), 'utf8')).bots[solver.id].reviewTrack.solver.review
  assert.equal(disk.verdict, 'unverified')
  assert.equal(disk.unverified, 'model')
  assert.equal(disk.receipt, actual.source.reviewReceipt)
  const book = h.rt.ledger.records(`pair-${[solver.id, reviewer.id].sort().join('-')}`)
  assert.equal(book.find(entry => entry.id === actual.source.exchangeId && entry.event === undefined).text, reviewShip)
  const statusView = { ...bot, ...h.rt.solverStatusOf(bot) }
  const surfaces = [
    [undefined, /RESULT review unverified\. The reviewer’s effective model could not be verified\./],
    [ptBrLocale(), /Revisão do RESULTADO sem verificação\. Não foi possível verificar o modelo usado pelo revisor\./],
    [{ register() {}, bind: () => (key, params) => (DICTIONARY.zh[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => params?.[name] ?? match),
      getLocale: () => ({ active: 'zh' }) }, /结果审阅未通过验证。无法验证审阅者实际使用的模型。/],
  ]
  for (const [locale, expected] of surfaces) {
    const restore = installLocale(locale)
    try { assert.match(solverAutoView(statusView, {}, 'ask').lines.join('\n'), expected) } finally { restore() }
  }
  const moved = { ...actual, id: 'moved-review-input' }
  assert.deepEqual(h.rt.withReviewFeedback(moved, solver.id).content, actual.content)
  assert.notEqual(h.rt.withReviewFeedback(moved, reviewer.id).content.at(-1).text, feedback)
  assert.equal(await h.rt.flushUpdateNotes(), true)
  await h.close()

  const next = fixture(t, h.home)
  await next.rt.load()
  const note = next.rt.unreadReviewReplies(solver.id).find(row => row.exchangeId === actual.source.exchangeId)
  assert.equal(note?.reviewReply?.receipt, actual.source.reviewReceipt)
  // Recover the same receipt through the normal reply queue and wake.
  await until(() => next.agentOf(solver.id).message?.source.exchangeId === actual.source.exchangeId)
  const reconstructed = next.agentOf(solver.id).message
  assert.equal(reconstructed.source.reviewFeedback, 'model')
  assert.equal(reconstructed.content.at(-1).text, feedback)
  const movedAgain = { ...reconstructed, id: 'new-part-input' }
  next.event(solver.id, 'turn/start', { turn: 4 })
  next.takeInput(solver.id, movedAgain)
  const binding = next.rt.live.get(solver.id).consumedResult
  assert.equal(binding.receipt, actual.source.reviewReceipt)
  const continuation = next.rt.notePartReviewContinuation(solver.id, {
    id: 'continuation', content: content('Continue.'), source: { kind: 'bot', role: 'resume', exchangeId: 'resume' },
  }, binding)
  assert.equal(continuation.content.at(-1).text, feedback)
  next.finish(solver.id, 'Kept unmarked Done.')
  const track = next.rt.botOf(solver.id).reviewTrack
  assert.equal(track.last?.done, undefined)
  assert.equal(track.outcome.reason, 'review')
  next.person('Replace the request.', solver.id)
  assert.equal(next.rt.withReviewFeedback(continuation, solver.id, binding).content.at(-1).text, 'Continue.')
  assert.equal(await next.rt.flushUpdateNotes(), true)
  await next.rt.save({ required: true, durable: true })
  await next.close()
})

async function pendingResultReview(t) {
  const f = await reviewReplyFixture(t)
  const { h, request, review, answer, openReply } = f
  const planExchange = await review('plan')
  h.finish('solver', 'Waiting for plan review.')
  await openReply(3, answer(planExchange))
  assert.match(await checked(h, request, 'test', { check: 'average-test', command: 'node --test average.test.mjs' }), /^Recorded\./)
  assert.match(await checked(h, request, 'diff', { check: 'diff-check', command: 'git diff --check' }), /^Recorded\./)
  // Give the RESULT a parent work item so a concurrently opened turn defers it.
  h.rt.openWork('solver-work', { from: 'other', to: 'solver' })
  h.rt.live.get('solver').info = { kind: 'bot', role: 'request', exchangeId: 'solver-work', senderSessionId: 'other' }
  const exchange = await review('result')
  assert.equal(h.rt.state.works[exchange].parent, 'solver-work')
  h.finish('solver', 'Waiting for result review.')
  return { ...f, exchange }
}

test('Owner LA-2 replaces a legacy pending RESULT without discarding passing evidence or delivery history', async t => {
  const { h, request, exchange, track } = await pendingResultReview(t)
  const progress = track().solver
  progress.review.solverModel = solverModel.model
  const evidence = structuredClone({ snapshot: progress.snapshot, passed: progress.passed, passRuns: progress.passRuns })
  const history = { review: 'bot', done: true, resultExchangeId: 'older-result', reviewer: { id: 'reviewer', model: 'old-model' } }
  h.rt.botOf('other').reviewTrack = {
    requested: true, delivered: true, requestAt: 1, last: history,
    solver: { request: 'older-request', origin: 'person', review: { solverModel: 'old-solver', verdict: 'SHIP' } },
  }
  await h.rt.save({ required: true, durable: true })
  assert.equal(await h.rt.flushUpdateNotes(), true)
  await h.close()

  const next = fixture(t, h.home)
  await next.rt.load()
  const bot = next.rt.botOf('solver')
  assert.equal(bot.reviewTrack.solver.review.exchangeId, exchange)
  assert.equal(bot.reviewTrack.solver.review.solverModel, solverModel.model)
  assert.deepEqual(next.rt.reviewMarkOf(next.rt.botOf('other')).reviewMark, history)
  await next.tool('message_bot', {
    to: 'reviewer', message: 'Review the current result again.', solver_review: 'result', solver_request: request, reply_to: 'me',
  })
  const input = next.agentOf('reviewer').message
  const current = bot.reviewTrack.solver
  assert.notEqual(current.review.exchangeId, exchange)
  assert.equal(input.source.exchangeId, current.review.exchangeId)
  assert.equal(current.review.solverModel, refOf(solverModel))
  assert.deepEqual({ snapshot: current.snapshot, passed: current.passed, passRuns: current.passRuns }, evidence)
  assert.equal(next.rt.state.works[exchange], undefined)
  next.event('reviewer', 'turn/start', { turn: 5 })
  next.takeInput('reviewer', input)
  next.finish('reviewer', 'RESULT SHIP')
  await until(() => next.agentOf('solver').message?.source.replyTo === current.review.exchangeId)
  next.event('solver', 'turn/start', { turn: 6 })
  next.takeInput('solver', next.agentOf('solver').message)
  next.finish('solver', 'Delivered after the fresh RESULT.')
  assert.equal(bot.reviewTrack.last?.done, true)
  assert.equal(bot.reviewTrack.last.resultExchangeId, current.review.exchangeId)
  assert.deepEqual(next.rt.reviewMarkOf(next.rt.botOf('other')).reviewMark, history)
})

const modelWarningCount = message => message?.content.filter(block =>
  block.type === 'text' && block.text.includes('The reviewer’s effective model could not be verified.')).length

test('identity round 2 recovers the original RESULT at the first durable work closure', async t => {
  const { h, exchange, answer } = await pendingResultReview(t)
  const snapshot = mkdtempSync(join(tmpdir(), 'solver-first-closure-'))
  t.after(() => rmSync(snapshot, { recursive: true, force: true, maxRetries: 5 }))
  const decision = Promise.withResolvers()
  const closed = Promise.withResolvers()
  const gate = Promise.withResolvers()
  const capabilities = h.rt.ensureCapabilities
  h.rt.ensureCapabilities = async id => {
    if (id === 'solver') await gate.promise
    return capabilities(id)
  }
  const save = h.rt.save
  h.rt.save = async options => {
    if (options?.required && options.durable && h.rt.botOf('solver').reviewTrack.solver.review?.unverified === 'model') {
      await decision.promise
    }
    const written = await save(options)
    if (options?.durable && written) {
      const state = readFileSync(join(h.home, 'state.json'), 'utf8')
      if (!JSON.parse(state).works[exchange]) {
        closed.resolve({ state, notes: readFileSync(join(h.home, 'inflight.json'), 'utf8') })
      }
    }
    return written
  }
  const reply = answer(exchange, undefined, null)
  // Allow a candidate that keeps the work open until the decision is durable to reach closure.
  // On the parent, the earlier closure is allowed to reach disk while the decision is held.
  if (h.rt.state.works[exchange]) decision.resolve()
  const cut = await closed.promise
  assert.notEqual(h.agentOf('solver').message?.source.exchangeId, reply.message.exchangeId)
  decision.resolve()
  gate.resolve()
  assert.equal(await reply.sent, reply.message.exchangeId)
  writeFileSync(join(snapshot, 'state.json'), cut.state)
  writeFileSync(join(snapshot, 'inflight.json'), cut.notes)
  const notes = Object.entries(JSON.parse(cut.notes).queued).flatMap(([destination, items]) =>
    items.filter(({ args }) => args.replyTo === exchange).map(({ args }) => ({ destination, args })))
  assert.equal(notes.length, 1, 'the first durable closure must already have exactly one recoverable RESULT')
  const [{ destination, args }] = notes
  assert.equal(destination, 'solver')
  assert.equal(args.text, reviewShip)
  assert.equal(args.reviewReply.receipt, JSON.parse(cut.state).bots.solver.reviewTrack.solver.review.receipt)

  const next = fixture(t, snapshot)
  const inputs = []
  next.agentOf('solver').followup = message => inputs.push(message)
  await next.rt.load()
  const keepAlive = setInterval(() => {}, 1000)
  try { await next.rt.resumesDone } finally { clearInterval(keepAlive) }
  const recovered = inputs.filter(message => message.source.replyTo === exchange)
  assert.equal(recovered.length, 1)
  assert.equal(recovered[0].source.reviewReceipt, args.reviewReply.receipt)
  assert.match(recovered[0].content[0].text, /Verdict: SHIP\nEvidence verified\./)
  assert.equal(modelWarningCount(recovered[0]), 1)
  await next.close()
})

test('identity round 2 keeps only the current RESULT warning on deferred hand-back', async t => {
  for (const path of ['ordinary', 'update restart', 'replaced request']) {
    await t.test(path, async t => {
      const { h, request, exchange, answer } = await pendingResultReview(t)
      const solver = h.agentOf('solver')
      const reply = answer(exchange, undefined, null)
      assert.equal(await reply.sent, reply.message.exchangeId)
      const input = solver.message
      assert.equal(modelWarningCount(input), 1)
      h.event('solver', 'turn/start', { turn: 4 })
      h.event('solver', 'user/message', { content: content('Other work.'), source: {
        kind: 'bot', role: 'reply', senderSessionId: 'other', exchangeId: 'other-reply', work: 'other-work',
      } })
      h.takeInput('solver', input)
      const deferred = h.rt.live.get('solver').later
      assert.equal(deferred?.length, 1, 'the actual RESULT was deferred during other work')
      assert.equal(deferred[0].text, reviewShip)
      assert.ok(h.rt.live.get('solver').consumedResult)
      const expected = path === 'replaced request' ? 0 : 1
      let inputs = []
      if (path === 'update restart') {
        await h.rt.markUpdateStop(['solver'])
        await h.close()
        const next = fixture(t, h.home)
        next.agentOf('solver').followup = message => inputs.push(message)
        await next.rt.load()
        const keepAlive = setInterval(() => {}, 1000)
        try { await next.rt.resumesDone } finally { clearInterval(keepAlive) }
        await next.close()
      } else {
        solver.followup = message => inputs.push(message)
        if (path === 'replaced request') {
          h.rt.reviewTurnEnd('solver', { request, completed: true, wroteText: true, model: refOf(solverModel) })
          assert.equal(await requestOf(h), undefined)
          h.person('A new task has replaced the review.')
          assert.notEqual(await requestOf(h), request)
        }
        h.event('solver', 'turn/end', { reason: { kind: 'interrupted' } })
        await until(() => inputs.length > 0)
      }
      inputs = inputs.filter(message => message.source.replyTo === exchange)
      assert.equal(inputs.length, 1)
      assert.match(inputs[0].content[0].text, /Verdict: SHIP\nEvidence verified\./)
      assert.equal(modelWarningCount(inputs[0]), expected, 'the hand-back must reconstruct only the current host warning')
      if (path === 'replaced request') {
        h.event('solver', 'turn/start', { turn: 5 })
        h.takeInput('solver', inputs[0])
        assert.equal(h.rt.live.get('solver').consumedResult, undefined)
      }
    })
  }
})

test('Claude Code pins the three live aliases and selects the Opus wire from the answering session', async t => {
  const { h, adapter, wire, selections } = wireHost(t, undefined, 'opus-alias')
  const provider = 'acp-claude'
  await adapter.agents.get(provider).catalog.probeIdentityModels()
  const model = 'claude-opus-5-5'
  const id = 'reviewer'
  await h.ctx.sessionController.selectModel({ sessionId: id, provider, model })
  assert.deepEqual(selections.at(-1), { sessionId: id, provider, model })
  h.event(id, 'turn/start', { turn: 21 })
  const messages = [{ role: 'user', content: content('Review this.') }]
  const chunks = []
  for await (const chunk of adapter.stream({ provider, model, sessionId: id, messages, signal: AbortSignal.timeout(5000) })) chunks.push(chunk)
  const reports = wire(provider)
  const prompt = reports.find(row => row.method === 'session/prompt')
  assert.ok(prompt, JSON.stringify(chunks))
  assert.equal(reports.find(row => row.method === 'session/set_config_option' && row.sessionId === prompt.sessionId)?.value, 'opus')
  assert.equal(prompt.selected, 'opus')
  assert.equal(adapter.live.get(id).run.acknowledgedModel(), model)

  const models = await adapter.listModels(provider)
  for (const [alias, pin, name] of [
    ['opus', model, 'Opus 5.5'], ['fable', 'claude-fable-5-2', 'Fable 5.2'], ['haiku', 'claude-haiku-5-5', 'Haiku 5.5'],
  ]) {
    assert.deepEqual(adapter.modelIdentityOf(provider, alias), { status: 'offered', model: pin })
    assert.deepEqual(adapter.modelIdentityOf(provider, pin), { status: 'offered', model: pin })
    assert.deepEqual(models.filter(row => row.id === pin).map(row => row.name), [name])
    assert.equal((await adapter.resolveModel(provider, pin)).name, name)
  }
  assert.deepEqual(adapter.modelIdentityOf(provider, 'default'), { status: 'offered', model: 'default' })
  assert.equal((await h.rt.catalog({ fresh: true })).find(row => row.ref === 'acp-claude/default')?.solverIdentity, 'acp-claude/default')
})

test('the live Claude alias relabel refuses an explicit pin and an offered concrete row does not prove a raw alias', async t => {
  const provider = 'acp-claude'
  const model = 'claude-opus-5-5'
  const id = 'reviewer'
  const messages = [{ role: 'user', content: content('Review this.') }]
  const stream = async (adapter, model) => {
    const chunks = []
    for await (const chunk of adapter.stream({ provider, model, sessionId: id, messages, signal: AbortSignal.timeout(5000) })) chunks.push(chunk)
    return chunks
  }
  const home = mkdtempSync(join(tmpdir(), 'solver-relabel-wire-'))
  const relabel = wireHost(t, home, 'opus-relabelled')
  await relabel.adapter.agents.get(provider).catalog.probeIdentityModels()
  assert.deepEqual(relabel.adapter.modelIdentityOf(provider, model), { status: 'offered', model })
  writeFileSync(join(home, provider + '.jsonl.relabelled'), '')
  const chunks = await stream(relabel.adapter, model)
  assert.match(chunks.at(-1).reason.failure?.message ?? '', /the pinned Opus model is not offered/)
  const answering = relabel.adapter.live.get(id).run
  assert.equal(answering.option('model').options.find(row => row.value === 'opus')?.name, 'Opus 5.6')
  assert.equal(relabel.wire(provider).some(row => row.sessionId === answering.sessionId), false,
    'the answering run sent neither a model selection nor a prompt')

  const concrete = wireHost(t)
  await concrete.adapter.agents.get(provider).catalog.probeIdentityModels()
  assert.deepEqual(concrete.adapter.modelIdentityOf(provider, model), { status: 'offered', model })
  assert.deepEqual(concrete.adapter.modelIdentityOf(provider, 'opus'), { status: 'unresolved' })
  const wrong = wireHost(t, undefined, 'different-concrete')
  const unacknowledged = await stream(wrong.adapter, model)
  assert.match(unacknowledged.at(-1).reason.failure?.message ?? '', /did not acknowledge the pinned Opus model/)
  assert.equal(wrong.wire(provider).some(row => row.method === 'session/prompt'), false)
  assert.equal(wrong.adapter.live.get(id).run.acknowledgedModel(), undefined)

  await stream(concrete.adapter, 'opus')
  assert.equal(concrete.wire(provider).find(row => row.method === 'session/prompt')?.selected, 'opus')
})
