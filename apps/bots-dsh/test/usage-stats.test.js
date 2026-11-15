import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeUsage, summarizeUsage, buildUsageStats, buildUsageStatsIterated } from '../src/shared/usage-stats.js'
import { foldCalls, install } from '../src/host/usage.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const sample = (key, extra = {}) => ({ key, session: 's', requestId: 'r', turnId: 't', attemptId: key, retryOrdinal: 0, provider: 'p', model: 'm', kind: 'turn', time: 1, input: 2, output: 1, cacheRead: 0, cacheWrite: 0, ...extra })

test('scoped SQLite aggregates never materialize unrelated or full owner history and retain complete distinct totals', async t => {
  const { rt, home } = await fixture(t)
  await rt.usageView() // initialize only the derived database before instrumentation
  const db = new DatabaseSync(join(home, 'usage.sqlite'))
  const put = db.prepare('INSERT INTO calls VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const detail = db.prepare('INSERT INTO usage_details (key,session_id,request_id,turn_id,attempt_id,retry_ordinal,source_seq,input,output,cache_read,cache_write,total_tokens,provenance,cache_semantics) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  db.exec('BEGIN')
  db.prepare('INSERT OR REPLACE INTO owners VALUES (?, ?, ?)').run('unrelated', 'other', 'Private')
  for (let i = 0; i < 5120; i += 1) {
    const session = i < 1024 ? 's' : 'unrelated'
    const key = `${session}:${i}`
    put.run(key, session, i, i % 2 ? 'pB' : 'pA', 'm', 'turn', 0, 1, 0, 0, 2)
    detail.run(key, session, `request:${Math.floor(i / 2)}`, `turn:${Math.floor(i / 4)}`, key, i % 2, i, 1, 2, 0, 0, 3, 'fixture', 'prompt-disjoint-v1')
  }
  db.exec('COMMIT')
  const original = DatabaseSync.prototype.prepare
  // Intercept existing prepared statements too, not just statements prepared by
  // this poll (the former allRows statement was prepared when the ledger opened).
  const statementPrototype = Object.getPrototypeOf(db.prepare('SELECT 1'))
  const originalAll = statementPrototype.all
  statementPrototype.all = function (...params) {
    const rows = originalAll.call(this, ...params)
    assert.ok(!rows.some(row => Object.hasOwn(row, 'key')), 'raw historical calls must not be materialized through .all()')
    return rows
  }
  const aggregates = []
  const latestQueries = []
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = original.call(this, sql)
    return new Proxy(statement, { get(target, property) {
      if (property === 'get' && sql.includes('ORDER BY d.source_seq')) return (...params) => {
        latestQueries.push({ sql, params })
        assert.match(sql, /LIMIT 1/)
        return target.get(...params)
      }
      if (property === 'all') return (...params) => {
        const rows = target.all(...params)
        assert.ok(!rows.some(row => Object.hasOwn(row, 'key')), 'raw historical calls must not be materialized through .all()')
        if (sql.includes('AS dimension')) aggregates.push({ sql, params, count: rows.length })
        return rows
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  }
  let stats
  try { stats = await rt.usageStats('b') } finally {
    DatabaseSync.prototype.prepare = original
    statementPrototype.all = originalAll
  }
  assert.deepEqual(stats.scopes.bot.allIn, { input: 1024, output: 2048, cacheRead: 0, cacheWrite: 0, calls: 512, attempts: 1024, retries: 512 })
  assert.equal(stats.scopes.lastRequest.allIn.calls, 1)
  assert.equal(stats.scopes.lastRequest.allIn.attempts, 2)
  assert.equal(stats.scopes.lastTurn.allIn.calls, 2)
  assert.equal(stats.scopes.lastTurn.allIn.attempts, 4)
  assert.deepEqual(stats.scopes.bot.byProvider.map(row => row.totals.calls), [512, 512])
  assert.ok(aggregates.length > 0)
  assert.ok(aggregates.every(query => query.count <= 4), 'returned rows are bounded by dimensions, not attempts')
  const plans = [...aggregates, ...latestQueries].flatMap(query => db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params).map(row => row.detail))
  for (const index of ['calls_session', 'usage_request', 'usage_turn', 'usage_latest']) assert.ok(plans.some(plan => plan.includes(index)), `${index} must bound its scoped query`)
  assert.equal(latestQueries.length, 1)
  t.diagnostic(`5120 stored attempts; 4096 unrelated; all1024 owned retained; max returned aggregate rows=${Math.max(...aggregates.map(query => query.count))}; calls_session/request/turn/latest indexes used`)
  db.close()
})

test('SQL full-history aggregates match pure scopes for cache semantics, unknowns, legacy positives and unsafe sums', async t => {
  const { rt, home } = await fixture(t)
  await rt.usageView()
  const rows = [
    sample('a', { input: 10, cacheRead: 90, cacheWrite: null, totalTokens: 101, cacheSemantics: 'prompt-disjoint-v1', sourceSeq: 1, provider: 'pA' }),
    sample('b', { input: 0, totalTokens: 1, retryOrdinal: 1, cacheSemantics: 'prompt-disjoint-v1', sourceSeq: 2, provider: 'pB' }),
    sample('c', { session: 'old', input: 90, cacheRead: 10, totalTokens: 101, cacheSemantics: 'prompt-disjoint-v1', requestId: 'old-request', sourceSeq: 3, provider: 'pA' }),
    sample('d', { kind: 'memory', requestId: 'aux', turnId: null, cacheRead: null, cacheWrite: null, provider: 'pUnknown' }),
    sample('legacy', { input: 8, output: 2, cacheRead: null, cacheWrite: null, requestId: null, turnId: null, retryOrdinal: null, provider: 'pLegacy' }),
    ...[4, 5].map(i => sample(`huge${i}`, { input: Number.MAX_SAFE_INTEGER, requestId: `huge${i}`, sourceSeq: i, provider: 'pOverflow' })),
  ]
  const db = new DatabaseSync(join(home, 'usage.sqlite'))
  db.prepare('INSERT INTO owners VALUES (?, ?, ?)').run('old', 'b', 'Bot')
  db.prepare('INSERT INTO kinds VALUES (?, ?)').run('old', 'task')
  const put = db.prepare('INSERT INTO calls VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const detail = db.prepare('INSERT INTO usage_details (key,session_id,request_id,turn_id,attempt_id,retry_ordinal,source_seq,input,output,cache_read,cache_write,total_tokens,provenance,cache_semantics) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  for (const row of rows) {
    put.run(row.key, row.session, row.time, row.provider, row.model, row.kind, 0, row.input ?? 0, row.cacheRead ?? 0, row.cacheWrite ?? 0, row.output ?? 0)
    if (row.key !== 'legacy') detail.run(row.key, row.session, row.requestId, row.turnId, row.attemptId, row.retryOrdinal, row.sourceSeq ?? null, row.input, row.output, row.cacheRead, row.cacheWrite, row.totalTokens ?? null, 'fixture', row.cacheSemantics ?? null)
  }
  db.close()
  const normalize = scopes => { for (const scope of Object.values(scopes)) scope?.byProvider.sort((a, b) => a.provider.localeCompare(b.provider)); return scopes }
  const expected = buildUsageStats(rows, { botId: 'b', sessionId: 's', owners: new Map([['s', { owner: 'b' }], ['old', { owner: 'b' }]]), kinds: new Map([['old', 'task']]) })
  const actual = await rt.usageStats('b')
  assert.deepEqual(normalize(actual.scopes), normalize(expected.scopes))
  assert.equal(actual.scopes.bot.byProvider.find(row => row.provider === 'pA').cacheRatio.ratio, 0.5)
  assert.equal(actual.scopes.bot.allIn.input, null)
  assert.equal(actual.scopes.bot.allIn.calls, null)
})

test('bounded SQL overlays unsaved replacements exactly once while a write is unavailable', async t => {
  const { rt, meter } = await fixture(t)
  const original = DatabaseSync.prototype.prepare
  let blocked = false
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = original.call(this, sql)
    if (!sql.startsWith('INSERT OR REPLACE INTO calls')) return statement
    return new Proxy(statement, { get(target, property) {
      if (property === 'run') return (...args) => { if (blocked) throw new Error('fixture write unavailable'); return target.run(...args) }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  }
  try { await rt.usageStats('b') } finally { DatabaseSync.prototype.prepare = original }
  const messages = rt.tagUsage([], { sessionId: 's', kind: 'checkpoint', requestId: 'aux', attemptId: 'stable' })
  const options = { sessionId: 's', messages, provider: 'p' }
  const report = n => drain(meter(options, async function* () { yield { type: 'usage', usage: { inputTokens: n, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } } }))
  await report(5)
  assert.equal((await rt.usageStats('b')).scopes.bot.allIn.input, 5)
  blocked = true
  await report(7)
  await drain(meter(options, async function* () {})) // no sample cannot erase pending7
  const pending = await rt.usageStats('b')
  assert.equal(pending.coverage.status, 'partial')
  assert.equal(pending.scopes.bot.allIn.input, 7)
  assert.equal(pending.scopes.bot.allIn.calls, 1)
  assert.equal(pending.scopes.bot.allIn.attempts, 1)
  blocked = false
  assert.deepEqual((await rt.usageStats('b')).scopes, pending.scopes)
})

test('memory fallback iterates cooperatively without history arrays and supports bounded cancellation', async t => {
  const rows = Array.from({ length: 1024 }, (_, i) => sample(String(i), { session: i % 3 === 0 ? 'private' : 's', sourceSeq: i, requestId: `request:${Math.floor(i / 2)}`, retryOrdinal: i % 2, provider: i % 2 ? 'pB' : 'pA' }))
  const options = { botId: 'b', sessionId: 's', owners: new Map([['s', { owner: 'b' }], ['private', { owner: 'other' }]]), kinds: new Map(), scanning: false, coverage: { status: 'partial', unreadableSessionIds: [], unresolvedSessionIds: [] } }
  let visited = 0
  const source = function* () { for (const row of rows) { visited += 1; yield row } }
  let yielded = false
  const timer = setTimeout(() => { yielded = true }, 0)
  const streamed = await buildUsageStatsIterated(source, options)
  clearTimeout(timer)
  const expected = buildUsageStats(rows, options)
  assert.deepEqual(streamed, expected)
  assert.equal(visited, rows.length * 2)
  assert.equal(yielded, true)
  assert.equal(streamed.coverage.status, 'partial')
  visited = 0
  const controller = new AbortController()
  const cancel = setTimeout(() => controller.abort(new Error('cancelled fixture')), 0)
  await assert.rejects(buildUsageStatsIterated(source, options, controller.signal), /cancelled fixture/)
  clearTimeout(cancel)
  assert.ok(visited <= 257)
  t.diagnostic(`memory fallback two streaming passes=${rows.length * 2} row visits, cooperative yield every256, cancelled after${visited} visits; no team snapshot`)
})

test('normalization preserves missing versus reported zero and rejects unsafe counts', () => {
  assert.deepEqual(normalizeUsage({ inputTokens: 4, outputTokens: 0, cacheReadTokens: 0 }), { input: 4, output: 0, cacheRead: 0, cacheWrite: null, totalTokens: null, cacheSemantics: null })
  assert.equal(normalizeUsage(undefined).input, null)
  assert.equal(normalizeUsage({ cacheReadTokens: -1 }).cacheRead, null)
  assert.equal(normalizeUsage({ inputTokens: Number.MAX_SAFE_INTEGER + 1 }).input, null)
})

test('totals count requests separately from attempts and propagate unknown fields', () => {
  const totals = summarizeUsage([sample('a'), sample('b', { retryOrdinal: 1, cacheRead: null }), sample('c', { requestId: 'r2' })])
  assert.deepEqual(totals, { input: 6, output: 3, cacheRead: null, cacheWrite: 0, calls: 2, attempts: 3, retries: 1 })
  assert.equal(summarizeUsage([sample('legacy', { requestId: null, retryOrdinal: null })]).calls, null)
  assert.equal(summarizeUsage([sample('a'), sample('a')]).attempts, 1)
})

test('scopes partition exact kinds without double-counting or leaking another owner', () => {
  const rows = [sample('a'), sample('b', { session: 'old', requestId: 'older', turnId: 'oldturn' }), sample('aux', { kind: 'checkpoint', requestId: 'aux', turnId: null }), sample('private', { session: 'private', input: 999 })]
  const stats = buildUsageStats(rows, { botId: 'b', sessionId: 's', owners: new Map([['s', { owner: 'b' }], ['old', { owner: 'b' }], ['private', { owner: 'other' }]]) })
  assert.equal(stats.scopes.bot.allIn.attempts, 3)
  assert.equal(stats.scopes.session.allIn.attempts, 2)
  assert.equal(stats.scopes.lastRequest.allIn.attempts, 1)
  assert.equal(stats.scopes.lastTurn.allIn.attempts, 1)
  assert.equal(stats.scopes.bot.byKind.checkpoint.attempts, 1)
  assert.equal(stats.scopes.bot.allIn.input, 6)
})

test('cache ratios are token-weighted within evidenced provider semantics only', () => {
  const rows = [sample('a', { input: 10, cacheRead: 90, totalTokens: 101, cacheSemantics: 'prompt-disjoint-v1' }), sample('b', { requestId: 'r2', input: 90, cacheRead: 10, totalTokens: 101, cacheSemantics: 'prompt-disjoint-v1' }), sample('c', { provider: 'other', cacheSemantics: null })]
  const stats = buildUsageStats(rows, { botId: 'b', sessionId: 's', owners: new Map([['s', { owner: 'b' }]]) })
  assert.deepEqual(stats.scopes.bot.byProvider.find(row => row.provider === 'p').cacheRatio, { read: 100, prompt: 200, ratio: 0.5 })
  assert.equal(stats.scopes.bot.byProvider.find(row => row.provider === 'other').cacheRatio, null)
  assert.equal('cacheRatio' in stats.scopes.bot.allIn, false)
  assert.equal(normalizeUsage({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 90 }, { kind: 'unrecognized' }).cacheSemantics, null)
})

test('fold records missing usage attempts and stable identities across page/retry/fork cuts', () => {
  const first = foldCalls([{ seq: 0, type: 'assistant/attempt', data: { turn: 3, step: 0, stream: [] } }, { seq: 1, type: 'llm/retry-started', data: { turn: 3, step: 0 } }])
  assert.equal(first.rows.length, 1)
  assert.equal(first.rows[0].input, null)
  const next = foldCalls([{ seq: 2, type: 'assistant/message', data: { turn: 3, step: 0, usage: { inputTokens: 0, outputTokens: 0 }, stream: [] } }], first.state)
  assert.equal(next.rows[0].retryOrdinal, 1)
  assert.equal(next.rows[0].key, '3:0:1')
  const fork = foldCalls([{ seq: 3, type: 'session/end-seed', data: { inherited: true } }, { seq: 4, type: 'assistant/message', data: { turn: 4, step: 0, usage: { inputTokens: 1, outputTokens: 2 } } }], next.state)
  assert.equal(fork.reset, true)
  assert.equal(fork.rows.length, 1)
})

async function fixture(t, { home: existing, logs = {}, state: statePatch = {}, listed = [] } = {}) {
  const home = existing ?? await mkdtemp(join(tmpdir(), 'bot-stats-'))
  if (!existing) t.after(() => rm(home, { recursive: true, force: true }))
  const listeners = new Map()
  const disposers = []
  const state = { bots: { b: { id: 'b', sessionId: 's', name: 'Bot' }, other: { id: 'other', sessionId: 'private', name: 'Private' } }, rooms: {}, agents: {}, ...statePatch }
  const rt = { home, state, load: async () => {}, warn() {}, botOf: id => state.bots[id], roomOf: () => undefined, sessionOfRoom: room => (room === undefined ? undefined : room.sessionId ?? room.id), chatOf: id => state.bots[id]?.sessionId, cachedCatalog: () => [], own: (object, key) => object?.[key], ctx: { effect: fn => disposers.push(fn()), on: (name, fn) => listeners.set(name, fn), sessionController: { list: async () => ({ items: listed }), projections: async ({ sessionId }) => logs[sessionId] ? { asOfSeq: logs[sessionId].length - 1 } : null, page: async ({ address, beforeSeq, throughSeq }) => { const log = logs[address.sessionId ?? address.childSessionId]; if (!log) throw new Error('unreadable'); const eligible = log.map((event, seq) => ({ event: { ...event, seq } })).filter(({ event }) => event.seq <= throughSeq && (beforeSeq === undefined || event.seq < beforeSeq)); return { records: eligible.slice(-2), hasMore: eligible.length > 2 } } } } }
  install(rt)
  const close = () => { for (const dispose of disposers) dispose?.() }
  t.after(close)
  return { rt, home, close, meter: listeners.get('llm/stream') }
}
const drain = async stream => { for await (const chunk of stream) void chunk }
const event = (turn, step, usage) => ({ type: 'assistant/message', time: turn, data: { turn, step, usage, stream: [] } })

test('host query refreshes history, rejects cross-Bot sessions and persists knownness across restart', async t => {
  const first = await fixture(t, { logs: { s: [event(1, 0, { inputTokens: 5, outputTokens: 0, cacheReadTokens: 0 })] } })
  const stats = await first.rt.usageStats('b')
  assert.equal(stats.scopes.bot.allIn.input, 5)
  assert.equal(stats.scopes.bot.allIn.cacheRead, 0)
  assert.equal(stats.scopes.bot.allIn.cacheWrite, null)
  await assert.rejects(first.rt.usageStats('b', { sessionId: 'private' }), error => error.code === 'bot/invalid')
  first.close()
  const second = await fixture(t, { home: first.home })
  const reopened = await second.rt.usageStats('b')
  assert.equal(reopened.scopes.bot.allIn.cacheRead, 0)
  assert.equal(reopened.scopes.bot.allIn.cacheWrite, null)
})

test('additive v2 migration preserves auxiliary history/owners/kinds with legacy unknowns', async t => {
  const home = await mkdtemp(join(tmpdir(), 'bot-stats-migrate-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const db = new DatabaseSync(join(home, 'usage.sqlite'))
  db.exec(`CREATE TABLE calls (key TEXT PRIMARY KEY, session TEXT NOT NULL, time INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL, live INTEGER NOT NULL, input INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, output INTEGER NOT NULL);
    CREATE TABLE marks (session TEXT PRIMARY KEY, through INTEGER NOT NULL, fold TEXT NOT NULL, sealed INTEGER NOT NULL);
    CREATE TABLE owners (session TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE kinds (session TEXT PRIMARY KEY, kind TEXT NOT NULL);
    INSERT INTO calls VALUES ('live:old','s',1,'p','m','memory',1,8,0,0,2);
    INSERT INTO owners VALUES ('s','b','Bot'); INSERT INTO kinds VALUES ('s','group');
    INSERT INTO marks VALUES ('s',100,'{}',1); PRAGMA user_version=2;`)
  db.close()
  const { rt } = await fixture(t, { home })
  const stats = await rt.usageStats('b')
  assert.equal(stats.scopes.bot.allIn.attempts, 1)
  assert.equal(stats.scopes.bot.allIn.cacheRead, null)
  assert.equal(stats.scopes.bot.allIn.calls, null)
  const after = new DatabaseSync(join(home, 'usage.sqlite'))
  assert.equal(after.prepare('SELECT COUNT(*) AS n FROM calls').get().n, 1)
  assert.equal(after.prepare('SELECT kind FROM kinds WHERE session = ?').get('s').kind, 'group')
  // The store version after the merge: Automagik's and v0.3.6's additions together.
  assert.equal(after.prepare('PRAGMA user_version').get().user_version, 4)
  after.close()
})

test('meter preserves tagged kinds, partial failed usage, dedupe and absent usage attempts', async t => {
  const { rt, meter } = await fixture(t)
  const chunk = { type: 'usage', usage: { inputTokens: 5, outputTokens: 0 } }
  const messages = rt.tagUsage([], { sessionId: 's', kind: 'checkpoint' })
  await assert.rejects(drain(meter({ messages, sessionId: 's', purpose: 'compaction', provider: 'p', model: 'm' }, async function* () { yield chunk; throw new Error('failure') })))
  await drain(meter({ messages, sessionId: 's', purpose: 'compaction' }, async function* () { yield chunk }))
  await drain(meter({ messages: [], sessionId: 's', purpose: 'compaction' }, async function* () {}))
  const stats = await rt.usageStats('b')
  assert.equal(stats.scopes.bot.byKind.checkpoint.attempts, 1)
  assert.equal(stats.scopes.bot.byKind.checkpoint.input, 5)
  assert.equal(stats.scopes.bot.byKind.compaction.attempts, 1)
  assert.equal(stats.scopes.bot.byKind.compaction.input, null)
})

test('recursive rewrite wrappers count once, including empty/failed streams; concurrent calls remain separate', async t => {
  const { rt, meter } = await fixture(t)
  const options = { sessionId: 's', purpose: 'compaction', messages: [] }
  // The intermediate wrapper is deliberately not the meter iterator itself.
  const rewrite = () => (async function* () { yield* meter(options, async function* () {}) })()
  await drain(meter(options, rewrite))
  await assert.rejects(drain(meter(options, () => (async function* () { yield* meter(options, async function* () { yield await Promise.reject(new Error('provider failed')) }) })())))
  await Promise.all([drain(meter(options, async function* () {})), drain(meter(options, async function* () {}))])
  const stats = await rt.usageStats('b')
  assert.equal(stats.scopes.bot.allIn.attempts, 4)
  assert.equal(stats.scopes.bot.allIn.calls, 4)
  assert.equal(stats.scopes.bot.allIn.input, null)
})

test('paged settlement replacements and retries survive scans/restarts without duplicate foreground streams', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const u = { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }
  const logs = { s: [
    { type: 'request/header', data: { header: { config: { provider: 'p', model: 'm' } } } },
    { type: 'assistant/attempt', data: { turn: 1, step: 0, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: u } }] } },
    { type: 'llm/retry-started', data: { turn: 1, step: 0 } },
    event(1, 0, { ...u, inputTokens: 3 }),
    event(1, 0, { ...u, inputTokens: 4 }),
  ] }
  const first = await fixture(t, { logs })
  // The stream observer must pass plain Session requests through unmetered.
  await drain(first.meter({ sessionId: 's', messages: [] }, async function* () { yield { type: 'usage', usage: u } }))
  const before = await first.rt.usageStats('b')
  assert.equal(before.scopes.lastRequest.allIn.input, 6)
  assert.equal(before.scopes.lastRequest.allIn.calls, 1)
  assert.equal(before.scopes.lastRequest.allIn.attempts, 2)
  assert.equal(before.scopes.lastRequest.allIn.retries, 1)
  const id = before.scopes.lastRequest.id
  logs.s.push(event(1, 0, { ...u, inputTokens: 7 }))
  t.mock.timers.tick(6_000)
  const replaced = await first.rt.usageStats('b')
  assert.equal(replaced.scopes.lastRequest.id, id)
  assert.equal(replaced.scopes.lastRequest.allIn.input, 9)
  assert.equal(replaced.scopes.lastRequest.allIn.attempts, 2)
  // A final settlement with no sample cannot erase the last reported usage.
  logs.s.push(event(1, 0, undefined))
  t.mock.timers.tick(6_000)
  const noSample = await first.rt.usageStats('b')
  assert.equal(noSample.scopes.lastRequest.allIn.input, 9)
  assert.equal(noSample.scopes.lastRequest.allIn.attempts, 2)
  first.close()
  const second = await fixture(t, { home: first.home, logs })
  const reopened = await second.rt.usageStats('b')
  assert.deepEqual(reopened.scopes, noSample.scopes)
})

test('fork inherited cut deletes only inherited logged attempts, preserving auxiliary calls across restart', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const logs = { s: [event(1, 0, { inputTokens: 100, outputTokens: 10 })] }
  const first = await fixture(t, { logs })
  await first.rt.usageStats('b')
  await drain(first.meter({ sessionId: 's', purpose: 'memory', messages: [] }, async function* () { yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 1 } } }))
  logs.s.push({ type: 'session/end-seed', data: { inherited: true } }, event(2, 0, { inputTokens: 2, outputTokens: 1 }))
  t.mock.timers.tick(6_000)
  const fork = await first.rt.usageStats('b')
  assert.equal(fork.scopes.bot.allIn.input, 7)
  assert.equal(fork.scopes.bot.allIn.attempts, 2)
  assert.equal(fork.scopes.bot.byKind.memory.attempts, 1)
  first.close()
  const second = await fixture(t, { home: first.home, logs })
  assert.equal((await second.rt.usageStats('b')).scopes.bot.allIn.input, 7)
})

test('adapter provenance enables weighted cache only when exact prompt totals remain compatible', () => {
  const u = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 30, totalTokens: 45 }
  const pi = normalizeUsage(u, { kind: 'pi-ai', version: 2, api: 'openai-completions' })
  assert.equal(pi.cacheWrite, null)
  assert.equal(pi.cacheSemantics, 'prompt-disjoint-v1')
  const build = rows => buildUsageStats(rows, { botId: 'b', sessionId: 's', owners: new Map([['s', { owner: 'b' }]]) }).scopes.bot.byProvider[0].cacheRatio
  assert.deepEqual(build([sample('a', pi)]), { read: 30, prompt: 40, ratio: 0.75 })
  assert.equal(build([sample('a', pi), sample('b', { ...pi, cacheSemantics: null })]), null)
  assert.equal(build([sample('a', { ...pi, totalTokens: 20 })]), null)
  assert.equal(build([sample('a', { ...pi, input: Number.MAX_SAFE_INTEGER })]), null)
  assert.equal(normalizeUsage(u, { kind: 'pi-ai', version: 3, api: 'openai-completions' }).cacheSemantics, null)
  assert.equal(normalizeUsage(u, { kind: 'pi-ai', version: 2, api: 'unknown' }).cacheSemantics, null)
  assert.equal(normalizeUsage(u, { kind: 'deepseek-messages', version: 1 }).cacheSemantics, 'prompt-disjoint-v1')
})

