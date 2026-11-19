// The shared gen-UI kit's view model (#1326, G1 and G5): what a row line says, and how a
// person card reads the note the bot wrote. Kept apart from the components so the words and
// the number formats are proved without a browser, and so every plugin draws the same ones.
//
// A row holds labels and counts only (the host's genui.js rebuilds it), never message text:
// nothing here prints a field it does not know. The note is bot-written text, drawn as text.
import { dateLocale, t } from './i18n.js'

// An outcome says how a row that ended went; it wins over the state where the two differ.
const OUTCOME_FIRST = new Set(['stopped', 'not-started'])
const COUNT_KEYS = ['fetched', 'total', 'stored', 'duplicates', 'mediaDownloaded', 'mediaMissing', 'reactions', 'edits', 'deletions', 'unmatched']
const NOTE_MAX = 8000

const genuiNumber = (value) => {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : undefined
}
const genuiInstant = (value) => {
  // A backfill run reports its times in milliseconds; the reading rows report ISO times.
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return new Date(value)
  if (typeof value !== 'string') return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms) : undefined
}
// One short label: a name, never a message. Control and format characters are dropped and
// the rest is cut, as the host does with what it publishes.
const genuiLabel = (value, max = 120) => {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, '').replace(/\s+/g, ' ').trim()
  return text === '' ? undefined : text.slice(0, max)
}

/** A count in the interface's digits and grouping: 4180 → "4,180". */
export function countText(value) {
  const count = genuiNumber(value)
  return count === undefined ? '' : count.toLocaleString(dateLocale())
}

/** How much of a total is fetched, 0-100, or undefined without a total. */
export function percentOf(fetched, total) {
  const done = genuiNumber(fetched)
  const all = genuiNumber(total)
  if (done === undefined || all === undefined || all === 0) return undefined
  return Math.min(100, Math.round((done / all) * 100))
}

/** A day, in the interface's own order: "Nov 1, 2026". */
export function shortDate(value) {
  const date = genuiInstant(value)
  if (date === undefined) return ''
  return new Intl.DateTimeFormat(dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' }).format(date)
}

const genuiMonth = (date, withYear) => new Intl.DateTimeFormat(dateLocale(), { month: 'short', ...(withYear ? { year: 'numeric' } : {}) }).format(date)

/** The months a coverage spans, "Mar–Nov", or the years too when they differ. */
export function spanOf(value) {
  const coverage = coverageOf(value)
  if (coverage === undefined) return ''
  const oldest = genuiInstant(coverage.oldest)
  const newest = genuiInstant(coverage.newest)
  if (oldest === undefined && newest === undefined) return ''
  if (oldest === undefined) return shortDate(coverage.newest)
  if (newest === undefined) return shortDate(coverage.oldest)
  if (oldest.getFullYear() === newest.getFullYear()) return `${genuiMonth(oldest, false)}–${genuiMonth(newest, false)}`
  return `${genuiMonth(oldest, true)} – ${genuiMonth(newest, true)}`
}

/** The coverage fields a card shows, cut to numbers and ISO times; undefined when empty. */
export function coverageOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const coverage = {}
  // The times stay the strings the host sent, already checked as dates.
  for (const key of ['oldest', 'newest', 'lastInbound', 'lastOutbound']) {
    if (genuiInstant(value[key]) !== undefined) coverage[key] = value[key]
  }
  for (const key of ['count', 'countInWindow', 'mediaMissing', 'deletedCount']) {
    const count = genuiNumber(value[key])
    if (count !== undefined) coverage[key] = count
  }
  return Object.keys(coverage).length === 0 ? undefined : coverage
}

/**
 * One coverage line: how much the chat holds, the months it spans, what is deleted and
 * what media Omni no longer has. Empty without a coverage.
 */
export function coverageLine(value) {
  const coverage = coverageOf(value)
  if (coverage === undefined) return ''
  const parts = []
  if (coverage.count !== undefined) parts.push(t('{count} messages', { count: countText(coverage.count) }))
  const span = spanOf(coverage)
  if (span !== '') parts.push(span)
  if ((coverage.deletedCount ?? 0) > 0) parts.push(t('{count} deleted', { count: countText(coverage.deletedCount) }))
  if ((coverage.mediaMissing ?? 0) > 0) parts.push(t('{count} missing media', { count: countText(coverage.mediaMissing) }))
  return parts.join(' · ')
}

/** Last contact each way, from a coverage: "From them Nov 1, 2026 · From you Aug 1, 2026". */
export function contactLine(value) {
  const coverage = coverageOf(value)
  if (coverage === undefined) return ''
  const parts = []
  if (coverage.lastInbound !== undefined) parts.push(t('From them {date}', { date: shortDate(coverage.lastInbound) }))
  if (coverage.lastOutbound !== undefined) parts.push(t('From you {date}', { date: shortDate(coverage.lastOutbound) }))
  return parts.join(' · ')
}

