// The session reader's rows: a synthetic JSON Lines session record in, the shim's staged receipts
// out. Every record here is a string we construct; no session file, transcript, queue or feed is
// read, and nothing is sent. The item id is deliberately different from the event id so a reader
// that passes the event id where the item id belongs cannot pass.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CHANNEL_NATURE } from "../mods/am-sidebar/eventNotice.mjs";
import { readSession } from "../mods/am-sidebar/sessionReader.mjs";

const EVENT = "evt-7f3a";
const ITEM = "item-9c1";
const ASSISTANT = "item-9c2";
const SOURCE = "synthetic-session";
const WINDOW = 60_000;
const NOW = Date.parse("2026-11-17T09:05:00Z");
const at = (clock) => `2026-11-17T09:${clock}Z`;
const lines = (...records) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
const item = (extra = {}) => ({
  type: "user-input",
  itemId: ITEM,
  text: `System notice (data, not a request): an event arrived.\nevent: ${EVENT}`,
  at: at("04:30"),
  threadId: "t1",
  ...extra,
});
const answer = (extra = {}) => ({ type: "assistant", itemId: ASSISTANT, text: "Done.", at: at("04:40"), threadId: "t1", ...extra });
const read = (text, extra = {}) => readSession({ text, eventId: EVENT, windowMs: WINDOW, now: NOW, source: SOURCE, ...extra });

test("session reader: a clean session yields started, finished and the transcript receipt", () => {
  assert.notEqual(ITEM, EVENT, "the fixture pins the item id apart from the event id");
  const got = read(lines(item(), answer()));
  assert.equal(got.ok, true);
  assert.equal(got.source, SOURCE);
  assert.deepEqual(got.started, { state: "started", itemId: ITEM, at: at("04:30"), source: SOURCE });
  assert.deepEqual(got.finished, { state: "finished", itemId: ASSISTANT, at: at("04:40"), source: SOURCE });
  assert.deepEqual(got.transcript, { ok: true, items: 1, line: CHANNEL_NATURE });
});

test("session reader: an assistant that quotes the id is not a user-input item", () => {
  const got = read(lines(answer({ text: `The notice carried ${EVENT}.` })));
  assert.equal(got.ok, true);
  assert.equal(got.started.state, "unknown");
  assert.equal(got.started.reason, "no user-input item in the window");
  assert.deepEqual(got.transcript, { ok: false, items: 0, line: CHANNEL_NATURE });
  assert.deepEqual(got.finished, { state: "unknown", itemId: null, at: null, source: SOURCE, reason: "no started item" });
});

test("session reader: two user-input items with the id are unproven", () => {
  const got = read(lines(item(), item({ itemId: "item-9c3" }), answer()));
  assert.equal(got.ok, true);
  assert.equal(got.started.state, "unproven");
  assert.equal(got.started.count, 2);
  assert.deepEqual(got.transcript, { ok: false, items: 2, line: CHANNEL_NATURE });
  assert.equal(got.finished.state, "unknown");
  assert.equal(got.finished.reason, "no started item");
});

test("session reader: the started observation is windowed and the transcript is not", () => {
  const got = read(lines(item({ at: at("02:00") }), answer({ at: at("02:10") })));
  assert.equal(got.ok, true);
  assert.equal(got.started.state, "unknown");
  assert.equal(got.started.reason, "no user-input item in the window");
  assert.deepEqual(got.transcript, { ok: true, items: 1, line: CHANNEL_NATURE });
});

test("session reader: an item after the clock is not in the window", () => {
  const got = read(lines(item({ at: at("06:00") }), answer({ at: at("06:10") })));
  assert.equal(got.ok, true);
  assert.equal(got.started.state, "unknown");
  assert.equal(got.started.reason, "no user-input item in the window");
  assert.deepEqual(got.transcript, { ok: true, items: 1, line: CHANNEL_NATURE });
});

test("session reader: a thread change under the read is unknown", () => {
  const got = read(lines(item(), answer({ threadId: "t2" })));
  assert.equal(got.ok, true);
  assert.equal(got.started.state, "unknown");
  assert.equal(got.started.reason, "thread changed under the read");
});

