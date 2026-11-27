// RFC 0030 Q7a, amended 2026-11-23 (#2061): a crossing on a chat with history moves it to a new
// part with a handoff; only a Hermes route still refuses it. A crossing applies in place while
// the part has nothing said.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import * as instructions from '@deepseek-ai/dsh-agent-instructions'
import * as skill from '@deepseek-ai/dsh-tool-skill'
import { DICTIONARY, hostText, installLocale } from '../src/client/i18n.js'
import { SOURCE_KIND } from '../src/host/constants.js'
import { install as installFallback } from '../src/host/fallback.js'
import { install as installMemory } from '../src/host/memory.js'
import { install, saidSomething } from '../src/host/parts.js'
import { install as installReviewMark } from '../src/host/review-mark.js'
import { install as installResume } from '../src/host/resume.js'
import { resultSnapshot } from '../src/host/solver-progress.js'
import { SOLVER_DESCRIPTION } from '../src/shared/solver-method.js'
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
    inbox: { nextStep: [], nextTurn: [], remove() {}, unshift() {}, prepend() {} },
    followup() {}, inject() {}, send() {},
  }
  // A fresh part's agent, one per Session, with an inbox that keeps what it is given.
  const freshAgents = new Map()
  const freshAgent = (id) => {
    if (freshAgents.has(id)) return freshAgents.get(id)
    const inbox = {
      nextStep: [], nextTurn: [], unshift() {},
      remove(messageId) { for (const list of [inbox.nextStep, inbox.nextTurn]) { const at = list.findIndex(message => message.id === messageId); if (at >= 0) list.splice(at, 1) } },
      prepend(target, message) { (target === 'next-step' ? inbox.nextStep : inbox.nextTurn).unshift(message) },
    }
    const fresh = {
      ...agent, id, session: { ...session, id }, inbox,
      followup(message) { inbox.nextTurn.push(message) },
      inject(message) { inbox.nextStep.push(message) },
      send(message, target) { (target === 'next-step' ? inbox.nextStep : inbox.nextTurn).push(message) },
    }
    freshAgents.set(id, fresh)
    return fresh
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
      return id === 's1' ? agent : freshAgent(id)
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
    cachedCatalog: () => ['deepseek/v4', 'acp-claude/default', 'acp-codex/gpt-6.2-sol', 'deepseek-official/deepseek-flash', 'acp-hermes/default'].map(ref => ({ ref })),
    resolveModel: async ref => ref,
    noteModelChoice: () => {},
    createSession: async () => { const id = `s${++fresh}`; calls.created.push(id); return id },
  }
  install(rt)
  ctx.emit('agent/created', { agent })
  return { rt, ctx, agent, bot, calls, freshAgent }
}

// A crossing on a chat with history (RFC 0030, Handoff note, 2026-11-23): the host answers
// `switching` at once and the chat is locked while the job runs; the fresh part then holds the
// handoff package and the Bot's record moves to it with the picked model, the old part's
// segment naming the switch.
async function crossesWithHandoff(b, result, { target = 'acp-claude/default', from = 's1', freshId = 's2' } = {}) {
  assert.equal(result.status, 'switching')
  assert.equal(result.model, target)
  await waitFor(() => b.bot.sessionId === freshId && [...b.rt.switchJobs()].length === 0)
  assert.equal(b.bot.model, target)
  assert.equal(b.bot.appliedModel, target)
  assert.deepEqual(b.bot.segments.at(-1).sessionId, from)
  assert.equal(b.bot.segments.at(-1).switchedTo, target)
  const handoff = b.freshAgent(freshId).inbox.nextTurn.find(message => message.source?.handoff === true)
  assert.match(textOf(handoff?.content), /the user switched this chat from .+ to .+; you are .+ now/)
  return handoff
}

