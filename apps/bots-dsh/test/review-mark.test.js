// #2056 (RFC 0048, delivery 1): the Solver's "unreviewed" mark. The host dates a Solver's work
// calls and its reviewer's verdicts per request and marks each delivery with what it saw. It
// grants and refuses nothing.
import { Session, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import assert from 'node:assert/strict'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { ROUTE } from '../src/host/constants.js'
import { isNotesPath, isNotesWrite, isWorkCall } from '../src/host/review-mark.js'
import { resultSnapshot } from '../src/host/solver-progress.js'
import { reviewMarkText } from '../src/client/solver-draft.js'
import { answerSender } from '../src/host/turns.js'
import { guardVerdictOf } from '../src/shared/review-guard.js'
import { deliveryMark, verdictOf } from '../src/shared/review-mark.js'
import { CALLER_BOT_KEYS } from '../src/host/caller-view.js'
import { fakeContext } from './fake-ctx.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
// Each step a few ms apart, so the order of work and verdicts is never a tie.
const step = () => wait(3)

test('#2134 K7a AW-R7 result credit belongs to the current exchange and revision', async t => {
  for (const invalidate of [false, true]) {
    await t.test(invalidate ? 'invalidated result' : 'current result', async t => {
      const { rt, reviewer, solver } = bench(t)
      const judge = await reviewer()
      const bot = await solver({ reviewerId: judge.id })
      let now = 100
      t.mock.method(Date, 'now', () => ++now)
      const request = await rt.reviewRequest(bot.id, { text: 'Fixture request' })
      rt.reviewVerdict(judge.id, bot.id, undefined, 'SHIP', Date.now())
      rt.reviewWork(bot, true, 'bash', { command: 'synthetic' })
      bot.reviewTrack.solver.review = { revision: 0, exchangeId: 'result', reviewerId: judge.id, solverModel: 'acp-claude/fixture' }
      await rt.reviewVerdict(judge.id, bot.id, undefined, 'RESULT SHIP', Date.now(),
        { replyTo: 'result', reviewReceipt: 'fixture-receipt' }, 'acp-codex/fixture')
      if (invalidate) {
        bot.reviewTrack.solver.revision += 1
        delete bot.reviewTrack.solver.review
      }
      rt.reviewTurnEnd(bot.id, { completed: true, wroteText: true, request, model: 'acp-claude/fixture' })
      assert.equal(bot.reviewTrack.last.plan, false)
      assert.equal(bot.reviewTrack.last.result, !invalidate)
      assert.equal(bot.reviewTrack.last.done, undefined)
    })
  }
})

test('#2134 K7b AW-R7 settlement crossing a request or revision stays uncertain', async t => {
  const { rt, solver } = bench(t)
  const bot = await solver()
  let now = 100
  t.mock.method(Date, 'now', () => ++now)
  await rt.reviewRequest(bot.id, { text: 'First fixture' })
  const admit = () => ({
    bot, requestAt: bot.reviewTrack.requestAt, request: bot.reviewTrack.solver.request,
    revision: bot.reviewTrack.solver.revision, at: Date.now(),
  })
  const settle = token => rt.reviewWork(bot, true, 'acp_tool', { kind: 'execute', input: { command: 'synthetic' } },
    undefined, undefined, { at: token.at, admit: token })
  const a = admit()
  bot.reviewTrack.delivered = true
  await rt.reviewRequest(bot.id, { text: 'Second fixture' })
  settle(a)
  assert.equal(bot.reviewTrack.firstWorkAt, bot.reviewTrack.requestAt)
  assert.ok(bot.reviewTrack.uncertainWorkAt > bot.reviewTrack.requestAt)
  const b = admit()
  bot.reviewTrack.solver.revision += 1
  settle(b)
  assert.ok(bot.reviewTrack.uncertainWorkAt > b.at)
  assert.equal(bot.reviewTrack.solver.revision, 1)
})

test('#2134 source 7 the designated result survives reply-history eviction and reload', async t => {
  for (const invalidate of [false, true]) {
    await t.test(invalidate ? 'invalidated result' : 'current result', async t => {
      const { rt, reviewer, solver, reply, resultReply, reload } = bench(t)
      const judge = await reviewer()
      const bot = await solver({ reviewerId: judge.id })
      const request = await rt.reviewRequest(bot.id, { text: 'Synthetic delivery' })
      rt.reviewWork(bot, true, 'write', { file_path: 'fixture.txt' })
      await step()
      await resultReply(bot, judge)
      assert.equal(bot.reviewTrack.solver.review.verdict, 'SHIP')
      for (let i = 0; i < 5; i += 1) reply(judge.id, bot.id, 'SHIP')
      assert.equal(bot.reviewTrack.verdicts.length, 4)
      assert.ok(bot.reviewTrack.verdicts.every(item => item.stage === undefined))
      if (invalidate) bot.reviewTrack.solver.revision += 1
      const recovered = await reload()
      recovered.reviewTurnEnd(bot.id, { completed: true, wroteText: true, request })
      assert.equal(recovered.botOf(bot.id).reviewTrack.last.result, !invalidate)
    })
  }
})

test('#2134 K7d a verified Done result cannot supply the unreviewed plan flag', async t => {
  const { rt, reviewer, solver, home } = bench(t)
  const judge = await reviewer()
  const bot = await solver({ reviewerId: judge.id })
  bot.workDir = join(home, 'fixture-work')
  mkdirSync(bot.workDir)
  writeFileSync(join(bot.workDir, 'marker.txt'), 'synthetic result')
  let now = Date.now()
  t.mock.method(Date, 'now', () => ++now)
  const request = await rt.reviewRequest(bot.id)
  const plan = { checks: ['marker'], revision: 0, review: { exchangeId: 'plan', reviewerId: judge.id } }
  bot.reviewTrack.solver.plan = plan
  rt.reviewWork(bot, true, 'bash', { command: 'inert observation' })
  rt.reviewVerdict(judge.id, bot.id, undefined, 'PLAN SHIP', Date.now(),
    { replyTo: 'plan', reviewReceipt: 'receipt-plan' }, 'acp-codex/reviewer')
  const progress = bot.reviewTrack.solver
  const snapshot = resultSnapshot(bot.workDir)
  assert.ok(snapshot)
  progress.snapshot = snapshot
  progress.passed = ['marker']
  progress.passRuns = { marker: 'verified' }
  progress.runs = { verified: { revision: progress.revision, evidence: { snapshot } } }
  progress.review = { exchangeId: 'result', reviewerId: judge.id, revision: progress.revision, solverModel: 'acp-claude/solver' }
  await rt.reviewVerdict(judge.id, bot.id, undefined, 'RESULT SHIP', Date.now(),
    { replyTo: 'result', reviewReceipt: 'receipt-result' }, 'acp-codex/reviewer')
  rt.reviewTurnEnd(bot.id, { completed: true, wroteText: true, request, model: 'acp-claude/solver' })
  const { last, outcome } = bot.reviewTrack
  assert.equal(outcome.done, true)
  assert.equal(last.done, true)
  assert.equal(last.result, true)
  assert.equal(last.plan, false)
  assert.equal(reviewMarkText({ ...bot, reviewMark: last }, { byId: rt.state.bots }),
    `Plan unreviewed: ${judge.name} gave no verdict before the work started.\nDone: every check passed and ${judge.name} approved.`)
})

function bench(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-review-mark-'))
  const sessions = new Map()
  const agents = new Map()
  let created = 0
  const services = { agents: { list: () => [...agents.values()], get: id => agents.get(id) } }
  const props = {
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: `w${created}`, path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async options => ({ sessionId: options.sessionId ?? `s${++created}` }),
      resolveAgent: async (sessionId) => {
        if (!agents.has(sessionId)) {
          agents.set(sessionId, { session: sessions.get(sessionId) ?? { id: sessionId }, ctx: { tools: { restrict: () => () => {} }, effect: execute => execute() } })
        }
        return { agent: agents.get(sessionId) }
      },
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { get: sessionId => sessions.get(sessionId), flush: async () => {} },
  }
  let ctx
  let rt
  let route
  const loadPlugin = () => {
    ctx = fakeContext({ services })
    ctx.tools.schemas = () => ['bash', 'read', 'write', 'edit'].map(name => ({ name }))
    ctx.tools.view = () => ({ restrictableNames: new Set(['bash', 'read', 'write', 'edit']), knownNames: new Set(['bash', 'read', 'write', 'edit']) })
    Object.assign(ctx, props)
    const register = ctx.connection.fetch.register
    ctx.connection.fetch.register = (options) => {
      if (options.path === ROUTE) route = options
      return register(options)
    }
    apply(ctx, { home })
    rt = ctx.provided.get('omniTeam')
  }
  loadPlugin()
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const reload = async () => {
    await rt.save()
    await ctx.dispose()
    loadPlugin()
    await rt.load()
    return rt
  }
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const guard = (exec) => (ctx.listeners.get('tools/execute') ?? [])[0](exec, async () => 'ran')
  let seq = 0
  const event = (sessionId, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) listener({ id: sessionId }, { type, seq: ++seq, time: Date.now(), data })
  }
  const recordedReplies = new Set()
  // The mark unit cases simulate verdicts the Solver has already read. The race
  // cases opt into real host delivery and control when their fake agent reads it.
  const replyInbox = (sessionId) => {
    const agent = agents.get(sessionId)
    recordedReplies.add(sessionId)
    const nextTurn = []
    agent.inbox = { nextStep: [], nextTurn }
    agent.followup = (message) => {
      const start = nextTurn.length
      nextTurn.push(message)
      event(sessionId, 'agent/inbox/spliced', { target: 'next-turn', start, inserted: [message] })
      ctx.emit('agent/inbox/inserted', { agent, message })
    }
    return nextTurn
  }
  const takeReply = (sessionId, inbox, replyTo, { admitted = true } = {}) => {
    const message = inbox.shift()
    assert.equal(message?.source.replyTo, replyTo)
    assert.equal(message.source.role, 'reply')
    const turn = seq + 1
    event(sessionId, 'turn/start', { turn })
    event(sessionId, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
    ctx.emit('agent/inbox/claimed', { agent: agents.get(sessionId), message, turn })
    if (admitted) event(sessionId, 'user/message', { id: message.id, content: message.content, source: message.source })
  }
  const text = value => [{ type: 'text', text: value }]
  // A person's message in the chat, and a turn that ends with `reply` (or nothing).
  const person = (sessionId, value) => {
    event(sessionId, 'turn/start', { turn: seq + 1 })
    event(sessionId, 'user/message', { content: text(value), source: { kind: 'user' } })
  }
  const endTurn = (sessionId, reply, reason = { kind: 'completed' }) => {
    if (reply) event(sessionId, 'assistant/message', { message: { content: text(reply) } })
    event(sessionId, 'turn/end', { turn: rt.live.get(sessionId)?.turn ?? seq, reason })
  }
  // The reviewer answering the Solver's request (the path every reply takes, turns.js), on the work
  // message_bot opened for it now (`opened: false`: a reply whose work is gone; `exchangeId`: a given one).
  const reply = (fromId, toId, value, { opened = true, exchangeId = `x${++seq}`, model, ...extra } = {}) => {
    if (opened && rt.state.works?.[exchangeId] === undefined) rt.openWork(exchangeId, { from: toId, to: fromId })
    let settled
    const host = recordedReplies.has(toId) ? rt : { __proto__: rt, async deliver(_message, { onReplyRecorded, closeReviewWork }) {
      if (closeReviewWork) settled = onReplyRecorded.ready.then(closeReviewWork)
      return settled
    } }
    answerSender(host, fromId, { exchangeId, senderSessionId: toId, ...extra }, value, undefined, undefined, model)
    return settled
  }
  const designate = (stage, bot, reviewer, exchangeId = `designated-${++seq}`) => {
    const progress = bot.reviewTrack.solver
    assert.ok(progress?.request)
    const identity = { exchangeId, reviewerId: reviewer.id }
    if (stage === 'plan') progress.plan = { checks: ['fixture'], revision: progress.revision, review: identity }
    else progress.review = { ...identity, revision: progress.revision, solverModel: 'acp-claude/fixture' }
    return exchangeId
  }
  const planReply = (bot, reviewer, value = 'PLAN SHIP', exchangeId) =>
    reply(reviewer.id, bot.id, value, { exchangeId: designate('plan', bot, reviewer, exchangeId) })
  const resultReply = (bot, reviewer, value = 'RESULT SHIP', exchangeId) =>
    reply(reviewer.id, bot.id, value, {
      exchangeId: designate('result', bot, reviewer, exchangeId), model: 'acp-codex/fixture',
    })
  // A Solver as the dialog makes it, through the person's create-bot route.
  const solver = async ({ reviewerId, brief = '' } = {}) => {
    const answer = await call('create-bot', { name: `Solver ${++created}`, role: 'Solver', instructions: 'Method.', brief, ...(reviewerId ? { reviewerId } : {}) })
    assert.equal(answer.ok, true, JSON.stringify(answer))
    return rt.botOf(answer.value.id)
  }
  const reviewer = async () => rt.createBot({ name: `Reviewer ${++created}`, role: 'Reviewer', instructions: 'Review.', pickModel: true })
  return { ctx, rt, home, call, guard, person, endTurn, reply, designate, planReply, resultReply, solver, reviewer, sessions, event, replyInbox, takeReply, reload }
}

// F9 (APP-TEST "Recheck on 262488524"): a Codex reviewer's replies, word for word with every name
// taken out. Its progress sentence and its verdict arrive run together on the first line.
const CODEX_REPLIES = [
  ["I'll check the delivered file against the request and the supplied evidence. SHIP", 'SHIP'],
  ['I\u2019ll check the note\u2019s line count and accuracy against the original request, and review whether the plan covers it. FIX-FIRST\n\n'
    + 'The plan covers the requested file, three-line format, and accuracy check. The result has three lines, but [note.md:2] makes an absolute claim that any input change produces a completely different checksum. SHA-256 outputs can collide, and a changed input does not guarantee that every output bit changes.\n\n'
    + 'Replace that claim with \u201cA change to the input will almost certainly produce a different checksum.\u201d Then deliver the file.', 'FIX-FIRST'],
  ['I\u2019ll read the note and check its three lines against the request and the plan.FIX-FIRST\n\n'
    + 'The plan matches the request, and note.md contains three lines. However, line 2 claims that any change produces a different checksum and reveals tampering. SHA-256 collisions are possible, so this is not guaranteed. Change it to say that a change will almost certainly produce a different checksum.\n\n'
    + 'Line 3 should also say that the published checksum must come from a trusted source; otherwise, an attacker could replace both the download and its checksum.', 'FIX-FIRST'],
  ['I\u2019ll re-read the revised file and check its wording and line count.SHIP\n\n'
    + 'Unsaved note contains three lines explaining a SHA-256 checksum and how to use it. The revised wording addresses the earlier concerns.', 'SHIP'],
]

test('verdictOf reads a whole-word verdict at the start of any line, after "Verdict:", or ending a sentence\'s line; the last one wins', () => {
  for (const [value, verdict] of [
    ['SHIP', 'SHIP'], ['SHIP\nAll checks hold.', 'SHIP'], ['FIX-FIRST (plan)\n1. ...', 'FIX-FIRST'], ['BLOCKED: no access', 'BLOCKED'],
    ['**SHIP**', 'SHIP'], ['# FIX-FIRST', 'FIX-FIRST'], ['> BLOCKED', 'BLOCKED'], ['`SHIP`', 'SHIP'], ['\n\n  SHIP', 'SHIP'], ['_SHIP_', 'SHIP'],
    // F9: after a lead-in line, after "Verdict:", and the last such line.
    ['Looks good.\nSHIP', 'SHIP'], ['I read the file and ran the checks.\n\nFIX-FIRST\n1. Line 2 overclaims.', 'FIX-FIRST'],
    ['Verdict: SHIP', 'SHIP'], ['**Verdict:** BLOCKED (no access)', 'BLOCKED'], ['Final verdict: FIX-FIRST', 'FIX-FIRST'],
    ['FIX-FIRST\n1. Fix line 2.\nRe-checked after the fix:\nSHIP', 'SHIP'], ['SHIP\nVerdict: BLOCKED', 'BLOCKED'], ['SHIP\r\nAll good.', 'SHIP'],
    ...CODEX_REPLIES,
  ]) assert.equal(verdictOf(value), verdict, value)
  for (const value of [
    'SHIPPED', 'SHIPPING', 'ship', '', '   ', 'FIX-FIRSTLY', 'SHIP-IT', 'SHIP2', undefined, null, 7,
    // Mid-line, or inside a word, never counts.
    'This is not a SHIP yet.', 'not a SHIP yet', 'Looks fine to me, a SHIP from me.', 'Answer first with one verdict, SHIP, FIX-FIRST or BLOCKED, then the evidence.',
    'It is a SHIP', 'Is this a SHIP?', 'The plan is fine. SHIPPING it later.', 'Done. SHIP it once the tests pass.', 'verdict: ship', 'NOTSHIP', 'reSHIP',
    // SR5-2: an echoed option list, a question, a list of options, a fenced block.
    'SHIP, FIX-FIRST or BLOCKED.', 'You asked for one verdict:\nSHIP, FIX-FIRST or BLOCKED.\nI could not open the file.', 'SHIP? no.', 'SHIP ? no.',
    'FIX-FIRST or SHIP', 'SHIP / FIX-FIRST / BLOCKED', 'Verdict: SHIP, FIX-FIRST or BLOCKED', '**SHIP**, FIX-FIRST or BLOCKED',
    'The options are:\n* SHIP\n* FIX-FIRST\n* BLOCKED', 'The options are:\n- SHIP\n- FIX-FIRST\n- BLOCKED', 'Options:\n1. SHIP\n2. FIX-FIRST\n3. BLOCKED',
    '> * SHIP', '+ SHIP', '```\nSHIP\n```', '```text\nFIX-FIRST\n```\nI could not open the file.', '```SHIP```', '  ```\n  BLOCKED',
    // SR6-2: a tilde fence, and options joined by "and", "vs", a dash or a bracket.
    '~~~\nSHIP\n~~~', 'SHIP and FIX-FIRST are the two choices.', 'SHIP vs FIX-FIRST', 'SHIP - FIX-FIRST - BLOCKED', 'SHIP (or FIX-FIRST)',
  ]) assert.equal(verdictOf(value), undefined, String(value))
  // SR5-2: a verdict still counts after a fenced block, with a comment after a comma, and after "Verdict:" in a list item.
  for (const [value, verdict] of [
    ['```\nSHIP\n```\nFIX-FIRST\nLine 2 overclaims.', 'FIX-FIRST'], ['SHIP, with one note below.', 'SHIP'], ['FIX-FIRST: line 2, then SHIP', 'FIX-FIRST'],
    ['- **Verdict:** SHIP', 'SHIP'], ['Checked.\n* Verdict: BLOCKED (no access)', 'BLOCKED'], ['SHIP\n```\nnpm test\n```', 'SHIP'], ['I checked it. Ready? SHIP', 'SHIP'],
    // SR6-2: a dash followed by a comment, not by another verdict word, still counts.
    ['SHIP - all checks pass', 'SHIP'], ['SHIP \u2014 all checks pass', 'SHIP'],
  ]) assert.equal(verdictOf(value), verdict, value)
})

// #2056 F3: a Codex reviewer's progress sentence glued to its verdict and a spaced dash (S4).
test('verdictOf reads a verdict glued to a sentence\'s end before a spaced dash; quoted, indented or spaced lines are not read this way', () => {
  for (const [value, verdict] of [
    ["I'll inspect the delivered file directly and verify the two lines.SHIP — bom.md contains two lines.", 'SHIP'],
    ["I'll read the note and check its line count against the request.BLOCKED — bom.md was not found.", 'BLOCKED'],
    ['**I checked the plan.SHIP** — fine', 'SHIP'],
  ]) assert.equal(verdictOf(value), verdict, value)
  for (const value of [
    '“He said done.SHIP — later”', "'He said done.SHIP — later'", '‘done.SHIP — x’', '«done.SHIP — x»',
    '„done.SHIP — x“', 'The note reads “ready.”SHIP — ok', '    I checked.SHIP — fine',
    // S6H-1: other quote marks, and a zero-width character before a leading quote.
    'He wrote ‘done.SHIP — x’', '‹done.SHIP — x›', '「done.SHIP — x」', "​'He said done.SHIP — later'",
    // S6H-2: spaces then a tab indent a code line too.
    '  \tI checked.SHIP — fine',
    // A space before the verdict is mid-sentence, as before.
    'Done. SHIP — later',
  ]) assert.equal(verdictOf(value), undefined, value)
})

test('a work call on every route: DSH tools, the dsh bridge, and an ACP agent\'s own tools', () => {
  // DSH-tool routes (DSH models; Claude Code, Codex, omp with native tools off through the dsh bridge).
  for (const name of ['write', 'edit', 'str_replace_editor', 'apply_patch', 'bash', 'pwsh', 'terminal_send', 'start_task',
    'mcp__dsh__write', 'mcp__dsh__edit', 'mcp__dsh__apply_patch', 'mcp__dsh__bash']) assert.equal(isWorkCall(name, {}), true, name)
  // A tool that takes a command is a shell tool whatever its name.
  assert.equal(isWorkCall('runner', {}, { parameters: { properties: { command: {} } } }), true)
  // An ACP agent's own call, mirrored as acp_tool (Claude Code and Codex with native tools on).
  for (const kind of ['edit', 'delete', 'move', 'execute']) assert.equal(isWorkCall('acp_tool', { kind, title: kind, input: {} }), true, kind)
  assert.equal(isWorkCall('acp_tool', { kind: 'other', input: { command: 'make' } }), true)
  assert.equal(isWorkCall('acp_tool', { input: { cmd: 'ls' } }), true)
  // Research is not work.
  for (const name of ['read', 'grep', 'glob', 'web_fetch', 'list_bots', 'message_bot', 'mcp__dsh__message_bot', 'mcp__dsh__list_bots', 'task', '']) {
    assert.equal(isWorkCall(name, {}), false, name)
  }
  for (const kind of ['read', 'search', 'fetch', 'think', 'other', undefined]) assert.equal(isWorkCall('acp_tool', { kind, input: {} }), false, String(kind))
  assert.equal(isWorkCall('acp_tool', { kind: 'other', image: true, input: { command: 'x' } }), false)
  assert.equal(isWorkCall('acp_tool', null), false)
})

test('deliveryMark: plan missing, result missing, both present, both missing, fresh session, none', () => {
  const verdict = at => ({ verdict: 'SHIP', at })
  assert.deepEqual(deliveryMark({ firstWorkAt: 10, lastWorkAt: 20, verdicts: [verdict(30)] }, 'bot', 40), { at: 40, review: 'bot', plan: false, result: true })
  assert.deepEqual(deliveryMark({ firstWorkAt: 10, lastWorkAt: 20, verdicts: [verdict(5)] }, 'bot', 40), { at: 40, review: 'bot', plan: true, result: false })
  assert.deepEqual(deliveryMark({ firstWorkAt: 10, lastWorkAt: 20, verdicts: [verdict(5), verdict(25)] }, 'bot', 40), { at: 40, review: 'bot', plan: true, result: true })
  assert.deepEqual(deliveryMark({ firstWorkAt: 10, lastWorkAt: 20, verdicts: [verdict(15)] }, 'bot', 40), { at: 40, review: 'bot', plan: false, result: false })
  assert.deepEqual(deliveryMark({ verdicts: [] }, 'bot', 40), { at: 40, review: 'bot', plan: false, result: false })
  // No work call seen: the first verdict counts for the plan, a second one for the result.
  assert.deepEqual(deliveryMark({ verdicts: [verdict(5)] }, 'bot', 40), { at: 40, review: 'bot', plan: true, result: false })
  assert.deepEqual(deliveryMark({ verdicts: [verdict(5), verdict(6)] }, 'bot', 40), { at: 40, review: 'bot', plan: true, result: true })
  // SR6-1: only notes writes seen (no firstWorkAt): the plan needs its own verdict before the last
  // notes write, the result one after it, so one verdict never reviews both.
  assert.deepEqual(deliveryMark({ lastWorkAt: 30, verdicts: [verdict(20), verdict(40)] }, 'bot', 50), { at: 50, review: 'bot', plan: true, result: true })
  assert.deepEqual(deliveryMark({ lastWorkAt: 30, verdicts: [verdict(40)] }, 'bot', 50), { at: 50, review: 'bot', plan: false, result: true })
  // A work call at the same moment as a verdict is not ordered: neither side counts it.
  assert.deepEqual(deliveryMark({ firstWorkAt: 10, lastWorkAt: 10, verdicts: [verdict(10)] }, 'bot', 40), { at: 40, review: 'bot', plan: false, result: false })
  assert.deepEqual(deliveryMark({ verdicts: [verdict(5)] }, 'fresh', 40), { at: 40, review: 'fresh' })
  // Delivered while the reviewer still had the work (Run 3): the same mark, said pending; never for fresh or none.
  assert.deepEqual(deliveryMark({ firstWorkAt: 10, lastWorkAt: 20, verdicts: [verdict(5)] }, 'bot', 40, { pending: true }), { at: 40, review: 'bot', plan: true, result: false, pending: true })
  assert.deepEqual(deliveryMark({ verdicts: [] }, 'fresh', 40, { pending: true }), { at: 40, review: 'fresh' })
  assert.deepEqual(deliveryMark({ verdicts: [verdict(5)] }, 'none', 40), { at: 40, review: 'none' })
})

// APP-TEST F7 run 2: the Solver wrote its file before any plan review, then sent one combined review.
test('a Solver that wrote before its plan review is marked plan unreviewed; the view shows the mark, never the timestamps', async (t) => {
  const { rt, call, guard, person, endTurn, resultReply, solver, reviewer } = bench(t)
  const ada = await reviewer()
  const bot = await solver({ reviewerId: ada.id })
  assert.equal(bot.reviewerId, ada.id)
  person(bot.id, 'Write a one-page comparison.')
  await step()
  assert.equal(await guard({ name: 'acp_tool', arguments: { kind: 'edit', title: 'Write bom.md', input: { file_path: 'bom.md' } }, agent: { id: bot.id } }), 'ran')
  await step()
  // message_bot opened the review: the turn that ends to wait for it is not a delivery.
  rt.openWork('w-review', { from: bot.id, to: ada.id })
  endTurn(bot.id, 'Sent my plan and work for review.')
  assert.equal(bot.reviewTrack.last, undefined)
  await step()
  await resultReply(bot, ada, 'RESULT SHIP\nThe comparison holds.', 'w-review')
  await step()
  endTurn(bot.id, 'Delivered: bom.md.')
  assert.deepEqual({ ...bot.reviewTrack.last, at: 0 }, { at: 0, review: 'bot', plan: false, result: true })
  const view = (await call('state', {})).value.bots.find(entry => entry.id === bot.id)
  assert.deepEqual({ ...view.reviewMark, at: 0 }, { at: 0, review: 'bot', plan: false, result: true })
  assert.equal(view.reviewTrack, undefined)
  assert.equal(view.reviewerId, ada.id)
  // A caller's view lists only its fixed keys: neither field reaches it.
  assert.equal(CALLER_BOT_KEYS.includes('reviewMark') || CALLER_BOT_KEYS.includes('reviewerId'), false)
})

test('plan and result reviewed, and a result without its second review, on a DSH tool route', async (t) => {
  const { rt, guard, person, endTurn, planReply, resultReply, solver, reviewer, home } = bench(t)
  const ada = await reviewer()
  const bot = await solver({ reviewerId: ada.id })
  person(bot.id, 'Fix the script.')
  await step()
  planReply(bot, ada, 'PLAN FIX-FIRST\nAdd a check.')
  await step()
  planReply(bot, ada, '**SHIP**')
  await step()
  await guard({ name: 'write', arguments: { file_path: 'a.js' }, agent: { id: bot.id } })
  await step()
  await guard({ name: 'mcp__dsh__bash', arguments: { command: 'node a.js' }, agent: { id: bot.id } })
  await step()
  await resultReply(bot, ada)
  await step()
  endTurn(bot.id, 'Done.')
  assert.deepEqual({ ...bot.reviewTrack.last, at: 0 }, { at: 0, review: 'bot', plan: true, result: true })
  // The mark is kept in state.json, so a restart keeps it.
  await rt.save()
  const stored = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).bots[bot.id]
  assert.equal(stored.reviewTrack.last.plan, true)
  // The next request opens a new review; this one skips the result review.
  person(bot.id, 'Now add a test.')
  assert.deepEqual(bot.reviewTrack.verdicts, [])
  assert.equal(bot.reviewTrack.last.result, true, 'the last mark stays until the next delivery')
  await step()
  planReply(bot, ada)
  await step()
  await guard({ name: 'edit', arguments: {}, agent: { id: bot.id } })
  await step()
  endTurn(bot.id, 'Added it.')
  assert.deepEqual({ ...bot.reviewTrack.last, at: 0 }, { at: 0, review: 'bot', plan: true, result: false })
})

