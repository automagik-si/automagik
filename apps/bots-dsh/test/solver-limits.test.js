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
import { ROUTE } from '../src/host/constants.js'
import { questionReply } from '../src/host/parts.js'
import { modelOf } from '../src/host/solver-progress.js'
import { answerSender } from '../src/host/turns.js'
import { DICTIONARY, installLocale } from '../src/client/i18n.js'
import { reviewMarkText, solverAutoView } from '../src/client/solver-draft.js'
import { stopLine } from '../src/client/stops.js'
import { solverInstructions } from '../src/shared/solver-method.js'
import { fakeContext } from './fake-ctx.js'
import { immediate, until } from './until.js'
import { ptBrLocale } from './fixtures/pt-br-locale.js'
import { NewSolver, mount, all, text } from './fixtures/solver-dialog.mjs'

const solverModel = { provider: 'fake', model: 'solver-model' }
const reviewerModel = { provider: 'fake', model: 'reviewer-model' }
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
  const verdict = (exchangeId, model = reviewerModel.model) => answerSender(h.rt, 'reviewer', {
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
  const answer = (exchangeId, shouldSend, model = reviewerModel.model) => {
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
      h.rt.reviewTurnEnd('solver', { completed: true, wroteText: true, model: solverModel.model, request })
    }
    const mark = track().last
    assert.equal(track().delivered, true)
    assert.equal(mark.done, true)
    assert.equal(mark.resultExchangeId, exchange)
    assert.equal(mark.reviewer.model, reviewerModel.model)
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
  const boundEnd = () => next.rt.reviewTurnEnd('solver', { completed: true, wroteText: true, model: solverModel.model, request })
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
  const closeRequest = () => h.rt.reviewTurnEnd('solver', { completed: true, wroteText: true, model: solverModel.model, request })
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
      h.rt.reviewTurnEnd('solver', { completed: true, wroteText: true, model: solverModel.model, request })
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
  h.ctx.acpAgents.effectiveModelOf = id => id === 'solver' ? (codex ? 'gpt-6.2-sol' : 'claude-sonnet-5-5') : undefined
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
  return { cwd, mirror }
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
  host.ctx.acpAgents.effectiveModelOf = id => id === 'reviewer' ? 'claude-sonnet-5-5' : 'gpt-6.2-sol'
  host.event('reviewer', 'user/message', { content: content('Review the result.'), source: {
    kind: 'bot', role: 'request', senderSessionId: 'solver', exchangeId,
  } })
  host.event('reviewer', 'turn/start', { turn: 2 })
  host.finish('reviewer', 'Verdict: SHIP\nEvidence verified.')
  const review = h.bot().reviewTrack.solver.review
  assert.equal(review.verdict, 'SHIP')
  assert.equal(review.solverModel, 'gpt-6.2-sol')
  assert.equal(review.reviewer.model, 'claude-sonnet-5-5')

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

test('LA-2 a Claude ACP alias cannot establish independent model identity', async t => {
  const h = await setup(t)
  const { request, send, delivered } = await reviewedPlan(h, ['check-a'])
  const direct = { provider: 'anthropic', model: 'claude-sonnet-5-5' }
  h.agentOf('solver').session.requestHeader = () => ({ config: direct })
  h.agentOf('reviewer').session.requestHeader = () => ({ config: { provider: 'acp-claude', model: 'sonnet' } })
  h.ctx.acpAgents.effectiveModelOf = () => 'sonnet'
  await checked(h, request, 'current')
  await send('result')
  h.event('reviewer', 'user/message', { content: content('Check the result.'), source: {
    kind: 'bot', role: 'request', senderSessionId: 'solver', exchangeId: delivered.at(-1).exchangeId,
  } })
  h.event('reviewer', 'turn/start', { turn: 1 })
  h.finish('reviewer', 'SHIP')
  assert.equal(h.rt.botOf('solver').reviewTrack.solver.review.verdict, 'unverified')
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
  const verdict = (exchangeId, text, model = reviewerModel.model) => answerSender(h.rt, 'reviewer', {
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
  assert.deepEqual(mark.reviewer, { id: 'reviewer', name: 'reviewer', model: reviewerModel.model })
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

function wireHost(t, home, acknowledgement = 'selected', configure, codexAcknowledgement = 'selected') {
  const traces = Object.fromEntries(['acp-claude', 'acp-codex'].map(provider => [provider, join(home, provider + '.jsonl')]))
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
  const wire = provider => readFileSync(traces[provider], 'utf8').trim().split('\n').map(line => JSON.parse(line))
  return { h, adapter, wire, selections }
}

async function dialogWire(t, acknowledgement) {
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
  await h.rt.save({ required: true })
  const rows = await h.rt.catalog({ fresh: true })
  assert.ok(rows.some(row => row.ref === configuredSolver), JSON.stringify(rows))
  const roster = { bots: [h.rt.botOf('main')], mainBotIds: ['main'], models: rows, prefs: { roles: false } }
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
  const solverRow = await pickDialogModel(picker('new-bot'), 'acp-codex', 'GPT-6 Sol', true)
  find(node => node.type === 'select').props.onChange({ target: { value: 'new' } })
  const reviewerRow = await pickDialogModel(picker('new-reviewer'), 'acp-claude', 'Sonnet 5.5', false)
  find(node => node.type === 'button' && node.props.className?.includes('bt-create-go')).props.onClick()
  await until(() => solver || failures.length || find(node => node.props?.role === 'alert') || find(node => node.type === 'button' && text(node) === 'Done'))
  assert.deepEqual(failures, [])
  if (!solver) find(node => node.type === 'button' && text(node) === 'Done')?.props.onClick()
  assert.ok(solver, text(dialog.render()))
  const reviewer = creates.find(entry => entry.payload.role === 'Reviewer').bot
  const bot = h.rt.botOf(solver.id)
  const agent = id => h.agentOf(id)
  const progress = (kind, args = {}) => h.progress(kind, args, solver.id)
  const prompt = async (id, input) => {
    const [provider, model] = h.rt.botOf(id).model.split('/')
    agent(id).session.requestHeader = () => ({ config: { provider, model } })
    const messages = [{ role: 'user', content: input.content, source: input.source }]
    const chunks = []
    for await (const chunk of adapter.stream({ provider, model, sessionId: id, messages, signal: AbortSignal.timeout(5000) })) chunks.push(chunk)
    return { chunks, text: chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block.text ?? '').join('') }
  }
  return { h, bot, solver, reviewer, solverRow, reviewerRow, creates, wire, agent, progress, prompt, adapter, cwd }
}

async function dialogResult(f, { beforeReply, takeResult = true } = {}) {
  const { h, bot, solver, reviewer, progress, agent } = f
  h.event(solver.id, 'turn/start', { turn: 2 })
  const opening = await f.prompt(solver.id, { content: content('Do the task.'), source: { kind: 'user' } })
  assert.equal(bot.model, configuredSolver)
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
    const answer = await f.prompt(reviewer.id, input)
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
        assert.equal(f.h.ctx.acpAgents.effectiveModelOf(f.reviewer.id, 'acp-claude'), 'claude-sonnet-5-5')
      } else {
        assert.match(answer.chunks.at(-1).reason.failure.message, /did not acknowledge the pinned Sonnet/)
        assert.equal(wire.filter(row => row.method === 'session/prompt').length, 0)
        assert.equal(f.h.ctx.acpAgents.effectiveModelOf(f.reviewer.id, 'acp-claude'), undefined)
        assert.equal(f.adapter.live.get(f.reviewer.id).run.option('model').currentValue, outcome === 'echo-only' ? 'sonnet' : 'default')
      }
    })
  }
})

