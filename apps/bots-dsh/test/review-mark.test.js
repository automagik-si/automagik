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
import { answerSender } from '../src/host/turns.js'
import { deliveryMark, verdictOf } from '../src/shared/review-mark.js'
import { CALLER_BOT_KEYS } from '../src/host/caller-view.js'
import { fakeContext } from './fake-ctx.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
// Each step a few ms apart, so the order of work and verdicts is never a tie.
const step = () => wait(3)

function bench(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-review-mark-'))
  const ctx = fakeContext()
  const sessions = new Map()
  const agents = new Map()
  let created = 0
  ctx.tools.schemas = () => ['bash', 'read', 'write', 'edit'].map(name => ({ name }))
  ctx.tools.view = () => ({ restrictableNames: new Set(['bash', 'read', 'write', 'edit']), knownNames: new Set(['bash', 'read', 'write', 'edit']) })
  Object.assign(ctx, {
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
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    if (options.path === ROUTE) route = options
    return register(options)
  }
  apply(ctx, { home })
  t.after(() => {
    ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const rt = ctx.provided.get('omniTeam')
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const guard = (exec) => (ctx.listeners.get('tools/execute') ?? [])[0](exec, async () => 'ran')
  let seq = 0
  const event = (sessionId, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) listener({ id: sessionId }, { type, seq: ++seq, time: Date.now(), data })
  }
  const text = value => [{ type: 'text', text: value }]
  // A person's message in the chat, and a turn that ends with `reply` (or nothing).
  const person = (sessionId, value) => {
    event(sessionId, 'turn/start', { turn: seq + 1 })
    event(sessionId, 'user/message', { content: text(value), source: { kind: 'user' } })
  }
  const endTurn = (sessionId, reply, reason = { kind: 'completed' }) => {
    if (reply) event(sessionId, 'assistant/message', { message: { content: text(reply) } })
    event(sessionId, 'turn/end', { turn: seq, reason })
  }
  // The reviewer answering the Solver's request (the path every reply takes, turns.js), on the work
  // message_bot opened for it now (`opened: false`: a reply whose work is gone; `exchangeId`: a given one).
  const reply = (fromId, toId, value, { opened = true, exchangeId = `x${++seq}`, ...extra } = {}) => {
    if (opened && rt.state.works?.[exchangeId] === undefined) rt.openWork(exchangeId, { from: toId, to: fromId })
    return answerSender(rt, fromId, { exchangeId, senderSessionId: toId, ...extra }, value)
  }
  // A Solver as the dialog makes it, through the person's create-bot route.
  const solver = async ({ reviewerId, brief = '' } = {}) => {
    const answer = await call('create-bot', { name: `Solver ${++created}`, role: 'Solver', instructions: 'Method.', brief, ...(reviewerId ? { reviewerId } : {}) })
    assert.equal(answer.ok, true, JSON.stringify(answer))
    return rt.botOf(answer.value.id)
  }
  const reviewer = async () => rt.createBot({ name: `Reviewer ${++created}`, role: 'Reviewer', instructions: 'Review.', pickModel: true })
  return { ctx, rt, home, call, guard, person, endTurn, reply, solver, reviewer, sessions }
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
  ]) assert.equal(verdictOf(value), undefined, String(value))
  // SR5-2: a verdict still counts after a fenced block, with a comment after a comma, and after "Verdict:" in a list item.
  for (const [value, verdict] of [
    ['```\nSHIP\n```\nFIX-FIRST\nLine 2 overclaims.', 'FIX-FIRST'], ['SHIP, with one note below.', 'SHIP'], ['FIX-FIRST: line 2, then SHIP', 'FIX-FIRST'],
    ['- **Verdict:** SHIP', 'SHIP'], ['Checked.\n* Verdict: BLOCKED (no access)', 'BLOCKED'], ['SHIP\n```\nnpm test\n```', 'SHIP'], ['I checked it. Ready? SHIP', 'SHIP'],
  ]) assert.equal(verdictOf(value), verdict, value)
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
  const { rt, call, guard, person, endTurn, reply, solver, reviewer } = bench(t)
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
  rt.closeWork('w-review', ada.name, 'SHIP')
  reply(ada.id, bot.id, 'SHIP\nThe comparison holds.')
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
  const { rt, guard, person, endTurn, reply, solver, reviewer, home } = bench(t)
  const ada = await reviewer()
  const bot = await solver({ reviewerId: ada.id })
  person(bot.id, 'Fix the script.')
  await step()
  reply(ada.id, bot.id, 'FIX-FIRST (plan)\nAdd a check.')
  await step()
  reply(ada.id, bot.id, '**SHIP**')
  await step()
  await guard({ name: 'write', arguments: { file_path: 'a.js' }, agent: { id: bot.id } })
  await step()
  await guard({ name: 'mcp__dsh__bash', arguments: { command: 'node a.js' }, agent: { id: bot.id } })
  await step()
  reply(ada.id, bot.id, 'SHIP')
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
  reply(ada.id, bot.id, 'SHIP')
  await step()
  await guard({ name: 'edit', arguments: {}, agent: { id: bot.id } })
  await step()
  endTurn(bot.id, 'Added it.')
  assert.deepEqual({ ...bot.reviewTrack.last, at: 0 }, { at: 0, review: 'bot', plan: true, result: false })
})

