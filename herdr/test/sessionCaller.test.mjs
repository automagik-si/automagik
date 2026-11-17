// The caller's rows: the synthetic session record text + the caller's expected thread id in, the
// reader's receipts plus the caller's two duties out. Every record is a string we construct; the
// scratch row writes it to a temp directory only. No real session, transcript, queue or feed is
// read, and nothing is sent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHANNEL_NATURE } from "../mods/am-sidebar/eventNotice.mjs";
import { measureSession } from "../mods/am-sidebar/sessionCaller.mjs";

const EVENT = "evt-7f3a";
const ITEM = "item-9c1";
const ASSISTANT = "item-9c2";
const THREAD = "01a1e53f-13b4-75e1-83db-734576e0cf20";
const OTHER = "01a1e588-5115-72e2-ba36-375fca02f328";
const SOURCE = "synthetic-session";
const WINDOW = 60_000;
const NOW = Date.parse("2026-11-17T09:05:00Z");
const at = (clock) => `2026-11-17T09:${clock}Z`;
const lines = (...records) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
const item = (extra = {}) => ({ type: "user-input", itemId: ITEM, text: `System notice: event ${EVENT}`, at: at("04:30"), threadId: THREAD, ...extra });
const answer = (extra = {}) => ({ type: "assistant", itemId: ASSISTANT, text: "Done.", at: at("04:40"), threadId: THREAD, ...extra });
const measure = (text, extra = {}) => measureSession({ text, eventId: EVENT, expectedThreadId: THREAD, windowMs: WINDOW, now: NOW, source: SOURCE, ...extra });

test("caller: a clean synthetic session satisfies both duties and keeps the receipts", () => {
  const got = measure(lines(item(), answer()));
  assert.equal(got.ok, true);
  assert.equal(got.source, SOURCE);
  assert.deepEqual(got.duties.thread, { ok: true, expected: THREAD, seen: [THREAD] });
  assert.deepEqual(got.duties.uniqueItemIds, { ok: true, reused: [] });
  assert.deepEqual(got.started, { state: "started", itemId: ITEM, at: at("04:30"), source: SOURCE });
  assert.deepEqual(got.finished, { state: "finished", itemId: ASSISTANT, at: at("04:40"), source: SOURCE });
  assert.deepEqual(got.transcript, { ok: true, items: 1, line: CHANNEL_NATURE });
});

test("caller: a consistent but wrong thread downgrades started and finished", () => {
  const got = measure(lines(item({ threadId: OTHER }), answer({ threadId: OTHER })));
  const reason = `the session's thread ${OTHER} is not the expected ${THREAD}`;
  assert.equal(got.ok, true);
  assert.deepEqual(got.duties.thread, { ok: false, expected: THREAD, seen: [OTHER], reason });
  assert.deepEqual(got.started, { state: "unknown", itemId: null, at: null, source: SOURCE, reason });
  assert.deepEqual(got.finished, { state: "unknown", itemId: null, at: null, source: SOURCE, reason });
  assert.deepEqual(got.transcript, { ok: true, items: 1, line: CHANNEL_NATURE });
});

test("caller: a later record on another thread fails the thread duty", () => {
  const got = measure(lines(item(), answer({ threadId: OTHER })));
  assert.equal(got.duties.thread.ok, false);
  assert.deepEqual(got.duties.thread.seen, [THREAD, OTHER]);
  assert.equal(got.started.state, "unknown");
});

test("caller: a session with no thread id fails the thread duty", () => {
  const got = measure(lines(item({ threadId: undefined }), answer({ threadId: undefined })));
  assert.deepEqual(got.duties.thread, { ok: false, expected: THREAD, seen: [], reason: "no thread id in the records" });
  assert.equal(got.started.state, "unknown");
});

test("caller: a reused started item id withholds the finished receipt", () => {
  const got = measure(lines(item(), answer(), { type: "tool", itemId: ITEM, text: "ran", at: at("04:50"), threadId: THREAD }));
  assert.deepEqual(got.duties.uniqueItemIds, { ok: false, reused: [{ id: ITEM, count: 2 }] });
  assert.deepEqual(got.started, { state: "started", itemId: ITEM, at: at("04:30"), source: SOURCE });
  assert.deepEqual(got.finished, {
    state: "unknown", itemId: null, at: null, source: SOURCE,
    reason: `item id ${ITEM} x2 is not unique; the finished receipt is not trusted`,
  });
});

