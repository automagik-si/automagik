// The footer rail (am-footer) under a stub runtime: the Bots tab comes first and shows only
// while the sidebar mod is installed, and its popup offers New bot and Bot settings as the sidebar
// mod's own forms. Not Herdr itself: the in-app check in the mod's RECIPE still applies.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";

const here = (f) => new URL(f, import.meta.url).href;
const stubs = { herdr: here("./footer-herdr.mjs"), "gpui-kit": here("./gpui-stub.mjs"), "gpui-base": here("./gpui-stub.mjs") };
const fromMod = (context) => context.parentURL?.includes("/mods/am-footer/");
registerHooks({
  resolve: (specifier, context, next) =>
    stubs[specifier] && fromMod(context) ? { url: stubs[specifier], shortCircuit: true } : next(specifier, context),
});

const { state, ui } = await import(stubs.herdr);
const { default: Footer, BOT_FORMS, PANELS, PANEL_POPUP, botsMenuItems, panelShown } = await import("../mods/am-footer/main.js");
const { OFF_BY_DEFAULT } = await import("../mods/am-sidebar/release.js");
const { all, index, nodes, textOf } = await import(stubs["gpui-kit"]);

const TABS = new Set(["bots", "mods", "automations", "quota", "pocket", "settings", "machine"]);

function makeCx() {
  const cx = { pending: [], spawn(fn) { const p = Promise.resolve().then(() => fn(cx)); cx.pending.push(p); return p; },
    timer: { every: () => ({ cancel() {} }) }, notify() {}, stop_propagation() {} };
  cx.settle = async () => { while (cx.pending.length) await Promise.allSettled(cx.pending.splice(0)); };
  return cx;
}

async function footer({ sidebar, quota = true, automations = true, files = {} }) {
  const root = mkdtempSync(join(tmpdir(), "hb-footer-"));
  state.appHome = root;
  if (sidebar) { mkdirSync(join(root, "mods/am-sidebar"), { recursive: true }); writeFileSync(join(root, "mods/am-sidebar/mod.json"), "{}\n"); }
  if (quota) { mkdirSync(join(root, "mods/am-quota"), { recursive: true }); writeFileSync(join(root, "mods/am-quota/mod.json"), "{}\n"); }
  if (automations) { mkdirSync(join(root, "mods/am-automations"), { recursive: true }); writeFileSync(join(root, "mods/am-automations/mod.json"), "{}\n"); }
  for (const [path, body] of Object.entries(files)) { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), body); }
  ui.props = { footer: true };
  const cx = makeCx();
  const view = new Footer();
  view.init({}, cx);
  await cx.settle();
  rmSync(root, { recursive: true, force: true });
  const drawn = view.render();
  index(drawn);
  // Contributed buttons are keyed <mod>/<id>; their badge is <key>#badge.
  return all(drawn).map((n) => n.id).filter((id) => TABS.has(id) || (typeof id === "string" && id.includes("/") && !id.includes("#")));
}

test("the rail: Bots first, ahead of Mods, Automations and Accounts, while the sidebar mod is installed", async () => {
  assert.deepEqual(await footer({ sidebar: true }), ["bots", "mods", "automations", "quota", "settings", "machine"]);
  assert.equal(nodes.get("bots").kids[0].__node.arg, "mods/am-footer/bot.svg");
});

test("the rail: no Bots tab without mods/am-sidebar/mod.json", async () => {
  assert.deepEqual(await footer({ sidebar: false }), ["mods", "automations", "quota", "settings", "machine"]);
});

test("the rail: no Accounts tab while am-quota is off (in mods-disabled/) or not installed", async () => {
  assert.deepEqual(await footer({ sidebar: true, quota: false }), ["bots", "mods", "automations", "settings", "machine"]);
  const off = { "mods-disabled/am-quota/mod.json": "{}\n" };
  assert.deepEqual(await footer({ sidebar: false, quota: false, files: off }), ["mods", "automations", "settings", "machine"]);
});