test('a turn that ends with its review still out is not a delivery; a person asking first does not drop the plan review', async (t) => {
  const { rt, person, endTurn, reply, solver, reviewer } = bench(t)
  const ada = await reviewer()
  const bot = await solver({ reviewerId: ada.id })
  person(bot.id, 'Compare two libraries.')
  rt.openWork('w-plan', { from: bot.id, to: ada.id })
  endTurn(bot.id, 'Waiting for my reviewer.')
  assert.equal(bot.reviewTrack.last, undefined)
  rt.closeWork('w-plan', ada.name, 'SHIP')
  reply(ada.id, bot.id, 'SHIP')
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
  const { rt, guard, person, endTurn, reply, solver, reviewer, sessions } = bench(t)
  const ada = await reviewer()
  const bot = await solver({ reviewerId: ada.id })
  person(bot.id, 'Build it.')
  await step()
  reply(ada.id, bot.id, 'SHIP')
  await step()
  const childId = 'child-of-solver'
  sessions.set(childId, Session.create(childId, [], {
    version: SESSION_FORMAT_VERSION, id: childId, createdAt: Date.now(), cwd: '/tmp', parentSession: bot.id, origin: 'subagent', isSeeded: false,
  }))
  assert.equal(await guard({ name: 'bash', arguments: { command: 'make' }, agent: { id: childId } }), 'ran')
  assert.equal(typeof bot.reviewTrack.firstWorkAt, 'number')
  const first = bot.reviewTrack.firstWorkAt
  // Research never dates the work.
  await guard({ name: 'read', arguments: {}, agent: { id: bot.id } })
  await guard({ name: 'acp_tool', arguments: { kind: 'read', input: {} }, agent: { id: bot.id } })
  assert.equal(bot.reviewTrack.lastWorkAt, first)
  // A task run of the Solver is not its own chat.
  rt.state.tasks = { ...rt.state.tasks, 'task-1': { from: bot.id, title: 'side' } }
  assert.equal(await guard({ name: 'write', arguments: {}, agent: { id: 'task-1' } }), 'ran')
  assert.equal(bot.reviewTrack.lastWorkAt, first)
  await step()
  reply(ada.id, bot.id, 'SHIP')
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
  const { rt, guard, person, endTurn, reply, solver, reviewer } = bench(t)
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
  reply(ada.id, bot.id, 'SHIP')
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
  const { call, guard, person, endTurn, reply, solver, reviewer } = bench(t)
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
  reply(ada.id, bot.id, 'SHIP')
  await step()
  await guard({ name: 'write', arguments: {}, agent: { id: bot.id } })
  await step()
  reply(ada.id, bot.id, 'SHIP')
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
  const { rt, call, person, endTurn, reply, solver, reviewer } = bench(t)
  const ada = await reviewer()
  const bot = await solver({ reviewerId: ada.id })
  person(bot.id, 'Do it.')
  await step()
  reply(ada.id, bot.id, 'SHIP')
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
  const { rt, person, endTurn, reply, solver, reviewer } = bench(t)
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
  rt.closeWork('w-plan', ada.name, 'SHIP')
  reply(ada.id, bot.id, 'SHIP')
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
  const { guard, person, endTurn, reply, solver, reviewer } = bench(t)
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
  reply(ada.id, bot.id, 'SHIP')
  await step()
  await guard({ name: 'write', arguments: { file_path: 'compare.md' }, agent: { id: bot.id } })
  await step()
  reply(ada.id, bot.id, 'SHIP')
  await step()
  // SR5-1: a notes write after the result verdict is still work for the result side.
  await guard({ name: 'write', arguments: { file_path: '.solver/notes.md' }, agent: { id: bot.id } })
  endTurn(bot.id, 'Delivered: compare.md.')
  assert.deepEqual({ ...bot.reviewTrack.last, at: 0 }, { at: 0, review: 'bot', plan: true, result: false })
})

