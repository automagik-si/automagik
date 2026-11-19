// The sidebar's usagemeter run (Group 6c, meter.js) with a fake exec, a fake clock and a fake
// shared store: when it runs, never twice at once, a missing binary and the meter's own exits are
// silent; SYNC under sh with fake binaries in a temp home; main.js's wiring; the marker's usagemeter
// line. Nothing here runs a real usagemeter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { METER_EVERY_MS, METER_FIRST_MS, METER_KEY, SYNC, meterBin, syncMeter } from "../mods/am-sidebar/meter.js";
import { formatMarker, parseMarker } from "../mods/am-sidebar/release.js";
import { closure } from "../../scripts/am-copies.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = meterBin("/home/someone");

/** Herdr's shared store as a Map: one per Herdr, every sidebar copy sees it. */
const sharedStore = () => {
  const m = new Map();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v) };
};

/** An exec that records each call and resolves (or rejects) when the test says. */
const gatedExec = () => {
  const calls = [];
  const exec = (cmd, args) => new Promise((resolve, reject) => calls.push({ cmd, args, resolve, reject }));
  return { calls, exec };
};

test("usagemeter sync: SYNC with the shared binary's absolute path, no other argument", async () => {
  assert.equal(BIN, "/home/someone/.local/bin/usagemeter");
  const calls = [];
  const r = await syncMeter({ exec: async (cmd, args) => { calls.push([cmd, args]); return { code: 0 }; }, bin: BIN, now: () => 1e12 });
  assert.deepEqual(calls, [["sh", ["-c", SYNC, "sh", BIN]]]);
  assert.deepEqual(r, { started: true, code: 0, wait: METER_EVERY_MS });
});

test("usagemeter sync: once 30 s after load, then at most once per 10 minutes over two hours", async () => {
  assert.equal(METER_FIRST_MS, 30_000);
  assert.equal(METER_EVERY_MS, 600_000);
  // main.js's timer: the first look at METER_FIRST_MS, each next one after the `wait` it returns.
  // A second sidebar copy, loaded 4 minutes later, shares the store and must not add runs.
  const store = sharedStore();
  const runs = [];
  let clock = 0;
  const exec = async () => { runs.push(clock); return { code: 0 }; };
  const copies = [{ next: METER_FIRST_MS, state: {} }, { next: 240_000 + METER_FIRST_MS, state: {} }];
  const end = 2 * 60 * 60 * 1000;
  for (;;) {
    const c = copies.reduce((a, b) => (b.next < a.next ? b : a));
    if (c.next > end) break;
    clock = c.next;
    const r = await syncMeter({ exec, bin: BIN, now: () => clock, ...store, state: c.state });
    assert.ok(r.wait > 0 && r.wait <= METER_EVERY_MS, `wait ${r.wait}`);
    c.next = clock + r.wait;
  }
  assert.equal(runs[0], METER_FIRST_MS);
  for (let i = 1; i < runs.length; i++) assert.ok(runs[i] - runs[i - 1] >= METER_EVERY_MS, `runs ${runs[i - 1]} and ${runs[i]}`);
  assert.equal(runs.length, Math.floor((end - METER_FIRST_MS) / METER_EVERY_MS) + 1);
  assert.equal(store.get(METER_KEY), runs.at(-1));
});

test("usagemeter sync: never twice at once, in one copy or across copies", async () => {
  const store = sharedStore();
  const { calls, exec } = gatedExec();
  let clock = 1e12;
  const now = () => clock;
  const state = {};
  const first = syncMeter({ exec, bin: BIN, now, ...store, state });
  // The same copy again, and another copy, while the run is going: neither starts one.
  assert.deepEqual(await syncMeter({ exec, bin: BIN, now, ...store, state }), { started: false, why: "busy", wait: METER_EVERY_MS });
  const other = await syncMeter({ exec, bin: BIN, now, ...store, state: {} });
  assert.equal(other.started, false);
  assert.equal(other.why, "fresh");
  // Even past ten minutes, this copy waits for its own run to end.
  clock += METER_EVERY_MS + 1;
  assert.equal((await syncMeter({ exec, bin: BIN, now, ...store, state })).why, "busy");
  assert.equal(calls.length, 1);
  calls[0].resolve({ code: 0, stdout: "", stderr: "" });
  assert.equal((await first).started, true);
  // Its run over and ten minutes gone: the next one starts.
  const second = syncMeter({ exec, bin: BIN, now, ...store, state });
  assert.equal(calls.length, 2);
  calls[1].resolve({ code: 0, stdout: "", stderr: "" });
  assert.equal((await second).started, true);
});

