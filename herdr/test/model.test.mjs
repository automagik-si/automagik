import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  BOT_LABEL, MAX_INSTRUCTIONS, CHARACTERS, COLOURS, projectKeyOf, projectOf, paneKeyOf, parseBots, checkBots, effectiveLead, newBotId, defaultLook,
  listedProjects, withListedProject, MAX_LISTED_PROJECTS,
} from "../mods/am-sidebar/model.js";
import { scratchRoot } from "./scratch-project.mjs";

const run = promisify(execFile);
const roots = new Set();
// What bots.js hands projectKeyOf, over Node instead of Herdr's exec.
const git = async (args, cwd) => {
  try { return (await run("git", args, { cwd })).stdout; } catch { return null; }
};
const exists = async (path) => [...roots].some((r) => path === r || path.startsWith(`${r}/`)) && existsSync(path);
const noGit = async () => null;
// No git installed: the adapter answers null, as bots.js does for a program that can't start.
const missingGit = async (args, cwd) => {
  try { return (await run("no-such-git-here", args, { cwd })).stdout; } catch { return null; }
};
const unreachable = async () => { throw new Error("machine unreachable"); };

// A scratch repository with one commit, a worktree and a subfolder, under $TMPDIR
// (realpath: on macOS /var/folders is /private/var/folders, and git answers with the real one).
function scratch(t) {
  const root = scratchRoot(t, "automagik-herdr-");
  roots.add(root);
  t.after(() => roots.delete(root));
  return root;
}
async function repo(t) {
  const root = scratch(t);
  const main = join(root, "proj");
  mkdirSync(join(main, "src", "deep"), { recursive: true });
  await run("git", ["init", "-q", main]);
  await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: main });
  const tree = join(root, "proj-wt");
  await run("git", ["worktree", "add", "-q", "-b", "wt", tree], { cwd: main });
  return { root, main, tree };
}

test("project key: a main checkout is its own project", async (t) => {
  const { main } = await repo(t);
  assert.equal(await projectKeyOf(main, git, exists), main);
  assert.equal(await projectKeyOf(`${main}/`, git, exists), main);
});

test("project key: a worktree belongs to its main checkout", async (t) => {
  const { main, tree } = await repo(t);
  assert.equal(await projectKeyOf(tree, git, exists), main);
});

test("project key: a subfolder belongs to its main checkout", async (t) => {
  const { main } = await repo(t);
  assert.equal(await projectKeyOf(join(main, "src", "deep"), git, exists), main);
});

test("project key: a worktree's committed bots.json is not its project", async (t) => {
  const { main, tree } = await repo(t);
  mkdirSync(join(tree, ".herdr"), { recursive: true });
  writeFileSync(join(tree, ".herdr", "bots.json"), "{}");
  assert.equal(await projectKeyOf(tree, git, exists), main);
});

test("project key: outside git, the nearest folder holding .herdr/bots.json", async (t) => {
  const root = scratch(t);
  const deep = join(root, "a", "b", "c");
  mkdirSync(deep, { recursive: true });
  mkdirSync(join(root, "a", ".herdr"), { recursive: true });
  writeFileSync(join(root, "a", ".herdr", "bots.json"), "{}");
  assert.equal(await projectKeyOf(deep, git, exists), join(root, "a"));
  assert.equal(await projectKeyOf(join(root, "a"), git, exists), join(root, "a"));
});

test("project key: outside git with no bots.json above, the folder itself", async (t) => {
  const root = scratch(t);
  const deep = join(root, "x", "y");
  mkdirSync(deep, { recursive: true });
  assert.equal(await projectKeyOf(deep, git, exists), deep);
});

test("project key: a picked folder outside git under another project's folder is its own (own), passing by it is not (key)", async (t) => {
  // The owner's case: ~/repos/child, no git, under ~/repos holding another project's bots.json.
  const root = scratch(t);
  const child = join(root, "repos", "child");
  mkdirSync(child, { recursive: true });
  mkdirSync(join(root, "repos", ".herdr"), { recursive: true });
  writeFileSync(join(root, "repos", ".herdr", "bots.json"), "{}");
  assert.deepEqual(await projectOf(child, git, exists), { key: join(root, "repos"), own: child });
  assert.equal(await projectKeyOf(child, git, exists), join(root, "repos"));
  // Once child has its own file, the walk-up finds it first.
  mkdirSync(join(child, ".herdr"), { recursive: true });
  writeFileSync(join(child, ".herdr", "bots.json"), "{}");
  assert.deepEqual(await projectOf(child, git, exists), { key: child, own: child });
});

test("project key: in git, a picked worktree or subfolder is still its main checkout", async (t) => {
  const { main, tree } = await repo(t);
  assert.deepEqual(await projectOf(tree, git, exists), { key: main, own: main });
  assert.deepEqual(await projectOf(join(main, "src", "deep"), git, exists), { key: main, own: main });
});

test("project key: git missing or failing reads as outside git", async (t) => {
  const { main } = await repo(t);
  const sub = join(main, "src", "deep");
  // Inside a real repository, but git can't answer: the folder rule applies.
  assert.equal(await projectKeyOf(sub, noGit, exists), sub);
  assert.equal(await projectKeyOf(sub, missingGit, exists), sub);
  mkdirSync(join(main, ".herdr"), { recursive: true });
  writeFileSync(join(main, ".herdr", "bots.json"), "{}");
  assert.equal(await projectKeyOf(sub, missingGit, exists), main);
});

test("project key: a machine that can't be asked rejects, never guessing outside git", async () => {
  await assert.rejects(projectKeyOf("/srv/app-wt", unreachable, async () => false), /unreachable/);
  await assert.rejects(projectKeyOf("/srv/app-wt", noGit, unreachable), /unreachable/);
});

