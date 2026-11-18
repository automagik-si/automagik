// discover.js over a fake io with latency: lookups run a few at once per machine, this
// computer's projects are listed before another machine answers, a machine that never
// answers holds back only its own projects, and the list keeps sidebar order however the
// answers arrive.
import { test } from "node:test";
import assert from "node:assert/strict";

import { discover, limiter, machineGate, within, TimedOut } from "../mods/am-sidebar/discover.js";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const never = () => new Promise(() => {});
const FILE = (name) => ({ file: { version: 1, categories: [], bots: [{ id: name }] }, warnings: [] });

// A fake io: each machine's latency (Infinity: never answers), its folders' keys, and a log.
// Its calls to another machine bound themselves (as bots.js does each call) after `timeoutMs`.
function fakeIo({ latency = {}, keyOf = (folder) => folder, last = () => undefined, listed = [], timeoutMs = 0, cachedKey } = {}) {
  const io = { calls: [], inflight: {}, max: {}, done: [] };
  const answer = async (machine, what, value) => {
    const m = machine ?? "local";
    io.calls.push([m, what]);
    io.inflight[m] = (io.inflight[m] ?? 0) + 1;
    io.max[m] = Math.max(io.max[m] ?? 0, io.inflight[m]);
    try {
      const ms = latency[m] ?? 1;
      if (ms === Infinity) await never();
      await sleep(ms);
      io.done.push([m, what]);
      return value();
    } finally { io.inflight[m] -= 1; }
  };
  const timed = (machine, p) => within(p, machine ? timeoutMs : 0, sleep);
  io.keyOf = (folder, machine) => timed(machine, answer(machine, `key ${folder}`, () => keyOf(folder, machine)));
  io.read = (p) => timed(p.machine, answer(p.machine, `read ${p.key}`, () => FILE(`${p.machine ?? "local"}:${p.key}`)));
  io.last = last;
  io.cachedKey = cachedKey;
  io.listed = async () => listed;
  return io;
}

test("limiter: never more than `limit` running, started in the order given", async () => {
  const run = limiter(3);
  let now = 0, most = 0;
  const started = [];
  await Promise.all(Array.from({ length: 10 }, (_, i) => run(async () => {
    started.push(i);
    most = Math.max(most, ++now);
    await sleep(5);
    now -= 1;
  })));
  assert.equal(most, 3);
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("within: a call slower than its time rejects TimedOut; without a timer it just waits", async () => {
  await assert.rejects(within(never(), 20, sleep), TimedOut);
  assert.equal(await within(sleep(5).then(() => "yes"), 1000, sleep), "yes");
  assert.equal(await within("value", 20, null), "value");
  const late = Promise.reject(new Error("late")); // swallowed: no unhandled rejection
  await assert.rejects(within(late.then(() => sleep(50)), 5, sleep), /late|no answer/);
});

test("discover: lookups on one machine run at most `limit` at once, and do run together", async () => {
  const io = fakeIo({ latency: { local: 10 } });
  const spaces = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, folder: `/p${i}`, machine: null }));
  const found = await discover({ spaces }, io, { limit: 4 });
  assert.equal(found.length, 20);
  assert.equal(io.max.local, 4);
  // Each machine has its own bound.
  const io2 = fakeIo({ latency: { local: 10, far: 10 } });
  const mixed = [...spaces, ...spaces.map((s) => ({ ...s, id: `r${s.id}`, machine: "far" }))];
  await discover({ spaces: mixed }, io2, { limit: 3 });
  assert.equal(io2.max.local, 3);
  assert.equal(io2.max.far, 3);
});

test("discover: this computer's projects are listed before a slow machine answers", async () => {
  const io = fakeIo({ latency: { local: 2, far: 80 } });
  const spaces = [
    { id: "s1", folder: "/a", machine: "far" },
    { id: "s2", folder: "/b", machine: null },
    { id: "s3", folder: "/c", machine: "far" },
    { id: "s4", folder: "/d", machine: null },
  ];
  const updates = [];
  const t0 = Date.now();
  const found = await discover({ spaces }, io, { onUpdate: (list) => updates.push({ at: Date.now() - t0, list }) });
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].list.map((p) => p.key), ["/b", "/d"]);
  assert.ok(updates[0].at < 60, `local listed after ${updates[0].at} ms`);
  // Every local call was done before the first remote answer.
  const firstFar = io.done.findIndex(([m]) => m === "far");
  assert.ok(io.done.slice(firstFar).every(([m]) => m === "far"));
  // The full list, in sidebar order.
  assert.deepEqual(found.map((p) => [p.machine, p.key]), [["far", "/a"], [null, "/b"], ["far", "/c"], [null, "/d"]]);
});