test("session reader: a finished observation needs the assistant after the item", () => {
  const got = read(lines(answer({ itemId: "item-early", at: at("04:00") }), item()));
  assert.equal(got.ok, true);
  assert.equal(got.started.state, "started");
  assert.equal(got.finished.state, "unknown");
  assert.equal(got.finished.reason, "no assistant message after the item");
});

test("session reader: a tool record between the item and the assistant does not stop the finish", () => {
  const got = read(lines(item(), { type: "tool", text: "ran", at: at("04:35"), threadId: "t1" }, answer()));
  assert.equal(got.ok, true);
  assert.deepEqual(got.finished, { state: "finished", itemId: ASSISTANT, at: at("04:40"), source: SOURCE });
});

test("session reader: a malformed line is refused with its line number", () => {
  assert.deepEqual(read("not json\n"), { ok: false, reason: "line 1: must be one JSON object", line: 1 });
});

test("session reader: a JSON non-object line is refused", () => {
  assert.deepEqual(read("[1,2]\n"), { ok: false, reason: "line 1: must be one JSON object", line: 1 });
  assert.deepEqual(read("null\n"), { ok: false, reason: "line 1: must be one JSON object", line: 1 });
});

test("session reader: a type outside the set is refused", () => {
  assert.deepEqual(read(lines({ type: "human", text: "x" })), { ok: false, reason: "line 1: type must be user-input, assistant or tool", line: 1 });
});

test("session reader: a present field of the wrong type or an unparseable at is refused", () => {
  for (const [fields, reason] of [
    [{ type: "user-input", itemId: 5 }, "line 1: itemId must be a string"],
    [{ type: "user-input", text: 5 }, "line 1: text must be a string"],
    [{ type: "user-input", at: 5 }, "line 1: at must be a string"],
    [{ type: "user-input", at: "not-a-date" }, "line 1: at must parse as a date"],
    [{ type: "user-input", threadId: 5 }, "line 1: threadId must be a string"],
  ]) {
    assert.deepEqual(read(lines(fields)), { ok: false, reason, line: 1 });
  }
});

test("session reader: an invalid window is refused", () => {
  for (const windowMs of [-1, Number.NaN, "60000"]) {
    assert.deepEqual(read(lines(item()), { windowMs }), { ok: false, reason: "windowMs: must be a non-negative number of milliseconds" });
  }
});

test("session reader: an invalid clock is refused", () => {
  for (const now of [Number.NaN, "now", null]) {
    assert.deepEqual(read(lines(item()), { now }), { ok: false, reason: "now: must be an epoch-millisecond number" });
  }
});

test("session reader: an invalid source is refused", () => {
  for (const source of ["", 5, null]) {
    assert.deepEqual(read(lines(item()), { source }), { ok: false, reason: "source: must be a non-empty string" });
  }
});

test("session reader: an invalid event id is refused", () => {
  for (const eventId of ["", 5, null]) {
    assert.deepEqual(read(lines(item()), { eventId }), { ok: false, reason: "eventId: must be a non-empty string" });
  }
});

test("session reader: blank lines are skipped and line numbers count them", () => {
  const clean = read(`\n${lines(item(), answer())}\n`);
  assert.equal(clean.ok, true);
  assert.equal(clean.started.state, "started");
  assert.deepEqual(read("\n\nnot json\n"), { ok: false, reason: "line 3: must be one JSON object", line: 3 });
});

test("session reader: an empty or blank-only session is a valid read with no receipts", () => {
  for (const text of ["", "\n", "\n  \n\t\n"]) {
    const got = read(text);
    assert.equal(got.ok, true);
    assert.equal(got.source, SOURCE);
    assert.equal(got.started.state, "unknown");
    assert.equal(got.started.reason, "no user-input item in the window");
    assert.deepEqual(got.finished, { state: "unknown", itemId: null, at: null, source: SOURCE, reason: "no started item" });
    assert.deepEqual(got.transcript, { ok: false, items: 0, line: CHANNEL_NATURE });
  }
});