test('conflicting ACP model fields keep the reviewer pin routed and leave RESULT unverified', async t => {
  const f = await dialogWire(t, 'dual-field-conflict')
  const { h, bot, solver, reviewer } = f
  let identity
  const { exchangeId, actual } = await dialogResult(f, { beforeReply() {
    identity = modelOf(h.rt, f.agent(reviewer.id), undefined, 3)
  } })
  const wire = f.wire('acp-claude')
  const prompt = wire.filter(entry => entry.method === 'session/prompt').at(-1)
  const pin = wire.find(entry => entry.method === 'session/set_config_option' && entry.sessionId === prompt?.sessionId)
  assert.equal(pin?.value, 'sonnet')
  assert.equal(prompt?.selected, 'sonnet')
  assert.equal(f.adapter.live.get(reviewer.id).run.option('model').currentValue, 'sonnet')
  const result = bot.reviewTrack.solver.review
  assert.equal(result.exchangeId, exchangeId)
  assert.equal(result.verdict, 'unverified')
  assert.equal(result.unverified, 'model')
  assert.equal(result.reviewer, undefined)
  assert.equal(identity, undefined)
  assert.match(actual.content.at(-1).text, /RESULT review is unverified/)
  h.finish(solver.id, 'Delivered after the RESULT reply.')
  assert.equal(bot.reviewTrack.last?.done, undefined)
})

