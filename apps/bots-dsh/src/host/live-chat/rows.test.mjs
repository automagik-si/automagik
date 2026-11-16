// node --test chat/rows.test.mjs: decoded messages and screen turns to RFC 0015 rows.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { INPUT_PREVIEW, OUTPUT_PREVIEW, preview, RowStore, tokensFromLine, toolSummary } from './rows.js'
import { decodeClaudeTranscriptLine } from './decode-claude.js'
import { decodeOmpTranscriptLine } from './decode-omp.js'
import { decodeCodexTranscriptLine } from './decode-codex.js'

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').split('\n').filter(Boolean)
const shape = (r) => { const { at, segment, source, ...rest } = r; return rest }

test('a Claude session becomes rows: turns, calls paired with results, ids by segment and line', () => {
  const store = new RowStore()
  const lines = fixture('claude.jsonl')
  lines.forEach((l, i) => {
    const m = decodeClaudeTranscriptLine(l, `1:${i + 1}`)
    if (m) store.addMessage(m, { line: i + 1, tokens: tokensFromLine('claude', l) })
  })
  assert.deepEqual(store.rows.map(shape), [
    { id: '1:2.0', turn: 1, kind: 'text', role: 'user', text: 'List the files in src and fix the typo in main.js' },
    { id: '1:4.0', turn: 1, kind: 'text', role: 'assistant', text: "I'll list the files." },
    { id: '1:4.1', turn: 1, kind: 'tool-call', tool: 'Bash', summary: 'ls src', input: '{"command":"ls src","description":"List src"}' },
    { id: '1:5.0', turn: 1, kind: 'tool-result', call: '1:4.1', ok: true, output: 'main.js\nutil.js' },
    { id: '1:6.0', turn: 1, kind: 'tool-call', tool: 'Edit', summary: '/home/u/proj/src/main.js', input: '{"file_path":"/home/u/proj/src/main.js","old_string":"conosle","new_string":"console"}' },
    { id: '1:7.0', turn: 1, kind: 'tool-result', call: '1:6.0', ok: true, output: 'The file has been updated.' },
    { id: '1:9.0', turn: 1, kind: 'text', role: 'assistant', text: 'Fixed the typo in `src/main.js`.' },
    { id: '1:9.1', turn: 1, kind: 'tokens', input: 10, output: 5, cache: 0, context: 10 },
    { id: '1:12.0', turn: 1, kind: 'status', state: 'interrupted', msg: 'Conversation interrupted' }
  ])
  assert.ok(store.rows.every((r) => r.source === 'transcript' && r.segment === 1))
  assert.deepEqual(store.openCalls(), [])
})

test('open calls: one per call with no result; an interruption abandons them', () => {
  const store = new RowStore()
  const call = (id, name) => ({ id, role: 'assistant', blocks: [{ type: 'tool-call', name, input: { command: 'rm -rf build' }, callId: id }], timestamp: null, source: 'transcript' })
  store.addMessage(call('c1', 'Bash'), { line: 1 })
  store.addMessage(call('c2', 'Read'), { line: 2 })
  assert.deepEqual(store.openCalls().map((c) => [c.tool, c.input]), [['Bash', { command: 'rm -rf build' }], ['Read', { command: 'rm -rf build' }]])
  store.addMessage({ id: 'r', role: 'tool', blocks: [{ type: 'tool-result', output: 'x', callId: 'c2' }], timestamp: null, source: 'transcript' }, { line: 3 })
  assert.deepEqual(store.openCalls().map((c) => c.tool), ['Bash'])
  store.addMessage({ id: 'i', role: 'system', blocks: [{ type: 'text', text: 'Conversation interrupted' }], timestamp: null, source: 'transcript' }, { line: 4 })
  assert.deepEqual(store.openCalls(), [])
})

test('omp: results pair with calls in order (no call ids); usage becomes a tokens row; reasoning-only skipped', () => {
  const store = new RowStore()
  fixture('omp.jsonl').forEach((l, i) => { const m = decodeOmpTranscriptLine(l, `1:${i + 1}`); if (m) store.addMessage(m, { line: i + 1 }) })
  const kinds = store.rows.map((r) => [r.kind, r.call ?? r.tool ?? r.state ?? r.role])
  assert.deepEqual(kinds, [
    ['text', 'user'], ['text', 'assistant'], ['tool-call', 'read'], ['tokens', undefined],
    ['tool-result', '1:4.1'], ['text', 'assistant'], ['tokens', undefined],
    ['tool-call', 'bash'], ['tool-result', '1:7.0'], ['status', 'compacted']
  ])
  assert.deepEqual(shape(store.rows[6]), { id: '1:6.1', turn: 1, kind: 'tokens', input: 140, output: 9, cache: 100, context: 240 })
  assert.equal(store.rows[8].ok, false)
})

