// #1326 K2: the interactive backfill card's words. A proposal says which chats and which
// dates it would read, and pre-ticks only the chats the Bot named; a run says how each chat
// moves and which rows can still be stopped. Labels and counts only: a message preview the
// Omni plugin happened to pass is rebuilt away, never drawn.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  backfillDay, backfillRange, backfillSummaryText, backfillView, canCancel, proposalView, runView,
} from '../src/client/genui-model.js'

const FROM = '2026-03-01T00:00:00.000Z'
const TO = '2026-11-15T23:59:59.999Z'
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
const PROPOSAL = {
  id: 'p1',
  botId: 'm1',
  from: FROM,
  to: TO,
  createdAt: 1_763_500_000_000,
  preview: 'the last thing someone wrote',
  chats: [
    { id: 'c1', name: 'Ana', kind: 'dm', channelId: 'inst-1', channel: 'Shop line', ticked: true, preview: 'private' },
    { id: 'c2', name: 'Bruno', kind: 'group', channelId: 'inst-1', channel: 'Shop line', ticked: false },
    // A chat Omni can only name by id, and a name far past the label cap.
    { id: 'c3', channelId: 'inst-1' },
    { id: 'c4', name: 'x'.repeat(300), ticked: true },
    // A chat with no id names nothing to tick: left out.
    { name: 'No id' },
  ],
}

test('a proposal says the chats and the range it would read, and pre-ticks only what the Bot named', () => {
  const view = proposalView(PROPOSAL)
  assert.equal(view.id, 'p1')
  assert.equal(view.botId, 'm1')
  assert.equal(view.range, 'Mar 1, 2026 – Nov 15, 2026')
  assert.equal(view.from, '2026-03-01')
  assert.equal(view.to, '2026-11-15')
  assert.deepEqual(view.chats.map(chat => [chat.id, chat.name, chat.ticked]),
    [['c1', 'Ana', true], ['c2', 'Bruno', false], ['c3', 'Unnamed chat', false], ['c4', 'x'.repeat(120), true]])
  assert.deepEqual(view.ticked, ['c1', 'c4'])
  assert.equal(view.count, 4)
  // A channel and a kind are labels; a preview is neither.
  assert.equal(view.chats[0].channel, 'Shop line')
  assert.equal(view.chats[1].kind, 'group')
  assert.equal(JSON.stringify(view).includes('private'), false)
  assert.equal(JSON.stringify(view).includes('the last thing someone wrote'), false)
  // The whole history, when the Bot gave no dates, and one end of it.
  assert.equal(proposalView({ id: 'p2', chats: [] }).range, 'All available history')
  assert.equal(proposalView({ id: 'p2', from: FROM, chats: [] }).range, 'From Mar 1, 2026')
  assert.equal(proposalView({ id: 'p2', to: TO, chats: [] }).range, 'Through Nov 15, 2026')
  assert.equal(proposalView({ id: 'p2', chats: [] }).count, 0)
  // A proposal with no id is not a card.
  assert.equal(proposalView({ chats: [] }), undefined)
  assert.equal(proposalView(null), undefined)
  assert.equal(proposalView({ id: 'p2', chats: 'nope' }).count, 0)
})

test('one approval: the day a date input carries is the UTC day the host reads', () => {
  assert.equal(backfillDay(FROM), '2026-03-01')
  assert.equal(backfillDay(TO), '2026-11-15')
  assert.equal(backfillDay(1_795_003_200_000), '2026-11-18')
  assert.equal(backfillDay('2026-03-01'), '2026-03-01')
  assert.equal(backfillDay('not a date'), '')
  assert.equal(backfillDay(null), '')
  assert.equal(backfillRange(FROM, TO), 'Mar 1, 2026 – Nov 15, 2026')
  assert.equal(backfillRange(FROM, FROM), 'Mar 1, 2026')
  assert.equal(backfillRange(null, null), 'All available history')
})