test("caller: a reused id elsewhere in the session withholds the finished receipt", () => {
  const got = measure(lines(
    item(),
    { type: "tool", itemId: "tool-x", at: at("04:45"), threadId: THREAD },
    answer(),
    { type: "tool", itemId: "tool-x", at: at("04:55"), threadId: THREAD },
  ));
  assert.deepEqual(got.duties.uniqueItemIds, { ok: false, reused: [{ id: "tool-x", count: 2 }] });
  assert.equal(got.started.state, "started");
  assert.deepEqual(got.finished, {
    state: "unknown", itemId: null, at: null, source: SOURCE,
    reason: "item id tool-x x2 is not unique; the finished receipt is not trusted",
  });
});

test("caller: unique ids keep the finished receipt trusted", () => {
  const got = measure(lines(item(), { type: "tool", itemId: "tool-1", at: at("04:35"), threadId: THREAD }, answer()));
  assert.equal(got.duties.uniqueItemIds.ok, true);
  assert.deepEqual(got.finished, { state: "finished", itemId: ASSISTANT, at: at("04:40"), source: SOURCE });
});

test("caller: a reader refusal is returned as it is", () => {
  assert.deepEqual(measure("not json\n"), { ok: false, reason: "line 1: must be one JSON object", line: 1 });
});

test("caller: an invalid expected thread id is refused before the read", () => {
  for (const expectedThreadId of ["", 5, null]) {
    assert.deepEqual(measure(lines(item(), answer()), { expectedThreadId }), { ok: false, reason: "expectedThreadId: must be a non-empty string" });
  }
});

test("caller: the measurement reads its synthetic input from a scratch directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "am-caller-scratch-"));
  try {
    const input = join(dir, "session.jsonl");
    writeFileSync(input, lines(item(), answer()));
    assert.ok(input.startsWith(dir), "the input lives under the scratch directory");
    const got = measure(readFileSync(input, "utf8"));
    assert.equal(got.ok, true);
    assert.equal(got.duties.thread.ok, true);
    assert.equal(got.duties.uniqueItemIds.ok, true);
    assert.deepEqual(got.started, { state: "started", itemId: ITEM, at: at("04:30"), source: SOURCE });
    assert.deepEqual(got.finished, { state: "finished", itemId: ASSISTANT, at: at("04:40"), source: SOURCE });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("caller: the duties cover the whole session, not just the reader's window", () => {
  const got = measure(lines(
    item(),
    answer(),
    { type: "tool", itemId: "tool-1", text: "old", at: "2026-11-17T08:00:00Z", threadId: OTHER },
  ));
  assert.equal(got.duties.thread.ok, false);
  assert.deepEqual(got.duties.thread.seen, [THREAD, OTHER]);
  assert.equal(got.started.state, "unknown");
});

test("caller: a session with no user-input item keeps the duties and reports no start", () => {
  const got = measure(lines(answer(), { type: "tool", itemId: "tool-1", at: at("04:50"), threadId: THREAD }));
  assert.equal(got.duties.thread.ok, true);
  assert.deepEqual(got.duties.uniqueItemIds, { ok: true, reused: [] });
  assert.equal(got.started.state, "unknown");
  assert.equal(got.started.reason, "no user-input item in the window");
  assert.deepEqual(got.finished, { state: "unknown", itemId: null, at: null, source: SOURCE, reason: "no started item" });
  assert.deepEqual(got.transcript, { ok: false, items: 0, line: CHANNEL_NATURE });
});

test("caller: empty-string item ids are not ids for the uniqueness duty", () => {
  const got = measure(lines(
    item(),
    { type: "tool", itemId: "", at: at("04:45"), threadId: THREAD },
    { type: "tool", itemId: "", at: at("04:50"), threadId: THREAD },
    answer(),
  ));
  assert.deepEqual(got.duties.uniqueItemIds, { ok: true, reused: [] });
  assert.equal(got.started.state, "started");
  assert.deepEqual(got.finished, { state: "finished", itemId: ASSISTANT, at: at("04:40"), source: SOURCE });
});