test("project key: injected git and exists, as on a remote machine", async () => {
  const calls = [];
  const fakeGit = async (args, cwd) => { calls.push([args.join(" "), cwd]); return "/srv/app/.git\n"; };
  assert.equal(await projectKeyOf("/srv/app-wt/lib", fakeGit, async () => false), "/srv/app");
  assert.deepEqual(calls, [["rev-parse --path-format=absolute --git-common-dir", "/srv/app-wt/lib"]]);
  const seen = [];
  const fakeExists = async (p) => { seen.push(p); return p === "/srv/.herdr/bots.json"; };
  assert.equal(await projectKeyOf("/srv/x/y", noGit, fakeExists), "/srv");
  assert.deepEqual(seen, ["/srv/x/y/.herdr/bots.json", "/srv/x/.herdr/bots.json", "/srv/.herdr/bots.json"]);
  assert.equal(await projectKeyOf("/nowhere/z", noGit, async () => false), "/nowhere/z");
});

// A valid file to vary.
const ID = { main: "b-aaaaaaaaaa", cap: "b-bbbbbbbbbb", dev: "b-cccccccccc", tst: "b-dddddddddd", plan: "b-eeeeeeeeee" };
const bot = (id, kind, extra = {}) => ({
  id, name: id.slice(2, 5), kind, look: { character: "star", colour: "blue" }, role: "r", instructions: "i", agent: "claude", ...extra,
});
function sample(edit = (f) => f) {
  return edit({
    version: 1,
    categories: [{ id: "eng", title: "Engineering", sub: "build it" }],
    bots: [
      bot(ID.main, "main"),
      bot(ID.cap, "member", { category: "eng" }),
      bot(ID.dev, "member", { lead: ID.cap }),
      bot(ID.tst, "member", { lead: ID.cap, model: "GPT-6.1 Sol" }),
      bot(ID.plan, "member", { agent: undefined, planned: { wave: 3, note: "waits for auth v2" } }),
    ],
  });
}
const text = (f) => JSON.stringify(f);

test("code is an optional boolean; invalid values warn; unrelated form edits keep the opt-out", () => {
  assert.deepEqual(checkBots(sample()), []);
  for (const code of [true, false]) {
    const file = sample((f) => { f.bots[0].code = code; return f; });
    assert.deepEqual(checkBots(file), []);
    assert.equal(parseBots(text(file)).file.bots[0].code, code);
    const { code: ignored, ...entry } = file.bots[0];
    assert.equal(applyBotEdit(file, { ...entry, role: "Updated" }).bots[0].code, code);
    assert.equal("code" in applyBotEdit(file, { ...entry, code: undefined }).bots[0], false);
  }
  for (const code of ["false", 0, null, {}]) {
    const file = sample((f) => { f.bots[0].code = code; return f; });
    assert.ok(checkBots(file).some((line) => /code is not a boolean/.test(line)));
    const parsed = parseBots(text(file));
    assert.equal(parsed.file.bots[0].code, undefined);
    assert.ok(parsed.warnings.some((line) => /code is not a boolean/.test(line)));
    assert.deepEqual(parsed.raw.bots[0].code, code);
  }
});

test("hcProxy is an optional boolean, malformed settings warn and never opt in", () => {
  for (const value of [true, false]) {
    const file = sample((f) => { f.bots[0].hcProxy = value; return f; });
    assert.deepEqual(checkBots(file), []);
    assert.equal(parseBots(text(file)).file.bots[0].hcProxy, value);
  }
  for (const value of ["true", 1, {}, null]) {
    const file = sample((f) => { f.bots[0].hcProxy = value; return f; });
    assert.ok(checkBots(file).some((line) => /hcProxy is not a boolean/.test(line)));
    const parsed = parseBots(text(file));
    assert.equal(parsed.file.bots[0].hcProxy, undefined);
    assert.ok(parsed.warnings.some((line) => /hcProxy is not a boolean/.test(line)));
    assert.deepEqual(parsed.raw.bots[0].hcProxy, value);
  }
});

test("schema: a valid file parses with no warnings and checks clean", () => {
  const { file, warnings } = parseBots(text(sample()));
  assert.deepEqual(warnings, []);
  assert.equal(file.bots.length, 5);
  assert.equal(file.categories[0].sub, "build it");
  assert.deepEqual(file.bots[4].planned, { wave: 3, note: "waits for auth v2" });
  assert.deepEqual(checkBots(file), []);
});

test("schema: a gemini bot's gemini-era model pins are dropped on read (seat and worker), raw keeps them", () => {
  const source = sample((f) => {
    f.bots[1].agent = "gemini";
    f.bots[1].model = "gemini-2.5-pro";
    f.bots[1].worker = { model: "gemini-2.5-flash", effort: "high" };
    f.bots[2].worker = { agent: "gemini", model: "gemini-2.5-pro" };
    f.bots[3].agent = "gemini";
    f.bots[3].worker = { agent: "codex", model: "gpt-6.1-sol" };
    return f;
  });
  const { file, warnings, raw } = parseBots(text(source));
  const [cap, dev, tst] = [file.bots[1], file.bots[2], file.bots[3]];
  assert.equal(cap.agent, "antigravity");
  assert.equal(cap.model, undefined, "the seat's gemini pin is gone");
  assert.deepEqual(cap.worker, { effort: "high" }, "its workers ran gemini too: their model is gone, effort kept");
  assert.equal(dev.agent, "claude");
  assert.deepEqual(dev.worker, { agent: "antigravity" });
  assert.equal(tst.model, undefined, "its seat pin was made for gemini");
  assert.deepEqual(tst.worker, { agent: "codex", model: "gpt-6.1-sol" }, "a codex worker keeps its codex model");
  assert.deepEqual(warnings, [
    `${ID.cap}: agent gemini is retired; it runs on antigravity (model pin gemini-2.5-pro and worker model gemini-2.5-flash dropped)`,
    `${ID.dev}: agent gemini is retired; it runs on antigravity (worker model gemini-2.5-pro dropped)`,
    `${ID.tst}: agent gemini is retired; it runs on antigravity (model pin GPT-6.1 Sol dropped)`,
  ]);
  assert.equal(raw.bots[1].model, "gemini-2.5-pro");
  assert.equal(raw.bots[2].worker.model, "gemini-2.5-pro");
});