test('known-zero and unknown auxiliary fields persist with exact tag precedence and no replay payload', async t => {
  const first = await fixture(t)
  for (const kind of ['checkpoint', 'steward', 'handoff', 'memory']) {
    const messages = first.rt.tagUsage([], { sessionId: 's', kind })
    const copied = []
    first.rt.carryUsageTag(messages, copied)
    await drain(first.meter({ sessionId: 's', purpose: 'compaction', provider: 'p', model: 'm', messages: copied }, async function* () {
      yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } }
      yield { type: 'finish', replayState: { response: { kind: 'pi-ai', version: 2, api: 'openai-completions', privatePayload: 'must-not-persist' } }, reason: { kind: 'stop' } }
    }))
  }
  const stats = await first.rt.usageStats('b')
  assert.deepEqual(Object.keys(stats.scopes.bot.byKind).sort(), ['checkpoint', 'handoff', 'memory', 'steward'])
  assert.equal(stats.scopes.bot.allIn.cacheRead, 0)
  assert.equal(stats.scopes.bot.allIn.cacheWrite, null)
  const db = new DatabaseSync(join(first.home, 'usage.sqlite'))
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage_details WHERE provenance LIKE '%must-not-persist%'").get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_details WHERE request_id IS NOT NULL AND attempt_id IS NOT NULL AND turn_id IS NULL').get().n, 4)
  db.close()
  first.close()
  const second = await fixture(t, { home: first.home })
  assert.deepEqual((await second.rt.usageStats('b')).scopes.bot, stats.scopes.bot)
})

