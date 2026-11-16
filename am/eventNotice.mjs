// Event-notice shim for the voice harness: one strict event in, one fixed text string out, to be
// queued into a Codex chat by the queue command. Pure: no I/O, no process spawn, no network.
//
// THE CLAIM. The queue stores the text as a USER-INPUT text item, not as a data item, so
// data-not-instruction is a convention of the strict shapes, the fixed template and the chat's own
// rule, never a property of the queue; the boundary is behavioural. The source line below is a
// hint, not authentication.
//
// The event id appears once in the template text; that is a property of the text, not a count of
// anything the chat did; the receipt counts user-input items, not mentions: after a queue call the
// chat quotes the id in its own answers, and a mention is not an item.
//
// STARTED, FINISHED and HEARD are observed, separate receipts over injected data. Each carries its
// source, identifier and timestamp, and each is unknown when the evidence is missing or the read
// window closed; the window and the clock are injected. The started observer reports at most one
// input item observed per event id: zero items is unknown, one is started, two or more is unproven
// with the count. The finished observer reports the following assistant message after the item,
// whether or not that message names the id. The heard receipt formats a person's word or playback
// telemetry and is unknown by default. No stage is inferred from the queue call: the queue
// confirms queued only.
//
// Rehearsal facts (synthetic event, one Codex thread, closed): an idle chat took the strict-template
// notice as one user-input item and answered in about 4 s; a busy chat held the item in the queue
// and drained it after the turn as one user-input item; a free-form event is not a template result
// and is never cited as one; the closed chat was not tested for real, because the shim refuses it
// by its own thread check.
//
// A value outside its shape is a refusal: it is rejected, not rewritten.
//
// SPEC: This is a text queue with staged evidence from two sources (the queue call and the chat's
// own session record), not a structured event bus.
//
// API: buildNotice(event), deliverArgv(threadId, text), deliver(options), receiptLine(receipt),
// exitCodeFor(decision), runExitCode(receipts), createSeenJournal(capacity),
// countUserInputItems(transcript, eventId), transcriptReceipt(transcript, eventId),
// observeStarted(records, eventId, windowMs, now, source), observeFinished(records, itemId,
// source), heardReceipt(input), lintClaims(text), CHANNEL_NATURE, SPEC_LINE.
//
// A transcript item is { kind: "user-input" | "assistant", text }. A session record is
// { type: "user-input" | "assistant" | "tool", itemId, text, at, eventId?, threadId? }.
// Apache-2.0.

export const CHANNEL_NATURE = "channel: codex queue stores user-input text; data-not-instruction is a convention (strict shapes, fixed template, the chat's own rule), not enforced by the queue";

export const SPEC_LINE = "This is a text queue with staged evidence from two sources (the queue call and the chat's own session record), not a structured event bus.";

const FIRST_SENTENCE = "System notice (data, not a request): an event arrived.";
const SCHEMA_KEYS = new Set(["event_id", "source", "terminal", "seq", "from", "to", "observed_at"]);
const SOURCE_IDS = new Set(["hc-event-shim"]);
const STATES = new Set(["working", "blocked", "idle", "done", "error"]);
const DECISIONS = new Set(["refused", "deduped", "suppressed", "paused", "stopped", "queued", "failed"]);
const EVENT_ID_SHAPE = /^[a-z0-9][a-z0-9-]{7,63}$/;
const TERMINAL_SHAPE = /^(?:[a-z0-9-]{1,32}\/)?t[0-9a-z]{1,8}$/;
const THREAD_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OBSERVED_AT_SHAPE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const U64_MAX = 18446744073709551615n;

const EXIT_CODES = Object.freeze({ queued: 0, deduped: 0, suppressed: 0, paused: 0, stopped: 0, refused: 1, failed: 1 });

function daysInMonth(year, month) {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function checkString(value, field) {
  if (value === undefined) return `${field}: missing`;
  if (typeof value !== "string") return `${field}: must be a string`;
  return null;
}

function seqValue(value) {
  if (value === undefined) return { reason: "seq: missing" };
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return { reason: "seq: a number must be a safe integer" };
    if (value < 0) return { reason: "seq: must be an unsigned 64-bit integer" };
    return { text: String(value) };
  }
  if (typeof value === "string") {
    if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return { reason: "seq: a string must be all digits, with no sign or leading zeros" };
    if (BigInt(value) > U64_MAX) return { reason: "seq: must be at most 18446744073709551615" };
    return { text: value };
  }
  return { reason: "seq: must be a decimal string or a safe integer" };
}

