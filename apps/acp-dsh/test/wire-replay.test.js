// One reproducible round trip (docs/research/t3-code-acp-integration.md recommendation 1): a
// scripted agent (dev/scripted-agent.mjs) plays a Claude-style turn over real stdio to this
// plugin as DSH loads it (index.js `apply`), DSH's own agent loop runs the turn, DSH's JSONL
// session persistence writes the chat, and a second DSH host (a restart) resumes it from that
// file. The test compares the wire (every frame, both ways, normalized) and the chat a person
// reopens (its rows and DSH's `todos` projection, read from the resumed Session) with their
// goldens. A mutated or duplicated frame changes one of them. Variants: the agent's plan and
// usage, the plan beside DSH's own `todo_write` list, Stop while the approval is open, and a
// handshake that stops at auth_required.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk/unstable'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as Todo from '@deepseek-ai/dsh-tool-todo'
import { apply, inject } from '../index.js'
import { CLIENT_CAPABILITIES } from '../src/host/features.js'
import { writeReceipt } from '../scripts/acp-receipts.mjs'

const AGENT = join(import.meta.dirname, '..', 'dev', 'scripted-agent.mjs')
const ROUTE = 'acp-fake'
const SESSION = 'chat'
const SDK = JSON.parse(readFileSync(new URL('../node_modules/@agentclientprotocol/sdk/package.json', import.meta.url), 'utf8')).version

const toolCall = { toolCallId: 'toolu_01', title: 'Run touch report.txt', kind: 'execute', status: 'pending', rawInput: { command: 'touch report.txt' } }
const options = [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'always', name: 'Always', kind: 'allow_always' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }]
const text = value => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } })
const initialize = { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, agentInfo: { name: 'scripted', version: '0.0.0' } }
const items = (planId, ...entries) => ({ update: { sessionUpdate: 'plan_update', plan: { planId, type: 'items', entries: entries.map(([content, status]) => ({ content, status, priority: 'medium' })) } } })

export const APPROVED = {
  initialize,
  session: { sessionId: 'native-1' },
  turn: [
    { update: text('I will create the report.') },
    { update: { sessionUpdate: 'tool_call', ...toolCall } },
    { ask: { toolCall, options } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'toolu_01', status: 'in_progress' } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'toolu_01', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'created report.txt' } }] } },
    { update: text(' Done: report.txt exists.') },
    { end: 'end_turn' },
  ],
}

// The plugin's model catalog first reads the agent's models in a process of its own (catalog.js),
// as it does in the app; then the chat's process.
const CATALOG_PROBE = [{ in: 'initialize', clientCapabilities: 'plan' }, { in: 'session/new', servers: [] }]
// The wire a person's one approval makes. The client answers the question with the allow-once
// option, never the lasting one, and no frame repeats.
const APPROVED_WIRE = [
  ...CATALOG_PROBE,
  { in: 'initialize', clientCapabilities: 'plan' },
  { in: 'session/new', servers: [] },
  { in: 'session/prompt', text: 'make the report' },
  { out: 'session/update', update: 'agent_message_chunk' },
  { out: 'session/update', update: 'tool_call toolu_01 pending' },
  { out: 'session/request_permission', toolCallId: 'toolu_01', options: ['allow_once', 'allow_always', 'reject_once'] },
  { in: 'permission-answer', outcome: 'selected', kind: 'allow_once' },
  { out: 'session/update', update: 'tool_call_update toolu_01 in_progress' },
  { out: 'session/update', update: 'tool_call_update toolu_01 completed' },
  { out: 'session/update', update: 'agent_message_chunk' },
  { out: 'session/prompt', stopReason: 'end_turn' },
]
// The chat the person reopens: their words, the agent's words around one card, one result.
const APPROVED_ROWS = [
  { role: 'user', text: 'make the report' },
  { role: 'assistant', text: 'I will create the report.', calls: 1 },
  { role: 'tool', output: 'created report.txt' },
  { role: 'assistant', text: ' Done: report.txt exists.', calls: 0 },
]

