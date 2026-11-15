// Usage ledger: the tokens each model call in this DSH spent, for the Usage page.
//
// A call that a Session logs (one assistant settlement per attempt) is read from that
// log, so calls made before this ledger existed count too. A call outside every log (a
// checkpoint, a handoff note, the steward, an image reading, DSH titles and compaction)
// is metered while it streams, from the time Omni runs. Rows go to usage.sqlite; like
// the chat index it is derived from the logs, and deleting it loses only the metered
// calls and the names of deleted Bots.
//
// A call belongs to a Bot (its own chat, its group Sessions, their earlier parts, and
// any Session forked or spawned under them), to a group chat's own Session, or to the
// rest of DSH ("other").
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeUsage, buildUsageStatsIterated, scopeFromAggregates, usageStatsResult } from '../shared/usage-stats.js'

const LEDGER_VERSION = 4
const PAGE_MESSAGES = 400
const PAGE_TIMEOUT_MS = 20_000
const SCAN_TIMEOUT_MS = 180_000
const SCAN_PARALLEL = 4
// A view waits this long for a scan, then answers with what it has.
const VIEW_WAIT_MS = 6_000
const RESCAN_AFTER_MS = 5_000
// An ended part still gets a few events (a title, a late reply) just after it ends.
const SEAL_AFTER_MS = 60_000
// Calls are summed per quarter hour, which every time zone offset divides.
const SLOT_MS = 15 * 60_000

const count = value => (Number.isSafeInteger(value) && value > 0 ? value : 0)

function usageChunk(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage
  }
  return undefined
}

function replayResponse(data) {
  const source = data.message?.source?.replayState?.response
  if (source !== undefined) return source
  if (!Array.isArray(data.stream)) return undefined
  for (let index = data.stream.length - 1; index >= 0; index -= 1) {
    const chunk = data.stream[index]?.chunk
    if (chunk?.type === 'finish' && chunk.replayState?.response) return chunk.replayState.response
  }
  return undefined
}

const identity = (kind, session, ...position) => JSON.stringify([kind, session, ...position])
// Persist only the adapter discriminator, never arbitrary provider replay data.
const provenanceOf = response => response ? JSON.stringify({ kind: response.kind, version: response.version, api: response.api }) : 'unknown'

// No sample is not a replacement sample. This matches DSH's projection: a
// settlement without usage cannot erase a previous sample of the same attempt.
function replaceSample(previous, row) {
  if (!previous || row.usageReported !== false) return row
  return { ...row, usageReported: previous.usageReported ?? true, ...Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'provenance', 'cacheSemantics', 'provider', 'model'].map(field => [field, previous[field]])) }
}

// Folds Session events, oldest first, into one row per billed attempt, as DSH's own
// tokenUsage projection counts them: a later sample of one attempt replaces the earlier
// one, and `llm/retry-started` begins a new attempt. The model is the one the latest
// request header named. A fork's events up to its inherited cut are the parent's, so
// the cut drops the rows before it (`reset`).
export function foldCalls(events, from = {}) {
  const state = { provider: from.provider ?? '', model: from.model ?? '', retry: from.retry ?? null }
  const rows = new Map()
  let reset = false
  for (const event of events) {
    const data = event?.data ?? {}
    switch (event?.type) {
      case 'request/header': {
        const config = data.header?.config
        if (config?.provider && config?.model) Object.assign(state, { provider: config.provider, model: config.model })
        break
      }
      case 'request/context':
        if (data.provider && data.model) Object.assign(state, { provider: data.provider, model: data.model })
        break
      case 'llm/retry-started':
        state.retry = state.retry?.turn === data.turn && state.retry.step === data.step
          ? { ...state.retry, count: state.retry.count + 1 }
          : { turn: data.turn, step: data.step, count: 1 }
        break
      case 'session/end-seed':
        if (data.inherited === true) {
          rows.clear()
          reset = true
        }
        break
      case 'assistant/message':
      case 'assistant/attempt': {
        const usage = (event.type === 'assistant/message' ? data.usage : undefined) ?? usageChunk(data.stream)
        if (!Number.isSafeInteger(data.turn) || !Number.isSafeInteger(data.step)) break
        const attempt = state.retry?.turn === data.turn && state.retry.step === data.step ? state.retry.count : 0
        const key = `${data.turn}:${data.step}:${attempt}`
        rows.set(key, replaceSample(rows.get(key), {
          key, usageReported: usage !== undefined && usage !== null, turn: data.turn, step: data.step, retryOrdinal: attempt, sourceSeq: event.seq ?? null,
          time: Number.isFinite(event.time) ? event.time : 0, provider: data.message?.source?.provider ?? state.provider, model: data.message?.source?.model ?? state.model,
          provenance: provenanceOf(replayResponse(data)),
          outcome: event.type === 'assistant/attempt' ? 'attempt' : data.interrupted ? 'interrupted' : 'message',
          ...normalizeUsage(usage, replayResponse(data)),
        }))
        break
      }
      default:
        break
    }
  }
  return { rows: [...rows.values()], state, reset }
}

// One aggregate per Session, model, use, and quarter hour.
function addTo(groups, row) {
  const slot = Math.floor(row.time / SLOT_MS)
  const id = `${row.session}\n${row.provider}\n${row.model}\n${row.kind}\n${slot}`
  const group = groups.get(id) ?? { session: row.session, provider: row.provider, model: row.model, kind: row.kind, slot, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 }
  if ([row.input, row.output, row.cacheRead, row.cacheWrite].every(value => value === null)) return
  group.input += count(row.input)
  group.cacheRead += count(row.cacheRead)
  group.cacheWrite += count(row.cacheWrite)
  group.output += count(row.output)
  group.calls += row.calls ?? 1
  groups.set(id, group)
}

