// One reproducible round trip (docs/research/t3-code-acp-integration.md recommendation 1): a
// scripted agent (dev/scripted-agent.mjs) plays a Claude-style turn over real stdio, the real
// adapter and mirror tool run it the way DSH's loop does, and the test compares both the wire
// (every frame, both ways, normalized) and the chat a person reopens (the rows, written out and
// read back) with their goldens. A mutated or duplicated frame changes one of them. Variants:
// Stop while the approval is open, and a handshake that stops at auth_required.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk/unstable'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { AcpAdapter } from '../src/host/adapter.js'
import { CLIENT_CAPABILITIES } from '../src/host/features.js'
import { writeReceipt } from '../scripts/acp-receipts.mjs'

const AGENT = join(import.meta.dirname, '..', 'dev', 'scripted-agent.mjs')
const ROUTE = 'acp-scripted'
const SDK = JSON.parse(readFileSync(new URL('../node_modules/@agentclientprotocol/sdk/package.json', import.meta.url), 'utf8')).version

const toolCall = { toolCallId: 'toolu_01', title: 'Run touch report.txt', kind: 'execute', status: 'pending', rawInput: { command: 'touch report.txt' } }
const options = [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'always', name: 'Always', kind: 'allow_always' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }]
const text = value => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } })
const initialize = { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, agentInfo: { name: 'scripted', version: '0.0.0' } }

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

// The wire a person's one approval makes. The client answers the question with the allow-once
// option, never the lasting one, and no frame repeats.
const APPROVED_WIRE = [
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
  { role: 'tool', status: 'completed', output: 'created report.txt' },
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

/** The rows a reopened chat shows, from its messages as written out and read back. */
export function rowsOf(messages) {
  const reopened = JSON.parse(JSON.stringify(messages))
  return reopened.map((message) => {
    if (message.role === 'user') return { role: 'user', text: message.content.map(block => block.text).join('') }
    if (message.role === 'tool') return { role: 'tool', status: message.meta?.status, output: String(message.content?.map?.(block => block.text).join('') ?? message.content).trim() }
    return { role: 'assistant', text: message.content.filter(block => block.type === 'text').map(block => block.text).join(''), calls: message.content.filter(block => block.type === 'tool-call').length }
  })
}

function world(t, script, { approval } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-wire-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const scriptPath = join(dir, 'script.json')
  const trace = join(dir, 'trace.ndjson')
  writeFileSync(scriptPath, JSON.stringify(script))
  const session = Session.create('s1')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 0 })
  const tools = new Map()
  const agent = { session, ctx: { tools: { register: (def) => { tools.set(def.name, def); return () => tools.delete(def.name) } } } }
  const asked = []
  const ctx = {
    agents: { get: () => agent, turnBoundaryOf: () => ({ lastTurn: 1 }) },
    get: (key) => {
      if (key === 'approval') return { effectivePolicy: () => 'ask', request: async (request) => { asked.push(request.callId); return approval ? approval(request) : 'allowed-once' } }
      if (key === 'sandboxPolicy') return { resolve: () => ({ mode: 'workspace-write' }) }
      if (key === 'agentPresets') return { presetForSession: () => 'standard' }
      return undefined
    },
    logger: { warn: () => {}, info: () => {} },
  }
  const catalog = { models: async () => [{ id: 'default', name: 'Scripted' }], model: async () => undefined, ownEffort: () => undefined, dispose() {} }
  const spec = { name: 'Scripted agent', catalog, installed: () => true, spawn: () => ({ command: process.execPath, args: [AGENT], env: { SCRIPTED_ACP_SCRIPT: scriptPath, SCRIPTED_ACP_TRACE: trace } }) }
  const adapter = new AcpAdapter(ctx, new Map([[ROUTE, spec]]), { dshTools: () => false })
  t.after(() => adapter.dispose())
  const wire = () => (existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [])
  return { adapter, session, agent, tools, asked, wire }
}

// DSH's loop for one turn: steps until the model stops, the mirror tool run between them.
async function turn(h, messages, said, signal) {
  messages.push({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: said }] })
  for (;;) {
    const chunks = []
    for await (const chunk of h.adapter.stream(markAgentLoopRequest({ provider: ROUTE, model: 'default', sessionId: 's1', messages, signal }))) chunks.push(chunk)
    const blocks = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
    messages.push({ role: 'assistant', source: { kind: 'model', provider: ROUTE, model: 'default' }, content: blocks })
    const finish = chunks.at(-1)
    if (finish.reason.kind !== 'tool-calls') return finish
    for (const call of blocks.filter(block => block.type === 'tool-call')) {
      const tool = h.tools.get(call.name)
      const args = JSON.parse(call.arguments)
      const value = await tool.execute(args, { agent: h.agent, callId: call.id, signal: signal ?? new AbortController().signal })
      messages.push({ role: 'tool', toolCallId: call.id, source: { kind: 'tool', callId: call.id }, content: tool.output.render(args, value), meta: tool.output.presentationMeta(args, value) })
    }
  }
}