/** The wire, normalized: ids of DSH's own, paths and timings never reach it; an update is its kind, call and status. */
export function normalizeWire(frames) {
  return frames.map((frame) => {
    if (frame.in === 'initialize') return { in: 'initialize', clientCapabilities: Object.keys(frame.clientCapabilities ?? {}).filter(key => frame.clientCapabilities[key] != null && key !== 'auth' && key !== 'fs' && key !== 'terminal').sort().join(',') }
    if (frame.out === 'session/update') {
      const u = frame.update
      return { out: 'session/update', update: [u.sessionUpdate, u.toolCallId, u.status].filter(Boolean).join(' ') }
    }
    return frame
  }).filter(frame => !['session/set_mode', 'session/set_config_option', 'session/close'].includes(frame.in))
}

const textOf = content => (Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('') : String(content ?? ''))
// DSH's own context rows (the system prompt, its runtime context) are not this plugin's.
const DSH_CONTEXT = new Set(['system-prompt', 'runtime-context', 'time-context', 'skill-catalog'])

/** The rows a reopened chat shows, from the resumed Session's messages as DSH derives them. */
export function rowsOf(messages) {
  return messages.filter(message => message.role !== 'system' && !DSH_CONTEXT.has(message.source?.kind)).map((message) => {
    if (message.role === 'user' && message.source?.form === 'notice') return { role: 'notice', notice: message.source.notice, summary: message.source.summary, text: textOf(message.content) }
    if (message.role === 'user') return { role: 'user', text: textOf(message.content) }
    if (message.role === 'tool') return { role: 'tool', output: textOf(message.content).trim() }
    return { role: 'assistant', text: textOf(message.content), calls: message.content.filter(block => block.type === 'tool-call').length }
  })
}

/** A DSH host as the app loads it, on the session files under `root`. */
async function host(t, root, { approval } = {}) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(Jsonl, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(Todo, { allowParallelInProgress: false })
  const asked = []
  ctx.provide('approval', { effectivePolicy: () => 'ask', request: async (request) => { asked.push(request.callId); return approval ? approval(request, ctx) : 'allowed-once' } })
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write' }) })
  await ctx.plugin({
    name: 'acp-dsh-under-test',
    inject,
    apply: scoped => apply(scoped, { fakeAgent: AGENT, claude: false, codex: false, dshTools: false }, { store: { binOf: () => undefined, update: async () => {}, dispose() {} }, find: () => undefined }),
  })
  await mountAgentLoopTestHarness(ctx)
  return { ctx, asked }
}

