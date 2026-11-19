// A retired Bot account home is kept, not removed (#1529). A reset moves the vendor's pointer
// and marks the previous generation retired; its session files and usage history stay readable
// at their bound path. This module says that in the home itself (RETIRED.json, 0600) and reports
// every retired home for inspection. Collection on a later start removes nothing: the issue's
// other conditions - a complete measurement scan taken after the home's last write with the root
// frozen, the measurement retirement record, and the session-absorption receipt - are not
// available on this side yet, so the default is keep. A home whose marker, note or path cannot
// be proved to be the retired generation's own is refused and left untouched: that includes a
// note that is missing, unreadable or not a readable disposition, because the record of what was
// decided is then ambiguous. A KEEP file in the home opts out of any future collection.
// Apache-2.0.

import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const RETIRED_NOTE = 'RETIRED.json'
export const RETIRED_KEEP = 'KEEP'

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`

/**
 * One log line for a startup that found retired homes: no path, no account detail. It reports
 * every disposition it saw, and claims retention at a bound path only for a home still there;
 * a marker whose folder is gone is reported as gone, never as keeping history it does not have.
 */
export const retiredLine = (vendor, rows = []) => {
  const count = state => rows.filter(row => row.state === state).length
  const kept = count('kept')
  const missing = count('missing')
  const refused = count('refused')
  const parts = []
  if (kept > 0) {
    parts.push(`kept ${plural(kept, `retired ${vendor} Bot sign-in home`, `retired ${vendor} Bot sign-in homes`)}: `
      + 'each keeps its session and usage history at its bound path; '
      + `see ${RETIRED_NOTE} in it`)
  }
  if (missing > 0) {
    parts.push(`found ${plural(missing, `retired ${vendor} marker with no home`, `retired ${vendor} markers with no home`)}: `
      + 'the bound path is gone, so no session or usage history is there; '
      + 'this side removed nothing')
  }
  if (refused > 0) {
    parts.push(`found ${plural(refused, `retired ${vendor} home that cannot be proved`, `retired ${vendor} homes that cannot be proved`)}: `
      + 'left untouched, nothing removed')
  }
  return parts.join('; ')
}

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
const noteRefusal = (noteState, reason) => ({ refused: true, noteState, reason })

// A note is the record of what this side decided for the home. If it is absent, cannot be read
// or cannot be recognised, this side cannot tell what was decided, so the home is refused and
// left untouched like any other ambiguity. Each case keeps its own `noteState`, so an absent
// note stays distinguishable from a corrupt one.
const noteAt = (home, vendor, generation) => {
  const path = join(home, RETIRED_NOTE)
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    return error.code === 'ENOENT'
      ? noteRefusal('missing', 'The retirement note is missing, so this side cannot tell what was decided for this home; nothing here is touched.')
      : noteRefusal('unreadable', 'The retirement note cannot be read, so this side cannot tell what was decided for this home; nothing here is touched.')
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return noteRefusal('unreadable', 'The retirement note is not a plain file this side can read, so this side cannot tell what was decided for this home; nothing here is touched.')
  }
  if (stat.size > NOTE_MAX) {
    return noteRefusal('invalid', 'The retirement note is too large to be a disposition this side can read, so this side cannot tell what was decided for this home; nothing here is touched.')
  }
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return noteRefusal('unreadable', 'The retirement note cannot be read, so this side cannot tell what was decided for this home; nothing here is touched.')
  }
  let note
  try {
    note = JSON.parse(text)
  } catch {
    return noteRefusal('invalid', 'The retirement note is not valid JSON, so this side cannot tell what was decided for this home; nothing here is touched.')
  }
  let own = false
  try {
    own = note?.version === NOTE_VERSION && note.vendor === vendor
      && note.generation === generation && resolve(note.home) === resolve(home)
  } catch { own = false }
  if (!own) {
    return noteRefusal('unrecognised', 'This side cannot tell whether the retirement note belongs to this home, so nothing here is touched.')
  }
  return { note, noteState: 'present' }
}

/**
 * Every retired home this installation has marked, read only: the marker proves the retirement,
 * the note says what is kept and how to inspect or keep it. `state` is `kept` (left alone),
 * `refused` (this side cannot tell whether the folder is the retired home's own, or cannot read
 * the note saying so) or `missing` (the home is no longer at its bound path). A refused note also
 * names what was wrong in `noteState` (`missing`, `unreadable`, `invalid` or `unrecognised`);
 * a kept one has `present`. Nothing here removes anything.
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
      Object.assign(row, {
        state: 'refused', kept: true, noteState: read.noteState, reason: read.reason,
      })
      rows.push(row)
      continue
    }
    row.noteState = read.noteState
    if (read.note?.retiredAt) row.retiredAt = read.note.retiredAt
    try { row.optedOut = lstatSync(join(home, RETIRED_KEEP)) !== null } catch {}
    row.reason = row.optedOut
      ? `The person asked to keep this home with ${RETIRED_KEEP}; it stays at its bound path.`
      : 'The home is kept: its session and usage history stay readable at its bound path; collection needs the measurement side\'s complete post-last-write scan with the root frozen and its retirement record, plus the session-absorption receipt, none of which is available on this side yet.'
    rows.push(row)
  }
  return rows
}
