// #1326 K1, G1 and G5: the shared gen-UI kit's own words. A row prints a name, a state and
// the counts a card was given, never a field it does not know; a person card reads the bot's
// four parts out of its reading note and puts the coverage beside them. No browser: these are
// the model the components draw, so a wording or format change is proved here.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  contactLine, countText, coverageLine, coverageOf, parseReadingNote, percentOf, personView,
  rowView, shortDate, spanOf, stateId, stateWord,
} from '../src/client/genui-model.js'

// The four parts as Omni's save_reading_note asks the bot to write them (O2's own example).
const NOTE = 'Who: a client of the user since March.\nOpen: the order for Thursday.\nLast contact: 1 Nov, about the order.\nTone: short and friendly.'

const coverage = {
  oldest: '2026-03-02T12:00:00Z',
  newest: '2026-11-20T12:00:00Z',
  count: 4400,
  countInWindow: 120,
  mediaMissing: 2,
  deletedCount: 3,
  lastInbound: '2026-11-20T12:00:00Z',
  lastOutbound: '2026-08-01T12:00:00Z',
}

test('a reading row says its page and the months the chat covers', () => {
  const view = rowView({ chatId: 'c1', chat: 'Maria', state: 'reading', page: 3, pages: 12, coverage })
  assert.equal(view.name, 'Maria')
  assert.equal(view.word, 'Reading')
  assert.equal(view.state, 'work')
  assert.equal(view.page, 'Page 3 of about 12')
  assert.equal(view.progress, '')
  assert.equal(view.span, 'Mar–Nov')
  assert.equal(view.coverage, '4,400 messages · Mar–Nov · 3 deleted · 2 missing media')
  assert.deepEqual(view.media, '')
  assert.deepEqual(view.marks, '')
})

test('a fetching row says how much of the total it holds, its photos and its marks', () => {
  const view = rowView({
    chatId: 'c1', chat: 'Maria', state: 'fetching',
    counts: { fetched: 4180, total: 4400, mediaDownloaded: 38, mediaMissing: 2, reactions: 5, edits: 2 },
  })
  assert.equal(view.word, 'Fetching')
  assert.equal(view.state, 'work')
  assert.equal(view.progress, '4,180 of 4,400 · 95%')
  assert.equal(view.media, '38 photos, 2 missing')
  assert.equal(view.marks, '5 reactions · 2 edits')
  // The counts may also come flat, as the kit's first readers pass them.
  const flat = rowView({ chatId: 'c1', state: 'fetching', fetched: 4180, total: 4400, mediaMissing: 2 })
  assert.equal(flat.progress, '4,180 of 4,400 · 95%')
  assert.equal(flat.media, '2 missing')
  // A fetched count without a total is still a count.
  assert.equal(rowView({ chatId: 'c1', state: 'fetching', counts: { fetched: 12 } }).progress, '12 fetched')
})

test('one end state per row, in plain words, and each one its own dot', () => {
  const cases = [
    [{ state: 'queued' }, 'Waiting', 'work'],
    [{ state: 'done', outcome: 'done' }, 'Done', 'done'],
    [{ state: 'done', outcome: 'not-started' }, 'Not started', 'stopped'],
    [{ state: 'phone-did-not-answer', outcome: 'phone-did-not-answer' }, 'Phone did not answer', 'phone'],
    [{ state: 'cancelled', outcome: 'stopped' }, 'Stopped', 'stopped'],
    [{ state: 'failed', outcome: 'failed' }, 'Failed', 'failed'],
    [{ state: 'done' }, 'Done', 'done'],
    [{ outcome: 'failed' }, 'Failed', 'failed'],
    [{}, '', 'unknown'],
  ]
  for (const [row, word, id] of cases) {
    assert.equal(stateWord(row), word, JSON.stringify(row))
    assert.equal(stateId(row), id, JSON.stringify(row))
    assert.equal(rowView({ chatId: 'c1', chat: 'Maria', ...row }).word, word)
  }
})