function world(t, script) {
  const root = mkdtempSync(join(tmpdir(), 'acp-wire-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const scriptPath = join(root, 'script.json')
  const trace = join(root, 'trace.ndjson')
  writeFileSync(scriptPath, JSON.stringify(script))
  // The scripted agent inherits these: the plugin spawns it as it spawns any agent.
  const before = { script: process.env.SCRIPTED_ACP_SCRIPT, trace: process.env.SCRIPTED_ACP_TRACE }
  process.env.SCRIPTED_ACP_SCRIPT = scriptPath
  process.env.SCRIPTED_ACP_TRACE = trace
  t.after(() => {
    for (const [key, value] of [['SCRIPTED_ACP_SCRIPT', before.script], ['SCRIPTED_ACP_TRACE', before.trace]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const wire = () => (existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [])
  return { root, wire, log: join(root, 'sessions') }
}

/** One turn through DSH's loop: the person's words in, until the agent is idle again. */
async function say(agent, words) {
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: words }] }))
  for (let i = 0; i < 100 && agent.status !== 'running' && agent.inbox.nextTurn.length > 0; i += 1) await delay(10)
  await agent.whenIdle()
}

/** Runs `script` for one turn on a fresh chat, restarts DSH and reopens the chat from its file. */
async function roundTrip(t, script, { approval, during } = {}) {
  const w = world(t, script)
  const first = await host(t, w.root, { approval })
  const { agent } = await first.ctx.agentLoop.createAgent(first.ctx, { sessionId: SESSION, agentOptions: { provider: ROUTE, model: 'default' }, meta: { cwd: w.root } })
  await (during ? during(agent, first) : say(agent, 'make the report'))
  const live = { todos: first.ctx.sessionProjections.stateOf(agent.session, 'todos'), rows: rowsOf(agent.session.deriveMessages()) }
  await first.ctx.fiber.dispose()
  // The restart: a new host reads the chat back from DSH's own session file.
  const second = await host(t, w.root)
  const { agent: back } = await second.ctx.agentLoop.resume(second.ctx, { resumeSessionId: SESSION, agentOptions: { provider: ROUTE, model: 'default' } })
  const reopened = { todos: second.ctx.sessionProjections.stateOf(back.session, 'todos'), rows: rowsOf(back.session.deriveMessages()) }
  return { ...w, asked: first.asked, live, reopened, back, second }
}

test('one approved tool call: the wire and the reopened chat match their goldens', { timeout: 60_000 }, async (t) => {
  const r = await roundTrip(t, APPROVED)
  assert.deepEqual(normalizeWire(r.wire()), APPROVED_WIRE)
  assert.deepEqual(r.reopened.rows, APPROVED_ROWS)
  assert.deepEqual(r.reopened.rows, r.live.rows, 'the reopened chat is the chat as it was')
  assert.equal(r.asked.length, 1, 'one approval for one call')
  assert.equal(r.reopened.todos, null, 'no plan, no list')
  assert.deepEqual(CLIENT_CAPABILITIES, { plan: {} })
  writeReceipt(process.env.ACP_RECEIPT_DIR, {
    route: 'acp-scripted', scenario: 'synthetic-replay', sdk: SDK, platform: `${process.platform}-${process.arch}`, node: process.version,
    phases: { initialize: 'passed', session: 'passed', prompt: 'passed', toolApproval: 'passed' },
  })
})

test('the goldens catch a mutated frame and a duplicated result', { timeout: 60_000 }, async (t) => {
  // A changed output, and a completed update sent twice: each run differs from the golden.
  const mutated = structuredClone(APPROVED)
  mutated.turn[4].update.content[0].content.text = 'created other.txt'
  const duplicated = structuredClone(APPROVED)
  duplicated.turn.splice(5, 0, structuredClone(duplicated.turn[4]))
  for (const [name, script, differs] of [['mutated', mutated, 'rows'], ['duplicated', duplicated, 'wire']]) {
    const r = await roundTrip(t, script)
    if (differs === 'rows') assert.throws(() => assert.deepEqual(r.reopened.rows, APPROVED_ROWS), name)
    else assert.throws(() => assert.deepEqual(normalizeWire(r.wire()), APPROVED_WIRE), name)
    // Whatever the agent repeats, the reopened chat keeps one card and one result.
    assert.equal(r.reopened.rows.filter(row => row.role === 'tool').length, 1, name)
  }
})

// The agent's plan, changed three times in one prompt (an items plan updated in place, a
// markdown plan, then the markdown plan withdrawn and the items plan finished), and its usage.
export const PLANNED = {
  ...APPROVED,
  turn: [
    items('steps', ['Create the report', 'in_progress'], ['Check it', 'pending']),
    { update: { sessionUpdate: 'plan_update', plan: { planId: 'notes', type: 'markdown', content: '# Report plan\n\n1. Touch the file.\n2. Check it exists.' } } },
    ...APPROVED.turn.slice(0, 5),
    items('steps', ['Create the report', 'completed'], ['Check it', 'in_progress']),
    { update: { sessionUpdate: 'plan_update', plan: { planId: 'notes', type: 'markdown', content: '# Report plan\n\n1. Touch the file. Done.\n2. Check it exists.' } } },
    items('steps', ['Create the report', 'completed'], ['Check it', 'completed']),
    APPROVED.turn[5],
    { end: 'end_turn', usage: { totalTokens: 1530, inputTokens: 1200, outputTokens: 330, cachedReadTokens: 900 } },
  ],
}

test('the plan and the usage: one list in DSH\'s todo panel, one row per plan, one usage row, all there after a restart', { timeout: 60_000 }, async (t) => {
  const r = await roundTrip(t, PLANNED)
  // The panel draws the items plan, updated in place: its last state, one list.
  assert.deepEqual(r.reopened.todos, [{ content: 'Create the report', status: 'completed' }, { content: 'Check it', status: 'completed' }])
  assert.deepEqual(r.reopened.todos, r.live.todos)
  const notices = r.reopened.rows.filter(row => row.role === 'notice')
  // The markdown plan is one row with its last text; the items plan has its panel, no row.
  assert.deepEqual(notices.map(row => [row.notice, row.summary]), [
    ['plan', 'Plan: Report plan'],
    ['usage', 'Tokens: 1,200 in · 330 out · 900 cache read · 1,530 total (as the agent reported it)'],
  ])
  assert.match(notices[0].text, /1\. Touch the file\. Done\./)
  // The words and the card are as before: the plan and usage add rows, never change the reply.
  assert.deepEqual(r.reopened.rows.filter(row => row.role !== 'notice'), APPROVED_ROWS)
  // The panel was written once per real change, never for an equal list (the markdown updates).
  const writes = r.back.session.snapshotEvents(0).filter(event => event.type === 'todo/write')
  assert.equal(writes.length, 3)
  writeReceipt(process.env.ACP_RECEIPT_DIR, { route: 'acp-scripted', scenario: 'synthetic-replay', sdk: SDK, platform: `${process.platform}-${process.arch}`, node: process.version, phases: { plan: 'passed', usage: 'passed' } })
})

test('a markdown plan withdrawn before the prompt ends leaves no row', { timeout: 60_000 }, async (t) => {
  const script = { ...APPROVED, turn: [
    { update: { sessionUpdate: 'plan_update', plan: { planId: 'notes', type: 'markdown', content: '# Draft' } } },
    { update: { sessionUpdate: 'plan_removed', planId: 'notes' } },
    { update: text('No plan after all.') },
    { end: 'end_turn' },
  ] }
  const r = await roundTrip(t, script)
  assert.deepEqual(r.reopened.rows.filter(row => row.role === 'notice'), [])
  assert.equal(r.reopened.todos, null)
})

// DSH's own `todo_write` (the real tool, run in the same turn) owns the panel: the agent's
// items plan never replaces that list, whichever came first, and shows as a row instead.
for (const [order, turn] of [
  ['the agent\'s plan first', [items('steps', ['Agent step', 'in_progress']), APPROVED.turn[0], APPROVED.turn[1], APPROVED.turn[2], items('steps', ['Agent step', 'completed']), APPROVED.turn[4], APPROVED.turn[5], APPROVED.turn[6]]],
  ['DSH\'s list first', [APPROVED.turn[0], APPROVED.turn[1], APPROVED.turn[2], items('steps', ['Agent step', 'completed']), APPROVED.turn[4], APPROVED.turn[5], APPROVED.turn[6]]],
]) {
  test(`DSH's own todo list is never overwritten by the agent's plan (${order})`, { timeout: 60_000 }, async (t) => {
    const own = [{ content: 'Person\'s task', status: 'in_progress' }]
    const r = await roundTrip(t, { ...APPROVED, turn }, {
      // The approval is where DSH's own tool runs in this turn: the real todo_write, on the agent.
      approval: async (request, ctx) => {
        const agent = ctx.get('agents').get(SESSION)
        await ctx.tools.get('todo_write').execute({ todos: own }, { agent })
        return 'allowed-once'
      },
    })
    assert.deepEqual(r.reopened.todos, own)
    const plans = r.reopened.rows.filter(row => row.notice === 'plan')
    assert.equal(plans.length, 1)
    assert.equal(plans[0].summary, 'Plan: 1 of 1 done')
    assert.match(plans[0].text, /- \[x\] Agent step/)
  })
}

test('Stop while the approval is open: the question is withdrawn, the agent is cancelled, and the tool never runs', { timeout: 60_000 }, async (t) => {
  const script = { ...APPROVED, turn: [APPROVED.turn[0], APPROVED.turn[1], APPROVED.turn[2], { update: text('should not arrive') }, { end: 'end_turn' }] }
  const r = await roundTrip(t, script, {
    approval: ({ signal }) => new Promise((resolve) => {
      signal?.addEventListener('abort', () => resolve('denied'), { once: true })
    }),
    during: async (agent, first) => {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'make the report' }] }))
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline && first.asked.length === 0) await delay(10)
      agent.cancel()
      await agent.whenIdle()
    },
  })
  // The agent writes its trace after the answer reaches it: wait for those frames, bounded.
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && !(r.wire().some(frame => frame.in === 'permission-answer') && r.wire().some(frame => frame.in === 'session/cancel'))) {
    await delay(20)
  }
  const wire = normalizeWire(r.wire())
  assert.deepEqual(wire.find(frame => frame.in === 'permission-answer'), { in: 'permission-answer', outcome: 'cancelled' })
  assert.ok(wire.some(frame => frame.in === 'session/cancel'), JSON.stringify(wire))
  assert.equal(wire.some(frame => frame.update === 'tool_call_update toolu_01 completed'), false)
  assert.equal(r.reopened.rows.some(row => row.role === 'tool' && row.output === 'created report.txt'), false)
  assert.equal(JSON.stringify(r.reopened.rows).includes('should not arrive'), false)
  writeReceipt(process.env.ACP_RECEIPT_DIR, { route: 'acp-scripted', scenario: 'synthetic-replay', sdk: SDK, platform: `${process.platform}-${process.arch}`, node: process.version, phases: { stop: 'passed' } })
})