async function switchWithReview(b, { message, carried, live } = {}) {
  const turn = 3
  b.rt.live = new Map([['s1', { turn, ...live }]])
  const idle = Promise.withResolvers()
  b.agent.status = 'running'
  b.agent.whenIdle = () => idle.promise
  let cancelled
  b.agent.cancel = reason => { cancelled = reason }
  if (message !== undefined) b.ctx.emit('agent/inbox/claimed', { agent: b.agent, message, turn })

  const fresh = b.freshAgent('s2')
  const enqueue = fresh.followup
  fresh.followup = queued => {
    enqueue.call(fresh, queued)
    b.ctx.emit('agent/inbox/inserted', { agent: fresh, message: queued })
  }
  const switched = await b.rt.switchRoute('b1', 'acp-claude/default', undefined, { stopReply: true })
  const [job] = b.rt.switchJobs()
  assert.equal(switched.status, 'switching')
  assert.ok(cancelled)
  if (carried) {
    const preStep = b.ctx.listeners.get('agent/pre-step')[0]
    await preStep({ agent: b.agent, step: 1, messages: [message] }, () => assert.fail('switch let the old step run'))
  }
  b.rt.reviewReplyTurnEnd('s1', { turn, reason: { kind: 'aborted', reason: cancelled } })
  b.rt.live.delete('s1')
  b.agent.status = 'idle'
  idle.resolve()
  await job.finished
  await crossesWithHandoff(b, switched)
  b.rt.chatOwners.set('s2', 'b1')
  return fresh
}

test('TRACK1 SWITCH: a route switch preserves a carried review claim and retires a lost one', async t => {
  const dispositions = []
  for (const carried of [true, false]) {
    const b = bench()
    t.after(() => b.ctx.dispose())
    b.rt.state.bots.reviewer = { id: 'reviewer', name: 'Reviewer' }
    Object.assign(b.bot, { role: SOLVER_DESCRIPTION, reviewerId: 'reviewer' })
    installReviewMark(b.rt)
    b.rt.reviewCreated(b.bot, 'Review this change.')
    const message = {
      id: 'inbox-id',
      content: [{ type: 'text', text: 'SHIP' }],
      source: { kind: SOURCE_KIND, role: 'reply', exchangeId: 'review-reply', replyTo: 'review-work', senderSessionId: 'reviewer' },
    }
    const record = b.rt.reviewVerdict('reviewer', 'b1', undefined, 'SHIP', Date.now(), message.source)
    record()
    const fresh = await switchWithReview(b, { message, carried })
    const awaiting = fresh.inbox.nextTurn.filter(item => item.source?.replyTo === 'review-work')
    assert.equal(awaiting.length, Number(carried))
    b.rt.reviewTurnEnd('b1', { completed: true, wroteText: true })
    dispositions.push(b.bot.reviewTrack.delivered === true)
    if (carried) {
      const [exact] = awaiting
      assert.equal(exact.source.exchangeId, message.source.exchangeId)
      assert.notEqual(exact.id, message.id)
      for (const listener of b.ctx.listeners.get('session/event')) {
        listener(fresh.session, { type: 'user/message', data: { id: exact.id, source: exact.source } })
      }
      b.rt.reviewTurnEnd('b1', { completed: true, wroteText: true })
      assert.equal(b.bot.reviewTrack.delivered, true)
    }
  }
  assert.deepEqual(dispositions, [false, true], 'only the carried claim still holds delivery after settlement')
})