test("discover: a machine that never answers holds back only its own projects, which show their last good file", async () => {
  const last = (p) => (p.machine === "dead" && ["/x", "/k"].includes(p.key) ? FILE(`dead-last${p.key}`) : undefined);
  // /w was keyed before: its known key places it at once, whatever "dead" does.
  const cachedKey = (f, m) => (m === "dead" && f === "/w" ? { key: "/k", fresh: true } : undefined);
  const io = fakeIo({ latency: { local: 2, dead: Infinity, far: 5 }, last, keyOf: (f) => f, timeoutMs: 60, cachedKey });
  const spaces = [
    { id: "s1", folder: "/x", machine: "dead" },
    { id: "s2", folder: "/b", machine: null },
    { id: "s3", folder: "/y", machine: "far" },
    { id: "s4", folder: "/z", machine: "dead" },
    { id: "s5", folder: "/w", machine: "dead" },
  ];
  const updates = [];
  const t0 = Date.now();
  const found = await discover({ spaces, remembered: [{ key: "/x", machine: "dead" }] }, io,
    { limit: 1, onUpdate: (list) => updates.push(list) });
  const took = Date.now() - t0;
  assert.ok(took < 400, `took ${took} ms`);
  // This computer's and far's projects were listed before the dead machine's time ran out.
  assert.deepEqual(updates.map((l) => l.map((p) => p.key)), [["/b", "/k", "/x"], ["/b", "/y", "/k", "/x"]]);
  // In the end: the remembered dead project and /w's (by its known key) with their last good
  // files; /z (never keyed) is skipped.
  assert.deepEqual(found.map((p) => [p.machine, p.key, p.spaces]), [[null, "/b", ["s2"]], ["far", "/y", ["s3"]], ["dead", "/k", ["s5"]], ["dead", "/x", []]]);
  assert.deepEqual(found.slice(2).map((p) => p.file.bots[0].id), ["dead-last/k", "dead-last/x"]);
  // After one call to the dead machine timed out, its others didn't wait (limit 1: one call).
  assert.equal(io.calls.filter(([m]) => m === "dead").length, 1);
});

test("discover: a project's spaces and the list keep sidebar order however the answers arrive", async () => {
  // Later spaces answer first.
  const spaces = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, folder: `/f${i}`, machine: i % 2 ? "far" : null }));
  const io = fakeIo({ keyOf: (f) => (f === "/f0" || f === "/f2" ? "/one" : f) });
  const slow = io.keyOf;
  io.keyOf = async (folder, machine) => { await sleep(30 - Number(folder.slice(2)) * 5); return slow(folder, machine); };
  const found = await discover({ spaces, remembered: [{ key: "/r", machine: null }] }, io, { listed: [] });
  assert.deepEqual(found.map((p) => p.key), ["/one", "/f1", "/f3", "/f4", "/f5", "/r"]);
  assert.deepEqual(found[0].spaces, ["s0", "s2"]);
});

test("discover: a known key places its space at once; one not fresh is looked up again, and a new key moves the space in the same discovery", async () => {
  const cachedKey = (f) => ({ "/a": { key: "/a", fresh: true }, "/b": { key: "/old", fresh: false } })[f];
  const io = fakeIo({ latency: { local: 20 }, keyOf: (f) => (f === "/b" ? "/new" : f), cachedKey });
  const spaces = [{ id: "s1", folder: "/a", machine: null }, { id: "s2", folder: "/b", machine: null }];
  const found = await discover({ spaces }, io);
  assert.deepEqual(found.map((p) => [p.key, p.spaces]), [["/a", ["s1"]], ["/new", ["s2"]]]);
  // The fresh key wasn't asked; the stale one was, once.
  assert.deepEqual(io.calls.filter(([, w]) => w.startsWith("key")).map(([, w]) => w), ["key /b"]);
});

test("machineGate: a machine that never answers is sent at most `limit` calls, however many are asked", async () => {
  const gate = machineGate(8, 20);
  let started = 0;
  const hang = () => { started += 1; return never(); };
  // 15 folders, three discoveries' worth of calls.
  for (let round = 0; round < 3; round++) {
    const asks = Array.from({ length: 15 }, () => gate.call(hang, { sleep, remote: true }).catch((e) => e));
    for (const e of await Promise.all(asks)) assert.ok(e instanceof TimedOut);
  }
  assert.equal(started, 8);
  assert.equal(gate.stuck, 8);
  assert.equal(gate.away, true);
  assert.equal(gate.answered, false);
});

test("machineGate: a call that times out queued never starts; one that answers frees its place and marks the machine answered", async () => {
  const gate = machineGate(1, 20);
  let release;
  const first = gate.call(() => new Promise((done) => { release = done; }), { sleep, remote: true }).catch((e) => e);
  let ran = false;
  const second = gate.call(() => { ran = true; return "late"; }, { sleep, remote: true }).catch((e) => e);
  assert.ok((await second) instanceof TimedOut);
  assert.ok((await first) instanceof TimedOut);
  release("ok"); // the stuck call answers after all
  await sleep(5);
  assert.equal(ran, false);
  assert.equal(gate.stuck, 0);
  assert.equal(gate.answered, true);
  assert.equal(gate.away, false);
  assert.equal(await gate.call(() => "now", { sleep, remote: true }), "now");
});