test("schema: raw is the file as read, entries left out of file included, and a separate copy", () => {
  const source = sample((f) => { f.bots.push({ name: "nobody", kind: "member" }); f.categories.push({ title: "no id" }); return f; });
  const { file, raw } = parseBots(text(source));
  assert.equal(file.bots.length, 5);
  assert.deepEqual(raw, JSON.parse(text(source)));
  raw.bots[0].look.colour = "red";
  assert.equal(file.bots[0].look.colour, "blue");
});

test("schema: not a version-1 file throws", () => {
  assert.throws(() => parseBots("not json"));
  assert.throws(() => parseBots(text({ version: 2, bots: [] })), /version/);
  assert.throws(() => parseBots(text({ version: 1 })), /bots/);
});

test("schema: instructions over 4,000 characters warn and fail the write check", () => {
  const long = "x".repeat(MAX_INSTRUCTIONS + 1);
  const { file, warnings } = parseBots(text(sample((f) => { f.bots[1].instructions = long; return f; })));
  assert.equal(file.bots.length, 5);
  assert.ok(warnings.some((w) => w.startsWith(ID.cap) && /4000/.test(w)), warnings.join("\n"));
  assert.ok(checkBots(file).some((e) => /4000/.test(e)));
  const ok = parseBots(text(sample((f) => { f.bots[1].instructions = "x".repeat(MAX_INSTRUCTIONS); return f; })));
  assert.deepEqual(ok.warnings, []);
});

test("schema: an unknown kind is left out with a warning", () => {
  const { file, warnings } = parseBots(text(sample((f) => { f.bots[3].kind = "helper"; return f; })));
  assert.equal(file.bots.some((b) => b.id === ID.tst), false);
  assert.ok(warnings.some((w) => w.includes(ID.tst) && /unknown kind/.test(w)));
  assert.ok(checkBots({ ...file, bots: [...file.bots, bot("b-ffffffffff", "helper")] }).some((e) => /unknown kind/.test(e)));
});

test("schema: two main bots warn, the first counts, the write check refuses", () => {
  const { file, warnings } = parseBots(text(sample((f) => { f.bots.push(bot("b-ffffffffff", "main")); return f; })));
  assert.ok(warnings.some((w) => /2 main bots/.test(w) && w.includes(ID.main)));
  assert.equal(effectiveLead(file, ID.cap).lead, ID.main);
  assert.ok(checkBots(file).some((e) => /exactly one/.test(e)));
});

test("schema: no main bot warns", () => {
  const { warnings } = parseBots(text(sample((f) => { f.bots.shift(); return f; })));
  assert.ok(warnings.includes("no main bot"));
});

test("schema: entries with no id, a repeated id or no name are left out; other faults warn", () => {
  const { file, warnings } = parseBots(text(sample((f) => {
    f.bots.push({ name: "nobody", kind: "member" }, bot(ID.dev, "member"), bot("b-gggggggggg", "member", { name: "" }));
    f.bots[1].look = undefined;
    f.bots[2].agent = undefined;
    f.bots[3].look = { character: "dragon", colour: "plaid" };
    f.bots[4].planned = { wave: 0 };
    return f;
  })));
  assert.equal(file.bots.length, 5);
  assert.deepEqual(file.bots[1].look, defaultLook(ID.cap));
  assert.equal(file.bots[4].planned, undefined);
  for (const w of ["entry 6: no id", `${ID.dev}: id used twice`, "b-gggggggggg: no name", `${ID.cap}: no look`,
    `${ID.dev}: no coding agent`, `${ID.tst}: unknown character dragon`, `${ID.tst}: unknown colour plaid`, `${ID.plan}: planned`])
    assert.ok(warnings.some((x) => x.startsWith(w)), `missing warning ${w}\n${warnings.join("\n")}`);
});

test("schema: the write check wants A9 ids, known categories and an agent unless planned", () => {
  const errs = checkBots(sample((f) => {
    f.bots[1].id = "captain";
    f.bots[2].category = "nope";
    f.bots[3].agent = "";
    return f;
  }));
  assert.ok(errs.some((e) => /captain: id/.test(e)));
  assert.ok(errs.some((e) => /unknown category nope/.test(e)));
  assert.ok(errs.some((e) => e.startsWith(`${ID.tst}: no coding agent`)));
});

test("lead: absent means the main bot; a valid lead holds at any depth", () => {
  const file = sample();
  assert.deepEqual(effectiveLead(file, ID.cap), { lead: ID.main });
  assert.deepEqual(effectiveLead(file, ID.dev), { lead: ID.cap });
  assert.deepEqual(effectiveLead(file, ID.main), { lead: "" });
});

test("mode #821: empty seat and worker modes mean default on read, validation and save", () => {
  const raw = sample((f) => {
    f.bots[0].agyMode = "";
    f.bots[0].worker = { agent: "antigravity", agyMode: "" };
    return f;
  });
  assert.deepEqual(checkBots(raw), []);
  const parsed = parseBots(text(raw));
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.file.bots[0].agyMode, undefined);
  assert.deepEqual(parsed.file.bots[0].worker, { agent: "antigravity" });
  assert.equal(parsed.raw.bots[0].worker.agyMode, "", "reading does not mutate the raw roster");
  const saved = applyBotEdit(raw, { ...raw.bots[0], name: "Renamed" }).bots[0];
  assert.equal(saved.agyMode, undefined);
  assert.deepEqual(saved.worker, { agent: "antigravity" });
});

test("lead: a missing lead falls back to the main bot with a warning", () => {
  const file = sample((f) => { f.bots[2].lead = "b-zzzzzzzzzz"; return f; });
  const r = effectiveLead(file, ID.dev);
  assert.equal(r.lead, ID.main);
  assert.match(r.warning, /missing/);
  assert.ok(parseBots(text(file)).warnings.some((w) => w.startsWith(ID.dev) && /missing/.test(w)));
  assert.ok(checkBots(file).some((e) => e.startsWith(ID.dev)));
});

