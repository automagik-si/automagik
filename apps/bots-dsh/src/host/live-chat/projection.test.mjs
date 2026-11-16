// node --test chat/projection.test.mjs: one terminal as chat rows, read side, against the fake hc
// and temp homes (never a live Herdr).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { compareIds, Projection } from './projection.js'
import { StatusHub } from './status.js'
import { createFakeHc, fakeTerminal } from './fake-hc.mjs'

const noTimers = { setTimeout: () => ({}), clearTimeout: () => {}, setInterval: () => ({}), clearInterval: () => {} }
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)) }
const claudeLines = readFileSync(new URL('./fixtures/claude.jsonl', import.meta.url), 'utf8')
const user = (uuid, text) => JSON.stringify({ type: 'user', uuid, message: { role: 'user', content: text } }) + '\n'
const reply = (uuid, text) => JSON.stringify({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'

function setup({ terminals, screens, files } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'chat-proj-')))
  const write = (rel, text) => { const p = join(home, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); return p }
  const hc = createFakeHc({ terminals: terminals?.(home, write) ?? [], screens, files })
  const hub = new StatusHub(hc, { timers: noTimers })
  const events = []
  const make = (address, extra = {}) => {
    const p = new Projection(address, { hc, hub, home, timers: noTimers, watch: null, ...extra })
    p.on((e) => events.push(e))
    p.start()
    return p
  }
  return { home, write, hc, hub, events, make }
}

test('a labelled Claude pane: transcript rows at once, new lines as they are written', async () => {
  let path
  const { events, make } = setup({ terminals: (home, write) => {
    path = write('.claude/projects/p/s.jsonl', claudeLines)
    return [fakeTerminal('t1', { labels: { 'agent.transcript': path } })]
  } })
  const p = make('t1')
  await settle(); await p.ready
  assert.deepEqual(events.find((e) => e.type === 'source'), { type: 'source', source: 'label', agent: 'claude', reason: null })
  const rows = events.filter((e) => e.type === 'rows').flatMap((e) => e.rows)
  assert.equal(rows.length, 9)
  assert.equal(rows[0].text, 'List the files in src and fix the typo in main.js')
  assert.ok(!JSON.stringify(events).includes(path), 'no event carries the path')
  appendFileSync(path, user('u-9', 'and the README?'))
  await p.tail.tick()
  assert.deepEqual(events.at(-1).rows.map((r) => [r.id, r.turn, r.text]), [['1:13.0', 2, 'and the README?']])
  await p.stop()
})

test('status changes are relayed; a new agent.transcript label is a new session with a divider', async () => {
  let second
  const { hc, events, make } = setup({ terminals: (home, write) => {
    const first = write('.claude/projects/p/a.jsonl', user('a1', 'first'))
    second = write('.claude/projects/p/b.jsonl', user('b1', 'second'))
    return [fakeTerminal('t1', { labels: { 'agent.transcript': first } })]
  } })
  const p = make('t1')
  await settle(); await p.ready
  hc.change('t1', 'status', { status: { app: 'claude-code', state: 'working', msg: 'Thinking' }, reported: true, records: {} })
  assert.deepEqual(events.at(-1), { type: 'status', status: { state: 'working', kind: null, msg: 'Thinking', turn: 0, title: '', app: 'claude-code' } })
  hc.change('t1', 'labels', { labels: { 'agent.transcript': second } })
  await p.ready
  const rows = events.filter((e) => e.type === 'rows').flatMap((e) => e.rows)
  assert.deepEqual(rows.map((r) => [r.id, r.kind, r.state ?? r.text]), [['1:1.0', 'text', 'first'], ['2:0.0', 'status', 'new-session'], ['2:1.0', 'text', 'second']])
  await p.stop()
})

test('no transcript: the screen fills the chat; once the transcript covers the turn the screen rows go', async () => {
  const { hc, events, make, write } = setup({
    terminals: () => [fakeTerminal('t1', { cwd: '/home/u/proj', created: 1 })],
    screens: { t1: '❯ hello\n\nWorking on it…\n' }
  })
  const p = make('t1')
  await settle()
  assert.deepEqual(events.find((e) => e.type === 'source'), { type: 'source', source: 'none', agent: 'claude', reason: 'not-found' })
  await p.screenTick()
  assert.deepEqual(events.at(-1).rows.map((r) => [r.source, r.role, r.text]), [['screen', 'user', '❯ hello'], ['screen', 'assistant', 'Working on it…']])
  const path = write('.claude/projects/p/s.jsonl', user('u1', 'hello'))
  hc.change('t1', 'labels', { labels: { 'agent.transcript': path } })
  await p.ready
  await p.screenTick()
  appendFileSync(path, reply('a1', 'Hi!'))
  await p.tail.tick()
  assert.deepEqual(events.at(-1), { type: 'screen', rows: [] })
  assert.deepEqual(p.screen(), [])
  await p.stop()
})

test('a pane on another machine is tailed with file.read, on from its address, no cwd', async () => {
  const { hc, events, make } = setup({
    terminals: () => [fakeTerminal('box/t3', { labels: { 'agent.transcript': '/home/u/.claude/projects/p/s.jsonl' } })],
    files: { box: { '.claude/projects/p/s.jsonl': user('r1', 'remote hello') } }
  })
  const p = make('box/t3')
  await settle(); await p.ready
  assert.deepEqual(events.filter((e) => e.type === 'rows').flatMap((e) => e.rows).map((r) => r.text), ['remote hello'])
  const reads = hc.calls.filter((c) => c.method === 'file.read').map((c) => c.params)
  assert.ok(reads.length >= 1)
  for (const r of reads) {
    assert.equal(r.on, 'box')
    assert.equal(r.path, '.claude/projects/p/s.jsonl')
    assert.ok(!('cwd' in r))
  }
  await p.stop()
})