test('Limits + Auto switch moves designated PLAN and RESULT claims by exchange and releases a lost claim', async t => {
  for (const phase of ['plan', 'result']) {
    for (const carried of [true, false]) await t.test(`${phase} ${carried ? 'moved' : 'lost'}`, async t => {
      const b = bench()
      t.after(() => b.ctx.dispose())
      b.rt.state.bots.reviewer = { id: 'reviewer', name: 'Reviewer' }
      Object.assign(b.bot, { role: SOLVER_DESCRIPTION, reviewerId: 'reviewer' })
      installReviewMark(b.rt)
      b.rt.reviewCreated(b.bot, 'Review this change.')
      const progress = b.bot.reviewTrack.solver
      const designation = { exchangeId: 'review-work', reviewerId: 'reviewer' }
      progress.plan = { revision: 0, checks: ['test'], ...(phase === 'plan' ? { review: designation } : {}) }
      if (phase === 'result') {
        const workspace = mkdtempSync(join(tmpdir(), 'switch-text-result-'))
        t.after(() => rmSync(workspace, { recursive: true, force: true }))
        b.bot.workDir = workspace
        progress.plan.accepted = true
        progress.passed = ['test']
        progress.snapshot = resultSnapshot(workspace)
        progress.review = { ...designation, revision: 0, solverModel: 'deepseek/v4' }
      }
      const work = { from: 'b1', to: 'reviewer', at: Date.now() }
      assert.equal(b.rt.designatedReplyRequest('b1', 'reviewer', 'review-work', work), progress.request)
      const source = { kind: SOURCE_KIND, role: 'reply', exchangeId: 'review-reply', replyTo: 'review-work',
        senderSessionId: 'reviewer', reviewReceipt: 'host-receipt' }
      b.rt.reviewVerdict('reviewer', 'b1', undefined, 'SHIP', work.at, source, 'other/independent')()
      const message = { id: 'original-inbox-id', content: [{ type: 'text', text: 'SHIP' }], source }
      const fresh = await switchWithReview(b, { message, carried })
      const waiting = fresh.inbox.nextTurn.filter(input => input.source?.exchangeId === source.exchangeId)
      assert.equal(waiting.length, Number(carried))
      const finish = request => b.rt.reviewTurnEnd('b1', { completed: true, wroteText: true, request })
      finish(progress.request)
      assert.equal(b.bot.reviewTrack.delivered === true, !carried)
      if (!carried) return
      const [input] = waiting
      assert.notEqual(input.id, message.id)
      assert.deepEqual(input.source, source)
      assert.equal(b.rt.takeReviewReply(fresh.id, input, 4), undefined, 'the moved reply is not yet input')
      b.ctx.emit('agent/inbox/claimed', { agent: fresh, message: input, turn: 4 })
      assert.equal(b.rt.takeReviewReply(fresh.id, message, 4), undefined, 'the original ID cannot consume the moved reply')
      const consumed = b.rt.takeReviewReply(fresh.id, input, 4)
      assert.equal(consumed.request, progress.request)
      assert.equal(consumed.consumedResult?.replyTo, phase === 'result' ? 'review-work' : undefined)
      finish(consumed.request)
      assert.equal(b.bot.reviewTrack.delivered, true)
    })
  }
})

