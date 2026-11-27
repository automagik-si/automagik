import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createAssistantMessage, createToolResultMessage, createUserMessage, markAgentLoopRequest,
} from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { apply } from '../index.js'
import { SYNTHETIC_KIND } from '../src/host/names.js'
import { TOOL_NAME } from '../src/host/tool.js'

const FAKE_AGENT = join(import.meta.dirname, '..', 'dev', 'fake-agent.mjs')
const MODEL = { provider: 'acp-fake', model: 'default' }
const textIn = chunks => chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
const context = kind => createUserMessage({
  source: { kind, form: 'snapshot' }, content: [{ type: 'text', text: `A ${kind} snapshot.` }],
})
const advertisement = () => createAssistantMessage({
  source: { provider: MODEL.provider, model: MODEL.model, synthetic: SYNTHETIC_KIND },
  content: [{ type: 'tool-call', id: 'bridge_2', name: 'job_output', arguments: '{}' }],
})

async function betweenMirrors(t) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-context-step-'))
  const trace = join(dir, 'trace.ndjson')
  const session = Session.create('context-step', undefined, {
    version: 4, id: 'context-step', createdAt: 0, isSeeded: false, cwd: dir,
  })
  const disposers = []
  const tools = new Map()
  const agent = {
    session, model: { current: () => MODEL }, options: { provider: MODEL.provider }, status: 'idle',
    ctx: { tools: { register: definition => {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    } } },
  }
  let adapter
  const ctx = {
    llm: { registerAdapter: (_providers, registered) => {
      adapter = registered
      return () => {}
    } },
    agents: { get: id => id === session.id ? agent : undefined, list: () => [agent] },
    get: name => ({
      approval: { effectivePolicy: () => 'never' },
      sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
    })[name],
    on: () => () => {},
    effect: fn => disposers.push(fn()),
    provide: () => {},
  }
  const beforeTrace = process.env.FAKE_ACP_TRACE
  process.env.FAKE_ACP_TRACE = trace
  t.after(() => {
    for (const dispose of disposers) dispose()
    if (beforeTrace === undefined) delete process.env.FAKE_ACP_TRACE
    else process.env.FAKE_ACP_TRACE = beforeTrace
    rmSync(dir, { recursive: true, force: true })
  })
  apply(ctx, { fakeAgent: FAKE_AGENT, claude: false, codex: false, dshTools: true })

  const step = async (...trailing) => {
    const chunks = []
    for await (const chunk of adapter.stream(markAgentLoopRequest({
      ...MODEL, sessionId: session.id, messages: [...session.deriveMessages(), ...trailing],
      signal: AbortSignal.timeout(10_000),
    }))) chunks.push(chunk)
    return chunks
  }
  const wire = () => readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    .filter(({ event }) => event === 'prompt' || event === 'cancel').map(({ event }) => event)

  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', { header: { config: MODEL }, reason: 'initial' })
  session.append('user/message', createUserMessage({
    source: { kind: 'user' }, content: [{ type: 'text', text: 'run twice' }],
  }), { surfaceOp: 'append' })
  const chunks = await step()
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls', JSON.stringify(chunks.at(-1)))
  const blocks = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
  const call = blocks.find(block => block.type === 'tool-call')
  assert.equal(call?.name, TOOL_NAME)
  session.append('assistant/message', {
    turn: 1, step: 1, stream: [], message: createAssistantMessage({ content: blocks, source: MODEL }),
  }, { surfaceOp: 'append' })
  const callSeq = session.append('tool/call', {
    turn: 1, step: 1, callId: call.id, name: call.name, arguments: call.arguments,
  }).seq
  const mirror = tools.get(TOOL_NAME)
  const args = JSON.parse(call.arguments)
  assert.equal(args.id, 'call-1-1')
  const result = await mirror.execute(args, { agent, callId: call.id, signal: AbortSignal.timeout(10_000) })
  assert.equal(result.text, 'hello 1')
  session.append('tool/result', {
    turn: 1, step: 1,
    message: createToolResultMessage({
      callId: call.id, content: mirror.output.render(args, result), isError: false,
    }),
  }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
  session.append('step/end', { turn: 1, step: 1 })
  const live = adapter.live.get(session.id)
  assert.equal(live?.run.busy, true, 'the second mirror keeps the prompt running')
  assert.equal(live.calls.has(call.id), true)
  assert.equal(session.deriveMessages().at(-1).toolCallId, call.id)
  session.append('step/start', { turn: 1, step: 2 })
  return { adapter, session, live, step, wire }
}

for (const [name, trailing] of [
  ['U1 time-context', () => [context('time-context')]],
  ['U2 runtime-context', () => [context('runtime-context')]],
  ['U2 skill-catalog', () => [context('skill-catalog')]],
  ['U2b ds-bot-time-context', () => [context('ds-bot-time-context')]],
  ['U3 bridge then clock', () => [advertisement(), context('time-context')]],
  ['U3 clock then bridge', () => [context('time-context'), advertisement()]],
]) {
  test(`#2130 ${name}: continue the live mirror prompt`, async t => {
    const { adapter, session, live, step, wire } = await betweenMirrors(t)
    const chunks = await step(...trailing())
    assert.deepEqual(wire(), ['prompt'], 'the clock must not cancel or replace the prompt')
    assert.match(textIn(chunks), /It printed hello 1\./)
    assert.doesNotMatch(textIn(chunks), /was interrupted before it finished/)
    assert.equal(adapter.live.get(session.id), live)
  })
}

test('#2130 U4: a stale mirror result followed by the clock sends no new prompt', async t => {
  const { adapter, session, step, wire } = await betweenMirrors(t)
  adapter.endSession(session.id)
  assert.equal(adapter.live.has(session.id), false)
  const prompts = wire().filter(event => event === 'prompt').length
  const chunks = await step(context('time-context'))
  assert.equal(wire().filter(event => event === 'prompt').length, prompts, 'the stale step must not start a prompt')
  assert.match(textIn(chunks), /was interrupted before it finished/)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(adapter.live.has(session.id), false)
})

test('#2130 U5: a user message before the clock still starts a fresh prompt', async t => {
  const { step, wire } = await betweenMirrors(t)
  const user = createUserMessage({
    source: { kind: 'user' }, content: [{ type: 'text', text: 'plain new turn' }],
  })
  const chunks = await step(user, context('time-context'))
  assert.deepEqual(wire(), ['prompt', 'cancel', 'prompt'])
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.doesNotMatch(textIn(chunks), /was interrupted before it finished/)
})
