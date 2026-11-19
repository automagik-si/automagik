// The shared gen-UI kit's host half (#1326, G0): the live slice every kit card reads, and
// the media route a kit card shows bytes from. Other Omni plugins publish a batch's rows
// into the slice through rt.hooks.genui, and every state answer carries it on the 1.5 s
// live hook (extend.js has the hook list). A row holds labels and counts only, never
// message text: publish() rebuilds each row from the fields it knows, so a text field a
// plugin happens to pass is left out rather than copied to every window.
//
//   publish(batchId, row)   one chat's row, merged by chatId; the newest publish wins
//   read(batchId)           a copy of one batch, or undefined
//   clear(batchId)          a batch from a proposal no longer open
//   media.register(name, fn) rt.hooks.media: a source the media route serves bytes from
//
// `revision` goes up on every change; a person card or a row list that wants to refresh
// while the bot works can watch it.
import { GENUI_MEDIA_ROUTE } from './constants.js'

// A batch keeps at most this many rows, and the slice this many batches, so a long-lived
// host answers small forever. A running row leaves after a finished one when the cap hits.
export const GENUI_MAX_ROWS = 20
export const GENUI_MAX_BATCHES = 8
// A row still moving: the slice keeps its finished rows too, but drops them first.
const ACTIVE = new Set(['queued', 'reading', 'fetching'])

const BATCH_ID = /^[\w.:-]{1,64}$/
const MEDIA_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/
const MEDIA_ID_MAX = 300
// What a card may show of a chat's media. Anything else (a page, a script) is refused.
export const MEDIA_TYPES = Object.freeze([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/webm',
])
const MEDIA_TYPE = new Set(MEDIA_TYPES)
const STATES = new Set(['queued', 'reading', 'fetching', 'done', 'phone-did-not-answer', 'cancelled', 'failed'])
const OUTCOMES = new Set(['done', 'phone-did-not-answer', 'stopped', 'failed', 'not-started'])
const COUNT_KEYS = ['fetched', 'total', 'totalEstimated', 'stored', 'duplicates', 'mediaDownloaded', 'mediaMissing', 'reactions', 'edits', 'deletions', 'unmatched']
const COVERAGE_TIMES = ['oldest', 'newest', 'lastInbound', 'lastOutbound']
const COVERAGE_COUNTS = ['count', 'countInWindow', 'mediaMissing', 'deletedCount']
// A short label: control and format characters are dropped (a label is one line), then it
// is cut. Only a label or an id ever comes back, never the text a message held.
const clip = (value, max) => {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, '').replace(/\s+/g, ' ').trim()
  return text === '' ? undefined : text.slice(0, max)
}
const integer = (value) => {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) && number >= 0 ? Math.min(Math.floor(number), 1e12) : undefined
}
const iso = (value) => {
  if (typeof value !== 'string') return undefined
  return Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : undefined
}

function coverageOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const coverage = {}
  for (const key of COVERAGE_TIMES) {
    const when = iso(value[key])
    if (when !== undefined) coverage[key] = when
  }
  for (const key of COVERAGE_COUNTS) {
    const count = integer(value[key])
    if (count !== undefined) coverage[key] = count
  }
  return Object.keys(coverage).length === 0 ? undefined : coverage
}

function countsOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const counts = {}
  for (const key of COUNT_KEYS) {
    // `totalEstimated` is Omni's own name for the estimate a fetch runs against.
    const count = integer(value[key])
    if (count !== undefined) counts[key === 'totalEstimated' ? 'total' : key] = count
  }
  return Object.keys(counts).length === 0 ? undefined : counts
}

// The two fields Omni's channels plugin publishes for the backfill card (#1326 K2): the
// open proposals on the team view, and the live runs on every state answer. Like a kit row,
// they are rebuilt from the labels, dates, states and counts the card draws: a chat preview
// or a message text a caller passed, and a field the card does not know, never reach a
// window. A proposal or a run without its id names no card and is left out.
const BACKFILL_ID_MAX = 200
const BACKFILL_CHATS_MAX = 200
const BACKFILL_ROWS_MAX = 200
// The card draws every open proposal and the newest three runs (BACKFILL_RUNS_SHOWN in the
// model), so the slice publishes at most this many of each. Twenty leaves room for a busy
// team's open proposals and for the runs the card counts beyond the three it draws, and
// with the per-element caps it keeps the published slice small even when every run is full.
export const GENUI_MAX_BACKFILL_PROPOSALS = 20
export const GENUI_MAX_BACKFILL_RUNS = 20
const BACKFILL_STATES = new Set(['queued', 'fetching', 'done', 'phone-did-not-answer', 'cancelled', 'failed'])
const BACKFILL_OUTCOMES = new Set(['done', 'phone-did-not-answer', 'stopped', 'failed', 'not-started'])
const BACKFILL_SUMMARY = ['total', 'running', 'done', 'phoneDidNotAnswer', 'stopped', 'failed']
const backfillId = value => clip(value, BACKFILL_ID_MAX)
// A millisecond timestamp (the runs') or an ISO time (the reading rows').
const stampOf = (value) => {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.min(Math.floor(value), 1e15)
  const when = iso(value)
  return when === undefined ? undefined : Date.parse(when)
}