test("usagemeter sync: sh that cannot start, or a failing run, is silent, and tried again later", async () => {
  const store = sharedStore();
  let clock = 1e12;
  // Herdr's exec rejects only when the program (sh) cannot start; a missing usagemeter is SYNC's exit 0.
  const noShell = async () => { throw new Error("No such file or directory"); };
  const r = await syncMeter({ exec: noShell, bin: BIN, now: () => clock, ...store, state: {} });
  assert.deepEqual(r, { started: false, why: "no-shell", wait: METER_EVERY_MS });
  clock += METER_EVERY_MS;
  const failed = await syncMeter({ exec: async () => ({ code: 1 }), bin: BIN, now: () => clock, ...store, state: {} });
  assert.deepEqual(failed, { started: true, code: 1, wait: METER_EVERY_MS });
  // A shared store that throws (or holds junk) does not stop the run.
  const odd = await syncMeter({ exec: async () => ({ code: 0 }), bin: BIN, now: () => clock, get: () => "junk", set: () => { throw new Error("x"); }, state: {} });
  assert.equal(odd.started, true);
});

/** Herdr's exec over a real sh: `{ code, stdout, stderr }`, rejecting only when the program can't start. */
const shExec = (env) => (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { env }, (err, stdout, stderr) => {
  if (err && typeof err.code !== "number") reject(err); else resolve({ code: err ? err.code : 0, stdout, stderr });
}));
const fakeHome = (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "am-meter-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  return home;
};
const exe = (path, text) => { writeFileSync(path, text); chmodSync(path, 0o755); };

test("SYNC runs the binary $1 names (Herdr's absolute path), never the default; a missing one is exit 0, silent", async (t) => {
  const home = fakeHome(t);
  exe(join(home, ".local", "bin", "usagemeter"), `#!/bin/sh\necho "default $*" >> "$HOME/ran"\n`);
  const named = join(home, "elsewhere", "usagemeter");
  mkdirSync(dirname(named));
  exe(named, `#!/bin/sh\necho "named $*" >> "$HOME/ran"\n`);
  const exec = shExec({ HOME: home, PATH: "/usr/bin:/bin" });
  assert.deepEqual(await syncMeter({ exec, bin: named, state: {} }), { started: true, code: 0, wait: METER_EVERY_MS });
  assert.equal(readFileSync(join(home, "ran"), "utf8"), "named sync\n");
  // $1 names a binary that is not there: nothing runs, not even the default, and the exit is 0.
  rmSync(named);
  assert.deepEqual(await syncMeter({ exec, bin: named, state: {} }), { started: true, code: 0, wait: METER_EVERY_MS });
  assert.equal(readFileSync(join(home, "ran"), "utf8"), "named sync\n");
  // No $1 (a linked machine): the default.
  assert.equal(spawnSync("sh", ["-c", SYNC], { env: { HOME: home, PATH: "/usr/bin:/bin" } }).status, 0);
  assert.equal(readFileSync(join(home, "ran"), "utf8"), "named sync\ndefault sync\n");
});