test("lead: a planned lead falls back to the main bot with a warning", () => {
  const file = sample((f) => { f.bots[2].lead = ID.plan; return f; });
  const r = effectiveLead(file, ID.dev);
  assert.equal(r.lead, ID.main);
  assert.match(r.warning, /planned/);
  assert.deepEqual(checkBots(file), []);
});

test("lead #742: a planned main is valid in a shared roster and remains the members' lead", () => {
  const file = sample((f) => {
    f.bots[0].planned = { wave: 1 };
    delete f.bots[0].agent;
    f.bots[2].lead = ID.main;
    return f;
  });
  assert.deepEqual(checkBots(file), []);
  assert.deepEqual(parseBots(text(file)).warnings, []);
  assert.deepEqual(effectiveLead(file, ID.main), { lead: "" });
  for (const id of [ID.cap, ID.dev]) {
    assert.deepEqual(effectiveLead(file, id), { lead: ID.main }, "implicit and explicit main leads");
  }
});

test("lead: a cycle falls back to the main bot for every bot in it, not for those under it", () => {
  const file = sample((f) => { f.bots[1].lead = ID.tst; f.bots[3].lead = ID.cap; return f; });
  for (const id of [ID.cap, ID.tst]) {
    const r = effectiveLead(file, id);
    assert.equal(r.lead, ID.main, id);
    assert.match(r.warning, /back to this bot/);
  }
  // dev's lead is cap, inside the cycle: dev stays under cap, which itself falls back.
  assert.deepEqual(effectiveLead(file, ID.dev), { lead: ID.cap });
  const self = sample((f) => { f.bots[2].lead = ID.dev; return f; });
  assert.equal(effectiveLead(self, ID.dev).lead, ID.main);
  assert.ok(checkBots(self).some((e) => e.startsWith(ID.dev)));
  const plannedSelf = sample((f) => { f.bots[4].lead = ID.plan; return f; });
  assert.ok(checkBots(plannedSelf).some((e) => e.startsWith(ID.plan)));
  assert.ok(checkBots(file).some((e) => /leads back to this bot/.test(e)));
});

test("lead #741: saves refuse cycles through planned bots while reads keep their fallback", () => {
  for (const allPlanned of [false, true]) {
    const file = sample((f) => {
      f.bots[1].lead = ID.dev;
      f.bots[2].lead = ID.plan;
      f.bots[4].lead = ID.cap;
      if (allPlanned) for (const i of [1, 2]) f.bots[i].planned = { wave: 1 };
      return f;
    });
    assert.match(effectiveLead(file, ID.dev).warning, /is planned/);
    for (const id of [ID.cap, ID.dev, ID.plan]) {
      assert.ok(checkBots(file).some((e) => e.startsWith(id) && /leads back to this bot/.test(e)), id);
    }
    delete file.bots[4].lead;
    assert.deepEqual(checkBots(file), [], "an acyclic planned lead stays writable");
  }
});

test("ids: b- plus 10 lowercase base32 characters, and random", () => {
  const ids = new Set(Array.from({ length: 200 }, () => newBotId()));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^b-[a-z2-7]{10}$/);
  assert.equal(newBotId(() => 0), "b-aaaaaaaaaa");
  assert.equal(newBotId(() => 0.999999), "b-7777777777");
});

test("look: defaultLook is stable per id and names Automagik characters and colours", () => {
  const ids = Array.from({ length: 300 }, (_, i) => `b-${String(i).padStart(10, "a")}`);
  const looks = ids.map(defaultLook);
  assert.deepEqual(ids.map(defaultLook), looks);
  for (const l of looks) {
    assert.ok(CHARACTERS.includes(l.character), l.character);
    assert.ok(COLOURS.includes(l.colour), l.colour);
  }
  assert.ok(new Set(looks.map((l) => l.character)).size > 3);
  assert.ok(new Set(looks.map((l) => l.colour)).size > 3);
  // Pinned to Automagik's own lookOf({ id }) (checked against it over 2,000 ids): a change
  // to the hash would give every bot without a stored look another face than in Automagik.
  assert.deepEqual(defaultLook("b-aaaaaaaaaa"), { character: "peanut", colour: "blue" });
  assert.deepEqual(defaultLook("b-k3m7q2zt5x"), { character: "star", colour: "violet" });
  assert.deepEqual(defaultLook("b-77777777ab"), { character: "moon", colour: "yellow" });
});

test("characters: Automagik's 21, in its order", () => {
  assert.equal(CHARACTERS.length, 21);
  assert.equal(new Set(CHARACTERS).size, 21);
  assert.deepEqual(CHARACTERS.slice(9, 12), ["peanut", "saucer", "bunny"]);
});

test("label key", () => {
  assert.equal(BOT_LABEL, "bot");
  assert.equal(MAX_INSTRUCTIONS, 4000);
});

// ---- the Create form's write-back (applyBotEdit) ----
import { applyBotEdit, newCategoryId, OMNI_LOOK } from "../mods/am-sidebar/model.js";

test("create: the first bot of a project, from no file, is a valid file", () => {
  const out = applyBotEdit(null, bot(ID.main, "main", { look: { ...OMNI_LOOK }, lead: ID.cap, category: "eng" }));
  assert.deepEqual(out.categories, []);
  assert.equal(out.bots[0].lead, undefined);
  assert.equal(out.bots[0].category, undefined);
  assert.deepEqual(checkBots(out), []);
});