test('a turn that ends with its review still out is not a delivery; a person asking first does not drop the plan review', async (t) => {
  const { rt, person, endTurn, planReply, solver, reviewer } = bench(t)
  const ada = await reviewer()
  const bot = await solver({ reviewerId: ada.id })
  person(bot.id, 'Compare two libraries.')
  rt.openWork('w-plan', { from: bot.id, to: ada.id })
  endTurn(bot.id, 'Waiting for my reviewer.')
  assert.equal(bot.reviewTrack.last, undefined)
  planReply(bot, ada, 'PLAN SHIP', 'w-plan')
  rt.openWork('w-result', { from: bot.id, to: ada.id })
  endTurn(bot.id, 'Waiting for the result review.')
  assert.equal(bot.reviewTrack.last, undefined)
  await step()
  // The person asks for the delivery while the result review is out: it is not a new request, and
  // the turn that answers it is the delivery (SR3-3 (b), SR4-1), the plan review kept.
  person(bot.id, 'Deliver now, please.')
  assert.equal(bot.reviewTrack.verdicts.length, 1)
  endTurn(bot.id, 'Fresh-session review ran; no verdict came from the reviewer. Delivered.')
  assert.deepEqual({ ...bot.reviewTrack.last, at: 0 }, { at: 0, review: 'bot', plan: true, result: false, pending: true })
  // A failed or empty turn is never a delivery, and a later turn of the same request adds nothing.
  person(bot.id, 'Again.')
  endTurn(bot.id, '', { kind: 'completed' })
  endTurn(bot.id, 'Oops.', { kind: 'aborted' })
  assert.equal(bot.reviewTrack.delivered, undefined)
})