test("the first sync after the upgrade: a lock held, a blocked move or no space is silent, and the next run is due", async (t) => {
  // The meter's own exits during its one-time move to ~/.automagik/meter (meter/usagemeter README):
  // 0 when another sync or an older meter holds a lock, 3 when the move cannot prove a file its own,
  // 4 when there is not twice the store's size free; nothing is changed in any of them.
  const home = fakeHome(t);
  const bin = join(home, ".local", "bin", "usagemeter");
  const exec = shExec({ HOME: home, PATH: "/usr/bin:/bin" });
  const store = sharedStore();
  let clock = 1e12;
  for (const [code, stderr] of [[0, "another sync is running; nothing to do"], [3, "meter: left meter.db in the old folder"], [4, "meter: not enough free space"]]) {
    exe(bin, `#!/bin/sh\necho "${stderr}" >&2\nexit ${code}\n`);
    const r = await syncMeter({ exec, bin, now: () => clock, ...store, state: {} });
    assert.deepEqual(r, { started: true, code, wait: METER_EVERY_MS }, String(code));
    // Within ten minutes nothing starts again; after them the next run does.
    assert.equal((await syncMeter({ exec, bin, now: () => clock + 1000, ...store, state: {} })).why, "fresh");
    clock += METER_EVERY_MS;
  }
});

test("the sidebar wires it: Herdr's exec and home(), 30 s after load, and nothing Herdr loads writes a LaunchAgent", () => {
  const main = readFileSync(join(ROOT, "mods", "am-sidebar", "main.js"), "utf8");
  assert.match(main, /import \{[^}]*\bsyncMeter\b[^}]*\} from "\.\/meter\.js";/);
  assert.match(main, /cx\.timer\.after\(METER_FIRST_MS, \(cx\) => this\.meterTick\(cx\)\)/);
  assert.match(main, /syncMeter\(\{ exec, bin: meterBin\(home\(\)\), get: shared, set: setShared, state: this\.meter, machines, sleep: sleepOf\(cx\), fleet \}\)/);
  assert.match(main, /const machines = syncTargets\(this\.machines, scope, owned\);/);
  // A mod has no setTimeout (Herdr): meter.js times nothing on its own, only with the caller's sleep.
  assert.doesNotMatch(readFileSync(join(ROOT, "mods", "am-sidebar", "meter.js"), "utf8"), /\bset(Timeout|Interval)\b/);
  assert.match(main, /cx\.timer\.after\(wait, \(cx\) => this\.meterTick\(cx\)\)/);
  // meter.js is pure, so node --test and the mod share it: its one import is meterFleet.js (the
  // fleet record, RFC 0026 (e)), which imports nothing.
  assert.deepEqual(readFileSync(join(ROOT, "mods", "am-sidebar", "meter.js"), "utf8").match(/^import .*$/gm).map((l) => l.replace(/^.* from /, "")), ['"./meterFleet.js";']);
  assert.doesNotMatch(readFileSync(join(ROOT, "mods", "am-sidebar", "meterFleet.js"), "utf8"), /^import /m);
  // The pack's mods: Pocket Link (mods/pocket-link, Pocket's, never in the pack) runs its own bridge
  // LaunchAgent, which the pack never writes. Nothing Herdr loads names launchd either; the revive
  // login service (#939) writes its agent from the CLI, in modules main.js never imports.
  for (const dir of readdirSync(join(ROOT, "mods")).filter((d) => d !== "pocket-link")) {
    for (const name of closure(join(ROOT, "mods", dir), ["main.js"])) {
      assert.doesNotMatch(readFileSync(join(ROOT, "mods", dir, name), "utf8"), /Library\/LaunchAgents|launchctl/, `${dir}/${name}`);
    }
  }
});

test("the marker's usagemeter line: written when set, read back, junk ignored, absent by default", () => {
  const base = { version: "1.2.3", mods: ["am-sidebar"], layout: "added" };
  assert.doesNotMatch(formatMarker(base), /usagemeter/);
  const text = formatMarker({ ...base, usagemeter: "0.2.0" });
  assert.match(text, /\nusagemeter=0\.2\.0\n$/);
  assert.equal(parseMarker(text).usagemeter, "0.2.0");
  assert.equal(parseMarker(formatMarker(parseMarker(text))).usagemeter, "0.2.0");
  assert.equal(parseMarker(`${formatMarker(base)}usagemeter=../../x\n`).usagemeter, null);
  assert.equal(parseMarker(formatMarker(base)).usagemeter, null);
});