test('one approved tool call: the wire and the reopened chat match their goldens', async (t) => {
  const h = world(t, APPROVED)
  const messages = []
  const finish = await turn(h, messages, 'make the report')
  assert.equal(finish.reason.kind, 'stop')
  assert.deepEqual(normalizeWire(h.wire()), APPROVED_WIRE)
  assert.deepEqual(rowsOf(messages), APPROVED_ROWS)
  assert.equal(h.asked.length, 1, 'one approval for one call')
  assert.deepEqual(CLIENT_CAPABILITIES, { plan: {} })
  writeReceipt(process.env.ACP_RECEIPT_DIR, {
    route: ROUTE, scenario: 'synthetic-replay', sdk: SDK, platform: `${process.platform}-${process.arch}`, node: process.version,
    phases: { initialize: 'passed', session: 'passed', prompt: 'passed', toolApproval: 'passed' },
  })
})

test('the goldens catch a mutated frame and a duplicated result', async (t) => {
  // A changed output, and a completed update sent twice: each run differs from the golden.
  const mutated = structuredClone(APPROVED)
  mutated.turn[4].update.content[0].content.text = 'created other.txt'
  const duplicated = structuredClone(APPROVED)
  duplicated.turn.splice(5, 0, structuredClone(duplicated.turn[4]))
  for (const [name, script, differs] of [['mutated', mutated, 'rows'], ['duplicated', duplicated, 'wire']]) {
    const h = world(t, script)
    const messages = []
    await turn(h, messages, 'make the report')
    if (differs === 'rows') assert.throws(() => assert.deepEqual(rowsOf(messages), APPROVED_ROWS), name)
    else assert.throws(() => assert.deepEqual(normalizeWire(h.wire()), APPROVED_WIRE), name)
    // Whatever the agent repeats, the chat keeps one card and one result.
    assert.equal(rowsOf(messages).filter(row => row.role === 'tool').length, 1, name)
  }
})

test('Stop while the approval is open: the question is withdrawn, the agent is cancelled, and the tool never runs', async (t) => {
  const stop = new AbortController()
  const h = world(t, { ...APPROVED, turn: [APPROVED.turn[0], APPROVED.turn[1], APPROVED.turn[2], { update: text('should not arrive') }, { end: 'end_turn' }] }, {
    approval: ({ signal }) => new Promise((resolve) => {
      setTimeout(() => stop.abort(), 50)
      signal?.addEventListener('abort', () => resolve('denied'), { once: true })
    }),
  })
  const messages = []
  await turn(h, messages, 'make the report', stop.signal).catch(() => {})
  const wire = normalizeWire(h.wire())
  const answered = wire.find(frame => frame.in === 'permission-answer')
  assert.deepEqual(answered, { in: 'permission-answer', outcome: 'cancelled' })
  assert.ok(wire.some(frame => frame.in === 'session/cancel'), JSON.stringify(wire))
  assert.equal(wire.some(frame => frame.update === 'tool_call_update toolu_01 completed'), false)
  assert.equal(rowsOf(messages).some(row => row.role === 'tool' && row.status === 'completed'), false)
  assert.equal(JSON.stringify(messages).includes('should not arrive'), false)
  writeReceipt(process.env.ACP_RECEIPT_DIR, { route: ROUTE, scenario: 'synthetic-replay', sdk: SDK, platform: `${process.platform}-${process.arch}`, node: process.version, phases: { stop: 'passed' } })
})

test('an auth_required handshake: no prompt is sent and the chat says to sign in', async (t) => {
  const h = world(t, { ...APPROVED, session: { authRequired: true } })
  const messages = []
  const finish = await turn(h, messages, 'make the report')
  assert.equal(finish.reason.kind, 'error')
  assert.match(finish.reason.failure.message, /sign in|signed in|Sign in/i)
  assert.deepEqual(normalizeWire(h.wire()).map(frame => frame.in ?? frame.out), ['initialize', 'session/new'])
  writeReceipt(process.env.ACP_RECEIPT_DIR, { route: ROUTE, scenario: 'synthetic-replay', sdk: SDK, platform: `${process.platform}-${process.arch}`, node: process.version, phases: { recovery: 'passed' } })
})