test('only the Solver\'s own reviewer, answering its own chat with a verdict first, counts', async (t) => {
  const { rt, person, endTurn, reply, solver, reviewer } = bench(t)
  const ada = await reviewer()
  const ben = await reviewer()
  const bot = await solver({ reviewerId: ada.id })
  person(bot.id, 'Plan a migration.')
  reply(ben.id, bot.id, 'SHIP')
  reply(ada.id, bot.id, 'Looks fine to me, a SHIP from me.')
  reply(ada.id, bot.id, 'SHIP', { senderRoomId: 'room-1' })
  reply(bot.id, bot.id, 'SHIP')
  assert.deepEqual(bot.reviewTrack.verdicts, [])
  endTurn(bot.id, 'Delivered.')
  assert.deepEqual({ ...bot.reviewTrack.last, at: 0 }, { at: 0, review: 'bot', plan: false, result: false })
  assert.equal(rt.botOf(ben.id).reviewTrack, undefined)
})

test('fresh session and none: a Solver with no reviewer Bot, and one whose reviewer is gone', async (t) => {
  const { call, person, endTurn, solver, reviewer } = bench(t)
  const fresh = await solver()
  assert.equal(fresh.reviewerId, undefined)
  person(fresh.id, 'Summarise the page.')
  endTurn(fresh.id, 'Review: fresh session. Done.')
  assert.deepEqual({ ...fresh.reviewTrack.last, at: 0 }, { at: 0, review: 'fresh' })
  const ada = await reviewer()
  const bot = await solver({ reviewerId: ada.id })
  assert.equal((await call('delete-bot', { id: ada.id })).ok, true)
  person(bot.id, 'Summarise the page.')
  endTurn(bot.id, 'Review: none. BLOCKED-review.')
  assert.deepEqual({ ...bot.reviewTrack.last, at: 0 }, { at: 0, review: 'none' })
  // A reviewer id that names no Bot on the team is not kept.
  const stray = await solver({ reviewerId: 'nobody' })
  assert.equal(stray.reviewerId, undefined)
})

