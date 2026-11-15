// node --test chat/decode-claude.test.mjs: Claude Code transcript lines decode to messages.
// Synthetic fixtures. Ported cases keep the name of the Orca test they come from
// (src/main/native-chat/transcript-line-decoders-claude-*.test.ts); the parts that test Orca's
// renderer (folding, command-output surfacing) are not taken.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { decodeClaudeTranscriptLine } from './decode-claude.js'

const at = (iso) => Date.parse(iso)
const lines = readFileSync(new URL('./fixtures/claude.jsonl', import.meta.url), 'utf8').split('\n').filter((l) => l !== '')

test('a Claude session fixture decodes to its messages, skipping what is not a turn', () => {
  const got = lines.flatMap((l, i) => decodeClaudeTranscriptLine(l, `claude.jsonl:${i + 1}`) ?? [])
  assert.deepEqual(got, [
    { id: 'u-1', role: 'user', blocks: [{ type: 'text', text: 'List the files in src and fix the typo in main.js' }], timestamp: at('2026-11-03T10:00:00.000Z'), source: 'transcript' },
    { id: 'a-1', role: 'reasoning', blocks: [{ type: 'text', text: 'Look at src first.' }], timestamp: at('2026-11-03T10:00:01.000Z'), source: 'transcript', parentId: 'u-1' },
    {
      id: 'a-2', role: 'assistant', timestamp: at('2026-11-03T10:00:02.000Z'), source: 'transcript', parentId: 'a-1',
      blocks: [
        { type: 'text', text: "I'll list the files." },
        { type: 'tool-call', name: 'Bash', input: { command: 'ls src', description: 'List src' }, callId: 'toolu_01' }
      ]
    },
    { id: 'u-2', role: 'tool', blocks: [{ type: 'tool-result', output: 'main.js\nutil.js', callId: 'toolu_01' }], timestamp: at('2026-11-03T10:00:03.000Z'), source: 'transcript', parentId: 'a-2' },
    {
      id: 'a-3', role: 'assistant', timestamp: at('2026-11-03T10:00:04.000Z'), source: 'transcript', parentId: 'u-2',
      blocks: [{ type: 'tool-call', name: 'Edit', input: { file_path: '/home/u/proj/src/main.js', old_string: 'conosle', new_string: 'console' }, callId: 'toolu_02' }]
    },
    {
      id: 'u-3', role: 'tool', timestamp: at('2026-11-03T10:00:05.000Z'), source: 'transcript', parentId: 'a-3',
      blocks: [{
        type: 'tool-result', output: 'The file has been updated.', callId: 'toolu_02',
        editPatch: { filePath: '/home/u/proj/src/main.js', hunks: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-conosle.log(1)', '+console.log(1)'] }] }
      }]
    },
    { id: 'a-4', role: 'assistant', blocks: [{ type: 'text', text: 'Fixed the typo in `src/main.js`.' }], timestamp: at('2026-11-03T10:00:06.000Z'), source: 'transcript', parentId: 'u-3' },
    { id: 'u-int', role: 'system', blocks: [{ type: 'text', text: 'Conversation interrupted' }], timestamp: at('2026-11-03T10:00:07.000Z'), source: 'transcript', parentId: 'a-4' }
  ])
})

test('a line that does not parse, or is not a turn, is skipped', () => {
  for (const l of ['', '   ', 'not json', '[1,2]', '"text"', '{"type":"summary","summary":"x"}', '{"type":"user"}', '{"type":"assistant","message":{"content":[]}}']) {
    assert.equal(decodeClaudeTranscriptLine(l, 'f'), null, l)
  }
})

test('a record without uuid takes the message id, then the fallback id', () => {
  const noUuid = JSON.stringify({ type: 'assistant', message: { id: 'msg_9', content: 'hi' } })
  assert.equal(decodeClaudeTranscriptLine(noUuid, 'f')?.id, 'msg_9')
  const bare = JSON.stringify({ type: 'user', message: { content: 'hi' } })
  assert.equal(decodeClaudeTranscriptLine(bare, 'file:7')?.id, 'file:7')
  assert.equal(decodeClaudeTranscriptLine(bare, 'file:7')?.timestamp, null)
})

test('a user ! command echo is restored as typed', () => {
  const line = JSON.stringify({ type: 'user', uuid: 'b', message: { content: '<bash-input>git status</bash-input>' } })
  assert.deepEqual(decodeClaudeTranscriptLine(line, 'f')?.blocks, [{ type: 'text', text: '!git status' }])
})

// --- transcript-line-decoders-claude-control-bytes.test.ts

test('keeps the Ctrl+U byte the TUI pasted into the prompt', () => {
  const text = 'line 000 xxxxxxxxxx\nline 001 xxxxxxxxxx\nline 002 xxxxxxxxxx'
  const line = JSON.stringify({ type: 'user', uuid: 'synthetic-user-turn', message: { role: 'user', content: `\u0015${text}` } })
  const message = decodeClaudeTranscriptLine(line, 'fallback')
  assert.equal(message?.role, 'user')
  assert.deepEqual(message?.blocks[0], { type: 'text', text: `\u0015${text}` })
})

// --- transcript-line-decoders-claude-image-companion.test.ts

test('a pasted-image companion row is kept despite isMeta; ordinary injected turns are dropped', () => {
  const companion = JSON.stringify({
    type: 'user', uuid: 'companion-uuid', isMeta: true, turnCompanion: true, timestamp: '2026-09-01T01:33:04.608Z',
    message: { role: 'user', content: [{ type: 'text', text: '[Image: source: /tmp/paste-a.png]' }, { type: 'text', text: '[Image: source: /tmp/paste-b.png]' }] }
  })
  assert.deepEqual(decodeClaudeTranscriptLine(companion, 'f')?.blocks, [
    { type: 'text', text: '[Image: source: /tmp/paste-a.png]' },
    { type: 'text', text: '[Image: source: /tmp/paste-b.png]' }
  ])
  const injected = JSON.stringify({ type: 'user', uuid: 'injected', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /x' }] } })
  assert.equal(decodeClaudeTranscriptLine(injected, 'fallback'), null)
})

test('does not turn a mixed marker-and-prose meta row into an image source turn', () => {
  const mixed = JSON.stringify({
    type: 'user', uuid: 'mixed', isMeta: true,
    message: { role: 'user', content: [{ type: 'text', text: '[Image: source: /tmp/a.png]' }, { type: 'text', text: 'metadata prose' }] }
  })
  assert.equal(decodeClaudeTranscriptLine(mixed, 'fallback'), null)
})

test('retains tool results from a mixed meta row while dropping its marker text', () => {
  const mixed = JSON.stringify({
    type: 'user', uuid: 'mixed-tool', isMeta: true,
    message: { role: 'user', content: [{ type: 'text', text: '[Image: source: /tmp/a.png]' }, { type: 'tool_result', content: 'tool output' }] }
  })
  const got = decodeClaudeTranscriptLine(mixed, 'fallback')
  assert.equal(got?.id, 'mixed-tool')
  assert.equal(got?.role, 'tool')
  assert.deepEqual(got?.blocks, [{ type: 'tool-result', output: 'tool output' }])
})

test('a prompt with base64 images keeps its text and image blocks with no url or path dropped', () => {
  const prompt = JSON.stringify({
    type: 'user', uuid: 'prompt-uuid',
    message: { role: 'user', content: [{ type: 'text', text: 'look at this [Image #1]' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }] }
  })
  assert.deepEqual(decodeClaudeTranscriptLine(prompt, 'f')?.blocks, [{ type: 'text', text: 'look at this [Image #1]' }])
})

// --- transcript-line-decoders-claude-pasted-content.test.ts

const prompt = 'Summarize the failing tests.\n\nThen propose a fix for each one.'
const wrapped = `\n\n<pasted_content id="7e64">\n${prompt}\n</pasted_content id="7e64">\n`
const decodeText = (text, role = 'user', array = false) =>
  decodeClaudeTranscriptLine(JSON.stringify({ type: role, uuid: 'user', message: { content: array ? [{ type: 'text', text }] : text } }), 'fallback')

test('decodes the whole-block paste envelope in host user content', () => {
  for (const array of [false, true]) {
    assert.deepEqual(decodeText(wrapped, 'user', array).blocks, [{ type: 'text', text: prompt }])
  }
})

test('accepts CRLF and a paste wrapper without ids', () => {
  assert.deepEqual(decodeText(`<pasted_content>\r\n${prompt}\r\n</pasted_content>`).blocks, [{ type: 'text', text: prompt }])
})

test('decodes a paste whose own text quotes differently identified or bare tags', () => {
  const quoted = `<pasted_content id="aa">\nx\n</pasted_content id="aa">\n</pasted_content>`
  assert.deepEqual(decodeText(`<pasted_content id="7e64">\n${quoted}\n</pasted_content id="7e64">`).blocks, [{ type: 'text', text: quoted }])
})

test('preserves prose and nonmatching paste envelopes', () => {
  for (const text of [
    `Explain this:\n${wrapped}`,
    `<pasted_content id="7e64">\n<pasted_content id="7e64">\nx\n</pasted_content id="7e64">`,
    `<pasted_content>\n<pasted_content id="aa">\nx\n</pasted_content id="aa">\n</pasted_content>`,
    wrapped.replace('id="7e64">\n', 'id="other">\n'),
    wrapped.replace('</pasted_content id="7e64">', '</pasted_content>'),
    wrapped.replace('<pasted_content id="7e64">', '<pasted_content>'),
    `${wrapped}\n${wrapped}`
  ]) {
    assert.deepEqual(decodeText(text).blocks, [{ type: 'text', text }], JSON.stringify(text))
  }
})

test('leaves assistant text with a paste envelope untouched', () => {
  assert.deepEqual(decodeText(wrapped, 'assistant').blocks, [{ type: 'text', text: wrapped }])
})

// --- transcript-line-decoders-claude-queued-prompt.test.ts

const queuedCommand = (attachment) => JSON.stringify({
  parentUuid: 'tool-result-row', isSidechain: false,
  attachment: { type: 'queued_command', source_uuid: 'cmd-1', delivery_id: 'delivery-1', timestamp: '2026-10-06T21:49:54.910Z', ...attachment },
  type: 'attachment', uuid: 'queued-row', timestamp: '2026-10-06T21:49:54.910Z',
  rendered: [{ content: '<system-reminder>\nThe user sent a new message…</system-reminder>' }]
})

test('decodes a prompt absorbed mid-turn as the user row Claude never writes', () => {
  const line = queuedCommand({ prompt: 'use the other approach instead', commandMode: 'prompt', origin: { kind: 'human' }, humanTurn: true })
  assert.deepEqual(decodeClaudeTranscriptLine(line, 'fallback'), {
    id: 'queued-row', role: 'user', blocks: [{ type: 'text', text: 'use the other approach instead' }],
    timestamp: at('2026-10-06T21:49:54.910Z'), source: 'transcript', parentId: 'tool-result-row'
  })
})

test('a queued command that is not a human prompt is not a user row', () => {
  assert.equal(decodeClaudeTranscriptLine(queuedCommand({ prompt: 'x', commandMode: 'prompt', origin: { kind: 'agent' } }), 'f'), null)
  assert.equal(decodeClaudeTranscriptLine(queuedCommand({ prompt: '/compact', commandMode: 'bash' }), 'f'), null)
  // Legacy prompt-mode entries omit origin and are human-authored.
  assert.equal(decodeClaudeTranscriptLine(queuedCommand({ prompt: 'legacy', commandMode: 'prompt' }), 'f')?.role, 'user')
})

// --- transcript-line-decoders-claude-stop-hook.test.ts

test('a Stop hook that sent the turn back shows as a warning status row', () => {
  for (const feedback of ['Verify your statement with evidence.', '[/tmp/hook.sh]: Verify your statement with evidence.\n']) {
    const line = JSON.stringify({ type: 'user', uuid: 'feedback', isMeta: true, timestamp: '2026-11-01T05:33:22.035Z', message: { role: 'user', content: `Stop hook feedback:\n${feedback}` } })
    assert.deepEqual(decodeClaudeTranscriptLine(line, 'fallback'), {
      id: 'feedback', role: 'system', timestamp: at('2026-11-01T05:33:22.035Z'), source: 'transcript',
      blocks: [{ type: 'text', text: 'Stop hook feedback: Verify your statement with evidence.', presentation: 'hook-sent-back', tone: 'warning' }]
    })
  }
})