test('an invalidated live pin gives the exact RESULT input a durable unverified notice', async t => {
  const f = await dialogWire(t, 'conflict')
  const { h, bot, solver, reviewer } = f
  const result = await dialogResult(f, { takeResult: false, async beforeReply(request) {
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
  assert.equal(h.ctx.acpAgents.effectiveModelOf(reviewer.id, 'acp-claude'), undefined)
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

test('startup upgrades only referenced aliases once, and keeps later owner choices and verdicts', async t => {
  const seed = fixture(t)
  t.after(() => rmSync(seed.home, { recursive: true, force: true, maxRetries: 5 }))
  await seed.rt.load()
  const record = (id, fields) => ({ id, name: id, role: 'Helper', createdAt: 1, ...fields })
  const unresolved = 'acp-claude/opus'
  const verdict = { request: 'a-kept-request', origin: 'person', revision: 1,
    review: { exchangeId: 'kept-exchange', reviewerId: 'reviewer', revision: 1, verdict: 'unverified' } }
  Object.assign(seed.rt.state.bots, {
    reviewer: record('reviewer', { model: aliasReviewer, appliedModel: aliasReviewer }),
    unresolved: record('unresolved', { model: unresolved, appliedModel: unresolved }),
    unrelated: record('unrelated', { model: aliasReviewer, appliedModel: aliasReviewer }),
    solver: record('solver', { role: 'Solver', reviewerId: 'reviewer', reviewTrack: { requested: true, requestAt: 1, verdicts: [], solver: verdict } }),
    second: record('second', { role: 'Solver', reviewerId: 'reviewer' }),
    third: record('third', { role: 'Solver', reviewerId: 'unresolved' }),
  })
  seed.rt.state.mainBotIds = ['solver']
  await seed.rt.save({ required: true, durable: true })
  await seed.close()

  let available = false
  const { h, selections } = wireHost(t, seed.home, 'selected', (ctx, agentOf) => {
    agentOf('reviewer').status = 'running'
    agentOf('reviewer').session.requestHeader = () => ({ config: { provider: 'acp-claude', model: 'sonnet' } })
    const resolve = ctx.acpAgents.resolveModelIdentity
    ctx.acpAgents.resolveModelIdentity = async (...args) => available ? resolve(...args) : { status: 'unavailable' }
  })
  await h.rt.load()
  await h.rt.upgradeReviewerModels()
  assert.deepEqual(selections, [])
  assert.equal(h.rt.botOf('unresolved').reviewerModelChoices, undefined)
  available = true
  await h.rt.upgradeReviewerModels()
  assert.deepEqual(selections, [], 'an active turn defers the model switch')
  h.agentOf('reviewer').status = 'idle'
  const saveCopy = h.rt.saveCopy
  h.rt.saveCopy = (change, options) => {
    h.rt.saveCopy = saveCopy
    h.agentOf('reviewer').status = 'running'
    return saveCopy(change, options)
  }
  await h.rt.upgradeReviewerModels()
  assert.equal(h.rt.botOf('reviewer').model, aliasReviewer, 'a turn that starts before commit fences the write')
  assert.equal(h.rt.botOf('reviewer').reviewerModelChoices, undefined)
  assert.deepEqual(selections.splice(0).map(row => row.model), ['claude-sonnet-5-5', 'sonnet'], 'restore the prior Session selection')
  h.agentOf('reviewer').status = 'idle'
  await h.rt.upgradeReviewerModels()
  assert.deepEqual(selections, [{ sessionId: 'reviewer', provider: 'acp-claude', model: 'claude-sonnet-5-5' }])
  const disk = () => JSON.parse(readFileSync(join(h.home, 'state.json'), 'utf8')).bots
  assert.equal(disk().reviewer.model, configuredReviewer)
  assert.equal(disk().reviewer.appliedModel, configuredReviewer)
  assert.equal(disk().unresolved.model, unresolved)
  assert.equal(disk().unrelated.model, aliasReviewer)
  assert.deepEqual(disk().solver.reviewTrack.solver.review, verdict.review)
  assert.equal(h.rt.solverStatusOf(h.rt.botOf('third')).solverStatus.reviewerModelChoice, true)

  await h.rt.updateBot('reviewer', { model: aliasReviewer })
  assert.equal(disk().reviewer.model, aliasReviewer)
  await h.close()
  const restarted = wireHost(t, seed.home)
  await restarted.h.rt.load()
  await restarted.h.rt.upgradeReviewerModels()
  assert.equal(restarted.h.rt.botOf('reviewer').model, aliasReviewer)
  assert.equal(restarted.h.rt.botOf('reviewer').reviewerModelChoices[aliasReviewer], 'applied')
  assert.equal(restarted.h.rt.botOf('unresolved').reviewerModelChoices[unresolved], 'unresolved')
  assert.deepEqual(restarted.selections, [])
  assert.deepEqual(disk().solver.reviewTrack.solver.review, verdict.review)
})

test('New Solver host refuses an alias payload and the same concrete model across routes', async t => {
  const { h, solver, reviewer } = await dialogWire(t)
  const aliased = await h.call('create-bot', { name: 'Unpinned', role: 'Reviewer', model: aliasReviewer, solverModelChoice: true })
  assert.equal(aliased.ok, false)
  assert.match(aliased.error.message, /Choose a specific model/)
  const original = h.rt.botOf(reviewer.id).model
  const list = h.ctx.llm.listProviders
  const models = h.ctx.llm.listModels
  h.ctx.llm.listProviders = () => [...list(), { id: 'anthropic', name: 'Anthropic' }]
  h.ctx.llm.listModels = provider => provider === 'anthropic' ? [{ id: 'claude-sonnet-5-5-20261001', name: 'Sonnet' }] : models(provider)
  const refusal = await h.call('create-bot', { name: 'Same reviewer model', role: 'Solver',
    model: 'anthropic/claude-sonnet-5-5-20261001', reviewerId: reviewer.id, solverModelChoice: true })
  assert.equal(refusal.ok, false)
  assert.match(refusal.error.message, /Choose a different model for the reviewer/)
  assert.equal(h.rt.botOf(reviewer.id).model, original)
  assert.equal(h.rt.botOf(solver.id).model, configuredSolver)
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
          h.rt.reviewTurnEnd('solver', { request, completed: true, wroteText: true, model: solverModel.model })
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

test('identity round 2 trusts only the requested ACP model in the answering turn', async t => {
  for (const [provider, model, acknowledgement, expected] of [
    ['acp-codex', 'gpt-6-sol', 'echo-only', undefined],
    ['acp-codex', 'gpt-6-sol', 'already-current', 'gpt-6-sol'],
    ['acp-codex', 'gpt-6-sol', 'conflict', undefined],
    ['acp-claude', 'claude-opus-5-5', 'different-concrete', undefined],
    ['acp-claude', 'claude-sonnet-5-5', 'selected', 'claude-sonnet-5-5'],
  ]) {
    await t.test(`${provider}/${model}: ${acknowledgement}`, async t => {
      const home = mkdtempSync(join(tmpdir(), 'solver-answering-acp-'))
      t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
      const { h, adapter, wire } = wireHost(t, home, acknowledgement, undefined, acknowledgement)
      const id = 'reviewer'
      const session = h.agentOf(id).session
      h.event(id, 'turn/start', { turn: 21 })
      const messages = [{ role: 'user', content: content('Review this.') }]
      const prompt = async () => {
        let answer = ''
        for await (const chunk of adapter.stream({ provider, model, sessionId: id, messages, signal: AbortSignal.timeout(5000) })) {
          if (chunk.type === 'block-end') answer += chunk.block.text ?? ''
        }
        assert.equal(answer, reviewShip)
      }
      await prompt()
      const current = wire(provider).find(row => row.method === 'session/prompt')
      assert.ok(current)
      const identity = turn => h.ctx.acpAgents.effectiveModelOf(id, provider, model, turn)
      assert.equal(identity(21), expected, 'only a live acknowledgement of the requested pin can identify the answer')
      if (expected) {
        h.event(id, 'turn/start', { turn: 22 })
        assert.equal(identity(22), undefined, 'a reused ACP session has not prompted this turn yet')
        assert.equal(identity(21), undefined, 'starting a new turn retires the previous turn proof')
        await prompt()
        assert.equal(wire(provider).at(-1).sessionId, current.sessionId)
        assert.equal(identity(22), expected)
        adapter.noteEvent(session, { type: 'model/selection', data: { provider } })
        assert.equal(identity(22), undefined)
      }
    })
  }
})

async function checkCodexReviewerUpgrade(t, acknowledgement) {
  const defaultRef = 'acp-codex/default'
  const resolved = acknowledgement === 'own-model'
  const seed = fixture(t)
  t.after(() => rmSync(seed.home, { recursive: true, force: true, maxRetries: 5 }))
  await seed.rt.load()
  const kept = { exchangeId: 'old-exchange', reviewerId: 'reviewer', revision: 1, verdict: 'SHIP' }
  const put = (id, fields) => seed.rt.state.bots[id] = { id, name: id, createdAt: 1, ...fields }
  put('reviewer', { model: defaultRef, appliedModel: defaultRef, role: 'Reviewer' })
  put('solver', { role: 'Solver', reviewerId: 'reviewer', reviewTrack: { requested: true, requestAt: 1,
    verdicts: [], solver: { request: 'kept-request', origin: 'person', revision: 1, review: kept } } })
  put('second', { role: 'Solver', reviewerId: 'reviewer' })
  seed.rt.state.mainBotIds = ['solver']
  await seed.rt.save({ required: true, durable: true })
  await seed.close()

  let available = false
  const resolutions = []
  const { h, selections } = wireHost(t, seed.home, 'selected', ctx => {
    const resolve = ctx.acpAgents.resolveModelIdentity
    ctx.acpAgents.resolveModelIdentity = async (...args) => {
      resolutions.push(args)
      return available ? resolve(...args) : { status: 'unavailable' }
    }
  }, acknowledgement)
  await h.rt.load()
  await h.rt.upgradeReviewerModels()
  assert.equal(h.rt.botOf('reviewer').reviewerModelChoices, undefined)
  available = true
  resolutions.length = 0
  await h.rt.upgradeReviewerModels()
  await h.rt.upgradeReviewerModels()
  const disk = JSON.parse(readFileSync(join(h.home, 'state.json'), 'utf8')).bots
  assert.equal(disk.reviewer.reviewerModelChoices?.[defaultRef], resolved ? 'applied' : 'unresolved',
    'the supported Codex alias needs a durable disposition')
  assert.deepEqual(resolutions, [['acp-codex', 'default']])
  assert.equal(disk.reviewer.model, resolved ? configuredSolver : defaultRef)
  assert.deepEqual(disk.solver.reviewTrack.solver.review, kept)
  assert.deepEqual(selections, resolved ? [{ sessionId: 'reviewer', provider: 'acp-codex', model: 'gpt-6-sol' }] : [])
  assert.equal(h.rt.solverStatusOf(h.rt.botOf('second')).solverStatus.reviewerModelChoice, resolved ? undefined : true)
  await h.close()
}

test('identity round 2 disposes the Codex default once for a shared reviewer', async t => {
  await t.test('provider Default remains unresolved', t => checkCodexReviewerUpgrade(t, 'selected'))
  await t.test('host Default resolves from the live choice', t => checkCodexReviewerUpgrade(t, 'own-model'))
})
