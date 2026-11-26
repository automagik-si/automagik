// Which phones have a session open now, and public-status.json: the one file in the state dir
// other mods may read (a Herdr sidebar's "phone connected" dot). Schema 1:
//
//   { "schema": 1, "running": true, "updated": <epoch ms>, "phones_connected": 1,
//     "phones": [{ "name": "Pixel 9", "since": <epoch ms> }] }
//
// No ticket, endpoint id, phone key or secret ever goes in it; status.json (0600) keeps those.
// `updated` is rewritten every HEARTBEAT ms while the bridge serves, so a reader can call a file
// older than STALE ms a stopped bridge (one killed without its clean shutdown).
// No dependencies, so node --test runs it without the bridge's packages.
import { chmodSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const SCHEMA = 1
export const FILE = 'public-status.json'
export const HEARTBEAT = 20_000
export const STALE = 90_000

/** Open sessions, by phone. `open()` returns that session's close; calling it again does nothing. */
export function presence({ changed = () => {}, now = Date.now } = {}) {
  const sessions = new Map() // token -> { phone, name, since }
  return {
    open(phone, name) {
      const token = Symbol(phone)
      sessions.set(token, { phone, name: String(name ?? 'Phone'), since: now() })
      changed()
      return () => { if (sessions.delete(token)) changed() }
    },
    /** One entry per phone (a phone may have several sessions open), oldest first. */
    phones() {
      const by = new Map()
      for (const s of sessions.values()) {
        const seen = by.get(s.phone)
        if (!seen || s.since < seen.since) by.set(s.phone, { name: s.name, since: s.since })
      }
      return [...by.values()].sort((a, b) => a.since - b.since)
    },
  }
}

/** The public document. Only names and times: nothing that reaches or identifies this computer. */
export function publicStatus({ running, phones = [], now = Date.now() }) {
  const list = running ? phones.map(({ name, since }) => ({ name, since })) : []
  return { schema: SCHEMA, running: Boolean(running), updated: now, phones_connected: list.length, phones: list }
}

/** Writes it atomically (a reader never sees half a file), mode 0644 whatever the umask. */
export function writePublic(dir, value) {
  const path = join(dir, FILE)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o644 })
  chmodSync(tmp, 0o644)
  renameSync(tmp, path)
  return path
}

/** How another mod should read it: null when missing, unreadable, another schema, or stale. */
export function readPublic(text, now = Date.now()) {
  let doc
  try { doc = JSON.parse(text) } catch { return null }
  if (!doc || doc.schema !== SCHEMA || typeof doc.updated !== 'number') return null
  if (!doc.running || now - doc.updated > STALE) return { ...doc, running: false, phones_connected: 0, phones: [] }
  return doc
}