test('same-Bot group seats/children/tasks cannot be queried as own-chat; their billing stays separate and durable', async t => {
  const u = { inputTokens: 2, outputTokens: 1 }
  const logs = { s: [event(1, 0, u)], old: [event(1, 0, u)], seat: [event(1, 0, u)], child: [event(1, 0, { inputTokens: 100, outputTokens: 10 }), { type: 'session/end-seed', data: { inherited: true } }, event(2, 0, u)], task: [event(1, 0, u)] }
  const state = { bots: { b: { id: 'b', sessionId: 's', name: 'Bot', segments: [{ sessionId: 'old' }] } }, rooms: { room: { id: 'room', name: 'Room', sessions: { b: 'seat' } } }, tasks: { task: { from: 'b', status: 'done' } } }
  const first = await fixture(t, { logs, state, listed: [{ sessionId: 'child', origin: 'subagent', parentSessionId: 's' }] })
  const stats = await first.rt.usageStats('b')
  assert.equal(stats.scopes.bot.allIn.attempts, 5)
  assert.equal(stats.scopes.bot.allIn.input, 10)
  assert.equal(stats.scopes.bot.byKind.child.input, 2)
  assert.equal(stats.scopes.bot.byKind.task.input, 2)
  assert.equal(stats.scopes.bot.byKind.group.input, 2)
  assert.equal(stats.scopes.bot.byKind.chat.input, 4)
  for (const sessionId of ['seat', 'child', 'task']) await assert.rejects(first.rt.usageStats('b', { sessionId }), error => error.code === 'bot/invalid')
  assert.equal((await first.rt.usageStats('b', { sessionId: 'old' })).scopes.session.allIn.input, 2)
  first.close()
  // The identifying room/task/listing records are gone; journaled kind/owner must remain.
  const second = await fixture(t, { home: first.home, state: { bots: state.bots } })
  const restored = await second.rt.usageStats('b')
  assert.equal(restored.scopes.bot.byKind.child.input, 2)
  assert.equal(restored.scopes.bot.byKind.task.input, 2)
  assert.equal(restored.scopes.bot.byKind.group.input, 2)
  assert.equal(restored.scopes.bot.allIn.input, 10)
})

