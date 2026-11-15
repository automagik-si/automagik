import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { AcpAdapter } from '../src/host/adapter.js'
import { Backchannel } from '../src/host/backchannel.js'

const FAKE = join(import.meta.dirname, '..', 'dev', 'fake-agent.mjs')

test('the adapter bridge reports a running prompt, including after re-mint', { timeout: 10_000 }, async t => {
  const session = Session.create('adapter-step-wait')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const agent = { session, ctx: { tools: { register: () => () => {} } } }
  const definitions = []
  const ctx = {
    agents: { get: () => agent, turnBoundaryOf: () => ({ lastTurn: 1 }) },
    get: name => {
      if (name === 'tools') return { definitions: () => definitions, executable: name => definitions.find(tool => tool.name === name) }
      if (name === 'approval') return { effectivePolicy: () => 'never' }
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'danger-full-access' }) }
      if (name === 'agentPresets') return { presetForSession: () => 'standard' }
    },
    logger: { warn() {}, info() {} },
  }
  const spec = {
    name: 'Step wait probe',
    refresh: 'fork',
    catalog: { models: async () => [{ id: 'default', name: 'Probe' }], model: async () => undefined, ownEffort: () => undefined, dispose() {} },
    installed: () => true,
    spawn: () => ({ command: process.execPath, args: [FAKE] }),
  }
  const backchannel = new Backchannel({ ctx })
  const adapter = new AcpAdapter(ctx, new Map([['acp-fake', spec]]), { dshTools: () => true, backchannel })
  t.after(() => { adapter.dispose(); backchannel.dispose() })
  let previous
  for (let index = 0; index < 2; index += 1) {
    if (index === 1) definitions.push({ name: 'extra', description: 'Extra', parameters: { type: 'object' } })
    let live
    let observed = false
    let finish
    for await (const chunk of adapter.stream(markAgentLoopRequest({
      provider: 'acp-fake', model: 'default', sessionId: session.id,
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hang' }] }],
    }))) {
      if (chunk.type === 'finish') finish = chunk
      live = adapter.live.get(session.id)
      if (observed || live?.run.busy !== true) continue
      observed = true
      assert.equal(live.open, true)
      assert.equal(live.bridge.promptRunning(), true)
      if (previous !== undefined) {
        assert.notEqual(live.bridge, previous)
        assert.equal(previous.closed, true)
      }
      await live.run.cancel()
    }
    assert.equal(observed, true, 'a live prompt was observed')
    assert.equal(finish.reason.kind, 'aborted')
    assert.equal(live.open, false)
    assert.equal(live.run.busy, false)
    assert.equal(live.bridge.promptRunning(), false)
    previous = live.bridge
  }
})
