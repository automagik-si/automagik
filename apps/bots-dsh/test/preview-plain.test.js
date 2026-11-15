// The sidebar's one-line previews show a message's words, not its markdown source (#1155):
// a Bot's row (the client's previewOf) and a group's row (the host's `preview`) both read the
// last message through shared/plain-text.js.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { PREVIEW_SOURCE, plainText, previewText } from '../src/shared/plain-text.js'
import { previewOf } from '../src/client/text.js'

const reads = (cases) => { for (const [markdown, plain] of cases) assert.equal(plainText(markdown), plain, JSON.stringify(markdown)) }

test('bold, italics and struck text lose their marks and keep their words', () => {
  reads([
    ['Yes. **CSV export** is in.', 'Yes. CSV export is in.'],
    ['__bold__ and *italic* and _italic_', 'bold and italic and italic'],
    ['***both*** and **a *b* c**', 'both and a b c'],
    ['~~gone~~ stays readable', 'gone stays readable'],
    ['**two\nlines**', 'two\nlines'],
  ])
})

test('what only looks like emphasis is left alone', () => {
  reads([
    ['snake_case_name and my__init__py', 'snake_case_name and my__init__py'],
    ['2 * 3 * 4 and a * b', '2 * 3 * 4 and a * b'],
    ['a_b*c', 'a_b*c'],
    ['**unclosed and *also', '**unclosed and *also'],
    ['\\*not italic\\* and \\_nor this\\_', '*not italic* and _nor this_'],
    ['5 ** 2 is 25', '5 ** 2 is 25'],
  ])
})

test('code keeps its text and loses its ticks and fences; nothing in it is read as a mark', () => {
  reads([
    ['run `npm run export` now', 'run npm run export now'],
    ['`a*b*c` and `_x_`', 'a*b*c and _x_'],
    ['``tick ` inside``', 'tick ` inside'],
    ['```js\nconst a = b * c * d\n```\nafter', 'const a = b * c * d\nafter'],
    ['~~~\n**kept**\n~~~', '**kept**'],
    ['```\nnever closed **x**', 'never closed **x**'],
  ])
})

test('a link or an image shows its label, and a bare address stays whole', () => {
  reads([
    ['press *Export* on [the orders report](https://example.com/orders).', 'press Export on the orders report.'],
    ['[a `code` label](https://example.com/a_(b) "title") and [ref][1]', 'a code label and ref'],
    ['![a chart](https://example.com/c.png)', 'a chart'],
    ['see https://example.com/a_b_c/*x* and <https://example.com/_y_>', 'see https://example.com/a_b_c/*x* and https://example.com/_y_'],
    ['[x] is not a link and [neither] is this', '[x] is not a link and [neither] is this'],
  ])
})

test('headings, quotes, bullets, task boxes and rules lose their line marks', () => {
  reads([
    ['## Report\n\n**Done.**', 'Report\n\nDone.'],
    ['# Title #\nbody', 'Title\nbody'],
    ['Title\n===\nbody', 'Title\n\nbody'],
    ['> quoted *text*\n>> deeper', 'quoted text\ndeeper'],
    ['- one\n* two\n+ three', 'one\ntwo\nthree'],
    ['- [x] done\n- [ ] open\n1. [x] first', 'done\nopen\n1. first'],
    ['1. first\n2) second', '1. first\n2) second'],
    ['above\n\n---\n* * *\nbelow', 'above\n\n\n\nbelow'],
    ['#hashtag and -5 degrees and +1', '#hashtag and -5 degrees and +1'],
  ])
})

test('what is not text reads as nothing, and the placeholder characters never leak', () => {
  for (const value of [undefined, null, 42, {}, '']) assert.equal(plainText(value), '')
  assert.equal(plainText('a 0 `b`'), 'a 0 b')
  assert.equal(plainText('https://example.com/a\\_b'), 'https://example.com/a_b')
})