test('task eviction before async load and first scan preserves captured owner/category across reopen', async t => {
  const logs = { task: [event(1, 0, { inputTokens: 8, outputTokens: 2 })] }
  const first = await fixture(t, { logs, state: { tasks: { task: { from: 'b', status: 'working' } } }, listed: [{ sessionId: 'task' }] })
  const load = Promise.withResolvers()
  let loadCalls = 0
  first.rt.load = () => { loadCalls += 1; return load.promise }
  // Plain foreground ingestion must capture the task before its first await.
  await drain(first.meter({ sessionId: 'task', messages: [] }, async function* () {}))
  assert.equal(loadCalls, 0)
  delete first.rt.state.tasks.task
  load.resolve()
  const stats = await first.rt.usageStats('b')
  assert.equal(stats.scopes.bot.byKind.task?.input, 8)
  assert.equal(stats.scopes.bot.byKind.task?.output, 2)
  assert.equal(stats.scopes.bot.byKind.chat, undefined)
  assert.equal(stats.scopes.bot.allIn.input, 8)
  assert.equal(stats.scopes.bot.allIn.output, 2)
  const db = new DatabaseSync(join(first.home, 'usage.sqlite'))
  assert.equal(db.prepare('SELECT owner FROM owners WHERE session = ?').get('task')?.owner, 'b')
  assert.equal(db.prepare('SELECT kind FROM kinds WHERE session = ?').get('task')?.kind, 'task')
  db.close()
  first.close()
  const second = await fixture(t, { home: first.home, logs, listed: [{ sessionId: 'task' }] })
  const reopened = await second.rt.usageStats('b')
  assert.equal(reopened.scopes.bot.byKind.task?.input, 8)
  assert.equal(reopened.scopes.bot.byKind.task?.output, 2)
  assert.equal(reopened.scopes.bot.byKind.chat, undefined)
  assert.equal(reopened.scopes.bot.allIn.attempts, 1)
})

