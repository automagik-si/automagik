// The persistent seen-ids journal behind `am notify`: the event ids the shim has queued, kept
// across executions so a restart dedupes instead of queuing an event twice. One JSON string per
// line (an id), oldest first; the newest `capacity` ids are kept (1000 by default), the oldest
// evicted, so the file cannot grow without bound. The file is 0600 (an existing broader file is
// tightened) and is rewritten atomically (a sibling temp file, then a rename) after every add.
//
// has/add keep createSeenJournal's semantics: the shim calls add only after a queued result, so a
// refused, paused, stopped, suppressed or failed line is never written. A missing file is empty;
// an unreadable or corrupt file is refused, never silently reset: openSeenJournal throws
// SeenJournalError and the CLI exits 3 before reading stdin.
//
// One writer is assumed (the harness runs one notify at a time); the atomic rename keeps a reader
// from ever seeing a partial file. Apache-2.0.

import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export const SEEN_CAPACITY = 1000;

/** A journal read/write problem. `kind` is "read" (refused before stdin) or "write" (io, stops). */
export class SeenJournalError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = "SeenJournalError";
    this.kind = kind;
  }
}

function parse(text) {
  const ids = [];
  for (const raw of text.split("\n")) {
    if (raw === "") continue;
    let id;
    try {
      id = JSON.parse(raw);
    } catch {
      throw new SeenJournalError("a line is not JSON", "read");
    }
    if (typeof id !== "string" || id.length === 0 || id.includes("\n")) throw new SeenJournalError("a line is not an event id", "read");
    ids.push(id);
  }
  return ids;
}

/**
 * Opens the journal at `path`, loading the ids it holds. A missing file is empty. Throws
 * SeenJournalError when the file cannot be read or is corrupt, before anything is processed.
 * The returned store has createSeenJournal's has/add (add writes the file) and its size/capacity.
 */
export function openSeenJournal(path, options = {}) {
  if (typeof path !== "string" || path.length === 0) throw new TypeError("the seen journal needs a path");
  const capacity = options.capacity ?? SEEN_CAPACITY;
  if (!Number.isInteger(capacity) || capacity < 1) throw new TypeError("seen journal capacity must be a positive integer");
  const order = [];
  const ids = new Set();
  const remember = (id) => {
    if (ids.has(id)) return;
    ids.add(id);
    order.push(id);
    while (ids.size > capacity) ids.delete(order.shift());
  };

  if (existsSync(path)) {
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      throw new SeenJournalError(`cannot read ${path}: ${e.code ?? e.message}`, "read");
    }
    let loaded;
    try {
      loaded = parse(text);
    } catch (e) {
      if (e instanceof SeenJournalError) throw new SeenJournalError(`${path}: ${e.message}`, "read");
      throw e;
    }
    for (const id of loaded) remember(id);
    try {
      if ((statSync(path).mode & 0o777) !== 0o600) chmodSync(path, 0o600);
    } catch (e) {
      throw new SeenJournalError(`cannot set 0600 on ${path}: ${e.code ?? e.message}`, "read");
    }
  }

  const persist = () => {
    let tmp;
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      const fd = openSync(tmp, "w", 0o600);
      try {
        writeSync(fd, order.map((id) => `${JSON.stringify(id)}\n`).join(""));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
      chmodSync(path, 0o600);
    } catch (e) {
      if (tmp) {
        try { unlinkSync(tmp); } catch { /* nothing to clean, or already renamed */ }
      }
      throw new SeenJournalError(`cannot write ${path}: ${e.code ?? e.message}`, "write");
    }
  };

  return {
    path,
    capacity,
    has(id) {
      return ids.has(id);
    },
    add(id) {
      if (typeof id !== "string" || id.length === 0) return;
      if (ids.has(id)) return;
      remember(id);
      persist();
    },
    get size() {
      return ids.size;
    },
  };
}