test('the brief it was made with is its first request; a greeting is not a delivery', async (t) => {
  const { person, endTurn, solver, reviewer } = bench(t)
  const ada = await reviewer()
  const greeted = await solver({ reviewerId: ada.id })
  endTurn(greeted.id, 'Hi! What should I solve?')
  assert.equal(greeted.reviewTrack.last, undefined)
  person(greeted.id, 'Compare two libraries.')
  endTurn(greeted.id, 'Here it is.')
  assert.equal(greeted.reviewTrack.last.review, 'bot')
  const briefed = await solver({ reviewerId: ada.id, brief: 'Compare two libraries.' })
  assert.equal(briefed.reviewTrack.requested, true)
  endTurn(briefed.id, 'Here it is.')
  assert.equal(briefed.reviewTrack.last.review, 'bot')
})

test('a subagent under the Solver\'s own chat dates its work; a group Session, a task and another Bot do not', async (t) => {
  const { rt, guard, person, endTurn, planReply, resultReply, solver, reviewer, sessions } = bench(t)
  const { folder } = notesFolder(t)
  const marker = join(folder, 'fixture.txt')
  writeFileSync(marker, 'synthetic research')
  const ada = await reviewer()
  const bot = await solver({ reviewerId: ada.id })
  bot.workDir = folder
  person(bot.id, 'Build it.')
  await step()
  planReply(bot, ada)
  await step()
  const childId = 'child-of-solver'
  sessions.set(childId, Session.create(childId, [], {
    version: SESSION_FORMAT_VERSION, id: childId, createdAt: Date.now(), cwd: '/tmp', parentSession: bot.id, origin: 'subagent', isSeeded: false,
  }))
  assert.equal(await guard({ name: 'bash', arguments: { command: 'make' }, agent: { id: childId } }), 'ran')
  assert.equal(typeof bot.reviewTrack.firstWorkAt, 'number')
  const first = bot.reviewTrack.firstWorkAt
  // Research never dates the work.
  await guard({ name: 'read', arguments: { file_path: marker }, agent: { id: bot.id } })
  await guard({ name: 'acp_tool', arguments: { kind: 'read', input: { file_path: marker } }, agent: { id: bot.id } })
  assert.equal(bot.reviewTrack.lastWorkAt, first)
  // A task run of the Solver is not its own chat.
  rt.state.tasks = { ...rt.state.tasks, 'task-1': { from: bot.id, title: 'side' } }
  assert.equal(await guard({ name: 'write', arguments: {}, agent: { id: 'task-1' } }), 'ran')
  assert.equal(bot.reviewTrack.lastWorkAt, first)
  await step()
  await resultReply(bot, ada)
  endTurn(bot.id, 'Built.')
  assert.deepEqual({ ...bot.reviewTrack.last, at: 0 }, { at: 0, review: 'bot', plan: true, result: true })
})

test('another Bot is never tracked or marked, and the guard runs its calls as before', async (t) => {
  const { rt, call, guard, person, endTurn, reply, reviewer } = bench(t)
  const ada = await reviewer()
  const plain = await rt.createBot({ name: 'Plain', instructions: 'Free.', pickModel: true })
  // A reviewer id on a Bot without the Solver marker is cosmetic: nothing reads it.
  const other = (await call('create-bot', { name: 'Helper', role: 'Helper', instructions: 'Help.', reviewerId: ada.id })).value
  for (const bot of [plain, rt.botOf(other.id)]) {
    person(bot.id, 'Do it.')
    assert.equal(await guard({ name: 'write', arguments: {}, agent: { id: bot.id } }), 'ran')
    reply(ada.id, bot.id, 'SHIP')
    endTurn(bot.id, 'Done.')
    assert.equal(rt.botOf(bot.id).reviewTrack, undefined, bot.name)
    const view = (await call('state', {})).value.bots.find(entry => entry.id === bot.id)
    assert.equal(view.reviewMark, undefined, bot.name)
  }
})