test('unreadable gaps never advance cursors or claim complete coverage', async t => {
  const { rt, home } = await fixture(t, { logs: { s: [event(1, 0, { inputTokens: 1, outputTokens: 1 })] } })
  rt.ctx.sessionController.projections = async () => ({ asOfSeq: 2 })
  const stats = await rt.usageStats('b')
  assert.equal(stats.coverage.status, 'partial')
  assert.ok(stats.coverage.unreadableSessionIds.includes('s'))
  assert.equal(stats.scopes.bot.allIn.attempts, 0)
  const db = new DatabaseSync(join(home, 'usage.sqlite'))
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM marks').get().n, 0)
  db.close()
})

test('bounded refresh reports scanning without waiting indefinitely and rechecks own-chat identity', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { rt } = await fixture(t)
  const started = Promise.withResolvers()
  const finish = Promise.withResolvers()
  rt.ctx.sessionController.list = async () => { started.resolve(); return finish.promise }
  const pending = rt.usageStats('b')
  await started.promise
  t.mock.timers.tick(6_000)
  const partial = await pending
  assert.equal(partial.scanning, true)
  assert.equal(partial.coverage.status, 'scanning')
  finish.resolve({ items: [] })
  await rt.usageView()
  assert.equal((await rt.usageStats('b')).scanning, false)
  rt.state.bots.b.sessionId = 'replacement'
  await assert.rejects(rt.usageStats('b', { sessionId: 's' }), error => error.code === 'bot/invalid')
})