test("am-quota off: an Accounts panel left open is hidden; one already hidden, or the mod on, is left alone", async () => {
  const tree = (hidden) => ({ id: "root", children: [{ id: "am-quota-panel", hidden, children: [] }] });
  for (const [quota, hidden, want] of [[false, false, [["layout.hide", { id: "am-quota-panel" }]]], [false, true, []], [true, false, []]]) {
    ui.layout = tree(hidden);
    state.runs = [];
    await footer({ sidebar: true, quota });
    assert.deepEqual(state.runs.filter(([n]) => n.startsWith("layout.")), want, `quota ${quota}, hidden ${hidden}`);
  }
  ui.layout = null;
});

test("the rail: no Automations tab while am-automations is off (in mods-disabled/) or not installed", async () => {
  assert.deepEqual(await footer({ sidebar: true, automations: false }), ["bots", "mods", "quota", "settings", "machine"]);
  const off = { "mods-disabled/am-automations/mod.json": "{}\n" };
  assert.deepEqual(await footer({ sidebar: false, automations: false, quota: false, files: off }), ["mods", "settings", "machine"]);
});

test("am-automations off: an Automations panel left open is hidden; one already hidden, or the mod on, is left alone", async () => {
  const tree = (hidden) => ({ id: "root", children: [{ id: "automations-panel", hidden, children: [] }] });
  for (const [automations, hidden, want] of [[false, false, [["layout.hide", { id: "automations-panel" }]]], [false, undefined, [["layout.hide", { id: "automations-panel" }]]], [false, true, []], [true, false, []]]) {
    ui.layout = tree(hidden);
    state.runs = [];
    await footer({ sidebar: true, automations });
    assert.deepEqual(state.runs.filter(([n]) => n.startsWith("layout.")), want, `automations ${automations}, hidden ${hidden}`);
  }
  ui.layout = null;
});

test("a panel is active only while its block is in the layout and not hidden: a missing block never is", async () => {
  const block = (id, extra) => ({ id, type: "block", children: [], ...extra });
  assert.equal(panelShown({ id: "root", children: [] }, "am-quota-panel"), false, "no block");
  assert.equal(panelShown({}, "am-quota-panel"), false, "an empty layout");
  assert.equal(panelShown(null, "am-quota-panel"), false, "no layout at all");
  assert.equal(panelShown({ id: "root", children: [block("am-quota-panel", { hidden: true })] }, "am-quota-panel"), false, "hidden");
  assert.equal(panelShown({ id: "root", children: [block("am-quota-panel", { hidden: false })] }, "am-quota-panel"), true, "shown");
  assert.equal(panelShown({ id: "root", children: [block("am-quota-panel")] }, "am-quota-panel"), true, "no hidden key: shown");
  // Drawn: with neither block in the layout, both tabs show unselected.
  ui.layout = { id: "root", children: [] };
  await footer({ sidebar: false });
  for (const id of ["automations", "quota"]) assert.deepEqual(nodes.get(id).calls.find(([n]) => n === "bg"), ["bg", ui.theme.chrome], `${id} is not active`);
  ui.layout = { id: "root", children: [block("am-quota-panel", { hidden: false }), block("automations-panel", { hidden: true })] };
  await footer({ sidebar: false });
  assert.deepEqual(nodes.get("quota").calls.find(([n]) => n === "bg"), ["bg", ui.theme.selected], "Accounts showing");
  assert.deepEqual(nodes.get("automations").calls.find(([n]) => n === "bg"), ["bg", ui.theme.chrome], "Automations hidden");
  ui.layout = null;
});

test("a panel tab toggles its block when the layout has one, else opens the mod as a popup", async () => {
  for (const p of PANELS) {
    ui.layout = { id: "root", children: [{ id: p.node, hidden: true, children: [] }] };
    await footer({ sidebar: false });
    state.runs = [];
    ui.overlays = [];
    nodes.get(p.tab).click(null, makeCx());
    assert.deepEqual(state.runs, [["layout.toggle", { id: p.node }]], `${p.tab} with its block`);
    assert.deepEqual(ui.overlays, []);
    ui.layout = { id: "root", children: [] };
    await footer({ sidebar: false });
    state.runs = [];
    nodes.get(p.tab).click(null, makeCx());
    assert.deepEqual(state.runs, [], `${p.tab} without its block toggles nothing`);
    assert.deepEqual(ui.overlays, [{ mod: p.mod, ...PANEL_POPUP }], `${p.tab} without its block opens ${p.mod}`);
  }
  ui.layout = null;
});