test("edit: clears planned, keeps unknown keys and the entries parseBots left out", () => {
  const source = sample((f) => { f.bots[4].extra = "kept"; f.bots.push({ name: "nobody", kind: "member" }); return f; });
  const { raw, file } = parseBots(text(source));
  const was = file.bots[4];
  const { extra, ...shown } = was; // the form edits the fields it knows, not "extra"
  assert.equal(extra, "kept");
  const out = applyBotEdit(raw, { ...shown, agent: "codex", planned: undefined, model: "" });
  const edited = out.bots.find((b) => b.id === ID.plan);
  assert.equal(edited.planned, undefined);
  assert.equal(edited.agent, "codex");
  assert.equal("model" in edited, false);
  assert.equal(edited.extra, "kept");
  assert.equal(out.bots.length, 6); // the left-out entry survives
  assert.equal(raw.bots[4].planned.wave, 3); // raw itself untouched
});

test("edit: a lead equal to the main bot is stored as none; another lead drops the category", () => {
  const { raw } = parseBots(text(sample()));
  const cap = raw.bots[1];
  assert.equal(applyBotEdit(raw, { ...cap, lead: ID.main }).bots[1].lead, undefined);
  const moved = applyBotEdit(raw, { ...cap, lead: ID.tst }).bots[1];
  assert.equal(moved.lead, ID.tst);
  assert.equal(moved.category, undefined);
});

test("create: a new category is added with a unique id and used", () => {
  const { raw } = parseBots(text(sample()));
  const out = applyBotEdit(raw, bot("b-ffffffffff", "member"), { title: "Engineering", sub: " the builders " });
  assert.deepEqual(out.categories.at(-1), { id: "engineering", title: "Engineering", sub: "the builders" });
  assert.equal(out.bots.at(-1).category, "engineering");
  assert.equal(newCategoryId("Engineering", out.categories), "engineering-2");
  assert.deepEqual(checkBots(out), []);
});

test("create: instructions over 4,000 characters can't be written", () => {
  const { raw } = parseBots(text(sample()));
  const out = applyBotEdit(raw, bot("b-ffffffffff", "member", { instructions: "x".repeat(MAX_INSTRUCTIONS + 1) }));
  assert.ok(checkBots(out).some((e) => /4000/.test(e)));
});

test("lead choices: a bot's descendants at any depth can't be its lead", async () => {
  const { descendantsOf } = await import("../mods/am-sidebar/model.js");
  const f = sample();
  assert.deepEqual([...descendantsOf(f, ID.cap)].sort(), [ID.dev, ID.tst].sort());
  assert.deepEqual([...descendantsOf(f, ID.dev)], []);
  const deeper = sample((x) => { x.bots[2].lead = ID.tst; return x; }); // cap -> tst -> dev
  assert.deepEqual([...descendantsOf(deeper, ID.cap)].sort(), [ID.dev, ID.tst].sort());
  assert.equal(descendantsOf(f, ID.main).size, 4);
});

test("edit: planned keeps its other keys; wave and note come from the form", async () => {
  const { plannedOf } = await import("../mods/am-sidebar/model.js");
  assert.deepEqual(plannedOf({ wave: 3, note: "old", squad: "access" }, 4, ""), { wave: 4, squad: "access" });
  assert.deepEqual(plannedOf(null, 1, "later"), { wave: 1, note: "later" });
});

test("the CLI's project list: absolute keys once each, the newest last, at most 200", () => {
  assert.deepEqual(listedProjects(null), []);
  assert.deepEqual(listedProjects("{nope"), []);
  assert.deepEqual(listedProjects('{"a":1}'), []);
  assert.deepEqual(listedProjects('["/a", 3, "rel", "/b", "/a", null]'), ["/a", "/b"]);
  assert.deepEqual(JSON.parse(withListedProject(null, "/a")), ["/a"]);
  assert.deepEqual(JSON.parse(withListedProject('["/a", "/b"]', "/a")), ["/b", "/a"]);
  assert.equal(withListedProject('["/b", "/a"]', "/a"), withListedProject(withListedProject('["/b", "/a"]', "/a"), "/a"));
  const many = JSON.stringify(Array.from({ length: MAX_LISTED_PROJECTS }, (_, i) => `/p${i}`));
  const next = JSON.parse(withListedProject(many, "/new"));
  assert.equal(next.length, MAX_LISTED_PROJECTS);
  assert.deepEqual([next[0], next.at(-1)], ["/p1", "/new"]);
});

// ---- A16: rank ----
import { RANKS } from "../mods/am-sidebar/model.js";

test("rank: an unknown one is warned about and dropped when shown, and refused when written; role stays free text", () => {
  assert.deepEqual(RANKS, ["captain", "dev", "tester", "reviewer", "fixer", "integrator", "pm", "owner"]);
  const raw = { version: 1, categories: [], bots: [bot(ID.main, "main", { rank: "owner", role: "Runs it all" }), bot(ID.cap, "member", { rank: "boss" })] };
  const { file, warnings } = parseBots(JSON.stringify(raw));
  assert.equal(file.bots[0].rank, "owner");
  assert.equal(file.bots[0].role, "Runs it all");
  assert.equal("rank" in file.bots[1], false);
  assert.ok(warnings.some((w) => w.includes(ID.cap) && /unknown rank "boss"/.test(w)));
  assert.ok(checkBots(raw).some((e) => /unknown rank "boss"/.test(e)));
  assert.deepEqual(checkBots({ ...raw, bots: [raw.bots[0]] }), []);
});

test("applyBotEdit sets a rank, clears it when named empty, and keeps it when the entry leaves it out", () => {
  const start = { version: 1, categories: [], bots: [bot(ID.main, "main")] };
  const set = applyBotEdit(start, { ...bot(ID.main, "main"), rank: "pm" });
  assert.equal(set.bots[0].rank, "pm");
  const kept = applyBotEdit(set, bot(ID.main, "main", { role: "new role" }));
  assert.deepEqual([kept.bots[0].rank, kept.bots[0].role], ["pm", "new role"]);
  assert.equal("rank" in applyBotEdit(set, { ...bot(ID.main, "main"), rank: "" }).bots[0], false);
});

