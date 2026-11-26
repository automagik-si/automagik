// The sidebar's bot cards follow the attach ledger by session (#1875): a card is a snapshot
// session (its full address, machine, project and created_ms generation). The ledger names the
// panes it has a row for at that generation; a live labelled pane no ledger row names — an
// empty answer, a bot bound on another machine's ledger, a WSL prefix the ledger kept bare —
// still draws on its Bot's card from its own `bot=` label, and a reused address never carries
// the old card's status or click. Drawn on sidebar-tree.mjs's sidebar under its stubs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { index, nodes } from "./gpui-stub.mjs";
import { load, setSnapshot, sidebar, state } from "./sidebar-tree.mjs";
import { parseBots } from "../mods/am-sidebar/model.js";
import { liveOf } from "../mods/am-sidebar/rows.js";

const Spaces = await load();
const BOT = "b-reviewbotx";
const PROJECT = "/fixture/project";
const context = { notify() {} };
const agent = { key: "claude", name: "Claude Code", agent: true };
const project = (planned = false) => parseBots(JSON.stringify({
  version: 1,
  bots: [{ id: BOT, kind: "main", name: "Fixture Bot", role: "", agent: "claude", ...(planned ? { planned: { wave: 1, note: "" } } : {}) }],
  categories: [],
}));

// A project with one live agent in it: the pane is `address` (bare here, `<machine>/<terminal>`
// on a linked machine or inside WSL), on `machine`, labelled `label` unless null, created at
// `created_ms`. `program` is what Herdr's table says is in front (a shell: no agent yet).
// `ledger` is the whois --all answer the sidebar holds for this render.
function draw({ address = "t12", machine = null, ledger = null, label = BOT, created_ms = 200, planned = false, program = agent } = {}) {
  const terminal = {
    address, state: "live", status: "working", created_ms,
    cwd: PROJECT, labels: label ? { bot: label } : {}, program,
  };
  const snapshot = {
    terminals: [terminal],
    panes: [{ pane: "p1", terminal: address, tab: "tab1", program, cwd: PROJECT }],
    agents: program.agent ? [{ address, pane: "p1", tab: "tab1", space: "space1", program, status: "working" }] : [],
    spaces: [{ id: "space1", folder: PROJECT, name: "Project", machine, tabs: [{ id: "tab1", name: "Project", named: true }] }],
    bots: [{ ...project(planned), key: PROJECT, machine, spaces: ["space1"] }],
  };

  setSnapshot(snapshot);
  const view = sidebar(Spaces, snapshot);
  view.ledger = ledger;
  index(view.render(context));
  const tree = view.trees.find((t) => t.key === PROJECT && t.machine === machine);
  const bot = tree.main;
  const card = nodes.get(`row-b:${BOT}`);
  assert.ok(card, "the Bot's card rendered");

  function click() {
    state.runs = [];
    card.click?.(null, context);
    return state.runs;
  }
  // The menu the card's right-click opens: the attachment its Detach and Start items follow.
  function menu() {
    state.opened = [];
    (card.calls ?? []).find((c) => c[0] === "on_mouse_down" && c[1] === "right")?.[2]();
    return state.opened.at(-1)?.props ?? null;
  }
  return {
    status: bot.status,
    terminal: bot.live?.terminal ?? null,
    // A pane the ledger or its label gave to the bot is not drawn again as a plain agent row.
    plainAgent: nodes.has(`ag-${address}`),
    // The ledger's own answer (no label fallback) and the spaceless project's Start.
    bound: view.bound,
    boundTerminal: liveOf(view.bound, { key: PROJECT, machine }, BOT)?.terminal ?? null,
    startable: view.startable(tree)?.id ?? null,
    click,
    menu,
  };
}

// One complete card, from what it shows to where its click goes.
const card = ({ status, terminal, plainAgent, click }) => ({ status, terminal, plainAgent, action: click() });
const focus = (terminal) => [["agent.focus", { terminal }]];
const running = (terminal) => ({ status: "working", terminal, plainAgent: false, action: focus(terminal) });
const detached = { status: null, terminal: null, plainAgent: true, action: [] };
// The ledger's row for the fixture's pane: whois keeps the bare terminal and the project key.
const row = (created_ms = 200, more = {}) => ({
  bot: BOT, address: "t12", terminal: "t12", project: PROJECT, machine: null, created_ms, state: "live", ...more,
});

