import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { AgentRun } from '../src/host/acp.js'
import { AcpAdapter } from '../src/host/adapter.js'
import { Backchannel } from '../src/host/backchannel.js'
import { TOOL_NAME } from '../src/host/tool.js'

const FAKE = join(import.meta.dirname, '..', 'dev', 'fake-agent.mjs')

function dshHost(t, { toolsOn = true, refresh = 'fork' } = {}) {
  const session = Session.create('mcp-permission-probe')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const asked = []
  const agent = { session, ctx: { tools: { register: () => () => {} } } }
  const ctx = {
    agents: { get: () => agent, turnBoundaryOf: () => ({ lastTurn: 1 }) },
    get: name => {
      if (name === 'tools') return { definitions: () => [], executable: () => undefined }
      if (name === 'approval') return {
        effectivePolicy: () => 'ask',
        request: async request => { asked.push(request); return 'allowed-once' },
      }
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'workspace-write' }) }
      if (name === 'agentPresets') return { presetForSession: () => 'standard' }
    },
    logger: { warn() {}, info() {} },
  }
  const spec = {
    name: 'MCP probe',
    catalog: { models: async () => [{ id: 'default', name: 'Probe' }], model: async () => undefined, ownEffort: () => undefined, dispose() {} },
    installed: () => true,
    spawn: () => ({ command: process.execPath, args: [FAKE] }),
    refresh,
  }
  const backchannel = new Backchannel({ ctx })
  const adapter = new AcpAdapter(ctx, new Map([['acp-fake', spec]]), { dshTools: () => toolsOn, backchannel })
  t.after(() => { adapter.dispose(); backchannel.dispose() })
  return { session, agent, asked, adapter }
}

async function step(h, messages) {
  const chunks = []
  for await (const chunk of h.adapter.stream(markAgentLoopRequest({ provider: 'acp-fake', model: 'default', sessionId: h.session.id, messages }))) chunks.push(chunk)
  return chunks
}

const question = text => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }]
const textIn = chunks => chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')

for (const [trigger, outcome, server] of [
  ['bridge', 'yes', 'dsh'],
  ['other', 'no', 'personal'],
  ['standalone', 'yes', 'dsh'],
  ['unknown', 'no', undefined],
]) {
  test(`fork MCP permission: ${trigger}`, { timeout: 10_000 }, async t => {
    const h = dshHost(t)
    const chunks = await step(h, question(`mcp-ask-${trigger}`))
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.match(textIn(chunks), new RegExp(`MCP permission: ${outcome}\\.`))
    assert.equal(chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call'), false)
    assert.deepEqual(h.asked, [])
    assert.equal(h.session.snapshotEvents().some(event => event.type === 'tool/call'), false)
    const run = h.adapter.live.get(h.session.id).run
    assert.equal(run.spec.refresh, 'fork')
    const tool = run.tools.get('mcp-ask-1')
    assert.equal(tool.mcp, true)
    assert.equal(tool.mcpServer, server)
    assert.equal(tool.bridge, undefined)
    assert.equal(tool.permission, undefined)
    assert.equal(run.busy, false)
  })
}

for (const [label, options] of [
  ['bridge off', { toolsOn: false }],
  ['non-fork agent', { refresh: 'live' }],
]) {
  test(`${label} keeps the MCP mirror and its DSH approval`, { timeout: 10_000 }, async t => {
    const h = dshHost(t, options)
    const messages = question('mcp-ask-bridge')
    const first = await step(h, messages)
    assert.equal(first.at(-1).reason.kind, 'tool-calls')
    const blocks = first.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
    const call = blocks.find(block => block.type === 'tool-call')
    assert.equal(call.name, TOOL_NAME)
    messages.push({ role: 'assistant', source: { kind: 'model', provider: 'acp-fake', model: 'default' }, content: blocks })
    const args = JSON.parse(call.arguments)
    const tool = h.adapter.tool
    const value = await tool.execute(args, { agent: h.agent, callId: call.id, signal: new AbortController().signal })
    assert.equal(h.asked.length, 1)
    messages.push({ role: 'tool', toolCallId: call.id, source: { kind: 'tool', callId: call.id }, content: tool.output.render(args, value) })
    const second = await step(h, messages)
    assert.equal(second.at(-1).reason.kind, 'stop')
    assert.match(textIn(second), /MCP permission: yes\./)
  })
}

for (const server of ['dsh', 'personal', undefined]) {
  test(`a skipped MCP call answers a permission already stored: ${server}`, async () => {
    const run = new AgentRun({ dshTools: false, refresh: 'fork' })
    const tool = run.seeTool({ toolCallId: 'queued', _meta: { is_mcp_tool_call: true }, rawInput: { server } })
    const pending = run.onPermission({
      toolCall: { toolCallId: tool.id },
      options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }],
    })
    assert.ok(tool.permission)
    run.spec.dshTools = true
    run.answerSkippedMcp(tool)
    assert.deepEqual(await pending, { outcome: { outcome: 'selected', optionId: server === 'dsh' ? 'yes' : 'no' } })
    assert.equal(tool.permission, undefined)
    assert.equal(tool.bridge, undefined)
  })
}

test('fork bridge MCP permission falls back to allow_always', async () => {
  const run = new AgentRun({ dshTools: true, refresh: 'fork' })
  const answer = await run.onPermission({
    _meta: { is_mcp_tool_approval: true },
    toolCall: { toolCallId: 'standalone', rawInput: { serverName: 'dsh' } },
    options: [{ optionId: 'always', kind: 'allow_always' }],
  })
  assert.deepEqual(answer, { outcome: { outcome: 'selected', optionId: 'always' } })
  assert.equal(run.tools.get('standalone').bridge, undefined)
})