// SR3-2: a verdict counts only for work the current request opened. Request 1's late SHIP, after
// the wait for it was given up, never marks request 2's plan reviewed.
test('a late verdict from an earlier request does not review the current one', async (t) => {
  const { rt, guard, person, endTurn, reply, planReply, solver, reviewer } = bench(t)
  const ada = await reviewer()
  const bot = await solver({ reviewerId: ada.id })
  person(bot.id, 'Request 1.')
  await step()
  rt.openWork('w-r1', { from: bot.id, to: ada.id })
  endTurn(bot.id, 'Sent my result for review.')
  // The person stops waiting: the work is gone, and the Solver delivers.
  rt.dropWork('w-r1')
  endTurn(bot.id, 'Delivered without the verdict.')
  assert.equal(bot.reviewTrack.delivered, true)
  await step()
  person(bot.id, 'Request 2.')
  await step()
  // Request 1's SHIP lands now, before request 2's first work call: no work record, no verdict.
  reply(ada.id, bot.id, 'SHIP', { exchangeId: 'w-r1', opened: false })
  assert.deepEqual(bot.reviewTrack.verdicts, [])
  // A work record opened before this request opened is not this request's review either.
  rt.openWork('w-old', { from: bot.id, to: ada.id })
  rt.state.works['w-old'].at = bot.reviewTrack.requestAt - 1
  reply(ada.id, bot.id, 'SHIP', { exchangeId: 'w-old' })
  assert.deepEqual(bot.reviewTrack.verdicts, [])
  await step()
  await guard({ name: 'write', arguments: {}, agent: { id: bot.id } })
  await step()
  endTurn(bot.id, 'Request 2 done.')
  assert.deepEqual({ ...bot.reviewTrack.last, at: 0 }, { at: 0, review: 'bot', plan: false, result: false })
  // Request 2's own review, on work it opened, still counts.
  person(bot.id, 'Request 3.')
  await step()
  planReply(bot, ada)
  assert.equal(bot.reviewTrack.verdicts.length, 1)
})

// SR3-1: a copy of a Solver keeps its reviewer, so its mark reads that reviewer's verdicts.
test('a copy of a Solver keeps its reviewer id, checked again', async (t) => {
  const { rt, call, solver, reviewer } = bench(t)
  const ada = await reviewer()
  const bot = await solver({ reviewerId: ada.id })
  const copy = await call('duplicate-bot', { id: bot.id })
  assert.equal(copy.ok, true, JSON.stringify(copy))
  assert.equal(rt.botOf(copy.value.id).reviewerId, ada.id)
  assert.equal(rt.botOf(copy.value.id).role, 'Solver')
  // A reviewer gone since is not carried to the copy (buildBot keeps only a Bot on the team).
  assert.equal((await call('delete-bot', { id: ada.id })).ok, true)
  const orphan = await call('duplicate-bot', { id: bot.id })
  assert.equal(orphan.ok, true, JSON.stringify(orphan))
  assert.equal(rt.botOf(orphan.value.id).reviewerId, undefined)
  // A copy of a Solver with no reviewer gets none.
  const fresh = await solver()
  const freshCopy = await call('duplicate-bot', { id: fresh.id })
  assert.equal(rt.botOf(freshCopy.value.id).reviewerId, undefined)
})

// SR3-6: a corrupted stored track never throws on a reply, a tool call, a turn's end or the view.
test('a corrupted stored review track is repaired, never thrown on', async (t) => {
  const { call, guard, person, endTurn, reply, planReply, resultReply, solver, reviewer } = bench(t)
  const ada = await reviewer()
  const bot = await solver({ reviewerId: ada.id })
  for (const bad of ['garbage', 7, [], null, { verdicts: 5, last: 'x', firstWorkAt: {} }, { requested: true, requestAt: 'now', verdicts: [null, 7, { verdict: 'SHIP' }], last: [1] }]) {
    const label = JSON.stringify(bad)
    bot.reviewTrack = bad
    assert.doesNotThrow(() => reply(ada.id, bot.id, 'SHIP'), label)
    bot.reviewTrack = bad
    assert.equal(await guard({ name: 'write', arguments: {}, agent: { id: bot.id } }), 'ran', label)
    bot.reviewTrack = bad
    assert.doesNotThrow(() => endTurn(bot.id, 'Done.'), label)
    bot.reviewTrack = bad
    const view = await call('state', {})
    assert.equal(view.ok, true, label)
    assert.equal(view.value.bots.find(entry => entry.id === bot.id).reviewMark, undefined, label)
    bot.reviewTrack = bad
    assert.doesNotThrow(() => person(bot.id, 'Next.'), label)
    assert.ok(Array.isArray(bot.reviewTrack.verdicts), label)
  }
  // The repaired track marks the next delivery as usual.
  await step()
  planReply(bot, ada)
  await step()
  await guard({ name: 'write', arguments: {}, agent: { id: bot.id } })
  await step()
  await resultReply(bot, ada)
  endTurn(bot.id, 'Done.')
  assert.deepEqual({ ...bot.reviewTrack.last, at: 0 }, { at: 0, review: 'bot', plan: true, result: true })
})

// SR3-7: the lineage walk and the work date run only for a Solver's calls.
test('only a Solver\'s tool calls reach the review mark', async (t) => {
  const { rt, guard, solver, reviewer } = bench(t)
  const ada = await reviewer()
  const bot = await solver({ reviewerId: ada.id })
  const plain = await rt.createBot({ name: 'Plain', instructions: 'Free.', pickModel: true })
  const seen = []
  const real = rt.reviewWork
  rt.reviewWork = (who, ...rest) => { seen.push(who.id); return real(who, ...rest) }
  assert.equal(await guard({ name: 'write', arguments: {}, agent: { id: plain.id } }), 'ran')
  assert.equal(await guard({ name: 'write', arguments: {}, agent: { id: bot.id } }), 'ran')
  assert.deepEqual(seen, [bot.id])
})

// SR3-8: the last mark stays in the view after the Bot's description changes.
test('the last mark stays shown after the Solver\'s description changes', async (t) => {
  const { rt, call, person, endTurn, planReply, solver, reviewer } = bench(t)
  const ada = await reviewer()
  const bot = await solver({ reviewerId: ada.id })
  person(bot.id, 'Do it.')
  await step()
  planReply(bot, ada)
  endTurn(bot.id, 'Done.')
  assert.equal(bot.reviewTrack.last.review, 'bot')
  assert.equal((await call('update-bot', { id: bot.id, role: 'Helper' })).ok, true)
  assert.equal(rt.botOf(bot.id).role, 'Helper')
  const view = (await call('state', {})).value.bots.find(entry => entry.id === bot.id)
  assert.deepEqual({ ...view.reviewMark, at: 0 }, { at: 0, review: 'bot', plan: true, result: false })
})

// SR4-1: the person asks for the delivery while the result review is out (SR3-3 (b)), the work still
// open. That delivery is marked, the next message opens a new request, and request 1's late SHIP on
// the work it left open never reviews request 2.
test('a delivery the person asked for first is marked; the late verdict never marks the next request', async (t) => {
  const { rt, guard, person, endTurn, reply, solver, reviewer } = bench(t)
  const ada = await reviewer()
  const bot = await solver({ reviewerId: ada.id })
  person(bot.id, 'Request 1.')
  await step()
  await guard({ name: 'write', arguments: { file_path: 'a.js' }, agent: { id: bot.id } })
  await step()
  rt.openWork('w1', { from: bot.id, to: ada.id })
  endTurn(bot.id, 'Sent my result for review.')
  assert.equal(bot.reviewTrack.last, undefined)
  await step()
  person(bot.id, 'Deliver now, please.')
  endTurn(bot.id, 'Fresh-session review ran; no verdict came from Ada. Delivered.')
  assert.equal(bot.reviewTrack.delivered, true)
  assert.deepEqual({ ...bot.reviewTrack.last, at: 0 }, { at: 0, review: 'bot', plan: false, result: false, pending: true })
  assert.notEqual(rt.state.works.w1, undefined, 'the reviewer work is still open')
  await step()
  const before = bot.reviewTrack.requestAt
  person(bot.id, 'Request 2.')
  assert.notEqual(bot.reviewTrack.requestAt, before, 'request 2 opens a new request')
  assert.equal(bot.reviewTrack.delivered, undefined)
  await step()
  await guard({ name: 'write', arguments: { file_path: 'b.js' }, agent: { id: bot.id } })
  await step()
  reply(ada.id, bot.id, 'SHIP', { exchangeId: 'w1' })
  assert.deepEqual(bot.reviewTrack.verdicts, [])
  endTurn(bot.id, 'Request 2 done.')
  assert.deepEqual({ ...bot.reviewTrack.last, at: 0 }, { at: 0, review: 'bot', plan: false, result: false })
})

// SR4-1: only reviewer work opened before the person's last message stops holding the delivery.
test('a person\'s message before the Solver opens its review work still waits for the verdict', async (t) => {
  const { rt, person, endTurn, planReply, solver, reviewer } = bench(t)
  const ada = await reviewer()
  const bot = await solver({ reviewerId: ada.id })
  person(bot.id, 'Request 1.')
  await step()
  person(bot.id, 'Also cover the edge case.')
  assert.ok(bot.reviewTrack.personAt > bot.reviewTrack.requestAt, 'the second message dates personAt')
  await step()
  rt.openWork('w-plan', { from: bot.id, to: ada.id })
  endTurn(bot.id, 'Sent my plan for review.')
  assert.equal(bot.reviewTrack.last, undefined)
  assert.equal(bot.reviewTrack.delivered, undefined)
  planReply(bot, ada, 'PLAN SHIP', 'w-plan')
  endTurn(bot.id, 'Delivered.')
  assert.deepEqual({ ...bot.reviewTrack.last, at: 0 }, { at: 0, review: 'bot', plan: true, result: false })
})

// SR4-2 (the lead's ruling): the Solver's notes file, one exact path in its folder, is not work.
function notesFolder(t) {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-notes-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
  const folder = join(root, 'solver')
  const outside = join(root, 'outside')
  mkdirSync(folder)
  mkdirSync(outside)
  return { root, folder, outside }
}

