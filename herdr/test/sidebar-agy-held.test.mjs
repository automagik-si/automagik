import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load, sidebar, setSnapshot, state } from "./sidebar-tree.mjs";
import { index, nodes, textOf } from "./gpui-stub.mjs";
import { parseBots } from "../mods/am-sidebar/model.js";
import { AGY_SCAN_MS, AGY_READ_MS, machineOf } from "../mods/am-sidebar/agyScan.js";
import { SYNTHETIC, TRUST, trustScreen, fileQuestion, fileScreen } from "./agy-prompt-fixture.mjs";

const Spaces = await load();
const NOW = 1_800_000_000_000;
const APP = "synthetic-agy";
const BOT = "b-adaaaaaaaa";
const LABEL = "automagik-herdr.needs-owner";
const program = { key: "antigravity", name: "Antigravity", agent: true };
const front = (...argv) => ({ argv });
const term = (address, fields = {}) => ({
  address, state: "live", created_ms: 1, labels: {}, foreground: front("agy"), program, ...fields,
});
const space = (id = "s1", machine = null) => ({
  id, machine, folder: "/work/" + id, name: "Space " + id, active: id === "s1", status: "working",
  tabs: [{ id: "tab-" + id, name: "Tab " + id, named: true }],
});
const pane = (address, w) => ({
  pane: "p-" + address, terminal: address, tab: w.tabs[0].id, cwd: w.folder, title: "Pane " + address, program,
});
const agent = (p, w, status = "working") => ({
  address: p.terminal, pane: p.pane, tab: p.tab, title: p.title, space: w.id, space_name: w.name, program, status, seq: 0,
});
const scene = (terminal = term("t1"), { listed = false, display = terminal.address } = {}) => {
  const w = space(), p = pane(display, w);
  return { spaces: [w], panes: [p], terminals: [terminal], agents: listed ? [agent(p, w, terminal.status)] : [] };
};
const project = (spaces = ["s1"]) => ({
  key: "/work/s1", machine: null, spaces, ...parseBots(JSON.stringify({
    version: 1, categories: [], bots: [{ id: BOT, kind: "main", name: "Synthetic bot", role: "",
      instructions: "", agent: "antigravity", look: { character: "octopus", colour: "deepseek" } }],
  })),
});
const answer = (stdout = trustScreen) => ({ code: 0, stdout });
const safe = "SYNTHETIC regular output\n> ";
const addresses = () => state.hcCalls.map((args) => args[1]);
const text = (id) => textOf(nodes.get(id));
const needs = (address) => nodes.get("needs-" + address);
const assertHold = (address, question = TRUST) => {
  assert.equal(needs(address)?.props.tooltip, question, address);
  assert.match(textOf(needs(address)), /Needs you/);
};
const treeNodes = (node) => node ? [node, ...node.kids.flatMap((k) => treeNodes(k?.__node))] : [];
const spinner = (id) => treeNodes(nodes.get(id)).some((n) => n.arg === "mods/workspace-chrome/spinner.svg");
const click = (id) => nodes.get(id).click();
const blockedColor = "#123456";
const assertRail = (s, id = "s1", status = "blocked") => {
  const rendered = s.compact({ w: state.spaces.find((w) => w.id === id), i: 0 },
    { blocked: blockedColor, working: "working", ansi3: "owner" }).__node;
  const mark = rendered.kids.at(-1).__node;
  assert.equal(textOf(mark), status === "working" ? "·" : "●");
  assert.equal(mark.props.color, { blocked: blockedColor, working: "working", owner: "owner" }[status]);
};