function observedAtReason(value) {
  if (value === undefined) return "observed_at: missing";
  if (typeof value !== "string") return "observed_at: must be an RFC 3339 string";
  const match = OBSERVED_AT_SHAPE.exec(value);
  if (!match) return "observed_at: must be an RFC 3339 UTC timestamp with Z or an offset";
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12) return "observed_at: month must be 01 to 12";
  if (day < 1 || day > daysInMonth(year, month)) return "observed_at: day is not a real calendar day";
  if (hour > 23) return "observed_at: hour must be 00 to 23";
  if (minute > 59) return "observed_at: minute must be 00 to 59";
  if (second > 59) return "observed_at: second must be 00 to 59";
  if (offsetText !== "Z") {
    const offsetHour = Number(offsetText.slice(1, 3));
    const offsetMinute = Number(offsetText.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return "observed_at: offset is not a real UTC offset";
  }
  if (Number.isNaN(Date.parse(value))) return "observed_at: is not a real date";
  return null;
}

function threadReason(threadId) {
  if (threadId === undefined) return "thread id: missing";
  if (typeof threadId !== "string") return "thread id: must be a string";
  if (!THREAD_SHAPE.test(threadId)) return "thread id: must be a lowercase uuid";
  return null;
}

function knownEventId(event) {
  if (event === null || typeof event !== "object" || Array.isArray(event)) return null;
  const id = event.event_id;
  return typeof id === "string" && EVENT_ID_SHAPE.test(id) ? id : null;
}

function clock(now) {
  let value;
  try {
    value = typeof now === "function" ? now() : new Date().toISOString();
  } catch {
    value = undefined;
  }
  if (typeof value !== "string" || value.length === 0 || value.includes("\n")) return new Date().toISOString();
  return value;
}

function makeReceipt(eventId, decision, queueId, reason, at) {
  return { event_id: eventId ?? null, decision, queue_id: queueId ?? null, reason: reason ?? null, at };
}

export function buildNotice(event) {
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    return { ok: false, reason: "event: must be one JSON object" };
  }
  for (const key of Object.keys(event)) {
    if (!SCHEMA_KEYS.has(key)) {
      const named = SAFE_KEY.test(key) ? key : "a key outside the schema";
      return { ok: false, reason: `unexpected field: ${named}` };
    }
  }

  const id = event.event_id;
  let reason = checkString(id, "event_id");
  if (reason) return { ok: false, reason };
  if (!EVENT_ID_SHAPE.test(id)) return { ok: false, reason: "event_id: must match the fixed id shape" };

  reason = checkString(event.source, "source");
  if (reason) return { ok: false, reason };
  if (!SOURCE_IDS.has(event.source)) return { ok: false, reason: "source: must be an allowlisted origin id" };

  reason = checkString(event.terminal, "terminal");
  if (reason) return { ok: false, reason };
  if (!TERMINAL_SHAPE.test(event.terminal)) return { ok: false, reason: "terminal: must be a bare terminal id or a machine-qualified one" };

  const seq = seqValue(event.seq);
  if (seq.reason) return { ok: false, reason: seq.reason };

  for (const field of ["from", "to"]) {
    const value = event[field];
    reason = checkString(value, field);
    if (reason) return { ok: false, reason };
    if (!STATES.has(value)) return { ok: false, reason: `${field}: must be one of working, blocked, idle, done, error` };
  }

  reason = observedAtReason(event.observed_at);
  if (reason) return { ok: false, reason };

  const text = [
    FIRST_SENTENCE,
    `source: ${event.source}`,
    `event: ${id}`,
    `terminal: ${event.terminal}`,
    `seq: ${seq.text}`,
    `change: ${event.from} -> ${event.to}`,
  ].join("\n");

  if (text.split(id).length - 1 !== 1) {
    return { ok: false, reason: "event_id: must appear once in the template text" };
  }
  return { ok: true, text, id };
}

export function deliverArgv(threadId, text) {
  const reason = threadReason(threadId);
  if (reason) return { ok: false, reason };
  if (typeof text !== "string" || text.length === 0) return { ok: false, reason: "text: must be a non-empty string" };
  return ["codex", "queue", "--thread", threadId, "--message", text];
}

export function createSeenJournal(capacity = 1000) {
  if (!Number.isInteger(capacity) || capacity < 1) throw new TypeError("seen journal capacity must be a positive integer");
  const order = [];
  const ids = new Set();
  return {
    capacity,
    has(id) {
      return ids.has(id);
    },
    add(id) {
      if (ids.has(id)) return;
      ids.add(id);
      order.push(id);
      while (ids.size > capacity) ids.delete(order.shift());
    },
    get size() {
      return ids.size;
    },
  };
}

export function countUserInputItems(transcript, eventId) {
  if (!Array.isArray(transcript) || typeof eventId !== "string") return 0;
  let count = 0;
  for (const item of transcript) {
    if (item && item.kind === "user-input" && typeof item.text === "string" && item.text.includes(eventId)) count += 1;
  }
  return count;
}