test('numbers are the interface\'s, and a percent is always a whole 0-100', () => {
  assert.equal(countText(4180), '4,180')
  assert.equal(countText('4400'), '4,400')
  assert.equal(countText(-1), '')
  assert.equal(percentOf(4180, 4400), 95)
  assert.equal(percentOf(0, 4400), 0)
  assert.equal(percentOf(4400, 4400), 100)
  assert.equal(percentOf(4401, 4400), 100)
  assert.equal(percentOf(1, 0), undefined)
  assert.equal(percentOf(1, undefined), undefined)
})

test('a coverage line and its months, also across a year', () => {
  assert.equal(coverageLine(coverage), '4,400 messages · Mar–Nov · 3 deleted · 2 missing media')
  assert.equal(coverageLine({ count: 12 }), '12 messages')
  assert.equal(coverageLine(null), '')
  assert.equal(coverageLine({ none: true }), '')
  assert.equal(spanOf({ oldest: '2026-08-02T12:00:00Z', newest: '2026-08-20T12:00:00Z' }), 'Aug 2026')
  assert.equal(spanOf({ oldest: '2025-08-02T12:00:00Z', newest: '2026-08-20T12:00:00Z' }), 'Aug 2025 – Aug 2026')
  assert.equal(spanOf({ oldest: '2025-03-02T12:00:00Z', newest: '2026-11-20T12:00:00Z' }), 'Mar 2025 – Nov 2026')
  assert.equal(spanOf({ oldest: '2026-03-02T12:00:00Z' }), 'Mar 2, 2026')
  assert.equal(spanOf({}), '')
  assert.equal(shortDate('2026-11-20T12:00:00Z'), 'Nov 20, 2026')
  assert.equal(shortDate('not a date'), '')
  assert.deepEqual(coverageOf({ ...coverage, mystery: 'x' }), coverage)
  assert.equal(coverageOf({ oldest: 'nope' }), undefined)
  // Last contact each way, from the coverage rather than the note.
  assert.equal(contactLine(coverage), 'From them Nov 20, 2026 · From you Aug 1, 2026')
  assert.equal(contactLine({ lastInbound: coverage.lastInbound }), 'From them Nov 20, 2026')
  assert.equal(contactLine(null), '')
})

test('a reading note splits into the four parts the bot was asked for, and keeps its prose', () => {
  assert.deepEqual(parseReadingNote(NOTE), {
    blocks: {
      who: 'a client of the user since March.',
      open: 'the order for Thursday.',
      contact: '1 Nov, about the order.',
      tone: 'short and friendly.',
    },
    loose: '',
  })
  // The same parts in the words a Bot may choose, one continued over several lines.
  const other = [
    'Maria runs the shop next door.',
    'Who they are to him: a neighbour.',
    "What's open between you: the delivery.",
    'Last contact each way: 1 Nov.',
    'How he talks to them:',
    'short messages,',
    'one question at a time.',
  ].join('\n')
  assert.deepEqual(parseReadingNote(other), {
    blocks: {
      who: 'a neighbour.',
      open: 'the delivery.',
      contact: '1 Nov.',
      tone: 'short messages,\none question at a time.',
    },
    loose: 'Maria runs the shop next door.',
  })
  // Prose without a label stays whole, never put under a part it may not be.
  assert.deepEqual(parseReadingNote('She is a client.\nVery friendly.'), { blocks: {}, loose: 'She is a client.\nVery friendly.' })
  assert.deepEqual(parseReadingNote(''), { blocks: {}, loose: '' })
  assert.deepEqual(parseReadingNote(null), { blocks: {}, loose: '' })
  // Windows line endings and a label with no text still make their part.
  assert.deepEqual(parseReadingNote('Who:\r\nOpen: the order.\r\n'), { blocks: { who: '', open: 'the order.' }, loose: '' })
})

