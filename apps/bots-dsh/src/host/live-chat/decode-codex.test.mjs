// node --test chat/decode-codex.test.mjs: Codex rollout lines decode to messages. Synthetic
// fixtures. Orca has no direct test of this decoder, so these cases are ours, written against
// its behaviour (src/main/native-chat/transcript-line-decoders-codex.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { decodeCodexTranscriptLine, isCodexVisibleHistoryRecord } from './decode-codex.js'

const at = (iso) => Date.parse(iso)
const lines = readFileSync(new URL('./fixtures/codex.jsonl', import.meta.url), 'utf8').split('\n').filter((l) => l !== '')
const msg = (id, role, blocks, iso) => ({ id, role, blocks, timestamp: at(iso), source: 'transcript' })

test('a Codex rollout fixture decodes to its messages', () => {
  const got = lines.flatMap((l, i) => decodeCodexTranscriptLine(l, `codex.jsonl:${i + 1}`) ?? [])
  assert.deepEqual(got, [
    // Visible prose comes from event_msg; response_item input_text/output_text carry no text block.
    msg('codex.jsonl:4', 'user', [{ type: 'text', text: 'Run the tests' }], '2026-11-03T10:00:00.250Z'),
    msg('codex.jsonl:6', 'reasoning', [{ type: 'text', text: 'Plan: run the test command.' }], '2026-11-03T10:00:01.000Z'),
    msg('codex.jsonl:7', 'assistant', [{ type: 'tool-call', name: 'shell', input: '{"command":["bun","test"]}', callId: 'call_01' }], '2026-11-03T10:00:02.000Z'),
    msg('codex.jsonl:8', 'tool', [{ type: 'tool-result', output: '{"output":"3 pass\\n0 fail","metadata":{"exit_code":0}}', callId: 'call_01' }], '2026-11-03T10:00:03.000Z'),
    msg('codex.jsonl:9', 'assistant', [{ type: 'tool-call', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch', callId: 'call_02' }], '2026-11-03T10:00:04.000Z'),
    msg('codex.jsonl:10', 'tool', [{ type: 'tool-result', output: 'patch failed', callId: 'call_02', isError: true }], '2026-11-03T10:00:05.000Z'),
    msg('codex.jsonl:12', 'assistant', [{ type: 'text', text: 'All 3 tests pass.' }], '2026-11-03T10:00:06.050Z'),
    msg('codex.jsonl:15', 'system', [{ type: 'text', text: 'Context compacted', presentation: 'compaction' }], '2026-11-03T10:00:07.000Z'),
    msg('codex.jsonl:16', 'system', [{ type: 'text', text: 'Conversation interrupted' }], '2026-11-03T10:00:08.000Z')
  ])
})

test('a line that does not parse, or is not a turn, is skipped', () => {
  for (const l of ['', 'not json', '[]', '{"type":"turn_context","payload":{"cwd":"/x"}}', '{"type":"event_msg","payload":{"type":"user_message","message":"  "}}']) {
    assert.equal(decodeCodexTranscriptLine(l, 'f'), null, l)
  }
})

test('a user response_item with a plain text part, minus skill context', () => {
  const line = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', id: 'm1', content: [{ type: 'text', text: '<SKILL> x' }, { type: 'text', text: 'real prompt' }] } })
  assert.deepEqual(decodeCodexTranscriptLine(line, 'f'), { id: 'm1', role: 'user', blocks: [{ type: 'text', text: 'real prompt' }], timestamp: null, source: 'transcript' })
})

test('older unwrapped records decode without a payload', () => {
  const user = JSON.stringify({ type: 'message', id: 'u1', role: 'user', content: [{ type: 'input_text', text: 'hello' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] })
  assert.deepEqual(decodeCodexTranscriptLine(user, 'f'), {
    id: 'u1', role: 'user', timestamp: null, source: 'transcript',
    blocks: [{ type: 'text', text: 'hello' }, { type: 'image-ref', url: 'data:image/png;base64,AAAA' }]
  })
  const call = JSON.stringify({ type: 'local_shell_call', call_id: 'c9', action: { type: 'exec', command: ['ls'] } })
  assert.deepEqual(decodeCodexTranscriptLine(call, 'file:3')?.blocks, [{ type: 'tool-call', name: 'tool', input: { type: 'exec', command: ['ls'] }, callId: 'c9' }])
})

test('completed turn items: user, agent, compaction, and reasoning only on history import', () => {
  const item = (it) => JSON.stringify({ type: 'event_msg', timestamp: '2026-11-03T10:00:00.000Z', payload: { type: 'item_completed', item: it } })
  assert.deepEqual(decodeCodexTranscriptLine(item({ id: 'i1', type: 'UserMessage', content: [{ type: 'text', text: 'hi' }, { type: 'local_image', path: '/tmp/a.png' }] }), 'f')?.blocks, [
    { type: 'text', text: 'hi' }, { type: 'image-ref', path: '/tmp/a.png' }
  ])
  assert.equal(decodeCodexTranscriptLine(item({ id: 'i2', type: 'AgentMessage', content: [{ type: 'Text', text: 'ok' }] }), 'f')?.role, 'assistant')
  assert.equal(decodeCodexTranscriptLine(item({ id: 'i3', type: 'ContextCompaction' }), 'f')?.blocks[0].presentation, 'compaction')
  const reasoning = item({ id: 'i4', type: 'Reasoning', summary_text: ['thought one', 'thought two'] })
  assert.equal(decodeCodexTranscriptLine(reasoning, 'f'), null)
  assert.deepEqual(decodeCodexTranscriptLine(reasoning, 'f', { historyImport: true })?.blocks, [{ type: 'text', text: 'thought one\nthought two' }])
})

test('isCodexVisibleHistoryRecord hides legacy prose only when paginated', () => {
  const legacy = { type: 'event_msg', payload: { type: 'agent_message' } }
  const tool = { type: 'response_item', payload: { type: 'function_call' } }
  assert.equal(isCodexVisibleHistoryRecord(legacy, false), true)
  assert.equal(isCodexVisibleHistoryRecord(legacy, true), false)
  assert.equal(isCodexVisibleHistoryRecord(tool, true), true)
})