// A Session's seal, as the marks keep it. `seal` is undefined while the Session can
// still grow; `{listed: null}` for an ended part; `{listed}` for a cold Session, at
// the checkpoint watermark its listing showed.
const sealFields = seal => ({ sealed: seal !== undefined, listed: seal?.listed ?? null })

function memoryLedger() {
  const calls = new Map()
  const marks = new Map()
  const owners = new Map()
  const kinds = new Map()
  return {
    durable: false,
    mark: session => marks.get(session),
    commit(session, { rows, reset, mark }) {
      if (reset) for (const [key, row] of calls) if (row.session === session && !row.live) calls.delete(key)
      for (const row of rows) calls.set(row.key, replaceSample(calls.get(row.key), row))
      marks.set(session, mark)
    },
    add: row => calls.set(row.key, { ...replaceSample(calls.get(row.key), row), live: true }),
    owners: () => new Map(owners),
    setOwner: (session, owner) => owners.set(session, owner),
    kinds: () => new Map(kinds),
    setKind: (session, kind) => kinds.set(session, kind),
    journal(session, owner, kind) {
      if (owner) owners.set(session, owner)
      if (kind) kinds.set(session, kind)
    },
    stats: (options, signal) => buildUsageStatsIterated(() => calls.values(), options, signal),
    groups() {
      const groups = new Map()
      for (const row of calls.values()) addTo(groups, row)
      return [...groups.values()]
    },
    close() {},
  }
}