test('a write to exactly the notes file before the plan verdict keeps the plan reviewed, on every route', async (t) => {
  const { guard, person, endTurn, planReply, resultReply, solver, reviewer } = bench(t)
  const { folder } = notesFolder(t)
  const ada = await reviewer()
  const bot = await solver({ reviewerId: ada.id })
  bot.workDir = folder
  person(bot.id, 'Compare two libraries.')
  await step()
  for (const exec of [
    { name: 'write', arguments: { file_path: '.solver/notes.md' } },
    { name: 'mcp__dsh__write', arguments: { file_path: join(folder, '.solver', 'notes.md') } },
    { name: 'edit', arguments: { file_path: './.solver/notes.md' } },
    { name: 'str_replace_editor', arguments: { path: '.solver/notes.md' } },
    { name: 'acp_tool', arguments: { kind: 'edit', title: 'Write notes', input: { file_path: join(folder, '.solver/notes.md') }, locations: [{ path: join(folder, '.solver/notes.md') }] } },
  ]) assert.equal(await guard({ ...exec, agent: { id: bot.id } }), 'ran', exec.name)
  // The file exists now, as a plain file: still the notes file.
  mkdirSync(join(folder, '.solver'), { recursive: true })
  writeFileSync(join(folder, '.solver', 'notes.md'), 'notes')
  await guard({ name: 'write', arguments: { file_path: '.solver/notes.md' }, agent: { id: bot.id } })
  assert.equal(bot.reviewTrack.firstWorkAt, undefined)
  await step()
  planReply(bot, ada)
  await step()
  await guard({ name: 'write', arguments: { file_path: 'compare.md' }, agent: { id: bot.id } })
  await step()
  await resultReply(bot, ada)
  await step()
  // SR5-1: a notes write after the result verdict is still work for the result side.
  await guard({ name: 'write', arguments: { file_path: '.solver/notes.md' }, agent: { id: bot.id } })
  endTurn(bot.id, 'Delivered: compare.md.')
  assert.deepEqual({ ...bot.reviewTrack.last, at: 0 }, { at: 0, review: 'bot', plan: true, result: false })
})

// SR5-1: an answer written only into the notes file after two plan verdicts, delivered with no
// result review, reads result unreviewed (never "Plan and result reviewed").
test('a notes-only deliverable with no result review reads result unreviewed', async (t) => {
  const { guard, person, endTurn, planReply, solver, reviewer } = bench(t)
  const { folder } = notesFolder(t)
  const ada = await reviewer()
  const bot = await solver({ reviewerId: ada.id })
  bot.workDir = folder
  person(bot.id, 'Research two libraries and give me a one-page comparison.')
  await step()
  planReply(bot, ada, 'PLAN FIX-FIRST\nAdd a licence check to the plan.')
  await step()
  planReply(bot, ada)
  await step()
  assert.equal(await guard({ name: 'write', arguments: { file_path: '.solver/notes.md', content: '# Comparison' }, agent: { id: bot.id } }), 'ran')
  assert.equal(bot.reviewTrack.firstWorkAt, undefined)
  assert.equal(typeof bot.reviewTrack.lastWorkAt, 'number')
  await step()
  endTurn(bot.id, 'Delivered: the comparison is in .solver/notes.md.')
  assert.deepEqual({ ...bot.reviewTrack.last, at: 0 }, { at: 0, review: 'bot', plan: true, result: false })
})

// SR6-1: an answer written only into the notes file, with no plan review, reviewed once after the
// notes: the one verdict reviews the result, never the plan too.
test('a notes-only delivery reviewed once, after the notes, reads plan unreviewed', async (t) => {
  const { guard, person, endTurn, resultReply, solver, reviewer } = bench(t)
  const { folder } = notesFolder(t)
  const ada = await reviewer()
  const bot = await solver({ reviewerId: ada.id })
  bot.workDir = folder
  person(bot.id, 'Research two libraries and give me a one-page comparison.')
  await step()
  assert.equal(await guard({ name: 'write', arguments: { file_path: '.solver/notes.md', content: '# Comparison' }, agent: { id: bot.id } }), 'ran')
  assert.equal(bot.reviewTrack.firstWorkAt, undefined)
  await step()
  await resultReply(bot, ada)
  await step()
  endTurn(bot.id, 'Delivered: the comparison is in .solver/notes.md.')
  assert.deepEqual({ ...bot.reviewTrack.last, at: 0 }, { at: 0, review: 'bot', plan: false, result: true })
})

// SR5-1: a delivered file that is a symlink into the notes file, changed through a notes write after
// the result verdict, reads result unreviewed.
test('a delivered symlink into the notes file changed after the result verdict reads result unreviewed', async (t) => {
  const { guard, person, endTurn, planReply, resultReply, solver, reviewer } = bench(t)
  const { folder } = notesFolder(t)
  mkdirSync(join(folder, '.solver'))
  writeFileSync(join(folder, '.solver', 'notes.md'), 'reviewed text')
  const ada = await reviewer()
  const bot = await solver({ reviewerId: ada.id })
  bot.workDir = folder
  person(bot.id, 'Write report.md.')
  await step()
  planReply(bot, ada)
  await step()
  await guard({ name: 'bash', arguments: { command: 'ln -s .solver/notes.md report.md' }, agent: { id: bot.id } })
  symlinkSync('.solver/notes.md', join(folder, 'report.md'))
  await step()
  await resultReply(bot, ada)
  await step()
  assert.equal(isNotesPath('.solver/notes.md', folder, folder), true)
  await guard({ name: 'write', arguments: { file_path: '.solver/notes.md', content: 'unreviewed text' }, agent: { id: bot.id } })
  endTurn(bot.id, 'Delivered: report.md.')
  assert.deepEqual({ ...bot.reviewTrack.last, at: 0 }, { at: 0, review: 'bot', plan: true, result: false })
})

test('any other write before the plan verdict marks the plan unreviewed: lookalikes, .., another folder, a symlink, a link', async (t) => {
  const { guard, person, endTurn, planReply, resultReply, solver, reviewer } = bench(t)
  const { root, folder, outside } = notesFolder(t)
  // A second folder whose notes path leads out through a symlink, one whose notes file is a symlink, and
  // one whose notes file is a hard link to a file outside.
  const linkedDir = join(root, 'linked-dir')
  mkdirSync(linkedDir)
  symlinkSync(outside, join(linkedDir, '.solver'))
  const linkedFile = join(root, 'linked-file')
  mkdirSync(join(linkedFile, '.solver'), { recursive: true })
  writeFileSync(join(outside, 'target.md'), 'x')
  symlinkSync(join(outside, 'target.md'), join(linkedFile, '.solver', 'notes.md'))
  const hardFile = join(root, 'hard-file')
  mkdirSync(join(hardFile, '.solver'), { recursive: true })
  linkSync(join(outside, 'target.md'), join(hardFile, '.solver', 'notes.md'))
  const ada = await reviewer()
  const cases = [
    [folder, { name: 'write', arguments: { file_path: '.solver/notes.md.bak' } }],
    [folder, { name: 'write', arguments: { file_path: '.solver/notes.mdx' } }],
    [folder, { name: 'write', arguments: { file_path: '.solver/../.solver/notes.md' } }],
    [folder, { name: 'write', arguments: { file_path: '../solver/.solver/notes.md' } }],
    [folder, { name: 'write', arguments: { file_path: 'notes.md' } }],
    [folder, { name: 'write', arguments: { file_path: 'sub/.solver/notes.md' } }],
    [folder, { name: 'write', arguments: { file_path: join(outside, '.solver', 'notes.md') } }],
    [folder, { name: 'apply_patch', arguments: { input: '*** Begin Patch\n*** Add File: .solver/notes.md\n+x\n*** End Patch' } }],
    [folder, { name: 'bash', arguments: { command: 'echo x > .solver/notes.md' } }],
    [folder, { name: 'acp_tool', arguments: { kind: 'edit', input: { file_path: join(folder, '.solver/notes.md') }, locations: [{ path: join(folder, 'a.js') }] } }],
    [linkedDir, { name: 'write', arguments: { file_path: '.solver/notes.md' } }],
    [linkedFile, { name: 'write', arguments: { file_path: '.solver/notes.md' } }],
    [hardFile, { name: 'write', arguments: { file_path: '.solver/notes.md' } }],
  ]
  for (const [workDir, exec] of cases) {
    const label = `${workDir} ${JSON.stringify(exec)}`
    const bot = await solver({ reviewerId: ada.id })
    bot.workDir = workDir
    person(bot.id, 'Compare two libraries.')
    await step()
    assert.equal(await guard({ ...exec, agent: { id: bot.id } }), 'ran', label)
    assert.equal(typeof bot.reviewTrack.firstWorkAt, 'number', label)
    await step()
    planReply(bot, ada)
    await step()
    await resultReply(bot, ada)
    endTurn(bot.id, 'Delivered.')
    assert.deepEqual({ ...bot.reviewTrack.last, at: 0 }, { at: 0, review: 'bot', plan: false, result: true }, label)
  }
})