export function transcriptReceipt(transcript, eventId) {
  const items = countUserInputItems(transcript, eventId);
  return { ok: items === 1, items, line: CHANNEL_NATURE };
}

export async function deliver(options = {}) {
  const { event, queue, seen, threadExists, threadCurrent, currentState, readControl, run, now, config } = options;
  const threadId = options.threadId ?? (config && config.threadId);
  const seenSet = seen ?? new Set();
  const at = () => clock(now);
  const eventId = knownEventId(event);

  if (run && typeof run === "object" && run.stopped === true) {
    return { status: "stopped", receipt: makeReceipt(eventId, "stopped", null, "control stopped", at()) };
  }

  const notice = buildNotice(event);
  if (!notice.ok) {
    return { status: "refused", reason: notice.reason, receipt: makeReceipt(eventId, "refused", null, notice.reason, at()) };
  }

  let control = "running";
  if (typeof readControl === "function") {
    try {
      control = await readControl();
    } catch {
      control = "stopped";
    }
  }
  if (control === "stopped") {
    if (run && typeof run === "object") run.stopped = true;
    return { status: "stopped", receipt: makeReceipt(notice.id, "stopped", null, null, at()) };
  }
  if (control !== "running") {
    return { status: "paused", receipt: makeReceipt(notice.id, "paused", null, null, at()) };
  }

  if (event.from === event.to) {
    return { status: "suppressed", reason: "no-op change", receipt: makeReceipt(notice.id, "suppressed", null, "no-op change", at()) };
  }

  const threadIssue = threadReason(threadId);
  if (threadIssue) {
    return { status: "refused", reason: threadIssue, receipt: makeReceipt(notice.id, "refused", null, threadIssue, at()) };
  }

  if (seenSet.has(notice.id)) {
    return { status: "duplicate", id: notice.id, receipt: makeReceipt(notice.id, "deduped", null, null, at()) };
  }

  if (typeof currentState === "function") {
    let state;
    try {
      state = await currentState(event.terminal);
    } catch {
      state = undefined;
    }
    if (state !== event.to) {
      return { status: "suppressed", reason: "state resolved", receipt: makeReceipt(notice.id, "suppressed", null, "state resolved", at()) };
    }
  }

  if (typeof threadCurrent === "function") {
    let current;
    try {
      current = await threadCurrent(threadId);
    } catch {
      current = undefined;
    }
    if (current === undefined || current === null || current === false) {
      return { status: "refused", reason: "thread not open or unknown", receipt: makeReceipt(notice.id, "refused", null, "thread not open or unknown", at()) };
    }
    if (current !== true && current !== threadId) {
      return { status: "refused", reason: "thread identity changed", receipt: makeReceipt(notice.id, "refused", null, "thread identity changed", at()) };
    }
  } else if (typeof threadExists === "function") {
    let exists;
    try {
      exists = await threadExists(threadId);
    } catch {
      exists = undefined;
    }
    if (exists !== true) {
      return { status: "refused", reason: "thread not open or unknown", receipt: makeReceipt(notice.id, "refused", null, "thread not open or unknown", at()) };
    }
  } else {
    return { status: "refused", reason: "thread not open or unknown", receipt: makeReceipt(notice.id, "refused", null, "thread not open or unknown", at()) };
  }

  const argv = deliverArgv(threadId, notice.text);
  if (!Array.isArray(argv)) {
    return { status: "refused", reason: argv.reason, receipt: makeReceipt(notice.id, "refused", null, argv.reason, at()) };
  }

  let queued;
  try {
    queued = await queue(argv);
  } catch {
    return { status: "failed", exit: undefined, receipt: makeReceipt(notice.id, "failed", null, null, at()) };
  }
  const exit = typeof queued === "number" ? queued : queued && typeof queued === "object" ? queued.exit : undefined;
  const queueId = queued && typeof queued === "object" ? (queued.queue_id ?? queued.id ?? null) : null;
  if (exit !== 0) {
    return { status: "failed", exit, receipt: makeReceipt(notice.id, "failed", queueId, null, at()) };
  }
  const receipt = makeReceipt(notice.id, "queued", queueId, null, at());
  try {
    seenSet.add(notice.id);
  } catch (error) {
    // The queue call succeeded, so the event went out; the store that should remember its id
    // failed. Return the queued receipt and the error: the caller writes the receipt, then
    // reports the id as unrecorded and exits io.
    return { status: "queued", id: notice.id, unrecorded: true, error, receipt };
  }
  return { status: "queued", id: notice.id, receipt };
}

export function receiptLine(receipt) {
  return JSON.stringify(receipt);
}

export function exitCodeFor(decision) {
  return Object.prototype.hasOwnProperty.call(EXIT_CODES, decision) && DECISIONS.has(decision) ? EXIT_CODES[decision] : 2;
}

