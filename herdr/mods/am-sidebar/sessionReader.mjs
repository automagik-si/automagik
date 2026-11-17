// The session reader for the voice harness: one synthetic chat session record in, the shim's
// staged receipts out. The record is a JSON Lines TEXT the caller supplies (in tests, one we
// construct); this module reads no file, spawns nothing, opens no socket and sends nothing. A
// later step's caller reads the chat's own record and passes its text here.
//
// A session record is { type: "user-input" | "assistant" | "tool", itemId?: string, text?: string,
// at?: ISO string, threadId?: string } (the shape eventNotice.mjs documents). Blank lines are
// skipped; every other line must be one object of that shape, or the read is refused. A refused
// read returns { ok: false, reason, line? } and invents no receipt: nothing is rewritten.
//
// On a valid read the receipts are the shim's own: STARTED is the windowed observation of at most
// one user-input item carrying the event id (the window and the clock are the caller's); FINISHED
// is the assistant record after that item, and unknown when there is no started item; TRANSCRIPT
// counts the session's user-input items carrying the event id and is NOT windowed - a quoted
// mention in an assistant message is not an item. No stage is inferred from a queue call.
// Apache-2.0.

import { observeFinished, observeStarted, transcriptReceipt } from "./eventNotice.mjs";

const TYPES = new Set(["user-input", "assistant", "tool"]);
const STRING_FIELDS = ["itemId", "text", "at", "threadId"];

function refusal(reason, line) {
  return line === undefined ? { ok: false, reason } : { ok: false, reason, line };
}

function parseRecords(text) {
  const records = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") continue;
    const number = index + 1;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return { refused: refusal(`line ${number}: must be one JSON object`, number) };
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) return { refused: refusal(`line ${number}: must be one JSON object`, number) };
    if (!TYPES.has(record.type)) return { refused: refusal(`line ${number}: type must be user-input, assistant or tool`, number) };
    for (const field of STRING_FIELDS) {
      if (!(field in record) || record[field] === undefined || record[field] === null) continue;
      if (typeof record[field] !== "string") return { refused: refusal(`line ${number}: ${field} must be a string`, number) };
    }
    if (typeof record.at === "string" && !Number.isFinite(Date.parse(record.at))) return { refused: refusal(`line ${number}: at must parse as a date`, number) };
    records.push(record);
  }
  return { records };
}

/**
 * Reads `text` (a synthetic JSON Lines session record) into the staged receipts for `eventId`.
 * Inputs: text a string; eventId a non-empty string; windowMs a finite number >= 0; now a finite
 * epoch-millisecond number; source a non-empty label. A malformed input or record is refused.
 */
export function readSession(options = {}) {
  const { text, eventId, windowMs, now, source } = options;
  if (typeof text !== "string") return refusal("text: must be a string");
  if (typeof eventId !== "string" || eventId.length === 0) return refusal("eventId: must be a non-empty string");
  if (!Number.isFinite(windowMs) || windowMs < 0) return refusal("windowMs: must be a non-negative number of milliseconds");
  if (!Number.isFinite(now)) return refusal("now: must be an epoch-millisecond number");
  if (typeof source !== "string" || source.length === 0) return refusal("source: must be a non-empty string");

  const parsed = parseRecords(text);
  if (parsed.refused) return parsed.refused;
  const records = parsed.records;

  const started = observeStarted(records, eventId, windowMs, now, source);
  const finished = started.state === "started" && typeof started.itemId === "string" && started.itemId.length > 0
    ? observeFinished(records, started.itemId, source)
    : { state: "unknown", itemId: null, at: null, source, reason: "no started item" };
  const transcript = transcriptReceipt(
    records
      .filter((record) => record.type === "user-input" || record.type === "assistant")
      .map((record) => ({ kind: record.type, text: typeof record.text === "string" ? record.text : "" })),
    eventId,
  );
  return { ok: true, source, started, finished, transcript };
}