// At most 1 + kind-count + provider-count rows cross the SQLite boundary per
// scope. Native SQL visits only authorized Sessions; no raw history .all() exists.
function sqliteStats(db, options) {
  const { botId, sessionId, owners } = options
  const sessions = JSON.stringify([...owners].filter(([, owner]) => owner.owner === botId).map(([id]) => id))
  // Only unsaved attempts are serialized, never historical rows. Overlay by key
  // so a temporary write failure neither omits nor double-counts a replacement.
  const pending = new Map()
  for (const row of options.pending ?? []) if (owners.get(row.session)?.owner === botId) pending.set(row.key, replaceSample(pending.get(row.key), row))
  const pendingFields = ['key', 'session', 'provider', 'kind', 'requestId', 'turnId', 'retryOrdinal', 'usageReported', 'input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'cacheSemantics']
  const pendingValue = (field, stored) => `CASE WHEN p.usageReported = 0 AND d.key IS NOT NULL THEN d.${stored} ELSE p.${field} END`
  const getLatest = db.prepare(`SELECT d.request_id AS requestId, d.turn_id AS turnId FROM usage_details d
    JOIN calls c ON c.key = d.key WHERE d.session_id = ? AND d.source_seq IS NOT NULL
    AND d.request_id IS NOT NULL AND d.turn_id IS NOT NULL AND c.kind = 'turn'
    ORDER BY d.source_seq DESC LIMIT 1`)
  const strictSum = field => `CASE WHEN COUNT(${field}) = COUNT(*) AND TOTAL(${field}) <= 9007199254740991 THEN CAST(TOTAL(${field}) AS INTEGER) ELSE NULL END`
  const aggregates = `${['input', 'output', 'cacheRead', 'cacheWrite'].map(field => `${strictSum(field)} AS ${field}`).join(', ')},
    COUNT(*) AS attempts, CASE WHEN COUNT(NULLIF(requestId, '')) = COUNT(*) THEN COUNT(DISTINCT requestId) ELSE NULL END AS calls,
    CASE WHEN COUNT(retryOrdinal) = COUNT(*) THEN COALESCE(SUM(retryOrdinal > 0), 0) ELSE NULL END AS retries,
    CASE WHEN COUNT(cacheSemantics) = COUNT(*) AND COUNT(DISTINCT cacheSemantics) = 1 THEN MIN(cacheSemantics) ELSE NULL END AS semantics,
    ${strictSum('prompt')} AS prompt`
  const known = (legacy, detail) => `CASE WHEN d.key IS NULL THEN CASE WHEN c.${legacy} > 0 THEN c.${legacy} ELSE NULL END ELSE d.${detail} END`
  const prompt = 'COALESCE(totalTokens - output, input + cacheRead + cacheWrite)'
  const query = (id, filter = '', params = {}) => scopeFromAggregates(id, db.prepare(`
    WITH pending AS MATERIALIZED (SELECT ${pendingFields.map(field => `json_extract(value, '$.${field}') AS ${field}`).join(', ')} FROM json_each(:pending)),
    samples AS NOT MATERIALIZED (
      SELECT c.provider, CASE WHEN c.kind = 'turn' THEN COALESCE(k.kind, 'chat') ELSE c.kind END AS kind,
      d.request_id AS requestId, d.retry_ordinal AS retryOrdinal, d.cache_semantics AS cacheSemantics, d.total_tokens AS totalTokens,
      ${known('input', 'input')} AS input, ${known('output', 'output')} AS output,
      ${known('cache_read', 'cache_read')} AS cacheRead, ${known('cache_write', 'cache_write')} AS cacheWrite
      FROM calls c LEFT JOIN usage_details d ON c.key = d.key LEFT JOIN kinds k ON k.session = c.session
      WHERE c.session IN (SELECT value FROM json_each(:sessions)) AND c.key NOT IN (SELECT key FROM pending) ${filter}
      UNION ALL
      SELECT CASE WHEN p.usageReported = 0 AND d.key IS NOT NULL THEN c.provider ELSE p.provider END,
      CASE WHEN p.kind = 'turn' THEN COALESCE(k.kind, 'chat') ELSE p.kind END,
      p.requestId, p.retryOrdinal, ${pendingValue('cacheSemantics', 'cache_semantics')}, ${pendingValue('totalTokens', 'total_tokens')},
      ${pendingValue('input', 'input')}, ${pendingValue('output', 'output')}, ${pendingValue('cacheRead', 'cache_read')}, ${pendingValue('cacheWrite', 'cache_write')}
      FROM pending p LEFT JOIN usage_details d ON d.key = p.key LEFT JOIN calls c ON c.key = p.key LEFT JOIN kinds k ON k.session = p.session
      WHERE p.session IN (SELECT value FROM json_each(:sessions)) ${filter.replaceAll('c.session', 'p.session').replaceAll('d.session_id', 'p.session').replaceAll('d.request_id', 'p.requestId').replaceAll('d.turn_id', 'p.turnId')}
    ), normalized AS NOT MATERIALIZED (
      SELECT *, CASE WHEN cacheRead IS NOT NULL AND input IS NOT NULL AND output IS NOT NULL
      AND ${prompt} BETWEEN 0 AND 9007199254740991 AND ${prompt} >= input + cacheRead
      AND (cacheWrite IS NULL OR ${prompt} = input + cacheRead + cacheWrite) THEN ${prompt} ELSE NULL END AS prompt FROM samples
    )
    SELECT 'allIn' AS dimension, '' AS name, ${aggregates} FROM normalized
    UNION ALL SELECT 'kind' AS dimension, kind AS name, ${aggregates} FROM normalized GROUP BY kind
    UNION ALL SELECT 'provider' AS dimension, provider AS name, ${aggregates} FROM normalized GROUP BY provider
    `).all({ sessions, pending: JSON.stringify([...pending.values()]), ...params }))
  // Keep all four scopes on one SQLite read snapshot even with another writer.
  db.exec('BEGIN')
  try {
    const latest = getLatest.get(sessionId)
    const scopes = {
      bot: query(botId), session: query(sessionId, 'AND c.session = :selected', { selected: sessionId }),
      lastRequest: latest ? query(latest.requestId, 'AND d.session_id = :selected AND d.request_id = :request', { selected: sessionId, request: latest.requestId }) : null,
      lastTurn: latest ? query(latest.turnId, 'AND d.session_id = :selected AND d.turn_id = :turn', { selected: sessionId, turn: latest.turnId }) : null,
    }
    db.exec('COMMIT')
    return usageStatsResult(options, scopes)
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function sqliteLedger(DatabaseSync, path) {
  const db = new DatabaseSync(path)
  try {
    // Desktop and Web may share one DSH home; the other writer holds the lock
    // briefly, and the timeout must be armed before the WAL pragma can block.
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA journal_mode = WAL')
    // Schema upgrades are additive. In particular, old live auxiliary rows cannot
    // be reconstructed from Session history and must never be rebuilt or erased.
    // Both prior products used version 3 with different columns. Upgrade by shape,
    // under one write lock, preserving live rows and Automagik's usage_details.
    db.exec('BEGIN IMMEDIATE')
    try {
      const version = db.prepare('PRAGMA user_version').get().user_version
      if (version > LEDGER_VERSION) throw new Error(`unsupported usage ledger version ${version}`)
      db.exec(`
        CREATE TABLE IF NOT EXISTS calls (key TEXT PRIMARY KEY, session TEXT NOT NULL, time INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL, live INTEGER NOT NULL, input INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, output INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS calls_session ON calls (session);
        CREATE TABLE IF NOT EXISTS marks (session TEXT PRIMARY KEY, through INTEGER NOT NULL, fold TEXT NOT NULL, sealed INTEGER NOT NULL, listed INTEGER);
        CREATE TABLE IF NOT EXISTS owners (session TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS kinds (session TEXT PRIMARY KEY, kind TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS usage_details (key TEXT PRIMARY KEY, session_id TEXT NOT NULL, request_id TEXT, turn_id TEXT, attempt_id TEXT, turn INTEGER, step INTEGER, retry_ordinal INTEGER, source_seq INTEGER, input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER, total_tokens INTEGER, provenance TEXT NOT NULL, cache_semantics TEXT, outcome TEXT);
        CREATE INDEX IF NOT EXISTS usage_request ON usage_details (session_id, request_id);
        CREATE INDEX IF NOT EXISTS usage_turn ON usage_details (session_id, turn_id);
        CREATE INDEX IF NOT EXISTS usage_latest ON usage_details (session_id, source_seq DESC) WHERE source_seq IS NOT NULL;`)
      if (!db.prepare('PRAGMA table_info(marks)').all().some(column => column.name === 'listed')) {
        db.exec('ALTER TABLE marks ADD COLUMN listed INTEGER')
      }
      // Replay enriches durable logged rows; all auxiliary rows and old amounts
      // remain intact. Unreadable history keeps legacy-unknown metadata.
      if (version < LEDGER_VERSION) db.exec("UPDATE marks SET through = -1, fold = '{}', sealed = 0")
      db.exec(`PRAGMA user_version = ${LEDGER_VERSION}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    const put = db.prepare('INSERT OR REPLACE INTO calls (key, session, time, provider, model, kind, live, input, cache_read, cache_write, output) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const dropLogged = db.prepare('DELETE FROM calls WHERE session = ? AND live = 0')
    const getMark = db.prepare('SELECT through, fold, sealed, listed FROM marks WHERE session = ?')
    const setMark = db.prepare('INSERT OR REPLACE INTO marks (session, through, fold, sealed, listed) VALUES (?, ?, ?, ?, ?)')
    const allOwners = db.prepare('SELECT session, owner, name FROM owners')
    const putOwner = db.prepare('INSERT OR REPLACE INTO owners (session, owner, name) VALUES (?, ?, ?)')
    const allKinds = db.prepare('SELECT session, kind FROM kinds')
    const putKind = db.prepare('INSERT OR REPLACE INTO kinds (session, kind) VALUES (?, ?)')
    const putDetail = db.prepare('INSERT OR REPLACE INTO usage_details (key, session_id, request_id, turn_id, attempt_id, turn, step, retry_ordinal, source_seq, input, output, cache_read, cache_write, total_tokens, provenance, cache_semantics, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const dropDetails = db.prepare('DELETE FROM usage_details WHERE key IN (SELECT key FROM calls WHERE session = ? AND live = 0)')
    const previousSample = db.prepare('SELECT d.input, d.output, d.cache_read AS cacheRead, d.cache_write AS cacheWrite, d.total_tokens AS totalTokens, d.provenance, d.cache_semantics AS cacheSemantics, c.provider, c.model FROM usage_details d JOIN calls c ON c.key = d.key WHERE d.key = ?')
    const insert = (row, live) => {
      if (row.usageReported === false) row = replaceSample(previousSample.get(row.key), row)
      put.run(row.key, row.session, row.time, row.provider, row.model, row.kind, live ? 1 : 0, count(row.input), count(row.cacheRead), count(row.cacheWrite), count(row.output))
      putDetail.run(row.key, row.session, row.requestId ?? null, row.turnId ?? null, row.attemptId ?? null, row.turn ?? null, row.step ?? null, row.retryOrdinal ?? null, row.sourceSeq ?? null, row.input, row.output, row.cacheRead, row.cacheWrite, row.totalTokens ?? null, row.provenance ?? 'unknown', row.cacheSemantics ?? null, row.outcome ?? null)
    }
    return {
      durable: true,
      mark(session) {
        const row = getMark.get(session)
        return row === undefined ? undefined : { through: row.through, fold: JSON.parse(row.fold), sealed: row.sealed === 1, listed: row.listed ?? null }
      },
      commit(session, { rows, reset, mark }) {
        db.exec('BEGIN')
        try {
          if (reset) {
            dropDetails.run(session)
            dropLogged.run(session)
          }
          for (const row of rows) insert(row, false)
          setMark.run(session, mark.through, JSON.stringify(mark.fold), mark.sealed ? 1 : 0, mark.listed ?? null)
          db.exec('COMMIT')
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      },
      add(row) {
        db.exec('BEGIN')
        try {
          insert(row, true)
          db.exec('COMMIT')
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      },
      owners: () => new Map(allOwners.all().map(row => [row.session, { owner: row.owner, name: row.name }])),
      setOwner: (session, owner) => putOwner.run(session, owner.owner, owner.name),
      kinds: () => new Map(allKinds.all().map(row => [row.session, row.kind])),
      setKind: (session, kind) => putKind.run(session, kind),
      journal(session, owner, kind) {
        db.exec('BEGIN')
        try {
          if (owner) putOwner.run(session, owner.owner, owner.name)
          if (kind) putKind.run(session, kind)
          db.exec('COMMIT')
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      },
      stats: options => sqliteStats(db, options),
      groups: () => db.prepare(`SELECT c.session, c.provider, c.model, c.kind, c.time / ${SLOT_MS} AS slot, SUM(c.input) AS input, SUM(c.cache_read) AS cacheRead, SUM(c.cache_write) AS cacheWrite, SUM(c.output) AS output, COUNT(*) AS calls FROM calls c LEFT JOIN usage_details d ON c.key = d.key WHERE d.key IS NULL OR d.input IS NOT NULL OR d.output IS NOT NULL OR d.cache_read IS NOT NULL OR d.cache_write IS NOT NULL GROUP BY c.session, c.provider, c.model, c.kind, slot`).all().map(row => ({ ...row, slot: Number(row.slot) })),
      close: () => db.close(),
    }
  } catch (error) {
    db.close()
    throw error
  }
}

// Every hour bucket in one time zone, as `YYYY-MM-DD HH`.
export function hourKeys(timeZone) {
  let format
  try {
    format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
  } catch {
    format = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
  }
  const cache = new Map()
  return (time) => {
    const slot = Math.floor(time / SLOT_MS)
    let key = cache.get(slot)
    if (key === undefined) {
      const part = Object.fromEntries(format.formatToParts(new Date(slot * SLOT_MS)).map(({ type, value }) => [type, value]))
      key = `${part.year}-${part.month}-${part.day} ${part.hour}`
      cache.set(slot, key)
    }
    return key
  }
}

async function eachLimited(items, limit, work) {
  let next = 0
  const lane = async () => {
    while (next < items.length) {
      const item = items[next]
      next += 1
      await work(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
}

export function install(rt) {
  const { ctx, home, state } = rt
  const path = join(home, 'usage.sqlite')

  let ledger
  let opening
  // Metered calls that finish before the ledger opens.
  const early = []
  let writeFailed = false
  function flushPending(book) {
    while (early.length > 0) {
      try {
        book.add(early[0])
        early.shift()
      } catch (error) {
        writeFailed = true
        rt.warn('ds-bot: usage could not record a call: %s', error)
        return book
      }
    }
    writeFailed = false
    return book
  }
  function openLedger() {
    if (ledger !== undefined) return Promise.resolve(flushPending(ledger))
    const job = opening ??= (async () => {
      let DatabaseSync
      try {
        ({ DatabaseSync } = await import('node:sqlite'))
        await mkdir(home, { recursive: true })
      } catch (error) {
        rt.warn('omni-ui: usage is kept in memory only: %s', error)
        return memoryLedger()
      }
      try {
        return sqliteLedger(DatabaseSync, path)
      } catch (error) {
        // Even damage may leave irreplaceable auxiliary history recoverable.
        // Never delete a ledger as a side effect of opening a statistics view.
        rt.warn('ds-bot: usage is kept in memory only: %s', error)
        return memoryLedger()
      }
    })().then((opened) => {
      // The plugin may have been disposed while the file opened.
      if (opening !== job) {
        opened.close()
        return memoryLedger()
      }
      return ledger = flushPending(opened)
    })
    return job
  }
  ctx.effect(() => () => {
    ledger?.close()
    ledger = undefined
    opening = undefined
  }, 'omni-ui: usage ledger')

  // Who each Session's calls belong to, from the team as it is now. Sessions forked or
  // spawned under one belong to the same owner, and a parent the team has lost
  // (a deleted Bot) still passes its journaled owner down the chain.
  function liveOwners(listed, stored) {
    const owners = new Map()
    const botOwner = bot => ({ owner: bot.id, name: bot.name })
    for (const bot of Object.values(state.bots ?? {})) {
      for (const sessionId of [bot.id, rt.chatOf(bot.id), ...(bot.segments ?? []).map(segment => segment.sessionId)]) owners.set(sessionId, botOwner(bot))
    }
    for (const room of Object.values(state.rooms ?? {})) {
      for (const sessionId of [rt.sessionOfRoom(room), ...(room.parts ?? []).map(segment => segment.sessionId)].filter(Boolean)) owners.set(sessionId, { owner: `room:${room.id}`, name: room.name })
      const memberOwner = botId => ({ owner: botId, name: rt.botOf(botId)?.name ?? '' })
      for (const [botId, sessionId] of Object.entries(room.sessions ?? {})) owners.set(sessionId, memberOwner(botId))
      for (const [botId, segments] of Object.entries(room.segments ?? {})) {
        for (const segment of segments) owners.set(segment.sessionId, memberOwner(botId))
      }
    }
    // The DSH Agent is part of the team: its Sessions count beside the Bots, not
    // with the other sessions.
    for (const agent of Object.values(state.agents ?? {})) {
      for (const sessionId of agent.sessions ?? []) owners.set(sessionId, { owner: `agent:${agent.id}`, name: agent.name })
    }
    for (const [sessionId, task] of Object.entries(state.tasks ?? {})) {
      const bot = rt.botOf(task.from)
      if (bot) owners.set(sessionId, botOwner(bot))
    }
    const parents = new Map((listed ?? []).filter(item => item.parentSessionId).map(item => [item.sessionId, item.parentSessionId]))
    for (const sessionId of parents.keys()) {
      let root = sessionId
      for (let depth = 0; parents.has(root) && depth < 32; depth += 1) root = parents.get(root)
      if (owners.has(sessionId)) continue
      const found = owners.get(root) ?? stored?.get(root)
      if (found !== undefined) owners.set(sessionId, found)
    }
    return owners
  }

  let listed = []
  let scanning
  let scannedAt = 0

  // Sessions that speak inside a group chat, from the rooms as they are now.
  const inGroup = () => new Set(Object.values(state.rooms ?? {}).flatMap(room => [
    ...Object.values(room.sessions ?? {}),
    ...Object.values(room.segments ?? {}).flat().map(segment => segment.sessionId),
  ]))

  // DSH reads a subagent Session only through its parent's address; the parent
  // need not exist any more. One with no parent on record cannot be read.
  const addressOf = item => (item.origin !== 'subagent'
    ? { kind: 'session', sessionId: item.sessionId }
    : item.parentSessionId === undefined
      ? undefined
      : { kind: 'subagent', parentSessionId: item.parentSessionId, childSessionId: item.sessionId, mode: 'unknown' })
  // Sessions that already failed to read, so each one warns once, not every scan.
  const unreadable = new Set()
  const unresolved = new Set()
  let listingFailed = true
  let scanFailed = false

  async function scanSession(ledger, address, asOfSeq, seal, signal) {
    const sessionId = address.kind === 'session' ? address.sessionId : address.childSessionId
    const mark = ledger.mark(sessionId)
    // A seal stands only while the listing shows the watermark it was sealed at, so a
    // cold Session whose log grew since is read again.
    if (mark?.sealed && seal !== undefined && mark.listed === seal.listed) return true
    let through = asOfSeq
    if (through === undefined) {
      const projections = await ctx.sessionController.projections({ sessionId }, signal)
      if (projections === null || projections === undefined) return false
      through = projections.asOfSeq
    }
    const from = mark?.through ?? -1
    if (!Number.isSafeInteger(through) || through < from) return false
    if (through === from) {
      // Nothing new to read: a warm Session's seal is cleared, and a cold one is sealed again at its watermark.
      if (mark !== undefined && (seal !== undefined || mark.sealed)) ledger.commit(sessionId, { rows: [], reset: false, mark: { ...mark, ...sealFields(seal) } })
      return true
    }
    const events = []
    let beforeSeq
    for (let reached = false; !reached;) {
      const page = await ctx.sessionController.page({
        address,
        throughSeq: through,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
        maxMessages: PAGE_MESSAGES,
      }, AbortSignal.any([signal, AbortSignal.timeout(PAGE_TIMEOUT_MS)]))
      const got = page.records.map(record => record.event)
      for (let index = got.length - 1; index >= 0; index -= 1) {
        if (got[index].seq <= from) {
          reached = true
          break
        }
        events.push(got[index])
      }
      if (!page.hasMore || got.length === 0) break
      if (beforeSeq !== undefined && got[0].seq >= beforeSeq) throw new Error(`the history of ${sessionId} did not advance`)
      beforeSeq = got[0].seq
    }
    events.reverse()
    if (events.length !== through - from || events.some((event, index) => event.seq !== from + index + 1)) throw new Error(`the history of ${sessionId} came back with a gap`)
    const fold = foldCalls(events, mark?.fold)
    ledger.commit(sessionId, {
      rows: fold.rows.map(row => ({
        ...row, key: `${sessionId}#${row.key}`, session: sessionId, kind: 'turn',
        requestId: identity('request', sessionId, row.turn, row.step),
        turnId: identity('turn', sessionId, row.turn),
        attemptId: identity('attempt', sessionId, row.turn, row.step, row.retryOrdinal),
      })),
      reset: fold.reset,
      mark: { through, fold: fold.state, ...sealFields(seal) },
    })
    return true
  }

  // Catches every known Session up to its log. A part that ended a while ago is
  // complete, so it is sealed and never read again.
  function scan() {
    if (scanning !== undefined) return scanning
    if (Date.now() - scannedAt < RESCAN_AFTER_MS) return Promise.resolve()
    const job = (async () => {
      const ledger = await openLedger()
      await rt.load()
      const signal = AbortSignal.timeout(SCAN_TIMEOUT_MS)
      try {
        listed = (await ctx.sessionController.list({}, signal)).items ?? []
        listingFailed = false
      } catch (error) {
        listingFailed = true
        rt.warn('ds-bot: usage could not list the Sessions: %s', error)
      }
      const stored = ledger.owners()
      const owners = liveOwners(listed, stored)
      for (const [sessionId, owner] of owners) {
        const before = stored.get(sessionId)
        if (owner.name !== '' && (before?.owner !== owner.owner || before?.name !== owner.name)) ledger.setOwner(sessionId, owner)
      }
      // Group membership vanishes with the room, but a call that happened in a
      // group chat must stay one, so the kind is remembered like the owner is.
      const storedKinds = ledger.kinds()
      const observedKinds = new Map([...inGroup()].map(id => [id, 'group']))
      for (const item of listed) if (item.origin === 'subagent') observedKinds.set(item.sessionId, 'child')
      for (const sessionId of Object.keys(state.tasks ?? {})) observedKinds.set(sessionId, 'task')
      for (const [sessionId, kind] of observedKinds) if (storedKinds.get(sessionId) !== kind) ledger.setKind(sessionId, kind)
      const ended = new Set()
      const longAgo = Date.now() - SEAL_AFTER_MS
      for (const bot of Object.values(state.bots)) for (const segment of bot.segments ?? []) if (segment.endedAt < longAgo) ended.add(segment.sessionId)
      for (const room of Object.values(state.rooms ?? {})) {
        for (const segments of Object.values(room.segments ?? {})) for (const segment of segments) if (segment.endedAt < longAgo) ended.add(segment.sessionId)
      }
      // A listing row's projections are hints, not cursors. Only a 'sequenced'
      // block shares the Session log's sequence space; a 'cached' block carries
      // the persisted cache's own watermark, so it must not cut a page. The
      // Session's exact cursor is read below when no hint is usable.
      const listedCursor = item => (item.projections?.kind === 'sequenced' ? item.projections.asOfSeq : undefined)
      // A Session with no Agent attached is cold. Its listing carries the watermark of its
      // checkpoint, which DSH rewrites at each turn end and when the Session is detached, so
      // the watermark moves when the log does. A cold Session seals at that watermark only:
      // the watermark is compared with an earlier listing, never with a log sequence.
      const coldWatermarks = new Map(listed
        .filter(item => item.agentAvailable !== true && item.running !== true && item.projections?.kind === 'cached' && Number.isSafeInteger(item.projections.asOfSeq))
        .map(item => [item.sessionId, item.projections.asOfSeq]))
      // An ended part is complete, so it seals for good.
      const sealOf = sessionId => (ended.has(sessionId) ? { listed: null } : coldWatermarks.has(sessionId) ? { listed: coldWatermarks.get(sessionId) } : undefined)
      const targets = new Map()
      for (const item of listed) if (item.blank !== true) targets.set(item.sessionId, listedCursor(item))
      for (const sessionId of new Set([...stored.keys(), ...owners.keys()])) if (!targets.has(sessionId)) targets.set(sessionId, undefined)
      const addresses = new Map(listed.map(item => [item.sessionId, addressOf(item)]))
      let cut = 0
      const failed = []
      await eachLimited([...targets], SCAN_PARALLEL, async ([sessionId, asOfSeq]) => {
        if (signal.aborted) {
          cut += 1
          return
        }
        const address = addresses.has(sessionId) ? addresses.get(sessionId) : { kind: 'session', sessionId }
        if (address === undefined) {
          unresolved.add(sessionId)
          return
        }
        try {
          const complete = await scanSession(ledger, address, asOfSeq, sealOf(sessionId), signal)
          if (complete) unresolved.delete(sessionId)
          else unresolved.add(sessionId)
          unreadable.delete(sessionId)
        } catch (error) {
          // The scan timeout cancels the reads still open. Those Sessions are not broken,
          // so they are counted with the ones it never reached, not remembered as unreadable.
          if (signal.aborted) {
            cut += 1
            return
          }
          if (unreadable.has(sessionId)) return
          unreadable.add(sessionId)
          failed.push([sessionId, error])
        }
      })
      // One line for the whole scan, not one per Session it could not read.
      const missed = failed.length + cut
      if (missed > 0) {
        rt.warn('omni-ui: usage could not read %d Session%s%s%s', missed, missed === 1 ? '' : 's',
          cut > 0 ? ' before the scan ran out of time' : '',
          failed.length > 0 ? `: ${failed.map(([sessionId]) => sessionId).join(', ')} (first error: ${failed[0][1]})` : '')
      }
      scanFailed = false
    })().catch(error => {
      scanFailed = true
      throw error
    }).finally(() => {
      scannedAt = Date.now()
      scanning = undefined
    })
    scanning = job
    return job
  }

  // Tokens per hour, owner, model, and use, for the browser to sum by day, week, or month.
  async function usageView({ timeZone } = {}) {
    const job = scan().catch(error => rt.warn('omni-ui: usage scan failed: %s', error))
    let timer
    await Promise.race([job, new Promise((resolve) => { timer = setTimeout(resolve, VIEW_WAIT_MS) })])
    clearTimeout(timer)
    const ledger = await openLedger()
    const stored = ledger.owners()
    const live = liveOwners(listed, stored)
    const hourOf = hourKeys(typeof timeZone === 'string' ? timeZone : undefined)
    // A deleted Bot or group keeps the name it had when its calls were last read.
    const describe = (key, name) => {
      if (key === 'other') return { key, kind: 'other' }
      if (key.startsWith('room:')) {
        const id = key.slice('room:'.length)
        const room = rt.roomOf(id)
        return { key, kind: 'room', id, name: room?.name ?? name, ...(room ? {} : { deleted: true }) }
      }
      if (key.startsWith('agent:')) {
        const id = key.slice('agent:'.length)
        const agent = rt.own(state.agents, id)
        return { key, kind: 'agent', id, name: agent?.name ?? name, ...(agent ? {} : { deleted: true }) }
      }
      const bot = rt.botOf(key)
      return { key, kind: 'bot', id: key, name: bot?.name ?? name, ...(bot ? {} : { deleted: true }) }
    }
    const owners = []
    const ownerIndex = new Map()
    const ownerOf = (sessionId) => {
      const found = live.get(sessionId) ?? stored.get(sessionId)
      const key = found?.owner ?? 'other'
      if (!ownerIndex.has(key)) {
        ownerIndex.set(key, owners.length)
        owners.push(describe(key, found?.name ?? ''))
      }
      return ownerIndex.get(key)
    }
    const catalog = rt.cachedCatalog()
    const models = []
    const modelIndex = new Map()
    const modelOf = (provider, model) => {
      const key = `${provider}/${model}`
      if (!modelIndex.has(key)) {
        modelIndex.set(key, models.length)
        const entry = catalog.find(item => item.ref === key)
        models.push({ key, provider, model, name: entry?.name ?? model, ...(entry?.providerName ? { providerName: entry.providerName } : {}) })
      }
      return modelIndex.get(key)
    }
    const kinds = []
    const kindIndex = new Map()
    const kindOf = (kind) => {
      if (!kindIndex.has(kind)) {
        kindIndex.set(kind, kinds.length)
        kinds.push(kind)
      }
      return kindIndex.get(kind)
    }
    const groupSessions = inGroup()
    const buckets = new Map()
    const storedKinds = ledger.kinds()
    for (const group of ledger.groups()) {
      const kind = group.kind === 'turn' ? (groupSessions.has(group.session) || storedKinds.get(group.session) === 'group' ? 'group' : 'chat') : group.kind
      const row = [hourOf(group.slot * SLOT_MS), ownerOf(group.session), modelOf(group.provider, group.model), kindOf(kind)]
      const id = row.join('\n')
      const bucket = buckets.get(id) ?? [...row, 0, 0, 0, 0, 0]
      bucket[4] += group.input
      bucket[5] += group.cacheRead
      bucket[6] += group.cacheWrite
      bucket[7] += group.output
      bucket[8] += group.calls
      buckets.set(id, bucket)
    }
    return {
      owners,
      models,
      kinds,
      // [hour, owner, model, kind, input, cacheRead, cacheWrite, output, calls]
      rows: [...buckets.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
      now: hourOf(Date.now()),
      scanning: scanning !== undefined,
    }
  }

  // A read refreshes only this derived ledger. It never creates or mutates a
  // Session, changes a setting, or starts a model request.
  async function usageStats(botId, { sessionId } = {}) {
    const refuse = (code, message) => { throw Object.assign(new Error(message), { code }) }
    if (typeof botId !== 'string' || botId === '') refuse('bot/invalid', 'A Bot id is required')
    if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId === '')) refuse('bot/invalid', 'Invalid Session id')
    await rt.load()
    if (!rt.botOf(botId)) refuse('bot/not-found', 'Bot not found')
    const job = scan().catch(error => rt.warn('ds-bot: usage scan failed: %s', error))
    let timer
    try {
      await Promise.race([job, new Promise(resolve => { timer = setTimeout(resolve, VIEW_WAIT_MS) })])
    } finally {
      clearTimeout(timer)
    }
    const book = await openLedger()
    if (!rt.botOf(botId)) refuse('bot/not-found', 'Bot not found')
    const bot = rt.botOf(botId)
    const selected = sessionId ?? rt.chatOf(botId)
    const ownChat = new Set([rt.chatOf(botId), ...(bot.segments ?? []).map(segment => segment.sessionId)])
    const owners = new Map([...book.owners(), ...liveOwners(listed, book.owners())])
    if (!ownChat.has(selected) || owners.get(selected)?.owner !== botId) refuse('bot/invalid', 'Session is not this Bot’s own chat or an earlier part')
    const owned = id => owners.get(id)?.owner === botId
    const unreadableSessionIds = [...unreadable].filter(owned).sort()
    const unresolvedSessionIds = [...unresolved].filter(owned).sort()
    const busy = scanning !== undefined
    const partial = !book.durable || writeFailed || listingFailed || scanFailed || unreadableSessionIds.length > 0 || unresolvedSessionIds.length > 0
    const kinds = new Map(book.kinds())
    for (const id of inGroup()) kinds.set(id, 'group')
    return book.stats({
      botId, sessionId: selected, owners, kinds, pending: early, scanning: busy,
      coverage: { status: busy ? 'scanning' : partial ? 'partial' : 'complete', unreadableSessionIds, unresolvedSessionIds },
    }, AbortSignal.timeout(VIEW_WAIT_MS))
  }

  // DS Bot tags the requests it makes outside a Session with the Session they serve.
  const tags = new WeakMap()
  const tagUsage = (messages, tag) => {
    if (messages !== null && typeof messages === 'object') tags.set(messages, tag)
    return messages
  }
  const carryUsageTag = (from, to) => {
    const tag = from !== null && typeof from === 'object' ? tags.get(from) : undefined
    if (tag !== undefined) tagUsage(to, tag)
  }
  // Omni's own requests name the Session they serve, as some routes require, so
  // `sessionId` alone does not make a request that Session's own round; the tag does.
  const ownRequest = options => tags.has(options?.messages)
  // Capture ownership and positively observed use before any await: task records
  // are bounded and may be evicted before load/open or the first statistics scan.
  const observedKind = sessionId => state.tasks?.[sessionId] && rt.botOf(state.tasks[sessionId].from) ? 'task'
    : listed.some(item => item.sessionId === sessionId && item.origin === 'subagent') ? 'child'
      : inGroup().has(sessionId) ? 'group' : undefined
  const journaled = new Map()
  const journal = (book, sessionId, captured) => {
    const owner = captured.owner ?? liveOwners(listed, book.owners()).get(sessionId)
    const kind = captured.kind ?? observedKind(sessionId)
    const validOwner = owner !== undefined && owner.name !== '' ? owner : undefined
    const stamp = validOwner ? `${validOwner.owner}\n${validOwner.name}` : undefined
    const ownerChanged = stamp !== undefined && journaled.get(sessionId) !== stamp
    const kindChanged = kind !== undefined && journaled.get(`${sessionId}\nkind`) !== kind
    if (!ownerChanged && !kindChanged) return
    // Owner and category are one durable unit, not an owner-only record that
    // would silently become foreground chat after a crash or metadata eviction.
    book.journal(sessionId, ownerChanged ? validOwner : undefined, kindChanged ? kind : undefined)
    if (ownerChanged) journaled.set(sessionId, stamp)
    if (kindChanged) journaled.set(`${sessionId}\nkind`, kind)
  }
  // Plain foreground requests skip the stream meter, but still journal their
  // billing identity immediately. Already loaded ownership needs no async load.
  const noteSession = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return
    const captured = { owner: liveOwners(listed, ledger?.owners()).get(sessionId), kind: observedKind(sessionId) }
    void (async () => {
      if (captured.owner === undefined) await rt.load()
      const book = ledger ?? await openLedger().catch(() => undefined)
      if (book === undefined) return
      try { journal(book, sessionId, captured) } catch (error) { rt.warn('ds-bot: usage could not journal %s: %s', sessionId, error) }
    })()
  }
  function record({ sessionId, kind, provider, model, usage, response, tag, invocation, outcome }) {
    noteSession(sessionId)
    const row = {
      key: `live:${identity('aux-key', sessionId ?? '', tag?.attemptId ?? invocation)}`, session: sessionId ?? '', time: Date.now(), provider: provider ?? '', model: model ?? '', kind,
      usageReported: usage !== undefined && usage !== null,
      requestId: tag?.requestId ?? identity('aux-request', sessionId ?? '', invocation),
      attemptId: tag?.attemptId ?? identity('aux-attempt', sessionId ?? '', invocation),
      turnId: tag?.turnId ?? null, retryOrdinal: 0, provenance: provenanceOf(response), outcome,
      ...normalizeUsage(usage, response),
    }
    if (ledger !== undefined) {
      try { ledger.add(row) } catch (error) {
        writeFailed = true
        early.push(row)
        rt.warn('ds-bot: usage could not record a call: %s', error)
      }
      return
    }
    early.push(row)
    void openLedger().catch(() => {})
  }

  // A request listener that rewrites a request starts it over, so the same usage chunk
  // can pass here twice; it counts once.
  const counted = new WeakSet()
  const meterContext = new AsyncLocalStorage()
  // Mark recursive/rewrite waterfalls as wrappers, not additional attempts. Run
  // each iterator operation inside its own scope so concurrent calls stay separate,
  // including failed/empty streams with no usage-object identity to deduplicate.
  async function* contextual(source, scope) {
    const iterator = source[Symbol.asyncIterator]()
    let done = false
    try {
      while (!done) {
        const step = await meterContext.run(scope, () => iterator.next())
        done = step.done
        if (!done) yield step.value
      }
    } finally {
      if (!done) await meterContext.run(scope, () => iterator.return?.())
    }
  }
  // A Session's own requests are in its log; every other request is metered here.
  ctx.on('llm/stream', (options, next) => {
    const tag = tags.get(options.messages)
    noteSession(tag?.sessionId ?? options.sessionId)
    if (tag === undefined && options.sessionId !== undefined && options.purpose === undefined) return next()
    return (async function* meter() {
      const parent = meterContext.getStore()
      if (parent) parent.delegated = true
      const scope = { delegated: false }
      const invocation = randomUUID()
      let usage
      let response
      let sawUsage = false
      let outcome = 'interrupted'
      try {
        for await (const chunk of contextual(meterContext.run(scope, next), scope)) {
          if (chunk?.type === 'usage' && chunk.usage && typeof chunk === 'object') {
            sawUsage = true
            if (!counted.has(chunk)) {
              counted.add(chunk)
              usage = chunk.usage
            }
          }
          if (chunk?.type === 'finish') {
            response = chunk.replayState?.response
            outcome = chunk.reason?.kind ?? 'finished'
          }
          yield chunk
        }
        if (outcome === 'interrupted') outcome = 'ended'
      } finally {
        // An outer rewritten stream sees the same usage objects, already owned
        // by the inner invocation. No usage at all is an observed unknown attempt.
        if (!scope.delegated && (usage !== undefined || !sawUsage)) record({ sessionId: tag?.sessionId ?? options.sessionId, kind: tag?.kind ?? options.purpose ?? 'other', provider: options.provider, model: options.model, usage, response, tag, invocation, outcome })
      }
    })()
  })

  Object.assign(rt, { usageView, usageStats, tagUsage, carryUsageTag, ownRequest })
}