test("turned off, then on again: the tab and its click go and come back, once", async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-footer-"));
  state.appHome = root;
  const on = join(root, "mods/am-automations"), off = join(root, "mods-disabled/am-automations");
  mkdirSync(on, { recursive: true });
  mkdirSync(join(root, "mods-disabled"));
  writeFileSync(join(on, "mod.json"), "{}\n");
  ui.props = { footer: true };
  ui.layout = { id: "root", children: [] };
  // The 30 s look, run by hand after each move the Mods panel makes.
  const cx = makeCx();
  cx.timer = { every: (_ms, fn) => { cx.look = fn; } };
  const view = new Footer();
  const rail = async () => { await cx.settle(); const d = view.render(); index(d); return all(d).map((n) => n.id).filter((id) => id === "automations"); };
  try {
    view.init({}, cx);
    assert.deepEqual(await rail(), ["automations"], "on");
    renameSync(on, off);
    cx.look(cx);
    assert.deepEqual(await rail(), [], "off");
    renameSync(off, on);
    cx.look(cx);
    assert.deepEqual(await rail(), ["automations"], "on again: one tab");
    ui.overlays = [];
    nodes.get("automations").click(null, makeCx());
    assert.deepEqual(ui.overlays, [{ mod: "am-automations", ...PANEL_POPUP }], "and it opens the panel");
  } finally {
    rmSync(root, { recursive: true, force: true });
    ui.layout = null;
  }
});

// Herdr shows plain Herdr instead of a layout that names a mod missing from mods/ ("<layout> needs
// mods that aren't here. Showing Herdr instead."), hidden block or not (issue #221). The pack's
// layout must not name a mod that can be off: one that ships off, or a panel the rail opens.
test("the pack's layout names no mod that ships off, and no panel block the rail opens itself", () => {
  const layout = JSON.parse(readFileSync(new URL("../../herdr-layout/layouts/automagik.json", import.meta.url), "utf8"));
  const named = [], ids = [];
  const walk = (n) => { if (n.content?.mod) named.push(n.content.mod); if (n.id) ids.push(n.id); for (const f of n.floating ?? []) walk(f); (n.children ?? []).forEach(walk); };
  walk(layout);
  assert.ok(named.includes("am-footer"), "the walk reaches the blocks");
  for (const mod of [...OFF_BY_DEFAULT, ...PANELS.map((p) => p.mod)]) assert.ok(!named.includes(mod), `the layout names ${mod}`);
  for (const p of PANELS) assert.ok(!ids.includes(p.node), `the layout has ${p.node}`);
  if (layout.terminal_menu) assert.ok(!OFF_BY_DEFAULT.includes(layout.terminal_menu));
});

test("the Bots tab opens this mod's popup", async () => {
  await footer({ sidebar: true });
  ui.overlays = [];
  nodes.get("bots").click(null, makeCx());
  assert.deepEqual(ui.overlays, [{ mod: "am-footer", kind: "popup", width: 200, height: 90, props: { botsMenu: true } }]);
});

test("the forms are the sidebar mod's own: create 1000 x 840, the bot list 560 x 0.85, modal dialogs", () => {
  assert.deepEqual(BOT_FORMS.create, { mod: "am-sidebar", kind: "dialog", modal: true, width: 1000, height: 840, props: { form: "create" } });
  assert.deepEqual(BOT_FORMS.pick, { mod: "am-sidebar", kind: "dialog", modal: true, width: 560, height: 0.85, props: { form: "pick" } });
});

function popup() {
  ui.props = { botsMenu: true, overlay: "o3" };
  const cx = makeCx();
  const view = new Footer();
  view.init({}, cx);
  assert.equal(cx.pending.length, 0, "the popup looks nothing up");
  return index(view.render());
}

