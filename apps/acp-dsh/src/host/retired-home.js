// A retired Bot account home is kept, not removed (#1529). A reset moves the vendor's pointer
// and marks the previous generation retired; its session files and usage history stay readable
// at their bound path. This module says that in the home itself (RETIRED.json, 0600) and reports
// every retired home for inspection. Collection on a later start removes nothing: the issue's
// other conditions - a complete measurement scan taken after the home's last write with the root
// frozen, the measurement retirement record, and the session-absorption receipt - are not
// available on this side yet, so the default is keep. A home whose path cannot be proved to be
// the retired generation's own is refused and left untouched. A KEEP file in the home opts out
// of any future collection. Apache-2.0.

import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const RETIRED_NOTE = 'RETIRED.json'
export const RETIRED_KEEP = 'KEEP'

/** One log line for a startup that found retired homes: no path, no account detail. */
export const retiredLine = (vendor, kept) => `kept ${kept.length} retired ${vendor} Bot sign-in home`
  + `${kept.length === 1 ? '' : 's'}: each keeps its session and usage history at its bound path; `
  + `see ${RETIRED_NOTE} in it`

const NOTE_VERSION = 1
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const NOTE_MAX = 64 * 1024

// The four separately proved conditions the issue names. None stands in for another; this side
// can prove the first today, and the other three belong to the measurement side and to the
// session-absorption record, so removal is not offered.
export const COLLECTION_CONDITIONS = [
  'the recorded owners are dead',
  "a complete measurement scan taken after this home's last write is saved and the measurement side has frozen the root",
  'the measurement retirement record names this root retired',
  "the session-absorption receipt records the successor's reading of this home",
]

const disposition = (root, vendor, generation, home, retiredAt) => ({
  version: NOTE_VERSION,
  vendor,
  generation,
  home,
  retiredAt,
  removed: [],
  kept: {
    sessions: `${home}: the vendor's own session files, under its config and sessions folders`,
    usage: `${home}: the usage history recorded in this home`,
    files: "the vendor's own files, at the path above",
  },
  forHowLong: 'indefinitely, until every condition below is separately proved; there is no time limit',
  inspect: `this file (${RETIRED_NOTE}) in the retired home; the marker in ${join(root, 'retired', vendor)} names the generation`,
  optOut: `create a file named ${RETIRED_KEEP} in this home; it is then never removed`,
  collection: {
    allowed: false,
    because: 'the measurement and absorption conditions are not available on this side yet, so a retired home is kept',
    conditions: COLLECTION_CONDITIONS,
  },
})

/**
 * The note beside the retired home's files, written once when the home is retired. It never
 * overwrites a file already there (a person's own note stays), and a failure never stops the
 * reset: the note explains a decision the marker already records.
 */
export function writeRetiredNote({ root, vendor, generation, home, at = new Date() }) {
  const text = `${JSON.stringify(disposition(resolve(root), vendor, generation, resolve(home), at.toISOString()), null, 2)}\n`
  try { writeFileSync(join(resolve(home), RETIRED_NOTE), text, { mode: 0o600, flag: 'wx' }) } catch {}
}

const plainDirectory = path => {
  try { const stat = lstatSync(path); return stat.isDirectory() && !stat.isSymbolicLink() } catch { return false }
}
const plainMarker = path => {
  try { const stat = lstatSync(path); return stat.isFile() && !stat.isSymbolicLink() && stat.size === 0 } catch { return false }
}
const noteAt = (home, vendor, generation) => {
  try {
    const path = join(home, RETIRED_NOTE)
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > NOTE_MAX) return { refused: true }
    const note = JSON.parse(readFileSync(path, 'utf8'))
    if (note?.version !== NOTE_VERSION || note.vendor !== vendor || note.generation !== generation
      || resolve(note.home) !== resolve(home)) return { refused: true }
    return { note }
  } catch { return { note: null } }
}

/**
 * Every retired home this installation has marked, read only: the marker proves the retirement,
 * the note says what is kept and how to inspect or keep it. `state` is `kept` (left alone),
 * `refused` (this side cannot tell whether the folder is the retired home's own) or `missing`
 * (the home is no longer at its bound path). Nothing here removes anything.
 */
export function retiredHomes(root, vendor) {
  const base = resolve(root)
  const directory = join(base, 'retired', vendor)
  let names
  try { names = readdirSync(directory).sort() } catch { return [] }
  const rows = []
  for (const generation of names) {
    if (generation !== 'legacy' && !UUID.test(generation)) continue
    const marker = join(directory, generation)
    const home = generation === 'legacy' ? join(base, vendor) : join(base, 'homes', vendor, generation)
    let retiredAt
    try { retiredAt = lstatSync(marker).mtime.toISOString() } catch { retiredAt = null }
    const row = { vendor, generation, marker, home, note: join(home, RETIRED_NOTE), retiredAt,
      state: 'kept', kept: true, optedOut: false, reason: '' }
    if (!plainMarker(marker)) {
      Object.assign(row, { state: 'refused', kept: true, reason: 'This side cannot tell whether the marker is the retired home\'s own, so nothing here is touched.' })
      rows.push(row)
      continue
    }
    const own = generation === 'legacy'
      ? plainDirectory(home)
      : plainDirectory(join(base, 'homes')) && plainDirectory(join(base, 'homes', vendor)) && plainDirectory(home)
    if (!own) {
      Object.assign(row, existsSync(home)
        ? { state: 'refused', kept: true, reason: 'This side cannot tell whether the folder at the bound path is the retired home\'s own, so nothing here is touched.' }
        : { state: 'missing', kept: false, reason: 'The retired home is no longer at its bound path; this side removed nothing.' })
      rows.push(row)
      continue
    }
    const read = noteAt(home, vendor, generation)
    if (read.refused) {
      Object.assign(row, { state: 'refused', kept: true, note: null, reason: 'This side cannot tell whether the retirement note belongs to this home, so nothing here is touched.' })
      rows.push(row)
      continue
    }
    if (read.note?.retiredAt) row.retiredAt = read.note.retiredAt
    try { row.optedOut = lstatSync(join(home, RETIRED_KEEP)) !== null } catch {}
    row.reason = row.optedOut
      ? `The person asked to keep this home with ${RETIRED_KEEP}; it stays at its bound path.`
      : 'The home is kept: its session and usage history stay readable at its bound path; collection needs the measurement side\'s complete post-last-write scan with the root frozen and its retirement record, plus the session-absorption receipt, none of which is available on this side yet.'
    rows.push(row)
  }
  return rows
}