test("category ids: parseBots warns about a non-slug id; checkBots refuses only a new one; newCategoryId makes slugs", () => {
  const raw = { version: 1, categories: [{ id: "Knowledge", title: "Knowledge" }, { id: "ok-1", title: "Fine" }], bots: [bot(ID.main, "main"), bot(ID.cap, "member", { category: "Knowledge" })] };
  const { file, warnings } = parseBots(JSON.stringify(raw));
  assert.equal(file.categories.length, 2);
  assert.equal(file.bots[1].category, "Knowledge");
  assert.ok(warnings.some((w) => /"Knowledge": an id is a lowercase slug/.test(w)));
  // A hand-written file stays writable: the id was there before the edit.
  assert.deepEqual(checkBots(raw, raw), []);
  assert.deepEqual(checkBots(raw, JSON.stringify(raw)), []);
  // A new non-slug id (no file before, or not in it) is refused.
  assert.ok(checkBots(raw).some((e) => /"Knowledge": a new id is a lowercase slug/.test(e)));
  const added = { ...raw, categories: [...raw.categories, { id: "Ops Team", title: "Ops" }] };
  assert.deepEqual(checkBots(added, raw).filter((e) => /lowercase slug/.test(e)).length, 1);
  for (const bad of ["a--b", "-a", "a-", "A", "a b", "ação", ""]) assert.ok(checkBots({ ...raw, categories: [{ id: bad, title: "x" }] }).length, bad);
  assert.deepEqual(checkBots({ ...raw, bots: [raw.bots[0]], categories: [raw.categories[1]] }), []);
  for (const title of ["Ação & Studio", "  --Quality \"gate\"-- ", "!!!", "Platform 2"]) {
    assert.match(newCategoryId(title, []), /^[a-z0-9]+(-[a-z0-9]+)*$/, title);
  }
});

test("schema: a gemini bot (retired agent) is read as antigravity with one warning; raw keeps gemini", () => {
  const source = sample((f) => {
    f.bots[1].agent = "gemini";
    f.bots[2].agent = "gemini";
    f.bots[2].worker = { agent: "gemini", effort: "high" };
    f.bots[3].worker = { agent: "gemini" };
    return f;
  });
  const { file, warnings, raw } = parseBots(text(source));
  assert.equal(file.bots[1].agent, "antigravity");
  assert.equal(file.bots[2].agent, "antigravity");
  assert.deepEqual(file.bots[2].worker, { agent: "antigravity", effort: "high" });
  assert.equal(file.bots[3].agent, "claude");
  assert.deepEqual(file.bots[3].worker, { agent: "antigravity" });
  assert.deepEqual(warnings, [
    `${ID.cap}: agent gemini is retired; it runs on antigravity`,
    `${ID.dev}: agent gemini is retired; it runs on antigravity`,
    `${ID.tst}: agent gemini is retired; it runs on antigravity`,
  ], "one line per bot, even when its worker names gemini too");
  assert.equal(raw.bots[1].agent, "gemini", "the file on disk is not rewritten by reading it");
  assert.equal(raw.bots[2].worker.agent, "gemini");
  assert.deepEqual(checkBots(file), []);
});

// automagik#227 (RFC 0014 Q16): a bot pane counts by project and id, its project from its folder.
test("pane key (#227): a worktree is its main checkout's project, a clone its own", async (t) => {
  const { root, main, tree } = await repo(t);
  const clone = join(root, "proj-clone");
  await run("git", ["clone", "-q", main, clone]);
  assert.equal(await paneKeyOf(main, git, exists), main);
  assert.equal(await paneKeyOf(tree, git, exists), main);
  assert.equal(await paneKeyOf(join(main, "src", "deep"), git, exists), main);
  assert.equal(await paneKeyOf(clone, git, exists), clone);
});

test("pane key (#227): a folder that names no project gives null; a bots.json above it, that folder", async (t) => {
  const root = scratch(t);
  const deep = join(root, "a", "b");
  mkdirSync(deep, { recursive: true });
  // Not in git, nothing above: no project (projectKeyOf would say the folder itself).
  assert.equal(await projectKeyOf(deep, git, exists), deep);
  assert.equal(await paneKeyOf(deep, git, exists), null);
  // git missing or failing, a folder gone: the same.
  assert.equal(await paneKeyOf(deep, noGit, exists), null);
  assert.equal(await paneKeyOf(deep, missingGit, exists), null);
  assert.equal(await paneKeyOf(join(root, "gone"), git, exists), null);
  // A project outside git: the walk-up finds it.
  mkdirSync(join(root, "a", ".herdr"), { recursive: true });
  writeFileSync(join(root, "a", ".herdr", "bots.json"), "{}");
  assert.equal(await paneKeyOf(deep, noGit, exists), join(root, "a"));
  // A machine that can't be asked still rejects (the caller reads that as no project).
  await assert.rejects(paneKeyOf("/srv/x", unreachable, async () => false), /unreachable/);
});

// ---- #850: cross-project lead (leadProject + reciprocal crossMembers) ----
import { collectProjectMap, crossMemberWarnings, descendantsOf } from "../mods/am-sidebar/model.js";
import { parentArgs, leadIdOf, roleOf } from "../mods/am-sidebar/launchArgs.js";