test("the popup with bots (or before the sidebar has said): New bot and Bot settings, each opening its form", () => {
  for (const defined of [true, undefined]) {
    defined === undefined ? state.shared.delete("bots.defined") : state.shared.set("bots.defined", defined);
    popup();
    assert.deepEqual(botsMenuItems().map((i) => i.label), ["New bot", "Bot settings"]);
    assert.equal(textOf(nodes.get("bots-menu")), "New bot Bot settings");
  }
  for (const [id, form] of [["bots-new", "create"], ["bots-settings", "pick"]]) {
    ui.overlays = [];
    const closed = ui.closed;
    nodes.get(id).click(null, makeCx());
    assert.deepEqual(ui.overlays, [BOT_FORMS[form]]);
    assert.equal(ui.closed, closed + 1, "the popup closes");
  }
});

test("the popup with no bot on this computer: a single New bot line", () => {
  state.shared.set("bots.defined", false);
  popup();
  assert.equal(textOf(nodes.get("bots-menu")), "New bot");
  assert.ok(!nodes.has("bots-settings"));
  ui.overlays = [];
  nodes.get("bots-new").click(null, makeCx());
  assert.deepEqual(ui.overlays, [BOT_FORMS.create]);
  state.shared.delete("bots.defined");
});

// Another mod's button (the Genie board's Tasks), from its own mod.json in the scratch app home.
const TASKS_MOD = {
  "mods/tasks-mock/mod.json": JSON.stringify({ place: "none", automagik: { footer: [
    { id: "tasks", label: "Tasks", icon: "mods/genie-herdr/tasks.svg", command: "mod.open", args: { name: "tasks-mock" }, badge: "genie.tasks.waiting" },
    { id: "broken", label: "No command" },
  ] } }),
  "mods/genie-herdr/tasks.svg": '<svg viewBox="0 0 24 24"><path d="M4 4h16" /></svg>',
};

test("a contributed button: after the pack's own tabs, before the app's, its icon tinted like theirs", async () => {
  state.calls.length = 0;
  assert.deepEqual(await footer({ sidebar: true, files: TASKS_MOD }), ["bots", "mods", "automations", "quota", "tasks-mock/tasks", "settings", "machine"]);
  assert.equal(nodes.get("tasks-mock/tasks").kids[0].__node.kind, "svg");
  assert.equal(nodes.get("tasks-mock/tasks").kids[0].__node.arg, "mods/genie-herdr/tasks.svg");
  assert.ok(!state.calls.some((c) => c.kind === "write"), "the scan writes nothing");
  assert.ok(!state.calls.some((c) => /pocket-link\/(?!mod\.json)/i.test(String(c.path))), "only Pocket Link's own tab lookup");
});

test("a contributed button's press runs its command: mod.open toggles the board", async () => {
  await footer({ sidebar: false, files: TASKS_MOD });
  state.runs.length = 0;
  nodes.get("tasks-mock/tasks").click(null, makeCx());
  assert.deepEqual(state.runs, [["mod.open", { name: "tasks-mock" }]]);
});

test("a contributed button's badge: a count for a number above 0, nothing for 0, a string or null", async () => {
  for (const [value, drawn] of [[3, "3"], [0, null], ["x", null], [null, null]]) {
    state.shared.set("genie.tasks.waiting", value);
    await footer({ sidebar: false, files: TASKS_MOD });
    const badge = nodes.get("tasks-mock/tasks#badge");
    assert.equal(badge ? textOf(badge) : null, drawn, `badge ${JSON.stringify(value)}`);
  }
  state.shared.delete("genie.tasks.waiting");
});

test("a contributed button with a missing icon draws the neutral glyph", async () => {
  const files = { "mods/tasks-mock/mod.json": TASKS_MOD["mods/tasks-mock/mod.json"] };
  await footer({ sidebar: false, files });
  assert.equal(nodes.get("tasks-mock/tasks").kids[0].__node.arg, "mods/am-footer/circle.svg");
});

test("a mod.json change rescans at once; a batch of other files does not", async () => {
  const batches = [(dir) => [`${dir}/tasks-mock/main.js`], (dir) => [`${dir}/tasks-mock/mod.json`]];
  state.watch = (dir) => (batches.length ? Promise.resolve(batches.shift()(dir)) : Promise.reject(new Error("done")));
  state.calls.length = 0;
  try {
    await footer({ sidebar: false, files: TASKS_MOD });
  } finally {
    delete state.watch;
  }
  const finds = state.calls.filter((c) => c.kind === "exec" && c.command === "find");
  assert.equal(finds.length, 2, "the first look, then the mod.json batch");
});

