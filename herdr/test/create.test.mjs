// The bot form (create.js) under `node --test`, with gpui and herdr stood in for
// (gpui-stub.mjs, form-herdr-stub.mjs): what it lists, what Copy copies, how a save or a
// Start that fails is reported, and that a picture it can't write is not retried.
import { registerHooks } from "node:module";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchProject, scratchRoot } from "./scratch-project.mjs";

const here = (f) => new URL(f, import.meta.url).href;
const stubs = { herdr: here("./form-herdr-stub.mjs"), "fs/promises": here("./fs-stub.mjs"), "gpui-kit": here("./gpui-stub.mjs"), "gpui-base": here("./gpui-stub.mjs") };
const CLI = new URL("../mods/am-sidebar/bin/automagik-herdr.mjs", import.meta.url).pathname;
const FAKE_AGY = new URL("./fake-agy.mjs", import.meta.url).pathname;
const fromPack = (context) => context.parentURL?.includes("/mods/am-sidebar/");
registerHooks({
  resolve: (specifier, context, next) => (stubs[specifier] && fromPack(context) ? { url: stubs[specifier], shortCircuit: true } : next(specifier, context)),
});
const { state } = await import(stubs.herdr);
const { nodes, textOf, index, all } = await import(stubs["gpui-kit"]);
const { BotForm, FORM_SIZE } = await import("../mods/am-sidebar/create.js");
const { layoutPopup } = await import("./popup-layout.mjs");
const { hcFileOps } = await import("./hc-file-ops.mjs");

const look = (character, colour) => ({ character, colour });
const MAIN = { id: "b-mainaaaaaa", name: "orch", kind: "main", look: look("octopus", "deepseek"), role: "", instructions: "", agent: "claude" };
const OMP = { id: "b-ompaaaaaaa", name: "pi-bot", kind: "member", look: look("hex", "sky"), role: "r", instructions: "", agent: "omp", model: "kimi-k3" };
const KIMI = { id: "b-kimiaaaaaa", name: "kimi-bot", kind: "member", look: look("gem", "rose"), role: "r", instructions: "", agent: "kimi" };
const AGENTS = [
  { key: "claude", name: "Claude Code", installed: true, icon: "icons/claude.svg", tint: false },
  { key: "omp", name: "Oh My Pi", installed: true, icon: "icons/pi.svg", tint: true },
  { key: "kimi", name: "Kimi", installed: false, icon: "icons/kimi.svg", tint: false },
  { key: "amp", name: "Amp", installed: false, icon: "icons/amp.svg", tint: false },
  { key: "antigravity", name: "Antigravity", installed: false, icon: null, tint: false },
];
// The fixture with Antigravity's installed flag set, no duplicate entry.
const withAntigravity = (installed) => AGENTS.map((a) => (a.key === "antigravity" ? { ...a, installed } : a));

function makeCx() {
  const cx = {
    pending: [], spawns: 0, notifies: 0, clip: null,
    spawn(fn) { cx.spawns += 1; const p = Promise.resolve().then(() => fn(cx)); cx.pending.push(p); return p; },
    notify() { cx.notifies += 1; },
    write_to_clipboard(text) { cx.clip = text; },
    stop_propagation() {},
  };
  cx.settle = async () => { for (let i = 0; i < 100 && cx.pending.length; i += 1) await Promise.allSettled(cx.pending.splice(0)); };
  return cx;
}

let root, project;
beforeEach((t) => {
  root = scratchRoot(t, "hb-create-");
  project = scratchProject(root, "proj");
  state.appHome = join(root, "app");
  state.notes = [];
  state.closed = [];
  state.runs = [];
  state.spaces = [];
  state.focused = null;
  state.pickFolder = null;
  state.terminals = [];
  state.agents = AGENTS;
  state.hcAnswer = () => ({ code: 0, stdout: "{}", stderr: "" });
  state.offline = new Set();
  state.calls = [];
  state.hcCalls = [];
  state.trimExec = false;
});

