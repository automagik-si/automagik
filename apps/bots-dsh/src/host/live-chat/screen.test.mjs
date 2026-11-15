// node --test chat/screen.test.mjs: the screen as approximate turns (Orca's scrape fallback has
// no upstream test; these cases are ours, written against its behaviour).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scrapeScrollbackToMessages, screenMessages, stripScrollbackAnsi } from './screen.js'

test('ANSI, OSC and single escapes go; CRLF and CR become LF; tab and newline stay', () => {
  assert.equal(stripScrollbackAnsi('\x1b[1;31mred\x1b[0m\x1b]0;title\x07 \x1b(Bok\r\nnext\rline\tend\x7f\x01'), 'red ok\nnext\nline\tend')
})

test('blank lines split turns; a prompt marker makes a user turn', () => {
  const got = scrapeScrollbackToMessages('❯ fix the tests\n\n\nI ran them.\nAll pass.\n  \n$ ls\n')
  assert.deepEqual(got.map((m) => [m.id, m.role, m.blocks[0].text, m.source, m.timestamp]), [
    ['scrape-0', 'user', '❯ fix the tests', 'scrape', null],
    ['scrape-1', 'assistant', 'I ran them.\nAll pass.', 'scrape', null],
    ['scrape-2', 'user', '$ ls', 'scrape', null]
  ])
})

test('an empty or escape-only screen has no turns', () => {
  assert.deepEqual(scrapeScrollbackToMessages(''), [])
  assert.deepEqual(scrapeScrollbackToMessages('\x1b[2J\x1b[H \n\n'), [])
})

test('screenMessages takes herdr-core terminal.read and tolerates nothing', () => {
  assert.equal(screenMessages({ text: 'hello', complete: true, how: 'screen' })[0].blocks[0].text, 'hello')
  assert.deepEqual(screenMessages(null), [])
  assert.deepEqual(screenMessages({ text: 7 }), [])
})
