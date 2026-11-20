// The sidebar's rows and clicks follow the attach ledger (#223): a pane relabelled with another
// bot is drawn as the bot the ledger binds it to, and the row's click focuses that pane, not
// the one its bot= label names. Drawn on sidebar-tree.mjs's synthetic case under its stubs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cases, load, sidebar, setSnapshot } from "./sidebar-tree.mjs";

const Spaces = await load();
const snap = cases()[2][1];
const MAIN = "b-bot0aaaa";
const MEMBER = "b-bot0bbbb";
const labelled = (id) => snap.terminals.find((t) => t.state === "live" && t.labels?.bot === id).address;
const MAIN_PANE = labelled(MAIN);
const MEMBER_PANE = labelled(MEMBER);
// An agent's pane in the same project, with no bot= label: only the ledger can name its bot.
const UNLABELLED_PANE = "t6";
const bindings = [
  { bot: MAIN, terminal: UNLABELLED_PANE, address: UNLABELLED_PANE, project: "/work/s0", machine: null, state: "live" },
  { bot: MEMBER, terminal: MAIN_PANE, address: MAIN_PANE, project: "/work/s0", machine: null, state: "live" },
];

// The tree's bot node by id, wherever it nests.
function nodeOf(tree, id) {
  let found = null;
  const walk = (n) => { if (!n || found) return; if (n.bot.id === id) found = n; for (const m of n.members ?? []) walk(m); };
  walk(tree.main);
  for (const c of tree.categories) for (const n of c.bots) walk(n);
  for (const n of tree.uncategorised) walk(n);
  return found;
}

test("sidebar: the ledger's binding decides the row's bot and the pane its click focuses (#223)", () => {
  setSnapshot(snap);
  const s = sidebar(Spaces, snap);
  s.ledger = bindings;
  s.render({ notify() {} });
  assert.equal(s.botOf.get(MAIN_PANE), MEMBER, "the relabelled pane is drawn as the member");
  assert.equal(s.botOf.get(UNLABELLED_PANE), MAIN, "an unlabelled pane is drawn as its ledger bot");
  const tree = s.trees.find((t) => t.key === "/work/s0");
  assert.equal(nodeOf(tree, MAIN).live?.terminal, UNLABELLED_PANE, "the main bot's pane is the ledger's");
  assert.equal(nodeOf(tree, MEMBER).live?.terminal, MAIN_PANE, "the member's pane is the ledger's");
});

test("sidebar: with no ledger answer the labels still draw the rows", () => {
  setSnapshot(snap);
  const s = sidebar(Spaces, snap);
  s.render({ notify() {} });
  assert.equal(s.botOf.get(MAIN_PANE), MAIN);
  assert.equal(s.botOf.get(UNLABELLED_PANE), undefined);
  assert.equal(nodeOf(s.trees.find((t) => t.key === "/work/s0"), MAIN).live?.terminal, MAIN_PANE);
});
