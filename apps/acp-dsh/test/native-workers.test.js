// Claude Code's native subagents as workers (issue 1564): the adapter stamps each call a
// subagent makes with `_meta.claudeCode.parentToolUseId`, the subagent's own Agent/Task call
// id. Ingest keeps that link on the call, the mirror card's arguments carry it, and the run's
// workers() groups the steps under their worker, from today's wire alone.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parentToolOf, workersOf, WORKER_STEPS_MAX } from '../src/host/acp.js'
import { callArguments, mirrorTool } from '../src/host/tool.js'
import { probe } from './support/state-probe.js'

// The frames 0.108.0's renderer sends for one Agent call and its child calls (step-1 report §2).
const agentCall = (toolCallId, description, more = {}) => ({
  sessionUpdate: 'tool_call', toolCallId, name: 'Agent', title: description, kind: 'think', status: 'pending',
  content: [{ type: 'content', content: { type: 'text', text: `Prompt for ${description}` } }],
  rawInput: { description, prompt: `Prompt for ${description}`, subagent_type: 'general-purpose' },
  _meta: { claudeCode: { toolName: 'Agent' } },
  ...more,
})
const childCall = (toolCallId, parent, name, title, more = {}) => ({
  sessionUpdate: 'tool_call', toolCallId, name, title, kind: 'read', status: 'pending', rawInput: {},
  _meta: { claudeCode: { toolName: name, parentToolUseId: parent } },
  ...more,
})
const update = (toolCallId, fields) => ({ sessionUpdate: 'tool_call_update', toolCallId, ...fields })

test('parentToolOf reads only the adapter stamp, and nothing else', () => {
  assert.equal(parentToolOf({ _meta: { claudeCode: { parentToolUseId: 'toolu_1' } } }), 'toolu_1')
  for (const meta of [undefined, {}, { claudeCode: {} }, { claudeCode: { parentToolUseId: '' } }, { claudeCode: { parentToolUseId: 7 } }, { parentToolUseId: 'toolu_1' }]) {
    assert.equal(parentToolOf({ _meta: meta }), undefined)
  }
})

test('the parent link survives ingest, from the first frame or a later one, and reaches the card', async t => {
  const p = probe(t)
  const end = p.begin()
  await p.run.onUpdate(agentCall('toolu_agent', 'Review the adapter bundle'))
  await p.run.onUpdate(childCall('toolu_read', 'toolu_agent', 'Read', 'Read dist/index.js'))
  // A refinement that comes first without the stamp, then the result that carries it.
  await p.run.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 'toolu_grep', name: 'Grep', title: 'grep parentToolUseId', kind: 'search', status: 'pending', _meta: { claudeCode: { toolName: 'Grep' } } })
  await p.run.onUpdate(update('toolu_grep', { status: 'completed', _meta: { claudeCode: { toolName: 'Grep', parentToolUseId: 'toolu_agent' } } }))
  // An update with no stamp does not take the link away.
  await p.run.onUpdate(update('toolu_read', { status: 'in_progress', _meta: { claudeCode: { toolName: 'Read' } } }))
  // The main agent's own call has no parent.
  await p.run.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 'toolu_main', name: 'Bash', title: 'ls', kind: 'execute', status: 'pending', _meta: { claudeCode: { toolName: 'Bash' } } })

  const tools = p.run.tools
  assert.equal(tools.get('toolu_read').parent, 'toolu_agent')
  assert.equal(tools.get('toolu_grep').parent, 'toolu_agent')
  assert.equal(tools.get('toolu_main').parent, undefined)
  assert.equal(tools.get('toolu_agent').parent, undefined)
  assert.equal(callArguments(tools.get('toolu_read')).parent, 'toolu_agent')
  assert.equal('parent' in callArguments(tools.get('toolu_main')), false)
  // The mirror tool takes the field, so DSH keeps it on the card's row.
  const mirror = mirrorTool({ runOf: () => undefined, approval: () => undefined })
  assert.equal(mirror.parameters.properties.parent.type, 'string')
  assert.equal(mirror.parameters.required?.includes('parent') ?? false, false)
  await end()
})

