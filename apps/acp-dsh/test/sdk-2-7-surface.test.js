import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agent, client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk/unstable'
import { AgentRun } from '../src/host/acp.js'
import { callArguments, mirrorTool } from '../src/host/tool.js'

const text = text => ({ type: 'text', text })
const message = value => ({ sessionUpdate: 'agent_message_chunk', content: text(value) })

// Like upload-content.test.js, use real SDK peers and serialization without a native process.
// Match acp.js's connection handlers; AgentRun handles updates, permissions and turn lifetime.
async function connected(t, prompt) {
  const errors = t.mock.method(console, 'error', () => {})
  const toAgent = new TransformStream()
  const toClient = new TransformStream()
  const run = new AgentRun({ name: 'Generic agent' })
  const received = { initialize: [], sessions: [], prompts: [], updates: [], permissions: [] }
  const peer = agent({ name: 'generic-peer' })
    .onRequest(methods.agent.initialize, ({ params }) => {
      received.initialize.push(params)
      return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }
    })
    .onRequest(methods.agent.session.new, ({ params }) => {
      received.sessions.push(params)
      return { sessionId: 'generic-session' }
    })
    .onRequest(methods.agent.session.prompt, async context => {
      received.prompts.push(context.params)
      await prompt(context)
      return { stopReason: 'end_turn' }
    })
    .connect(ndJsonStream(toClient.writable, toAgent.readable))
  const connection = client({ name: 'generic-client' })
    .onNotification(methods.client.session.update, ({ params }) => {
      received.updates.push(params.update)
      return run.onUpdate(params.update, params.sessionId)
    })
    .onRequest(methods.client.session.requestPermission, ({ params, signal }) => {
      received.permissions.push(params)
      return run.onPermission(params, signal)
    })
    .connect(ndJsonStream(toAgent.writable, toClient.readable))
  t.after(() => { connection.close(); peer.close(); run.letGo(true) })
  run.child = {} // alive, with no actual child process
  run.gone = new Promise(() => {})
  run.conn = { prompt: params => connection.agent.request(methods.agent.session.prompt, params) }
  run.init = await connection.agent.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION, clientCapabilities: {},
  })
  const session = await connection.agent.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] })
  run.sessionId = session.sessionId
  return { run, received, errors }
}

async function drain(run) {
  const events = []
  for (;;) {
    const event = await run.next()
    events.push(event)
    if (event.type === 'end' || event.type === 'error') return events
  }
}

const notify = (context, update) => context.client.notify(methods.client.session.update, {
  sessionId: context.params.sessionId, update,
})
const end = { type: 'end', stopReason: 'end_turn' }

test('empty clientCapabilities validates and reaches a session and completed turn', { timeout: 3000 }, async t => {
  const h = await connected(t, context => notify(context, message('Session ready.')))
  // The request above sends {}; the SDK fills omitted capabilities with disabled defaults.
  assert.deepEqual(h.received.initialize, [{
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      auth: { terminal: false }, fs: { readTextFile: false, writeTextFile: false }, terminal: false,
    },
  }])
  assert.equal(h.run.init.protocolVersion, PROTOCOL_VERSION)
  assert.deepEqual(h.received.sessions, [{ cwd: process.cwd(), mcpServers: [] }])
  assert.equal(h.run.sessionId, 'generic-session')
  h.run.prompt([text('Begin')])
  assert.deepEqual(await drain(h.run), [{ type: 'text', text: 'Session ready.' }, end])
  assert.deepEqual(h.received.prompts, [{ sessionId: 'generic-session', prompt: [text('Begin')] }])
  assert.equal(h.run.busy, false)
  assert.equal(h.errors.mock.callCount(), 0)
})