test('the person card draws the four parts, the read-through and the coverage together', () => {
  const view = personView({
    chat: { id: 'c1', name: 'Maria', channelId: 'wa' },
    note: { text: NOTE, readThrough: '2026-11-20T12:00:00Z', updatedAt: '2026-11-20T12:05:00Z' },
    coverage,
  })
  assert.equal(view.state, 'ready')
  assert.equal(view.title, 'Maria')
  assert.equal(view.subtitle, '')
  assert.deepEqual(view.blocks.map(block => block.label), ['Who they are to you', 'What is open', 'Last contact', 'How you talk'])
  assert.equal(view.blocks[0].text, 'a client of the user since March.')
  assert.equal(view.blocks[1].text, 'the order for Thursday.')
  // Last contact is the host's coverage first, the note's own line under it.
  assert.equal(view.blocks[2].text, 'From them Nov 20, 2026 · From you Aug 1, 2026\n1 Nov, about the order.')
  assert.equal(view.blocks[3].text, 'short and friendly.')
  assert.equal(view.readThrough, 'Nov 20, 2026')
  assert.deepEqual(view.coverage, coverage)
  // A part the note leaves out says so, rather than disappearing.
  const partial = personView({ chat: { id: 'c1', name: 'Maria' }, note: { text: 'Who: a client.', readThrough: '2026-11-20T12:00:00Z' } })
  assert.deepEqual(partial.blocks.map(block => block.text), ['a client.', '', '', ''])
  // No coverage: the note's own contact line still stands, and nothing invents one.
  const alone = personView({ chat: { id: 'c1', name: 'Maria' }, note: { text: NOTE, readThrough: '' } })
  assert.equal(alone.blocks[2].text, '1 Nov, about the order.')
  assert.equal(alone.readThrough, '')
  assert.equal(alone.coverage, undefined)
})

test('the person card before a note: the plain state, the coverage, and no invented parts', () => {
  const empty = personView({ chat: { id: 'c1', name: 'Maria' }, note: null, coverage })
  assert.equal(empty.state, 'empty')
  assert.equal(empty.title, 'Maria')
  assert.equal(empty.subtitle, 'Not read yet. Ask the bot to read this chat.')
  assert.deepEqual(empty.blocks, [])
  assert.deepEqual(empty.coverage, coverage)
  assert.equal(empty.readThrough, '')
  // A chat Omni can only name by id: no id is shown as a name.
  const nameless = personView({ chat: { id: 'c1' }, note: null, coverage: null })
  assert.equal(nameless.title, 'This chat')
  assert.equal(nameless.coverage, undefined)
  // A note written as prose is drawn whole, in one part.
  const prose = personView({ chat: { id: 'c1', name: 'Maria' }, note: { text: 'She is a client.\nVery friendly.' } })
  assert.deepEqual(prose.blocks.map(block => block.key), ['note'])
  assert.equal(prose.blocks[0].label, 'Reading note')
  assert.equal(prose.blocks[0].text, 'She is a client.\nVery friendly.')
  // An empty or missing answer is not a card pretending to hold a note.
  assert.equal(personView(null).state, 'empty')
  assert.equal(personView({ chat: { id: 'c1' }, note: { text: '   ' } }).state, 'empty')
  // A name with control characters, and a name longer than a title, are cleaned.
  assert.equal(personView({ chat: { id: 'c1', name: 'Ma\u0000ria\u202E' } }).title, 'Maria')
  assert.equal(personView({ chat: { id: 'c1', name: 'x'.repeat(400) } }).title.length, 120)
  // A note is cut at the size Omni keeps: a card never draws more than the note holds.
  const long = personView({ chat: { id: 'c1' }, note: { text: `Who: ${'x'.repeat(9000)}` } })
  assert.equal(long.blocks[0].text.length, 7995, 'the note is cut at 8,000 characters, its label included')
})

test('a row prints only what the kit knows, and a text field never reaches the card', () => {
  const view = rowView({
    chatId: 'c1',
    chat: 'Maria',
    state: 'reading',
    text: 'a private message',
    transcript: 'a voice note',
    messages: [{ text: 'x' }],
    page: '3',
    pages: 12,
  })
  assert.equal(view.name, 'Maria')
  assert.equal(view.page, 'Page 3 of about 12')
  assert.equal(JSON.stringify(view).includes('a private message'), false)
  assert.equal(rowView(null).name, '')
  assert.equal(rowView({}).word, '')
  assert.equal(rowView({ chat: 'A name over one hundred and twenty characters '.repeat(4) }).name.length, 120)
})
