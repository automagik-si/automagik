import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { CHILD_ASKS_CONTEXT, CHILD_ASKS_CONTEXT_NAME } from '../src/host/subagent-asks.js'

// Swap the live registration because the testkit only creates fresh Sessions.
test('renaming the subagent asks context adds one snapshot to the same Session', async t => {
  const root = new Context()
  t.after(() => root.fiber.dispose())
  await mountAgentLoopTestDependencies(root)
  const reply = { type: 'text', text: 'Still here' }
  class Adapter extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100000 } } }
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply.text }
      yield { type: 'block-end', index: 0, block: reply }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  root.llm.registerAdapter(['asks-upgrade-test'], new Adapter())
  const harness = await mountAgentLoopTestHarness(root)
  const register = name => root.systemPrompt.context({ name, order: 121, interpolate: false, text: CHILD_ASKS_CONTEXT })
  const legacyName = 'ds-bot:subagent-asks'
  const disposeLegacy = register(legacyName)
  const agent = await harness.create(SessionId('asks-upgrade'), { provider: 'asks-upgrade-test', model: 'test' })
  const events = []
  root.on('session/event', (session, event) => {
    if (session === agent.session) events.push(event)
  })
  const snapshots = (history = events) => history.filter(event => event.type === 'user/message' && event.data.source.kind === 'runtime-context')
    .map(event => event.data)
  const turn = async text => {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
    await agent.whenIdle()
  }

  await turn('Before the rename')
  assert.equal(snapshots().length, 1)
  const [legacy] = snapshots()
  assert.deepEqual(legacy.source.sections, [{ name: legacyName, text: CHILD_ASKS_CONTEXT }])

  disposeLegacy()
  register(CHILD_ASKS_CONTEXT_NAME)
  const beforeRenameTurn = events.length
  await turn('After the rename')
  assert.equal(snapshots().length, 2)
  const renamedTurn = events.slice(beforeRenameTurn)
  assert.deepEqual(snapshots(renamedTurn).map(message => message.source.sections), [
    [{ name: CHILD_ASKS_CONTEXT_NAME, text: CHILD_ASKS_CONTEXT }],
  ])
  assert.ok(agent.session.deriveMessages().some(message => message.id === legacy.id))
  assert.deepEqual(renamedTurn.find(event => event.type === 'assistant/message')?.data.message.content, [reply])
  assert.equal(renamedTurn.find(event => event.type === 'turn/end')?.data.reason.kind, 'completed')

  await turn('Same registration')
  assert.equal(snapshots().length, 2)
})
