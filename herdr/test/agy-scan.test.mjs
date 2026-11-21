import { test } from "node:test";
import assert from "node:assert/strict";
import { crossJoined, heldKey, heldSpaces, machineOf, nextVisits, observe, resolvePane, sampleOf,
  stillCandidate, treeTerminals } from "../mods/am-sidebar/agyScan.js";
import { SYNTHETIC, TRUST, trustScreen, fileScreen } from "./agy-prompt-fixture.mjs";

const read = (entry, text = trustScreen, created = 1) => observe(entry, { ok: true, text }, created, SYNTHETIC);
const fail = (entry) => observe(entry, { ok: false }, 1, SYNTHETIC);
const held = () => read(read(null));

test("held on the second identical matching read", () => {
  const first = read(null);
  assert.equal(first.held, null);
  assert.equal(first.match.question, TRUST);
  const second = read(first);
  assert.equal(second.held.question, TRUST);
  assert.equal(heldKey(first), "");
  assert.equal(heldKey(second), JSON.stringify(["folder-trust", trustScreen, TRUST]));
});

test("a changed screen or a read with no match clears at once", () => {
  assert.equal(read(held(), "output\n" + trustScreen).held, null);
  const answered = read(held(), trustScreen + "\n> ");
  assert.equal(answered.held, null);
  assert.equal(answered.match, null);
  assert.equal(read(answered).held, null);
});

test("changing output above a quoted prompt is not held", () => {
  const first = read(null, "quote 1\n" + trustScreen);
  assert.ok(first.match);
  assert.equal(read(first, "quote 2\n" + trustScreen).held, null);
});

test("trust then file-access is not held", () => {
  const second = read(read(null), fileScreen());
  assert.equal(second.held, null);
  assert.equal(second.match.kind, "file-access");
});

test("tails differing only in an escape sequence are not held", () => {
  const second = read(read(null), "\u001b[31m" + trustScreen);
  assert.equal(second.held, null);
  assert.equal(second.match.block, trustScreen);
});

test("one failed read preserves the observation, two clear it, and success resets the count", () => {
  const before = held();
  const first = fail(before);
  assert.deepEqual(first, { ...before, fails: 1 });
  assert.deepEqual(fail(first), { created: 1, tail: null, match: null, held: null, fails: 0 });
  assert.equal(read(fail(first)).held, null);
  assert.deepEqual(fail(read(first)), first);
});

test("a new lifetime starts fresh", () => {
  const next = read(held(), trustScreen, 2);
  assert.equal(next.created, 2);
  assert.equal(next.held, null);
  assert.ok(read(next, trustScreen, 2).held);
});

test("a frozen full quotation is held, the documented residual case", () => {
  const text = "A SYNTHETIC quotation follows:\n" + trustScreen;
  assert.equal(read(read(null, text), text).held.question, TRUST);
});

test("stillCandidate checks the live identity, lifetime and core status", () => {
  const terminal = { state: "live", address: "t1", created_ms: 1, foreground: { argv: ["agy"] } };
  for (const status of [null, "working", "idle", "done"]) assert.ok(stillCandidate({ ...terminal, status }, 1));
  for (const status of ["blocked", "error", "unknown"]) assert.equal(stillCandidate({ ...terminal, status }, 1), false);
  assert.equal(stillCandidate(terminal, 2), false);
  assert.equal(stillCandidate({ ...terminal, foreground: { argv: ["sh"] } }, 1), false);
  assert.equal(stillCandidate(null, 1), false);
});

test("nextVisits visits at most eight per tick, round-robin, each once, and wraps", () => {
  const list = Array.from({ length: 10 }, (_, i) => i);
  const first = nextVisits(list, 0);
  assert.deepEqual(first, { visit: list.slice(0, 8), next: 8 });
  assert.deepEqual(nextVisits(list, first.next), { visit: [8, 9, 0, 1, 2, 3, 4, 5], next: 6 });
  assert.deepEqual(nextVisits([0, 1], 9), { visit: [1, 0], next: 1 });
  assert.deepEqual(nextVisits([], 4), { visit: [], next: 0 });
});

test("only the first of 40 newline-terminated rows changing is a changed screen", () => {
  const screen = (first) => [first, ...Array(36).fill(""), trustScreen, ""].join("\n");
  assert.equal(sampleOf(screen("first")).split("\n").length, 40);
  assert.ok(sampleOf(screen("first")).startsWith("first\n\n"));
  const change = read(read(null, screen("first")), screen("second"));
  assert.equal(change.match.question, TRUST);
  assert.equal(change.held, null);
  assert.equal(read(change, screen("second")).held.question, TRUST);
  assert.equal(sampleOf("old\r\n" + screen("first").replaceAll("\n", "\r\n")), sampleOf(screen("first")));
});

test("treeTerminals walks bot groups and members and skips a hidden helper's subtree", () => {
  const node = (terminal, opts = {}) => ({ live: { terminal }, helpers: [], members: [], ...opts });
  const tree = {
    main: node("t1", { members: [node("t5")], helpers: [
      { terminal: "t2", depth: 0 }, { terminal: "t3", depth: 1 }, { terminal: "t4", depth: 0 },
    ] }),
    categories: [{ bots: [null, node("t6")] }],
    uncategorised: [node(null, { live: null, held: "t7" }), node("t8")],
  };
  assert.deepEqual(treeTerminals(tree), ["t1", "t2", "t3", "t4", "t5", "t6", "t8"]);
  assert.deepEqual(treeTerminals(tree, (n) => n.live?.terminal ?? n.held, (a) => a !== "t2"),
    ["t1", "t4", "t5", "t6", "t7", "t8"]);
});

test("crossJoined is a remote terminal with a bare parent only", () => {
  assert.ok(crossJoined({ address: "box/t2", parent: "t1" }));
  for (const [address, parent] of [["box/t2", "box/t1"], ["t2", "t1"], ["box/t2", ""], ["box/t2", null]]) {
    assert.equal(crossJoined({ address, parent }), false);
  }
  assert.equal(machineOf("box/t2"), "box");
  assert.equal(machineOf("t2"), null);
});

test("resolvePane matches an exact address or a unique renamed-machine alias", () => {
  const record = (address, tab = "tab1") => ({ address, labels: { "herdr.tab": tab } });
  const local = record("t2"), renamed = record("server/t2"), other = record("other/t2");
  const names = new Set(["host-b"]);
  const resolve = (rows, address, tab = "host-b/tab1") => resolvePane(rows, address, tab, names);
  assert.equal(resolve([local, renamed], "t2"), local);
  assert.equal(resolve([local, renamed], "server/t2"), renamed);
  assert.equal(resolve([local, renamed, record("server/t2")], "host-b/t2"), renamed);
  assert.equal(resolve([local, renamed, other], "host-b/t2"), null);
  assert.equal(resolve([local, renamed], "host-b/t2", "host-b/tab2"), null);
  names.add("other");
  assert.equal(resolve([local, renamed, other], "host-b/t2"), renamed);
  names.add("server");
  assert.equal(resolve([local, renamed], "host-b/t2"), null);
});

test("heldSpaces gives each space its first held question in drawn order", () => {
  const place = new Map([["t1", null], ["t2", "s1"], ["t3", "s1"], ["t4", "s1"], ["t5", "s2"]]);
  const hits = new Map([["t1", { question: "spaceless" }], ["t3", { question: "first" }], ["t4", { question: "second" }]]);
  assert.deepEqual([...heldSpaces(place, hits)], [["s1", "first"]]);
});