test('an auth_required handshake: no prompt is sent and the reopened chat says to sign in', { timeout: 60_000 }, async (t) => {
  const r = await roundTrip(t, { ...APPROVED, session: { authRequired: true } })
  assert.deepEqual(normalizeWire(r.wire()).map(frame => frame.in ?? frame.out), [...CATALOG_PROBE, ...CATALOG_PROBE].map(frame => frame.in))
  const errors = r.back.session.snapshotEvents(0).filter(event => event.type === 'turn/end')
  assert.equal(errors.length, 1)
  assert.match(JSON.stringify(errors[0].data), /sign in|signed in|Sign in/i)
  writeReceipt(process.env.ACP_RECEIPT_DIR, { route: 'acp-scripted', scenario: 'synthetic-replay', sdk: SDK, platform: `${process.platform}-${process.arch}`, node: process.version, phases: { recovery: 'passed' } })
})

test('a plan the chat shows, withdrawn in the next prompt, gets one row saying so', { timeout: 60_000 }, async (t) => {
  const plan = { update: { sessionUpdate: 'plan_update', plan: { planId: 'notes', type: 'markdown', content: '# Draft\n\nOne step.' } } }
  const script = { ...APPROVED, turns: [
    [plan, { update: text('Planned.') }, { end: 'end_turn' }],
    [{ update: { sessionUpdate: 'plan_removed', planId: 'notes' } }, { update: text('Dropped it.') }, { end: 'end_turn' }],
  ] }
  const r = await roundTrip(t, script, { during: async (agent) => { await say(agent, 'plan it'); await say(agent, 'drop it') } })
  assert.deepEqual(r.reopened.rows.filter(row => row.role === 'notice').map(row => row.summary), ['Plan: Draft', 'The agent withdrew its plan'])
})