test('newer ledgers are never reset or deleted by opening Stats', async t => {
  const home = await mkdtemp(join(tmpdir(), 'bot-stats-newer-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const db = new DatabaseSync(join(home, 'usage.sqlite'))
  db.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('auxiliary-history'); PRAGMA user_version=999;")
  db.close()
  const { rt } = await fixture(t, { home })
  assert.equal((await rt.usageStats('b')).coverage.status, 'partial')
  const after = new DatabaseSync(join(home, 'usage.sqlite'))
  assert.equal(after.prepare('SELECT value FROM sentinel').get().value, 'auxiliary-history')
  assert.equal(after.prepare('PRAGMA user_version').get().user_version, 999)
  after.close()
})

test('coverage is partial for unreadable owned history and never leaks private session IDs', async t => {
  const { rt } = await fixture(t, { logs: { s: [event(1, 0, { inputTokens: 1, outputTokens: 1 })] }, listed: [{ sessionId: 'private', projections: { kind: 'sequenced', asOfSeq: 1 } }, { sessionId: 'lost', parentSessionId: 's', origin: 'subagent', projections: { kind: 'sequenced', asOfSeq: 1 } }] })
  const stats = await rt.usageStats('b')
  assert.equal(stats.coverage.status, 'partial')
  assert.deepEqual(stats.coverage.unreadableSessionIds, ['lost'])
  assert.equal(JSON.stringify(stats).includes('private'), false)
})