test("#1875: no ledger answer draws a labelled pane on its card and focuses it", () => {
  assert.deepEqual(card(draw()), running("t12"));
});

test("#1875: a confirmed same-generation binding names an unlabelled pane and focuses it", () => {
  assert.deepEqual(card(draw({ ledger: [row()], label: null })), running("t12"));
});

test("#1875: an empty ledger answer falls back to the label for a live pane it doesn't name", () => {
  assert.deepEqual(card(draw({ ledger: [] })), running("t12"));
});

test("#1875: a label-only live pane is Focus, not an attachment: Start stays available", () => {
  const drawn = draw({ ledger: [] });
  assert.equal(drawn.terminal, "t12");
  assert.deepEqual(drawn.bound, {}, "the ledger alone names no pane");
  assert.equal(drawn.boundTerminal, null);
  assert.equal(drawn.startable, BOT, "the spaceless project can still Start it");
  assert.deepEqual(drawn.click(), focus("t12"), "the card's click still focuses the current pane");
});

test("#1875: a confirmed binding is the ledger's own answer for Start and Detach", () => {
  const drawn = draw({ ledger: [row()], label: null });
  assert.equal(drawn.boundTerminal, "t12");
  assert.equal(drawn.startable, null, "a confirmed pane means the project is already attached");
});

// The pane a Start hands to the agent: live, but Herdr's table still says a shell (no agent in
// front yet). The ledger's binding is the attachment, as on the card, whose menu offers Detach
// (#1875): the spaceless project must not draw Start beside that card.
const shell = { key: "shell", agent: false };

test("#1875: a confirmed binding on a held pane is attached: no Start, the card still holds it", () => {
  const drawn = draw({ ledger: [row()], label: null, program: shell });
  assert.equal(drawn.terminal, null, "held: no agent in front, so the card is not live");
  assert.equal(drawn.boundTerminal, null, "the live map never counts a held pane");
  assert.equal(drawn.startable, null, "the ledger attaches it: no Start for the spaceless project");
  assert.equal(drawn.plainAgent, false, "the ledger's pane is not drawn again as a plain agent");
  assert.deepEqual(drawn.click(), focus("t12"), "the card's click still goes to its held pane");
  const m = drawn.menu();
  assert.equal(m.live, "t12", "the card's menu treats the held pane as the attachment (Detach)");
  assert.equal(m.focus, "t12", "Focus goes to the same pane");
});

test("#1875: a labelled planned bot keeps its pane as a plain agent row", () => {
  // A planned node never draws a pane (buildTree), so its label must not take the agent row.
  const drawn = draw({ ledger: [], planned: true });
  assert.equal(drawn.status, null);
  assert.equal(drawn.terminal, null);
  assert.equal(drawn.plainAgent, true);
});

test("#1875: a linked machine's labelled pane missing from this ledger still draws and focuses", () => {
  assert.deepEqual(card(draw({ ledger: [], address: "lab/t12", machine: "lab" })), running("lab/t12"));
});

test("#1875: a WSL prefix binding meets the snapshot's wsl/t12 pane at its generation", () => {
  // No label: only the ledger's bare `t12` resolved to the snapshot's `wsl/t12` can name it.
  assert.deepEqual(card(draw({ ledger: [row()], address: "wsl/t12", machine: "wsl", label: null })), running("wsl/t12"));
});

test("#1875: an address reused before render does not join the old binding", () => {
  assert.deepEqual(card(draw({ ledger: [row(100)], label: null })), detached);
});

test("#1875: an address reused between render and click does not focus the replacement", () => {
  const drawn = draw({ ledger: [row()], label: null });
  assert.equal(drawn.terminal, "t12", "the card was drawn for the first session");
  state.terminals = [{ ...state.terminals[0], created_ms: 300, labels: {} }];
  assert.deepEqual(drawn.click(), [], "the old card's click is unavailable: the address is another session");
});