const flush = () => new Promise(setImmediate);
function manualClock() {
  let now = 0, notifications = 0;
  const due = [], interval = [], tasks = [];
  const cx = {
    timer: {
      after(ms, fn) { due.push({ at: now + ms, fn }); },
      every(ms, fn) { interval.push({ ms, fn }); },
    },
    spawn(fn) { tasks.push(fn(cx)); },
    notify() { notifications += 1; },
  };
  async function advance(ms) {
    const until = now + ms;
    for (;;) {
      due.sort((a, b) => a.at - b.at);
      if (!due.length || due[0].at > until) break;
      const { at, fn } = due.shift();
      now = at;
      fn(cx);
      await flush();
    }
    now = until;
    await flush();
  }
  return { cx, interval, tasks, advance, notifications: () => notifications };
}

function setup(snap = scene(), shapes = SYNTHETIC) {
  setSnapshot(snap);
  state.hcCalls = [];
  state.hcAnswer = () => answer();
  state.runs = [];
  state.opened = [];
  state.reads = {};
  const s = sidebar(Spaces, snap);
  if (shapes !== null) s.agyShapes = shapes;
  const clock = manualClock();
  const { cx } = clock;
  s.startAgy(cx);
  const draw = (collapsed = false) => {
    if (collapsed) state.shared.set("am.sidebar.collapsed", true);
    else state.shared.delete("am.sidebar.collapsed");
    const real = Date.now;
    Date.now = () => NOW;
    try { return index(s.render(cx)); } finally { Date.now = real; }
  };
  const tick = async () => {
    clock.interval[0].fn(cx);
    await flush();
  };
  const step = async () => {
    draw();
    await tick();
    draw();
  };
  return { s, ...clock, draw, tick, step };
}

test("init registers the Antigravity scan on its own 2.5 s timer", () => {
  const main = readFileSync(new URL("../mods/am-sidebar/main.js", import.meta.url), "utf8");
  assert.match(main, /this\.scanHermes\(cx\)\);[\s\S]*?this\.startAgy\(cx\);/);
  const h = setup();
  assert.deepEqual(h.interval.map(({ ms }) => ms), [2500]);
  assert.equal(AGY_SCAN_MS, 2500);
});

test("unarmed, the timer makes no snapshot read and adds no row or Needs you chip", async () => {
  const h = setup(scene(), null);
  h.draw();
  const reads = { ...state.reads };
  await h.tick();
  assert.deepEqual(state.reads, reads);
  assert.deepEqual(state.hcCalls, []);
  assert.equal(nodes.has("ag-t1"), false);
  assert.ok(![...nodes.keys()].some((id) => id.startsWith("needs-")));
});

test("armed with a shape that never matches, the extra row is read and nothing is held", async () => {
  const h = setup(scene(), [{ ...SYNTHETIC[0], question: /^SYNTHETIC impossible$/ }]);
  await h.step();
  await h.step();
  assert.ok(nodes.has("ag-t1"));
  assert.equal(needs("t1"), undefined);
  assert.deepEqual(addresses(), ["t1", "t1"]);
});

test("startup with no report shows an extra row, then Needs you on the second matching read", async () => {
  const h = setup();
  h.draw();
  assert.equal(nodes.get("unknown-t1")?.props.tooltip, "No status reported");
  await h.step();
  assert.equal(needs("t1"), undefined);
  assert.ok(nodes.has("unknown-t1"));
  assert.equal(h.notifications(), 0);
  await h.step();
  assertHold("t1");
  assert.equal(h.notifications(), 1);
  await h.step();
  assert.equal(h.notifications(), 1);
});

test("a report-only Antigravity terminal is read and held", async () => {
  const h = setup(scene(term("t1", { foreground: undefined, report: { app: APP } })));
  h.s.agyApps = [APP];
  await h.step();
  await h.step();
  assertHold("t1");
  assert.deepEqual(addresses(), ["t1", "t1"]);
});