test("cross-project lead (#850): member and main bots resolve across projects only when reciprocal, and fall back when one-sided, missing, planned or cyclic", () => {
  const leadId = "b-7777777777";
  const plannedLeadId = "b-6666666666";
  const subMain = "b-5555555555";
  const subCap = "b-4444444444";
  const subDev = "b-3333333333";
  const hubFile = parseBots(text({
    version: 1,
    categories: [],
    bots: [
      bot(leadId, "main", {
        name: "Coord",
        crossMembers: [
          { id: subMain, project: "/work/sub" },
          { id: subCap, project: "/work/sub" },
        ],
      }),
      bot(plannedLeadId, "member", { name: "FutureLead", agent: undefined, planned: { wave: 2 } }),
    ],
  })).file;
  const subFile = parseBots(text({
    version: 1,
    categories: [],
    bots: [
      bot(subMain, "main", { name: "SubMain", lead: leadId, leadProject: "/work/hub" }),
      bot(subCap, "member", { name: "SubCap", lead: leadId, leadProject: "/work/hub" }),
      bot(subDev, "member", { name: "SubDev", lead: subCap }),
    ],
  })).file;
  const projects = new Map([["/work/hub", hubFile], ["/work/sub", subFile]]);

  // Valid reciprocal cross-project lead for both main and member bots.
  const mainEff = effectiveLead(subFile, subMain, { project: "/work/sub", projects });
  assert.equal(mainEff.lead, leadId);
  assert.equal(mainEff.leadProject, "/work/hub");
  assert.equal(mainEff.leadBot?.name, "Coord");
  assert.equal(mainEff.warning, undefined);

  const capEff = effectiveLead(subFile, subCap, { project: "/work/sub", projects });
  assert.equal(capEff.lead, leadId);
  assert.equal(capEff.leadProject, "/work/hub");
  assert.equal(capEff.leadBot?.name, "Coord");
  assert.equal(capEff.warning, undefined);

  // descendantsOf on Coord in /work/hub includes SubMain, SubCap, and SubDev across projects.
  assert.deepEqual(
    [...descendantsOf(hubFile, leadId, { project: "/work/hub", projects })].sort(),
    [subMain, subCap, subDev].sort(),
  );
  assert.deepEqual(crossMemberWarnings(hubFile, leadId, { project: "/work/hub", projects }), []);

  // One-sided declaration (member names lead, lead does NOT list member in crossMembers):
  // fails closed to same-project graph (main -> "", member -> subMain) with one clear warning.
  const oneSidedHub = parseBots(text({
    version: 1,
    categories: [],
    bots: [bot(leadId, "main", { name: "Coord" })],
  })).file;
  const oneSidedProjects = new Map([["/work/hub", oneSidedHub], ["/work/sub", subFile]]);
  const oneSidedMain = effectiveLead(subFile, subMain, { project: "/work/sub", projects: oneSidedProjects });
  assert.equal(oneSidedMain.lead, "");
  assert.equal(oneSidedMain.leadProject, undefined);
  assert.match(oneSidedMain.warning, /is one-sided/);
  const oneSidedCap = effectiveLead(subFile, subCap, { project: "/work/sub", projects: oneSidedProjects });
  assert.equal(oneSidedCap.lead, subMain);
  assert.equal(oneSidedCap.leadProject, undefined);
  assert.match(oneSidedCap.warning, /is one-sided/);
  assert.deepEqual([...descendantsOf(oneSidedHub, leadId, { project: "/work/hub", projects: oneSidedProjects })], []);

  // One-sided declaration on the lead side (lead lists member in crossMembers, member does not name lead):
  // fails closed and surfaces a crossMemberWarnings entry on the lead.
  const unlinkedSub = parseBots(text({
    version: 1,
    categories: [],
    bots: [
      bot(subMain, "main", { name: "SubMain" }),
      bot(subCap, "member", { name: "SubCap" }),
    ],
  })).file;
  const leadOnlyProjects = new Map([["/work/hub", hubFile], ["/work/sub", unlinkedSub]]);
  assert.deepEqual([...descendantsOf(hubFile, leadId, { project: "/work/hub", projects: leadOnlyProjects })], []);
  const cmWarns = crossMemberWarnings(hubFile, leadId, { project: "/work/hub", projects: leadOnlyProjects });
  assert.equal(cmWarns.length, 2);
  assert.ok(cmWarns.every((w) => /is one-sided/.test(w)));

  // Target project missing: member falls back to same-project main, main falls back to "".
  const onlySub = new Map([["/work/sub", subFile]]);
  const missingProjCap = effectiveLead(subFile, subCap, { project: "/work/sub", projects: onlySub });
  assert.equal(missingProjCap.lead, subMain);
  assert.equal(missingProjCap.leadProject, undefined);
  assert.match(missingProjCap.warning, /project \/work\/hub has no roster/);
  const missingProjMain = effectiveLead(subFile, subMain, { project: "/work/sub", projects: onlySub });
  assert.equal(missingProjMain.lead, "");
  assert.match(missingProjMain.warning, /project \/work\/hub has no roster/);

  // Target bot missing in leadProject: falls back with warning.
  const missingBotSub = parseBots(text({
    version: 1,
    categories: [],
    bots: [
      bot(subMain, "main", { name: "SubMain" }),
      bot(subCap, "member", { name: "SubCap", lead: "b-2222222222", leadProject: "/work/hub" }),
    ],
  })).file;
  const missingBotEff = effectiveLead(missingBotSub, subCap, {
    project: "/work/sub",
    projects: new Map([["/work/hub", hubFile], ["/work/sub", missingBotSub]]),
  });
  assert.equal(missingBotEff.lead, subMain);
  assert.match(missingBotEff.warning, /in \/work\/hub is missing/);

  // Target bot is planned in leadProject: falls back with warning.
  const plannedLeadSub = parseBots(text({
    version: 1,
    categories: [],
    bots: [
      bot(subMain, "main", { name: "SubMain" }),
      bot(subCap, "member", { name: "SubCap", lead: plannedLeadId, leadProject: "/work/hub" }),
    ],
  })).file;
  const plannedEff = effectiveLead(plannedLeadSub, subCap, {
    project: "/work/sub",
    projects: new Map([["/work/hub", hubFile], ["/work/sub", plannedLeadSub]]),
  });
  assert.equal(plannedEff.lead, subMain);
  assert.match(plannedEff.warning, /in \/work\/hub is planned/);

  // Cross-project cycle: hub's Coord reports to sub's SubCap, which reports to hub's Coord (both reciprocal).
  const cyclicHub = parseBots(text({
    version: 1,
    categories: [],
    bots: [
      bot(leadId, "main", {
        name: "Coord",
        lead: subCap,
        leadProject: "/work/sub",
        crossMembers: [{ id: subCap, project: "/work/sub" }],
      }),
    ],
  })).file;
  const cyclicSub = parseBots(text({
    version: 1,
    categories: [],
    bots: [
      bot(subMain, "main", { name: "SubMain" }),
      bot(subCap, "member", {
        name: "SubCap",
        lead: leadId,
        leadProject: "/work/hub",
        crossMembers: [{ id: leadId, project: "/work/hub" }],
      }),
    ],
  })).file;
  const cyclicProjects = new Map([["/work/hub", cyclicHub], ["/work/sub", cyclicSub]]);
  const cycCap = effectiveLead(cyclicSub, subCap, { project: "/work/sub", projects: cyclicProjects });
  assert.equal(cycCap.lead, subMain);
  assert.match(cycCap.warning, /leads back to this bot/);
  const cycHub = effectiveLead(cyclicHub, leadId, { project: "/work/hub", projects: cyclicProjects });
  assert.equal(cycHub.lead, "");
  assert.match(cycHub.warning, /leads back to this bot/);
  assert.ok(
    checkBots(cyclicSub, null, { project: "/work/sub", projects: cyclicProjects })
      .some((e) => /leads back to this bot/.test(e)),
  );
});