// The desktop app reads a chat with DSH's pinned persistence worker and its carried loader patch
// (apps/desktop/test/acp-reopen-fixture.test.js). That test reads this file: the chat this suite
// writes for PLANNED, as DSH wrote it, with times and the temporary folder made stable. It must
// stay the chat this plugin writes now: ACP_WRITE_REOPEN_FIXTURE=1 writes it again.
const FIXTURE = join(import.meta.dirname, '..', '..', 'desktop', 'test', 'fixtures', 'acp-reopen', 'planned.v4.jsonl')
const shapeOf = lines => lines.map(line => [line.type, line.data?.recordType ?? line.data?.message?.source?.notice ?? line.data?.message?.role ?? null])

test('the reopened chat file the desktop test reads is the one this plugin writes', { timeout: 60_000 }, async (t) => {
  const r = await roundTrip(t, PLANNED)
  await r.second.ctx.fiber.dispose()
  const file = readdirSync(r.log, { recursive: true }).find(name => String(name).endsWith('session.v4.jsonl'))
  const raw = readFileSync(join(r.log, file), 'utf8').replaceAll(r.root, '/workspace').replaceAll(JSON.stringify(r.root).slice(1, -1), '/workspace')
  const lines = raw.trim().split('\n').map(line => JSON.parse(line)).map(line => ('time' in line ? { ...line, time: 0 } : 'createdAt' in line ? { ...line, createdAt: 0 } : line))
  const stable = `${lines.map(line => JSON.stringify(line)).join('\n')}\n`
  assert.equal(stable.includes(tmpdir()), false, 'no temporary path is kept')
  if (process.env.ACP_WRITE_REOPEN_FIXTURE === '1') {
    mkdirSync(join(FIXTURE, '..'), { recursive: true })
    writeFileSync(FIXTURE, stable)
  }
  const committed = readFileSync(FIXTURE, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(shapeOf(committed), shapeOf(lines))
})