for (const [status, screen, question] of [
  ["idle", fileScreen(), fileQuestion()], ["done", fileScreen(), fileQuestion()],
  ["working", fileScreen(), fileQuestion()], ["working", trustScreen, TRUST],
]) {
  test(status + " with " + question + " draws Needs you", async () => {
    const h = setup(scene(term("t1", { status }), { listed: true }));
    state.hcAnswer = () => answer(screen);
    await h.step();
    assert.equal(spinner("ag-t1"), status === "working");
    assert.equal(needs("t1"), undefined);
    await h.step();
    assertHold("t1", question);
    assert.equal(spinner("ag-t1"), false);
  });
}

test("changing output above a quoted prompt is not held", async () => {
  const h = setup();
  let n = 0;
  state.hcAnswer = () => answer("SYNTHETIC line " + ++n + "\n" + trustScreen);
  await h.step();
  await h.step();
  assert.equal(needs("t1"), undefined);
});

test("trust then file-access is not held", async () => {
  const h = setup();
  await h.step();
  state.hcAnswer = () => answer(fileScreen());
  await h.step();
  assert.equal(needs("t1"), undefined);
  await h.step();
  assertHold("t1", fileQuestion());
});

test("an answer between reads clears the first sample and a later answer clears the hold", async () => {
  const h = setup();
  await h.step();
  state.hcAnswer = () => answer(trustScreen + "\n> ");
  await h.step();
  assert.equal(h.s.agyObs.get("t1").match, null);
  state.hcAnswer = () => answer();
  await h.step();
  assert.equal(needs("t1"), undefined);
  await h.step();
  assertHold("t1");
  state.hcAnswer = () => answer(safe);
  await h.step();
  assert.equal(needs("t1"), undefined);
});

test("a frozen full quotation is held, the documented residual case", async () => {
  const h = setup();
  state.hcAnswer = () => answer("SYNTHETIC quotation:\n" + trustScreen);
  await h.step();
  await h.step();
  assertHold("t1");
});

test("a finished or headless terminal without a parent row is never read", async () => {
  const snap = scene(term("t1", { state: "exited" }), { listed: true });
  snap.terminals.push(term("t2"));
  const h = setup(snap);
  await h.step();
  assert.deepEqual(state.hcCalls, []);
});

test("two failed reads in a row clear it, including a deadline after a rejection", async () => {
  const h = setup();
  await h.step();
  await h.step();
  state.hcAnswer = () => ({ code: 1, stdout: trustScreen });
  await h.step();
  assertHold("t1");
  state.hcAnswer = () => answer();
  await h.step();
  assertHold("t1");
  state.hcAnswer = () => { throw new Error("synthetic rejection"); };
  await h.step();
  assertHold("t1");
  state.hcAnswer = () => new Promise(() => {});
  await h.step();
  await h.advance(AGY_READ_MS - 1);
  h.draw();
  assertHold("t1");
  await h.advance(1);
  h.draw();
  assert.equal(needs("t1"), undefined);
  assert.equal(h.s.agyGate(null).stuck, 1);
});

function rowShape(id) {
  const walk = (node) => ({
    id: node.id, kind: node.kind, arg: node.arg, props: node.props, calls: node.calls.map(([name, ...args]) => [
      name, ...args.map((arg) => typeof arg === "function" ? "handler" : arg),
    ]),
    kids: node.kids.map((k) => k?.__node ? walk(k.__node) : k),
  });
  return walk(nodes.get(id));
}

test("native blocked and error keep the existing agent, sub-agent and bot marks and cost no read", async () => {
  for (const status of ["blocked", "error"]) {
    const snap = scene(term("t1", { status, report: { state: status, kind: "permission" } }), { listed: true });
    snap.terminals.push(term("t2", { status, parent: "t1" }), term("t3", { status, labels: { bot: BOT } }), term("t4", { status }));
    snap.panes.push(pane("t4", snap.spaces[0]));
    snap.bots = [project()];
    const ids = ["ag-t1", "sub-t2", "row-b:" + BOT];
    const unarmed = setup(snap, null);
    unarmed.draw();
    const before = ids.map(rowShape);
    const h = setup(snap);
    await h.step();
    assert.deepEqual(ids.map(rowShape), before);
    assert.deepEqual(state.hcCalls, []);
    assert.ok(nodes.has("ag-t4"));
    assert.equal(/Needs you/.test(text("ag-t4")), status === "blocked");
    assert.equal(needs("t4"), undefined);
  }
});