export function backfillProposalOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const id = backfillId(value.id)
  if (id === undefined) return undefined
  const proposal = { id }
  const botId = backfillId(value.botId)
  if (botId !== undefined) proposal.botId = botId
  for (const key of ['from', 'to']) {
    if (value[key] === null) proposal[key] = null
    else {
      const when = iso(value[key])
      if (when !== undefined) proposal[key] = when
    }
  }
  const createdAt = stampOf(value.createdAt)
  if (createdAt !== undefined) proposal.createdAt = createdAt
  const chats = []
  for (const entry of Array.isArray(value.chats) ? value.chats.slice(0, BACKFILL_CHATS_MAX) : []) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const chatId = backfillId(entry.id)
    if (chatId === undefined) continue
    const chat = { id: chatId, ticked: entry.ticked === true }
    const name = clip(entry.name, 120)
    if (name !== undefined) chat.name = name
    const kind = clip(entry.kind, 24)
    if (kind !== undefined) chat.kind = kind
    const channelId = backfillId(entry.channelId)
    if (channelId !== undefined) chat.channelId = channelId
    const channel = clip(entry.channel, 120)
    if (channel !== undefined) chat.channel = channel
    chats.push(chat)
  }
  proposal.chats = chats
  return proposal
}

function backfillRowOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const chatId = backfillId(value.chatId)
  if (chatId === undefined) return undefined
  const row = { chatId }
  const chat = clip(value.chat ?? value.name, 120)
  if (chat !== undefined) row.chat = chat
  const channelId = backfillId(value.channelId)
  if (channelId !== undefined) row.channelId = channelId
  if (value.jobId === null) row.jobId = null
  else {
    const jobId = backfillId(value.jobId)
    if (jobId !== undefined) row.jobId = jobId
  }
  if (BACKFILL_STATES.has(value.state)) row.state = value.state
  if (value.outcome === null) row.outcome = null
  else if (BACKFILL_OUTCOMES.has(value.outcome)) row.outcome = value.outcome
  const round = integer(value.round)
  if (round !== undefined && round > 0) row.round = round
  if (value.oldestReached === null) row.oldestReached = null
  else {
    const oldestReached = iso(value.oldestReached)
    if (oldestReached !== undefined) row.oldestReached = oldestReached
  }
  const counts = countsOf(value.counts !== null && typeof value.counts === 'object' && !Array.isArray(value.counts) ? value.counts : value)
  if (counts !== undefined) row.counts = counts
  if (value.coverage === null) row.coverage = null
  else {
    const coverage = coverageOf(value.coverage)
    if (coverage !== undefined) row.coverage = coverage
  }
  for (const key of ['startedAt', 'updatedAt']) {
    const when = stampOf(value[key])
    if (when !== undefined) row[key] = when
  }
  return row
}

export function backfillRunOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const id = backfillId(value.id)
  if (id === undefined) return undefined
  const run = { id }
  const botId = backfillId(value.botId)
  if (botId !== undefined) run.botId = botId
  for (const key of ['from', 'to']) {
    if (value[key] === null) run[key] = null
    else {
      const when = iso(value[key])
      if (when !== undefined) run[key] = when
    }
  }
  const startedAt = stampOf(value.startedAt)
  if (startedAt !== undefined) run.startedAt = startedAt
  if (value.summary !== null && typeof value.summary === 'object' && !Array.isArray(value.summary)) {
    const summary = {}
    for (const key of BACKFILL_SUMMARY) {
      const count = integer(value.summary[key])
      if (count !== undefined) summary[key] = count
    }
    if (Object.keys(summary).length > 0) run.summary = summary
  }
  const rows = []
  for (const entry of Array.isArray(value.rows) ? value.rows.slice(0, BACKFILL_ROWS_MAX) : []) {
    const row = backfillRowOf(entry)
    if (row !== undefined) rows.push(row)
  }
  run.rows = rows
  return run
}

function cappedBackfillEntries(values, limit, sanitize) {
  if (!Array.isArray(values)) return []
  const accepted = []
  for (let index = 0; index < values.length; index += 1) {
    const entry = sanitize(values[index])
    if (entry === undefined) continue
    accepted.push(entry)
    if (accepted.length === limit) break
  }
  return accepted
}

