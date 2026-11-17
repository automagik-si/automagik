// The caller/integration around the session reader: it supplies the synthetic session record text
// to readSession and carries the two duties the reader deliberately leaves to the caller.
//
//   1. THE EXPECTED THREAD. Every thread id in the session must be the one the caller expected (and
//      at least one must be present). A consistent but wrong thread is not "started"; the thread
//      duty downgrades BOTH the started and the finished receipt and keeps the transcript.
//   2. UNIQUE ITEM IDS. The finished receipt depends on finding the started item by its id, so an
//      id reused anywhere in the session makes the finished receipt untrustworthy. A reused id is
//      reported with its count and the finished is withheld; the started is not affected.
//
// The caller is pure: text in, receipts out. It reads no file, spawns nothing, opens no socket and
// sends nothing; the text is synthetic, supplied by the caller's measurement, which runs in a
// scratch home. A reader refusal is returned as it is; the transcript is never downgraded. Empty
// string item ids are not ids and are ignored by the uniqueness duty. Apache-2.0.

import { readSession } from "./sessionReader.mjs";

function refusal(reason) {
  return { ok: false, reason };
}

/** The ids that appear more than once in the session; empty-string item ids are not ids. */
function reusedIds(records) {
  const counts = new Map();
  for (const record of records) {
    if (typeof record.itemId === "string" && record.itemId.length > 0) counts.set(record.itemId, (counts.get(record.itemId) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([id, count]) => ({ id, count }));
}

function recordsOf(text) {
  const records = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    records.push(JSON.parse(line));
  }
  return records;
}

/**
 * Measures a synthetic session for `eventId` against the caller's `expectedThreadId`: the reader's
 * started/finished/transcript receipts plus the caller's duties. Inputs as readSession, with
 * expectedThreadId a non-empty string. Invalid expectedThreadId is refused before the read; a
 * reader refusal is returned as it is. The duties are computed over the WHOLE session, not just
 * the reader's window.
 */
export function measureSession(options = {}) {
  const { text, eventId, expectedThreadId, windowMs, now, source } = options;
  if (typeof expectedThreadId !== "string" || expectedThreadId.length === 0) return refusal("expectedThreadId: must be a non-empty string");
  const read = readSession({ text, eventId, windowMs, now, source });
  if (!read.ok) return read;

  const records = recordsOf(text);
  const seen = [...new Set(records.map((record) => record.threadId).filter((thread) => typeof thread === "string"))];
  const threadOk = seen.length > 0 && seen.every((thread) => thread === expectedThreadId);
  const threadReason = seen.length === 0
    ? "no thread id in the records"
    : `the session's thread ${seen.join(", ")} is not the expected ${expectedThreadId}`;
  const reused = reusedIds(records);
  const uniqueOk = reused.length === 0;
  const duties = {
    thread: { ok: threadOk, expected: expectedThreadId, seen },
    uniqueItemIds: { ok: uniqueOk, reused },
  };
  let started = read.started;
  let finished = read.finished;
  if (!threadOk) {
    duties.thread.reason = threadReason;
    started = { state: "unknown", itemId: null, at: null, source, reason: threadReason };
    finished = { state: "unknown", itemId: null, at: null, source, reason: threadReason };
  } else if (!uniqueOk) {
    const reusedText = reused.map((entry) => `${entry.id} x${entry.count}`).join(", ");
    finished = { state: "unknown", itemId: null, at: null, source, reason: `item id ${reusedText} is not unique; the finished receipt is not trusted` };
  }
  return { ok: true, source, expectedThreadId, duties, started, finished, transcript: read.transcript };
}
