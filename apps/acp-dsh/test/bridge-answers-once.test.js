import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentRun } from '../src/host/acp.js'
import { CANCELLED, picked, probe, soon } from './support/state-probe.js'

test('a bridged question offering only allow_always is cancelled, never its reject', async t => {
  const p = probe(t, { dshTools: true })
  const end = p.begin()
  await p.see('b1', { name: 'mcp__dsh__bash' })
  const tool = p.run.tools.get('b1')
  assert.equal(tool.bridge, true)
  const options = [
    { optionId: 'b-always', kind: 'allow_always' },
    { optionId: 'b-reject', kind: 'reject_once' },
  ]
  assert.deepEqual(await soon(p.ask('b1', { options })), CANCELLED)
  assert.equal(tool.permission, undefined)
  await end()
})

test('a bridged question offering allow_once gets it wherever it sits', async t => {
  const p = probe(t, { dshTools: true })
  const end = p.begin()
  await p.see('b1', { name: 'mcp__dsh__bash' })
  assert.equal(p.run.tools.get('b1').bridge, true)
  const options = [
    { optionId: 'b-always', kind: 'allow_always' },
    { optionId: 'b-once', kind: 'allow_once' },
    { optionId: 'b-reject', kind: 'reject_once' },
  ]
  assert.deepEqual(await soon(p.ask('b1', { options })), picked('b-once'))
  await end()
})

test('a bridged question with no allow option is cancelled', async t => {
  const p = probe(t, { dshTools: true })
  const end = p.begin()
  await p.see('b1', { name: 'mcp__dsh__bash' })
  assert.equal(p.run.tools.get('b1').bridge, true)
  assert.deepEqual(await soon(p.ask('b1', { options: [] })), CANCELLED)
  const options = [{ optionId: 'b-reject', kind: 'reject_once' }]
  assert.deepEqual(await soon(p.ask('b1', { options })), CANCELLED)
  await end()
})

test('Skills row 2: disagreeing call identities go through ordinary approval', async t => {
  const p = probe(t, { skillBridge: true, provider: 'acp-claude' })
  const end = p.begin()
  const rawInput = { server: 'dsh', tool: 'load_skill' }
  await p.see('other', { name: 'Bash', rawInput })
  const other = p.run.tools.get('other')
  const approval = p.ask('other', { toolCall: { toolCallId: 'other', rawInput } })
  assert.notEqual(other.skillBridge, true, 'raw arguments cannot override the operation name')
  assert.ok(other.permission, 'the ordinary tool still has a pending approval')
  other.permission.answer(picked('no'))
  assert.deepEqual(await soon(approval), picked('no'))

  await p.see('skill', { name: 'mcp__dsh__load_skill' })
  assert.deepEqual(await soon(p.ask('skill')), picked('yes'))
  const conflict = p.ask('skill', { toolCall: { toolCallId: 'skill', name: 'Bash' } })
  const skill = p.run.tools.get('skill')
  assert.notEqual(skill.skillBridge, true, 'a conflicting later update revokes the exception')
  assert.ok(skill.permission)
  skill.permission.answer(picked('no'))
  assert.deepEqual(await soon(conflict), picked('no'))
  await end()

  const off = probe(t, { skillBridge: true, provider: 'acp-omp', refuseTools: true })
  const endOff = off.begin()
  assert.deepEqual(await soon(off.ask('raw-only', { toolCall: { toolCallId: 'raw-only', rawInput } })), picked('no'))
  assert.deepEqual(await soon(off.ask('other', { toolCall: { toolCallId: 'other', name: 'Bash', rawInput } })), picked('no'))
  assert.deepEqual(await soon(off.ask('skill', { toolCall: { toolCallId: 'skill', name: 'mcp__dsh__load_skill' } })), picked('yes'))
  await endOff()
})

function forkWithStoredQuestion(server, options) {
  const refused = []
  const run = new AgentRun({ dshTools: false, refresh: 'fork', onRefusedMcp: tool => refused.push(tool.id) })
  const tool = run.seeTool({ toolCallId: 'live-fork', _meta: { is_mcp_tool_call: true }, rawInput: { server } })
  const pending = run.onPermission({ toolCall: { toolCallId: tool.id }, options })
  assert.ok(tool.permission)
  run.spec.dshTools = true
  assert.notEqual(tool.unanswerable, true)
  return { run, tool, pending, refused }
}

test('fork bridge: stored allow_always cancels while incoming allow_once selects its own id', async () => {
  const { run, tool, pending, refused } = forkWithStoredQuestion('dsh', [
    { optionId: 'stored-always', kind: 'allow_always' },
  ])
  const returned = run.answerSkippedMcp(tool, [{ optionId: 'incoming-once', kind: 'allow_once' }])
  assert.deepEqual(await soon(pending), CANCELLED)
  assert.deepEqual(returned, picked('incoming-once'))
  assert.equal(tool.permission, undefined)
  assert.deepEqual(refused, [])
})

test('fork bridge: stored allow_once selects its own id while incoming allow_always cancels', async () => {
  const { run, tool, pending, refused } = forkWithStoredQuestion('dsh', [
    { optionId: 'stored-once', kind: 'allow_once' },
  ])
  const returned = run.answerSkippedMcp(tool, [{ optionId: 'incoming-always', kind: 'allow_always' }])
  assert.deepEqual(await soon(pending), picked('stored-once'))
  assert.deepEqual(returned, CANCELLED)
  assert.deepEqual(refused, [])
})

test('fork bridge: the helper form settles a stored always-only question as cancelled', async () => {
  const { run, tool, pending, refused } = forkWithStoredQuestion('dsh', [
    { optionId: 'stored-always', kind: 'allow_always' },
    { optionId: 'stored-reject', kind: 'reject_once' },
  ])
  const returned = run.answerSkippedMcp(tool)
  assert.deepEqual(await soon(pending), CANCELLED)
  assert.deepEqual(returned, CANCELLED)
  assert.equal(tool.permission, undefined)
  assert.deepEqual(refused, [])
})

test('fork non-bridge server keeps its reject and its log', async () => {
  const { run, tool, pending, refused } = forkWithStoredQuestion('personal', [
    { optionId: 'p-always', kind: 'allow_always' },
    { optionId: 'p-reject', kind: 'reject_once' },
  ])
  run.answerSkippedMcp(tool)
  assert.deepEqual(await soon(pending), picked('p-reject'))
  assert.deepEqual(refused, ['live-fork'])
})