test("contributed buttons clip in their own group; the rail's own tabs always render, outside it", async () => {
  const four = (name) => ({ [`mods/${name}/mod.json`]: JSON.stringify({ automagik: { footer: [1, 2].map((n) => ({ id: `b${n}`, label: `${name} ${n}`, command: "app.help" })) } }) });
  const ids = await footer({ sidebar: true, files: { ...four("aa"), ...four("bb"), ...four("cc") } });
  assert.deepEqual(ids, ["bots", "mods", "automations", "quota", "aa/b1", "aa/b2", "bb/b1", "bb/b2", "settings", "machine"]);
  const group = nodes.get("footer-contributed");
  const calls = new Map(group.calls.map(([name, ...args]) => [name, args]));
  assert.deepEqual(calls.get("min_w"), [0]);
  assert.deepEqual(calls.get("flex_shrink"), [1]);
  assert.ok(calls.has("overflow_hidden"), "the group clips");
  const inside = new Set(all({ __node: group }).map((n) => n.id));
  for (const id of ["bots", "mods", "automations", "quota", "settings", "machine"]) {
    assert.ok(!inside.has(id), `${id} is outside the clipping group`);
    assert.ok(nodes.get(id).calls.some(([name]) => name === "flex_none"), `${id} never shrinks`);
  }
  for (const id of ["aa/b1", "bb/b2"]) assert.ok(inside.has(id), `${id} is inside the group`);
});

test("no contributed buttons: no empty group in the rail", async () => {
  await footer({ sidebar: false });
  assert.ok(!nodes.has("footer-contributed"));
});

test("the footer reads the adopted state and refreshes when am's record changes", async t => {
  const root = mkdtempSync(join(tmpdir(), "hb-footer-pocket-"));
  const savedAmHome = process.env.AM_HOME;
  const savedState = process.env.POCKET_LINK_STATE_DIR;
  process.env.AM_HOME = join(root, "am");
  process.env.POCKET_LINK_STATE_DIR = join(root, "standalone");
  t.after(() => {
    if (savedAmHome === undefined) delete process.env.AM_HOME; else process.env.AM_HOME = savedAmHome;
    if (savedState === undefined) delete process.env.POCKET_LINK_STATE_DIR; else process.env.POCKET_LINK_STATE_DIR = savedState;
    rmSync(root, { recursive: true, force: true });
  });
  const record = join(process.env.AM_HOME, "parts/pocket.link/record.json");
  const status = (name, connected) => {
    const dir = join(root, name);
    mkdirSync(dir);
    writeFileSync(join(dir, "public-status.json"), JSON.stringify({ schema: 1, updated: Date.now(), running: true, phones_connected: Number(connected) }));
    return dir;
  };
  status("standalone", false);
  const adopted = status("adopted elsewhere", true);
  const moved = status("sibling adoption", false);
  mkdirSync(join(record, ".."), { recursive: true });
  const dialog = join(root, "mods/pocket-link/mod.json");
  mkdirSync(join(dialog, ".."), { recursive: true });
  writeFileSync(dialog, "{}");
  state.appHome = root;
  ui.props = { footer: true };
  const cx = makeCx();
  let look;
  cx.timer.every = (_, fn) => { look = () => fn(cx); };
  const view = new Footer();
  view.init({}, cx);
  await cx.settle();
  assert.equal(view.pocket, true);
  assert.equal(view.phone, false);
  writeFileSync(record, JSON.stringify({ state: adopted }));
  look();
  await cx.settle();
  assert.equal(view.phone, true);
  assert.equal(view.statusPath, join(adopted, "public-status.json"));
  writeFileSync(record, JSON.stringify({ state: moved }));
  look();
  await cx.settle();
  assert.equal(view.phone, false);
  assert.equal(view.statusPath, join(moved, "public-status.json"));
  rmSync(record);
  look();
  await cx.settle();
  assert.equal(view.statusPath, join(root, "standalone/public-status.json"));
});