test("a foreground change between render and tick makes no read", async () => {
  const h = setup();
  h.draw();
  state.terminals[0].foreground = front("sh");
  await h.tick();
  assert.deepEqual(state.hcCalls, []);
});

test("held, then a shell, then agy at the same lifetime needs two fresh reads", async () => {
  const h = setup(scene(term("t1", { status: "working" }), { listed: true }));
  await h.step();
  await h.step();
  assertHold("t1");
  state.terminals[0].foreground = front("sh");
  await h.tick();
  assert.deepEqual(addresses(), ["t1", "t1"]);
  assert.equal(h.s.agyObs.has("t1"), false);
  h.draw();
  assert.equal(needs("t1"), undefined);
  state.terminals[0].foreground = front("agy");
  await h.step();
  assert.equal(needs("t1"), undefined);
  await h.step();
  assertHold("t1");
});

test("a read completing after its terminal was cleared is dropped", async () => {
  const h = setup();
  await h.step();
  await h.step();
  assertHold("t1");
  const waiting = Promise.withResolvers();
  state.hcAnswer = () => waiting.promise;
  await h.tick();
  state.terminals[0].status = "blocked";
  h.draw();
  assert.equal(needs("t1"), undefined);
  state.terminals[0].status = "working";
  h.draw();
  waiting.resolve(answer());
  await Promise.all(h.tasks);
  assert.equal(h.s.agyObs.has("t1"), false);
});

test("a result checks lifetime and candidacy again before it is applied", async () => {
  for (const change of [{ created_ms: 2 }, { foreground: front("sh") }, { state: "exited" }]) {
    const h = setup();
    const waiting = Promise.withResolvers();
    state.hcAnswer = () => waiting.promise;
    await h.step();
    assert.deepEqual(addresses(), ["t1"]);
    Object.assign(state.terminals[0], change);
    waiting.resolve(answer());
    await Promise.all(h.tasks);
    assert.equal(h.s.agyObs.has("t1"), false);
    assert.equal(h.notifications(), 0);
  }
});

test("duplicate records of one address are read once per tick", async () => {
  const snap = scene();
  snap.terminals.push(term("t1", { created_ms: 2, foreground: front("sh") }));
  const h = setup(snap);
  await h.step();
  assert.deepEqual(addresses(), ["t1"]);
  assert.equal(needs("t1"), undefined);
  await h.step();
  assert.deepEqual(addresses(), ["t1", "t1"]);
  assertHold("t1");
});

const alias = (fields = {}) => term("server/t2", { labels: { "herdr.tab": "tab-s1" }, ...fields });
const otherAlias = () => term("other/t2", { labels: { "herdr.tab": "tab-s1" } });

test("the read uses the core address and the row uses its display alias", async () => {
  const h = setup(scene(alias(), { display: "host-b/t2" }));
  await h.step();
  await h.step();
  assert.ok(nodes.has("ag-host-b/t2"));
  assert.equal(nodes.has("ag-server/t2"), false);
  assertHold("server/t2");
  click("ag-host-b/t2");
  assert.deepEqual(state.runs.at(-1), ["pane.focus", { pane: "p-host-b/t2" }]);
  assert.deepEqual(state.hcCalls, Array.from({ length: 2 }, () => ["read", "server/t2", "--lines", "40"]));
});

test("an ambiguous alias is neither drawn nor read", async () => {
  const snap = scene(alias(), { display: "host-b/t2" });
  snap.terminals.push(otherAlias());
  const h = setup(snap);
  await h.step();
  assert.equal(nodes.has("ag-host-b/t2"), false);
  assert.deepEqual(state.hcCalls, []);
});