test('codex: token_count lines give tokens rows', () => {
  const lines = fixture('codex.jsonl')
  const t = lines.map((l) => tokensFromLine('codex', l)).filter(Boolean)
  assert.deepEqual(t, [])
  assert.deepEqual(tokensFromLine('codex', JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 120, cached_input_tokens: 100, output_tokens: 7 } } } })),
    { input: 120, output: 7, cache: 100, context: 120 })
  const store = new RowStore()
  lines.forEach((l, i) => { const m = decodeCodexTranscriptLine(l, `1:${i + 1}`); if (m) store.addMessage(m, { line: i + 1 }) })
  assert.deepEqual(store.rows.filter((r) => r.kind === 'tool-result').map((r) => [r.call, r.ok]), [['1:7.0', true], ['1:9.0', false]])
})

test('screen rows fill the turn until transcript rows cover it, then go', () => {
  const store = new RowStore()
  const screen = (text) => [{ id: 'scrape-0', role: 'assistant', blocks: [{ type: 'text', text }], timestamp: null, source: 'scrape' }]
  store.addMessage({ id: 'u', role: 'user', blocks: [{ type: 'text', text: 'go' }], timestamp: 1, source: 'transcript' }, { line: 1 })
  assert.deepEqual(store.setScreen(screen('Working on it')).map(shape), [{ id: 'screen:0', turn: 1, kind: 'text', role: 'assistant', text: 'Working on it' }])
  assert.equal(store.setScreen(screen('Working on it')), null, 'unchanged screen: nothing new')
  store.addMessage({ id: 'a', role: 'assistant', blocks: [{ type: 'text', text: 'Done' }], timestamp: 2, source: 'transcript' }, { line: 2 })
  assert.deepEqual(store.screen, [])
  assert.equal(store.setScreen(screen('Done')), null, 'covered: the screen adds nothing')
  store.addMessage({ id: 'u2', role: 'user', blocks: [{ type: 'text', text: 'again' }], timestamp: 3, source: 'transcript' }, { line: 3 })
  assert.equal(store.setScreen(screen('next turn'))[0].turn, 2)
})

test('a new session is a divider and a new segment; ids never repeat', () => {
  const store = new RowStore()
  store.addMessage({ id: 'u', role: 'user', blocks: [{ type: 'text', text: 'a' }], timestamp: null, source: 'transcript' }, { line: 1 })
  const d = store.newSegment()
  assert.deepEqual(shape(d), { id: '2:0.0', turn: 1, kind: 'status', state: 'new-session', msg: '' })
  store.addMessage({ id: 'u', role: 'user', blocks: [{ type: 'text', text: 'b' }], timestamp: null, source: 'transcript' }, { line: 1 })
  assert.deepEqual(store.rows.map((r) => r.id), ['1:1.0', '2:0.0', '2:1.0'])
})

test('only the last rows are kept; a cursor still held gives what follows, else null', () => {
  const store = new RowStore({ keep: 3 })
  for (let i = 1; i <= 5; i++) store.addMessage({ id: `u${i}`, role: 'user', blocks: [{ type: 'text', text: `m${i}` }], timestamp: null, source: 'transcript' }, { line: i })
  assert.deepEqual(store.rows.map((r) => r.text), ['m3', 'm4', 'm5'])
  assert.deepEqual(store.after('1:3.0').map((r) => r.text), ['m4', 'm5'])
  assert.equal(store.after('1:1.0'), null)
  assert.equal(store.after(null).length, 3)
})

test('previews are cut; summaries are one short line', () => {
  assert.equal(preview('x'.repeat(INPUT_PREVIEW + 5), INPUT_PREVIEW).length, INPUT_PREVIEW + 1)
  assert.equal(preview({ a: 1 }, 100), '{"a":1}')
  assert.equal(preview(undefined, 10), '')
  const store = new RowStore()
  store.addMessage({ id: 'r', role: 'tool', blocks: [{ type: 'tool-result', output: 'y'.repeat(OUTPUT_PREVIEW * 2) }], timestamp: null, source: 'transcript' }, { line: 1 })
  assert.equal(store.rows[0].output.length, OUTPUT_PREVIEW + 1)
  assert.equal(toolSummary('shell', '{"command":["bun","test"]}'), 'bun test')
  assert.equal(toolSummary('apply_patch', '*** Begin Patch\n*** End Patch'), '*** Begin Patch')
  assert.equal(toolSummary('Bash', { command: 'echo a\n  && echo b' }), 'echo a && echo b')
  assert.equal(toolSummary('x', null), '')
})

test('images are links the person taps, never inline data', () => {
  const store = new RowStore()
  store.addMessage({ id: 'u', role: 'user', blocks: [{ type: 'image-ref', url: 'https://example.invalid/a.png' }, { type: 'image-ref', url: 'data:image/png;base64,AAAA' }, { type: 'image-ref', path: '/tmp/a.png' }], timestamp: null, source: 'transcript' }, { line: 1 })
  assert.deepEqual(store.rows.map((r) => r.text), ['[image](https://example.invalid/a.png)', '[image]', '[image]'])
})

test('reasoning is not a row: a thinking-only message adds nothing', () => {
  const store = new RowStore()
  const added = store.addMessage({ id: 'r', role: 'reasoning', blocks: [{ type: 'text', text: 'private chain of thought' }], timestamp: null, source: 'transcript' }, { line: 1 })
  assert.deepEqual(added, [])
  assert.deepEqual(store.rows, [])
})
