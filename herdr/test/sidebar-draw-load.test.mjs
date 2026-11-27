import assert from "node:assert/strict";
import { test } from "node:test";
import { index, nodes } from "./gpui-stub.mjs";
import { load, setSnapshot, sidebar, state } from "./sidebar-tree.mjs";
import { parseBots } from "../mods/am-sidebar/model.js";
import { projectId } from "../mods/am-sidebar/rows.js";

const agent = { key: "claude", name: "Claude Code", agent: true };
const shell = { key: "sh", shell: true };
const machines = [null, "orchard", "meadow"];

function fixture() {
  const terminals = [], panes = [], agents = [], spaces = [], bots = [], ledger = [];
  let botNumber = 0;
  for (let p = 0; p < 8; p += 1) {
    const machine = machines[Math.floor(p / 3)];
    const key = `/fixture/project-${p}`;
    const space = [2, 5, 7].includes(p) ? null
      : { id: `space-${p}`, name: `Project ${p}`, folder: key, machine, tabs: [] };
    if (space) spaces.push(space);
    const definitions = Array.from({ length: p < 4 ? 8 : 7 }, (_, i) => {
      const n = botNumber++;
      const id = `b-fixture${n}`, bare = `t${n}`;
      const address = machine ? `${machine}/${bare}` : bare;
      const program = space && i % 2 === 0 ? agent : shell;
      const created_ms = 1000 + n;
      // Some panes hold a bot before its agent shows, some only carry a label, and some
      // bots are stopped. Linked bare ledger addresses still have to resolve by generation.
      if (i < 6) {
        terminals.push({ address, cwd: key, labels: { bot: id }, state: "live", status: "working", created_ms, program });
        if (space) {
          const tab = `tab-${n}`, pane = `pane-${n}`;
          space.tabs.push({ id: tab, named: true, name: `Bot ${n}` });
          panes.push({ pane, tab, terminal: address, cwd: key, program });
          if (program.agent) agents.push({ address, pane, tab, space: space.id, program, status: "working" });
        }
      }
      if (i < 5) ledger.push({ bot: id, address: bare, project: key, created_ms, state: "live" });
      return { id, name: `Bot ${n}`, kind: i === 0 ? "main" : "member", role: "", agent: "claude" };
    });
    bots.push({ key, machine, spaces: space ? [space.id] : [], ...parseBots(JSON.stringify({ version: 1, bots: definitions, categories: [] })) });
  }
  for (const [i, count] of [45, 510, 45].entries()) {
    const machine = machines[i];
    const prefix = machine ? `${machine}/` : "";
    const padding = count - terminals.filter(({ address }) => machine ? address.startsWith(prefix) : !address.includes("/")).length;
    for (let n = 0; n < padding; n += 1) terminals.push({ address: `${prefix}old-${n}`, state: "exited", labels: {} });
  }
  const hcMachines = machines.slice(1).map((name) => ({ name, state: "connected" }));
  return { terminals, panes, agents, spaces, bots, ledger, hcMachines, machines: hcMachines.map(({ name }) => ({ name, layout: "ready" })) };
}

test("a full sidebar draw does bounded work on terminal history across projects", async (t) => {
  const snap = fixture();
  assert.equal(snap.terminals.length, 600);
  assert.equal(snap.ledger.length, 40);
  const view = sidebar(await load(), snap);
  setSnapshot(snap);
  view.ledger = snap.ledger;
  let reads = 0;
  const history = state.terminals.filter((row) => row.state === "exited");
  for (const row of history) {
    for (const key of ["address", "labels", "parent"]) {
      const value = row[key];
      Object.defineProperty(row, key, { get() { reads += 1; return value; } });
    }
  }
  index(view.render({ notify() {} }));
  const cards = snap.bots.flatMap((p) => p.file.bots.map((b) => `row-b:${b.id}`));
  assert.equal(cards.length, 60);
  for (const id of cards) assert.ok(nodes.has(id), `${id} rendered`);
  const spaceless = snap.bots.filter((p) => !p.spaces.length);
  assert.equal(spaceless.length, 3);
  for (const project of spaceless) assert.ok(nodes.has(`project-${projectId(project)}`));
  t.diagnostic(`${reads} property reads across ${history.length} exited terminals`);
  // These are unrelated terminals. Each render pass can inspect them, but cards,
  // project headers and helpers must resolve through the snapshot's lookups.
  assert.ok(reads <= 16 * history.length, `terminal history was read ${reads} times (${reads / history.length} per row)`);
});
