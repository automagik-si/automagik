// node --test chat/decode-omp.test.mjs: omp session lines decode to messages. Synthetic fixtures.
// Ported from Orca's src/main/native-chat/transcript-line-decoders.omp.test.ts; its context-usage
// and model-list case tests Orca code not taken here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { decodeOmpTranscriptLine } from './decode-omp.js'

const at = (iso) => Date.parse(iso)
const line = (record) => JSON.stringify(record)
const message = (role, content, extra = {}) =>
  line({ type: 'message', id: 'rec-1', parentId: 'rec-0', timestamp: '2026-07-16T00:27:02.222Z', message: { role, content, ...extra } })

test('an omp session fixture decodes to its messages', () => {
  const lines = readFileSync(new URL('./fixtures/omp.jsonl', import.meta.url), 'utf8').split('\n').filter((l) => l !== '')
  const got = lines.flatMap((l, i) => decodeOmpTranscriptLine(l, `omp.jsonl:${i + 1}`) ?? [])
  const base = (id, role, blocks, iso, extra = {}) => ({ id, role, blocks, timestamp: at(iso), source: 'transcript', ...extra })
  assert.deepEqual(got, [
    base('rec-1', 'user', [{ type: 'text', text: 'What is in package.json?' }], '2026-11-03T10:00:00.100Z'),
    base('rec-2', 'assistant', [{ type: 'text', text: 'Read the file.' }, { type: 'tool-call', name: 'read', input: { path: 'package.json' } }], '2026-11-03T10:00:01.000Z', {
      model: 'test-model', provider: 'test-provider', usage: { inputTokens: 120, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 8 }
    }),
    base('rec-3', 'tool', [{ type: 'tool-result', output: '{"name":"demo"}' }], '2026-11-03T10:00:02.000Z'),
    base('rec-4', 'assistant', [{ type: 'text', text: 'It names the package `demo`.' }], '2026-11-03T10:00:03.000Z', {
      model: 'test-model', provider: 'test-provider', usage: { inputTokens: 140, cacheCreationInputTokens: 0, cacheReadInputTokens: 100, outputTokens: 9 }
    }),
    base('rec-5', 'tool', [{ type: 'tool-call', name: 'bash', input: 'false' }, { type: 'tool-result', output: '', isError: true }], '2026-11-03T10:00:04.000Z'),
    base('rec-7', 'system', [{ type: 'text', text: 'Context compacted', presentation: 'compaction' }], '2026-11-03T10:00:06.000Z')
  ])
})

test('skips malformed lines and non-conversation records', () => {
  assert.equal(decodeOmpTranscriptLine('not json', 'f'), null)
  assert.equal(decodeOmpTranscriptLine(line({ type: 'session_init', id: 'a' }), 'f'), null)
  assert.equal(decodeOmpTranscriptLine(line({ type: 'mode_change', id: 'a' }), 'f'), null)
  assert.equal(decodeOmpTranscriptLine(line({ type: 'custom', customType: 'tool_execution_start' }), 'f'), null)
  assert.equal(decodeOmpTranscriptLine(line({ type: 'a-type-from-the-future' }), 'f'), null)
})

test('decodes a user turn', () => {
  assert.deepEqual(decodeOmpTranscriptLine(message('user', [{ type: 'text', text: 'resume' }]), 'f'), {
    id: 'rec-1', role: 'user', blocks: [{ type: 'text', text: 'resume' }], timestamp: at('2026-07-16T00:27:02.222Z'), source: 'transcript'
  })
})

test('keeps thinking and tool calls together on a mixed assistant turn', () => {
  const decoded = decodeOmpTranscriptLine(message('assistant', [
    { type: 'thinking', thinking: 'Checking the goal' },
    { type: 'text', text: 'Reading it now.' },
    { type: 'toolCall', id: 'call-1', name: 'goal', arguments: { op: 'get' } }
  ]), 'f')
  assert.equal(decoded?.role, 'assistant')
  assert.deepEqual(decoded?.blocks, [
    { type: 'text', text: 'Checking the goal' },
    { type: 'text', text: 'Reading it now.' },
    { type: 'tool-call', name: 'goal', input: { op: 'get' } }
  ])
})

test('keeps a thinking-only assistant turn on the assistant role', () => {
  const decoded = decodeOmpTranscriptLine(message('assistant', [{ type: 'thinking', thinking: 'Weighing two options' }]), 'f')
  assert.equal(decoded?.role, 'assistant')
  assert.deepEqual(decoded?.blocks, [{ type: 'text', text: 'Weighing two options' }])
})

