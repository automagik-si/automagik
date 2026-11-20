// The one-time pairing code: what a try does to it, cancelling it, shortening it once its link is
// copied, and the short key fingerprint the dialog shows next to each phone. No iroh here, so
// `node --test` runs it without npm.
import { createHash, timingSafeEqual } from 'node:crypto'
import { unlinkSync, readFileSync, openSync, readSync, writeSync, ftruncateSync, fstatSync, statSync, closeSync } from 'node:fs'

/** Wrong tries one phone key gets at a code; after that its tries are refused and not counted. */
export const TRIES_PER_PHONE = 3
/**
 * Wrong tries from all phones together that end a code. New keys are free, so a low number would let
 * one stranger end each new code; codes are 128-bit, so guessing isn't the worry. Only a flood gets
 * here, and it bounds how big pairing.json grows.
 */
export const TRIES_PER_CODE = 1000

export const sameCode = (a, b) => {
  const x = createHash('sha256').update(String(a)).digest(), y = createHash('sha256').update(String(b)).digest()
  return timingSafeEqual(x, y)
}

/** The first 12 hex characters of a key in groups of four, as the dialog and the log show it. */
export const fingerprint = id => (String(id).slice(0, 12).match(/.{1,4}/g) ?? []).join(' ')

/** This computer's key, as Pocket shows it, only while it serves that key. */
export const desktopFingerprint = (status, running) =>
  running && status && !status.rotating && status.id && status.ticket
    ? fingerprint(status.id) : null

/**
 * One try at the pending code (pairing.json) from `phone` (its full key). Returns `verdict`
 * ('gone' | 'locked' | 'wrong' | 'ok') and `next`: the pairing.json to write, null to delete it,
 * or undefined to leave it as it is.
 *
 * One phone that keeps getting it wrong locks only itself out, so it can't end each new code for
 * everyone; only a flood of keys reaches TRIES_PER_CODE.
 */
export function judgeCode(pending, phone, code, now = Date.now()) {
  if (!pending || !(now <= pending.expires)) return { verdict: 'gone', next: undefined }
  const tries = pending.tries?.[phone] ?? 0
  if (tries >= TRIES_PER_PHONE) return { verdict: 'locked', next: undefined }
  if (sameCode(code, pending.code)) return { verdict: 'ok', next: null }
  const failures = (pending.failures ?? 0) + 1
  if (failures >= TRIES_PER_CODE) return { verdict: 'wrong', next: null }
  return { verdict: 'wrong', next: { ...pending, failures, tries: { ...pending.tries, [phone]: tries + 1 } } }
}

/**
 * How long a code lives once the dialog copies its link: the clipboard may sync to the person's
 * other devices (macOS Universal Clipboard), so a copied link must not stay good for 10 minutes.
 */
export const COPIED_LIFE = 2 * 60_000

/**
 * The pending code with at most `life` left from `now`, or undefined when there is no live code.
 * It never lengthens a code, and keeps its tries, so copying twice doesn't reset anything.
 */
export function shorten(pending, life = COPIED_LIFE, now = Date.now()) {
  if (!pending || !(now <= pending.expires)) return undefined
  return { ...pending, expires: Math.min(pending.expires, now + life) }
}

/**
 * Shortens the live code in `path` (pairing.json) in place. Returns `{ expires }`, its new expiry;
 * `{ error: 'gone' }` when there is no live code (used, cancelled, expired) or it is now another
 * code; `{ error: 'changing' }` when the file kept being replaced under it, so nothing should be
 * copied.
 *
 * Not the bridge's write-a-temp-and-rename: a phone can use the code, and the bridge delete the
 * file, between this read and this write, and a rename would bring the used code back. Here the
 * open fails once the file is gone, and a write after the bridge deletes it lands in the deleted
 * file, so a used or cancelled code stays gone.
 *
 * The bridge still writes a wrong try with a rename, and that can land over this write with the
 * old expiry. So after writing it checks that `path` is still the file it wrote, with its code and
 * expiry, again after `settle` ms (the bridge reads and renames in one synchronous step), and
 * otherwise shortens the new file; after `attempts` it gives up. Until the bridge is the only
 * writer of pairing.json, the dialog also ends a copied code itself at 0:00 (a new code replaces
 * it).
 */
export function shortenCode(path, life = COPIED_LIFE, now = Date.now(), { attempts = 5, settle = 50, written, settled } = {}) {
  let code = null
  for (let i = 0; i < attempts; i++) {
    let fd
    try { fd = openSync(path, 'r+') } catch { return { error: 'gone' } }
    try {
      const next = shortenOpen(fd, life, now, code)
      if (!next) return { error: 'gone' }
      code = next.code
      written?.(i)
      if (!holds(fd, path, next)) continue
      if (settle > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, settle)
      settled?.(i)
      if (holds(fd, path, next)) return { expires: next.expires }
    } finally { closeSync(fd) }
  }
  return { error: 'changing' }
}

/** Whether `path` is still the file open as `fd`, holding `next`'s code with no later expiry. */
function holds(fd, path, next) {
  let at, now
  try { at = statSync(path); now = JSON.parse(readFileSync(path, 'utf8')) } catch { return false }
  const own = fstatSync(fd)
  return at.ino === own.ino && at.dev === own.dev && sameCode(now?.code, next.code) && now.expires <= next.expires
}

/**
 * shortenCode's read and write, on pairing.json already open for both: the record written, or
 * null with nothing written when no code is live or, given `only`, the live one is another code.
 */
export function shortenOpen(fd, life = COPIED_LIFE, now = Date.now(), only = null) {
  const buf = Buffer.alloc(fstatSync(fd).size)
  readSync(fd, buf, 0, buf.length, 0)
  let pending = null
  try { pending = JSON.parse(buf.toString('utf8')) } catch {}
  const next = shorten(pending, life, now)
  if (!next || (only !== null && !sameCode(next.code, only))) return null
  const out = Buffer.from(JSON.stringify(next, null, 2) + '\n')
  writeSync(fd, out, 0, out.length, 0)
  ftruncateSync(fd, out.length)
  return next
}

/** Ends the live code, if any. True when there was one that still worked. */
export function cancelCode(path, now = Date.now()) {
  let pending = null
  try { pending = JSON.parse(readFileSync(path, 'utf8')) } catch {}
  try { unlinkSync(path) } catch { return false }
  return Boolean(pending && now <= pending.expires)
}