function countsOf(row) {
  const counts = {}
  const read = source => {
    for (const key of COUNT_KEYS) {
      const count = genuiNumber(source[key])
      if (count !== undefined) counts[key] = count
    }
  }
  if (row.counts !== null && typeof row.counts === 'object' && !Array.isArray(row.counts)) read(row.counts)
  // The kit's slice nests the counts; a plugin's own row may still carry them flat.
  if (Object.keys(counts).length === 0) read(row)
  return counts
}

/** The state word of one row: the outcome where it says more, else the state. */
export function stateWord(row) {
  if (row === null || typeof row !== 'object') return ''
  // The words are written here, as literals, so a translator's key scan finds every one.
  switch (row.outcome) {
    case 'stopped': return t('Stopped')
    case 'not-started': return t('Not started')
    default: break
  }
  switch (row.state) {
    case 'queued': return t('Waiting')
    case 'reading': return t('Reading')
    case 'fetching': return t('Fetching')
    case 'done': return t('Done')
    case 'phone-did-not-answer': return t('Phone did not answer')
    case 'cancelled': return t('Stopped')
    case 'failed': return t('Failed')
    default: break
  }
  switch (row.outcome) {
    case 'done': return t('Done')
    case 'phone-did-not-answer': return t('Phone did not answer')
    case 'failed': return t('Failed')
    default: return ''
  }
}

/** What colours the row's dot: done, failed, phone, stopped, work, or nothing yet. */
export function stateId(row) {
  if (row === null || typeof row !== 'object') return 'unknown'
  if (OUTCOME_FIRST.has(row.outcome)) return 'stopped'
  if (row.state === 'done' || row.outcome === 'done') return 'done'
  if (row.state === 'failed' || row.outcome === 'failed') return 'failed'
  if (row.state === 'phone-did-not-answer' || row.outcome === 'phone-did-not-answer') return 'phone'
  if (row.state === 'cancelled') return 'stopped'
  if (row.state !== undefined) return 'work'
  return 'unknown'
}

function pageText(row) {
  const page = genuiNumber(row.page)
  if (page === undefined || page === 0) return ''
  const pages = genuiNumber(row.pages)
  if (pages !== undefined && pages >= page) return t('Page {page} of about {pages}', { page: countText(page), pages: countText(pages) })
  return t('Page {page}', { page: countText(page) })
}

function progressText(counts) {
  const fetched = counts.fetched
  const total = counts.total
  if (fetched !== undefined && total !== undefined && total > 0) {
    const percent = percentOf(fetched, total)
    const line = t('{fetched} of {total}', { fetched: countText(fetched), total: countText(total) })
    return percent === undefined ? line : `${line} · ${t('{percent}%', { percent })}`
  }
  return fetched === undefined ? '' : t('{count} fetched', { count: countText(fetched) })
}

function mediaText(counts) {
  const downloaded = counts.mediaDownloaded
  const missing = counts.mediaMissing
  if ((downloaded ?? 0) > 0 && (missing ?? 0) > 0) {
    return t('{count} photos, {missing} missing', { count: countText(downloaded), missing: countText(missing) })
  }
  if ((downloaded ?? 0) > 0) return t('{count} photos', { count: countText(downloaded) })
  return (missing ?? 0) > 0 ? t('{count} missing', { count: countText(missing) }) : ''
}

function marksText(counts) {
  const parts = []
  if ((counts.reactions ?? 0) > 0) parts.push(t('{count} reactions', { count: countText(counts.reactions) }))
  if ((counts.edits ?? 0) > 0) parts.push(t('{count} edits', { count: countText(counts.edits) }))
  return parts.join(' · ')
}

/** One row as a card draws it: a name, a state, its page or counts, and its coverage span. */
export function rowView(row) {
  const source = row !== null && typeof row === 'object' ? row : {}
  const counts = countsOf(source)
  return {
    state: stateId(source),
    word: stateWord(source),
    name: genuiLabel(source.chat ?? source.name) ?? '',
    page: pageText(source),
    progress: progressText(counts),
    media: mediaText(counts),
    marks: marksText(counts),
    span: spanOf(source.coverage),
    coverage: coverageLine(source.coverage),
  }
}