test('session tool content preserves its text sibling in the rendered tool card and ends the turn', { timeout: 3000 }, async t => {
  const content = [
    { type: 'session', sessionId: 'referenced-session' },
    { type: 'content', content: text('Kept tool output.') },
  ]
  const h = await connected(t, async context => {
    await notify(context, {
      sessionUpdate: 'tool_call', toolCallId: 'generic-call', title: 'Inspect result',
      kind: 'other', status: 'completed', content,
    })
    await notify(context, message('Tool finished.'))
  })
  h.run.prompt([text('Inspect')])
  assert.deepEqual(await drain(h.run), [
    { type: 'tool', id: 'generic-call' }, { type: 'text', text: 'Tool finished.' }, end,
  ])
  const tool = h.run.tools.get('generic-call')
  assert.deepEqual(tool.content, content, 'both items survive SDK validation')
  const definition = mirrorTool({ runOf: () => ({ run: h.run, name: 'Generic agent' }) })
  const args = callArguments(tool)
  const value = await definition.execute(args, { callId: 'mirror-call', agent: { session: { id: 'generic-session' } } })
  assert.equal(value.text, 'Kept tool output.')
  assert.equal(value.status, 'completed')
  assert.deepEqual(definition.output.render(args, value), [text('Kept tool output.')])
  assert.equal(h.run.busy, false)
  assert.equal(h.errors.mock.callCount(), 0)
})

test('permission with session tool content is surfaced and its answer completes the turn', { timeout: 3000 }, async t => {
  const content = [{ type: 'session', sessionId: 'referenced-session' }]
  const options = [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }]
  let answer
  const h = await connected(t, async context => {
    answer = await context.client.request(methods.client.session.requestPermission, {
      sessionId: context.params.sessionId,
      toolCall: { toolCallId: 'permission-call', title: 'Inspect session?', content }, options,
    })
    await notify(context, message('Permission answered.'))
  })
  h.run.prompt([text('Inspect')])
  assert.deepEqual(await h.run.next(), { type: 'tool', id: 'permission-call' })
  const tool = h.run.tools.get('permission-call')
  assert.equal(h.received.permissions.length, 1)
  assert.deepEqual(tool.content, content)
  assert.deepEqual(tool.permission.call.content, content)
  assert.deepEqual(tool.permission.options, options)
  assert.equal(tool.permission.title, 'Inspect session?')
  assert.equal(h.run.busy, true, 'the turn waits for the permission answer')
  tool.permission.answer({ outcome: { outcome: 'selected', optionId: 'allow' } })
  assert.deepEqual(await drain(h.run), [{ type: 'text', text: 'Permission answered.' }, end])
  assert.deepEqual(answer, { outcome: { outcome: 'selected', optionId: 'allow' } })
  assert.equal(tool.permission, undefined)
  assert.equal(h.run.busy, false)
  assert.equal(h.errors.mock.callCount(), 0)
})

test('prompt suggestions validate but emit no event or error and later chunks arrive', { timeout: 3000 }, async t => {
  const update = { sessionUpdate: 'prompt_suggestions_update', suggestions: [{ prompt: [text('Suggested prompt')] }] }
  const h = await connected(t, async context => {
    await notify(context, message('Before.'))
    await notify(context, update)
    await notify(context, message('After.'))
  })
  h.run.prompt([text('Continue')])
  assert.deepEqual(await drain(h.run), [
    { type: 'text', text: 'Before.' }, { type: 'text', text: 'After.' }, end,
  ])
  assert.deepEqual(h.received.updates, [message('Before.'), update, message('After.')])
  assert.equal(h.run.tools.size, 0)
  assert.equal(h.errors.mock.callCount(), 0)
})

test('rejected legacy file plan update still delivers later chunks and a normal turn end', { timeout: 3000 }, async t => {
  const h = await connected(t, async context => {
    await notify(context, message('Before.'))
    // 2.7.0 accepts items/markdown plans, not the former file variant.
    await notify(context, { sessionUpdate: 'plan_update', plan: { type: 'file', planId: 'generic-plan', uri: 'file:///tmp/plan.md' } })
    await notify(context, message('After.'))
  })
  h.run.prompt([text('Continue')])
  assert.deepEqual(await drain(h.run), [
    { type: 'text', text: 'Before.' }, { type: 'text', text: 'After.' }, end,
  ])
  assert.deepEqual(h.received.updates, [message('Before.'), message('After.')], 'the invalid plan never reaches AgentRun')
  assert.equal(h.run.tools.size, 0)
  assert.equal(h.run.busy, false)
  assert.equal(h.errors.mock.callCount(), 1, 'only the invalid notification is rejected')
  const [label, metadata] = h.errors.mock.calls[0].arguments
  assert.equal(label, 'Error handling notification')
  assert.equal(metadata.method, methods.client.session.update)
  assert.match(metadata.message, /invalid|validation|input/i)
})