test("two machines with the same local id keep separate lifetimes and holds", async () => {
  const snap = scene(term("t2"));
  const w = space("s2", "box");
  snap.spaces.push(w);
  snap.panes.push(pane("box/t2", w));
  snap.terminals.push(term("box/t2"));
  const h = setup(snap);
  state.hcAnswer = ([, a]) => answer(a === "t2" ? trustScreen : fileScreen());
  await h.step();
  await h.step();
  assertHold("t2");
  assertHold("box/t2", fileQuestion());
  assert.equal(nodes.get("needs-space-s1").props.tooltip, "Needs you: " + TRUST);
  assert.equal(nodes.get("needs-space-s2").props.tooltip, "Needs you: " + fileQuestion());
});

test("rows keep their identity, name and agent order across hold and clear", async () => {
  const snap = scene(term("t1", { status: "working" }), { listed: true });
  snap.terminals.push(term("t2"));
  snap.panes.push(pane("t2", snap.spaces[0]));
  const h = setup(snap);
  h.draw();
  const names = (id) => treeNodes(nodes.get(id)).find((n) => n.calls.some(([method]) => method === "truncate"));
  const identity = () => [...nodes.keys()].filter((id) => id.startsWith("ag-")).map((id) => [id, textOf(names(id))]);
  const before = identity(), order = state.agentOrder;
  await h.step();
  await h.step();
  assertHold("t1");
  assertHold("t2");
  assert.deepEqual(identity(), before);
  assert.deepEqual(state.agentOrder, order);
  state.hcAnswer = () => answer(safe);
  await h.step();
  assert.deepEqual(identity(), before);
  assert.deepEqual(state.agentOrder, order);
  assert.equal(needs("t1"), undefined);
  assert.equal(needs("t2"), undefined);
});

const hermes = (address = "t1", fields = {}) => term(address, { argv: ["hermes", "chat"], foreground: front("python"), ...fields });
const clarify = "0/1 answered · ↑/↓ select · Enter confirm";

test("an unarmed Hermes row still reads its clarify footer", async () => {
  const h = setup(scene(hermes()), null);
  h.draw();
  state.hcAnswer = () => answer(clarify);
  h.s.scanHermes(h.cx);
  await Promise.all(h.tasks);
  h.draw();
  assert.match(text("ag-t1"), /Needs you/);
  assert.deepEqual(state.hcCalls, [["read", "t1"]]);
});

test("a pane launched as Hermes with agy in front belongs to agy for every core status", async () => {
  for (const status of [undefined, "working", "blocked"]) {
    const h = setup(scene(hermes("t1", { status, foreground: front("agy") })));
    h.draw();
    h.s.scanHermes(h.cx);
    await Promise.all(h.tasks);
    assert.deepEqual(state.hcCalls, []);
    await h.step();
    assert.equal(h.s.extraList[0].agy, true);
    if (status === "blocked") {
      assert.deepEqual(state.hcCalls, []);
      assert.match(text("ag-t1"), /Needs you/);
    } else assert.deepEqual(state.hcCalls, [["read", "t1", "--lines", "40"]]);
  }
});

test("on a mixed host each scanner uses its own read and the Hermes row keeps its tab name", async () => {
  const snap = scene(hermes());
  snap.screen = { t1: "blocked" };
  snap.terminals.push(term("t2"));
  snap.panes.push(pane("t2", snap.spaces[0]));
  const unarmed = setup(snap, null);
  unarmed.draw();
  const before = rowShape("ag-t1");
  const h = setup(snap);
  state.hcAnswer = ([, a]) => answer(a === "t1" ? clarify : trustScreen);
  h.draw();
  assert.deepEqual(rowShape("ag-t1"), before);
  click("ag-t1");
  assert.deepEqual(state.runs.at(-1), ["pane.focus", { pane: "p-t1" }]);
  h.s.scanHermes(h.cx);
  await h.tick();
  await Promise.all(h.tasks);
  assert.deepEqual(state.hcCalls, [["read", "t1"], ["read", "t2", "--lines", "40"]]);
  h.draw();
  assert.deepEqual(rowShape("ag-t1"), before);
});