export function runExitCode(receipts) {
  const list = Array.isArray(receipts) ? receipts : [];
  return list.some((receipt) => receipt && (receipt.decision === "refused" || receipt.decision === "failed")) ? 1 : 0;
}

export function observeStarted(records, eventId, windowMs, now, source = "chat session record") {
  const base = { source, itemId: null, at: null };
  if (!Array.isArray(records)) return { ...base, state: "unknown", reason: "records: must be an array" };
  if (!Number.isFinite(windowMs) || windowMs < 0) return { ...base, state: "unknown", reason: "window: must be a non-negative number of milliseconds" };
  if (!Number.isFinite(now)) return { ...base, state: "unknown", reason: "clock: must be an injected epoch millisecond value" };

  const threads = new Set();
  const inWindow = [];
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    if (typeof record.threadId === "string") threads.add(record.threadId);
    const at = Date.parse(record.at);
    if (!Number.isFinite(at)) continue;
    if (at < now - windowMs || at > now) continue;
    inWindow.push(record);
  }
  if (threads.size > 1) return { ...base, state: "unknown", reason: "thread changed under the read" };

  const items = inWindow.filter((record) => record.type === "user-input" && typeof record.text === "string" && record.text.includes(eventId));
  if (items.length === 0) return { ...base, state: "unknown", reason: "no user-input item in the window" };
  if (items.length > 1) return { ...base, state: "unproven", count: items.length, reason: "more than one user-input item carries the event id" };
  return { state: "started", itemId: items[0].itemId ?? null, at: items[0].at ?? null, source };
}

export function observeFinished(records, itemId, source = "chat session record") {
  const base = { source, itemId: null, at: null };
  if (!Array.isArray(records)) return { ...base, state: "unknown", reason: "records: must be an array" };
  const index = records.findIndex((record) => record && record.itemId === itemId);
  if (index === -1) return { ...base, state: "unknown", reason: "the item is not in the record" };
  for (let i = index + 1; i < records.length; i += 1) {
    const record = records[i];
    if (record && record.type === "assistant") {
      return { state: "finished", itemId: record.itemId ?? null, at: record.at ?? null, source };
    }
  }
  return { ...base, state: "unknown", reason: "no assistant message after the item" };
}

export function heardReceipt(input) {
  if (!input || typeof input !== "object") return { state: "unknown", source: null, by: null, at: null };
  const { source, by, at } = input;
  if ((source !== "human" && source !== "telemetry") || typeof by !== "string" || by.length === 0 || typeof at !== "string" || at.length === 0) {
    return { state: "unknown", source: source === "human" || source === "telemetry" ? source : null, by: typeof by === "string" ? by : null, at: typeof at === "string" ? at : null };
  }
  return { state: "heard", source, by, at };
}

const CLAIM_RULES = [
  { rule: "exactly once", pattern: /\bexactly\s+once\b/i },
  { rule: "exactly-once", pattern: /\bexactly-once\b/i },
  { rule: "exactly one near delivery or items", pattern: /\bexactly one\b[^.\n]{0,80}\b(?:deliver\w*|items?)\b|\b(?:deliver\w*|items?)\b[^.\n]{0,80}\bexactly one\b/i },
  { rule: "native receipt", pattern: /\bnative\s+receipt\b/i },
  { rule: "guaranteed", pattern: /\bguarantee(?:d|s)?\b/i },
  { rule: "proven", pattern: /\bproven\b/i, allowReceiptCitation: true },
  { rule: "filter", pattern: /\bfilter(?:s|ed|ing)?\b/i },
  { rule: "sanitis", pattern: /\bsanitis/i },
  { rule: "enforced", pattern: /\benforc(?:e|es|ed|ing)\b/i, allowNegation: true },
  { rule: "delivered", pattern: /\bdelivered\b/i },
  { rule: "structured", pattern: /\bstructured\b/i, allowNegation: true },
  { rule: "safe by construction", pattern: /\bsafe by construction\b/i, allowNegation: true },
];

export function lintClaims(text) {
  if (typeof text !== "string") throw new TypeError("lintClaims expects text");
  const violations = [];
  for (const rule of CLAIM_RULES) {
    const flags = rule.pattern.global ? rule.pattern : new RegExp(rule.pattern.source, `${rule.pattern.flags}g`);
    let match = flags.exec(text);
    while (match !== null) {
      const before = text.slice(Math.max(0, match.index - 12), match.index).toLowerCase();
      const negated = rule.allowNegation && /\bnot\s+(?:a\s+)?$/.test(before);
      const after = text.slice(match.index + match[0].length);
      const cited = rule.allowReceiptCitation && /^\s*\(receipt: [A-Za-z0-9._-]+\)/.test(after);
      if (!negated && !cited) violations.push({ rule: rule.rule, match: match[0], index: match.index });
      match = flags.exec(text);
    }
  }
  return violations.sort((a, b) => a.index - b.index);
}