test('a preview is the start of the message on one line', () => {
  assert.equal(previewText('## Report\n\n**Done.**   `wish/csv` adds\ta CSV export.\n\n- `src/csv.js`'), 'Report Done. wish/csv adds a CSV export. src/csv.js')
  assert.equal(previewText('  \n '), '')
  assert.equal(previewText(undefined), '')
  // Only the start is read: a mark closed past it stays as it is, far beyond what a row shows.
  const long = `${'word '.repeat(PREVIEW_SOURCE / 5 - 1)}**cut${' more'.repeat(40)}**`
  assert.ok(previewText(long).length <= PREVIEW_SOURCE)
  assert.ok(previewText(long).endsWith('**cut'))
})

const sessions = outline => ({ byId: {}, projectionsBySession: { s1: { values: { turnOutline: outline } } } })

test('a Bot row previews the last reply without its markdown marks', () => {
  const list = sessions([
    { turn: 1, prompt: 'Can the orders report export a spreadsheet?', response: 'Yes. **CSV export** is in: run `npm run export`, or press *Export* on [the orders report](https://example.com/orders).' },
  ])
  assert.equal(previewOf(list, 's1'), 'Yes. CSV export is in: run npm run export, or press Export on the orders report.')
})

test('a Bot row previews the person\'s own last message the same way, and skips hidden turns', () => {
  const list = sessions([
    { turn: 1, prompt: 'first', response: '## Plan\n\n1. **Draft**\n2. _Review_' },
    { turn: 2, prompt: 'Use `toCsv` and **quote** commas', response: '' },
    { turn: 3, prompt: 'a Bot wrote this', response: '**hidden**' },
  ])
  assert.equal(previewOf(list, 's1', [3]), 'Use toCsv and quote commas')
  assert.equal(previewOf(list, 's1', [2, 3]), 'Plan 1. Draft 2. Review')
  assert.equal(previewOf(sessions(undefined), 's1'), '')
})

// The host's state answer: a group's `preview` is its last message, as the row shows it.
const seed = log => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Omni', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Coder', role: 'Engineer', sessionId: 'b', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Launch', members: ['a', 'b'], mode: 'everyone', named: true, sessions: {}, log, seq: log.length, seen: {} } },
  agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
})

async function preview(t, log) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-preview-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed(log)))
  const ctx = fakeContext()
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, inbox: { nextStep: [], nextTurn: [], remove: () => false }, followup() {}, steer() {}, cancel() {} } }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  apply(ctx, { home })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await ctx.registeredTools.get('list_bots').execute({}, { agent: { id: 'a' } })
  const answer = await (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint: 'state', payload: {} }) }))).json()
  assert.equal(answer.ok, true)
  return answer.value.rooms.find(room => room.id === 'r1').preview
}

test('a group row previews a member\'s last message without its markdown marks', async (t) => {
  assert.equal(await preview(t, [
    { who: 'User', text: 'Who is on which part?', time: 1 },
    { who: 'Coder', text: 'Mine is `toCsv` and its *tests*:\nsee [the branch](https://example.com/branch).', time: 2 },
  ]), 'Coder：Mine is toCsv and its tests: see the branch.')
})

test('a group row previews the person\'s own message plain, and a heading does not show its marks', async (t) => {
  assert.equal(await preview(t, [{ who: 'User', text: '## Launch\n\n**Friday**, not _Thursday_', time: 1 }]), 'Launch Friday, not Thursday')
})

test('a group whose last message has no words left has no preview, and system lines are not messages', async (t) => {
  assert.equal(await preview(t, [{ who: 'Coder', text: '![](https://example.com/chart.png)', time: 1 }]), undefined)
  assert.equal(await preview(t, [{ who: 'Coder', text: '**shipped**', time: 1 }, { kind: 'joined', who: 'Omni', text: '**not a message**', time: 2 }]), 'Coder：shipped')
})
