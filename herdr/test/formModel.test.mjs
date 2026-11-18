// The Create / Edit form's rules (A13, mockup/create-form.dc.html renderVals): state from a
// bot, lead options, category visibility, the model line and pin list, validation, the
// entry a save writes and the matching automagik-herdr line.
import { test } from "node:test";
import assert from "node:assert/strict";

import { UI_ICONS, uiIconFile, commandOf, countTone, editChanged, entryOf, formFrom, leadOptions, modelInfo, modelLine, modelOptions, NEW_CATEGORY, placeOf, problemOf, rowLineOf, shellQuote, thousands } from "../mods/am-sidebar/formModel.js";
import { agModelsCacheText, parseAgModelsOutput } from "../mods/am-sidebar/models.js";
const AGY_CACHE = agModelsCacheText(parseAgModelsOutput(readFileSync(new URL("./fixtures/agy/models-1.5.3.txt", import.meta.url), "utf8")), "2026-11-09T12:00:00Z");
const AGY_TEXTS = { antigravitySettings: JSON.stringify({ model: "Gemini 4 Argon (High)" }), antigravityModels: AGY_CACHE };
import { applyBotEdit, checkBots, parseBots } from "../mods/am-sidebar/model.js";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const look = (character, colour) => ({ character, colour });
const FILE = {
  version: 1,
  categories: [{ id: "shared", title: "Shared" }, { id: "platform", title: "Platform" }],
  bots: [
    { id: "b-mainaaaaaa", name: "brain-orchestrator", kind: "main", look: look("octopus", "deepseek"), role: "", instructions: "", agent: "claude" },
    { id: "b-pmaaaaaaaa", name: "pm", kind: "member", look: look("bunny", "violet"), role: "", instructions: "", agent: "claude", category: "shared" },
    { id: "b-capaaaaaaa", name: "runtime-cap", kind: "member", look: look("whale", "blue"), role: "Captain", instructions: "", agent: "codex", category: "platform" },
    { id: "b-devaaaaaaa", name: "runtime-dev", kind: "member", look: look("hex", "sky"), role: "Builder", instructions: "x", agent: "codex", lead: "b-capaaaaaaa", model: "gpt-6.1-sol" },
    { id: "b-planaaaaaa", name: "access", kind: "member", look: look("gem", "rose"), role: "Access", instructions: "", planned: { wave: 3, note: "auth v2", owner: "kim" } },
  ],
};
const KEY = "/Users/x/brain-v3";
const CODEX = { codexConfig: 'model = "gpt-6.1-sol"\n', codexModels: JSON.stringify({ models: [{ slug: "gpt-6.1-sol" }, { slug: "gpt-6.1-terra" }] }) };
const create = (over = {}) => ({ ...formFrom({ mode: "create", file: FILE, id: "b-newaaaaaaa", agent: "codex" }), name: "runtime-qa", ...over });
const edit = (id) => formFrom({ mode: "edit", bot: FILE.bots.find((b) => b.id === id) });