test('isNotesPath and isNotesWrite: exact path only, relative to the call\'s folder', (t) => {
  const { folder, outside } = notesFolder(t)
  const notes = join(folder, '.solver', 'notes.md')
  assert.equal(isNotesPath(notes, folder), true)
  assert.equal(isNotesPath('.solver/notes.md', folder, folder), true)
  // A relative path lands in the call's folder, not the Bot's.
  assert.equal(isNotesPath('.solver/notes.md', folder, outside), false)
  for (const path of ['', '.solver', '.solver/', '.solver/notes', '.solver/notes.md/', '.solver//../.solver/notes.md', 'x\0/.solver/notes.md', 7, undefined]) {
    assert.equal(isNotesPath(path, folder, folder), false, String(path))
  }
  assert.equal(isNotesPath('.solver/notes.md', undefined, folder), false)
  assert.equal(isNotesPath('.solver/notes.md', folder, ''), false)
  // Reads never come here (isWorkCall), and a write tool's other argument names are not its target.
  assert.equal(isNotesWrite('write', { path: notes }, folder, folder), false)
  assert.equal(isNotesWrite('str_replace_editor', { path: notes }, folder, folder), true)
  assert.equal(isNotesWrite('acp_tool', { kind: 'edit', input: {} }, folder, folder), false)
  assert.equal(isNotesWrite('acp_tool', { kind: 'execute', input: { file_path: notes } }, folder, folder), false)
  assert.equal(isNotesWrite('acp_tool', { kind: 'edit', input: { file_path: notes, command: 'x' } }, folder, folder), false)
  assert.equal(isNotesWrite('acp_tool', { kind: 'edit', input: { file_path: notes } }, folder, folder), true)
})

// F9: a reviewer whose verdict follows its progress sentence (the Codex replies above) is counted,
// so a Solver that followed the method is marked plan and result reviewed.
test('a reviewer that opens with a progress sentence still reviews the plan and the result', async (t) => {
  const { guard, person, endTurn, planReply, resultReply, solver, reviewer } = bench(t)
  const ada = await reviewer()
  const bot = await solver({ reviewerId: ada.id })
  person(bot.id, 'Write a three-line note.')
  await step()
  planReply(bot, ada, CODEX_REPLIES[2][0])
  await step()
  planReply(bot, ada, CODEX_REPLIES[0][0].replace('. SHIP', '.SHIP'))
  await step()
  await guard({ name: 'write', arguments: { file_path: 'note.md' }, agent: { id: bot.id } })
  await step()
  await resultReply(bot, ada, CODEX_REPLIES[3][0])
  assert.deepEqual(bot.reviewTrack.verdicts.map(entry => entry.verdict), ['FIX-FIRST', 'SHIP', 'SHIP'])
  endTurn(bot.id, 'Delivered: note.md.')
  assert.deepEqual({ ...bot.reviewTrack.last, at: 0 }, { at: 0, review: 'bot', plan: true, result: true })
})

// Run 3 (APP-TEST "Recheck on 262488524"): the person asks for the delivery while the reviewer still
// has the work. That delivery carries a mark that says so; a Solver with a reviewer Bot is never
// marked "fresh" (the no-reviewer line).
test('a delivery made while the reviewer still has the work is marked pending, never fresh, in the view', async (t) => {
  const { rt, call, guard, person, endTurn, reply, planReply, solver, reviewer } = bench(t)
  const ada = await reviewer()
  const bot = await solver({ reviewerId: ada.id })
  person(bot.id, 'Write a three-line note.')
  await step()
  await guard({ name: 'write', arguments: { file_path: 'note.md' }, agent: { id: bot.id } })
  await step()
  rt.openWork('w-review', { from: bot.id, to: ada.id })
  endTurn(bot.id, 'Waiting for the verdict.')
  assert.equal(bot.reviewTrack.last, undefined)
  await step()
  person(bot.id, 'Please deliver now.')
  endTurn(bot.id, 'Review that ran: fresh session. The reviewer Bot gave no verdict. Delivered.')
  const view = (await call('state', {})).value.bots.find(entry => entry.id === bot.id)
  assert.deepEqual({ ...view.reviewMark, at: 0 }, { at: 0, review: 'bot', plan: false, result: false, pending: true })
  // The late verdict and the later round of the same request change nothing.
  reply(ada.id, bot.id, CODEX_REPLIES[2][0], { exchangeId: 'w-review' })
  endTurn(bot.id, 'Final delivery after the reviewer\'s SHIP.')
  assert.equal(bot.reviewTrack.last.pending, true)
  assert.equal(bot.reviewTrack.last.review, 'bot')
  // A work left open by an earlier request does not make the next delivery pending.
  person(bot.id, 'Next request.')
  await step()
  rt.openWork('w-stale', { from: bot.id, to: ada.id })
  rt.state.works['w-stale'].at = bot.reviewTrack.requestAt - 1
  planReply(bot, ada)
  endTurn(bot.id, 'Done.')
  assert.deepEqual({ ...bot.reviewTrack.last, at: 0 }, { at: 0, review: 'bot', plan: true, result: false })
})

test('D2 G2 a pin-only Solver is tracked through delivery', async t => {
  const b = bench(t)
  const solver = await b.solver()
  solver.role = 'Researcher'
  solver.roles = [{ id: 'solver', version: '3.1.2', attachedAt: '2026-11-24T00:00:00Z', grants: [] }]
  b.person(solver.id, 'Review the fixture')
  b.endTurn(solver.id, 'Review: fresh session. Done.')
  const roster = (await b.call('state')).value
  assert.equal(roster.bots.find(bot => bot.id === solver.id).reviewMark?.review, 'fresh')
})

// ---- Track 1 (#2056 combined-2 stage 6): the RESULT verdict is never recorded when the
// reviewer's PLAN SHIP arrives before the Solver's plan-wait turn ends. Real order from
// /tmp/automagik-2056-combined2-stage6/EXCHANGE.json and SOLVER-CHAT-RAW.json (turns 4-6).

const PLAN_REPLY = 'SHIP\n\nPLAN approved. Dividing the sum by `values.length` after the existing empty-input guard gives `12 / 3 = 4` and preserves empty-input rejection. Delivery still requires an explicit RESULT SHIP verdict from this reviewer.'
const RESULT_REPLY = 'SHIP\n\nExplicit RESULT SHIP verdict. PLAN approval preceded the edit. The submitted diff changes only the return line in `average.mjs`.\n\nThe Solver reports that the exact requested command exited `0` with one test passed and zero failed.'

test('TRACK1 PARSE: both stage-6 replies read as SHIP by verdictOf and guardVerdictOf', () => {
  assert.equal(verdictOf(PLAN_REPLY), 'SHIP')
  assert.equal(verdictOf(RESULT_REPLY), 'SHIP')
  assert.equal(guardVerdictOf(PLAN_REPLY, 'R'), 'SHIP')
  assert.equal(guardVerdictOf(RESULT_REPLY, 'R'), 'SHIP')
})

// Wait for the actual host exchange to be recorded. The fake agent keeps followups
// in its inbox until the test lets DSH's next turn take them as input.
async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await step()
  }
  assert.ok(predicate(), 'host reply did not reach the expected boundary')
}

async function run(t, { planAnsweredInsideTurn, resultAnsweredInsideTurn = false, clarification }) {
  const { rt, guard, person, endTurn, reply, designate, solver, reviewer, replyInbox, takeReply } = bench(t)
  const ada = await reviewer()
  const bot = await solver({ reviewerId: ada.id })
  await rt.resolveAgent(bot.id)
  const inbox = replyInbox(bot.id)
  const record = exchange => rt.ledger.records(`pair-${[ada.id, bot.id].sort().join('-')}`)
    .find(row => row.role === 'reply' && row.replyTo === exchange)
  const waitForReply = async (exchange) => {
    await until(() => inbox.length === 1)
    assert.equal(inbox[0].source.exchangeId, record(exchange)?.id)
  }
  const marks = []
  const finish = (text) => {
    endTurn(bot.id, text)
    const mark = bot.reviewTrack.last
    if (mark !== undefined && mark !== marks.at(-1)) marks.push(mark)
  }
  // Turn 4: the person's request; the Solver sends the PLAN (message_bot opens the work).
  person(bot.id, 'Fix average.mjs so average([2,4,6]) returns 4.')
  let afterClarification
  if (clarification !== undefined) {
    await step()
    reply(ada.id, bot.id, clarification, { exchangeId: 'x-clarification' })
    await until(() => record('x-clarification'))
    assert.equal(inbox.length, 0)
    finish('Waiting for the reviewer to clarify.')
    afterClarification = {
      delivered: bot.reviewTrack.delivered === true,
      verdicts: bot.reviewTrack.verdicts,
      planVerdictAt: bot.reviewTrack.planVerdictAt,
    }
    await waitForReply('x-clarification')
    takeReply(bot.id, inbox, 'x-clarification')
  }
  await step()
  designate('plan', bot, ada, 'x-plan')
  rt.openWork('x-plan', { from: bot.id, to: ada.id })
  await step()
  if (planAnsweredInsideTurn) {
    reply(ada.id, bot.id, PLAN_REPLY, { exchangeId: 'x-plan' })
    await until(() => record('x-plan'))
    assert.equal(inbox.length, 0, 'a recorded answer waits until the active turn ends')
  }
  await step()
  finish('PLAN review sent. I am waiting for its verdict before editing.')
  const afterTurn4 = { delivered: bot.reviewTrack.delivered === true, last: bot.reviewTrack.last && { ...bot.reviewTrack.last, at: 0 } }
  if (!planAnsweredInsideTurn) { await step(); reply(ada.id, bot.id, PLAN_REPLY, { exchangeId: 'x-plan' }) }
  await step()
  // Turn 5: opened by the PLAN reply; edit, test, then the RESULT review goes out and the turn ends.
  await waitForReply('x-plan')
  takeReply(bot.id, inbox, 'x-plan')
  await guard({ name: 'write', arguments: { file_path: 'average.mjs' }, agent: { id: bot.id } })
  await step()
  await guard({ name: 'mcp__dsh__bash', arguments: { command: 'node --test average.test.mjs' }, agent: { id: bot.id } })
  await step()
  designate('result', bot, ada, 'x-result')
  rt.openWork('x-result', { from: bot.id, to: ada.id })
  await step()
  const resultVerdictAt = Date.now()
  const answerResult = () => reply(ada.id, bot.id, RESULT_REPLY, { exchangeId: 'x-result', model: 'acp-codex/fixture' })
  if (resultAnsweredInsideTurn) {
    answerResult()
    await until(() => record('x-result'))
  }
  finish('The fix and checks are complete. I am waiting for the RESULT verdict before delivery.')
  const afterTurn5 = bot.reviewTrack.delivered === true
  if (!resultAnsweredInsideTurn) {
    // The recorded run received RESULT SHIP after turn 5 ended.
    await step()
    answerResult()
  }
  await step()
  // Turn 6: opened by the RESULT reply; the real delivery.
  await waitForReply('x-result')
  takeReply(bot.id, inbox, 'x-result')
  finish('Reviewer Bot: PLAN SHIP; RESULT SHIP. Updated average.mjs.')
  const last = bot.reviewTrack.last
  return { afterClarification, afterTurn4, afterTurn5, last, marks, verdicts: bot.reviewTrack.verdicts.map(v => v.verdict), resultVerdictAt }
}