test('Limits + Auto switch holds a legacy RESULT without a passing snapshot', async t => {
  const b = bench()
  const workspace = mkdtempSync(join(tmpdir(), 'switch-legacy-result-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  t.after(() => b.ctx.dispose())
  b.rt.state.bots.reviewer = { id: 'reviewer', name: 'Reviewer' }
  Object.assign(b.bot, { role: SOLVER_DESCRIPTION, reviewerId: 'reviewer', workDir: workspace })
  installReviewMark(b.rt)
  b.rt.reviewCreated(b.bot, 'Review this change.')
  const progress = b.bot.reviewTrack.solver
  progress.plan = { revision: 0, checks: ['test'], accepted: true }
  progress.passed = ['test']
  progress.review = { exchangeId: 'review-work', reviewerId: 'reviewer', revision: 0, solverModel: 'deepseek/v4' }
  const source = { kind: SOURCE_KIND, role: 'reply', exchangeId: 'review-reply', replyTo: 'review-work',
    senderSessionId: 'reviewer', reviewReceipt: 'host-receipt' }
  b.rt.reviewVerdict('reviewer', 'b1', undefined, 'SHIP', Date.now(), source, 'other/independent')()
  const message = { id: 'original-inbox-id', content: [{ type: 'text', text: 'SHIP' }], source }
  const fresh = await switchWithReview(b, { message, carried: true })
  const input = fresh.inbox.nextTurn.find(row => row.source?.exchangeId === source.exchangeId)
  assert.equal(input?.source.reviewFeedback, 'images')
  assert.equal(input.source.reviewImagesWhy, 'missing')
  b.ctx.emit('agent/inbox/claimed', { agent: fresh, message: input, turn: 4 })
  const { request, consumedResult } = b.rt.takeReviewReply(fresh.id, input, 4)
  assert.equal(request, progress.request)
  b.rt.reviewTurnEnd('b1', { completed: true, wroteText: true, model: 'deepseek/v4', request, consumedResult })
  const track = b.bot.reviewTrack
  assert.equal(track.solver.request, request)
  assert.equal(track.requested, true)
  assert.notEqual(track.delivered, true)
  assert.equal(track.solver.review.verdict, 'unverified')
  assert.deepEqual(track.verdicts, [])
  assert.equal(track.last?.result, false)
  assert.equal(track.last?.done, undefined)
})

test('Limits + Auto switch continues a consumed RESULT on its original request once', async t => {
  const b = bench()
  const home = mkdtempSync(join(tmpdir(), 'switch-result-'))
  t.after(async () => {
    await b.ctx.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  Object.assign(b.rt, { home, lockTerm: () => 1, holdsLock: () => true })
  b.rt.state.bots.reviewer = { id: 'reviewer', name: 'Reviewer' }
  Object.assign(b.bot, { role: SOLVER_DESCRIPTION, reviewerId: 'reviewer' })
  installReviewMark(b.rt)
  installResume(b.rt)
  b.rt.live = new Map([['s1', { turn: 3 }]])
  b.rt.reviewCreated(b.bot, 'Review this change.')
  const progress = b.bot.reviewTrack.solver
  progress.plan = { revision: 0, checks: ['test'], accepted: true }
  progress.passed = ['test']
  const workspace = mkdtempSync(join(tmpdir(), 'switch-result-files-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  writeFileSync(join(workspace, 'result.txt'), 'Verified result.')
  b.bot.workDir = workspace
  progress.snapshot = resultSnapshot(workspace)
  progress.review = { exchangeId: 'result-work', reviewerId: 'reviewer', revision: 0, solverModel: 'deepseek/v4' }
  const workAt = Date.now()
  const source = { kind: SOURCE_KIND, role: 'reply', exchangeId: 'result-reply', replyTo: 'result-work',
    senderSessionId: 'reviewer', reviewReceipt: 'host-receipt' }
  const input = { id: 'result-input', source }
  b.rt.reviewVerdict('reviewer', 'b1', undefined, 'SHIP', workAt, source, 'other/independent')()
  b.ctx.emit('agent/inbox/claimed', { agent: b.agent, message: input, turn: 3 })
  const { consumedResult } = b.rt.takeReviewReply('s1', input, 3)
  assert.equal(consumedResult.request, progress.request)
  const fresh = await switchWithReview(b, { live: { info: source, consumedResult } })
  const handoff = fresh.inbox.nextTurn.find(message => message.source?.handoff)
  assert.equal(handoff.source.exchangeId, source.exchangeId)
  assert.ok(b.rt.deliveryNote(source.exchangeId))
  assert.equal(b.rt.takeReviewContinuation(fresh.id, structuredClone(handoff)), undefined)
  b.ctx.emit('agent/inbox/claimed', { agent: fresh, message: handoff, turn: 4 })
  b.rt.noteUpdateInbox({ agent: fresh, message: handoff }, true)
  const resumed = b.rt.takeReviewContinuation(fresh.id, handoff)
  assert.deepEqual(resumed, consumedResult)
  assert.equal(b.rt.deliveryNote(source.exchangeId), undefined)
  const finish = consumedResult => b.rt.reviewTurnEnd('b1', { completed: true, wroteText: true, model: 'deepseek/v4', request: undefined, consumedResult })
  finish(resumed)
  const mark = b.bot.reviewTrack.last
  assert.equal(mark.done, true)
  assert.equal(mark.resultExchangeId, source.replyTo)
  assert.equal(b.rt.takeReviewContinuation(fresh.id, handoff), undefined)
  finish(resumed)
  assert.equal(b.bot.reviewTrack.last, mark)
})

// A goal is the Session's, so the part that takes over starts with none: an active one moves
// with the conversation, carrying the rounds it has left, or a long loop ends at the handoff.
test('an active goal moves to the fresh part with the rounds it has left', async () => {
  const b = bench({ goal: { id: 'goal-1', revision: 4, objective: 'ship the release', phase: 'active', maxGoalRounds: 256, roundsStarted: 6 } })
  await crossesWithHandoff(b, await b.rt.switchRoute('b1', 'acp-claude/default'))
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
    await crossesWithHandoff(b, await b.rt.switchRoute('b1', 'acp-claude/default'))
    await waitFor(() => b.calls.created.length === 1)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(b.calls.goals, [], scenario.name)
  }
})

test('a host without the goal service still moves the part', async () => {
  const b = bench({ withGoals: false })
  await crossesWithHandoff(b, await b.rt.switchRoute('b1', 'acp-claude/default'))
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
      code: 'bot/refused', message: "Ops's conversation is run by a host that cannot move it.",
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
  await crossesWithHandoff(b, await b.rt.switchRoute('b1', 'acp-claude/default'))
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

test('a native kickoff answered by the fallback leaves history that an ACP pick carries over with a handoff', async t => {
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

  b.rt.applyModel = async bot => { bot.appliedModel = bot.model }
  await crossesWithHandoff(b, await b.rt.switchRoute('b1', ROUTE_B))
})

// A Hermes route keeps Q7a's refusal (the #2061 amendment leaves Hermes out).
const ROUTE_HERMES = 'acp-hermes/default'

test('a populated crossing to a Hermes route refuses before clearing Auto, saving, or selecting anything', async t => {
  const b = bench()
  t.after(() => b.ctx.dispose())
  b.agent.whenIdle = () => new Promise(() => {})
  const before = structuredClone(b.bot)
  const mutations = []
  for (const method of ['clearAuto', 'noteModelChoice', 'save', 'applyModel']) b.rt[method] = () => mutations.push(method)
  await assert.rejects(b.rt.switchRoute('b1', ROUTE_HERMES, 'high'), {
    ...historyRefusal,
    message: `${b.bot.name}'s conversation has history, so changing to ACP needs a new conversation. Use New conversation, then pick ACP.`,
  })
  assertUntouched(b, before)
  assertNoConversation(b.calls.diagnostics)
  assert.deepEqual(mutations, [])
  assert.deepEqual(b.calls.diagnostics.map(({ level, where, text }) => [level, where, text]), [
    ['warn', 'switch-route', `Route change ${ROUTE_A} → ${ROUTE_HERMES} refused (needs-new-conversation)`],
  ])
})

// Between two ACP agents the destination is the agent, by the name the model menu shows: the
// catalog's brand, else the name of an agent the owner names. A provider id is not a UI word.
// Only a crossing to or from Hermes still refuses (#2061), so the pairs touch Hermes.
test('a cross-agent refusal names the agent, never its provider id, in en, pt-BR and zh', async t => {
  const pt = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url), 'utf8'))
  for (const [from, to, catalog, name] of [
    // No catalog row for the agent: the menu's own names answer.
    ['acp-claude/default', 'acp-hermes/default', [], 'Hermes'],
    // The catalog's brand wins over the menu's own name for the same agent.
    ['acp-claude/default', 'acp-hermes/default', [{ ref: 'acp-hermes/default', provider: 'acp-hermes', providerName: 'Hermes Agent' }], 'Hermes Agent'],
    ['acp-hermes/default', 'acp-codex/gpt-6.2-sol', [], 'Codex'],
  ]) {
    const b = bench()
    t.after(() => b.ctx.dispose())
    Object.assign(b.bot, { model: from, appliedModel: from })
    b.rt.cachedCatalog = () => catalog
    const refusal = await b.rt.switchRoute('b1', to).then(() => undefined, error => error)
    assert.equal(refusal?.reason, 'needs-new-conversation', to)
    assert.equal(refusal.message,
      `Ops's conversation has history, so changing to ${name} needs a new conversation. Use New conversation, then pick ${name}.`)
    for (const [active, dictionary] of [['en', {}], ['pt-BR', pt], ['zh', DICTIONARY.zh]]) {
      const dispose = installLocale({
        register: () => () => {},
        getLocale: () => ({ active }),
        bind: () => (key, params) => (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_, param) => params?.[param] ?? _),
      })
      try {
        const worded = hostText(refusal.message)
        assert.equal(worded.split(name).length - 1, 2, `${active}: ${worded}`)
        assert.doesNotMatch(worded, /acp-/, active)
        if (active !== 'en') assert.notEqual(worded, refusal.message, active)
      } finally {
        dispose()
      }
    }
  }
})

test('a crossing refusal tells the person to pause an active goal before New conversation', async t => {
  const b = bench({ goal: { phase: 'active', objective: 'Finish the work' } })
  t.after(() => b.ctx.dispose())
  b.agent.whenIdle = () => new Promise(() => {})
  b.agent.session.deriveMessages = () => [userMessage('goal', 'Work on the current goal.')]
  await assert.rejects(b.rt.switchRoute('b1', ROUTE_HERMES), {
    ...historyRefusal,
    message: `${b.bot.name}'s conversation has history, so changing to ACP needs a new conversation. Use New conversation, then pick ACP (pause an active goal first).`,
  })
})

for (const [kind, service] of [
  ['replay throws', { get() { throw new Error('Goal replay failed') } }],
  ['reader unavailable', {}],
  ['state unreadable', { get: () => ({}) }],
]) {
  test(`a crossing still switches with a handoff and moves no goal when goal ${kind}`, async t => {
    const b = bench({ withGoals: false })
    t.after(() => b.ctx.dispose())
    b.ctx.provide('goals', service)
    await crossesWithHandoff(b, await b.rt.switchRoute('b1', ROUTE_B))
    assert.deepEqual(b.calls.goals, [])
    assert.deepEqual(b.calls.diagnostics.map(entry => entry.text), [
      `Route change ${ROUTE_A} → ${ROUTE_B} accepted`,
      `Route change ${ROUTE_A} → ${ROUTE_B} completed (handoff with a summary)`,
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

test('a rollover carrying an earlier exchange crosses with a handoff', async t => {
  const b = await freshPart(t, { rollover: true })
  assert.match(textOf(b.messages[0].content), /carry on/)
  b.fresh.whenIdle = async () => {}
  await crossesWithHandoff(b, await b.rt.switchRoute('b1', ROUTE_B), { from: 's2', freshId: 's3' })
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
    b.fresh.whenIdle = async () => {}
    await crossesWithHandoff(b, await b.rt.switchRoute('b1', ROUTE_B), { from: 's2', freshId: 's3' })
  })
}

test('a handoff with a context source still needs to match the exact opening', async t => {
  const b = await freshPart(t)
  b.messages[0] = userMessage('runtime-context', 'Continue the earlier work.', { handoff: true })
  b.fresh.whenIdle = async () => {}
  await crossesWithHandoff(b, await b.rt.switchRoute('b1', ROUTE_B), { from: 's2', freshId: 's3' })
})

for (const kind of ['schedule', 'tool-jobs', 'user-approval', 'tool-goal', 'goal', 'repeat-tool-reminder',
  'dsh-session-title-llm', 'model-selection', 'unknown-kind']) {
  test(`a fresh opening with ${kind} still has crossing history`, async t => {
    const b = await freshPart(t)
    b.messages.push(userMessage(kind, 'Work or conversation content.'))
    b.fresh.whenIdle = async () => {}
    await crossesWithHandoff(b, await b.rt.switchRoute('b1', ROUTE_B), { from: 's2', freshId: 's3' })
  })
}
