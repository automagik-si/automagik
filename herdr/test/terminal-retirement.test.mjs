import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonLines } from "./log-lines.mjs";
import { scratchRoot } from "./scratch-project.mjs";

const cli = new URL("../mods/am-sidebar/bin/automagik-herdr.mjs", import.meta.url).href;
const fake = new URL("./fake-hc.mjs", import.meta.url).pathname;
const live = { address: "t1", state: "live", created_ms: 1 };
const child = {
  address: "t2", state: "live", parent: "t1", created_ms: 2, die_with_parent: true,
};
const finished = (fields) => ({
  ...live, state: "finished", reason: "killed", finished_ms: Date.now() + 60_000, ...fields,
});

function kill(t, state, options = { before: live }, terminal = "t1", expectedCode = 0) {
  const root = scratchRoot(t, "terminal-retirement-");
  const path = join(root, "state.json");
  const log = join(root, "hc.log");
  writeFileSync(path, JSON.stringify({ terminals: [live], ...state }));
  writeFileSync(log, "");
  writeFileSync(join(root, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`,
    { mode: 0o700 });
  const source = `import { hcKill } from ${JSON.stringify(cli)};
    const [terminal, options] = JSON.parse(process.argv[1]);
    const result = await hcKill(terminal, options);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.code;`;
  const { status, signal, stderr } = spawnSync(process.execPath,
    ["--input-type=module", "-e", source, JSON.stringify([terminal, options])], {
      cwd: root, encoding: "utf8", timeout: 10_000,
      env: {
        PATH: `${root}:/usr/bin:/bin`, HOME: root, HERDR_APP_HOME: root,
        HC_FAKE_LOG: log, HC_FAKE_STATE: path,
      },
    });
  assert.equal(status, expectedCode, stderr || signal);
  const calls = readJsonLines(log);
  const removals = calls.filter(([verb]) => verb === "rm").map(([, addr]) => addr);
  const terminals = JSON.parse(readFileSync(path, "utf8")).terminals;
  return { root, calls, removals, terminals, stderr };
}

test("terminal retirement: a short kill reply is completed with hc get", (t) => {
  const short = { address: "t1", state: "finished", reason: null, finished_ms: null };
  const r = kill(t, { killReply: { t1: short } });
  assert.deepEqual(r.removals, ["t1"]);
  assert.deepEqual(r.terminals, []);
  assert.deepEqual(r.calls.map(([verb]) => verb), ["kill", "get", "get", "rm"]);
  assert.equal(r.stderr, "");
});

const seat = { before: live, core: "fixture-core", kind: "seat", reason: "replaced" };
function assertSeatLeftListed(r) {
  assert.deepEqual(r.removals, []);
  assert.equal(r.stderr, "am: t1 was left listed. Run hc rm t1\n");
  const ledger = join(r.root, "automagik-herdr", "workers.jsonl");
  assert.ok(existsSync(ledger), "seat end row was recorded");
  const [row] = readJsonLines(ledger);
  assert.deepEqual({ ...row, at: "" }, {
    event: "end", kind: "seat", terminal: "t1", core: "fixture-core", created_ms: 1,
    reason: "replaced", at: "",
  });
  assert.equal(r.terminals[0].state, "finished");
}

test("terminal retirement: a still-short seat reply preserves the end row and rm line", (t) => {
  const short = { address: "t1", state: "finished" };
  assertSeatLeftListed(kill(t, { killReply: { t1: short }, getReply: { t1: short } }, seat));
});

test("terminal retirement: a short reply cannot use the facts of a reused address", (t) => {
  const r = kill(t, {
    killReply: { t1: { address: "t1" } }, getReply: { t1: { ...live, created_ms: 99 } },
  }, seat);
  assertSeatLeftListed(r);
});

test("terminal retirement: a live kill reply gives the still-running line", (t) => {
  const r = kill(t, { killReply: { t1: live } }, undefined, "t1", 1);
  assert.deepEqual(r.removals, []);
  assert.equal(r.stderr, "t1 is still running.");
});

test("terminal retirement: a kill reply with an older finish time never authorizes rm", (t) => {
  const ended = finished({ finished_ms: 1 });
  const r = kill(t, { killReply: { t1: ended }, getReply: { t1: ended } });
  assert.deepEqual(r.removals, []);
});

test("terminal retirement: a missing finish time never authorizes rm", (t) => {
  const ended = finished({ finished_ms: null });
  // A linked core uses the observed live pane as its pre-kill proof, independent of wall time.
  ended.address = "peer/t1";
  const before = { ...live, address: ended.address };
  const r = kill(t, {
    machines: [{ name: "peer", state: "connected" }],
    terminals: [before],
    killReply: { [ended.address]: ended }, getReply: { [ended.address]: ended },
  }, { before }, ended.address);
  assert.deepEqual(r.removals, []);
  assert.match(r.stderr, /Run hc rm peer\/t1/);
});

test("terminal retirement: a natural exit never authorizes rm", (t) => {
  const r = kill(t, { afterKill: { terminal: "t1", patch: { reason: "exited" } } });
  assert.deepEqual(r.calls.map(([verb]) => verb), ["kill"]);
  assert.deepEqual(r.removals, []);
});

test("terminal retirement: an already-finished pre-kill observation never authorizes rm", (t) => {
  const r = kill(t, {}, { before: finished() });
  assert.deepEqual(r.removals, []);
});

test("terminal retirement: a linked kill without a live observation never authorizes rm", (t) => {
  const address = "peer/t1";
  const r = kill(t, {
    machines: [{ name: "peer", state: "connected" }],
    terminals: [{ ...live, address }], failGet: [address],
  }, {}, address);
  assert.deepEqual(r.calls.map(([verb]) => verb), ["get", "kill"]);
  assert.deepEqual(r.removals, []);
});

for (const [field, replacement] of Object.entries({ address: "t9", created_ms: 99 })) {
  test(`terminal retirement: rm rechecks the ${field} of the ended pane`, (t) => {
    const ended = finished();
    const r = kill(t, {
      killReply: { t1: ended }, getReply: { t1: { ...ended, [field]: replacement } },
    });
    assert.deepEqual(r.removals, []);
  });
}

for (const [field, replacement] of Object.entries({
  state: "live", finished_ms: 1, reason: "exited",
})) {
  test(`terminal retirement: rm rechecks the ${field} of the finish`, (t) => {
    const ended = finished();
    const r = kill(t, {
      killReply: { t1: ended }, getReply: { t1: { ...ended, [field]: replacement } },
    });
    assert.deepEqual(r.removals, []);
  });
}

const childChanges = { parent: "t9", created_ms: 99, finished_ms: 1 };
for (const [field, replacement] of Object.entries(childChanges)) {
  test(`terminal retirement: a child's changed ${field} disqualifies its removal`, (t) => {
    const r = kill(t, {
      terminals: [live, child], afterKill: { terminal: "t2", patch: { [field]: replacement } },
    }, { before: live, children: [child] });
    assert.deepEqual(r.removals, ["t1"]);
    assert.equal(r.terminals[0].address, "t2");
  });
}