test('two panes in one folder: discovery never guesses, both are screen only', async () => {
  const { make, events } = setup({ terminals: (home, write) => {
    write(`.claude/projects/${join(home, 'proj').replace(/[^A-Za-z0-9]/g, '-')}/s.jsonl`, user('u', 'x'))
    return [fakeTerminal('t1', { cwd: join(home, 'proj'), created: 1 }), fakeTerminal('t2', { cwd: join(home, 'proj'), created: 1 })]
  } })
  const p = make('t1')
  await settle()
  assert.deepEqual(events.find((e) => e.type === 'source'), { type: 'source', source: 'none', agent: 'claude', reason: 'shared-folder' })
  await p.stop()
})

test('only the last rows are held; backfill reads older ones again with their turns', async () => {
  const lines = Array.from({ length: 6 }, (_, i) => (i % 2 ? reply(`a${i}`, `answer ${i}`) : user(`u${i}`, `question ${i}`))).join('')
  const { make } = setup({ terminals: (home, write) => [fakeTerminal('t1', { labels: { 'agent.transcript': write('.claude/projects/p/s.jsonl', lines) } })] })
  const p = make('t1', { keep: 2 })
  await settle(); await p.ready
  assert.deepEqual(p.rows().map((r) => r.text), ['question 4', 'answer 5'])
  assert.equal(p.rows('1:1.0'), null, 'a cursor no longer held')
  const older = await p.backfill('1:5.0', 3)
  assert.deepEqual(older.map((r) => [r.id, r.turn, r.text]), [['1:2.0', 1, 'answer 1'], ['1:3.0', 2, 'question 2'], ['1:4.0', 2, 'answer 3']])
  assert.deepEqual(await p.backfill('1:1.0', 5), [])
  assert.deepEqual(await p.backfill('nonsense', 5), [])
  await p.stop()
})

test('a terminal that ends, or herdr-core going away, is relayed', async () => {
  const { hc, hub, events, make } = setup({ terminals: () => [fakeTerminal('t1')] })
  const p = make('t1')
  await settle()
  hub.onMessage({ type: 'event', terminal: 't1', seq: 999, kind: 'removed', data: {} })
  assert.deepEqual(events.at(-1), { type: 'gone' })
  hc.drop()
  assert.deepEqual(events.at(-1), { type: 'offline' })
  await p.stop()
})

test('compareIds orders by segment, line, block', () => {
  assert.ok(compareIds('1:9.0', '1:10.0') < 0)
  assert.ok(compareIds('2:0.0', '1:99.9') > 0)
  assert.ok(compareIds('1:5.1', '1:5.0') > 0)
  assert.equal(compareIds('1:5.0', '1:5.0'), 0)
})

test('lines from a tail that is no longer the current one are ignored', async () => {
  let second
  const { hc, make } = setup({ terminals: (home, write) => {
    const first = write('.claude/projects/p/a.jsonl', user('a1', 'first'))
    second = write('.claude/projects/p/b.jsonl', user('b1', 'second'))
    return [fakeTerminal('t1', { labels: { 'agent.transcript': first } })]
  } })
  const p = make('t1')
  await settle(); await p.ready
  const old = p.tail
  hc.change('t1', 'labels', { labels: { 'agent.transcript': second } })
  await p.ready
  const held = p.rows().length
  p.onLines(old, 'claude', [{ n: 2, text: user('late', 'from the old file').trim() }])
  assert.equal(p.rows().length, held)
  assert.ok(!p.rows().some((r) => r.text === 'from the old file'))
  await p.stop()
})

test('the first read starts near the end; backfill before it gets exact turns, counted back', async () => {
  // 10 turns of question + answer: lines 1..20. A window of 4 lines holds turns 9 and 10.
  const lines = Array.from({ length: 20 }, (_, i) => (i % 2 ? reply(`a${i}`, `answer ${(i + 1) / 2}`) : user(`u${i}`, `question ${i / 2 + 1}`))).join('')
  const { make } = setup({ terminals: (home, write) => [fakeTerminal('t1', { labels: { 'agent.transcript': write('.claude/projects/p/s.jsonl', lines) } })] })
  const p = make('t1', { window: 4 })
  await settle(); await p.ready
  assert.deepEqual(p.rows().map((r) => [r.id, r.turn, r.text]), [['1:17.0', 1, 'question 9'], ['1:18.0', 1, 'answer 9'], ['1:19.0', 2, 'question 10'], ['1:20.0', 2, 'answer 10']])
  const older = await p.backfill('1:17.0', 4)
  assert.deepEqual(older.map((r) => [r.id, r.turn, r.text]), [['1:13.0', -1, 'question 7'], ['1:14.0', -1, 'answer 7'], ['1:15.0', 0, 'question 8'], ['1:16.0', 0, 'answer 8']])
  const oldest = await p.backfill('1:3.0', 2)
  assert.deepEqual(oldest.map((r) => [r.id, r.turn]), [['1:1.0', -7], ['1:2.0', -7]])
  await p.stop()
})
