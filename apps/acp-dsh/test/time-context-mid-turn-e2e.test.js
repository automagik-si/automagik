import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import LlmRuntime, {
  createAssistantMessage, createToolResultMessage, createUserMessage, markAgentLoopRequest,
} from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { apply, inject } from '../index.js'
import { TOOL_NAME } from '../src/host/tool.js'

const FAKE_AGENT = join(import.meta.dirname, '..', 'dev', 'fake-agent.mjs')
const MODEL = { provider: 'acp-fake', model: 'default' }
const TURN = 1
const textIn = content => content.filter(block => block.type === 'text').map(block => block.text).join('').trim()

function readTrace(path) {
  if (!existsSync(path)) return []
  const raw = readFileSync(path, 'utf8')
  return raw.split('\n').slice(0, -1).map(line => JSON.parse(line))
}

function checkTrace(trace, step) {
  const events = readTrace(trace).filter(({ event }) => event === 'prompt' || event === 'cancel')
  if (events.some(({ event }) => event === 'cancel') || events.length > 1) {
    assert.fail(`step ${step}: unexpected ACP cancel or replacement prompt: ${JSON.stringify(events)}`)
  }
  return events
}

async function drainStep(adapter, request, trace, step, controller) {
  const watch = new AbortController()
  const watching = (async () => {
    while (!watch.signal.aborted) {
      checkTrace(trace, step)
      await delay(5, undefined, { signal: watch.signal })
    }
  })()
  const draining = (async () => {
    const chunks = []
    for await (const chunk of adapter.stream(markAgentLoopRequest(request))) chunks.push(chunk)
    return chunks
  })()
  try {
    const chunks = await Promise.race([draining, watching])
    checkTrace(trace, step)
    return chunks
  } finally {
    watch.abort()
    controller.abort()
  }
}

