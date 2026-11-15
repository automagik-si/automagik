// The whole sidebar tree (sidebar-tree.mjs: every case, expanded and collapsed, two renders
// each) drawn by the pack's main.js, against the golden recorded from main.js as it was before
// it joined its lists by maps (#409) and read each snapshot key once per render: same rows,
// same agent order, and the same sha256 of every element's props and builder calls. Recorded
// from 21dba9ec^ (ebe68f59) with
//   git archive ebe68f59 herdr/mods | tar -x -C <dir>
//   node test/sidebar-tree.mjs <dir>/herdr/mods/am-sidebar/main.js
// and equal for 21dba9ec (#409). A difference: write both with --full and diff them.
// Re-recorded for #231's parent mark: the owner fixture's two cases add one parent-<bot> node
// on each of three bots (hc parent t1m, lead's pane t201); with those nodes left out, every
// case's --full tree equals dev's before #231, and the other cases' sha256 are unchanged.
// Re-recorded for the machine header's Move to top: every header but the first gains a hidden
// machine-top-<machine> node and every header an on_hover call; with those left out, every
// case's --full tree equals dev's at 0524c6e1 (no saved order draws the machines as before).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GOLDEN, load, trees, digest, cases } from "./sidebar-tree.mjs";

const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));

test("sidebar render: every case draws the tree it drew before the lookup maps and single reads", async () => {
  const got = digest(trees(await load()));
  assert.deepEqual(Object.keys(got), Object.keys(golden));
  for (const name of Object.keys(golden)) {
    assert.deepEqual(got[name].ids, golden[name].ids, `${name}: rows`);
    assert.deepEqual(got[name].order, golden[name].order, `${name}: agent order`);
    assert.equal(got[name].sha256, golden[name].sha256, `${name}: same rows, another tree (props or builder calls); diff with --full`);
  }
});

test("sidebar render cases: aliases, a renamed machine, sibling sub-agents, helpers, bots, loading", () => {
  const ids = Object.values(golden).flatMap((c) => c.ids);
  // host-b/t2 and host-b/t4 have one core terminal each under another machine's name; host-b/t3 two.
  assert.ok(ids.includes("ag-host-b/t2") && ids.includes("ag-host-b/t4") && !ids.includes("ag-host-b/t3"));
  const [, snap] = cases().find(([name]) => name.startsWith("synthetic n=4"));
  const live = snap.terminals.filter((k) => k.state === "live" && k.parent);
  const siblings = new Map();
  for (const k of live) siblings.set(k.parent, (siblings.get(k.parent) ?? 0) + 1);
  assert.ok([...siblings.values()].some((n) => n >= 2), "a parent with two live sub-agents");
  assert.ok(ids.some((id) => id.startsWith("sub-")) && ids.some((id) => id.startsWith("row-h:")) && ids.some((id) => id.startsWith("row-b:")));
  assert.ok(ids.some((id) => id.startsWith("unknown-")), "a Hermes extra");
  assert.ok(ids.includes("machine-loading-boot") && ids.includes("machine-new-away"));
  assert.equal(new Set(Object.values(golden).map((c) => c.sha256)).size, Object.keys(golden).length, "each case draws its own tree");
});

test("sidebar row Start logs unexpected failures and shows an actionable sentence", async (t) => {
  const { state } = await import("./sidebar-tree.mjs");
  const Sidebar = await load();
  const sidebar = Object.create(Sidebar.prototype);
  sidebar.botCommand = async () => { throw new Error("launch failed\n    at launchRun (models.js:508:3)"); };
  const logs = [];
  t.mock.method(console, "error", (line) => logs.push(line));
  state.notes = [];
  const pending = [];
  sidebar.startFromRow("b-aaaaaaaaaa", { spawn: (fn) => pending.push(fn({})) });
  await Promise.all(pending);
  assert.equal(state.notes.length, 1);
  assert.equal(state.notes[0].body, "launch failed; check the log and try again.");
  assert.ok(logs.some((line) => line.includes("at launchRun")));
});
