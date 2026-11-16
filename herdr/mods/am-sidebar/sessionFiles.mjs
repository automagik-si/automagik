// The session files revive trusts (#1490): a Codex rollout's first line and Kimi's index, read
// without following a symlink, without trusting a file that was swapped under the read, and
// within a byte cap. A read that can't prove what it read fails closed (null). Pure Node: the
// CLI passes the caps; the tests drive `afterOpen` to swap a file under a read.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, statSync } from "node:fs";

/** A file identity that names one file: its device and inode (the path's or an open handle's). */
export const identityOf = (st) => (st && Number.isSafeInteger(st.dev) && Number.isSafeInteger(st.ino) ? `${st.dev}:${st.ino}` : null);

/** The identity a path names when it is a regular file, else null (a symlink, folder or missing path). */
export function regularIdentity(file) {
  try {
    const st = lstatSync(file);
    return st.isFile() ? identityOf(st) : null;
  } catch { return null; }
}

/**
 * Open `file` without following a symlink (O_NOFOLLOW: a link is refused there) and prove the
 * handle is the regular file the path named. Resolves { fd, opened } or null; the caller closes `fd`.
 */
function openProven(file) {
  let before = null;
  try { before = statSync(file); } catch { return null; }
  if (!before.isFile()) return null;
  let fd = null;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    // A path swapped between the stat and the open is not trusted.
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) { closeSync(fd); return null; }
    return { fd, opened };
  } catch {
    if (fd !== null) try { closeSync(fd); } catch { /* nothing to close */ }
    return null;
  }
}

/**
 * The handle still runs the file the path names: read the caller's bytes first, then this. A
 * file that shrank under the read (a rewrite) or whose path now names another file (a
 * rename-over) is refused; an append is fine, since the bytes already read didn't change. The
 * path is followed: a symlink was already refused at the open (O_NOFOLLOW).
 */
function stillTheSame(file, fd, opened) {
  try {
    const after = fstatSync(fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size < opened.size) return false;
    const now = statSync(file);
    return now.isFile() && now.dev === opened.dev && now.ino === opened.ino;
  } catch { return false; }
}

const CHUNK = 64 * 1024;

/**
 * Read at most `maxBytes` from a proven regular file and call `stillTheSame` on the way out.
 * Resolves { bytes, size, complete } where `complete` says the read reached the end; null when
 * the read can't be trusted (or `afterOpen` threw). `afterOpen(file)` runs after the open is
 * proven and before any byte is read: the test seam for a file swapped under a read.
 */
function readProven(file, { maxBytes, afterOpen = null }) {
  const got = openProven(file);
  if (!got) return null;
  const { fd, opened } = got;
  try {
    if (typeof afterOpen === "function") afterOpen(file);
    const chunks = [];
    let used = 0;
    let complete = opened.size <= maxBytes;
    while (used < maxBytes) {
      const buf = Buffer.alloc(Math.min(CHUNK, maxBytes - used));
      const n = readSync(fd, buf, 0, buf.length, null);
      if (!n) { complete = true; break; }
      chunks.push(buf.subarray(0, n));
      used += n;
      if (used >= maxBytes && opened.size > maxBytes) complete = false;
    }
    if (!stillTheSame(file, fd, opened)) return null;
    return { bytes: Buffer.concat(chunks), size: opened.size, complete };
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * A rollout's first line, at most `maxBytes` (1 MiB by default); null when unreadable, swapped
 * under the read, a symlink, not a regular file, or a first line longer than the cap. A file
 * larger than the cap with a shorter first line is fine: only the line is read.
 */
export function firstLine(file, { maxBytes = 1024 * 1024, afterOpen = null } = {}) {
  const got = readProven(file, { maxBytes: maxBytes + 1, afterOpen });
  if (!got) return null;
  const end = got.bytes.indexOf(10);
  if (end >= 0) return got.bytes.subarray(0, end).toString("utf8");
  if (!got.complete) return null; // no newline inside the cap: the first line is oversized
  return got.bytes.toString("utf8");
}

/**
 * A whole text file, at most `maxBytes`; null when unreadable, swapped under the read, a
 * symlink, not a regular file, or larger than the cap.
 */
export function wholeText(file, { maxBytes = 16 * 1024 * 1024, afterOpen = null } = {}) {
  const got = readProven(file, { maxBytes, afterOpen });
  if (!got || !got.complete || got.size > maxBytes) return null;
  return got.bytes.toString("utf8");
}
