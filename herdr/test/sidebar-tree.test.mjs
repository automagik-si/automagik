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
import { GOLDEN, load, trees, digest, cases, setSnapshot, sidebar, state } from "./sidebar-tree.mjs";
import { all, textOf } from "./gpui-stub.mjs";

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

// #524: the accepted update's advisories (updater onAdvisories -> shared value) as one wrapping,
// dismissible row at the top of the space list; no row without valid notes or when collapsed.
test("#524 sidebar advisory row: full notes once, wrapping, dismissed for good, absent without notes", async () => {
  const KEY = "am.sidebar.update-advisories";
  const ADVISORY = "removing layouts/automagik.json without knowing the layout Herdr shows (herdr-app did not answer), so it may be the one shown: its blocks name am-tabs, which leaves mods/ too. If Herdr shows it, Herdr drops it (plain Herdr instead): switch layouts (ctrl-shift-l), or `am install herdr.pack` puts the pack back";
  const notes = [ADVISORY, "the failed pack could not be removed: it is in /x/.prev-next-1"];
  const Spaces = await load();
  const [, snap] = cases().find(([name]) => name.startsWith("synthetic n=1"));
  const draw = (value, collapsed = false) => {
    setSnapshot(snap, collapsed);
    if (value !== undefined) state.shared.set(KEY, value);
    const s = sidebar(Spaces, snap);
    const tree = s.render({ notify() {} });
    return { tree, nodes: all(tree), row: all(tree).find((n) => n.id === "update-advisories") };
  };
  const { tree, nodes, row } = draw(notes);
  assert.ok(row, "the row is drawn");
  const list = nodes.find((n) => n.id === "space-list");
  assert.equal(list.kids[0]?.__node, row, "first in the scrolling space list (no new panel)");
  const texts = row.kids.map((k) => k.__node).filter((n) => n.kind !== "button");
  assert.deepEqual(texts.map((n) => textOf(n)), notes, "each note as received, in order");
  for (const note of notes) assert.equal(textOf(tree).split(note).length - 1, 1, "each note once in the sidebar");
  const clipping = ["truncate", "text_ellipsis", "line_clamp", "overflow_hidden", "whitespace_nowrap", "max_h", "h"];
  for (const n of [row, ...texts]) assert.deepEqual(n.calls.filter(([p]) => clipping.includes(p)), [], "no clamp, ellipsis or fixed height");
  for (const n of texts) assert.ok(n.calls.some(([p]) => p === "whitespace_normal"), "each note wraps");
  assert.deepEqual(state.shared.get(KEY), notes, "drawing leaves the presentation value as accepted");
  const dismiss = row.kids.map((k) => k.__node).find((n) => n.kind === "button");
  assert.equal(dismiss?.id, "dismiss-update-advisories");
  assert.ok(dismiss.calls.some(([p, label]) => p === "accessibility_label" && label === "Dismiss update advisories"));
  dismiss.click();
  assert.equal(state.shared.get(KEY), null, "dismiss clears the presentation value");
  const s = sidebar(Spaces, snap);
  assert.equal(all(s.render({ notify() {} })).find((n) => n.id === "update-advisories"), undefined, "gone after an ordinary redraw");
  assert.equal(all(s.render({ notify() {} })).find((n) => n.id === "update-advisories"), undefined, "and stays gone");
  assert.equal(draw(notes, true).row, undefined, "collapsed: no row");
  for (const bad of [undefined, null, [], [""], ["ok", ""], [1], "text"]) assert.equal(draw(bad).row, undefined, `no row for ${JSON.stringify(bad)}`);
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
