// #1326 K1, G0: the shared gen-UI kit's host half, proved in the real plugin framework. A
// real Cordis Context carries bots-dsh's own inject list and the JSONL Session store a DSH
// profile supplies; the plugin provides `omniTeam`, and another plugin publishes into the
// kit exactly as Omni's channels plugin will. The live slice is fed from a fake Omni event
// source in Omni's own shapes (sync.* with a chatId, read_history's page header).
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as Bots from '../index.js'
import { GENUI_MEDIA_ROUTE } from '../src/host/constants.js'
import { GENUI_MAX_BATCHES, GENUI_MAX_ROWS, MEDIA_TYPES } from '../src/host/genui.js'
import { rowView } from '../src/client/genui-model.js'
import { omniSyncSource, pageHeader, readingOfHeader, rowOfEvent } from './fixtures/omni-sync-source.js'

const SessionPersistence = typeof Jsonl.apply === 'function' ? Jsonl : Jsonl.default

const TEAM = {
  version: 2,
  revision: 1,
  mainBotIds: ['m1'],
  bots: { m1: { id: 'm1', name: 'Omni', role: 'Orchestrator', sessionId: 'm1', createdAt: 1 } },
  agents: {},
  rooms: {},
  tasks: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

async function bench(t) {
  const home = mkdtempSync(join(tmpdir(), 'genui-host-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const routes = new Map()
  const host = new Context()
  t.after(async () => {
    await host.fiber.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  let rt
  let store
  await host.plugin({ name: 'genui-bench', apply: async group => {
    // The Session store is DSH's own JSONL persistence, in a temporary root, as a profile
    // supplies it. The kit keeps no store: its rows are the plugin's report, not a record.
    await group.plugin(Storage)
    await group.plugin(StorageJson, { root: join(home, 'storage') })
    await group.plugin(StorageDomain, { backend: 'json' })
    await group.plugin(SessionPersistence, { root: join(home, 'sessions') })
    await group.plugin({ name: 'genui-services', apply: ctx => {
      const services = {
        llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
        tools: { register: () => () => {}, guard: () => () => {}, schemas: () => [] },
        systemPrompt: { context: () => () => {}, section: () => () => {} },
        sessionController: {
          resolveAgent: async id => ({ agent: { id, session: { id }, followup() {} } }),
          selectModel: async () => {},
        },
        sessions: { get: () => undefined, list: () => [], flush: async () => {} },
        sessionTitle: { rename: async () => {} },
        workspaceRegistry: {
          get: () => undefined,
          resolveByPath: async () => undefined,
          create: async path => ({ id: 'sample-workspace', path }),
          archiveSession: async () => {},
        },
        connection: { fetch: { register: ({ path, fetch }) => {
          routes.set(path, fetch)
          return () => routes.delete(path)
        } } },
      }
      for (const name of Bots.inject) {
        ctx.provide(name)
        ctx.set(name, services[name])
      }
    } })
    await group.plugin({ name: 'genui-store-reader', inject: ['sessionPersistence'], apply: ctx => { store = ctx.sessionPersistence } })
    await group.plugin(Bots, { home, mainName: 'Omni' })
    rt = group.get('omniTeam')
  } })
  assert.ok(rt, 'the Bot plugin applied')
  assert.ok(store, 'the JSONL store sibling applied')
  // The Bot's own Session in the real store, as a profile's host has it.
  const handle = await store.create({ version: 4, id: 'm1', createdAt: 1, isSeeded: false })
  await handle.flush()
  await handle.close()
  assert.equal((await store.stat('m1')).header.id, 'm1')
  const call = async (endpoint, payload = {}) => {
    const fetch = routes.get('/api/omni-ui')
    assert.ok(fetch, 'the /api/omni-ui route is registered')
    const response = await fetch(new Request('http://localhost/api/omni-ui', {
      method: 'POST',
      body: JSON.stringify({ endpoint, payload }),
    }))
    return response.json()
  }
  const state = async (payload = {}) => {
    const answer = await call('state', payload)
    assert.equal(answer.ok, true, JSON.stringify(answer))
    return answer.value
  }
  const media = async (query) => {
    const fetch = routes.get(GENUI_MEDIA_ROUTE)
    assert.ok(fetch, 'the media route is registered')
    return fetch(new Request(`http://localhost${GENUI_MEDIA_ROUTE}?${query}`))
  }
  return { rt, routes, call, state, media, home, store }
}

test('the live slice rides every state answer, and a row is rebuilt from labels and counts only', async t => {
  const { rt, state } = await bench(t)
  assert.deepEqual((await state()).genui, { revision: 0, batches: {} }, 'an empty kit, still in the answer')
  assert.equal(rt.hooks.genui.publish('batch-1', {
    chatId: 'chat-1',
    chat: 'Ana',
    state: 'reading',
    page: 3,
    pages: 12,
    // Message text a careless caller passed: the slice keeps none of it.
    text: 'the order for Thursday',
    transcript: 'voice note text',
    messages: [{ text: 'x' }],
    counts: { fetched: 4180, total: 4400, mediaDownloaded: 38, mediaMissing: 2, reactions: 5, edits: 2 },
    coverage: { oldest: '2026-03-02T10:00:00Z', newest: '2026-11-01T08:00:00Z', count: 4400, deletedCount: 3, lastInbound: '2026-11-01T08:00:00Z', lastOutbound: '2026-08-01T09:00:00Z' },
  }), true)
  const genui = (await state()).genui
  assert.deepEqual(genui, {
    revision: 1,
    batches: { 'batch-1': { updatedAt: genui.batches['batch-1'].updatedAt, rows: [{
      chatId: 'chat-1',
      chat: 'Ana',
      state: 'reading',
      page: 3,
      pages: 12,
      counts: { fetched: 4180, total: 4400, mediaDownloaded: 38, mediaMissing: 2, reactions: 5, edits: 2 },
      coverage: {
        oldest: '2026-03-02T10:00:00.000Z',
        newest: '2026-11-01T08:00:00.000Z',
        lastInbound: '2026-11-01T08:00:00.000Z',
        lastOutbound: '2026-08-01T09:00:00.000Z',
        count: 4400,
        deletedCount: 3,
      },
    }] } },
  })
  assert.equal(typeof genui.batches['batch-1'].updatedAt, 'number')
  assert.ok(Number.isFinite(genui.batches['batch-1'].updatedAt))
  assert.equal(JSON.stringify(genui).includes('the order for Thursday'), false)
  assert.equal(JSON.stringify(genui).includes('voice note text'), false)
  // A republish merges by chat id; the newest value wins and the revision goes up once.
  assert.equal(rt.hooks.genui.publish('batch-1', { chatId: 'chat-1', state: 'done', outcome: 'done' }), true)
  const merged = rt.hooks.genui.read('batch-1').rows
  assert.equal(merged.length, 1)
  assert.equal(merged[0].state, 'done')
  assert.equal(merged[0].page, 3, 'a later row keeps what it does not say again')
  assert.equal((await state()).genui.revision, 2)
  // Clearing a batch (a proposal no longer open) takes it out and bumps the revision.
  assert.equal(rt.hooks.genui.clear('batch-1'), true)
  assert.deepEqual((await state()).genui, { revision: 3, batches: {} })
  assert.equal(rt.hooks.genui.clear('batch-1'), false)
})

test('a real-shaped Omni stream feeds one batch: sync events with a chatId, and read_history\'s page header', async t => {
  const { rt, state } = await bench(t)
  const source = omniSyncSource()
  // What Omni's channels plugin will do with each event: fold it into one row, publish it.
  for (const type of ['sync.progress', 'sync.completed', 'sync.failed', 'sync.cancelled']) {
    source.on(type, payload => rt.hooks.genui.publish('run-1', rowOfEvent(type, payload)))
  }
  source.on('read.page', header => {
    const reading = readingOfHeader(header)
    assert.ok(reading, 'the page header parsed')
    rt.hooks.genui.publish('run-1', {
      chatId: reading.chatId, chat: reading.chat, state: 'reading',
      page: reading.page, pages: reading.pages, coverage: reading.coverage,
    })
  })
  // Omni's job service publishes exactly this on each progress tick of a per-chat backfill.
  source.fire('sync.progress', {
    jobId: 'job-1', instanceId: 'inst-1', type: 'messages', chatId: 'chat-1',
    progress: {
      state: 'fetching', fetched: 4180, stored: 4180, duplicates: 12, mediaDownloaded: 38,
      mediaMissing: 2, reactionsApplied: 5, editsApplied: 2, deletionsApplied: 1, unmatched: 0,
      totalEstimated: 4400, oldestReached: '2026-03-02T10:00:00.000Z',
    },
  })
  let row = rt.hooks.genui.read('run-1').rows[0]
  assert.deepEqual(row.counts, { fetched: 4180, total: 4400, stored: 4180, duplicates: 12, mediaDownloaded: 38, mediaMissing: 2, reactions: 5, edits: 2, deletions: 1, unmatched: 0 })
  assert.equal(row.state, 'fetching')
  assert.equal(row.oldestReached, '2026-03-02T10:00:00.000Z')
  // read_history's first page of that same chat: the page numbers and the coverage.
  source.fire('read.page', pageHeader({
    chat: 'Ana', id: 'chat-1', page: 3, pages: 12, count: 4400,
    oldest: '2026-03-02T10:00:00Z', newest: '2026-11-01T08:00:00Z',
    deleted: 3, missing: 2, inbound: '2026-11-01T08:00:00Z', outbound: '2026-08-01T09:00:00Z',
  }))
  row = rt.hooks.genui.read('run-1').rows[0]
  assert.equal(row.page, 3)
  assert.equal(row.pages, 12)
  assert.deepEqual(row.coverage, {
    count: 4400,
    countInWindow: 50,
    deletedCount: 3,
    mediaMissing: 2,
    oldest: '2026-03-02T10:00:00.000Z',
    newest: '2026-11-01T08:00:00.000Z',
    lastInbound: '2026-11-01T08:00:00.000Z',
    lastOutbound: '2026-08-01T09:00:00.000Z',
  })
  // The same row, as the card's own model draws it.
  const view = rowView(row)
  assert.equal(view.name, 'Ana')
  assert.equal(view.word, 'Reading', 'the page read is the row\'s latest activity')
  assert.equal(view.page, 'Page 3 of about 12')
  assert.equal(view.progress, '4,180 of 4,400 · 95%')
  assert.equal(view.media, '38 photos, 2 missing')
  assert.equal(view.marks, '5 reactions · 2 edits')
  assert.equal(view.span, 'Mar–Nov')
  // Omni completes the job, then a second chat fails and a third is cancelled.
  source.fire('sync.completed', { jobId: 'job-1', instanceId: 'inst-1', type: 'messages', chatId: 'chat-1', progress: { state: 'done', outcome: 'done', fetched: 4400, stored: 4400, duplicates: 12, mediaDownloaded: 40, mediaMissing: 2 } })
  source.fire('sync.progress', { jobId: 'job-2', instanceId: 'inst-1', type: 'messages', chatId: 'chat-2', progress: { state: 'fetching', fetched: 10, totalEstimated: 900 } })
  source.fire('sync.failed', { jobId: 'job-2', instanceId: 'inst-1', type: 'messages', chatId: 'chat-2', progress: { state: 'failed', outcome: 'The phone did not answer' } })
  source.fire('sync.cancelled', { jobId: 'job-3', instanceId: 'inst-1', type: 'messages', chatId: 'chat-3', progress: { state: 'cancelled', outcome: 'Cancelled by person' } })
  const rows = (await state()).genui.batches['run-1'].rows
  assert.deepEqual(rows.map(entry => [entry.chatId, entry.state, entry.outcome]), [
    ['chat-1', 'done', 'done'],
    ['chat-2', 'failed', 'failed'],
    ['chat-3', 'cancelled', 'stopped'],
  ])
  assert.equal(rowView(rows[0]).word, 'Done')
  assert.equal(rowView(rows[1]).word, 'Failed')
  assert.equal(rowView(rows[2]).word, 'Stopped')
})

test('the slice keeps its cap: twenty rows a batch, a finished row leaving first, and eight batches', async t => {
  const { rt, state } = await bench(t)
  // The first five finish; the rest still run. Over the cap, the finished ones leave first.
  for (let index = 1; index <= 25; index += 1) {
    const finished = index <= 5
    rt.hooks.genui.publish('wide', { chatId: `chat-${index}`, chat: `Chat ${index}`, state: finished ? 'done' : 'fetching' })
  }
  const rows = rt.hooks.genui.read('wide').rows
  assert.equal(rows.length, GENUI_MAX_ROWS)
  assert.equal(rows.some(row => row.state === 'done'), false, 'finished rows leave first')
  assert.equal(rows[0].chatId, 'chat-6')
  assert.equal(rows.at(-1).chatId, 'chat-25')
  // Nine more batches: the slice keeps the newest eight.
  for (let index = 2; index <= 10; index += 1) rt.hooks.genui.publish(`batch-${index}`, { chatId: 'chat-1' })
  const batches = Object.keys((await state()).genui.batches)
  assert.equal(batches.length, GENUI_MAX_BATCHES)
  assert.deepEqual(batches, ['batch-3', 'batch-4', 'batch-5', 'batch-6', 'batch-7', 'batch-8', 'batch-9', 'batch-10'])
})

test('a row is only what the kit knows: labels cut, control characters gone, known states and counts', async t => {
  const { rt } = await bench(t)
  const name = `A${'na'.repeat(80)}`
  rt.hooks.genui.publish('shapes', {
    chatId: 'chat-1',
    chat: `${name}\u0000\u202E\u0007 ok`,
    state: 'somewhere-new',
    outcome: 'not-a-real-outcome',
    page: -3,
    pages: 1.9,
    counts: { fetched: -1, total: 4400.9, mediaDownloaded: '7', mediaMissing: 2, reactionsApplied: 3, unknown: 9 },
    coverage: { oldest: 'not a date', newest: '2026-11-01T08:00:00Z', count: '12', mystery: 1 },
    startedAt: '2026-11-01T08:00:00Z',
    updatedAt: 'yesterday',
  })
  const row = rt.hooks.genui.read('shapes').rows[0]
  assert.equal(row.chat.length, 120)
  assert.equal(row.chat.includes('\u0000'), false)
  assert.equal(row.chat.includes('\u202E'), false)
  assert.equal(row.state, undefined, 'an unknown state is left out, never shown as text')
  assert.equal(row.outcome, undefined)
  assert.equal(row.page, undefined)
  assert.equal(row.pages, 1)
  assert.deepEqual(row.counts, { total: 4400, mediaDownloaded: 7, mediaMissing: 2 })
  assert.deepEqual(row.coverage, { newest: '2026-11-01T08:00:00.000Z', count: 12 })
  assert.equal(row.startedAt, '2026-11-01T08:00:00.000Z')
  assert.equal(row.updatedAt, undefined)
  // A row without a chat id, and a batch id that is not one, publish nothing.
  assert.equal(rt.hooks.genui.publish('shapes', { chat: 'Nobody', state: 'done' }), false)
  assert.equal(rt.hooks.genui.publish('bad id!', { chatId: 'chat-1' }), false)
  assert.equal(rt.hooks.genui.publish('shapes', null), false)
  assert.equal(rt.hooks.genui.read('bad id!'), undefined)
})

test('a partial count update keeps the counts it does not repeat, the total included', async t => {
  const { rt } = await bench(t)
  // A backfill reports cumulative counters, but a row may publish only what changed.
  rt.hooks.genui.publish('partial', {
    chatId: 'chat-1', chat: 'Ana', state: 'fetching',
    counts: { fetched: 10, total: 20, reactions: 3, mediaDownloaded: 2 },
  })
  rt.hooks.genui.publish('partial', { chatId: 'chat-1', counts: { fetched: 12 } })
  assert.deepEqual(rt.hooks.genui.read('partial').rows[0].counts,
    { fetched: 12, total: 20, reactions: 3, mediaDownloaded: 2 },
    'a count the update does not name keeps what the row already said')
  // The same contract for a coverage update: only the named field changes.
  rt.hooks.genui.publish('partial', { chatId: 'chat-1', coverage: { count: 20, deletedCount: 3 } })
  rt.hooks.genui.publish('partial', { chatId: 'chat-1', coverage: { count: 21 } })
  assert.deepEqual(rt.hooks.genui.read('partial').rows[0].coverage, { count: 21, deletedCount: 3 })
  // A null clears what an earlier publish set, rather than keeping it.
  rt.hooks.genui.publish('partial', { chatId: 'chat-1', coverage: null })
  assert.equal(rt.hooks.genui.read('partial').rows[0].coverage, undefined)
})

test('an explicit null outcome clears a finished status, so a resumed row reads by its state', async t => {
  const { rt } = await bench(t)
  // A cancelled row that stopped: its word is Stopped, its dot the stopped one.
  rt.hooks.genui.publish('partial', { chatId: 'chat-1', chat: 'Ana', state: 'cancelled', outcome: 'stopped' })
  let view = rowView(rt.hooks.genui.read('partial').rows[0])
  assert.equal(view.word, 'Stopped')
  assert.equal(view.state, 'stopped')
  // The row is read again: outcome:null is the plugin saying the end is over, not a state.
  rt.hooks.genui.publish('partial', { chatId: 'chat-1', state: 'reading', outcome: null })
  let row = rt.hooks.genui.read('partial').rows[0]
  assert.equal(row.outcome, undefined, 'an explicit null outcome clears the one before')
  view = rowView(row)
  assert.equal(view.word, 'Reading')
  assert.equal(view.state, 'work', 'a running row never wears a finished dot')
  // A done outcome is cleared the same way, without leaving Reading beside a done dot.
  rt.hooks.genui.publish('partial', { chatId: 'chat-1', state: 'done', outcome: 'done' })
  rt.hooks.genui.publish('partial', { chatId: 'chat-1', state: 'reading', outcome: null })
  row = rt.hooks.genui.read('partial').rows[0]
  assert.equal(row.outcome, undefined)
  assert.equal(rowView(row).word, 'Reading')
  assert.equal(rowView(row).state, 'work')
})

test('the media route serves a registered source\'s bytes and refuses a page, an unknown source and a failure', async t => {
  const { rt, media } = await bench(t)
  const bytes = new Uint8Array([137, 80, 78, 71])
  const off = rt.hooks.media.register('photo', async (id) => (id === 'photo-1' ? { type: 'image/png', body: bytes } : null))
  const response = await media('source=photo&id=photo-1')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.equal(response.headers.get('content-length'), '4')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.match(response.headers.get('cache-control') ?? '', /private/)
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes)
  assert.equal((await media('source=photo&id=other')).status, 404)
  assert.equal((await media('source=unknown&id=photo-1')).status, 404)
  assert.equal((await media('source=photo&id=')).status, 404)
  assert.equal((await media(`source=photo&id=${'x'.repeat(301)}`)).status, 404)
  // Only the media types a card draws: a source cannot serve a page or a script through it.
  rt.hooks.media.register('page', () => ({ type: 'text/html', body: '<script>alert(1)</script>' }))
  assert.equal((await media('source=page&id=x')).status, 404)
  rt.hooks.media.register('svg', () => ({ type: 'image/svg+xml', body: '<svg/>' }))
  assert.equal((await media('source=svg&id=x')).status, 404)
  // A source's own error can name a path: the answer is empty, never its message.
  rt.hooks.media.register('broken', () => { throw new Error('/home/someone/secret.png') })
  const broken = await media('source=broken&id=x')
  assert.equal(broken.status, 500)
  assert.equal(await broken.text(), '')
  // Names are names; one source is served once, and its disposer takes it away.
  assert.throws(() => rt.hooks.media.register('Bad Name', () => null))
  assert.throws(() => rt.hooks.media.register('photo', () => null))
  assert.throws(() => rt.hooks.media.register('empty'))
  off()
  assert.equal((await media('source=photo&id=photo-1')).status, 404)
  assert.ok(MEDIA_TYPES.every(type => /^(?:image|audio)\//.test(type)))
})