const seed = (bots, extra = {}) => writeFileSync(join(project, ".herdr/bots.json"), `${JSON.stringify({ version: 1, categories: [], bots, ...extra }, null, 2)}\n`);
// The pack's Antigravity model cache (modelCache.js) in the test app home: opening a form on
// Antigravity then reads this list and never runs the host's agy. A test that deletes it and
// puts a fake agy on PATH watches the one refresh.
const seedAgModels = (models = [{ id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" }, { id: "claude-sonnet-5-5-high", label: "Claude Sonnet 5.5 (High)" }]) => {
  mkdirSync(join(state.appHome, "automagik-herdr"), { recursive: true });
  writeFileSync(join(state.appHome, "automagik-herdr/antigravity-models.json"), JSON.stringify({ version: 1, source: "agy models", at: new Date().toISOString(), models }));
};
const stored = () => JSON.parse(readFileSync(join(project, ".herdr/bots.json"), "utf8"));
async function open(props) {
  const cx = makeCx();
  const form = new BotForm({ overlay: "o9", project, ...props }, cx);
  await cx.settle();
  return { form, cx, draw: () => index(form.render(cx)), click: async (id) => { nodes.get(id).click(null, cx); await cx.settle(); } };
}

test("FORM_SIZE is the mockup's 1000 x 840", () => {
  assert.deepEqual(FORM_SIZE, { width: 1000, height: 840 });
});

test("Runs on: installed agents only, plus the bot's own agent when it isn't installed", async () => {
  seed([MAIN, KIMI]);
  const { draw } = await open({ form: "create" });
  draw();
  assert.ok(nodes.has("bot-agent-claude") && nodes.has("bot-agent-omp"));
  assert.ok(!nodes.has("bot-agent-kimi") && !nodes.has("bot-agent-amp"));
  const e = await open({ form: "edit", bot: KIMI.id });
  e.draw();
  assert.ok(nodes.has("bot-agent-kimi"), "the bot's own agent stays shown");
  assert.equal(nodes.get("bot-agent-kimi").props.opacity, 0.45);
  assert.ok(!nodes.has("bot-agent-amp"));
});

test("Runs on: gemini is never offered; a gemini bot opens on Antigravity", async () => {
  state.agents = [...withAntigravity(false),
    { key: "gemini", name: "Gemini", installed: true, icon: "icons/gemini.svg", tint: false }];
  const GEM = { ...KIMI, id: "b-gemaaaaaaa", name: "gem-bot", agent: "gemini" };
  seedAgModels();
  seed([MAIN, GEM]);
  const { draw } = await open({ form: "create" });
  draw();
  assert.ok(!nodes.has("bot-agent-gemini"), "installed, but retired");
  const e = await open({ form: "edit", bot: GEM.id });
  e.draw();
  assert.ok(!nodes.has("bot-agent-gemini"));
  assert.ok(nodes.has("bot-agent-antigravity"), "the mapped agent is the bot's own");
});

test("Runs on: the pack's agents fill in what knownAgents misses (#793), installed or not", async () => {
  seed([MAIN]);
  const { form } = await open({ form: "create" });
  form.programFile = async () => "/fake/bin/agy";
  const merged = await form.withPackAgents([{ key: "claude", name: "Claude Code", installed: true, icon: "icons/claude.svg" }]);
  assert.deepEqual(merged.find((a) => a.key === "antigravity"), { key: "antigravity", name: "Antigravity", installed: true, icon: null, tint: false });
  assert.equal(merged.find((a) => a.key === "claude").icon, "icons/claude.svg", "Herdr's own entry is kept");
  assert.deepEqual(merged.map((a) => a.key).sort(), ["antigravity", "claude"], "antigravity is the only pack agent added");
  form.programFile = async () => null;
  const dim = await form.withPackAgents([]);
  assert.equal(dim.find((a) => a.key === "antigravity").installed, false, "not installed: shown dimmed when it is the bot's own");
  assert.equal(new Set(dim.map((a) => a.key)).size, dim.length, "no duplicates");
});

test("Antigravity (#793): the pin list is the cached agy models, never the settings label", async () => {
  state.agents = withAntigravity(true);
  const AG = { ...MAIN, id: "b-agyaaaaaaa", name: "ag-bot", kind: "member", lead: MAIN.id, agent: "antigravity" };
  seedAgModels();
  seed([MAIN, AG]);
  const { form, draw } = await open({ form: "edit", bot: AG.id });
  draw();
  assert.ok(nodes.has("bot-pin"));
  form.pop = "models";
  draw();
  const labels = ["bot-pin-1", "bot-pin-2"].map((id) => nodes.get(id)?.calls.find(([call]) => call === "accessibility_label")?.[1]);
  assert.deepEqual(labels, ["gemini-4-argon-high", "claude-sonnet-5-5-high"]);
  assert.ok(!labels.includes("Gemini 4 Argon (High)"), "the settings label is the Default, never a pin");
});

test("Antigravity (#793): a missing model cache is refreshed once with `agy models`, then read from the app home", async (t) => {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const exe = (path, text) => { writeFileSync(path, text); chmodSync(path, 0o755); };
  exe(join(bin, "agy"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_AGY}" "$@"\n`);
  const before = process.env.PATH;
  process.env.PATH = `${bin}:${before}`;
  t.after(() => { process.env.PATH = before; });
  state.agents = withAntigravity(true);
  const AG = { ...MAIN, id: "b-agyaaaaaaa", name: "ag-bot", kind: "member", lead: MAIN.id, agent: "antigravity" };
  seed([MAIN, AG]);
  const { form } = await open({ form: "edit", bot: AG.id });
  const info = form.modelInfo("antigravity");
  assert.ok(info.models.includes("gemini-4-argon-high") && info.models.includes("claude-opus-5-5-high"));
  const cache = JSON.parse(readFileSync(join(state.appHome, "automagik-herdr/antigravity-models.json"), "utf8"));
  assert.ok(cache.models.some((m) => m.id === "claude-opus-5-5-high"), "the fixture list was written");
  const call = state.calls.find((c) => c.kind === "exec" && c.args?.[0] === "models");
  assert.ok(call, "agy models ran");
  assert.equal(call.command, join(bin, "agy"), "the resolved absolute path, as the CLI resolves it");
  // A second form in the same session reads the file: no second `agy models`.
  const execs = () => state.calls.filter((c) => c.kind === "exec" && c.args?.[0] === "models").length;
  assert.equal(execs(), 1);
  await open({ form: "edit", bot: AG.id });
  assert.equal(execs(), 1, "once per session");
});

test("Antigravity (#793): a field typed while a slow model refresh runs is still saved", async (t) => {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const release = join(root, "agy-release");
  const exe = (path, text) => { writeFileSync(path, text); chmodSync(path, 0o755); };
  // The fake agy waits for the test's release file: the refresh is held while the person types.
  exe(join(bin, "agy"), `#!/bin/sh\ni=0\nwhile [ ! -e "${release}" ] && [ $i -lt 1500 ]; do sleep 0.02; i=$((i + 1)); done\nexec "${process.execPath}" "${FAKE_AGY}" "$@"\n`);
  const before = process.env.PATH;
  process.env.PATH = `${bin}:${before}`;
  t.after(() => {
    try { writeFileSync(release, "go"); } catch { /* the temp root is gone: the fake's loop ends on its own */ }
    process.env.PATH = before;
  });
  state.agents = withAntigravity(true);
  const AG = { ...MAIN, id: "b-agyaaaaaaa", name: "ag-bot", kind: "member", lead: MAIN.id, agent: "antigravity" };
  seed([MAIN, AG]);
  const cx = makeCx();
  const form = new BotForm({ overlay: "o9", project, form: "edit", bot: AG.id }, cx);
  // load() fills the fields, snapshots the opened state, then awaits the cache refresh.
  const started = Date.now();
  while (!form.initial && Date.now() - started < 5000) await new Promise((go) => setTimeout(go, 10));
  assert.ok(form.initial, "the form filled and snapshotted before the refresh");
  form.inputs.name.type("typed-while-refreshing", cx);
  writeFileSync(release, "go");
  await cx.settle();
  assert.ok(form.modelInfo("antigravity").models.includes("gemini-4-argon-high"), "the refreshed list is used");
  index(form.render(cx));
  nodes.get("bot-save").click(null, cx);
  await cx.settle();
  assert.equal(stored().bots.find((b) => b.id === AG.id).name, "typed-while-refreshing", "the typed name was not lost to the snapshot");
});

test("Runs on: a knownAgents() failure is shown, not swallowed", async () => {
  seed([MAIN]);
  Object.defineProperty(state, "agents", { configurable: true, get() { throw new Error("no program table"); } });
  try {
    const { form, draw } = await open({ form: "create" });
    assert.match(textOf(draw()), /couldn't list its coding agents \(no program table\)/);
    assert.ok(form.agentsError);
  } finally {
    Object.defineProperty(state, "agents", { configurable: true, writable: true, value: AGENTS });
  }
});

test("a stored pin can be cleared when the agent lists no models", async () => {
  seed([MAIN, OMP]);
  const { form, draw, click } = await open({ form: "edit", bot: OMP.id });
  draw();
  assert.ok(nodes.has("bot-pin"), "the pin control shows for a stored pin");
  form.pop = "models";
  draw();
  await click("bot-pin-0"); // Default
  assert.equal(form.s.pin, "");
  draw();
  assert.ok(!nodes.has("bot-pin"), "no list and no pin: no control");
});

test("Copy copies only a line the form would save; a refused one shows why", async () => {
  seed([MAIN]);
  const { form, cx, draw, click } = await open({ form: "create" });
  draw();
  await click("bot-copy");
  assert.equal(cx.clip, null);
  assert.equal(form.error, "Not copied: Give the bot a name.");
  form.inputs.name.type("qa", cx);
  draw();
  await click("bot-copy");
  assert.match(cx.clip, /^am create --name=qa /);
  // The model is read once per agent, not on every render.
  assert.ok(form.models.has("claude"));
});

test("a refused write says Not saved once", async () => {
  // An entry parseBots leaves out (a bad id) stays in the raw copy, so checkBots refuses the write.
  seed([MAIN, { id: "x", name: "broken", kind: "member" }]);
  const { form, cx, draw, click } = await open({ form: "create" });
  form.inputs.name.type("qa", cx);
  draw();
  await click("bot-save");
  assert.match(form.error, /^Not saved: x: id is not b- plus 10 base32 characters/);
  assert.doesNotMatch(form.error, /Not saved: Not saved/);
});

test("Create & start: a Start that throws after the save says Saved, not started", async () => {
  seed([MAIN]);
  const { form, cx, draw, click } = await open({ form: "create" });
  form.inputs.name.type("qa", cx);
  draw();
  Object.defineProperty(state, "terminals", { configurable: true, get() { throw new Error("terminals gone"); } });
  try {
    await click("bot-save-start");
  } finally {
    Object.defineProperty(state, "terminals", { configurable: true, writable: true, value: [] });
  }
  assert.match(form.error, /^Saved, not started: /);
  assert.ok(stored().bots.some((b) => b.name === "qa"), "the bot was saved");
  draw();
  assert.ok(!nodes.has("bot-save") && !nodes.has("bot-save-start"), "not offered a second time");
  assert.deepEqual(state.closed, []);
});

test("a character picture that can't be written is not retried, and one notice names the folder", async () => {
  seed([MAIN]);
  writeFileSync(join(root, "app"), "a file where the app home should be");
  const { form, cx, draw, click } = await open({ form: "create" });
  const spawns = cx.spawns;
  assert.equal(state.notes.length, 1);
  assert.match(state.notes[0].body, new RegExp(`${root}/app/am-sidebar-pets`));
  assert.ok(form.petsFailed.size > 0 && form.pets.size === 0);
  // Redraws and a new colour: no endless retry, no second notice.
  draw(); draw();
  await cx.settle();
  assert.equal(cx.spawns, spawns);
  draw();
  await click("bot-colour-rose");
  assert.ok(cx.spawns <= spawns + 1);
  assert.equal(state.notes.length, 1);
});

test("character pictures are written under the app home outside mods/ and drawn", async () => {
  seed([MAIN]);
  const { form } = await open({ form: "create" });
  assert.ok(form.pets.size >= 22);
  const file = [...form.pets][0];
  assert.match(readFileSync(join(root, "app/am-sidebar-pets", file), "utf8"), /^<svg /);
});

test("the mockup's six icons are SVG files under the app home, drawn tinted with svg()", async () => {
  seed([MAIN]);
  const { form, draw } = await open({ form: "create" });
  for (const name of ["folder", "clock", "shuffle", "chevron", "close", "copy"]) {
    assert.match(readFileSync(join(root, "app/am-sidebar-pets", `ui-${name}.svg`), "utf8"), /^<svg [^>]*stroke="currentColor"/, name);
  }
  const drawn = all(draw()).filter((n) => n.kind === "svg" && /^am-sidebar-pets\/ui-/.test(n.arg));
  assert.deepEqual([...new Set(drawn.map((n) => n.arg))].sort(),
    ["chevron", "clock", "close", "copy", "folder", "shuffle"].map((n) => `am-sidebar-pets/ui-${n}.svg`));
  assert.ok(drawn.every((n) => /^#[0-9a-f]{6}$/i.test(n.props.color)), "each one tinted");
  assert.ok(form.pets.has("ui-close.svg"));
});

test("Rank chips (A16): shown for a member, picked into the save and the copied line; None clears", async () => {
  seed([MAIN]);
  const { form, cx, draw, click } = await open({ form: "create" });
  form.inputs.name.type("qa", cx);
  draw();
  assert.ok(nodes.has("bot-rank-none") && nodes.has("bot-rank-tester") && nodes.has("bot-rank-fixer") && !nodes.has("bot-rank-main"));
  await click("bot-rank-tester");
  draw();
  await click("bot-copy");
  assert.match(cx.clip, / --rank=tester /);
  await click("bot-rank-none");
  draw();
  await click("bot-copy");
  assert.doesNotMatch(cx.clip, /--rank/);
  await click("bot-rank-fixer");
  draw();
  await click("bot-copy");
  assert.match(cx.clip, / --rank=fixer /);
  await click("bot-rank-pm");
  draw();
  await click("bot-save");
  assert.equal(stored().bots.find((b) => b.name === "qa").rank, "pm");
});

test("Rank chips are not offered for the main bot", async () => {
  seed([]);
  const { draw } = await open({ form: "create" });
  draw();
  assert.ok(!nodes.has("bot-rank-none"));
});

test("Code bot toggle (#774): defaults on, toggles into the copied line and save, and edits back to on", async () => {
  seed([MAIN]);
  const { form, cx, draw, click } = await open({ form: "create" });
  form.inputs.name.type("writer", cx);
  draw();
  assert.ok(nodes.has("bot-code"));
  assert.equal(form.s.code, true);
  await click("bot-copy");
  assert.doesNotMatch(cx.clip, /--code/);
  await click("bot-code");
  assert.equal(form.s.code, false);
  draw();
  await click("bot-copy");
  assert.match(cx.clip, / --code=false /);
  await click("bot-save");
  const writer = stored().bots.find((b) => b.name === "writer");
  assert.equal(writer.code, false);

  const edited = await open({ form: "edit", bot: writer.id });
  edited.draw();
  assert.equal(edited.form.s.code, false);
  await edited.click("bot-code");
  assert.equal(edited.form.s.code, true);
  edited.draw();
  await edited.click("bot-copy");
  assert.match(edited.cx.clip, / --code=true /);
  await edited.click("bot-save");
  assert.equal(stored().bots.find((b) => b.id === writer.id).code, true);
});

test("toggles #848: code and planned change independently and keep their accessible labels", async () => {
  seed([MAIN]);
  const { form, draw, click } = await open({ form: "create" });
  draw();
  const label = (id) => nodes.get(id)?.calls.find(([call]) => call === "accessibility_label")?.[1];
  assert.equal(label("bot-code"), "Code bot (worker instruction in Git projects)");
  assert.equal(label("bot-planned"), "Planned for a later wave");
  assert.equal(form.s.code, true);
  assert.equal(form.s.planned, false);
  await click("bot-planned");
  assert.equal(form.s.planned, true);
  assert.equal(form.s.code, true);
  draw();
  await click("bot-code");
  assert.equal(form.s.code, false);
  assert.equal(form.s.planned, true);
  draw();
  await click("bot-planned");
  assert.equal(form.s.planned, false);
  assert.equal(form.s.code, false);
});

test("Bot settings (pick) with no bot: one New bot line that opens the Create form and closes the list", async () => {
  state.spaces = [{ id: "s1", folder: project, machine: null }];
  seed([]);
  const { draw, click } = await open({ form: "pick" });
  draw();
  assert.ok(nodes.has("pick-new"));
  assert.equal(textOf(nodes.get("bot-form-body")), "New bot");
  state.opened = [];
  await click("pick-new");
  assert.deepEqual(state.opened, [{ mod: "am-sidebar", kind: "dialog", modal: true, ...FORM_SIZE, props: { form: "create" } }]);
  assert.deepEqual(state.closed, ["o9"]);
});

test("Bot settings (pick) with bots: the bots with Edit / Start, no New bot line", async () => {
  state.spaces = [{ id: "s1", folder: project, machine: null }];
  seed([MAIN, OMP]);
  const { draw } = await open({ form: "pick" });
  draw();
  assert.ok(!nodes.has("pick-new"));
  assert.ok(nodes.has(`pick-${MAIN.id}`) && nodes.has(`edit-${OMP.id}`) && nodes.has(`start-${OMP.id}`));
});

test("Start in Bot settings with no space on the project: one space opened, waited for on the form's timer, the bot sent there", async () => {
  // Start runs the CLI with the place the sidebar picked; this scratch app home has no CLI, so
  // only that call is checked (the CLI's own start is tested in cli.test.mjs).
  state.calls = [];
  // Herdr shows the space a little after space.new.
  state.runFault = (name) => {
    if (name === "space.new") setTimeout(() => { state.spaces = [{ id: "s5", folder: project, machine: null, active: true, tabs: [{ id: "t5", active: true }] }]; }, 30);
  };
  seed([MAIN]);
  // Its space closed: the project is found as a remembered one.
  state.shared.set("am.sidebar.projects", [{ key: project, machine: null }]);
  try {
    const { cx, draw, click } = await open({ form: "pick" });
    cx.timer = { after(ms, fn) { setTimeout(() => fn(cx), ms); } };
    draw();
    await click(`start-${MAIN.id}`);
  } finally { state.runFault = null; state.shared.delete("am.sidebar.projects"); }
  assert.equal(state.runs.filter(([name]) => name === "space.new").length, 1);
  const cli = state.calls.find((c) => c.kind === "exec" && c.args.includes("start")).args;
  assert.deepEqual(cli.slice(cli.indexOf("--space"), cli.indexOf("--space") + 2), ["--space", "s5"]);
  assert.equal(cli.includes("--tab"), false, "a tab of its own: no --tab");
});

test("Attach with no bot keeps its message (the New bot line is the pick list's alone)", async () => {
  state.spaces = [{ id: "s1", folder: project, machine: null }];
  seed([]);
  const { draw } = await open({ form: "attach", terminal: "t1" });
  draw();
  assert.ok(!nodes.has("pick-new"));
  assert.match(textOf(nodes.get("bot-form-body")), /No bots on this computer yet/);
});

// ---- #239, #241, #397: the list popups keep their content's height and paint a scrollbar ----

// A popup is as tall as its content, its height only the most (Herdr's openOverlay). Live,
// a size_full scroll area measured 0 there: overflow_y_scrollbar's wrapper (#239) and #327's
// relative wrapper (#397) drew only the title and Cancel. A flex_1().min_h(0) scroll area,
// a flex item itself, keeps the items' height (#239's fix). The bar is placed beside it (#241):
// a relative flex column that shrinks to the popup holds the area, in flow, and a Scrollbar
// paired with it by name, the only absolute element. This checks how the body is built; the
// layout tests below lay it out (popup-layout.mjs).
const builds = (node) => node.calls.map(([name]) => name);
for (const [mode, extra] of [["menu", { bot: OMP.id, name: OMP.name, terminal: "t3" }], ["pick", {}], ["attach", { terminal: "t1" }]]) {
  test(`${mode} popup: the body scrolls in flow with a bar paired by name, so its items have a height (#239, #241)`, async () => {
    state.spaces = [{ id: "s1", folder: project, machine: null }];
    seed([MAIN, OMP]);
    const { draw } = await open({ form: mode, planned: false, machine: null, live: null, ...extra });
    const tree = all(draw());
    const area = nodes.get("bot-form-body");
    assert.equal(area.kind, "div", "the scroll area, not the bar, carries the id");
    const body = builds(area);
    assert.ok(body.includes("overflow_y_scroll"), "the body scrolls past the popup's height");
    assert.ok(!body.includes("overflow_y_scrollbar"), "no scrollbar wrapper: it collapses to 0 in a popup");
    for (const call of ["flex_1", "min_h"]) assert.ok(body.includes(call), `the area has ${call}: a flex item, sized by its items`);
    assert.ok(!body.includes("size_full") && !body.includes("h_full"), "no percentage height: it measures 0 in a popup (#397)");
    assert.ok(!body.includes("absolute"), "the area stays in flow, so its items' height reaches the popup");
    assert.ok(textOf(area).length > 0, "items are drawn in the body");

    const bars = tree.filter((n) => n.kind.startsWith("scrollbar"));
    assert.equal(bars.length, 1, "one bar");
    const [bar] = bars;
    assert.equal(bar.kind, "scrollbar-y", "a vertical bar");
    assert.equal(bar.arg, "bot-form-body", "keyed to the scroll area");
    assert.equal(bar.id, undefined, "the bar takes no id, so the name stays the area's");
    assert.ok(builds(bar).includes("absolute") && builds(bar).includes("inset_0"), "the bar fills its wrapper");

    const wrapper = tree.find((n) => n.kids.some((k) => k?.__node === area));
    assert.ok(wrapper.kids.some((k) => k?.__node === bar), "the bar sits beside the area");
    assert.equal(wrapper.kind, "v_flex", "a flex column, so the area's flex_1 and min_h(0) apply");
    const wraps = builds(wrapper);
    for (const call of ["relative", "flex_1", "min_h"]) assert.ok(wraps.includes(call), `the wrapper has ${call}`);
    assert.ok(!wraps.includes("absolute"), "the wrapper stays in flow");
    const form = nodes.get("bot-form");
    assert.ok(form.kids.some((k) => k?.__node === wrapper), "the wrapper is the popup's body, between title and footer");
    assert.equal(form.kids.length, 3, "title, body, footer");
  });
}

// ---- #397: laid out, the popups show every item of a short list and scroll a long one ----

// Herdr's popup sizes (main.js openBotForm): the menu 380 x 640, the Bots list and Attach 360
// high at the most; the Attach dialog from the command palette is a set 0.85 of the window.
const MAX = { menu: 640, pick: 360, attach: 360 };
const ROWS = { menu: /^menu-/, pick: /^pick-b-/, attach: /^pick-b-/ };
const rowIds = (mode) => [...nodes.keys()].filter((id) => ROWS[mode].test(id));
const many = Array.from({ length: 20 }, (_, i) => ({ ...OMP, id: `b-many${String(i).padStart(6, "0")}`, name: `bot-${i}` }));
async function laidOut(mode, extra, bots, size) {
  state.spaces = [{ id: "s1", folder: project, machine: null }];
  seed(bots);
  const { draw } = await open({ form: mode, planned: false, machine: null, live: null, ...extra });
  const root = draw();
  return layoutPopup(root, size, nodes);
}
const MODES = [["menu", { bot: OMP.id, name: OMP.name, terminal: "t3" }], ["pick", {}], ["attach", { terminal: "t1" }]];

for (const [mode, extra] of MODES) {
  test(`${mode} popup, short list: as tall as its items, and every item row has its height (#397)`, async () => {
    const pop = await laidOut(mode, extra, [MAIN, OMP], { height: MAX[mode] });
    const ids = rowIds(mode);
    assert.ok(ids.length > 0, "the list has item rows");
    const area = pop.box("bot-form-body");
    assert.ok(area.h > 0, `the scroll area has a height (got ${area.h})`);
    assert.equal(area.h, pop.contentOf("bot-form-body"), "the area is as tall as its items: nothing scrolls");
    assert.ok(pop.height < MAX[mode], `the popup is as tall as its content, under ${MAX[mode]} (got ${pop.height})`);
    for (const id of ids) assert.equal(pop.box(id).visible, 30, `${id} shows its 30 px`);
  });
}

test("pick popup, long list: held at 360, the area scrolls and the bar spans it (#241, #397)", async () => {
  const pop = await laidOut("pick", {}, [MAIN, ...many], { height: MAX.pick });
  assert.equal(pop.height, MAX.pick, "the popup stops at its height");
  const area = pop.box("bot-form-body");
  const form = nodes.get("bot-form");
  const [title, wrapper, footer] = form.kids.map((k) => pop.box(k));
  assert.equal(title.h, 42);
  assert.ok(footer.h > 0, "the footer and its Cancel stay");
  assert.equal(area.h, MAX.pick - 2 - title.h - footer.h, "the area takes what the title and footer leave");
  assert.ok(pop.contentOf("bot-form-body") > area.h, "its items are taller than it: it scrolls");
  const ids = rowIds("pick");
  assert.equal(pop.box(ids[0]).visible, 30, "the first rows show");
  assert.equal(pop.box(ids.at(-1)).visible, 0, "the last rows are scrolled to, not squeezed");
  const bar = all(form.kids[1]).find((n) => n.kind === "scrollbar-y");
  assert.deepEqual([pop.box(bar).y, pop.box(bar).h], [wrapper.y, wrapper.h], "the bar spans the area's wrapper");
  assert.equal(wrapper.h, area.h);
});

test("menu popup lower than its items: the area shrinks to it and scrolls (#397)", async () => {
  const pop = await laidOut("menu", MODES[0][1], [MAIN, OMP], { height: 150 });
  assert.equal(pop.height, 150);
  const area = pop.box("bot-form-body");
  assert.ok(area.h > 0 && area.h < pop.contentOf("bot-form-body"), `it scrolls (area ${area.h}, items ${pop.contentOf("bot-form-body")})`);
  assert.equal(pop.box("menu-configure").visible, 30, "the first item shows");
});

test("Attach as a dialog of a set height: the area fills it (#239)", async () => {
  const pop = await laidOut("attach", { terminal: "t1" }, [MAIN, OMP], { height: 700, fixed: true });
  const [title, , footer] = nodes.get("bot-form").kids.map((k) => pop.box(k));
  assert.equal(pop.box("bot-form-body").h, 700 - 2 - title.h - footer.h);
});

test("pick popup: a long bot name truncates, so Edit / Start / Restart stay in the popup (#239)", async () => {
  state.spaces = [{ id: "s1", folder: project, machine: null }];
  seed([MAIN]);
  const { draw } = await open({ form: "pick" });
  draw();
  const name = nodes.get(`pick-${MAIN.id}`).kids[0].__node;
  assert.equal(textOf(name), MAIN.name);
  assert.ok(builds(name).includes("truncate") && builds(name).includes("min_w"), "the name can shrink");
  assert.ok(!builds(name).includes("flex_none"), "a fixed-width name pushes the buttons out");
});

// The owner's case: a folder outside git (child) under a folder holding another project's
// bots.json (repos). `project` is the parent here, seeded with its main bot.
function underParent() {
  rmSync(join(project, ".git"), { recursive: true, force: true });
  const child = join(project, "child");
  mkdirSync(child);
  return child;
}
const kindWhy = (kind) => nodes.get(`bot-kind-${kind}`)?.props.tooltip ?? null;

test("a folder picked outside git is its own project, even under another project's folder: Main bot, saved there", async () => {
  seed([MAIN]);
  const parentBefore = readFileSync(join(project, ".herdr/bots.json"), "utf8");
  const child = underParent();
  state.pickFolder = child;
  const { form, cx, draw, click } = await open({ form: "create", project: undefined });
  draw();
  assert.match(textOf(nodes.get("bot-project")), /Pick a project…/);
  await click("bot-project");
  assert.equal(form.key, child);
  assert.equal(form.s.kind, "main", "a new project's first bot is its main bot");
  draw();
  assert.equal(kindWhy("main"), null, "Main bot is offered");
  assert.equal(kindWhy("member"), "A project's first bot is its main bot.");
  form.inputs.name.type("Child", cx);
  draw();
  await click("bot-save");
  assert.equal(form.error, null);
  const saved = JSON.parse(readFileSync(join(child, ".herdr/bots.json"), "utf8"));
  assert.deepEqual(saved.bots.map((b) => [b.name, b.kind]), [["Child", "main"]]);
  assert.equal(readFileSync(join(project, ".herdr/bots.json"), "utf8"), parentBefore, "the parent project is untouched");
});

test("a focused space whose folder is gone is not keyed: the form asks for the project", async () => {
  seed([MAIN]);
  state.spaces = [{ id: "s1", name: "gone", folder: join(project, "gone") }];
  state.focused = { space: "s1" };
  const { form, draw } = await open({ form: "create", project: undefined });
  draw();
  assert.ok(!form.key);
  assert.match(textOf(nodes.get("bot-project")), /Pick a project…/);
  assert.ok(!nodes.has("bot-project-parent") && !nodes.has("bot-project-own"));
});

test("a focused folder under another project's folder is offered both ways, never assumed", async () => {
  seed([MAIN]);
  const child = underParent();
  state.spaces = [{ id: "s1", name: "child", folder: child }];
  state.focused = { space: "s1" };
  const { form, draw, click } = await open({ form: "create", project: undefined });
  draw();
  assert.ok(!form.key, "the parent's project is not assumed");
  assert.equal(textOf(nodes.get("bot-project-parent")), "proj (parent project)");
  assert.equal(textOf(nodes.get("bot-project-own")), "Make child its own project");
  await click("bot-project-own");
  assert.equal(form.key, child);
  assert.equal(form.s.kind, "main");
  draw();
  assert.ok(!nodes.has("bot-project-parent"), "the choice is gone once made");
  // Picking the parent instead: a member of its team, as before.
  const again = await open({ form: "create", project: undefined });
  again.draw();
  await again.click("bot-project-parent");
  assert.equal(again.form.key, project);
  assert.equal(again.form.s.kind, "member");
});

test("a focused folder with its own bots.json, or in a git worktree, is keyed with no question", async (t) => {
  seed([MAIN]);
  const child = underParent();
  mkdirSync(join(child, ".herdr"), { recursive: true });
  writeFileSync(join(child, ".herdr/bots.json"), `${JSON.stringify({ version: 1, categories: [], bots: [] })}\n`);
  state.spaces = [{ id: "s1", name: "child", folder: child }];
  state.focused = { space: "s1" };
  const own = await open({ form: "create", project: undefined });
  own.draw();
  assert.equal(own.form.key, child);
  assert.ok(!nodes.has("bot-project-parent"));
  // A worktree of a repository keys to its main checkout (Decision 15), unchanged.
  const repo = join(root, "repo");
  const wt = join(root, "repo-wt");
  const g = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
  mkdirSync(repo);
  g("init", "-q");
  g("commit", "-q", "--allow-empty", "-m", "init");
  g("worktree", "add", "-q", "-b", "wt", wt);
  state.spaces = [{ id: "s2", name: "wt", folder: wt }];
  state.focused = { space: "s2" };
  const tree = await open({ form: "create", project: undefined });
  tree.draw();
  assert.equal(tree.form.key, repo);
  assert.ok(!nodes.has("bot-project-own"));
});

// #234, RFC 0014 Q16: a focused worktree space's edit is written in that worktree; the project
// (and what the sidebar reads) stays its main checkout.
test("from a focused worktree space, the form saves into the worktree's bots.json, never the main checkout's", async (t) => {
  const repo = join(root, "repo");
  const wt = join(root, "repo-wt");
  const g = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });
  mkdirSync(join(repo, ".herdr"), { recursive: true });
  const mainPath = join(repo, ".herdr/bots.json");
  writeFileSync(mainPath, `${JSON.stringify({ version: 1, categories: [], bots: [MAIN] }, null, 2)}\n`);
  g("init", "-q");
  g("add", ".");
  g("commit", "-q", "-m", "bots");
  g("worktree", "add", "-q", "-b", "wt", wt);
  const mainText = readFileSync(mainPath, "utf8");
  const wtPath = join(wt, ".herdr/bots.json");
  state.spaces = [{ id: "s2", name: "wt", folder: wt }];
  state.focused = { space: "s2" };
  const first = await open({ form: "create", project: undefined });
  first.draw();
  assert.equal(first.form.key, repo, "the project is the main checkout");
  assert.equal(first.form.dir, wt, "the edit is written in the worktree");
  first.form.inputs.name.type("qa", first.cx);
  first.draw();
  // Before saving: where it goes and when the sidebar shows it; no Create & start (bots start
  // from the main checkout's file, which gets the bot only once merged).
  assert.match(textOf(nodes.get("bot-where")), /^Saves in .*repo-wt\/\.herdr\/bots\.json, this worktree's file\. The sidebar reads .*repo\/\.herdr\/bots\.json, so this shows there once the worktree's change is merged and pulled\.$/);
  assert.ok(nodes.has("bot-save") && !nodes.has("bot-save-start"));
  await first.click("bot-save");
  assert.equal(first.form.error, null);
  // After: the form stays open, saying so, with only Close (the sidebar won't show qa yet).
  assert.deepEqual(state.closed, []);
  first.draw();
  assert.match(textOf(nodes.get("bot-where")), /^Saved in .*repo-wt\/\.herdr\/bots\.json, this worktree's file\./);
  assert.equal(textOf(nodes.get("bot-cancel")), "Close");
  assert.ok(!nodes.has("bot-save"), "not offered a second time");
  assert.deepEqual(JSON.parse(readFileSync(wtPath, "utf8")).bots.map((b) => b.name), ["orch", "qa"]);
  assert.equal(readFileSync(mainPath, "utf8"), mainText, "the main checkout's file is untouched");
  assert.equal(g("status", "--porcelain"), "");
  // A second form from the same space starts from the worktree's file, whose text the save checks.
  const second = await open({ form: "create", project: undefined });
  second.form.inputs.name.type("ops", second.cx);
  second.draw();
  await second.click("bot-save");
  assert.equal(second.form.error, null);
  assert.deepEqual(JSON.parse(readFileSync(wtPath, "utf8")).bots.map((b) => b.name), ["orch", "qa", "ops"]);
  assert.equal(readFileSync(mainPath, "utf8"), mainText);
  // The main checkout's own space: its file, as before.
  state.spaces = [{ id: "s3", name: "repo", folder: repo }];
  state.focused = { space: "s3" };
  const home = await open({ form: "create", project: undefined });
  assert.equal(home.form.dir, repo);
  home.form.inputs.name.type("dev", home.cx);
  home.draw();
  await home.click("bot-save");
  assert.equal(home.form.error, null);
  assert.deepEqual(JSON.parse(readFileSync(mainPath, "utf8")).bots.map((b) => b.name), ["orch", "dev"]);
  // A folder picked from the project chip decides, over the focused worktree space.
  state.spaces = [{ id: "s2", name: "wt", folder: wt }];
  state.focused = { space: "s2" };
  const picked = await open({ form: "create", project: undefined });
  state.pickFolder = repo;
  picked.draw();
  await picked.click("bot-project");
  assert.equal(picked.form.key, repo);
  assert.equal(picked.form.dir, repo, "the main checkout, picked: written there");
  picked.draw();
  assert.ok(!nodes.has("bot-where") && nodes.has("bot-save-start"), "the main checkout's form is as before");
  // Edit, from the worktree space, of a bot the main checkout has and the worktree's file hasn't:
  // the refusal names both files.
  const late = { ...MAIN, id: "b-lateaaaaaa", name: "late", kind: "member" };
  writeFileSync(mainPath, `${JSON.stringify({ version: 1, categories: [], bots: [MAIN, late] }, null, 2)}\n`);
  const edit = await open({ form: "edit", bot: late.id, project: repo });
  assert.match(edit.form.error, new RegExp(`repo-wt/\\.herdr/bots\\.json, this worktree's file, has no bot ${late.id}; .*repo/\\.herdr/bots\\.json has it`));
});

test("a worktree space whose main checkout's bots.json isn't committed: the form warns its pull would stop on it", async (t) => {
  const repo = join(root, "repo");
  const wt = join(root, "repo-wt");
  const g = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });
  mkdirSync(repo);
  g("init", "-q");
  g("commit", "-q", "--allow-empty", "-m", "init");
  g("worktree", "add", "-q", "-b", "wt", wt);
  mkdirSync(join(repo, ".herdr"), { recursive: true });
  writeFileSync(join(repo, ".herdr/bots.json"), `${JSON.stringify({ version: 1, categories: [], bots: [MAIN] }, null, 2)}\n`);
  state.spaces = [{ id: "s2", name: "wt", folder: wt }];
  state.focused = { space: "s2" };
  const f = await open({ form: "create", project: undefined });
  f.draw();
  assert.equal(f.form.dir, wt);
  assert.match(textOf(nodes.get("bot-where")), /repo\/\.herdr\/bots\.json isn't committed: commit or remove it before pulling, or the pull stops on it\.$/);
});

// #332, a follow-up to #234: a pull stops on the main checkout's committed bots.json too once
// it has local changes, not only on an untracked one; the form warns for either.
test("a worktree space whose main checkout's bots.json has local changes: the form warns its pull would stop on it", async (t) => {
  const repo = join(root, "repo");
  const wt = join(root, "repo-wt");
  const g = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });
  const mainPath = join(repo, ".herdr/bots.json");
  const committed = `${JSON.stringify({ version: 1, categories: [], bots: [MAIN] }, null, 2)}\n`;
  mkdirSync(join(repo, ".herdr"), { recursive: true });
  writeFileSync(mainPath, committed);
  g("init", "-q");
  g("add", ".");
  g("commit", "-q", "-m", "bots");
  g("worktree", "add", "-q", "-b", "wt", wt);
  // An edit made on the main checkout (allowed by design), not committed: the file is tracked.
  writeFileSync(mainPath, `${JSON.stringify({ version: 1, categories: [], bots: [MAIN, OMP] }, null, 2)}\n`);
  state.spaces = [{ id: "s2", name: "wt", folder: wt }];
  state.focused = { space: "s2" };
  const f = await open({ form: "create", project: undefined });
  f.draw();
  assert.equal(f.form.dir, wt);
  assert.match(textOf(nodes.get("bot-where")), /repo\/\.herdr\/bots\.json has local changes: commit or discard them before pulling, or the pull stops on it\.$/);
  assert.doesNotMatch(textOf(nodes.get("bot-where")), /isn't committed/);
  // Committed and clean, the main checkout's file draws no warning.
  writeFileSync(mainPath, committed);
  const clean = await open({ form: "create", project: undefined });
  clean.draw();
  assert.match(textOf(nodes.get("bot-where")), /^Saves in .*repo-wt\/\.herdr\/bots\.json, this worktree's file\./);
  assert.doesNotMatch(textOf(nodes.get("bot-where")), /isn't committed|has local changes/);
});

// #332 low: a committed bots.json deleted in the main checkout's working tree without staging
// (` D`) is said as deleted; the pull restores it with the worktree's version, it doesn't stop.
test("a worktree space whose main checkout's bots.json is deleted: the form says the pull restores it", async (t) => {
  const repo = join(root, "repo");
  const wt = join(root, "repo-wt");
  const g = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });
  const mainPath = join(repo, ".herdr/bots.json");
  mkdirSync(join(repo, ".herdr"), { recursive: true });
  writeFileSync(mainPath, `${JSON.stringify({ version: 1, categories: [], bots: [MAIN] }, null, 2)}\n`);
  g("init", "-q");
  g("add", ".");
  g("commit", "-q", "-m", "bots");
  g("worktree", "add", "-q", "-b", "wt", wt);
  g("config", "rebase.autoStash", "false");
  rmSync(mainPath);
  assert.equal(g("status", "--porcelain"), " D .herdr/bots.json\n");
  state.spaces = [{ id: "s2", name: "wt", folder: wt }];
  state.focused = { space: "s2" };
  const f = await open({ form: "create", project: undefined });
  f.draw();
  assert.equal(f.form.dir, wt);
  const where = textOf(nodes.get("bot-where"));
  assert.match(where, /^Saves in .*repo-wt\/\.herdr\/bots\.json, this worktree's file\. The sidebar reads .*repo\/\.herdr\/bots\.json, so this shows there once the worktree's change is merged and pulled\./);
  assert.match(where, /repo\/\.herdr\/bots\.json is deleted: /);
  assert.match(where, /brings it back with this worktree's version/);
  assert.doesNotMatch(where, /modified|has local changes|isn't committed|stops on it|autoStash/);
});

// #665: with rebase.autoStash=true git stashes the unstaged deletion and lets the rebase pull
// through; the stash apply then conflicts (UD), so the form says that instead of "refuses".
test("a worktree space with rebase.autoStash on: the form says the deleted bots.json is stashed", async (t) => {
  const repo = join(root, "repo");
  const wt = join(root, "repo-wt");
  const g = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });
  const mainPath = join(repo, ".herdr/bots.json");
  mkdirSync(join(repo, ".herdr"), { recursive: true });
  writeFileSync(mainPath, `${JSON.stringify({ version: 1, categories: [], bots: [MAIN] }, null, 2)}\n`);
  g("init", "-q");
  g("add", ".");
  g("commit", "-q", "-m", "bots");
  g("worktree", "add", "-q", "-b", "wt", wt);
  g("config", "pull.rebase", "true");
  g("config", "rebase.autoStash", "true");
  rmSync(mainPath);
  state.spaces = [{ id: "s2", name: "wt", folder: wt }];
  state.focused = { space: "s2" };
  const f = await open({ form: "create", project: undefined });
  f.draw();
  const where = textOf(nodes.get("bot-where"));
  assert.match(where, /repo\/\.herdr\/bots\.json is deleted: /);
  assert.match(where, /pull\.rebase=true with rebase\.autoStash=true stashes the deletion and lets the pull through/);
  assert.match(where, /then the stash apply conflicts \(UD\)/);
  assert.doesNotMatch(where, /refuses the pull until/);
});

// #665: a staged deletion ("1 D.") is not "modified": committing it turns the pull into
// modify/delete. The form says to restore and commit the file, or unstage the deletion.
test("a worktree space whose main checkout staged its bots.json deletion: the form says restore or unstage", async (t) => {
  const repo = join(root, "repo");
  const wt = join(root, "repo-wt");
  const g = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });
  const mainPath = join(repo, ".herdr/bots.json");
  mkdirSync(join(repo, ".herdr"), { recursive: true });
  writeFileSync(mainPath, `${JSON.stringify({ version: 1, categories: [], bots: [MAIN] }, null, 2)}\n`);
  g("init", "-q");
  g("add", ".");
  g("commit", "-q", "-m", "bots");
  g("worktree", "add", "-q", "-b", "wt", wt);
  g("rm", "-q", ".herdr/bots.json");
  assert.match(g("status", "--porcelain=v2"), /^1 D\. /m);
  state.spaces = [{ id: "s2", name: "wt", folder: wt }];
  state.focused = { space: "s2" };
  const f = await open({ form: "create", project: undefined });
  f.draw();
  const where = textOf(nodes.get("bot-where"));
  assert.match(where, /repo\/\.herdr\/bots\.json has a staged deletion: restore and commit the file, or unstage the deletion, before pulling/);
  assert.match(where, /committing the deletion ends the pull in a modify\/delete conflict/);
  assert.doesNotMatch(where, /has local changes|isn't committed|is deleted:/);
});

// #665: the CLI's worktreeNote and the form's word the untracked and modified cases the same;
// only the clause before the warning (and the file each shows) may differ.
test("the CLI and the form word the pull warning for an uncommitted or changed bots.json the same", async (t) => {
  const repo = join(root, "repo");
  const wt = join(root, "repo-wt");
  const home = join(root, "home");
  mkdirSync(repo);
  mkdirSync(home);
  const g = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });
  g("init", "-q");
  g("commit", "-q", "--allow-empty", "-m", "init");
  g("worktree", "add", "-q", "-b", "wt", wt);
  mkdirSync(join(repo, ".herdr"), { recursive: true });
  const mainPath = join(repo, ".herdr/bots.json");
  writeFileSync(mainPath, `${JSON.stringify({ version: 1, categories: [], bots: [MAIN] }, null, 2)}\n`);
  state.spaces = [{ id: "s2", name: "wt", folder: wt }];
  state.focused = { space: "s2" };
  const cli = (name) => spawnSync(process.execPath, [CLI, "create", "--name", name, "--agent", "claude", "--lead", MAIN.id], {
    cwd: wt, encoding: "utf8", env: { ...process.env, HOME: home, HERDR_APP_HOME: join(home, "app"), GIT_CONFIG_NOSYSTEM: "1" },
  });
  // The note is one stderr line; a long TMPDIR can add an unrelated "tidy" warning after it
  // (the machine's socket path limit), so take the note line alone and compare it word for word.
  const warningOf = (text) => {
    const line = text.split("\n").find((l) => /(?:saved|saves) in /i.test(l) && l.includes(`${repo}/.herdr/bots.json`));
    assert.ok(line, `no saved-in line for ${repo}/.herdr/bots.json in: ${text}`);
    const at = line.lastIndexOf(`${repo}/.herdr/bots.json`);
    return line.slice(at).trim();
  };
  const formWarning = async () => {
    const f = await open({ form: "create", project: undefined });
    f.draw();
    return warningOf(textOf(nodes.get("bot-where")));
  };
  // Untracked: the main checkout's file was never committed.
  const untracked = await formWarning();
  assert.match(untracked, /isn't committed: commit or remove it before pulling, or the pull stops on it\.$/);
  const first = cli("Scout");
  assert.equal(first.status, 0, first.stderr);
  assert.equal(untracked, warningOf(first.stderr));
  // A long TMPDIR adds the CLI's tidy warning after the note; the compare keeps the note alone.
  assert.equal(warningOf(`${first.stderr}\nam: tidy: hc ls --json failed: socket path too long`), untracked);
  // Modified: commit it in the main checkout, then change it there.
  g("add", ".herdr/bots.json");
  g("commit", "-q", "-m", "bots");
  writeFileSync(mainPath, `${JSON.stringify({ version: 1, categories: [], bots: [MAIN, OMP] }, null, 2)}\n`);
  const modified = await formWarning();
  assert.match(modified, /has local changes: commit or discard them before pulling, or the pull stops on it\.$/);
  const second = cli("Ranger");
  assert.equal(second.status, 0, second.stderr);
  assert.equal(modified, warningOf(second.stderr));
});

// #626: Herdr's exec may return stdout trimmed, turning v1's unstaged " D" into "D "; the
// porcelain=v2 read keeps the state field explicit, so the form still says deleted.
test("a trimmed status answer still reads the main checkout's deleted bots.json (porcelain v2)", async (t) => {
  const repo = join(root, "repo");
  const wt = join(root, "repo-wt");
  const g = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });
  const mainPath = join(repo, ".herdr/bots.json");
  mkdirSync(join(repo, ".herdr"), { recursive: true });
  writeFileSync(mainPath, `${JSON.stringify({ version: 1, categories: [], bots: [MAIN] }, null, 2)}\n`);
  g("init", "-q");
  g("add", ".");
  g("commit", "-q", "-m", "bots");
  g("worktree", "add", "-q", "-b", "wt", wt);
  rmSync(mainPath);
  assert.equal(g("status", "--porcelain"), " D .herdr/bots.json\n");
  state.trimExec = true; // what a Herdr whose exec trims stdout gives the rule
  state.spaces = [{ id: "s2", name: "wt", folder: wt }];
  state.focused = { space: "s2" };
  const f = await open({ form: "create", project: undefined });
  f.draw();
  assert.equal(f.form.dir, wt);
  const where = textOf(nodes.get("bot-where"));
  assert.match(where, /repo\/\.herdr\/bots\.json is deleted: /);
  assert.match(where, /a merge pull brings it back with this worktree's version/);
  assert.doesNotMatch(where, /has local changes|isn't committed/);
});

// #626: a committed deletion leaves porcelain empty, yet the pull ends in modify/delete; the
// form warns about that conflict too.
test("a worktree space whose main checkout has committed its bots.json deletion: the form warns the pull conflicts", async (t) => {
  const repo = join(root, "repo");
  const wt = join(root, "repo-wt");
  const g = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  mkdirSync(join(repo, ".herdr"), { recursive: true });
  writeFileSync(join(repo, ".herdr/bots.json"), `${JSON.stringify({ version: 1, categories: [], bots: [MAIN] }, null, 2)}\n`);
  g(repo, "init", "-q");
  g(repo, "add", ".");
  g(repo, "commit", "-q", "-m", "bots");
  g(repo, "worktree", "add", "-q", "-b", "wt", wt);
  // The worktree commits its change; main commits the deletion of the same file.
  writeFileSync(join(wt, ".herdr/bots.json"), `${JSON.stringify({ version: 1, categories: [], bots: [MAIN, OMP] }, null, 2)}\n`);
  g(wt, "add", ".");
  g(wt, "commit", "-q", "-m", "worktree bots");
  g(repo, "rm", "-q", ".herdr/bots.json");
  g(repo, "commit", "-q", "-m", "delete bots");
  assert.equal(g(repo, "status", "--porcelain"), "");
  state.spaces = [{ id: "s2", name: "wt", folder: wt }];
  state.focused = { space: "s2" };
  const f = await open({ form: "create", project: undefined });
  f.draw();
  assert.equal(f.form.dir, wt);
  const where = textOf(nodes.get("bot-where"));
  assert.match(where, /repo\/\.herdr\/bots\.json has a committed deletion: /);
  assert.match(where, /ends in a modify\/delete conflict/);
  assert.doesNotMatch(where, /isn't committed|has local changes|is deleted: a merge pull/);
});

// #626 F1: a main checkout that never had bots.json is not a committed deletion: the pull only
// adds the worktree's file, so the form does not warn.
test("a worktree space whose main checkout never had a bots.json: the form does not warn", async (t) => {
  const repo = join(root, "repo");
  const wt = join(root, "repo-wt");
  const g = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  mkdirSync(repo);
  g(repo, "init", "-q");
  g(repo, "commit", "-q", "--allow-empty", "-m", "init");
  g(repo, "worktree", "add", "-q", "-b", "wt", wt);
  mkdirSync(join(wt, ".herdr"), { recursive: true });
  writeFileSync(join(wt, ".herdr/bots.json"), `${JSON.stringify({ version: 1, categories: [], bots: [MAIN] }, null, 2)}\n`);
  state.spaces = [{ id: "s2", name: "wt", folder: wt }];
  state.focused = { space: "s2" };
  const f = await open({ form: "create", project: undefined });
  f.draw();
  assert.equal(f.form.dir, wt);
  assert.doesNotMatch(textOf(nodes.get("bot-where")), /committed deletion|modify\/delete|isn't committed|has local changes|is deleted/);
});

// #626 F1: main deleted bots.json before the worktree branched: the merge base has no file, so
// the form does not warn; the merge only adds the worktree's file.
test("a worktree space whose main deleted bots.json before branching: the form does not warn", async (t) => {
  const repo = join(root, "repo");
  const wt = join(root, "repo-wt");
  const g = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  mkdirSync(join(repo, ".herdr"), { recursive: true });
  writeFileSync(join(repo, ".herdr/bots.json"), `${JSON.stringify({ version: 1, categories: [], bots: [MAIN] }, null, 2)}\n`);
  g(repo, "init", "-q");
  g(repo, "add", ".");
  g(repo, "commit", "-q", "-m", "bots");
  g(repo, "rm", "-q", ".herdr/bots.json");
  g(repo, "commit", "-q", "-m", "delete bots");
  g(repo, "worktree", "add", "-q", "-b", "wt", wt);
  mkdirSync(join(wt, ".herdr"), { recursive: true });
  writeFileSync(join(wt, ".herdr/bots.json"), `${JSON.stringify({ version: 1, categories: [], bots: [MAIN, OMP] }, null, 2)}\n`);
  state.spaces = [{ id: "s2", name: "wt", folder: wt }];
  state.focused = { space: "s2" };
  const f = await open({ form: "create", project: undefined });
  f.draw();
  assert.equal(f.form.dir, wt);
  assert.doesNotMatch(textOf(nodes.get("bot-where")), /committed deletion|modify\/delete/);
});

// ---- #85: the pick and attach lists draw the sidebar's known bots at once ----

test("Bot settings (pick) draws the sidebar's known bots before discovery answers, then the fresh list", async () => {
  state.spaces = [{ id: "s1", folder: project, machine: null }];
  seed([MAIN, OMP]);
  const cx = makeCx();
  const known = [{ key: project, machine: null, file: { version: 1, categories: [], bots: [MAIN] } },
    { key: "/x/elsewhere", machine: "box", file: { version: 1, categories: [], bots: [KIMI] } }];
  const form = new BotForm({ overlay: "o9", form: "pick", known }, cx);
  index(form.render(cx)); // before cx.settle(): nothing has answered yet
  assert.doesNotMatch(textOf(nodes.get("bot-form-body")), /Finding bots/);
  assert.ok(nodes.has(`pick-${MAIN.id}`), "the known bot shows at once");
  assert.ok(nodes.has(`pick-${KIMI.id}`), "a linked machine's project shows too");
  assert.match(textOf(nodes.get("bot-form-body")), /ELSEWHERE · box/);
  assert.ok(nodes.has(`edit-${KIMI.id}`) && nodes.has(`start-${KIMI.id}`) && nodes.has(`restart-${KIMI.id}`), "Edit, Start and Restart there");
  assert.ok(nodes.has(`start-${MAIN.id}`));
  await cx.settle();
  index(form.render(cx));
  assert.ok(nodes.has(`pick-${MAIN.id}`) && nodes.has(`pick-${OMP.id}`), "the refreshed list replaces it");
});

test("Attach draws the sidebar's known bots at once too; with nothing known it still says it is looking", async () => {
  state.spaces = [{ id: "s1", folder: project, machine: null }];
  seed([MAIN]);
  const cx = makeCx();
  const form = new BotForm({ overlay: "o9", form: "attach", terminal: "t1", known: [{ key: project, machine: null, file: { bots: [MAIN] } }] }, cx);
  index(form.render(cx));
  assert.ok(nodes.has(`pick-${MAIN.id}`));
  await cx.settle();
  const bare = new BotForm({ overlay: "o9", form: "attach", terminal: "t1" }, makeCx());
  assert.match(textOf(index(bare.render(cx))), /Finding bots/, "no known list (an older caller): as before");
});

// ---- #85: a bot row's menu ----

// The CLI as runCli runs it (sh <app home>/mods/am-sidebar/bin/run.sh <cli> <args> --json): a
// stand-in that logs its arguments and prints `answer` (exits `code`).
function fakeCli(answer, code = 0) {
  const bin = join(state.appHome, "mods/am-sidebar/bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "answer.json"), JSON.stringify(answer));
  writeFileSync(join(bin, "run.sh"), `shift\nprintf '%s\\n' "$*" >> "${bin}/args.log"\ncat "${bin}/answer.json"\nexit ${code}\n`);
  return () => readFileSync(join(bin, "args.log"), "utf8").trim().split("\n");
}
const menu = (extra = {}) => open({ form: "menu", bot: OMP.id, name: OMP.name, planned: false, machine: null, terminal: null, live: null, ...extra });

test("menu, bot without a pane: Configure, Prompt, Start, Restart, Restart on…, Inspect; no Focus or Detach", async () => {
  seed([MAIN, OMP]);
  const { draw } = await menu({ terminal: "t3" });
  draw();
  for (const id of ["menu-configure", "menu-prompt", "menu-start", "menu-restart", "menu-restart-on", "menu-attach", "menu-inspect"]) assert.ok(nodes.has(id), id);
  for (const id of ["menu-focus", "menu-detach", "menu-restart-fresh"]) assert.ok(!nodes.has(id), id);
});

test("menu, running bot: Focus (its pane), Restart with a new conversation, Detach; Attach only to another pane", async () => {
  seed([MAIN, OMP]);
  const { draw } = await menu({ live: "t5", terminal: "t5" });
  draw();
  for (const id of ["menu-focus", "menu-restart", "menu-restart-fresh", "menu-restart-on", "menu-detach"]) assert.ok(nodes.has(id), id);
  assert.ok(!nodes.has("menu-start") && !nodes.has("menu-attach"));
  assert.match(textOf(nodes.get("menu-focus")), /t5/);
});

test("menu, planned bot: Configure, Prompt and Inspect, no Run item", async () => {
  seed([MAIN, OMP]);
  const { draw } = await menu({ planned: true, terminal: "t3" });
  const text = textOf(draw());
  assert.ok(nodes.has("menu-configure") && nodes.has("menu-prompt") && nodes.has("menu-inspect"));
  for (const id of ["menu-start", "menu-focus", "menu-restart", "menu-restart-on", "menu-attach", "menu-detach"]) assert.ok(!nodes.has(id), id);
  assert.doesNotMatch(text, /RUN/);
});

test("menu Configure opens the Edit form for the bot and closes the menu", async () => {
  seed([MAIN, OMP]);
  const { draw, click } = await menu();
  draw();
  state.opened = [];
  await click("menu-configure");
  assert.deepEqual(state.opened, [{ mod: "am-sidebar", kind: "dialog", modal: true, ...FORM_SIZE, props: { form: "edit", bot: OMP.id, project, machine: null } }]);
  assert.deepEqual(state.closed, ["o9"]);
});

test("menu Focus: the bot's pane by agent.focus when Herdr shows it", async () => {
  seed([MAIN, OMP]);
  state.panes = [{ terminal: "t5" }];
  try {
    const { draw, click } = await menu({ live: "t5" });
    draw();
    await click("menu-focus");
  } finally { state.panes = []; }
  assert.deepEqual(state.runs.at(-1), ["agent.focus", { terminal: "t5" }]);
  assert.deepEqual(state.closed, ["o9"]);
});

test("menu Prompt: the instructions edited in place and saved as the Edit form saves, every other field kept", async () => {
  const before = { ...OMP, instructions: "old words", worker: { agent: "codex" } };
  seed([MAIN, before]);
  const { form, cx, draw, click } = await menu();
  draw();
  await click("menu-prompt");
  draw();
  assert.ok(nodes.has("menu-prompt-text"));
  assert.equal(form.prompt.value(), "old words");
  form.prompt.type("new words\nline two", cx);
  draw();
  await click("menu-prompt-save");
  const saved = stored().bots.find((b) => b.id === OMP.id);
  assert.equal(saved.instructions, "new words\nline two");
  assert.deepEqual({ ...saved, instructions: "old words" }, before, "nothing else changed");
  assert.ok(state.runs.some(([name]) => name === "am-sidebar.refresh"));
  assert.deepEqual(state.closed, ["o9"]);
});

test("menu Prompt: over the limit is not saved, and an edit since it opened is refused as stale", async () => {
  seed([MAIN, OMP]);
  const { form, cx, draw, click } = await menu();
  draw();
  await click("menu-prompt");
  form.prompt.type("x".repeat(100_000), cx);
  draw();
  await click("menu-prompt-save");
  assert.match(form.error, /^Not saved: Instructions are/);
  assert.equal(stored().bots.find((b) => b.id === OMP.id).instructions, "");
  form.prompt.type("fine", cx);
  seed([MAIN, { ...OMP, role: "changed elsewhere" }]);
  draw();
  await click("menu-prompt-save");
  assert.match(form.error, /changed since this menu opened/);
  assert.equal(stored().bots.find((b) => b.id === OMP.id).role, "changed elsewhere", "the other edit is kept");
  assert.deepEqual(state.closed, []);
});

test("menu Detach: the CLI's detach for the bot and its project; a refusal is shown", async () => {
  seed([MAIN, OMP]);
  const args = fakeCli({ id: OMP.id, detached: ["t5"] });
  const { draw, click } = await menu({ live: "t5" });
  draw();
  await click("menu-detach");
  assert.deepEqual(args(), [`detach ${OMP.id} --project ${project} --json`]);
  assert.deepEqual(state.closed, ["o9"]);
  state.closed = [];
  fakeCli({}, 1);
  const again = await menu({ live: "t5" });
  again.draw();
  await again.click("menu-detach");
  assert.match(again.form.error, /detach failed \(exit 1\)/);
  assert.deepEqual(state.closed, []);
});

test("menu Inspect: what happened, by automagik-herdr history: timeline, transcript (a click copies it), workers, helpers", async () => {
  seed([MAIN, OMP]);
  const at = (m) => `2026-11-03T10:0${m}:00.000Z`;
  const args = fakeCli({ id: OMP.id, bot: OMP.id,
    attach: [{ v: 1, event: "attach", bot: OMP.id, terminal: "t5", by: "start", at: at(1) }],
    starts: [{ event: "start", kind: "seat", terminal: "t5", botId: OMP.id, agent: "omp", at: at(1) }],
    workers: [{ event: "start", kind: "worker", terminal: "t8", botId: OMP.id, branch: "fix-x", role: "dev", agent: "codex", at: at(3) }],
    sessions: [], transcript: "/x/sessions/one.jsonl" });
  const { cx, draw, click } = await menu({ live: "t5", helpers: [{ terminal: "t8", name: "fix-x" }] });
  draw();
  await click("menu-inspect");
  const text = textOf(draw());
  assert.deepEqual(args(), [`history ${OMP.id} --project ${project} --json`]);
  assert.match(text, /2026-11-03 10:01 attached to t5 · by start/);
  assert.match(text, /started in t5 · omp/);
  assert.match(text, /fix-x · dev · codex · t8/);
  assert.ok(nodes.has("menu-helper-t8"));
  await click("menu-transcript");
  assert.equal(cx.clip, "/x/sessions/one.jsonl");
  assert.doesNotMatch(text, /spend|cost/i, "no spend line: usagemeter has no per-bot figure");
});

test("menu Inspect: a CLI failure is shown in place, not a blank section", async () => {
  seed([MAIN, OMP]);
  const { form, draw, click } = await menu();
  draw();
  await click("menu-inspect");
  draw();
  assert.ok(form.history.error);
  assert.ok(nodes.has("menu-history"));
});

test("Attach with an empty known list says it is looking until discovery answers, then that there are none", async () => {
  state.spaces = [{ id: "s1", folder: project, machine: null }];
  seed([]);
  const cx = makeCx();
  const form = new BotForm({ overlay: "o9", form: "attach", terminal: "t1", known: [] }, cx);
  assert.match(textOf(index(form.render(cx))), /Finding bots/);
  await cx.settle();
  assert.match(textOf(index(form.render(cx))), /No bots on this computer yet/);
});

// ---- #88 review: pick while discovering, a failed prompt read, Focus as the row's click, busy labels ----

test("Bot settings (pick) with an empty known list says it is looking, never New bot alone, until discovery answers", async () => {
  state.spaces = [{ id: "s1", folder: project, machine: null }];
  seed([MAIN]);
  const cx = makeCx();
  const form = new BotForm({ overlay: "o9", form: "pick", known: [] }, cx);
  assert.match(textOf(index(form.render(cx))), /Finding bots/);
  assert.ok(!nodes.has("pick-new"), "no New bot while the bots may still be found: a duplicate risk");
  await cx.settle();
  index(form.render(cx));
  assert.ok(nodes.has(`pick-${MAIN.id}`) && !nodes.has("pick-new"));
  seed([]);
  const empty = new BotForm({ overlay: "o9", form: "pick", known: [] }, cx);
  await cx.settle();
  index(empty.render(cx));
  assert.ok(nodes.has("pick-new"), "discovery answered with no bot: New bot");
});

test("menu Prompt: a failed read is shown in the section, not Reading… forever", async () => {
  seed([MAIN]); // the menu's bot isn't in the file (removed since the row was drawn)
  const { form, draw, click } = await menu();
  draw();
  await click("menu-prompt");
  const text = textOf(draw());
  assert.ok(nodes.has("menu-prompt-error"));
  assert.match(text, /Can't read the prompt: .*has no bot b-ompaaaaaaa/);
  assert.doesNotMatch(text, /Reading…/);
  assert.equal(form.promptBase, null);
});

test("menu Focus does what the row's click does: a kept pane with no pane opens as a tab after its starter's", async () => {
  seed([MAIN, OMP]);
  state.panes = [{ terminal: "t1", tab: "tab1" }];
  state.spaces = [{ id: "s1", folder: project, machine: null, tabs: [{ id: "tab1", index: 1 }] }];
  // Herdr gives the kept terminal its pane in a new tab.
  state.runFault = (name) => { if (name === "terminal.keep") state.panes.push({ terminal: "t5", tab: "tab2" }); };
  try {
    const { draw, click } = await menu({ live: "t5", worker: { terminal: "t5", botTerminal: "t1", name: OMP.name } });
    draw();
    await click("menu-focus");
  } finally { state.runFault = null; state.panes = []; }
  const names = state.runs.map(([name]) => name);
  assert.deepEqual(names.slice(0, 3), ["space.select", "tab.select", "terminal.keep"]);
  assert.deepEqual(state.runs[2], ["terminal.keep", { terminal: "t5", place: "tab" }]);
  assert.ok(!names.includes("terminal.peek"), "not a peek");
  assert.deepEqual(state.closed, ["o9"]);
});

test("menu Focus with no pane and no starter's tab peeks, as the row's click does", async () => {
  seed([MAIN, OMP]);
  const { draw, click } = await menu({ live: "t5", worker: { terminal: "t5", botTerminal: null, name: OMP.name } });
  draw();
  await click("menu-focus");
  assert.deepEqual(state.runs.at(-1), ["terminal.peek", { terminal: "t5" }]);
  assert.deepEqual(state.closed, ["o9"]);
});

test("menu busy labels: only the running action's item changes", async () => {
  seed([MAIN, OMP]);
  fakeCli({ id: OMP.id, detached: ["t5"] });
  const { form, cx, draw } = await menu({ live: "t5", terminal: "t9" });
  form.detach(cx); // its spawn hasn't run yet: Detach is in progress
  draw();
  assert.equal(textOf(nodes.get("menu-detach")), "Detaching…");
  for (const [id, label] of [["menu-restart", "Restart"], ["menu-restart-fresh", "Restart with a new conversation"], ["menu-attach", "Attach to the focused pane (t9)"]]) {
    assert.equal(textOf(nodes.get(id)), label, id);
  }
  await cx.settle();
  const r = await menu({ terminal: "t9" });
  r.form.restart({ key: project }, { id: OMP.id }, r.cx, { fresh: true });
  r.draw();
  assert.equal(textOf(nodes.get("menu-start")), "Start");
  assert.equal(textOf(nodes.get("menu-restart")), "Restart", "a fresh restart leaves plain Restart's label");
  await r.cx.settle();
});

// ---- automagik#206: a project on a linked machine ("vm": its files are scratch paths here) ----

test("menu on a linked machine: Configure, Prompt and Run there; no What happened yet; Configure opens the form there", async () => {
  seed([MAIN, OMP]);
  const { draw, click } = await menu({ machine: "vm" });
  draw();
  for (const id of ["menu-configure", "menu-prompt", "menu-start", "menu-restart"]) assert.ok(nodes.has(id), id);
  for (const id of ["menu-attach", "menu-detach", "menu-focus", "menu-inspect"]) assert.ok(!nodes.has(id), id);
  assert.match(textOf(nodes.get("menu-remote-note")), /On vm\. What happened isn't shown/);
  assert.doesNotMatch(textOf(nodes.get("bot-form-body")), /work from that computer/);
  state.opened = [];
  await click("menu-configure");
  assert.deepEqual(state.opened[0].props, { form: "edit", bot: OMP.id, project, machine: "vm" });
});

test("menu on a linked machine, running: Focus and Detach its pane there; Attach only to a pane of that machine; actions pass --machine", async () => {
  seed([MAIN, OMP]);
  const there = await menu({ machine: "vm", live: "vm/t8", terminal: "vm/t3" });
  there.draw();
  for (const id of ["menu-focus", "menu-detach", "menu-attach", "menu-restart"]) assert.ok(nodes.has(id), id);
  assert.match(textOf(nodes.get("menu-attach")), /vm\/t3/);
  state.calls = [];
  await there.click("menu-detach");
  const cli = state.calls.find((c) => c.kind === "exec" && c.args.includes("detach"));
  assert.ok(cli && cli.args.includes("--machine") && cli.args[cli.args.indexOf("--machine") + 1] === "vm");
  // A pane of this computer (or another machine) focused: no Attach for a vm bot.
  const here = await menu({ machine: "vm", live: "vm/t8", terminal: "t3" });
  here.draw();
  assert.ok(!nodes.has("menu-attach"));
});

test("menu on a linked machine that isn't answering: its last-seen note, nothing to press", async () => {
  seed([MAIN, OMP]);
  const { draw } = await menu({ machine: "vm", stale: true });
  draw();
  assert.ok(!nodes.has("menu-configure") && !nodes.has("menu-prompt"));
  assert.match(textOf(nodes.get("menu-remote-note")), /vm isn't answering/);
});

test("menu Prompt on a linked machine: read there, saved there by hc file edit, a stale snapshot refused", async () => {
  seed([MAIN, { ...OMP, instructions: "old words" }]);
  state.hcAnswer = hcFileOps(state);
  const { form, cx, draw, click } = await menu({ machine: "vm" });
  draw();
  await click("menu-prompt");
  assert.ok(state.calls.some((c) => c.kind === "read" && c.on === "vm" && c.path === join(project, ".herdr/bots.json")));
  form.prompt.type("new words", cx);
  draw();
  await click("menu-prompt-save");
  assert.equal(form.error, null);
  assert.equal(stored().bots.find((b) => b.id === OMP.id).instructions, "new words");
  assert.ok(state.hcCalls.some((a) => a[0] === "file" && a[1] === "edit" && a.includes("vm")));
  assert.equal(state.calls.filter((c) => c.kind === "write").length, 0, "never Herdr's local write");
  // An edit there since it opened: refused as stale, named with its machine.
  const again = await menu({ machine: "vm" });
  again.draw();
  await again.click("menu-prompt");
  again.form.prompt.type("mine", again.cx);
  seed([MAIN, { ...OMP, instructions: "new words", role: "theirs" }]);
  again.draw();
  await again.click("menu-prompt-save");
  assert.match(again.form.error, /bots\.json on vm changed since this menu opened/);
  assert.equal(stored().bots.find((b) => b.id === OMP.id).role, "theirs");
});

test("Edit form on a linked machine: its agents and file there, the CLI line names --machine, saved there", async () => {
  seed([MAIN, OMP]);
  state.hcAnswer = hcFileOps(state);
  const { form, cx, draw, click } = await open({ form: "edit", bot: OMP.id, machine: "vm" });
  draw();
  assert.equal(form.machine, "vm");
  assert.match(textOf(nodes.get("bot-machine")), /on vm/);
  assert.match(textOf(nodes.get("bot-form")), /--machine=('vm'|vm) --project=/);
  form.inputs.role.type("trades", cx);
  draw();
  await click("bot-save");
  assert.equal(form.error, null);
  assert.equal(stored().bots.find((b) => b.id === OMP.id).role, "trades");
  assert.equal(state.calls.filter((c) => c.kind === "write").length, 0);
  // The machine away: the save fails with its reason, not as stale.
  state.offline.add("vm");
  const away = await open({ form: "edit", bot: OMP.id, machine: "vm" });
  away.draw();
  away.form.inputs.role.type("x", away.cx);
  away.draw();
  await away.click("bot-save");
  assert.match(away.form.error ?? "", /^Not saved: /);
  assert.doesNotMatch(away.form.error ?? "", /changed since/);
});

test("Create from a focused space on a linked machine: that machine's project, created there", async () => {
  state.spaces = [{ id: "s1", folder: project, machine: "vm", name: "hedge" }];
  state.focused = { space: "s1" };
  const { form, cx, draw, click } = await open({ form: "create", project: undefined });
  draw();
  assert.equal(form.key, project);
  assert.equal(form.machine, "vm");
  assert.ok(nodes.has("bot-save") && nodes.has("bot-save-start"));
  form.inputs.name.type("Hedge", cx);
  draw();
  await click("bot-save");
  assert.equal(form.error, null);
  assert.equal(stored().bots[0].name, "Hedge");
  assert.ok(state.calls.some((c) => c.kind === "exec" && c.command === "sh" && c.on === "vm"), "made there");
  assert.equal(state.calls.filter((c) => c.kind === "write").length, 0);
  assert.deepEqual(state.shared.get("am.sidebar.projects")?.at(-1), { key: project, machine: "vm" });
});

// #234: the menu's Prompt from a focused worktree space writes the worktree and says so.
test("menu Prompt from a worktree space: saved in the worktree, the menu stays saying where, and saves again", async () => {
  const repo = join(root, "repo");
  const wt = join(root, "repo-wt");
  const g = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });
  mkdirSync(join(repo, ".herdr"), { recursive: true });
  const mainPath = join(repo, ".herdr/bots.json");
  writeFileSync(mainPath, `${JSON.stringify({ version: 1, categories: [], bots: [MAIN, OMP] }, null, 2)}\n`);
  g("init", "-q");
  g("add", ".");
  g("commit", "-q", "-m", "bots");
  g("worktree", "add", "-q", "-b", "wt", wt);
  const mainText = readFileSync(mainPath, "utf8");
  const wtPath = join(wt, ".herdr/bots.json");
  state.spaces = [{ id: "s2", name: "wt", folder: wt }];
  state.focused = { space: "s2" };
  const { form, cx, draw, click } = await menu({ project: repo });
  draw();
  await click("menu-prompt");
  draw();
  assert.match(textOf(nodes.get("menu-prompt-where")), /^Saves in .*repo-wt\/\.herdr\/bots\.json, this worktree's file\./);
  form.prompt.type("new words", cx);
  draw();
  await click("menu-prompt-save");
  assert.equal(form.error, null);
  assert.deepEqual(state.closed, [], "the menu stays: the row reads the main checkout's file");
  draw();
  assert.match(textOf(nodes.get("menu-prompt-where")), /^Saved in .*repo-wt\/\.herdr\/bots\.json/);
  assert.equal(JSON.parse(readFileSync(wtPath, "utf8")).bots.find((b) => b.id === OMP.id).instructions, "new words");
  assert.equal(readFileSync(mainPath, "utf8"), mainText);
  form.prompt.type("newer words", cx);
  draw();
  await click("menu-prompt-save");
  assert.equal(form.error, null, "the snapshot followed the save");
  assert.equal(JSON.parse(readFileSync(wtPath, "utf8")).bots.find((b) => b.id === OMP.id).instructions, "newer words");
  assert.equal(g("status", "--porcelain"), "");
});

// #332 low: the prompt editor's where line (menu-prompt-where) warns like the form's footer.
test("menu Prompt from a worktree space whose main checkout's bots.json has local changes: the menu warns its pull would stop on it", async (t) => {
  const repo = join(root, "repo");
  const wt = join(root, "repo-wt");
  const g = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });
  const mainPath = join(repo, ".herdr/bots.json");
  mkdirSync(join(repo, ".herdr"), { recursive: true });
  writeFileSync(mainPath, `${JSON.stringify({ version: 1, categories: [], bots: [MAIN, OMP] }, null, 2)}\n`);
  g("init", "-q");
  g("add", ".");
  g("commit", "-q", "-m", "bots");
  g("worktree", "add", "-q", "-b", "wt", wt);
  // An edit made on the main checkout (allowed by design), not committed: the file is tracked.
  writeFileSync(mainPath, `${JSON.stringify({ version: 1, categories: [], bots: [MAIN, { ...OMP, role: "local edit" }] }, null, 2)}\n`);
  assert.equal(g("status", "--porcelain"), " M .herdr/bots.json\n");
  state.spaces = [{ id: "s2", name: "wt", folder: wt }];
  state.focused = { space: "s2" };
  const { draw, click } = await menu({ project: repo });
  draw();
  await click("menu-prompt");
  draw();
  const where = textOf(nodes.get("menu-prompt-where"));
  assert.match(where, /repo\/\.herdr\/bots\.json has local changes: commit or discard them before pulling, or the pull stops on it\.$/);
  assert.doesNotMatch(where, /isn't committed/);
  assert.doesNotMatch(where, /is deleted/);
});

// #230: a project's formatter may use tabs (Biome's default); the form's saves keep the file's
// indentation, and a new file is two spaces, as before.
const indented = (file, indent) => `${JSON.stringify(file, null, indent)}\n`;
const botsText = () => readFileSync(join(project, ".herdr/bots.json"), "utf8");
test("the form's Save and the menu's Prompt save keep bots.json's tabs (#230); a new file is two spaces", async () => {
  writeFileSync(join(project, ".herdr/bots.json"), indented({ version: 1, categories: [], bots: [MAIN, OMP] }, "\t"));
  const made = await open({ form: "create" });
  made.form.inputs.name.type("qa", made.cx);
  made.draw();
  await made.click("bot-save");
  assert.equal(made.form.error, null);
  assert.deepEqual(stored().bots.map((b) => b.name), ["orch", "pi-bot", "qa"]);
  assert.equal(botsText(), indented(stored(), "\t"));
  const { form, cx, draw, click } = await menu();
  draw();
  await click("menu-prompt");
  form.prompt.type("new words", cx);
  draw();
  await click("menu-prompt-save");
  assert.equal(stored().bots.find((b) => b.id === OMP.id).instructions, "new words");
  assert.equal(botsText(), indented(stored(), "\t"));
  rmSync(join(project, ".herdr/bots.json"));
  const fresh = await open({ form: "create" });
  fresh.form.inputs.name.type("orch", fresh.cx);
  fresh.draw();
  await fresh.click("bot-save");
  assert.equal(fresh.form.error, null);
  assert.equal(botsText(), indented(stored(), 2));
});

test("the menu's Prompt saved twice in a worktree keeps the main checkout's tabs, the second save not stale (#230)", async () => {
  const repo = join(root, "repo");
  const wt = join(root, "repo-wt");
  const g = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });
  mkdirSync(join(repo, ".herdr"), { recursive: true });
  writeFileSync(join(repo, ".herdr/bots.json"), indented({ version: 1, categories: [], bots: [MAIN, OMP] }, "\t"));
  g("init", "-q");
  g("add", ".");
  g("commit", "-q", "-m", "bots");
  g("worktree", "add", "-q", "-b", "wt", wt);
  rmSync(join(wt, ".herdr/bots.json"));
  const wtPath = join(wt, ".herdr/bots.json");
  state.spaces = [{ id: "s2", name: "wt", folder: wt }];
  state.focused = { space: "s2" };
  const { form, cx, draw, click } = await menu({ project: repo });
  draw();
  await click("menu-prompt");
  for (const words of ["first words", "second words"]) {
    form.prompt.type(words, cx);
    draw();
    await click("menu-prompt-save");
    assert.equal(form.error, null, words);
    const text = readFileSync(wtPath, "utf8");
    assert.equal(JSON.parse(text).bots.find((b) => b.id === OMP.id).instructions, words);
    assert.equal(text, indented(JSON.parse(text), "\t"), `${words}: tabs kept`);
  }
});

test("menu Restart queued: an info toast names the pane and who must answer", async () => {
  seed([MAIN, OMP]);
  fakeCli({ queued: true, terminal: "t5", reason: "blocked", dialog: { question: "Do you want to proceed?", who: "the owner" } });
  const { form, cx } = await menu({ live: "t5", terminal: "t5" });
  form.restart({ key: project }, OMP, cx);
  await cx.settle();
  assert.equal(state.notes.length, 1);
  assert.deepEqual(state.notes[0], { title: "Bots", level: "info", timeout: 15000,
    body: `${OMP.name}: restart queued for t5 (blocked on "Do you want to proceed?" — the owner must answer); it will restart at its next idle.` });
});

for (const machine of [null, "vm"]) for (const action of ["start", "restart", "restart-on"]) for (const failure of ["throw", "exit"]) {
  test(`menu ${action} ${machine ?? "local"} ${failure}: a failed command shows one sentence, logs its trace and clears busy`, async (t) => {
    seed([MAIN, OMP]);
    fakeCli({});
    const { form, cx } = await menu({ machine });
    const trace = "Error: launch failed\n    at launchRun (models.js:508:3)\n    at startOnMachine (cli.mjs:42:1)";
    const logs = [];
    t.mock.method(console, "error", (...words) => logs.push(words.join(" ")));
    state.timeoutProbe = "honours";
    if (failure === "throw") state.execFault = (command) => command === "env" ? new Error(trace) : null;
    else {
      const bin = join(state.appHome, "mods/am-sidebar/bin");
      writeFileSync(join(bin, "error.txt"), trace);
      writeFileSync(join(bin, "run.sh"), `cat "${bin}/error.txt" >&2\nexit 1\n`);
    }
    t.after(() => { delete state.execFault; delete state.timeoutProbe; });
    if (action === "start") form.start({ key: project, machine }, OMP, cx);
    else form.restart({ key: project, machine }, OMP, cx, action === "restart-on" ? { agent: "codex" } : {});
    await cx.settle();
    assert.equal(form.busy, false);
    assert.ok(form.error);
    assert.doesNotMatch(form.error, /\n|Error:|at launchRun|models\.js/);
    assert.match(form.error, /; (?:check|retry)/);
    assert.ok(logs.some((line) => line.includes("at launchRun")), logs.join("\n"));
    assert.equal(state.closed.length, 0);
  });
}

for (const machine of [null, "vm"]) for (const choice of ["menu-restart-helpers", "menu-end-helpers-restart"]) {
  test(`helper refusal: ${choice} is one click on ${machine ?? "local"}, keeping agent and conversation choice`, async (t) => {
    seed([MAIN, OMP]);
    const args = fakeCli({ refused: "helpers", terminal: "t5", error: "Its helpers would end." }, 1);
    state.timeoutProbe = "honours";
    t.after(() => { delete state.timeoutProbe; });
    const { form, cx, draw, click } = await menu({ machine });
    form.restart({ key: project, machine }, OMP, cx, { agent: "codex", fresh: true });
    await cx.settle();
    draw();
    assert.ok(nodes.has("menu-restart-helpers"));
    assert.ok(nodes.has("menu-end-helpers-restart"));
    assert.equal(nodes.has("menu-restart-force"), false);
    fakeCli({ terminal: "t100", replaced: "t5" });
    const press = nodes.get(choice).click;
    press(null, cx);
    assert.doesNotThrow(() => press(null, cx), "a repeated click cannot read a cleared retry choice");
    await cx.settle();
    assert.equal(args().length, 2, "one initial refusal and only one retry");
    const last = args().at(-1);
    assert.match(last, /--agent codex/);
    assert.match(last, /--force/);
    assert.match(last, /--fresh/);
    assert.equal(last.includes("--tree"), choice === "menu-restart-helpers");
    assert.equal(last.includes("--machine vm"), Boolean(machine));
    assert.equal(form.busy, false);
    assert.equal(form.error, null);
    assert.deepEqual(state.closed, ["o9"]);
  });
}

test("a repeated Restart anyway click does not read a cleared retry choice", async () => {
  seed([MAIN, OMP]);
  const args = fakeCli({ terminal: "t100" });
  const { form, cx, draw } = await menu();
  form.forceable = { project: { key: project }, bot: OMP, agent: null };
  draw();
  const press = nodes.get("menu-restart-force").click;
  press(null, cx);
  assert.doesNotThrow(() => press(null, cx));
  await cx.settle();
  assert.equal(args().length, 1);
});

// Herdr ends a mod's program at 30 s unless exec gets a timeout; a tree restart runs each helper in
// turn (26.5 s with 4 helpers, 36.8 s with 6), so the button must pass the long one (or not run).
for (const machine of [null, "vm"]) test(`menu Restart with its helpers on ${machine ?? "local"}: the CLI runs with the 600 s exec timeout`, async (t) => {
  seed([MAIN, OMP]);
  const args = fakeCli({ terminal: "t100", replaced: "t5" });
  Object.assign(state, { timeoutProbe: "honours", execTimeouts: [] });
  t.after(() => { delete state.timeoutProbe; delete state.execTimeouts; });
  const { form, cx } = await menu({ machine });
  form.restart({ key: project, machine }, OMP, cx, { tree: true, force: true });
  await cx.settle();
  assert.match(args().at(-1), /--tree/);
  assert.deepEqual(state.execTimeouts.filter((x) => x.command === "env"), [{ command: "env", timeout: 600_000 }]);
});

test("menu Restart with its helpers on a Herdr that takes no exec timeout: not run, nothing restarted, a terminal command", async (t) => {
  seed([MAIN, OMP]);
  const args = fakeCli({ terminal: "t100", replaced: "t5" });
  Object.assign(state, { timeoutProbe: "ignores", execTimeouts: [] });
  t.after(() => { delete state.timeoutProbe; delete state.execTimeouts; });
  const { form, cx } = await menu();
  form.restart({ key: project }, OMP, cx, { tree: true, force: true });
  await cx.settle();
  assert.equal(state.execTimeouts.some((x) => x.command === "env"), false, "the CLI never ran");
  assert.throws(() => args(), /ENOENT/, "no restart reached the CLI");
  assert.match(form.error, /cannot wait long enough for a restart with its helpers; restart it from a terminal/);
  assert.equal(form.busy, false);
});