function many(addressList) {
  const w = space();
  return { spaces: [w], panes: addressList.map((a) => pane(a, w)), terminals: addressList.map((a) => term(a)), agents: [] };
}
const sequence = (prefix, count) => Array.from({ length: count }, (_, i) => prefix + (i + 1));

test("40 healthy candidates and two stalled remote reads leave local reads within budget", async () => {
  const locals = sequence("t", 24), remotes = sequence("box/t", 16), stalled = ["stuck/t1", "stuck/t2"];
  const order = [locals[0], ...stalled, ...locals.slice(1, 4), ...remotes.slice(0, 2),
    ...locals.slice(4), ...remotes.slice(2)];
  const h = setup(many(order));
  const peak = new Map(), running = new Map();
  state.hcAnswer = ([, a]) => {
    const machine = machineOf(a);
    const n = (running.get(machine) ?? 0) + 1;
    running.set(machine, n);
    peak.set(machine, Math.max(peak.get(machine) ?? 0, n));
    if (machine === "stuck") return new Promise(() => {});
    return new Promise((done) => h.cx.timer.after(10, () => {
      running.set(machine, running.get(machine) - 1);
      done(answer(a === "t1" ? trustScreen : safe));
    }));
  };

  const rotation = Math.ceil(order.length / 8);
  for (let i = 0; i < 2 * rotation; i += 1) {
    h.draw();
    const start = state.hcCalls.length;
    await h.tick();
    if (i === 0) {
      assert.equal(h.s.agyScanning, true);
      await h.tick();
      assert.equal(h.tasks.length, 1);
      assert.equal(state.hcCalls.length - start, 8);
      await h.advance(10);
      assert.equal(h.s.agyObs.get("t1")?.match.question, TRUST);
      assert.equal(h.s.agyScanning, true, "local result arrives before stuck reads time out");
      await h.advance(AGY_READ_MS - 10);
      assert.equal(h.s.agyGate("stuck").stuck, 2);
    } else await h.advance(AGY_READ_MS);
    await Promise.all(h.tasks);
    assert.equal(h.s.agyScanning, false);
    const batch = addresses().slice(start);
    assert.ok(batch.length <= 8);
    assert.equal(new Set(batch).size, batch.length);
  }
  h.draw();
  assertHold("t1");
  assert.deepEqual(addresses().filter((a) => machineOf(a) === "stuck"), stalled);
  assert.deepEqual(peak, new Map([[null, 4], ["stuck", 2], ["box", 2]]));
  assert.ok(order.every((a) => addresses().includes(a)));
});

test("round-robin reaches a local prompt outside the first eight", async () => {
  const order = sequence("t", 10);
  const h = setup(many(order));
  state.hcAnswer = ([, a]) => answer(a === "t10" ? trustScreen : safe);
  await h.step();
  assert.deepEqual(addresses(), order.slice(0, 8));
  assert.equal(h.s.agyObs.has("t10"), false);
  await h.step();
  assert.deepEqual(addresses().slice(8), [...order.slice(8), ...order.slice(0, 6)]);
  assert.equal(needs("t10"), undefined);
  await h.step();
  assertHold("t10");
});

function botScene(child = term("t4", { parent: "t3" })) {
  const snap = scene(term("t1", { foreground: front("claude"), status: "working" }), { listed: true });
  snap.terminals.push(term("t2", { parent: "t1" }), term("t3", { labels: { bot: BOT } }), child);
  snap.bots = [project()];
  snap.open = [["b:" + BOT, true]];
  return snap;
}