test('passes tool arguments through unchanged', () => {
  const decoded = decodeOmpTranscriptLine(message('assistant', [{ type: 'toolCall', name: 'goal', arguments: { op: 'get', objective: null } }]), 'f')
  assert.deepEqual(decoded?.blocks[0], { type: 'tool-call', name: 'goal', input: { op: 'get', objective: null } })
})

test('decodes a tool result, and flags an errored one', () => {
  const ok = decodeOmpTranscriptLine(message('toolResult', [{ type: 'text', text: 'ok' }], { toolCallId: 'call-1', toolName: 'goal', isError: false }), 'f')
  assert.equal(ok?.role, 'tool')
  assert.deepEqual(ok?.blocks, [{ type: 'tool-result', output: 'ok' }])
  const bad = decodeOmpTranscriptLine(message('toolResult', [{ type: 'text', text: 'boom' }], { toolCallId: 'call-2', isError: true }), 'f')
  assert.deepEqual(bad?.blocks[0], { type: 'tool-result', output: 'boom', isError: true })
})

test('surfaces a displayed custom_message, and hides a state-only one', () => {
  const custom = (display) => line({ type: 'custom_message', id: 'rec-c', customType: 'rewind-report', display, content: [{ type: 'text', text: 'Investigation summary' }], timestamp: '2026-07-16T00:27:02.222Z' })
  assert.deepEqual(decodeOmpTranscriptLine(custom(true), 'f'), {
    id: 'rec-c', role: 'system', blocks: [{ type: 'text', text: 'Investigation summary' }], timestamp: at('2026-07-16T00:27:02.222Z'), source: 'transcript'
  })
  assert.equal(decodeOmpTranscriptLine(custom(false), 'f'), null)
})

test('accepts string content on a custom_message', () => {
  const decoded = decodeOmpTranscriptLine(line({ type: 'custom_message', id: 'rec-s', display: true, content: 'peer said hi' }), 'f')
  assert.deepEqual(decoded?.blocks, [{ type: 'text', text: 'peer said hi' }])
})

test('renders bash and python execution cells as tool turns; cancelled and nonzero exits are errors', () => {
  const bash = decodeOmpTranscriptLine(line({ type: 'message', id: 'rec-b', message: { role: 'bashExecution', command: 'ls -a', output: '.git\n', exitCode: 0 } }), 'f')
  assert.equal(bash?.role, 'tool')
  assert.deepEqual(bash?.blocks, [{ type: 'tool-call', name: 'bash', input: 'ls -a' }, { type: 'tool-result', output: '.git\n' }])
  const py = decodeOmpTranscriptLine(line({ type: 'message', id: 'rec-p', message: { role: 'pythonExecution', code: 'raise SystemExit(2)', output: 'boom', exitCode: 2 } }), 'f')
  assert.deepEqual(py?.blocks, [{ type: 'tool-call', name: 'python', input: 'raise SystemExit(2)' }, { type: 'tool-result', output: 'boom', isError: true }])
  const cancelled = decodeOmpTranscriptLine(line({ type: 'message', id: 'rec-c1', message: { role: 'bashExecution', command: 'sleep 99', output: 'partial', cancelled: true } }), 'f')
  assert.deepEqual(cancelled?.blocks[1], { type: 'tool-result', output: 'partial', isError: true })
})

test('lists file mention paths without dumping their auto-read contents', () => {
  const decoded = decodeOmpTranscriptLine(line({
    type: 'message', id: 'rec-f',
    message: { role: 'fileMention', files: [{ path: 'src/a.ts', content: 'SECRET FILE BODY' }, { path: 'src/b.ts' }, { image: true }] }
  }), 'f')
  assert.equal(decoded?.role, 'system')
  assert.deepEqual(decoded?.blocks, [{ type: 'text', text: '@src/a.ts\n@src/b.ts' }])
  assert.ok(!JSON.stringify(decoded).includes('SECRET FILE BODY'))
})

test('honors the display gate on legacy custom / hookMessage message rows', () => {
  const legacy = (role, display) => line({ type: 'message', id: 'rec-l', message: { role, customType: 'irc:incoming', display, content: 'peer note' } })
  assert.equal(decodeOmpTranscriptLine(legacy('custom', false), 'f'), null)
  assert.equal(decodeOmpTranscriptLine(legacy('hookMessage', false), 'f'), null)
  const shown = decodeOmpTranscriptLine(legacy('custom', true), 'f')
  assert.equal(shown?.role, 'system')
  assert.deepEqual(shown?.blocks, [{ type: 'text', text: 'peer note' }])
})

