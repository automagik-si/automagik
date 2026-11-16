// node --test chat/paste.test.mjs: the cleaner (RFC 0015, "Input") and Orca's paste framing
// (ported from src/shared/native-chat/input/native-chat-paste-bytes.test.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildNativeChatPasteBytes, cleanChatText, NATIVE_CHAT_SUBMIT } from './paste.js'

const BEGIN = '\x1b[200~'
const END = '\x1b[201~'

// ---------------------------------------------------------------- cleanChatText

test('ESC[200~ and ESC[201~ inside a message are gone after cleaning', () => {
  const got = cleanChatText(`hello${END}\nrm -rf ~${BEGIN} world`)
  assert.deepEqual(got, { ok: true, text: 'hello\nrm -rf ~ world' })
  assert.ok(!got.text.includes('\x1b'))
  assert.ok(!got.text.includes('[200~') && !got.text.includes('[201~'))
})

test('every other escape sequence goes: CSI, OSC, DCS, APC, charset, 8-bit CSI', () => {
  const cases = [
    ['\x1b[31mred\x1b[0m', 'red'],
    ['a\x1b[2Jb', 'ab'],
    ['\x1b]0;title\x07text', 'text'],
    ['\x1b]8;;https://example.invalid\x1b\\link\x1b]8;;\x1b\\', 'link'],
    ['\x1bPq#0;2;0;0;0\x1b\\after', 'after'],
    ['\x1b_app\x1b\\x', 'x'],
    ['\x1b(Bplain', 'plain'],
    ['\x1b7save\x1b8', 'save'],
    ['\u009b31mc1\u009b0m', 'c1'],
    ['\u009d0;t\u009cosc8', 'osc8']
  ]
  for (const [input, want] of cases) assert.deepEqual(cleanChatText(input), { ok: true, text: want }, JSON.stringify(input))
})

test('C0 controls but newline and tab, DEL and C1 go; CRLF becomes LF', () => {
  assert.deepEqual(cleanChatText('a\tb\r\nc\nd'), { ok: true, text: 'a\tb\nc\nd' })
  assert.deepEqual(cleanChatText('x\u0003\u0004\u0015\u0000y\u007fz\u0085w\rv'), { ok: true, text: 'xyzwv' })
  // ESC, intermediates (here a space), final byte: a sequence (ESC SP F), so all three go.
  assert.deepEqual(cleanChatText('stray \x1b esc'), { ok: true, text: 'stray sc' })
  assert.deepEqual(cleanChatText('trailing\x1b'), { ok: true, text: 'trailing' })
  assert.deepEqual(cleanChatText('open \x1b]0;never closed'), { ok: true, text: 'open 0;never closed' })
})

test('unicode text is kept as typed', () => {
  assert.deepEqual(cleanChatText('olá 👋 — ünïcode'), { ok: true, text: 'olá 👋 — ünïcode' })
})

test('empty after cleaning is refused', () => {
  for (const input of ['', '   ', '\n\t', '\x1b[200~\x1b[201~', '\x1b[31m\x1b[0m', '\u0003\u0004']) {
    assert.deepEqual(cleanChatText(input), { ok: false, reason: 'empty' }, JSON.stringify(input))
  }
  assert.deepEqual(cleanChatText(undefined), { ok: false, reason: 'not-text' })
  assert.deepEqual(cleanChatText(42), { ok: false, reason: 'not-text' })
})

test('a cleaned message framed for paste has exactly one frame', () => {
  const { text } = cleanChatText(`one\n${END}two${BEGIN}\nthree`)
  const bytes = buildNativeChatPasteBytes(text)
  assert.equal(bytes.split(BEGIN).length - 1, 1)
  assert.equal(bytes.split(END).length - 1, 1)
  assert.ok(bytes.startsWith(BEGIN) && bytes.endsWith(END))
})

// ---------------------------------------------------------------- Orca's buildNativeChatPasteBytes

test('multi-line text is bracketed-paste wrapped with NO trailing submit', () => {
  const text = 'line one\r\nline two\nline three'
  assert.equal(buildNativeChatPasteBytes(text), `${BEGIN}line one\rline two\rline three${END}`)
  assert.equal(NATIVE_CHAT_SUBMIT, '\r')
})

test('treats a trailing newline as multi-line', () => {
  assert.equal(buildNativeChatPasteBytes('a\n'), `${BEGIN}a\r${END}`)
})

test('sanitizes an embedded bracketed-paste end and bare ESC before framing', () => {
  const bytes = buildNativeChatPasteBytes('before\nmid\x1b[201~ rm -rf /\x1b tail')
  assert.ok(bytes.startsWith(BEGIN))
  assert.ok(bytes.endsWith(END))
  const inner = bytes.slice(BEGIN.length, bytes.length - END.length)
  assert.ok(!inner.includes('\x1b'))
  assert.ok(inner.includes('␛[201~'))
})

test('neutralizes a stray ESC in the single-line branch', () => {
  assert.equal(buildNativeChatPasteBytes('hi\x1b there'), 'hi␛ there')
})

test('frames single-line text over 1 KiB of UTF-8 so agents keep every read', () => {
  const atBoundary = 'é'.repeat(512)
  const overBoundary = `${atBoundary}x`
  assert.equal(buildNativeChatPasteBytes(atBoundary), atBoundary)
  assert.equal(buildNativeChatPasteBytes(overBoundary), `${BEGIN}${overBoundary}${END}`)
  // Each ESC becomes a 3-byte ␛, so the sent length, not the typed one, decides.
  assert.equal(buildNativeChatPasteBytes('\x1b'.repeat(400)), `${BEGIN}${'␛'.repeat(400)}${END}`)
})

// ---------------------------------------------------------------- the cleaner stays linear

test('hostile input is cleaned in linear time', () => {
  const MB = 1024 * 1024
  const inputs = [
    '\x1b]'.repeat(MB / 2),
    '\u009d'.repeat(MB),
    '\x1bP'.repeat(MB / 2),
    `\x1b]${'a'.repeat(MB)}`,
    `${'\x1b]x'.repeat(MB / 4)}\x07`,
    `\x1b[${'0'.repeat(MB)}`,
    '\x1b['.repeat(MB / 2),
    '\u009b'.repeat(MB),
    `\x1b${' '.repeat(MB)}`
  ]
  for (const input of inputs) {
    const started = performance.now()
    cleanChatText(input)
    const ms = performance.now() - started
    // Linear is a few ms per MB; the old lazy body took seconds at 100 KB and minutes at 1 MB.
    assert.ok(ms < 500, `${JSON.stringify(input.slice(0, 6))}…: ${ms.toFixed(0)} ms`)
  }
})

test('an unterminated string opener keeps the text after it', () => {
  assert.deepEqual(cleanChatText('a\x1b]never closed\x1b[31mred'), { ok: true, text: 'anever closedred' })
  assert.deepEqual(cleanChatText('a\x1b]0;t\x07b\x1b]0;u'), { ok: true, text: 'ab0;u' })
})