test("workers() groups each subagent's steps under it, with its state and result line", async t => {
  const p = probe(t)
  const end = p.begin()
  await p.run.onUpdate(agentCall('toolu_a', 'Review the adapter bundle'))
  await p.run.onUpdate(agentCall('toolu_b', 'Audit memory writes'))
  await p.run.onUpdate(agentCall('toolu_c', 'Check the approval path'))
  await p.run.onUpdate(childCall('a1', 'toolu_a', 'Grep', 'find the adapter version', { status: 'completed' }))
  await p.run.onUpdate(childCall('b1', 'toolu_b', 'Read', 'read the memory doors', { status: 'completed' }))
  await p.run.onUpdate(childCall('a2', 'toolu_a', 'Read', 'read the session update path'))
  await p.run.onUpdate(childCall('c1', 'toolu_c', 'Bash', 'run the permission probe'))
  await p.run.onUpdate(update('c1', { status: 'failed' }))
  await p.run.onUpdate(update('toolu_a', { status: 'in_progress', _meta: { claudeCode: { toolName: 'Agent', toolResponse: { elapsedTimeSeconds: 4 } } } }))
  // Done: the stripped report is the line; the content's prompt is never shown as a result.
  await p.run.onUpdate(update('toolu_b', {
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: '\n2 files changed · 4 notes kept\nMore detail' } }],
  }))
  // Failed with only the raw text: the usage block and agentId line do not reach the line.
  await p.run.onUpdate(update('toolu_c', {
    status: 'failed', content: [],
    rawOutput: '<usage>total_tokens: 9</usage>\nagentId: abc123\nBash exited 1 · approval path missing',
  }))
  await p.run.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 'main', name: 'Bash', title: 'ls', kind: 'execute', status: 'completed', _meta: { claudeCode: { toolName: 'Bash' } } })

  const workers = p.run.workers()
  assert.deepEqual(workers.map(w => [w.id, w.title, w.state, w.result]), [
    ['toolu_a', 'Review the adapter bundle', 'running', undefined],
    ['toolu_b', 'Audit memory writes', 'done', '2 files changed · 4 notes kept'],
    ['toolu_c', 'Check the approval path', 'failed', 'Bash exited 1 · approval path missing'],
  ])
  assert.deepEqual(workers[0].steps, [
    { id: 'a1', title: 'find the adapter version', tool: 'Grep', state: 'done' },
    { id: 'a2', title: 'read the session update path', tool: 'Read', state: 'running' },
  ])
  assert.deepEqual(workers[2].steps.map(step => step.state), ['failed'])
  assert.equal(typeof workers[0].at, 'number')
  // The main agent's own call is nobody's step.
  assert.equal(workers.flatMap(w => w.steps).some(step => step.id === 'main'), false)
  await end()
  // The prompt ended: its workers stay, now ended, until the next prompt starts.
  assert.deepEqual(p.run.workers().map(w => w.state), ['done', 'done', 'failed'])
  const next = p.begin()
  assert.deepEqual(p.run.workers(), [])
  await next()
})

test('a worker keeps its newest steps and counts the rest', () => {
  const tools = new Map([['w', { id: 'w', title: 'Big job', structuredName: 'Task', status: 'in_progress' }]])
  const ids = ['w']
  for (let i = 0; i < WORKER_STEPS_MAX + 5; i++) {
    tools.set(`s${i}`, { id: `s${i}`, title: `step ${i}`, structuredName: 'Read', status: 'completed', parent: 'w' })
    ids.push(`s${i}`)
  }
  const [worker] = workersOf(tools, ids)
  assert.equal(worker.steps.length, WORKER_STEPS_MAX)
  assert.equal(worker.more, 5)
  assert.equal(worker.steps.at(-1).title, `step ${WORKER_STEPS_MAX + 4}`)
})
