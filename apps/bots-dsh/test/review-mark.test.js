// #2056 (RFC 0048, delivery 1): the Solver's "unreviewed" mark. The host dates a Solver's work
// calls and its reviewer's verdicts per request and marks each delivery with what it saw. It
// grants and refuses nothing.
import { Session, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { ROUTE } from '../src/host/constants.js'
import { isWorkCall } from '../src/host/review-mark.js'
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
  // The reviewer answering the Solver's request (the path every reply takes, turns.js).
  const reply = (fromId, toId, value, extra = {}) => answerSender(rt, fromId, { exchangeId: `x${++seq}`, senderSessionId: toId, ...extra }, value)
  // A Solver as the dialog makes it, through the person's create-bot route.
  const solver = async ({ reviewerId, brief = '' } = {}) => {
    const answer = await call('create-bot', { name: `Solver ${++created}`, role: 'Solver', instructions: 'Method.', brief, ...(reviewerId ? { reviewerId } : {}) })
    assert.equal(answer.ok, true, JSON.stringify(answer))
    return rt.botOf(answer.value.id)
  }
  const reviewer = async () => rt.createBot({ name: `Reviewer ${++created}`, role: 'Reviewer', instructions: 'Review.', pickModel: true })
  return { ctx, rt, home, call, guard, person, endTurn, reply, solver, reviewer, sessions }
}

test('verdictOf reads only a verdict that opens the reply', () => {
  for (const [value, verdict] of [
    ['SHIP', 'SHIP'], ['SHIP\nAll checks hold.', 'SHIP'], ['FIX-FIRST (plan)\n1. ...', 'FIX-FIRST'], ['BLOCKED: no access', 'BLOCKED'],
    ['**SHIP**', 'SHIP'], ['# FIX-FIRST', 'FIX-FIRST'], ['> BLOCKED', 'BLOCKED'], ['`SHIP`', 'SHIP'], ['\n\n  SHIP', 'SHIP'], ['_SHIP_', 'SHIP'],
  ]) assert.equal(verdictOf(value), verdict, value)
  for (const value of ['SHIPPED', 'ship', 'Verdict: SHIP', '', '   ', 'Looks good.\nSHIP', 'FIX-FIRSTLY', 'SHIP-IT', undefined, null, 7]) {
    assert.equal(verdictOf(value), undefined, String(value))
  }
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
  // The person asks for the delivery while the result review is out: it is not a new request.
  person(bot.id, 'Deliver now, please.')
  assert.equal(bot.reviewTrack.verdicts.length, 1)
  endTurn(bot.id, 'Still waiting.')
  assert.equal(bot.reviewTrack.last, undefined)
  rt.dropWork('w-result')
  endTurn(bot.id, 'BLOCKED-review: the result review did not come back.')
  assert.deepEqual({ ...bot.reviewTrack.last, at: 0 }, { at: 0, review: 'bot', plan: true, result: false })
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
  reply(ada.id, bot.id, 'Looks fine to me.\nSHIP')
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