test("cross-project lead (#850): schema validation, applyBotEdit, and collectProjectMap", async () => {
  // Relative leadProject or leadProject without lead is warned and refused by checkBots.
  const relRaw = sample((f) => { f.bots[1].lead = ID.main; f.bots[1].leadProject = "relative/path"; return f; });
  assert.ok(parseBots(text(relRaw)).warnings.some((w) => /leadProject must be an absolute/.test(w)));
  assert.ok(checkBots(relRaw).some((e) => /leadProject must be an absolute/.test(e)));

  const noLeadRaw = sample((f) => { f.bots[1].leadProject = "/work/hub"; return f; });
  assert.ok(parseBots(text(noLeadRaw)).warnings.some((w) => /leadProject without lead/.test(w)));
  assert.ok(checkBots(noLeadRaw).some((e) => /leadProject needs a lead/.test(e)));

  // Malformed crossMembers entries are warned by parseBots and refused by checkBots.
  const badCmRaw = sample((f) => { f.bots[0].crossMembers = [{ id: "bad", project: "rel" }]; return f; });
  assert.ok(parseBots(text(badCmRaw)).warnings.some((w) => /crossMembers.*entry must have/.test(w)));
  assert.ok(checkBots(badCmRaw).some((e) => /crossMembers entry needs a bot id/.test(e)));

  // applyBotEdit sets, preserves, and clears lead + leadProject + crossMembers on bots.
  const start = sample();
  const withCrossMain = applyBotEdit(start, {
    ...start.bots[0],
    lead: "b-7777777777",
    leadProject: "/work/hub/",
    crossMembers: [{ id: "b-5555555555", project: "/work/spoke/" }],
  });
  assert.equal(withCrossMain.bots[0].lead, "b-7777777777");
  assert.equal(withCrossMain.bots[0].leadProject, "/work/hub");
  assert.deepEqual(withCrossMain.bots[0].crossMembers, [{ id: "b-5555555555", project: "/work/spoke" }]);
  const clearedMain = applyBotEdit(withCrossMain, {
    ...withCrossMain.bots[0],
    lead: undefined,
    leadProject: undefined,
    crossMembers: [],
  });
  assert.equal("lead" in clearedMain.bots[0], false);
  assert.equal("leadProject" in clearedMain.bots[0], false);
  assert.equal("crossMembers" in clearedMain.bots[0], false);

  // collectProjectMap discovers projects from leadProject, crossMembers, and PROJECTS_FILE.
  const files = new Map([
    [
      "/work/hub/.herdr/bots.json",
      text({
        version: 1,
        categories: [],
        bots: [
          bot("b-7777777777", "main", {
            name: "Coord",
            crossMembers: [{ id: "b-5555555555", project: "/work/spoke" }],
          }),
        ],
      }),
    ],
    [
      "/work/spoke/.herdr/bots.json",
      text({
        version: 1,
        categories: [],
        bots: [bot("b-5555555555", "main", { name: "Spoke", lead: "b-7777777777", leadProject: "/work/hub" })],
      }),
    ],
    ["/app/am-sidebar-projects.json", JSON.stringify(["/work/spoke"])],
  ]);
  const hubParsed = parseBots(files.get("/work/hub/.herdr/bots.json")).file;
  const map = collectProjectMap({
    project: "/work/hub",
    file: hubParsed,
    appHome: "/app",
    readText: (p) => files.get(p) ?? null,
  });
  assert.deepEqual([...map.keys()].sort(), ["/work/hub", "/work/spoke"]);

  // launchArgs: parentArgs, leadIdOf, and roleOf resolve reciprocal cross-project leads and reports.
  const spokeParsed = map.get("/work/spoke");
  assert.equal(leadIdOf(spokeParsed, spokeParsed.bots[0], { project: "/work/spoke", projects: map }), "b-7777777777");
  assert.deepEqual(
    parentArgs(spokeParsed, spokeParsed.bots[0], (id) => (id === "b-7777777777" ? "t1" : null), { project: "/work/spoke", projects: map }),
    ["--parent", "t1", "--outlive-parent"],
  );
  const hubWithMemberLead = parseBots(text({
    version: 1,
    categories: [],
    bots: [
      bot("b-8888888888", "main", { name: "Main" }),
      bot("b-7777777777", "member", {
        name: "Coord",
        crossMembers: [{ id: "b-5555555555", project: "/work/spoke" }],
      }),
    ],
  })).file;
  const map2 = new Map([["/work/hub", hubWithMemberLead], ["/work/spoke", spokeParsed]]);
  assert.equal(roleOf(hubWithMemberLead, hubWithMemberLead.bots[1], { project: "/work/hub", projects: map2 }), "captain");
});
