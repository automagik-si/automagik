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
    // the row already said (a completion need not repeat every count). The row goes to the
    // end of the map, so the least recently changed is first and leaves first.
    const previous = batch.rows.get(row.chatId)
    batch.rows.delete(row.chatId)
    batch.rows.set(row.chatId, previous === undefined ? row : { ...previous, ...row })
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

