// #1293: a bridge call waiting between steps advertises before the next request is derived.
// Its rows must not turn the mirror result into a new prompt. All ids and text are synthetic.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createAssistantMessage, createToolResultMessage, markAgentLoopRequest,
} from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { apply } from '../index.js'
import { SYNTHETIC_KIND } from '../src/host/names.js'
import { TOOL_NAME } from '../src/host/tool.js'

const FAKE_AGENT = join(import.meta.dirname, '..', 'dev', 'fake-agent.mjs')
const TOOLS = [{
  name: 'job_output',
  description: 'Read output from a running job',
  parameters: { type: 'object', properties: { job: { type: 'string' } } },
}]
const textIn = chunks => chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
const advertised = message => message?.source?.synthetic === SYNTHETIC_KIND
const hidden = message => message?.role === 'developer' && message?.source?.kind === SYNTHETIC_KIND
const RESULT = { content: [{ type: 'text', text: 'job finished in step 2' }], isError: false }

async function until(check, what) {
  const deadline = Date.now() + 10_000
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(check(), what)
}

function host(t) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-dsh-1293-'))
  const trace = join(dir, 'trace.ndjson')
  const session = Session.create('bridge-step-start', undefined, {
    version: 4, id: 'bridge-step-start', createdAt: 0, isSeeded: false, cwd: dir,
  })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', {
    header: { config: { provider: 'acp-fake', model: 'default' }, tools: TOOLS },
    reason: 'initial',
  })
  const registered = {}
  const disposers = []
  const toolsMap = new Map()
  const execution = Promise.withResolvers()
  let executing = false
  const agent = {
    session,
    model: { current: () => ({ provider: 'acp-fake', model: 'default' }) },
    options: { provider: 'acp-fake' },
    status: 'idle',
    ctx: { tools: { register: def => {
      toolsMap.set(def.name, def)
      return () => toolsMap.delete(def.name)
    } } },
  }
  const ctx = {
    llm: { registerAdapter: (providers, adapter) => {
      for (const id of providers) registered[id] = adapter
      return () => {}
    } },
    agents: { get: id => id === session.id ? agent : undefined, list: () => [agent] },
    get: name => {
      if (name === 'tools') return {
        definitions: () => TOOLS,
        executable: name => TOOLS.find(tool => tool.name === name),
        execute: async ({ calls }) => {
          executing = true
          await execution.promise
          return { results: [{ callId: calls[0].id, result: RESULT }] }
        },
      }
      if (name === 'approval') return {
        effectivePolicy: () => 'never', request: async () => 'allowed-once',
      }
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'danger-full-access' }) }
      if (name === 'agentPresets') return { presetForSession: () => 'standard' }
      return undefined
    },
    on: () => () => {},
    effect: fn => disposers.push(fn()),
    provide: () => {},
  }
  const before = process.env.FAKE_ACP_TRACE
  process.env.FAKE_ACP_TRACE = trace
  t.after(() => {
    execution.resolve()
    for (const dispose of disposers) dispose()
    if (before === undefined) delete process.env.FAKE_ACP_TRACE
    else process.env.FAKE_ACP_TRACE = before
    rmSync(dir, { recursive: true, force: true })
  })
  apply(ctx, { fakeAgent: FAKE_AGENT, claude: false, codex: false, dshTools: true })
  const adapter = registered['acp-fake']
  const events = () => existsSync(trace)
    ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []
  const step = async (messages = session.deriveMessages()) => {
    const chunks = []
    for await (const chunk of adapter.stream(markAgentLoopRequest({
      provider: 'acp-fake', model: 'default', sessionId: session.id, messages,
      signal: AbortSignal.timeout(15_000),
    }))) chunks.push(chunk)
    return chunks
  }
  const user = (id, text) => session.append('user/message', {
    id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }],
  }, { surfaceOp: 'append' })
  const start = async () => {
    // The second mirror keeps the prompt busy while step 2 drains the first one's answer.
    user('u1', 'run twice')
    const chunks = await step()
    assert.equal(chunks.at(-1).reason.kind, 'tool-calls', JSON.stringify(chunks.at(-1)))
    const blocks = chunks.filter(c => c.type === 'block-end').map(c => c.block)
    const call = blocks.find(block => block.type === 'tool-call')
    assert.ok(call, 'step 1 emits its mirror call')
    session.append('assistant/message', {
      turn: 1, step: 1, stream: [],
      message: createAssistantMessage({
        content: blocks,
        source: { kind: 'model', provider: 'acp-fake', model: 'default' },
      }),
    }, { surfaceOp: 'append' })
    const callSeq = session.append('tool/call', {
      turn: 1, step: 1, callId: call.id, name: call.name, arguments: call.arguments,
    }).seq
    const mirror = toolsMap.get(TOOL_NAME)
    const args = JSON.parse(call.arguments)
    const value = await mirror.execute(args, {
      agent, callId: call.id, signal: new AbortController().signal,
    })
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: call.id, content: mirror.output.render(args, value), isError: false,
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
    session.append('step/end', { turn: 1, step: 1 })
    const live = adapter.live.get(session.id)
    assert.ok(live?.bridge, 'the session has its bridge')
    assert.equal(live.run.busy, true, 'the second mirror keeps the prompt running')
    const bridge = adapter.backchannel.call(live.bridge, {
      name: 'job_output', arguments: { job: 'j1' }, callId: 'bridge_step_2',
    })
    // Let the call reach waitForStep while the Session has no open step.
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(live.bridge.controllers.size, 1, 'the bridge call waits between steps')
    assert.equal(executing, false)
    assert.equal(session.deriveMessages().at(-1).toolCallId, call.id)
    session.append('step/start', { turn: 1, step: 2 })
    await until(() => executing, 'the bridge advertises and starts in step 2')
    const messages = session.deriveMessages()
    assert.ok(advertised(messages.at(-1)), 'the request ends with the bridge advertisement')
    assert.equal(messages.at(-2).toolCallId, call.id)
    return { live, bridge, messages, mirrorId: call.id }
  }
  return { adapter, session, step, user, start, events, execution }
}