test('a run says its range and how its chats move, and only a live job can be stopped', () => {
  const rows = [
    { chatId: 'c1', chat: 'Ana', jobId: 'j1', state: 'fetching', outcome: null, round: 1, counts: { fetched: 50, stored: 40, duplicates: 10, mediaDownloaded: 5, mediaMissing: 1, reactions: 2, edits: 1, deletions: 1, unmatched: 0 } },
    { chatId: 'c2', chat: 'Bruno', jobId: 'j2', state: 'done', outcome: 'done', counts: { fetched: 80, stored: 80 }, coverage },
    { chatId: 'c3', chat: 'Carla', jobId: 'j3', state: 'failed', outcome: 'failed' },
    { chatId: 'c4', chat: 'Davi', jobId: 'j4', state: 'cancelled', outcome: 'stopped' },
    { chatId: 'c5', chat: 'Eva', jobId: null, state: 'failed', outcome: 'not-started' },
  ]
  const view = runView({
    id: 'r1', botId: 'm1', from: FROM, to: TO, startedAt: 1_795_003_201_000,
    summary: { total: 5, running: 1, done: 1, phoneDidNotAnswer: 0, stopped: 1, failed: 2 },
    rows,
    text: 'the last thing someone wrote',
  })
  assert.equal(view.id, 'r1')
  assert.equal(view.range, 'Mar 1, 2026 – Nov 15, 2026')
  assert.equal(view.started, 'Nov 18, 2026')
  assert.equal(view.total, 5)
  assert.equal(view.summary, '1 running · 1 done · 1 stopped · 2 failed')
  assert.deepEqual(view.rows.map(row => [row.name, row.word, row.cancelable]),
    [['Ana', 'Fetching', true], ['Bruno', 'Done', false], ['Carla', 'Failed', false], ['Davi', 'Stopped', false], ['Eva', 'Not started', false]])
  // The counts move: a fetched count with no total is still a count, and the coverage
  // comes only once a row ends.
  assert.equal(view.rows[0].progress, '50 fetched')
  assert.equal(view.rows[0].media, '5 photos, 1 missing')
  assert.equal(view.rows[0].marks, '2 reactions · 1 edits')
  assert.equal(view.rows[0].span, '')
  assert.equal(view.rows[1].span, 'Mar–Nov')
  assert.equal(JSON.stringify(view).includes('the last thing someone wrote'), false)
  // Only a job id and an explicit null outcome can still stop: a done or unknown row cannot.
  assert.equal(canCancel(rows[0]), true)
  for (const row of rows.slice(1)) assert.equal(canCancel(row), false, JSON.stringify(row))
  assert.equal(canCancel({ jobId: 'j', outcome: undefined }), false)
  assert.equal(canCancel({ jobId: null, outcome: null }), false)
  assert.equal(canCancel(null), false)
  // A run with no summary is read from its rows.
  assert.equal(runView({ id: 'r2', rows }).summary, '1 running · 1 done · 1 stopped · 2 failed')
  // A warning while the job finishes its coverage still counts as running.
  assert.equal(backfillSummaryText(undefined, [{ outcome: null }]), '1 running')
  // A run with no id is not a card.
  assert.equal(runView({ rows }), undefined)
})

test('the card reads the roster: newest runs first, capped, with the earlier ones counted', () => {
  const runs = Array.from({ length: 5 }, (_, index) => ({
    id: `r${index}`, from: FROM, to: TO, startedAt: 1_795_003_201_000,
    rows: [{ chatId: `c${index}`, chat: `C${index}`, jobId: `j${index}`, state: 'queued', outcome: null, counts: {} }],
  }))
  const roster = { omniBackfillProposals: [PROPOSAL], omniBackfills: runs, other: 1 }
  const view = backfillView(roster)
  assert.deepEqual(view.proposals.map(proposal => proposal.id), ['p1'])
  assert.deepEqual(view.runs.map(run => run.id), ['r0', 'r1', 'r2'])
  assert.equal(view.moreRuns, 2)
  // Many chats on one run: the card draws the first twenty and says how many more.
  const many = { id: 'r1', rows: Array.from({ length: 25 }, (_, index) => ({ chatId: `c${index}`, chat: `C${index}`, jobId: `j${index}`, state: 'queued', outcome: null })) }
  assert.equal(runView(many).rows.length, 20)
  assert.equal(runView(many).more, 5)
  // Absent, empty or malformed roster fields are no card, never a crash.
  assert.deepEqual(backfillView({}), { proposals: [], runs: [], moreRuns: 0 })
  assert.deepEqual(backfillView(null), { proposals: [], runs: [], moreRuns: 0 })
  assert.deepEqual(backfillView({ omniBackfillProposals: null, omniBackfills: 'nope' }), { proposals: [], runs: [], moreRuns: 0 })
  // A proposal or a run that fails its own shape is left out, not drawn half.
  const dropped = backfillView({ omniBackfillProposals: [{ chats: [] }, PROPOSAL], omniBackfills: [{ rows: [] }, runs[0]] })
  assert.deepEqual(dropped.proposals.map(proposal => proposal.id), ['p1'])
  assert.deepEqual(dropped.runs.map(run => run.id), ['r0'])
})
