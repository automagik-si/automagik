import assert from 'node:assert/strict'
import { test } from 'node:test'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { AcpAdapter } from '../src/host/adapter.js'
import { OPTIONS, picked, probe, soon } from './support/state-probe.js'

// Only the ACP peer is controlled here: the adapter streams and its registered mirror runs.
function host(t) {
  const p = probe(t)
  Object.defineProperty(p.run, 'alive', { get: () => true })
  const tools = new Map()
  const agent = {
    session: Session.create('bounded-adapter'),
    status: 'idle',
    ctx: { tools: { register: definition => {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    } } },
  }
  const ctx = {
    agents: { get: () => agent, list: () => [agent] },
    on: () => () => {},
    get: name => {
      if (name === 'approval') return { effectivePolicy: () => 'never', request: async () => 'allowed-once' }
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'danger-full-access' }) }
      return undefined
    },
  }
  const adapter = new AcpAdapter(ctx, new Map([['acp-probe', { name: 'Probe agent' }]]))
  t.after(() => adapter.dispose())
  const live = { provider: 'acp-probe', name: 'Probe agent', run: p.run, calls: new Set(), toolIds: new Map(), asks: false, open: false, dshAgent: agent }
  adapter.live.set(agent.session.id, live)
  const messages = []
  const step = async () => {
    const chunks = []
    for await (const chunk of adapter.stream(markAgentLoopRequest({ provider: live.provider, model: 'default', sessionId: agent.session.id, messages }))) chunks.push(chunk)
    const blocks = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
    messages.push({ role: 'assistant', source: { kind: 'model', provider: live.provider, model: 'default' }, content: blocks })
    return { chunks, blocks, finish: chunks.at(-1) }
  }
  const execute = async call => {
    const tool = tools.get(call.name)
    assert.ok(tool)
    const args = JSON.parse(call.arguments)
    const value = await soon(tool.execute(args, { agent, callId: call.id, signal: new AbortController().signal }))
    messages.push({ role: 'tool', toolCallId: call.id, source: { kind: 'tool', callId: call.id }, content: tool.output.render(args, value) })
    return value
  }
  return { ...p, adapter, live, messages, step, execute }
}

test('mirror ids survive steps and result observation, then reset at each new DSH turn', async t => {
  const h = host(t)
  let prompts = 0
  h.run.conn.prompt = async () => {
    const turn = ++prompts
    assert.equal(h.live.calls.size, 0, 'the previous turn is gone before the peer gets its prompt')
    assert.equal(h.live.toolIds.size, 0)
    for (let step = 0; step < 3; step++) {
      const id = `remote-${turn}-${step}`
      await h.see(id, { rawInput: { path: 'README.md' } })
      const answer = await h.ask(id)
      assert.deepEqual(answer, picked('yes'))
      h.run.changeTool(h.run.tools.get(id), { status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'read' } }] })
    }
    return { stopReason: 'end_turn' }
  }
  for (let turn = 1; turn <= 8; turn++) {
    h.messages.push({ role: 'user', content: [{ type: 'text', text: `turn ${turn}` }] })
    const calls = []
    for (let step = 0; step < 3; step++) {
      const result = await soon(h.step())
      assert.equal(result.finish.reason.kind, 'tool-calls')
      const call = result.blocks.find(block => block.type === 'tool-call')
      calls.push(call.id)
      assert.equal(JSON.parse(call.arguments).id, `remote-${turn}-${step}`)
      assert.deepEqual(h.live.calls, new Set(calls))
      assert.deepEqual([...h.live.toolIds.values()], calls.map((_, index) => `remote-${turn}-${index}`))
      assert.equal((await h.execute(call)).status, 'completed')
      assert.deepEqual(h.live.calls, new Set(calls), 'result observers still have every mirror id')
      // A bridge repair result may trail the mirror result in the next step's transcript.
      h.messages.push({ role: 'tool', toolCallId: `repair-${turn}-${step}`, content: [{ type: 'text', text: 'closed' }] })
    }
    assert.equal((await soon(h.step())).finish.reason.kind, 'stop')
    assert.equal(prompts, turn, 'continuation did not start another ACP prompt')
    assert.deepEqual(h.live.calls, new Set(calls), 'prompt end does not retire mirror ids')
    assert.deepEqual(h.run.turn, new Set([0, 1, 2].map(step => `remote-${turn}-${step}`)))
  }
})

test('a queued call whose entry was deleted is skipped before diagnostics and the next card runs', async t => {
  const h = host(t)
  const seen = []
  h.adapter.diagnostics = { own() {}, call: (_id, _live, tool) => { assert.ok(tool); seen.push(tool.id) } }
  h.run.conn.prompt = async () => {
    await h.see('deleted', { status: 'completed' })
    h.run.tools.delete('deleted')
    await h.see('kept', { status: 'completed', rawInput: { path: 'README.md' } })
    return { stopReason: 'end_turn' }
  }
  h.messages.push({ role: 'user', content: 'go' })
  const result = await soon(h.step())
  assert.equal(result.finish.reason.kind, 'tool-calls')
  const call = result.blocks.find(block => block.type === 'tool-call')
  assert.equal(JSON.parse(call.arguments).id, 'kept')
  assert.deepEqual(seen, ['kept'])
  assert.equal((await h.execute(call)).status, 'completed')
  assert.equal((await soon(h.step())).finish.reason.kind, 'stop')
  assert.equal(h.live.calls.size, 1)
})

test('a stop settles the old prompt before the next turn retires its mirror mappings', async t => {
  const h = host(t)
  let finish
  h.run.conn.prompt = () => new Promise(resolve => { finish = resolve })
  const prompting = h.run.prompt([{ type: 'text', text: 'go' }])
  await h.see('stopped')
  const question = h.run.onPermission({ toolCall: { toolCallId: 'stopped' }, options: OPTIONS })
  h.live.calls.add('old-mirror')
  h.live.toolIds.set('old-mirror', 'stopped')
  h.run.conn.cancel = async () => { finish({ stopReason: 'cancelled' }) }
  await h.run.cancel()
  assert.deepEqual(await soon(question), { outcome: { outcome: 'cancelled' } })
  await soon(prompting)
  h.run.conn.prompt = async () => ({ stopReason: 'end_turn' })
  h.messages.push({ role: 'user', content: 'next turn' })
  assert.equal((await soon(h.step())).finish.reason.kind, 'stop')
  assert.equal(h.live.calls.size, 0)
  assert.equal(h.live.toolIds.size, 0)
  assert.equal(h.run.tools.get('stopped').retired, true)
})