test("tabless agent sub-rows and a paneless bot's helpers count toward their parents' spaces", async () => {
  for (const [address, id] of [["t2", "sub-t2"], ["t4", "row-h:t4"]]) {
    const h = setup(botScene());
    state.hcAnswer = ([, a]) => answer(a === address ? trustScreen : safe);
    await h.step();
    await h.step();
    assert.ok(nodes.has(id));
    assertHold(address);
    assert.equal(nodes.get("needs-space-s1")?.props.tooltip, "Needs you: " + TRUST);
    h.draw(true);
    assert.match(text("space-s1"), /●/);
    assertRail(h.s);
  }
});

test("a remote child joined by a bare parent keeps its row and lights neither machine's space", async () => {
  const snap = scene(term("t1", { foreground: front("claude"), status: "working" }), { listed: true });
  const w = space("s2", "box"), p = pane("box/t1", w);
  snap.spaces.push(w);
  snap.panes.push(p);
  snap.agents.push(agent(p, w));
  snap.terminals.push(term("box/t1", { foreground: front("claude") }), term("box/t2", { parent: "t1" }),
    term("box/t3", { parent: "box/t2" }));
  const unarmed = setup(snap, null);
  unarmed.draw();
  const before = [rowShape("sub-box/t2"), rowShape("sub-box/t3")];
  const h = setup(snap);
  await h.step();
  await h.step();
  assert.deepEqual(state.hcCalls, []);
  assert.deepEqual([rowShape("sub-box/t2"), rowShape("sub-box/t3")], before);
  assert.equal(nodes.has("needs-space-s1"), false);
  assert.equal(nodes.has("needs-space-s2"), false);
});

test("a ledger-bound bot ignored by liveFrom keeps its click and menu and gets the held pet and chip", async () => {
  const snap = scene(term("t1", { foreground: undefined, report: { app: APP }, program: { agent: false } }));
  snap.bots = [project([])];
  const h = setup(snap);
  h.s.ledger = [{ bot: BOT, address: "t1", project: "/work/s1", state: "live" }];
  h.s.agyApps = [APP];
  const id = "row-b:" + BOT;
  const targets = () => {
    click(id);
    const menu = nodes.get(id).calls.find(([name, button]) => name === "on_mouse_down" && button === "right");
    menu[2]();
    return [state.runs.at(-1), state.opened.at(-1).props.live];
  };
  h.draw();
  assert.equal(h.s.trees[0].main.live, null);
  assert.equal(needs("t1"), undefined);
  const before = targets();
  assert.deepEqual(before, [["agent.focus", { terminal: "t1" }], "t1"]);
  await h.step();
  await h.step();
  assertHold("t1");
  assert.deepEqual(targets(), before);
  assert.ok([...h.s.petsWanted.values()].some((pet) => pet.pose === "needs-you"));
  h.s.petsWanted.clear();
  h.draw(true);
  assert.ok([...h.s.petsWanted.values()].some((pet) => pet.pose === "needs-you"));
  assert.equal(h.s.agyPlace.get("t1"), null);
});

test("an unlisted working agy pane gets a spinner, is read and then draws Needs you", async () => {
  const h = setup(scene(term("t1", { status: "working" })));
  await h.step();
  assert.equal(spinner("ag-t1"), true);
  assert.deepEqual(addresses(), ["t1"]);
  await h.step();
  assertHold("t1");
  assert.equal(spinner("ag-t1"), false);
  assert.deepEqual(addresses(), ["t1", "t1"]);
});

test("an alias turning ambiguous between render and tick loses its hold and is not read", async () => {
  const h = setup(scene(alias(), { display: "host-b/t2" }));
  await h.step();
  await h.step();
  assertHold("server/t2");
  state.terminals.push(otherAlias());
  await h.tick();
  assert.deepEqual(addresses(), ["server/t2", "server/t2"]);
  assert.equal(h.s.agyObs.has("server/t2"), false);
  h.draw();
  assert.equal(nodes.has("ag-host-b/t2"), false);
  assert.equal(nodes.has("needs-space-s1"), false);
});