test('surfaces the developer channel as system', () => {
  assert.equal(decodeOmpTranscriptLine(message('developer', [{ type: 'text', text: 'context note' }]), 'f')?.role, 'system')
})

test('drops blob-handle images, keeps inline ones as data URIs', () => {
  assert.equal(decodeOmpTranscriptLine(message('user', [{ type: 'image', data: 'blob:sha256:abc', mimeType: 'image/webp' }]), 'f'), null)
  assert.deepEqual(decodeOmpTranscriptLine(message('user', [{ type: 'image', data: 'iVBO\nRw0K', mimeType: 'image/png' }]), 'f')?.blocks, [
    { type: 'image-ref', url: 'data:image/png;base64,iVBORw0K' }
  ])
  assert.equal(decodeOmpTranscriptLine(message('user', [{ type: 'image', data: 'AAAA', mimeType: 'text/html' }]), 'f'), null)
})

test('surfaces an aborted turn as the interrupted row, not silence', () => {
  const decoded = decodeOmpTranscriptLine(message('assistant', [{ type: 'text', text: '' }], { stopReason: 'aborted', errorMessage: 'Stopped before model call' }), 'f')
  assert.equal(decoded?.role, 'system')
  assert.deepEqual(decoded?.blocks, [{ type: 'text', text: 'Conversation interrupted' }])
})

test('keeps partial content when a turn aborted mid-stream', () => {
  const decoded = decodeOmpTranscriptLine(message('assistant', [{ type: 'text', text: 'Partial answer' }], { stopReason: 'aborted' }), 'f')
  assert.equal(decoded?.role, 'assistant')
  assert.deepEqual(decoded?.blocks, [{ type: 'text', text: 'Partial answer' }])
})

test('still drops an empty non-aborted assistant turn', () => {
  assert.equal(decodeOmpTranscriptLine(message('assistant', [{ type: 'text', text: '' }]), 'f'), null)
})

test('falls back to the supplied id when the record carries none', () => {
  const decoded = decodeOmpTranscriptLine(line({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }), 'fallback-9')
  assert.equal(decoded?.id, 'fallback-9')
  assert.equal(decoded?.timestamp, null)
})

test('keeps the provider, model and usage of a completed reply; drops usage when aborted or errored', () => {
  const reply = (extra = {}) => message('assistant', [{ type: 'text', text: 'The `value` field is set to **42**.' }], {
    api: 'test-api', provider: 'test-provider', model: 'test-model',
    usage: { input: 680, output: 16, cacheRead: 20992, cacheWrite: 0, totalTokens: 21688, cost: { total: 0.01 } },
    stopReason: 'stop', ...extra
  })
  const done = decodeOmpTranscriptLine(reply(), 'f')
  assert.equal(done?.provider, 'test-provider')
  assert.equal(done?.model, 'test-model')
  assert.deepEqual(done?.usage, { inputTokens: 680, cacheCreationInputTokens: 0, cacheReadInputTokens: 20992, outputTokens: 16 })
  for (const stopReason of ['aborted', 'error']) {
    const decoded = decodeOmpTranscriptLine(reply({ stopReason }), 'f')
    assert.equal(decoded?.model, 'test-model')
    assert.ok(!('usage' in decoded))
  }
})

test('puts no model or usage on turns that are not replies', () => {
  const decoded = decodeOmpTranscriptLine(message('user', [{ type: 'text', text: 'hi' }], { model: 'm', usage: { input: 5 } }), 'f')
  assert.ok(!('usage' in decoded))
  assert.ok(!('model' in decoded))
})

test('marks a compaction row as the boundary it draws', () => {
  const decoded = decodeOmpTranscriptLine(line({
    type: 'compaction', id: 'cmp-1', parentId: 'rec-9', timestamp: '2026-07-16T01:00:00.000Z',
    summary: '…', shortSummary: '…', firstKeptEntryId: 'rec-7', tokensBefore: 180000
  }), 'f')
  assert.deepEqual(decoded, {
    id: 'cmp-1', role: 'system', blocks: [{ type: 'text', text: 'Context compacted', presentation: 'compaction' }],
    timestamp: at('2026-07-16T01:00:00.000Z'), source: 'transcript'
  })
})