function continued(h, live, chunks) {
  assert.match(textIn(chunks), /It printed hello 1\./)
  assert.doesNotMatch(textIn(chunks), /was interrupted before it finished/)
  assert.equal(h.adapter.live.get(h.session.id), live, 'step 2 keeps the live prompt')
  assert.equal(h.events().filter(event => event.event === 'prompt').length, 1)
  assert.equal(h.events().filter(event => event.event === 'cancel').length, 0)
}

test('#1293: a bridge advertisement at step start continues the mirror prompt', async t => {
  const h = host(t)
  const { live, bridge, messages } = await h.start()
  const chunks = await h.step(messages)
  h.execution.resolve()
  assert.deepEqual(await bridge, RESULT)
  continued(h, live, chunks)
})

test('#1293: a bridge result and hide row at step start continue the mirror prompt', async t => {
  const h = host(t)
  const { live, bridge, mirrorId } = await h.start()
  h.execution.resolve()
  assert.deepEqual(await bridge, RESULT)
  const rows = h.session.snapshotEvents().filter(event =>
    ['assistant/message', 'tool/result', 'developer/message'].includes(event.type))
  assert.equal(rows.at(-4).data.message.toolCallId, mirrorId)
  assert.ok(advertised(rows.at(-3).data.message))
  assert.equal(rows.at(-2).data.message.toolCallId, 'bridge_step_2')
  assert.ok(hidden(rows.at(-1).data.message))
  // The hide row replaces the advertisement. Session omits its empty content when deriving.
  const messages = h.session.deriveMessages()
  assert.equal(messages.at(-2).toolCallId, mirrorId)
  assert.equal(messages.at(-1).toolCallId, 'bridge_step_2')
  assert.equal(messages.some(message => advertised(message) || hidden(message)), false)
  continued(h, live, await h.step(messages))
})

test('#1293: a real user message after bridge rows still starts a new prompt', async t => {
  const h = host(t)
  const { bridge } = await h.start()
  h.execution.resolve()
  assert.deepEqual(await bridge, RESULT)
  h.user('u2', 'plain new turn')
  const messages = h.session.deriveMessages()
  assert.equal(messages.at(-1).role, 'user')
  const chunks = await h.step(messages)
  await until(() => h.events().some(event => event.event === 'cancel'), 'session/cancel is traced')
  assert.equal(h.events().filter(event => event.event === 'prompt').length, 2)
  assert.doesNotMatch(textIn(chunks), /was interrupted before it finished/)
})

test('#1293: a stale mirror result followed by an advertisement sends no new prompt', async t => {
  const h = host(t)
  const { bridge, messages } = await h.start()
  h.execution.resolve()
  assert.deepEqual(await bridge, RESULT)
  h.adapter.endSession(h.session.id)
  assert.equal(h.adapter.live.has(h.session.id), false)
  const prompts = h.events().filter(event => event.event === 'prompt').length
  const chunks = await h.step(messages)
  assert.match(textIn(chunks), /was interrupted before it finished/)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(h.adapter.live.has(h.session.id), false, 'the stale step starts no agent')
  assert.equal(h.events().filter(event => event.event === 'prompt').length, prompts)
})