test('#2130: the real pre-step clock lets both mirrors finish in one ACP prompt', { timeout: 30_000 }, async t => {
  const clock = await import('@deepseek-ai/dsh-time-context').catch(cause => {
    throw new Error('Install the ACP test harness with bun run harness', { cause })
  })
  const dir = mkdtempSync(join(tmpdir(), 'acp-time-context-e2e-'))
  const trace = join(dir, 'trace.ndjson')
  const beforeTrace = process.env.FAKE_ACP_TRACE
  process.env.FAKE_ACP_TRACE = trace
  t.after(() => {
    if (beforeTrace === undefined) delete process.env.FAKE_ACP_TRACE
    else process.env.FAKE_ACP_TRACE = beforeTrace
    rmSync(dir, { recursive: true, force: true })
  })

  const ctx = new Context()
  const session = Session.create('time-context-e2e', undefined, {
    version: 4, id: 'time-context-e2e', createdAt: 0, isSeeded: false, cwd: dir,
  })
  const tools = new Map()
  const agent = {
    id: session.id, session, model: { current: () => MODEL }, options: { provider: MODEL.provider }, status: 'running',
    ctx: { tools: { register: definition => {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    } } },
  }
  ctx.provide('agents', { get: id => id === session.id ? agent : undefined, list: () => [agent] })
  ctx.provide('sessions', { flush: async () => {} })
  ctx.provide('approval', { effectivePolicy: () => 'never' })
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access' }) })
  const llm = ctx.plugin(LlmRuntime)
  const projections = ctx.plugin(SessionProjectionRegistry)
  await llm
  await projections
  const clockPlugin = ctx.plugin(clock, { timeZone: 'UTC', refreshIntervalMs: 0 })
  const acp = ctx.plugin({
    name: 'acp-dsh-under-test',
    inject,
    apply: scoped => apply(scoped, { fakeAgent: FAKE_AGENT, claude: false, codex: false, dshTools: true }, {
      store: { binOf: () => undefined, update: async () => {}, dispose() {} },
      find: () => undefined,
    }),
  })
  t.after(async () => {
    await acp.dispose()
    await clockPlugin.dispose()
    await projections.dispose()
    await llm.dispose()
  })
  await clockPlugin
  await acp
  const dispatch = agentEvents(ctx, agent)
  await dispatch.serial('agent/created', {})
  const mirror = tools.get(TOOL_NAME)
  assert.ok(mirror, 'the live fixture agent has the registered mirror')
  const { adapter } = ctx.llm.adapters.get(MODEL.provider)
  const mirrorIds = []
  let requests = 0
  const stream = adapter.stream.bind(adapter)
  adapter.stream = options => {
    const step = ++requests
    if (step > 1) {
      const [previousResult, sample] = options.messages.slice(-2)
      assert.equal(previousResult.role, 'tool')
      assert.equal(previousResult.toolCallId, mirrorIds[step - 2])
      assert.equal(sample.source.kind, 'time-context')
      assert.equal(sample.source.form, 'snapshot')
      assert.match(textIn(sample.content), new RegExp(`^Time sampled while preparing turn 1, step ${step}:`))
    }
    return stream(options)
  }

  // Drive just the three steps of the turn. An always-refreshing clock also proposes a row
  // at the loop's next-step check after a completed answer.
  session.append('turn/start', { turn: TURN })
  const user = createUserMessage({
    content: [{ type: 'text', text: 'run twice' }], source: { kind: 'user' },
  })
  for (const step of [1, 2, 3]) {
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])
    const position = { turn: TURN, step }
    const messages = step === 1 ? [user] : []
    const decision = await dispatch.waterfall('agent/pre-step', {
      ...position, messages, signal, modelSelection: MODEL,
    }, async () => ({ kind: 'enter', messages }))
    assert.equal(decision.kind, 'enter')
    assert.equal(decision.messages.length, step === 1 ? 2 : 1)
    session.append('step/start', position)
    for (const message of decision.messages) {
      session.append('user/message', message, { surfaceOp: 'append' })
    }
    if (step === 1) {
      session.append('request/header', { header: { config: MODEL }, reason: 'initial' })
    }
    const chunks = await drainStep(adapter, {
      ...MODEL, sessionId: session.id, messages: session.deriveMessages(), signal,
    }, trace, step, controller)
    const finish = chunks.at(-1)
    const blocks = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
    assert.equal(finish.reason.kind, step === 3 ? 'stop' : 'tool-calls', JSON.stringify(finish))
    session.append('assistant/message', {
      ...position, stream: [], message: createAssistantMessage({ source: MODEL, content: blocks }),
    }, { surfaceOp: 'append' })
    if (step !== 3) {
      const calls = blocks.filter(block => block.type === 'tool-call')
      assert.equal(calls.length, 1)
      const [call] = calls
      assert.equal(call.name, TOOL_NAME)
      const args = JSON.parse(call.arguments)
      assert.equal(args.id, `call-1-${step}`)
      mirrorIds.push(call.id)
      const callSeq = session.append('tool/call', {
        ...position, callId: call.id, name: call.name, arguments: call.arguments,
      }).seq
      const result = await mirror.execute(args, { agent, callId: call.id, signal: AbortSignal.timeout(10_000) })
      assert.equal(result.text, `hello ${step}`)
      session.append('tool/result', {
        ...position,
        message: createToolResultMessage({
          callId: call.id, content: mirror.output.render(args, result), isError: false,
        }),
      }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
    }
    session.append('step/end', position)
  }
  // The last adapter finish ('stop') maps to the one completed end in this fixture.
  session.append('turn/end', { turn: TURN, reason: { kind: 'completed' } })

  const observed = session.snapshotEvents().flatMap(event => {
    const { type, data } = event
    if (type === 'turn/start') return [`turn ${data.turn} start`]
    if (type === 'tool/result') return [`turn ${data.turn} step ${data.step} result ${data.message.toolCallId}`]
    if (type === 'user/message' && data.source.kind === 'time-context') {
      return [textIn(data.content).split(':')[0]]
    }
    if (type === 'assistant/message') {
      const text = textIn(data.message.content)
      assert.doesNotMatch(text, /was interrupted before it finished/)
      return text.startsWith('It printed') ? [`turn ${data.turn} step ${data.step}: ${text}`] : []
    }
    if (type === 'turn/end') return [`turn ${data.turn} ${data.reason.kind}`]
    return []
  })
  assert.deepEqual(observed, [
    'turn 1 start',
    'Time sampled while preparing turn 1, step 1',
    `turn 1 step 1 result ${mirrorIds[0]}`,
    'Time sampled while preparing turn 1, step 2',
    'turn 1 step 2: It printed hello 1.',
    `turn 1 step 2 result ${mirrorIds[1]}`,
    'Time sampled while preparing turn 1, step 3',
    'turn 1 step 3: It printed hello 2.',
    'turn 1 completed',
  ])
  assert.equal(requests, 3)
  assert.deepEqual(checkTrace(trace, 3).map(({ event }) => event), ['prompt'])
})
