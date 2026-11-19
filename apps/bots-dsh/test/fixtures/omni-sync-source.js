// A stand-in for Omni's event stream, in the shapes the channels plugin folds into the
// shared kit (#1326): `sync.progress`, `sync.completed`, `sync.failed` and `sync.cancelled`
// carry a per-chat backfill's `chatId` and Omni's own progress counters, and
// `read_history`'s header carries the page numbers and the chat's coverage. Nothing here
// is the kit's code: it is the source the kit's live slice must accept, so the test
// publishes exactly what the real plugin will publish.

const integer = value => (Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : undefined)

// Omni's progress counters → one kit row's counts. Omni names some of them differently
// (reactionsApplied, totalEstimated); the kit uses the shorter names a card draws.
const COUNTS = [
  ['fetched', 'fetched'],
  ['stored', 'stored'],
  ['duplicates', 'duplicates'],
  ['mediaDownloaded', 'mediaDownloaded'],
  ['mediaMissing', 'mediaMissing'],
  ['reactionsApplied', 'reactions'],
  ['editsApplied', 'edits'],
  ['deletionsApplied', 'deletions'],
  ['unmatched', 'unmatched'],
  ['totalEstimated', 'total'],
]

export function omniSyncSource() {
  const listeners = new Map()
  return {
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
      return () => listeners.get(type)?.delete(fn)
    },
    fire(type, payload) {
      for (const fn of listeners.get(type) ?? []) fn(payload, type)
    },
  }
}

/** One kit row from one Omni event, or undefined for an event that names no chat. */
export function rowOfEvent(type, payload) {
  const chatId = payload?.chatId
  if (typeof chatId !== 'string' || chatId === '') return undefined
  const progress = payload.progress ?? {}
  const counts = {}
  for (const [from, to] of COUNTS) {
    const value = integer(progress[from])
    if (value !== undefined) counts[to] = value
  }
  const row = { chatId, ...(Object.keys(counts).length === 0 ? {} : { counts }) }
  if (typeof progress.oldestReached === 'string') row.oldestReached = progress.oldestReached
  switch (type) {
    case 'sync.progress':
      return { ...row, state: progress.state === 'queued' ? 'queued' : 'fetching' }
    case 'sync.completed':
      // A reading that reached the phone's end says so; every other completion is done.
      return progress.outcome === 'phone-did-not-answer'
        ? { ...row, state: 'phone-did-not-answer', outcome: 'phone-did-not-answer' }
        : { ...row, state: 'done', outcome: 'done' }
    case 'sync.failed':
      return { ...row, state: 'failed', outcome: 'failed' }
    case 'sync.cancelled':
      return { ...row, state: 'cancelled', outcome: 'stopped' }
    default:
      return undefined
  }
}

// The header read_history opens a page with (the Omni channels plugin's own words): the
// chat, the page of the window, the coverage and the last contact each way.
const CHAT = /^Reading (.+) \(chat ([\w-]+)\), from .+ to .+\.$/m
const PAGE = /^Page (\d+) of about (\d+), /m
const COVERAGE = /^Coverage: Omni holds (\d+) messages of this chat(?: \((\S+) to (\S+)\))?, (\d+) in this window; (\d+) deleted; (\d+) with media whose file Omni does not hold\.$/m
const CONTACT = /^Last contact: from them (\S+), from the user (\S+)\.$/m

/** What one real-shaped `read_history` header says: the chat, the page and its coverage. */
export function readingOfHeader(text) {
  const chat = CHAT.exec(text)
  if (chat === null) return undefined
  const page = PAGE.exec(text)
  const coverage = COVERAGE.exec(text)
  const contact = CONTACT.exec(text)
  const when = value => (value === undefined || value === 'never' ? undefined : new Date(value).toISOString())
  const coverageOf = {}
  if (coverage !== null) {
    coverageOf.count = Number(coverage[1])
    if (coverage[2] !== undefined) {
      coverageOf.oldest = when(coverage[2])
      coverageOf.newest = when(coverage[3])
    }
    coverageOf.countInWindow = Number(coverage[4])
    coverageOf.deletedCount = Number(coverage[5])
    coverageOf.mediaMissing = Number(coverage[6])
  }
  if (contact !== null) {
    coverageOf.lastInbound = when(contact[1])
    coverageOf.lastOutbound = when(contact[2])
  }
  return {
    chatId: chat[2],
    chat: chat[1],
    ...(page === null ? {} : { page: Number(page[1]), pages: Number(page[2]) }),
    ...(Object.keys(coverageOf).length === 0 ? {} : { coverage: coverageOf }),
  }
}

/** The page read_history prints for a chat it is reading, as the kit's test feeds it. */
export function pageHeader({ chat, id, page, pages, count, oldest, newest, deleted, missing, inbound, outbound }) {
  return [
    `Reading ${chat} (chat ${id}), from its first message to now.`,
    `Page ${page} of about ${pages}, newest pages first: 50 messages, oldest first.`,
    `Coverage: Omni holds ${count} messages of this chat (${oldest} to ${newest}), 50 in this window; ${deleted} deleted; ${missing} with media whose file Omni does not hold.`,
    `Last contact: from them ${inbound}, from the user ${outbound}.`,
    'This is the last page of this window.',
    'Reading note: none yet for this chat.',
  ].join('\n')
}