test('TRACK1 RACE: PLAN SHIP inside the plan-wait turn, then edit, RESULT SHIP: marked plan and result reviewed', async (t) => {
  const { afterTurn4, afterTurn5, last, marks, verdicts, resultVerdictAt } = await run(t, { planAnsweredInsideTurn: true })
  t.diagnostic(JSON.stringify({ afterTurn4, verdicts, last, markedBeforeResult: last?.at < resultVerdictAt }))
  assert.equal(afterTurn4.delivered, false, `the plan-wait turn was marked as the delivery: ${JSON.stringify(afterTurn4.last)}`)
  assert.equal(afterTurn5, false)
  assert.deepEqual(verdicts, ['SHIP', 'SHIP'])
  assert.ok(last.at >= resultVerdictAt)
  assert.deepEqual({ ...last, at: 0 }, { at: 0, review: 'bot', plan: true, result: true })
  assert.deepEqual(marks, [last])
})

test('TRACK1 RESULT: a RESULT SHIP inside the result-wait turn holds delivery until its reply is taken', async (t) => {
  const { afterTurn4, afterTurn5, last, marks } = await run(t, { planAnsweredInsideTurn: false, resultAnsweredInsideTurn: true })
  assert.equal(afterTurn4.delivered, false)
  assert.equal(afterTurn5, false)
  assert.deepEqual({ ...last, at: 0 }, { at: 0, review: 'bot', plan: true, result: true })
  assert.deepEqual(marks, [last])
})

test('TRACK1 CONTROL: PLAN SHIP after the plan-wait turn ends: marked plan and result reviewed', async (t) => {
  const { afterTurn4, afterTurn5, last, marks } = await run(t, { planAnsweredInsideTurn: false })
  assert.equal(afterTurn4.delivered, false)
  assert.equal(afterTurn5, false)
  assert.deepEqual({ ...last, at: 0 }, { at: 0, review: 'bot', plan: true, result: true })
  assert.deepEqual(marks, [last])
})

test('TRACK1 CLARIFICATION: an early clarification holds delivery through consumption and both reviews', async (t) => {
  const { afterClarification, afterTurn4, afterTurn5, last, marks, verdicts } = await run(t, {
    clarification: 'Which behavior is required for empty input?',
    planAnsweredInsideTurn: true,
  })
  assert.deepEqual(afterClarification, { delivered: false, verdicts: [], planVerdictAt: undefined })
  assert.equal(afterTurn4.delivered, false)
  assert.equal(afterTurn5, false)
  assert.deepEqual(verdicts, ['SHIP', 'SHIP'])
  assert.deepEqual({ ...last, at: 0 }, { at: 0, review: 'bot', plan: true, result: true })
  assert.deepEqual(marks, [last])
})

test('TRACK1 LIFECYCLE: a queued reply survives inbox moves until the exact input is read or withdrawn', async (t) => {
  const { ctx, rt, person, endTurn, event, reply, solver, reviewer, replyInbox, takeReply } = bench(t)
  const ada = await reviewer()
  const bot = await solver({ reviewerId: ada.id })
  const agent = await rt.resolveAgent(bot.id)
  const inbox = replyInbox(bot.id)

  person(bot.id, 'Review a change.')
  endTurn(bot.id)
  reply(ada.id, bot.id, PLAN_REPLY, { exchangeId: 'x-plan' })
  await until(() => inbox.length === 1)
  const exact = inbox.shift()
  ctx.emit('agent/inbox/discarded', { agent, message: exact })
  agent.followup({ ...exact, id: 'other-reply', source: { ...exact.source, exchangeId: 'other-exchange' } })
  agent.followup(exact)
  await step()
  takeReply(bot.id, inbox, 'x-plan') // Same work, different exchange.
  endTurn(bot.id, 'Still waiting for the review.')
  assert.equal(bot.reviewTrack.delivered, undefined)

  // Definitive withdrawal has no matching reinsertion.
  assert.equal(inbox.shift(), exact)
  ctx.emit('agent/inbox/discarded', { agent, message: exact })
  await step()
  event(bot.id, 'turn/start', { turn: 1000 })
  endTurn(bot.id, 'Delivered after the review reply was withdrawn.')
  assert.equal(bot.reviewTrack.delivered, true)
})

test('TRACK1 RELOAD: an accepted reply with a failed flush remains the sole actionable reply until consumed', async (t) => {
  const { ctx, rt, event, person, endTurn, reply, designate, solver, reviewer, replyInbox, takeReply, reload } = bench(t)
  const ada = await reviewer()
  const bot = await solver({ reviewerId: ada.id })
  const agent = await rt.resolveAgent(bot.id)
  const inbox = replyInbox(bot.id)
  let flushFailed = false
  ctx.sessions.flush = async () => {
    if (!flushFailed && inbox.length === 1) {
      flushFailed = true
      throw new Error('injected flush failure after accepting the reply')
    }
  }
  person(bot.id, 'Review a change.')
  endTurn(bot.id)
  await step()
  designate('plan', bot, ada, 'x-plan')
  reply(ada.id, bot.id, PLAN_REPLY, { exchangeId: 'x-plan' })
  await until(() => flushFailed)
  const exact = inbox[0]
  // Let the failed batch unwind. DSH keeps the reply and the running turn across reload.
  const workBook = `pair-${[ada.id, bot.id].sort().join('-')}`
  await rt.ledger.written(workBook)
  await step()
  agent.status = 'running'
  event(bot.id, 'turn/start', { turn: 1000 })
  const restarted = await reload()
  await until(() => restarted.live.get(bot.id)?.turn !== undefined)
  const restored = restarted.botOf(bot.id)
  const retained = restarted.unreadOf(bot.id).map(item => item.exchangeId)
  endTurn(bot.id, 'The review is still waiting to be read.')
  const waitingMark = restored.reviewTrack.last
  agent.status = 'idle'
  // Recovery must see the existing inbox entry and leave the single original reply in place.
  await Promise.all([restarted.resumesDone, wait(3500)])
  const actionable = inbox.map(message => message.source.exchangeId)
  takeReply(bot.id, inbox, 'x-plan')
  endTurn(bot.id, 'Delivered after reading the review.')
  assert.deepEqual({ waitingMark, retained, actionable }, {
    waitingMark: undefined,
    retained: [exact.source.exchangeId],
    actionable: [exact.source.exchangeId],
  })
  const mark = restored.reviewTrack.last
  assert.deepEqual({ ...mark, at: 0 }, { at: 0, review: 'bot', plan: true, result: false })
  assert.deepEqual(restarted.unreadOf(bot.id), [])
  event(bot.id, 'turn/start', { turn: 2000 })
  endTurn(bot.id, 'A later message.')
  assert.deepEqual(restored.reviewTrack.last, mark)
})

test('TRACK1 REJECTED: a claimed reply whose turn rejects the input releases the hold', async (t) => {
  const { rt, person, endTurn, event, reply, solver, reviewer, replyInbox, takeReply } = bench(t)
  const ada = await reviewer()
  const bot = await solver({ reviewerId: ada.id })
  await rt.resolveAgent(bot.id)
  const inbox = replyInbox(bot.id)
  person(bot.id, 'Review a change.')
  endTurn(bot.id)
  reply(ada.id, bot.id, PLAN_REPLY, { exchangeId: 'x-plan' })
  await until(() => inbox.length === 1)
  takeReply(bot.id, inbox, 'x-plan', { admitted: false })
  endTurn(bot.id, undefined, { kind: 'blocked' })
  event(bot.id, 'turn/start', { turn: 1000 })
  endTurn(bot.id, 'Delivered after the rejected step.')
  assert.equal(bot.reviewTrack.delivered, true)
})