test("shellQuote: bare plain words, single quotes otherwise", () => {
  assert.equal(shellQuote("runtime-dev"), "runtime-dev");
  assert.equal(shellQuote("/Users/x/brain v3"), "'/Users/x/brain v3'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(shellQuote(""), "''");
  assert.equal(shellQuote("a;rm -rf /"), "'a;rm -rf /'");
});

test("thousands and the counter's tone", () => {
  assert.equal(thousands(4000), "4,000");
  assert.equal(thousands(123), "123");
  assert.equal(countTone(3600), "ok");
  assert.equal(countTone(3601), "near");
  assert.equal(countTone(4001), "over");
});

test("formFrom: create is the main bot in an empty project, else a member of the main bot", () => {
  assert.equal(formFrom({ file: { version: 1, categories: [], bots: [] }, id: "b-aaaaaaaaaa" }).kind, "main");
  assert.equal(formFrom({ file: null, id: "b-aaaaaaaaaa" }).kind, "main");
  const s = formFrom({ file: FILE, id: "b-aaaaaaaaaa", agent: "claude" });
  assert.equal(s.kind, "member");
  assert.equal(s.agent, "claude");
  assert.equal(s.lead, "");
  assert.ok(s.character && s.colour);
});

test("formFrom: edit fills every field from the stored bot", () => {
  const s = edit("b-devaaaaaaa");
  assert.deepEqual([s.name, s.kind, s.character, s.colour, s.role, s.agent, s.pin, s.lead, s.planned], ["runtime-dev", "member", "hex", "sky", "Builder", "codex", "gpt-6.1-sol", "b-capaaaaaaa", false]);
  const p = edit("b-planaaaaaa");
  assert.deepEqual([p.planned, p.wave, p.note], [true, 3, "auth v2"]);
});

test("leadOptions: main first, tree order with depth, no self, no bot under it, no planned bot", () => {
  const all = leadOptions(FILE, "b-newaaaaaaa");
  assert.deepEqual(all.map((o) => [o.name, o.depth, o.note]), [
    ["brain-orchestrator", 0, "Main bot"], ["pm", 1, "Shared"], ["runtime-cap", 1, "Captain · Platform"], ["runtime-dev", 2, "Builder"],
  ]);
  // The captain can't report to itself or to the dev under it.
  assert.deepEqual(leadOptions(FILE, "b-capaaaaaaa").map((o) => o.name), ["brain-orchestrator", "pm"]);
  assert.deepEqual(leadOptions({ version: 1, categories: [], bots: [] }, "x"), []);
});

test("placeOf: Main disabled with the reason; categories only when the main bot leads", () => {
  const s = create();
  const p = placeOf(s, FILE);
  assert.equal(p.why.main, "brain-orchestrator is this project's main bot.");
  assert.equal(p.why.member, null);
  assert.equal(p.leadId, "b-mainaaaaaa");
  assert.equal(p.byMain, true);
  const under = placeOf(create({ lead: "b-capaaaaaaa" }), FILE);
  assert.equal(under.byMain, false);
  assert.equal(under.underLead, true);
  assert.equal(under.lead.name, "runtime-cap");
  const first = placeOf(formFrom({ file: { version: 1, categories: [], bots: [] }, id: "b-aaaaaaaaaa" }), { version: 1, categories: [], bots: [] });
  assert.equal(first.why.member, "A project's first bot is its main bot.");
  assert.equal(placeOf(edit("b-mainaaaaaa"), FILE).why.member, "A bot's kind is set when it is created.");
  // A lead that may not lead (planned) shows as the main bot, flagged.
  const stale = placeOf({ ...edit("b-devaaaaaaa"), lead: "b-planaaaaaa" }, FILE);
  assert.equal(stale.leadId, "b-mainaaaaaa");
});

test("modelInfo / modelOptions: Default first, then only the agent's known models", () => {
  const info = modelInfo("codex", CODEX);
  assert.equal(info.def, "gpt-6.1-sol");
  assert.equal(info.from, "your Codex config");
  const opts = modelOptions(info);
  assert.deepEqual(opts.map((o) => o.label), ["Default (gpt-6.1-sol)", "gpt-6.1-sol", "gpt-6.1-terra"]);
  assert.equal(opts[0].id, "");
  assert.equal(opts[1].hint, "default");
  assert.deepEqual(modelOptions(modelInfo("omp", {})).map((o) => o.label), ["Default (its own)"]);
  // A stored pin the list lost stays selectable, marked.
  assert.equal(modelOptions(info, "gpt-5").at(-1).hint, "not in the list");
  assert.ok(modelInfo("claude", {}).models.includes("opus"));
});

test("Antigravity (#793): the settings label is the Default, the pin list is agy models' ids", () => {
  const info = modelInfo("antigravity", AGY_TEXTS);
  assert.equal(info.def, "Gemini 4 Argon (High)");
  assert.equal(info.from, "your Antigravity settings");
  const opts = modelOptions(info);
  assert.equal(opts[0].label, "Default (Gemini 4 Argon (High))");
  assert.equal(opts[0].hint, "your Antigravity settings");
  assert.deepEqual(opts.slice(1).map((o) => o.id), parseAgModelsOutput(readFileSync(new URL("./fixtures/agy/models-1.5.3.txt", import.meta.url), "utf8")).map((m) => m.id));
  assert.ok(opts.some((o) => o.id === "gemini-4-argon-high") && opts.some((o) => o.id === "claude-opus-5-5-high"));
  assert.ok(!opts.some((o) => o.id === "Gemini 4 Argon (High)"), "the label is never offered as a pin");
  // No cache and no settings label: the line says where the list would come from.
  const bare = modelLine({ agentName: "Antigravity", agentKey: "antigravity", pin: "", info: modelInfo("antigravity", {}) });
  assert.equal(bare.shown, "its own default");
  assert.match(bare.note, /models come from `agy models`/);
  assert.doesNotMatch(bare.note, /doesn't list its models/);
});

test("modelLine: the mockup's three notes, and a live pane's model", () => {
  const info = modelInfo("codex", CODEX);
  assert.deepEqual(modelLine({ agentName: "Codex", pin: "", info }), { shown: "gpt-6.1-sol", note: "Codex's default, from your Codex config. Read from the running pane once started.", source: "default" });
  assert.equal(modelLine({ agentName: "Codex", pin: "gpt-6.1-terra", info }).note, "Pinned. Start runs Codex with this model; the sidebar shows what the pane really runs.");
  assert.equal(modelLine({ agentName: "Oh My Pi", pin: "", info: modelInfo("omp", {}) }).shown, "its own default");
  const live = modelLine({ agentName: "Codex", pin: "", info, detected: "gpt-6.1-terra", terminal: "t12" });
  assert.equal(live.shown, "gpt-6.1-terra");
  assert.equal(live.source, "detected");
});

test("rowLineOf: as the sidebar draws a stopped or planned bot", () => {
  assert.equal(rowLineOf(create({ role: "Builder" }), "gpt-6.1-sol"), "not running · Builder · gpt-6.1-sol");
  assert.equal(rowLineOf(create({ planned: true, wave: 2 }), "x"), "planned · wave 2 · no role · x");
});

test("problemOf: the CLI's refusals", () => {
  const ctx = { key: KEY, file: FILE, info: modelInfo("codex", CODEX) };
  assert.equal(problemOf(create(), ctx), null);
  assert.equal(problemOf(create(), { ...ctx, key: null }), "Pick the project folder first.");
  assert.match(problemOf(create(), { ...ctx, loadError: "bad file" }), /bad file/);
  assert.equal(problemOf(create({ name: "  " }), ctx), "Give the bot a name.");
  assert.match(problemOf(create({ name: "PM" }), ctx), /already has that name/);
  assert.equal(problemOf(edit("b-devaaaaaaa"), ctx), null); // its own name is not a twin
  assert.match(problemOf(create({ kind: "main" }), ctx), /already has a main bot, brain-orchestrator/);
  const empty = { version: 1, categories: [], bots: [] };
  assert.match(problemOf({ ...create(), kind: "member" }, { ...ctx, file: empty }), /first bot in a project must be its main bot/);
  assert.match(problemOf(create({ instructions: "x".repeat(4001) }), ctx), /4,001 characters; the limit is 4,000/);
  assert.match(problemOf(create({ agent: "" }), ctx), /Pick what it runs on/);
  assert.equal(problemOf(create({ agent: "", planned: true, wave: 2 }), ctx), null);
  assert.match(problemOf(create({ planned: true, wave: 0 }), ctx), /needs a wave/);
  assert.match(problemOf(create({ pin: "gpt-9" }), ctx), /isn't a model codex lists/);
  assert.match(problemOf(create({ category: NEW_CATEGORY }), ctx), /new category a title/);
  assert.equal(problemOf(create({ category: NEW_CATEGORY, lead: "b-capaaaaaaa" }), ctx), null); // no category under a captain
});

test("entryOf + applyBotEdit: a create writes a valid file", () => {
  const { entry, newCategory } = entryOf(create({ role: "QA", category: "platform", pin: "gpt-6.1-terra" }), FILE);
  assert.equal(newCategory, null);
  assert.equal(entry.lead, undefined); // the main bot is stored as no lead
  assert.equal(entry.category, "platform");
  assert.equal(entry.model, "gpt-6.1-terra");
  const out = applyBotEdit(FILE, entry);
  assert.deepEqual(checkBots(out), []);
  assert.equal(out.bots.at(-1).name, "runtime-qa");
});

test("entryOf: under a captain no category; a new category is added; planned keeps its other keys", () => {
  const under = entryOf(create({ lead: "b-capaaaaaaa", category: "platform" }), FILE).entry;
  assert.equal(under.lead, "b-capaaaaaaa");
  assert.equal(under.category, undefined);
  const made = entryOf(create({ category: NEW_CATEGORY, catTitle: "Quality", catSub: "tests" }), FILE);
  assert.deepEqual(made.newCategory, { title: "Quality", sub: "tests" });
  const out = applyBotEdit(FILE, made.entry, made.newCategory);
  assert.equal(out.bots.at(-1).category, "quality");
  const plan = { ...edit("b-planaaaaaa"), wave: 4 };
  assert.deepEqual(entryOf(plan, FILE).entry.planned, { wave: 4, note: "auth v2", owner: "kim" });
  assert.equal(entryOf({ ...plan, planned: false }, FILE).entry.planned, undefined);
});

test("agyPermissions (#823): the form keeps a stored field it doesn't edit; a create writes none", () => {
  const stored = { ...FILE.bots[0], agent: "antigravity", agyPermissions: { allow: ["command(npm publish)"], deny: [] } };
  const file = { ...FILE, bots: [stored, ...FILE.bots.slice(1)] };
  const initial = formFrom({ mode: "edit", bot: stored });
  const out = applyBotEdit(file, entryOf(initial, file).entry);
  assert.deepEqual(out.bots[0].agyPermissions, stored.agyPermissions);
  assert.equal(entryOf(create(), FILE).entry.agyPermissions, undefined);
});

test("entryOf: an untouched edit writes the bot back as stored", () => {
  for (const b of FILE.bots) {
    const out = applyBotEdit(FILE, entryOf(edit(b.id), FILE).entry);
    assert.deepEqual(out.bots.find((x) => x.id === b.id), b, b.name);
  }
  // A stale lead (planned) left alone stays stored; the view keeps warning on it.
  const raw = { ...FILE, bots: FILE.bots.map((b) => (b.id === "b-devaaaaaaa" ? { ...b, lead: "b-planaaaaaa" } : b)) };
  const s = formFrom({ mode: "edit", bot: raw.bots.find((b) => b.id === "b-devaaaaaaa") });
  assert.equal(entryOf(s, raw).entry.lead, "b-planaaaaaa");
});

test("agyMode: the form defaults to auto, opens a stored mode, writes only a chosen one and its CLI line sets/clears it", () => {
  assert.equal(formFrom({ mode: "create", file: FILE, id: "b-newaaaaaaa", agent: "antigravity" }).agyMode, "auto");
  const stored = { ...FILE.bots[0], agent: "antigravity", agyMode: "plan" };
  const initial = formFrom({ mode: "edit", bot: stored });
  assert.equal(initial.agyMode, "plan");
  const file = { ...FILE, bots: [stored, ...FILE.bots.slice(1)] };
  assert.equal(entryOf(initial, file).entry.agyMode, "plan");
  assert.equal(entryOf({ ...initial, agyMode: "auto" }, file).entry.agyMode, undefined, "auto is the default, never stored");
  assert.match(commandOf(create({ agent: "antigravity", agyMode: "plan" }), { key: KEY, file: FILE }), /--agy-mode=plan/);
  assert.doesNotMatch(commandOf(create({ agent: "antigravity" }), { key: KEY, file: FILE }), /--agy-mode/);
  assert.match(commandOf({ ...initial, agyMode: "auto" }, { key: KEY, file, initial }), /--agy-mode=auto/);
  assert.match(problemOf(create({ agent: "antigravity", agyMode: "yolo" }), { key: KEY, file: FILE }),
    /Antigravity mode "yolo" isn't one of accept-edits, auto, plan\./);
  assert.equal(editChanged({ ...initial, agyMode: "auto" }, initial), true);
  assert.equal(editChanged(initial, initial), false);
});

test("code: the form defaults to true, opens a stored false and its CLI line sets/clears it", () => {
  assert.equal(formFrom({ mode: "create", file: FILE, id: "b-newaaaaaaa", agent: "claude" }).code, true);
  assert.equal(edit("b-devaaaaaaa").code, true);
  const stored = { ...FILE.bots[0], code: false };
  const initial = formFrom({ mode: "edit", bot: stored });
  assert.equal(initial.code, false);
  const file = { ...FILE, bots: [stored, ...FILE.bots.slice(1)] };
  assert.equal(entryOf(initial, file).entry.code, false);
  assert.equal(entryOf({ ...initial, code: true }, file).entry.code, true);
  assert.equal(applyBotEdit(file, entryOf({ ...initial, code: true }, file).entry).bots[0].code, true);
  assert.match(commandOf(create({ code: false }), { key: KEY, file: FILE }), /--code=false/);
  assert.doesNotMatch(commandOf(create(), { key: KEY, file: FILE }), /--code/);
  assert.match(commandOf({ ...initial, code: true }, { key: KEY, file, initial }), /--code=true/);
  assert.match(commandOf({ ...edit("b-devaaaaaaa"), code: false }, { key: KEY, file: FILE, initial: edit("b-devaaaaaaa") }), /--code=false/);
  assert.equal(editChanged({ ...initial, code: true }, initial), true);
  assert.equal(editChanged(initial, initial), false);
});

test("code #848: unrelated sidebar edits preserve explicit true, false and an absent default", () => {
  for (const code of [true, false, undefined]) {
    const stored = { ...FILE.bots[0], ...(code === undefined ? {} : { code }) };
    const file = { ...FILE, bots: [stored, ...FILE.bots.slice(1)] };
    const initial = formFrom({ mode: "edit", bot: stored });
    const entry = entryOf({ ...initial, role: "New role" }, file).entry;
    const saved = applyBotEdit(file, entry).bots[0];
    assert.equal(saved.code, code);
    assert.equal(Object.hasOwn(saved, "code"), code !== undefined);
    assert.equal(saved.role, "New role");
  }
});

test("shellQuote: a leading = is quoted (zsh expands a bare =word)", () => {
  assert.equal(shellQuote("=ls"), "'=ls'");
  assert.equal(shellQuote("a=b"), "a=b");
});

test("formFrom: a stored wave that isn't a positive whole number reads as 1, never into the line", () => {
  const evil = { ...FILE.bots[4], planned: { wave: "1 && touch /tmp/x #" } };
  const s = formFrom({ mode: "edit", bot: evil });
  assert.equal(s.wave, 1);
  assert.doesNotMatch(commandOf({ ...s, wave: s.wave + 1 }, { key: KEY, file: FILE, initial: s }), /touch/);
  // Non-text stored fields read as empty.
  const odd = formFrom({ mode: "edit", bot: { ...FILE.bots[1], role: 5, name: ["x"], look: { character: 1 } } });
  assert.deepEqual([odd.role, odd.name, typeof odd.character], ["", "", "string"]);
});

test("commandOf create: the mockup's flag order, every value as --option=<quoted>, with --project", () => {
  const s = create({ name: "runtime-qa", role: "Test runner", lead: "b-capaaaaaaa", character: "hex", colour: "sky", pin: "gpt-6.1-terra", instructions: "Run the tests.\nReport." });
  assert.equal(commandOf(s, { key: KEY, file: FILE }),
    "am create --name=runtime-qa --agent=codex --role='Test runner' --lead=b-capaaaaaaa --character=hex --colour=sky --model=gpt-6.1-terra --project=/Users/x/brain-v3 --instructions='Run the tests.\nReport.'");
  const byMain = create({ category: "platform", character: "hex", colour: "sky", planned: true, wave: 2, note: "after auth" });
  assert.equal(commandOf(byMain, { key: KEY, file: FILE }),
    "am create --name=runtime-qa --agent=codex --lead=b-mainaaaaaa --category=platform --character=hex --colour=sky --planned-wave=2 --planned-note='after auth' --project=/Users/x/brain-v3");
  const main = formFrom({ file: { version: 1, categories: [], bots: [] }, id: "b-aaaaaaaaaa", agent: "claude" });
  assert.match(commandOf({ ...main, name: "" }, { key: KEY, file: { version: 1, categories: [], bots: [] } }), /^am create --name=new-bot --kind=main --agent=claude --character=/);
});

test("commandOf create: a new category is added first, with the id the create line names", () => {
  const s = create({ category: NEW_CATEGORY, catTitle: "Quality gate", catSub: "tests" });
  assert.match(commandOf(s, { key: KEY, file: FILE }),
    /^am category add --id=quality-gate --title='Quality gate' --sub=tests --project=\/Users\/x\/brain-v3 && am create .* --category=quality-gate /);
});

test("commandOf edit: only what changed, with the CLI's clearing spellings", () => {
  const initial = edit("b-devaaaaaaa");
  assert.equal(commandOf(initial, { key: KEY, file: FILE, initial }), "am edit b-devaaaaaaa --project=/Users/x/brain-v3");
  assert.equal(editChanged(initial, initial), false);
  const s = { ...initial, role: "Lead builder", pin: "", lead: "b-mainaaaaaa", category: "platform" };
  assert.equal(commandOf(s, { key: KEY, file: FILE, initial }),
    "am edit b-devaaaaaaa --role='Lead builder' --lead=b-mainaaaaaa --category=platform --no-model --project=/Users/x/brain-v3");
  assert.equal(editChanged(s, initial), true);
  const plan = edit("b-planaaaaaa");
  assert.equal(commandOf({ ...plan, planned: false, agent: "claude" }, { key: KEY, file: FILE, initial: plan }),
    "am edit b-planaaaaaa --agent=claude --unplanned --project=/Users/x/brain-v3");
  assert.equal(commandOf({ ...plan, note: "" }, { key: KEY, file: FILE, initial: plan }),
    "am edit b-planaaaaaa --planned-wave=3 --planned-note='' --project=/Users/x/brain-v3");
  const pm = edit("b-pmaaaaaaaa");
  assert.equal(commandOf({ ...pm, category: "" }, { key: KEY, file: FILE, initial: pm }),
    "am edit b-pmaaaaaaaa --no-category --project=/Users/x/brain-v3");
});

// ---- A16: rank ----

test("rank: members pick one or none; an edit keeps the stored one; the main bot's entry leaves it alone", () => {
  assert.equal(create().rank, "");
  const ranked = { ...FILE, bots: FILE.bots.map((b) => (b.id === "b-devaaaaaaa" ? { ...b, rank: "dev" } : b.id === "b-mainaaaaaa" ? { ...b, rank: "owner" } : b)) };
  const dev = formFrom({ mode: "edit", bot: ranked.bots.find((b) => b.id === "b-devaaaaaaa") });
  assert.equal(dev.rank, "dev");
  // Untouched: written back as stored; changed and cleared.
  const out = (state) => applyBotEdit(ranked, entryOf(state, ranked).entry).bots.find((b) => b.id === state.id);
  assert.equal(out(dev).rank, "dev");
  assert.equal(out({ ...dev, rank: "reviewer" }).rank, "reviewer");
  assert.equal("rank" in out({ ...dev, rank: "" }), false);
  // The main bot: no rank row, its stored rank kept.
  const main = formFrom({ mode: "edit", bot: ranked.bots.find((b) => b.id === "b-mainaaaaaa") });
  assert.equal("rank" in entryOf(main, ranked).entry, false);
  assert.equal(out(main).rank, "owner");
  assert.deepEqual(checkBots(applyBotEdit(FILE, entryOf(create({ rank: "tester" }), FILE).entry)), []);
});

test("rank: a stored rank outside the set is a problem until changed; the line names --rank, --rank= clears", () => {
  const ctx = { key: KEY, file: FILE, info: modelInfo("codex", CODEX) };
  assert.match(problemOf(create({ rank: "main" }), ctx), /"main" isn't a rank; pick one of captain, dev, tester, reviewer, fixer, integrator, pm, owner, or none/);
  assert.equal(problemOf(create({ rank: "pm" }), ctx), null);
  assert.equal(problemOf(create({ rank: "fixer" }), ctx), null);
  assert.match(commandOf(create({ rank: "fixer" }), { key: KEY, file: FILE }), / --rank=fixer /);
  assert.equal(problemOf(create({ kind: "main", rank: "main" }), { ...ctx, file: { ...FILE, bots: FILE.bots.filter((b) => b.kind !== "main") } }), null);
  assert.match(commandOf(create({ rank: "tester" }), { key: KEY, file: FILE }), / --rank=tester /);
  assert.doesNotMatch(commandOf(create(), { key: KEY, file: FILE }), /--rank/);
  const initial = { ...edit("b-devaaaaaaa"), rank: "dev" };
  assert.equal(commandOf(initial, { key: KEY, file: FILE, initial }), "am edit b-devaaaaaaa --project=/Users/x/brain-v3");
  assert.equal(commandOf({ ...initial, rank: "pm" }, { key: KEY, file: FILE, initial }), "am edit b-devaaaaaaa --rank=pm --project=/Users/x/brain-v3");
  assert.equal(commandOf({ ...initial, rank: "" }, { key: KEY, file: FILE, initial }), "am edit b-devaaaaaaa --rank= --project=/Users/x/brain-v3");
  assert.equal(editChanged({ ...initial, rank: "pm" }, initial), true);
});

// ---- the generated lines run through a real shell and the real CLI ----

const CLI = new URL("../mods/am-sidebar/bin/automagik-herdr.mjs", import.meta.url).pathname;
const SHELLS = ["/bin/sh", "/bin/zsh"].filter((sh) => existsSync(sh));
// Values a shell or the CLI's strict parser could take for something else.
const NASTY = {
  name: "-x",
  role: "=ls",
  instructions: "- a\n- b\nit's \"quoted\" $(id) `id` $HOME \\ --flag",
  note: "-waits $(touch HACKED) `touch HACKED`",
  catTitle: "-Quality \"gate\"",
  catSub: "=ls $(id)",
};

function scratch(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hb-form-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "proj"), bin = join(root, "bin"), home = join(root, "home"), app = join(root, "app");
  for (const d of [project, bin, home, app, join(project, ".herdr")]) mkdirSync(d, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: project });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "start"], { cwd: project });
  // `am` on PATH runs this CLI; the copied line names it so.
  writeFileSync(join(bin, "am"), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
  chmodSync(join(bin, "am"), 0o755);
  const file = { version: 1, categories: [{ id: "platform", title: "Platform" }], bots: [
    { id: "b-mainaaaaaa", name: "orch", kind: "main", look: look("octopus", "deepseek"), role: "", instructions: "", agent: "claude" },
    { id: "b-capaaaaaaa", name: "cap", kind: "member", look: look("whale", "blue"), role: "Captain", instructions: "", agent: "claude", category: "platform" },
  ] };
  writeFileSync(join(project, ".herdr/bots.json"), `${JSON.stringify(file, null, 2)}\n`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, HERDR_APP_HOME: app };
  delete env.HC_TERMINAL_ID;
  // Run from the scratch root, not the project: --project must name it.
  const run = (sh, line) => spawnSync(sh, ["-c", line], { cwd: root, env, encoding: "utf8" });
  const read = () => JSON.parse(readFileSync(join(project, ".herdr/bots.json"), "utf8"));
  return { root, project, file, run, read };
}

for (const sh of SHELLS) {
  test(`the copied create and edit lines do what the form saves, through ${sh} and the CLI's parser`, (t) => {
    const w = scratch(t);
    const s = { ...formFrom({ mode: "create", file: w.file, id: "b-newaaaaaaa", agent: "claude" }),
      ...NASTY, character: "hex", colour: "sky", category: NEW_CATEGORY, planned: true, wave: 2, rank: "reviewer" };
    assert.equal(problemOf(s, { key: w.project, file: w.file, info: modelInfo("claude", {}) }), null);
    const line = commandOf(s, { key: w.project, file: w.file });
    const r = w.run(sh, line);
    assert.equal(r.status, 0, `${line}\n${r.stderr}`);
    assert.equal(existsSync(join(w.root, "HACKED")), false);
    const out = w.read();
    const made = out.bots.find((b) => b.name === NASTY.name);
    assert.ok(made, r.stdout);
    assert.deepEqual([made.role, made.instructions, made.planned, made.look, made.rank], [NASTY.role, NASTY.instructions, { wave: 2, note: NASTY.note }, look("hex", "sky"), "reviewer"]);
    const cat = out.categories.find((c) => c.id === made.category);
    assert.deepEqual([cat?.title, cat?.sub], [NASTY.catTitle, NASTY.catSub]);
    // What the form itself would have written for the same state.
    const { entry, newCategory } = entryOf({ ...s, id: made.id }, w.file);
    assert.deepEqual(made, applyBotEdit(w.file, entry, newCategory).bots.find((b) => b.id === made.id));

    // Edit: change the text fields to other nasty values, clear planned, move under the captain.
    const file2 = parseBots(readFileSync(join(w.project, ".herdr/bots.json"), "utf8")).file;
    const initial = formFrom({ mode: "edit", bot: made });
    assert.equal(initial.rank, "reviewer");
    const e = { ...initial, name: "--help", role: "-r", instructions: "-- x\n= y", planned: false, lead: "b-capaaaaaaa", rank: "" };
    const edited = commandOf(e, { key: w.project, file: file2, initial });
    const r2 = w.run(sh, edited);
    assert.equal(r2.status, 0, `${edited}\n${r2.stderr}`);
    const after = w.read().bots.find((b) => b.id === made.id);
    assert.deepEqual([after.name, after.role, after.instructions, after.planned, after.lead, after.category, after.rank],
      ["--help", "-r", "-- x\n= y", undefined, "b-capaaaaaaa", undefined, undefined]);
    // What the form itself would have written for the same edit.
    assert.deepEqual(after, applyBotEdit(file2, entryOf(e, file2).entry).bots.find((b) => b.id === made.id));
  });
}

test("UI_ICONS: the mockup's six icons as stroke-only SVG documents (tinted by svg())", () => {
  assert.deepEqual(Object.keys(UI_ICONS).sort(), ["chevron", "clock", "close", "copy", "folder", "shuffle"]);
  for (const [name, text] of Object.entries(UI_ICONS)) {
    assert.match(text, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 24 24"[^>]* fill="none" stroke="currentColor"/, name);
    assert.match(text, /<\/svg>$/, name);
    assert.doesNotMatch(text, /<script|url\(/, name);
  }
  assert.equal(uiIconFile("close"), "ui-close.svg");
});

test("formFrom: a stored gemini bot opens on antigravity with its gemini-era pin dropped; others keep theirs", () => {
  const base = { id: "b-gemaaaaaaa", name: "g", kind: "member", look: { character: "star", colour: "blue" } };
  const gem = formFrom({ mode: "edit", bot: { ...base, agent: "gemini", model: "gemini-2.5-pro" } });
  assert.equal(gem.agent, "antigravity");
  assert.equal(gem.pin, "");
  const kept = formFrom({ mode: "edit", bot: { ...base, agent: "claude", model: "opus" } });
  assert.deepEqual([kept.agent, kept.pin], ["claude", "opus"]);
});
