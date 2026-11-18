#!/usr/bin/env node
// Host-side pilot check for read-only measurement access to one workspace volume. The image
// mounts that volume at /data and bakes no host path, so the node exposes the volume's host
// mountpoint read-only and runs this against that view as the measurement identity:
//
//   node server/measurement-check.mjs /srv/automagik/measure/<workspace>
//
// Exit 0 only when the view is present, is not stale, gives the exposed roots read-only, keeps
// the meter's files readable, and lets no credential or settings file be read.
import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const VIEW_USAGE = 'node server/measurement-check.mjs <read-only-view>'
/** Written by the image's first seed; its absence means the documented path is stale. */
export const MARKER = 'dsh/profiles/automagik-web/automagik-server-profile'
/** The only roots the measurement identity may read. */
export const EXPOSED = [
  '.claude/projects',
  '.claude/session-archive',
  '.codex/sessions',
  '.codex/archived_sessions',
  '.automagik/meter',
]
/** Files that carry a credential or an environment value and are never exposed. */
export const SECRETS = [
  '.claude/.credentials.json',
  '.codex/auth.json',
  '.claude.json',
  '.claude/settings.json',
  '.gemini/settings.json',
  '.antigravity/settings.json',
]
const METER = '.automagik/meter'
const METER_FILES = ['meter.db', 'claude-limits.jsonl']

const readable = (path) => { try { accessSync(path, constants.R_OK); return true } catch { return false } }
const usable = (path) => { try { accessSync(path, constants.R_OK | constants.X_OK); return true } catch { return false } }
const writable = (path) => { try { accessSync(path, constants.W_OK); return true } catch { return false } }
const directory = (path) => { try { return statSync(path).isDirectory() } catch { return false } }
const present = (path) => { try { statSync(path); return true } catch { return false } }

function check(view) {
  const ok = []
  const fail = []
  if (!directory(view)) {
    fail.push(`absent: ${view} is not a directory`)
    return { ok, fail }
  }
  if (writable(view)) fail.push('writable: the view root, not a read-only mount')
  else ok.push('read-only: the view root')

  const markerPath = join(view, MARKER)
  let marker
  try { marker = JSON.parse(readFileSync(markerPath, 'utf8')) } catch { /* reported below */ }
  if (marker?.version !== 1 || !/^[a-f0-9]{64}$/.test(marker.packageSha256 ?? '')) {
    fail.push(`stale: ${MARKER} is missing, unreadable or not version 1`)
  } else ok.push(`fresh: ${MARKER}`)

  let roots = 0
  for (const rel of EXPOSED) {
    const path = join(view, rel)
    if (!present(path)) continue
    roots += 1
    if (!directory(path)) { fail.push(`not a directory: ${rel}`); continue }
    if (!usable(path)) fail.push(`not readable: ${rel}`)
    else ok.push(`readable: ${rel}`)
    if (writable(path)) fail.push(`writable: ${rel}`)
  }
  if (roots === 0) fail.push('stale: none of the exposed roots exists')

  if (present(join(view, METER))) {
    for (const file of METER_FILES) {
      const rel = `${METER}/${file}`
      if (readable(join(view, rel))) ok.push(`readable: ${rel}`)
      else fail.push(`not readable: ${rel}`)
    }
  }

  for (const rel of SECRETS) {
    if (readable(join(view, rel))) fail.push(`exposed: ${rel} is readable`)
  }
  return { ok, fail }
}

const view = process.argv[2] === undefined ? undefined : resolve(process.argv[2])
if (!view) {
  console.error(`usage: ${VIEW_USAGE}`)
  process.exit(2)
}
const { ok, fail } = check(view)
for (const line of ok) console.log(`ok: ${line}`)
for (const line of fail) console.error(`FAIL: ${line}`)
console.log(`${fail.length ? 'FAILED' : 'OK'}: ${view} (${ok.length} checks, ${fail.length} failures)`)
process.exitCode = fail.length ? 1 : 0