/**
 * Wraps the view and live hooks a plugin registers, so the two kit fields are rebuilt on
 * their way into the team's answers. Every other field a hook returns passes through as it
 * was; a hook that returns no backfill field is left alone.
 */
export function guardBackfillFields(hooks) {
  for (const name of ['view', 'live']) {
    const register = hooks?.[name]
    if (typeof register !== 'function') continue
    hooks[name] = fn => register(() => {
      const value = fn()
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
      const hasProposals = Object.hasOwn(value, 'omniBackfillProposals')
      const hasRuns = Object.hasOwn(value, 'omniBackfills')
      if (!hasProposals && !hasRuns) return value
      const out = { ...value }
      if (hasProposals) out.omniBackfillProposals = cappedBackfillEntries(value.omniBackfillProposals, GENUI_MAX_BACKFILL_PROPOSALS, backfillProposalOf)
      if (hasRuns) out.omniBackfills = cappedBackfillEntries(value.omniBackfills, GENUI_MAX_BACKFILL_RUNS, backfillRunOf)
      return out
    })
  }
  return hooks
}

// One row, rebuilt from the fields a card draws. A row without a chat id names nothing to
// merge into, so it is left out.
export function rowOf(run) {
  if (run === null || typeof run !== 'object' || Array.isArray(run)) return undefined
  const chatId = clip(run.chatId, 200)
  if (chatId === undefined) return undefined
  const row = { chatId }
  const chat = clip(run.chat ?? run.name, 120)
  if (chat !== undefined) row.chat = chat
  const channelId = clip(run.channelId, 200)
  if (channelId !== undefined) row.channelId = channelId
  if (STATES.has(run.state)) row.state = run.state
  if (OUTCOMES.has(run.outcome)) row.outcome = run.outcome
  for (const key of ['page', 'pages', 'round']) {
    const value = integer(run[key])
    if (value !== undefined && value > 0) row[key] = value
  }
  const oldestReached = iso(run.oldestReached)
  if (oldestReached !== undefined) row.oldestReached = oldestReached
  // A row published before the counts were nested under `counts` still carries them flat.
  const counts = countsOf(run.counts !== null && typeof run.counts === 'object' && !Array.isArray(run.counts) ? run.counts : run)
  if (counts !== undefined) row.counts = counts
  const coverage = coverageOf(run.coverage)
  if (coverage !== undefined) row.coverage = coverage
  for (const key of ['startedAt', 'updatedAt']) {
    const when = iso(run[key])
    if (when !== undefined) row[key] = when
  }
  return row
}

// The batch a row belongs to: its rows in the order they last changed, and when it last did.
function rowsOf(batch) {
  return [...batch.rows.values()]
}

function sliceOf(batches, revision) {
  const out = {}
  for (const [id, batch] of batches) out[id] = { updatedAt: batch.updatedAt, rows: rowsOf(batch) }
  return { revision, batches: out }
}

// The route's body for one media request: the source answers `{ type, body }`, and the
// response is that body only when it is one of the media types a card may show.
const isBody = value => typeof value === 'string' || value instanceof ArrayBuffer || ArrayBuffer.isView(value)
  || (typeof ReadableStream !== 'undefined' && value instanceof ReadableStream) || (typeof Blob !== 'undefined' && value instanceof Blob)

function mediaResponse(result) {
  if (result === null || typeof result !== 'object') return new Response('', { status: 404 })
  const type = String(result.type ?? '').toLowerCase()
  if (!MEDIA_TYPE.has(type)) return new Response('', { status: 404 })
  const body = result.body
  if (!isBody(body)) return new Response('', { status: 404 })
  const headers = {
    'content-type': type,
    'cache-control': 'private, max-age=300',
    'x-content-type-options': 'nosniff',
  }
  if (typeof body === 'string' || body instanceof Uint8Array || body instanceof ArrayBuffer) {
    headers['content-length'] = String(typeof body === 'string' ? new TextEncoder().encode(body).length : body.byteLength)
  }
  return new Response(body, { status: 200, headers })
}

const kindOf = error => [error?.code, error?.name].find(value => typeof value === 'string' && /^[\w./-]{1,40}$/.test(value)) ?? 'error'