test("a first read settling after a lost candidacy seeds nothing", async () => {
  const h = setup();
  const waiting = Promise.withResolvers();
  state.hcAnswer = () => waiting.promise;
  await h.step();
  state.terminals[0].foreground = front("sh");
  h.draw();
  state.terminals[0].foreground = front("agy");
  h.draw();
  waiting.resolve(answer());
  await Promise.all(h.tasks);
  assert.equal(h.s.agyObs.has("t1"), false);
  state.hcAnswer = () => answer();
  await h.step();
  assert.equal(needs("t1"), undefined);
  await h.step();
  assertHold("t1");
});

test("a queued read never starts if the terminal loses its agy foreground", async () => {
  const h = setup(many(["box/t1", "box/t2", "box/t3"]));
  const waiting = Promise.withResolvers();
  state.hcAnswer = () => waiting.promise;
  await h.step();
  assert.deepEqual(addresses(), ["box/t1", "box/t2"]);
  state.terminals[2].foreground = front("sh");
  h.draw();
  waiting.resolve(answer());
  await Promise.all(h.tasks);
  assert.deepEqual(addresses(), ["box/t1", "box/t2"]);
  assert.equal(h.s.agyObs.has("box/t3"), false);
});

test("agent, extra, aliased, sub-agent, helper and bot rows all draw their prompt tooltips", async () => {
  const snap = botScene();
  snap.terminals[0].foreground = front("agy");
  snap.terminals.push(term("t5"), alias({ report: { app: "agy" }, status: "idle" }));
  snap.panes.push(pane("t5", snap.spaces[0]), pane("host-b/t2", snap.spaces[0]));
  const h = setup(snap);
  await h.step();
  await h.step();
  for (const [id, a] of [["ag-t1", "t1"], ["ag-t5", "t5"], ["ag-host-b/t2", "server/t2"],
    ["sub-t2", "t2"], ["row-h:t4", "t4"], ["row-b:" + BOT, "t3"]]) {
    assert.ok(treeNodes(nodes.get(id)).includes(needs(a)), id);
    assertHold(a);
  }
  assert.ok([...h.s.petsWanted.values()].some((pet) => pet.pose === "needs-you"));
  assert.equal(nodes.get("needs-space-s1")?.props.tooltip, "Needs you: " + TRUST);
  h.draw(true);
  assert.match(text("space-s1"), /●/);
  assertRail(h.s);
});

test("a held agy pane takes space priority while the labelled pane keeps its Question chip", async () => {
  const snap = scene(term("t1", { foreground: front("claude"), status: "done", status_ms: NOW,
    labels: { [LABEL]: "SYNTHETIC Question?" } }), { listed: true });
  snap.terminals.push(term("t2", { status: "done" }));
  snap.panes.push(pane("t2", snap.spaces[0]));
  const h = setup(snap);
  await h.step();
  await h.step();
  assert.match(text("ag-t1"), /Question/);
  assert.ok(treeNodes(nodes.get("ag-t1")).some((n) => n.props.tooltip === "Waiting on you: SYNTHETIC Question?"));
  assertHold("t2");
  assert.doesNotMatch(text("ag-t2"), /Question/);
  assert.equal(nodes.has("owner-s1"), false);
  assert.equal(nodes.get("needs-space-s1")?.props.tooltip, "Needs you: " + TRUST);
  h.draw(true);
  assertRail(h.s);
  state.hcAnswer = () => answer(safe);
  await h.step();
  assert.equal(nodes.has("needs-space-s1"), false);
  assert.equal(nodes.get("owner-s1")?.props.tooltip, "Waiting on you: SYNTHETIC Question?");
  h.draw(true);
  assertRail(h.s, "s1", "owner");
});
