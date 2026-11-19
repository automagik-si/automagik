import { test } from "node:test";
import assert from "node:assert/strict";
import { load, setSnapshot, sidebar } from "./sidebar-tree.mjs";
import { parseBots } from "../mods/am-sidebar/model.js";
import { index, nodes, textOf } from "./gpui-stub.mjs";

const Spaces = await load();
const LABEL = "automagik-herdr.needs-owner";
const bot = "b-adaaaaaaaa";
const program = { key: "claude", name: "Claude Code", agent: true };

// A terminal that reports a status; `labels` carries the marker the agent set with hc label.
function terminal(address, status, extra = {}) {
  return { address, state: "live", status, report: { state: status }, labels: {}, program, ...extra };
}

// One space with: a plain agent (t1) waiting on a question and its sub-agent (t3) too, a plain
// agent that is not (t2), a bot (t4) waiting and its helper (t5) too, a blocked pane (t6) whose
// label must not win over the permission chip, a working pane (t7) whose label has cleared, and
// a pane with a blank label (t8).
function scene() {
  const labels = (pairs) => ({ [LABEL]: pairs });
  return {
    spaces: [{ id: "s1", name: "x", folder: "/work/x", machine: null, active: true,
      tabs: [{ id: "tab1", name: "x", named: true }] }],
    panes: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ pane: `p${n}`, terminal: `t${n}`, tab: "tab1", cwd: "/work/x", program })),
    agents: [1, 2, 6, 7, 8].map((n) => ({ address: `t${n}`, pane: `p${n}`, tab: "tab1",
      status: n === 6 ? "blocked" : n === 7 ? "working" : "done",
      program, title: "x", space: "s1", space_name: "x", seq: n })),
    terminals: [
      terminal("t1", "done", { labels: labels("ship it?") }),
      terminal("t2", "done"),
      terminal("t3", "done", { parent: "t1", labels: labels("which database?") }),
      terminal("t4", "done", { labels: { bot, [LABEL]: "approve the plan?" } }),
      terminal("t5", "done", { parent: "t4", labels: labels("and the name?") }),
      terminal("t6", "blocked", { labels: labels("stale?") }),
      terminal("t7", "working", { labels: labels("not yet") }),
      terminal("t8", "done", { labels: labels("   ") }),
    ],
    machines: [],
    bots: [{ key: "/work/x", machine: null, spaces: ["s1"], ...parseBots(JSON.stringify({
      version: 1, categories: [], bots: [{ id: bot, kind: "main", name: "ada", role: "",
        instructions: "", agent: "claude", look: { character: "octopus", colour: "deepseek" } }],
    })) }],
    open: [[`b:${bot}`, true]],
  };
}

// Every tooltip under one indexed node, depth first (textOf's walk, for a node rather than a proxy).
const tooltips = (node) => {
  const out = [];
  const walk = (n) => {
    if (n?.props?.tooltip) out.push(n.props.tooltip);
    for (const k of n?.kids ?? []) if (k?.__node) walk(k.__node);
  };
  walk(node);
  return out.join(" | ");
};
function draw(snap) {
  setSnapshot(snap);
  const s = sidebar(Spaces, snap);
  index(s.render({ notify() {} }));
  return s;
}

test("a stopped pane's needs-owner label draws a Question chip on agent, sub-agent, bot and helper rows", () => {
  draw(scene());
  for (const [id, text] of [["ag-t1", "ship it?"], ["sub-t3", "which database?"], [`row-b:${bot}`, "approve the plan?"], ["row-h:t5", "and the name?"]]) {
    assert.ok(nodes.has(id), id);
    assert.match(textOf(nodes.get(id)), /Question/, id);
    assert.match(tooltips(nodes.get(id)), new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), id);
  }
  // Not a waiting pane: no label at all, or a blank one.
  for (const id of ["ag-t2", "ag-t8"]) {
    assert.doesNotMatch(textOf(nodes.get(id)), /Question/, id);
  }
  // A blocked pane's permission chip keeps its own words, and a working pane's label has cleared.
  assert.match(textOf(nodes.get("ag-t6")), /Needs you/);
  assert.doesNotMatch(textOf(nodes.get("ag-t6")), /Question/);
  assert.doesNotMatch(textOf(nodes.get("ag-t7")), /Question/);
  // The space speaks up too: a dot by its name, its tooltip naming the first question.
  assert.ok(nodes.has("owner-s1"));
  assert.match(tooltips(nodes.get("owner-s1")), /ship it\?/);
});

test("a space's dot and every Question chip clear once the panes work again, the labels still set", () => {
  const snap = scene();
  draw(snap);
  for (const t of snap.terminals) t.status = "working";
  for (const a of snap.agents) a.status = "working";
  draw(snap);
  for (const id of ["ag-t1", `row-b:${bot}`, "row-h:t5", "sub-t3"]) {
    assert.doesNotMatch(textOf(nodes.get(id)), /Question/, id);
  }
  assert.equal(nodes.has("owner-s1"), false);
});

test("removing the label clears the chip and the space's dot", () => {
  const snap = scene();
  draw(snap);
  for (const t of snap.terminals) delete t.labels[LABEL];
  draw(snap);
  assert.doesNotMatch(textOf(nodes.get("ag-t1")), /Question/);
  assert.doesNotMatch(textOf(nodes.get(`row-b:${bot}`)), /Question/);
  assert.equal(nodes.has("owner-s1"), false);
});

test("the narrow rail marks a waiting space's glyph in the waiting colour, not the space's own status", () => {
  const snap = scene();
  setSnapshot(snap, true);
  const s = sidebar(Spaces, snap);
  index(s.render({ notify() {} }));
  assert.ok(nodes.has("space-s1"));
  assert.match(textOf(nodes.get("space-s1")), /●/);
  for (const t of snap.terminals) t.status = "working";
  for (const a of snap.agents) a.status = "working";
  setSnapshot(snap, true);
  index(sidebar(Spaces, snap).render({ notify() {} }));
  assert.match(textOf(nodes.get("space-s1")), /·/);
});