export function install(rt) {
  const { ctx } = rt
  // The kit fields the backfill card draws are guarded from here on: a plugin's view or
  // live hook cannot carry a preview or an unknown field into a window.
  guardBackfillFields(rt.hooks)
  const batches = new Map()
  let revision = 0
  // A publish nudges the desktop's own feed, at most once per burst: a backfill reports
  // several rows a second, and one `live` event is enough for the window to ask again.
  let nudge
  const nudgeFeed = () => {
    if (nudge !== undefined) return
    nudge = setTimeout(() => {
      nudge = undefined
      rt.publishFeed?.('live', {})
    }, 150)
    nudge.unref?.()
  }

  const publish = (batchId, run) => {
    const id = typeof batchId === 'string' ? batchId : ''
    if (!BATCH_ID.test(id)) return false
    const row = rowOf(run)
    if (row === undefined) return false
    let batch = batches.get(id)
    if (batch === undefined) {
      batch = { rows: new Map(), updatedAt: 0 }
      batches.set(id, batch)
    }
    // A republish updates that chat's row: a field this event does not carry keeps what
    // the row already said (a completion need not repeat every count). The counts and the
    // coverage merge field by field for the same reason; an explicit null clears the field
    // (the plugin says the end, or the coverage, is over), while an omitted or invalid one
    // leaves it. The row goes to the end of the map, so the least recently changed leaves
    // first.
    const previous = batch.rows.get(row.chatId)
    let merged = previous === undefined ? row : { ...previous, ...row }
    if (previous !== undefined && row.counts !== undefined && previous.counts !== undefined) {
      merged.counts = { ...previous.counts, ...row.counts }
    }
    if (previous !== undefined && row.coverage !== undefined && previous.coverage !== undefined) {
      merged.coverage = { ...previous.coverage, ...row.coverage }
    }
    if (run.outcome === null) delete merged.outcome
    if (run.counts === null) delete merged.counts
    if (run.coverage === null) delete merged.coverage
    batch.rows.delete(row.chatId)
    batch.rows.set(row.chatId, merged)
    // Over the cap, a finished row leaves before a running one.
    while (batch.rows.size > GENUI_MAX_ROWS) {
      const entries = [...batch.rows.entries()]
      const finished = entries.find(([, value]) => value.state !== undefined && !ACTIVE.has(value.state))
      batch.rows.delete((finished ?? entries[0])[0])
    }
    batch.updatedAt = Date.now()
    // The newest batch is the last one: the oldest is dropped once the cap is reached.
    batches.delete(id)
    batches.set(id, batch)
    while (batches.size > GENUI_MAX_BATCHES) batches.delete(batches.keys().next().value)
    revision += 1
    nudgeFeed()
    return true
  }
  const read = (batchId) => {
    const batch = typeof batchId === 'string' ? batches.get(batchId) : undefined
    return batch === undefined ? undefined : { updatedAt: batch.updatedAt, rows: rowsOf(batch).map(row => structuredClone(row)) }
  }
  const clear = (batchId) => {
    if (typeof batchId !== 'string' || !batches.delete(batchId)) return false
    revision += 1
    nudgeFeed()
    return true
  }

  rt.hooks.genui = { publish, read, clear }
  ctx.effect(() => rt.hooks.live(() => ({ genui: sliceOf(batches, revision) })), 'omni-ui: genui slice')
  ctx.effect(() => () => clearTimeout(nudge), 'omni-ui: genui feed nudge')

  // A plugin's media, served by id: `GET <GENUI_MEDIA_ROUTE>?source=<name>&id=<id>`. The
  // bytes are the source's, the type is checked here, and a failure says nothing of the
  // source's own errors (they can name a path).
  const sources = new Map()
  rt.hooks.media = {
    register(name, fn) {
      if (!MEDIA_NAME.test(String(name ?? ''))) throw new Error(`omni-ui: a media source needs a name of letters, digits and dashes (got ${JSON.stringify(name)})`)
      if (typeof fn !== 'function') throw new Error(`omni-ui: media source ${name} needs a function`)
      if (sources.has(name)) throw new Error(`omni-ui: media source ${name} is already served`)
      sources.set(name, fn)
      return () => { if (sources.get(name) === fn) sources.delete(name) }
    },
  }
  ctx.effect(() => ctx.connection.fetch.register({
    path: GENUI_MEDIA_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url)
      const name = url.searchParams.get('source') ?? ''
      const id = url.searchParams.get('id') ?? ''
      const source = sources.get(name)
      if (source === undefined || id === '' || id.length > MEDIA_ID_MAX) return new Response('', { status: 404 })
      try {
        return mediaResponse(await source(id, request))
      } catch (error) {
        const kind = kindOf(error)
        rt.noteFailure?.({ source: 'api', text: `genui-media ${name}: ${kind}`, code: kind, stack: error?.stack })
        return new Response('', { status: 500 })
      }
    },
  }), 'omni-ui: genui media route')
}