const NOTE_LABELS = [
  ['who', /^(?:who(?: they are)?(?: to (?:you|him|them))?|relationship|about)\s*[:\-–—]\s*(.*)$/i],
  ['open', /^(?:open(?: items)?|what'?s open(?: between (?:you|them))?|pending)\s*[:\-–—]\s*(.*)$/i],
  ['contact', /^(?:last contact(?: each way)?|contact)\s*[:\-–—]\s*(.*)$/i],
  ['tone', /^(?:tone(?: of voice)?|how (?:you|he|she|they) talks?(?: to (?:you|him|them))?|style)\s*[:\-–—]\s*(.*)$/i],
]

/**
 * A reading note split into its four parts. The bot writes them with a label each ("Who:",
 * "Open:", "Last contact:", "Tone:"); text before the first label, or a note written as
 * prose, comes back as `loose` and is drawn whole, never forced into a part it may not be.
 */
export function parseReadingNote(text) {
  const blocks = new Map()
  const loose = []
  let current
  for (const raw of String(text ?? '').slice(0, NOTE_MAX).split(/\r?\n/)) {
    const line = raw.trim()
    const found = NOTE_LABELS.find(([, pattern]) => pattern.test(line))
    if (found !== undefined) {
      current = found[0]
      if (!blocks.has(current)) blocks.set(current, [])
      const rest = found[1].exec(line)?.[1]?.trim() ?? ''
      if (rest !== '') blocks.get(current).push(rest)
      continue
    }
    if (current !== undefined) {
      if (line !== '') blocks.get(current).push(line)
      continue
    }
    if (line !== '') loose.push(line)
  }
  const parts = {}
  for (const [key, lines] of blocks) parts[key] = lines.join('\n').trim()
  return { blocks: parts, loose: loose.join('\n').trim() }
}

function noteOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const text = typeof value.text === 'string' ? value.text.trim().slice(0, NOTE_MAX) : ''
  if (text === '') return undefined
  return { text, readThrough: value.readThrough, updatedAt: value.updatedAt }
}

/**
 * A person card: the chat's name, its four parts and its read-through, or the plain state
 * of a chat whose note the bot has not written yet. Coverage comes from the host's read, not
 * from the note, so it stands even before a note exists.
 */
export function personView(data) {
  const source = data !== null && typeof data === 'object' ? data : {}
  const chat = source.chat !== null && typeof source.chat === 'object' ? source.chat : {}
  const coverage = coverageOf(source.coverage)
  const title = genuiLabel(chat.name) ?? t('This chat')
  const note = noteOf(source.note)
  if (note === undefined) {
    return {
      state: 'empty',
      title,
      subtitle: t('Not read yet. Ask the bot to read this chat.'),
      blocks: [],
      coverage,
      readThrough: '',
    }
  }
  const parsed = parseReadingNote(note.text)
  const blocks = []
  // A note written as prose keeps its words whole, in one part: it is never forced into a
  // part it may not be. A note with labels draws the four parts, and any prose above them.
  if (Object.keys(parsed.blocks).length === 0) {
    blocks.push({ key: 'note', label: t('Reading note'), text: parsed.loose })
  } else {
    if (parsed.loose !== '') blocks.push({ key: 'note', label: t('Reading note'), text: parsed.loose })
    const contact = [contactLine(coverage), parsed.blocks.contact ?? ''].filter(text => text !== '').join('\n')
    blocks.push(
      { key: 'who', label: t('Who they are to you'), text: parsed.blocks.who ?? '' },
      { key: 'open', label: t('What is open'), text: parsed.blocks.open ?? '' },
      { key: 'contact', label: t('Last contact'), text: contact },
      { key: 'tone', label: t('How you talk'), text: parsed.blocks.tone ?? '' },
    )
  }
  return {
    state: 'ready',
    title,
    subtitle: '',
    blocks,
    coverage,
    readThrough: shortDate(note.readThrough),
  }
}


// The backfill card (#1326 K2): a Bot proposes reading a chat's history over a date range,
// the person ticks the chats and sets the dates, and one Start sends the approval. The runs
// move live beside it. These are labels, dates, states and counts only, never a message: the
// model rebuilds both from the fields it knows, so a preview a caller passed is left out.
export const BACKFILL_RUNS_SHOWN = 3
export const BACKFILL_ROWS_SHOWN = 20
const BACKFILL_CHATS_MAX = 200
const BACKFILL_ID_MAX = 200

const backfillId = value => genuiLabel(value, BACKFILL_ID_MAX)

/** The day a date input carries: the UTC day of the proposal's or the run's ISO time. */
export function backfillDay(value) {
  const date = genuiInstant(value)
  if (date === undefined) return ''
  const pad = number => String(number).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

// The day a backfill card names: the same UTC day `backfillDay` puts in the date input,
// formatted for the interface. Formatting the instant in the viewer's zone would show the
// day before at a UTC midnight and the day after at a UTC day's last millisecond, which is
// exactly the range the person did not pick. The run's started day uses it too, so every
// day on the card speaks the same UTC calendar; other cards keep `shortDate`'s local day.
const backfillDayText = (value) => {
  const day = backfillDay(value)
  if (day === '') return ''
  const date = genuiInstant(`${day}T00:00:00.000Z`)
  if (date === undefined) return ''
  return new Intl.DateTimeFormat(dateLocale(), {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(date)
}

/** The range a proposal or a run covers: "Mar 1, 2026 – Nov 15, 2026", or the whole history. */
export function backfillRange(from, to) {
  const start = backfillDayText(from)
  const end = backfillDayText(to)
  if (start !== '' && end !== '') return start === end ? start : `${start} – ${end}`
  if (start !== '') return t('From {date}', { date: start })
  if (end !== '') return t('Through {date}', { date: end })
  return t('All available history')
}

/** Only a queued or fetching job can still be stopped: a job id, and no outcome yet. */
export function canCancel(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return false
  return backfillId(row.jobId) !== undefined && row.outcome === null
}

/** One proposal: its id, its range, and the chats the person may tick. */
export function proposalView(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const id = backfillId(value.id)
  if (id === undefined) return undefined
  const chats = (Array.isArray(value.chats) ? value.chats : []).slice(0, BACKFILL_CHATS_MAX).map((chat) => {
    if (chat === null || typeof chat !== 'object' || Array.isArray(chat)) return undefined
    const chatId = backfillId(chat.id)
    if (chatId === undefined) return undefined
    return {
      id: chatId,
      name: genuiLabel(chat.name) ?? t('Unnamed chat'),
      channel: genuiLabel(chat.channel) ?? '',
      kind: genuiLabel(chat.kind, 24) ?? '',
      ticked: chat.ticked === true,
    }
  }).filter(Boolean)
  return {
    id,
    botId: backfillId(value.botId),
    range: backfillRange(value.from, value.to),
    from: backfillDay(value.from),
    to: backfillDay(value.to),
    chats,
    ticked: chats.filter(chat => chat.ticked).map(chat => chat.id),
    count: chats.length,
  }
}

/**
 * How a run stands, from its summary or, when it has none, from its rows: running first,
 * then the ways a row can end. Empty when there is nothing to say.
 */
export function backfillSummaryText(summary, rows) {
  const list = Array.isArray(rows) ? rows : []
  const fromSummary = key => {
    if (summary === null || typeof summary !== 'object' || Array.isArray(summary)) return undefined
    return genuiNumber(summary[key])
  }
  const counted = key => fromSummary(key) ?? 0
  const ended = outcome => list.filter(row => row?.outcome === outcome).length
  const running = fromSummary('running') ?? list.filter(row => row?.outcome === null).length
  const done = fromSummary('done') ?? ended('done')
  const phone = fromSummary('phoneDidNotAnswer') ?? ended('phone-did-not-answer')
  const stopped = fromSummary('stopped') ?? ended('stopped')
  const failed = fromSummary('failed') ?? (ended('failed') + ended('not-started'))
  const parts = []
  if (running > 0) parts.push(t('{count} running', { count: countText(running) }))
  if (done > 0) parts.push(t('{count} done', { count: countText(done) }))
  if (phone > 0) parts.push(t('{count} phone did not answer', { count: countText(phone) }))
  if (stopped > 0) parts.push(t('{count} stopped', { count: countText(stopped) }))
  if (failed > 0) parts.push(t('{count} failed', { count: countText(failed) }))
  // A summary that carries only its total still says so; an empty run says nothing.
  if (parts.length === 0 && (counted('total') > 0 || list.length > 0)) parts.push(t('{count} chats', { count: countText(counted('total') || list.length) }))
  return parts.join(' · ')
}

function backfillRowView(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return undefined
  const chatId = backfillId(row.chatId)
  if (chatId === undefined) return undefined
  return { ...rowView(row), chatId, jobId: backfillId(row.jobId) ?? null, cancelable: canCancel(row) }
}

/** One run: its range, its started day, how its chats stand, and its rows as they move. */
export function runView(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const id = backfillId(value.id)
  if (id === undefined) return undefined
  const rows = Array.isArray(value.rows) ? value.rows : []
  const shown = rows.slice(0, BACKFILL_ROWS_SHOWN).map(backfillRowView).filter(Boolean)
  return {
    id,
    botId: backfillId(value.botId),
    range: backfillRange(value.from, value.to),
    started: backfillDayText(value.startedAt),
    summary: backfillSummaryText(value.summary, rows),
    total: rows.length,
    rows: shown,
    more: Math.max(0, rows.length - shown.length),
  }
}

/** The card's roster view: the open proposals, then the newest runs and how many came before. */
export function backfillView(roster) {
  const proposals = Array.isArray(roster?.omniBackfillProposals) ? roster.omniBackfillProposals : []
  const runs = Array.isArray(roster?.omniBackfills) ? roster.omniBackfills : []
  const shown = runs.slice(0, BACKFILL_RUNS_SHOWN).map(runView).filter(Boolean)
  return {
    proposals: proposals.map(proposalView).filter(Boolean),
    runs: shown,
    moreRuns: Math.max(0, runs.length - shown.length),
  }
}