// SR5-1: an answer written only into the notes file after two plan verdicts, delivered with no
// result review, reads result unreviewed (never "Plan and result reviewed").
test('a notes-only deliverable with no result review reads result unreviewed', async (t) => {
  const { guard, person, endTurn, reply, solver, reviewer } = bench(t)
  const { folder } = notesFolder(t)
  const ada = await reviewer()
  const bot = await solver({ reviewerId: ada.id })
  bot.workDir = folder
  person(bot.id, 'Research two libraries and give me a one-page comparison.')
  await step()
  reply(ada.id, bot.id, 'FIX-FIRST\nAdd a licence check to the plan.')
  await step()
  reply(ada.id, bot.id, 'SHIP')
  await step()
  assert.equal(await guard({ name: 'write', arguments: { file_path: '.solver/notes.md', content: '# Comparison' }, agent: { id: bot.id } }), 'ran')
  assert.equal(bot.reviewTrack.firstWorkAt, undefined)
  assert.equal(typeof bot.reviewTrack.lastWorkAt, 'number')
  await step()
  endTurn(bot.id, 'Delivered: the comparison is in .solver/notes.md.')
  assert.deepEqual({ ...bot.reviewTrack.last, at: 0 }, { at: 0, review: 'bot', plan: true, result: false })
})

// SR5-1: a delivered file that is a symlink into the notes file, changed through a notes write after
// the result verdict, reads result unreviewed.
test('a delivered symlink into the notes file changed after the result verdict reads result unreviewed', async (t) => {
  const { guard, person, endTurn, reply, solver, reviewer } = bench(t)
  const { folder } = notesFolder(t)
  mkdirSync(join(folder, '.solver'))
  writeFileSync(join(folder, '.solver', 'notes.md'), 'reviewed text')
  const ada = await reviewer()
  const bot = await solver({ reviewerId: ada.id })
  bot.workDir = folder
  person(bot.id, 'Write report.md.')
  await step()
  reply(ada.id, bot.id, 'SHIP')
  await step()
  await guard({ name: 'bash', arguments: { command: 'ln -s .solver/notes.md report.md' }, agent: { id: bot.id } })
  symlinkSync('.solver/notes.md', join(folder, 'report.md'))
  await step()
  reply(ada.id, bot.id, 'SHIP')
  await step()
  assert.equal(isNotesPath('.solver/notes.md', folder, folder), true)
  await guard({ name: 'write', arguments: { file_path: '.solver/notes.md', content: 'unreviewed text' }, agent: { id: bot.id } })
  endTurn(bot.id, 'Delivered: report.md.')
  assert.deepEqual({ ...bot.reviewTrack.last, at: 0 }, { at: 0, review: 'bot', plan: true, result: false })
})

test('any other write before the plan verdict marks the plan unreviewed: lookalikes, .., another folder, a symlink, a link', async (t) => {
  const { guard, person, endTurn, reply, solver, reviewer } = bench(t)
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
    reply(ada.id, bot.id, 'SHIP')
    await step()
    reply(ada.id, bot.id, 'SHIP')
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
  const { guard, person, endTurn, reply, solver, reviewer } = bench(t)
  const ada = await reviewer()
  const bot = await solver({ reviewerId: ada.id })
  person(bot.id, 'Write a three-line note.')
  await step()
  reply(ada.id, bot.id, CODEX_REPLIES[2][0])
  await step()
  reply(ada.id, bot.id, CODEX_REPLIES[0][0])
  await step()
  await guard({ name: 'write', arguments: { file_path: 'note.md' }, agent: { id: bot.id } })
  await step()
  reply(ada.id, bot.id, CODEX_REPLIES[3][0])
  assert.deepEqual(bot.reviewTrack.verdicts.map(entry => entry.verdict), ['FIX-FIRST', 'SHIP', 'SHIP'])
  endTurn(bot.id, 'Delivered: note.md.')
  assert.deepEqual({ ...bot.reviewTrack.last, at: 0 }, { at: 0, review: 'bot', plan: true, result: true })
})

// Run 3 (APP-TEST "Recheck on 262488524"): the person asks for the delivery while the reviewer still
// has the work. That delivery carries a mark that says so; a Solver with a reviewer Bot is never
// marked "fresh" (the no-reviewer line).
test('a delivery made while the reviewer still has the work is marked pending, never fresh, in the view', async (t) => {
  const { rt, call, guard, person, endTurn, reply, solver, reviewer } = bench(t)
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
  reply(ada.id, bot.id, 'SHIP')
  endTurn(bot.id, 'Done.')
  assert.deepEqual({ ...bot.reviewTrack.last, at: 0 }, { at: 0, review: 'bot', plan: true, result: false })
})
