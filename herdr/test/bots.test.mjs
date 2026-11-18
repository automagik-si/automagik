// bots.js over stand-ins for Herdr's `herdr` and `fs/promises` modules (herdr-stub.mjs,
// fs-stub.mjs) and real scratch repositories: discovery keys worktree spaces to one project,
// writes land in the main checkout unless given a worktree's dir (#234), another machine is
// asked with `on`, and a remembered project is forgotten on a null read, never on a rejected one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { state } from "./use-stubs.mjs";
import { hcFileOps } from "./hc-file-ops.mjs";
import { scratchRoot } from "./scratch-project.mjs";
import { PROJECTS_FILE } from "../mods/am-sidebar/model.js";
const { discoverProjects, discoverySnapshot, editFolderOf, writeBots, rememberProject, keyOf } = await import("../mods/am-sidebar/bots.js");

const run = promisify(execFile);
const ID = { main: "b-aaaaaaaaaa", dev: "b-cccccccccc" };
const bot = (id, kind) => ({ id, name: id.slice(2, 5), kind, look: { character: "star", colour: "blue" }, role: "r", instructions: "i", agent: "claude" });
const sample = () => ({ version: 1, categories: [], bots: [bot(ID.main, "main"), bot(ID.dev, "member")] });

function scratch(t) {
  return scratchRoot(t, "automagik-herdr-");
}
async function repo(t) {
  const root = scratch(t);
  const main = join(root, "proj");
  mkdirSync(main);
  await run("git", ["init", "-q", main]);
  await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: main });
  const tree = join(root, "proj-wt");
  await run("git", ["worktree", "add", "-q", "-b", "wt", tree], { cwd: main });
  return { root, main, tree };
}
const put = (dir, file) => { mkdirSync(join(dir, ".herdr"), { recursive: true }); writeFileSync(join(dir, ".herdr", "bots.json"), typeof file === "string" ? file : JSON.stringify(file)); };
function reset() {
  Object.assign(state, { spaces: [], shared: new Map(), setSharedCalls: 0, offline: new Set(), hung: new Set(), calls: [] });
}

test("writeBots from a worktree's key writes the main checkout only, and remembers it", async (t) => {
  reset();
  const { main, tree } = await repo(t);
  const key = await keyOf(tree);
  assert.equal(key, main);
  await writeBots(key, sample(), null);
  assert.equal(existsSync(join(tree, ".herdr")), false);
  const written = readFileSync(join(main, ".herdr", "bots.json"), "utf8");
  assert.deepEqual(JSON.parse(written), sample());
  assert.deepEqual(state.shared.get("am.sidebar.projects"), [{ key: main, machine: null }]);
  // The snapshot is required, and a stale one rejects instead of losing an edit.
  await assert.rejects(writeBots(key, sample()), /text the edit started from/);
  await assert.rejects(writeBots(key, sample(), null), /stale/);
  await writeBots(key, sample(), written);
  // A file checkBots faults is refused before any write.
  const two = sample();
  two.bots[1].kind = "main";
  await assert.rejects(writeBots(key, two, written), /exactly one/);
});

test("writeBots with a worktree's dir writes there (Q16, #234): the main checkout is untouched, the key remembered", async (t) => {
  reset();
  const { main, tree } = await repo(t);
  put(main, sample());
  const mainText = readFileSync(join(main, ".herdr", "bots.json"), "utf8");
  assert.equal(await editFolderOf(tree, main), tree);
  assert.equal(await editFolderOf(main, main), main, "the main checkout writes itself");
  assert.equal(await editFolderOf(tree, main, "box"), main, "another machine: the key, as before");
  // The first edit starts from the key's text (checkBots' before) and creates the worktree's file.
  const edit = sample();
  edit.bots[1].role = "builds";
  await writeBots(main, edit, null, null, { dir: tree, before: mainText });
  const written = readFileSync(join(tree, ".herdr", "bots.json"), "utf8");
  assert.deepEqual(JSON.parse(written), edit);
  assert.equal(readFileSync(join(main, ".herdr", "bots.json"), "utf8"), mainText);
  assert.deepEqual(state.shared.get("am.sidebar.projects"), [{ key: main, machine: null }]);
  // The next edit's snapshot is the worktree's text: the main checkout's would be stale there.
  await assert.rejects(writeBots(main, sample(), mainText, null, { dir: tree }), /stale/);
  await writeBots(main, sample(), written, null, { dir: tree });
  assert.deepEqual(JSON.parse(readFileSync(join(tree, ".herdr", "bots.json"), "utf8")), sample());
  // Discovery still reads the main checkout's file.
  state.spaces = [{ id: "w", name: "wt", folder: tree }];
  const found = await discoverProjects();
  assert.equal(found.length, 1);
  assert.equal(found[0].key, main);
  assert.equal(found[0].file.bots.find((b) => b.id === ID.dev).role, "r");
});

test("discoverProjects: a project open as two spaces (checkout and worktree) comes back once", async (t) => {
  reset();
  const { main, tree } = await repo(t);
  put(main, sample());
  state.spaces = [{ id: "s1", folder: main, machine: null }, { id: "s2", folder: tree, machine: null }];
  const found = await discoverProjects();
  assert.equal(found.length, 1);
  assert.equal(found[0].key, main);
  assert.deepEqual(found[0].spaces, ["s1", "s2"]);
  assert.equal(found[0].file.bots.length, 2);
  assert.deepEqual(found[0].warnings, []);
});

test("discoverProjects: outside git, a local space finds the bots.json above it", async (t) => {
  reset();
  const root = scratch(t);
  mkdirSync(join(root, "a", "b"), { recursive: true });
  put(join(root, "a"), sample());
  state.spaces = [{ id: "s1", folder: join(root, "a", "b"), machine: null }];
  const found = await discoverProjects();
  assert.deepEqual(found.map((p) => p.key), [join(root, "a")]);
});

test("discoverProjects: an open space on another machine is asked there, with on", async (t) => {
  reset();
  const root = scratch(t);
  mkdirSync(join(root, "srv", "app"), { recursive: true });
  put(join(root, "srv"), sample());
  state.spaces = [{ id: "r1", folder: join(root, "srv", "app"), machine: "far" }];
  const found = await discoverProjects();
  assert.deepEqual(found.map((p) => [p.key, p.machine]), [[join(root, "srv"), "far"]]);
  const git = state.calls.filter((c) => c.kind === "exec" && c.command === "git");
  // Every read but this computer's own app home (the CLI's project list) goes to "far".
  const reads = state.calls.filter((c) => c.kind === "read" && !c.path.startsWith(`${state.appHome}/`));
  assert.ok(git.length >= 1);
  assert.ok(reads.some((c) => c.path === join(root, "srv", ".herdr", "bots.json")));
  for (const c of [...git, ...reads]) assert.equal(c.on, "far", JSON.stringify(c));
});

test("discoverProjects: a machine away keeps its known key, and is skipped when never keyed", async (t) => {
  reset();
  const { main, tree } = await repo(t);
  put(main, sample());
  put(tree, { ...sample(), bots: [] }); // a worktree's committed copy: never read
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  state.offline.add("away");
  state.spaces = [{ id: "r1", folder: tree, machine: "away" }];
  assert.deepEqual(await discoverProjects(), []);
  state.offline.clear();
  const seen = await discoverProjects();
  assert.deepEqual(seen.map((p) => [p.key, p.file.bots.length]), [[main, 2]]);
  // Away again, with the cached key a minute old: git rejects, the key holds (no flip to
  // the worktree folder, whose bots.json is never read), and the rejected read keeps the
  // last good definitions.
  t.mock.timers.tick(61_000);
  state.offline.add("away");
  state.calls = [];
  const later = await discoverProjects();
  assert.deepEqual(later.map((p) => [p.key, p.file.bots.length]), [[main, 2]]);
  assert.ok(state.calls.some((c) => c.command === "git"), "the key was asked again");
  assert.ok(!state.calls.some((c) => c.kind === "read" && c.path.startsWith(tree)));
});

// A timer for discoverProjects' calls to another machine that runs out at once. A machine
// that never answers gets a name of its own per test: bots.js keeps one gate per machine for
// the module's life, so calls stuck on one stay stuck.
const quick = () => new Promise((done) => setImmediate(done));
const gitCalls = () => state.calls.filter((c) => c.kind === "exec" && c.command === "git");
const callsTo = (m) => state.calls.filter((c) => c.on === m);
const DAY = 24 * 3600_000;

test("discoverProjects: a folder keyed once isn't asked again; a minute later it is placed at once and asked once", async (t) => {
  reset();
  const { main, tree } = await repo(t);
  put(main, sample());
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  state.spaces = [{ id: "s1", folder: main, machine: "slow1" }, { id: "s2", folder: tree, machine: "slow1" }];
  await discoverProjects();
  state.calls = [];
  assert.deepEqual((await discoverProjects()).map((p) => p.spaces), [["s1", "s2"]]);
  assert.deepEqual(gitCalls(), [], "no key looked up again");
  // A minute on, "slow1" never answers: the known keys place the spaces at once and are asked
  // once; the read times out and the last good file (read in this run) shows, not stale.
  t.mock.timers.tick(61_000);
  state.hung.add("slow1");
  state.calls = [];
  const found = await discoverProjects({ sleep: quick });
  assert.deepEqual(found.map((p) => [p.key, p.spaces, p.file.bots.length, p.stale ?? false]), [[main, ["s1", "s2"], 2, false]]);
  assert.deepEqual(gitCalls().map((c) => c.cwd), [main, tree]);
  // The failed look renews the keys: the next discovery doesn't ask again.
  state.calls = [];
  await discoverProjects({ sleep: quick });
  assert.deepEqual(gitCalls(), []);
});

test("discoverProjects: a machine that never answers, with 15 folders, is never sent more than 8 calls", async (t) => {
  reset();
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  state.hung.add("h15");
  state.spaces = Array.from({ length: 15 }, (_, i) => ({ id: `r${i}`, folder: `/srv/p${i}`, machine: "h15" }));
  for (let round = 0; round < 3; round++) {
    assert.deepEqual(await discoverProjects({ sleep: quick }), []);
    t.mock.timers.tick(61_000);
  }
  assert.equal(callsTo("h15").length, 8);
});

test("discoverProjects: a machine that never answers doesn't hold back this computer's projects", async (t) => {
  reset();
  const { main } = await repo(t);
  put(main, sample());
  state.hung.add("dead");
  state.spaces = [{ id: "r1", folder: "/srv/app", machine: "dead" }, { id: "s1", folder: main, machine: null }];
  rememberProject("/srv/other", "dead");
  const found = await discoverProjects({ sleep: quick });
  assert.deepEqual(found.map((p) => [p.key, p.machine, p.spaces]), [[main, null, ["s1"]]]);
  // Away is not "no": the remembered project stays remembered.
  assert.equal(state.shared.get("am.sidebar.projects").length, 1);
});

test("restoreDiscovery: the last discovery draws at startup under the spaces open now; a machine away shows it stale, then not", async (t) => {
  reset();
  const { main, tree } = await repo(t);
  put(main, sample());
  state.spaces = [{ id: "s1", folder: tree, machine: null }, { id: "r1", folder: main, machine: "far" }];
  const saved = discoverySnapshot(await discoverProjects());
  const seen = JSON.parse(saved).projects[1].seen;
  // A restart: a fresh module, the spaces with new ids, "far" not answering.
  const fresh = await import("../mods/am-sidebar/bots.js?restart");
  state.spaces = [{ id: "n1", folder: tree, machine: null }, { id: "n2", folder: main, machine: "far" }];
  state.hung.add("far");
  state.calls = [];
  const drawn = fresh.restoreDiscovery(saved);
  assert.deepEqual(state.calls, [], "drawn without asking anything");
  assert.deepEqual(drawn.map((p) => [p.key, p.machine, p.spaces, p.file.bots.length, p.stale ?? false]),
    [[main, null, ["n1"], 2, false], [main, "far", ["n2"], 2, false]]);
  // "far" times out: its saved file shows stale, with when it was read.
  const found = await fresh.discoverProjects({ sleep: quick });
  assert.deepEqual(found.map((p) => [p.key, p.machine, p.spaces, p.file.bots.length, p.stale ?? false]),
    [[main, null, ["n1"], 2, false], [main, "far", ["n2"], 2, true]]);
  assert.match(found[1].warnings[0], /^last seen 1 min ago; far isn't answering$/);
  // Saved again, it keeps the time it was read (never as if read now), and no note.
  const again = JSON.parse(fresh.discoverySnapshot(found)).projects[1];
  assert.equal(again.seen, seen);
  assert.deepEqual(again.warnings, []);
  // Three discoveries without an answer: no longer shown.
  await fresh.discoverProjects({ sleep: quick });
  await fresh.discoverProjects({ sleep: quick });
  assert.deepEqual((await fresh.discoverProjects({ sleep: quick })).map((p) => p.machine), [null]);
});

test("restoreDiscovery: a saved file stops showing once its machine has answered", async (t) => {
  reset();
  const { main } = await repo(t);
  put(main, sample());
  const path = join(main, ".herdr", "bots.json");
  const saved = JSON.stringify({ keys: [["near", main, main, main, Date.now()]], projects: [{ key: main, machine: "near", file: sample(), warnings: [], seen: Date.now() }] });
  const fresh = await import("../mods/am-sidebar/bots.js?answered");
  state.spaces = [{ id: "r1", folder: main, machine: "near" }];
  assert.equal(fresh.restoreDiscovery(saved).length, 1);
  // "near" answers (its git does) but this file can't be read: the saved copy goes.
  state.readFault = (p) => (p === path ? new Error("EACCES") : null);
  t.after(() => { state.readFault = null; });
  // (No timer: "quick" would give up on the real git call too.)
  await fresh.discoverProjects();
  assert.deepEqual(await fresh.discoverProjects(), []);
});

test("restoreDiscovery: a saved key that is wrong now is put right in the first discovery", async (t) => {
  reset();
  const { main, tree } = await repo(t);
  put(main, sample());
  const now = Date.now();
  const saved = JSON.stringify({ keys: [[null, tree, "/moved/away", "/moved/away", now]],
    projects: [{ key: "/moved/away", machine: null, file: sample(), warnings: [], seen: now }] });
  const fresh = await import("../mods/am-sidebar/bots.js?moved");
  state.spaces = [{ id: "s1", folder: tree, machine: null }];
  assert.deepEqual(fresh.restoreDiscovery(saved).map((p) => [p.key, p.spaces]), [["/moved/away", ["s1"]]]);
  assert.deepEqual((await fresh.discoverProjects()).map((p) => [p.key, p.spaces]), [[main, ["s1"]]]);
});

test("restoreDiscovery: keys unused for a week and files read over a day ago are left out; nothing readable draws nothing", async () => {
  reset();
  const fresh = await import("../mods/am-sidebar/bots.js?old");
  const now = Date.now();
  state.spaces = [{ id: "s1", folder: "/a", machine: null }, { id: "s2", folder: "/b", machine: null }];
  const saved = JSON.stringify({
    keys: [[null, "/a", "/a", "/a", now - 8 * DAY], [null, "/b", "/b", "/b", now - DAY]],
    projects: [{ key: "/a", machine: null, file: sample(), warnings: [], seen: now }, { key: "/b", machine: null, file: sample(), warnings: [], seen: now - 2 * DAY }],
  });
  assert.deepEqual(fresh.restoreDiscovery(saved).map((p) => [p.key, p.spaces]), [["/a", []]]);
  for (const text of [null, "", "{nope", "[]", JSON.stringify({ keys: [[1, 2]], projects: [{ key: "/x", machine: null, file: "no", seen: now }] })]) {
    assert.deepEqual(fresh.restoreDiscovery(text), [], String(text));
  }
});

test("discoverProjects: a file that doesn't parse on its first read shows with the reason", async (t) => {
  reset();
  const { main } = await repo(t);
  put(main, "{ not json");
  state.spaces = [{ id: "s1", folder: main, machine: null }];
  const [p] = await discoverProjects();
  assert.deepEqual(p.file.bots, []);
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0], /bots\.json/);
});

test("discoverProjects: a remembered project with no space is found; forgotten only on a null read", async (t) => {
  reset();
  const { main } = await repo(t);
  put(main, sample());
  rememberProject(main, null);
  rememberProject(main, null);
  assert.equal(state.setSharedCalls, 1);
  rememberProject(main, "far");
  assert.equal((await discoverProjects()).length, 2);
  // "far" unreachable: its read rejects, it stays remembered and keeps its last good read.
  state.offline.add("far");
  assert.equal((await discoverProjects()).length, 2);
  assert.equal(state.shared.get("am.sidebar.projects").length, 2);
  // The file gone (read returns null): forgotten here, and still remembered for "far".
  unlinkSync(join(main, ".herdr", "bots.json"));
  const gone = await discoverProjects();
  assert.deepEqual(gone.map((p) => p.machine), ["far"]);
  assert.deepEqual(state.shared.get("am.sidebar.projects"), [{ key: main, machine: "far" }]);
});

test("discoverProjects: the CLI's project list is found with no space; a gone one is hidden, the list left alone", async (t) => {
  reset();
  const { root, main, tree } = await repo(t);
  put(main, sample());
  const app = join(root, "app");
  mkdirSync(app);
  const list = join(app, PROJECTS_FILE);
  const text = JSON.stringify([main, join(root, "gone"), 7, "relative"]);
  writeFileSync(list, text);
  const appHome = state.appHome;
  state.appHome = app;
  t.after(() => { state.appHome = appHome; });
  // Listed, and also open as a worktree space: one entry, under that space.
  state.spaces = [{ id: "s1", folder: tree }];
  const found = await discoverProjects();
  assert.deepEqual(found.map((p) => [p.key, p.spaces]), [[main, ["s1"]]]);
  state.spaces = [];
  assert.deepEqual((await discoverProjects()).map((p) => [p.key, p.spaces]), [[main, []]]);
  // Its file gone: not shown; the CLI's file untouched and nothing remembered or forgotten.
  unlinkSync(join(main, ".herdr", "bots.json"));
  assert.deepEqual(await discoverProjects(), []);
  assert.equal(readFileSync(list, "utf8"), text);
  assert.equal(state.setSharedCalls, 0);
  // A list that doesn't parse lists nothing.
  put(main, sample());
  writeFileSync(list, "{nope");
  assert.deepEqual(await discoverProjects(), []);
});

test("writeBots after an edit relabels the changed bots' live local panes without waiting; failures in one notice", async (t) => {
  reset();
  const { main } = await repo(t);
  await writeBots(main, sample(), null);
  let text = readFileSync(join(main, ".herdr", "bots.json"), "utf8");
  const row = (address, labels) => ({ address, labels, state: "live", program: { agent: true } });
  let release;
  const gate = new Promise((r) => { release = r; });
  Object.assign(state, {
    terminals: [row("t1", { bot: ID.main, role: "main" }), row("t5", { bot: ID.dev }), row("t6", { bot: ID.dev }), row("far/t7", { bot: ID.dev })],
    hcCalls: [], notes: [],
    hcAnswer: async (args) => { await gate; return { code: args[1] === "t6" ? 1 : 0, stdout: "{}", stderr: "" }; },
  });
  t.after(() => { state.terminals = []; state.hcCalls = []; state.notes = []; });
  const edited = sample();
  edited.bots[1].rank = "pm";
  // The save resolves while hc is still held: the labels follow on their own.
  const { relabel } = await writeBots(main, edited, text);
  assert.equal(JSON.parse(readFileSync(join(main, ".herdr", "bots.json"), "utf8")).bots[1].rank, "pm");
  release();
  assert.deepEqual(await relabel, { done: ["t5"], failed: ["t6"], unchecked: [] });
  assert.deepEqual(state.hcCalls, [["label", "t5", "role=pm"], ["label", "t6", "role=pm"]]); // never far/t7
  assert.equal(state.notes.length, 1);
  assert.match(state.notes[0].body, /these panes' labels weren't updated: t6/);
  // terminals() itself failing: the save still resolves; one notice.
  text = readFileSync(join(main, ".herdr", "bots.json"), "utf8");
  Object.defineProperty(state, "terminals", { configurable: true, get() { throw new Error("terminals gone"); } });
  try {
    const again = sample();
    again.bots[1].rank = "dev";
    const out = await writeBots(main, again, text);
    assert.deepEqual(await out.relabel, { done: [], failed: [], unchecked: [ID.dev] });
  } finally {
    Object.defineProperty(state, "terminals", { configurable: true, writable: true, value: [] });
  }
  assert.equal(state.notes.length, 2);
  assert.match(state.notes[1].body, new RegExp(`^Saved, but these bots' panes could not be checked: ${ID.dev}\\.`));
  // A new file relabels nothing (no pane can carry its bots yet).
  state.hcCalls = [];
  const other = await repo(t);
  assert.deepEqual(await (await writeBots(other.main, sample(), null)).relabel, { done: [], failed: [], unchecked: [] });
  assert.deepEqual(state.hcCalls, []);
});

test("writeBots on another machine: created there by exclusive create, edited by hc file edit, stale and away refused", async (t) => {
  reset();
  state.hcCalls = [];
  state.hcAnswer = hcFileOps(state);
  t.after(() => { state.hcAnswer = () => ({ code: 0, stdout: "{}", stderr: "" }); });
  const key = join(scratch(t), "hedgefund");
  mkdirSync(key);
  const path = join(key, ".herdr", "bots.json");
  // A new file: made there (exec on vm), never through Herdr's local writeTextFile.
  await writeBots(key, sample(), null, "vm");
  const made = readFileSync(path, "utf8");
  assert.deepEqual(JSON.parse(made), sample());
  assert.ok(state.calls.some((c) => c.kind === "exec" && c.command === "sh" && c.on === "vm"));
  assert.equal(state.calls.filter((c) => c.kind === "write").length, 0, "no local write");
  assert.deepEqual(state.shared.get("am.sidebar.projects"), [{ key, machine: "vm" }]);
  // Created again from a stale null: refused, the file left alone.
  await assert.rejects(writeBots(key, sample(), null, "vm"), /stale snapshot/);
  assert.equal(readFileSync(path, "utf8"), made);
  // An edit from the text read: hc file edit there, the whole text for the whole text.
  const next = sample();
  next.bots[1].role = "trades";
  const out = await writeBots(key, next, made, "vm");
  assert.deepEqual(await out.relabel, { done: [], failed: [], unchecked: [] }, "another machine's panes are left alone");
  const edit = state.hcCalls.find((a) => a[1] === "edit");
  assert.deepEqual(edit.slice(0, 5), ["file", "edit", "--json", "--on", "vm"]);
  assert.equal(edit.at(-1), path);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).bots[1].role, "trades");
  // From the old text again (someone's edit landed): stale, nothing written.
  const now = readFileSync(path, "utf8");
  await assert.rejects(writeBots(key, sample(), made, "vm"), /stale snapshot/);
  assert.equal(readFileSync(path, "utf8"), now);
  // checkBots still refuses before anything is sent; the machine away is an error, not stale.
  const two = sample();
  two.bots[1].kind = "main";
  state.hcCalls = [];
  await assert.rejects(writeBots(key, two, now, "vm"), /exactly one/);
  assert.equal(state.hcCalls.length, 0);
  state.offline.add("vm");
  await assert.rejects(writeBots(key, next, now, "vm"), (e) => !/stale/.test(e.message) && /vm/.test(e.message));
  assert.equal(readFileSync(path, "utf8"), now);
});

// #230: a project's formatter may use tabs (Biome's default) or four spaces; a write keeps the
// indentation the file has, and a new file is two spaces, as before.
const indented = (file, indent) => `${JSON.stringify(file, null, indent)}\n`;
const firstIndent = (text) => /\n([ \t]+)\S/.exec(text)?.[1];
test("writeBots keeps the file's indentation (#230): tabs and four spaces stay, a new file is two spaces", async (t) => {
  reset();
  for (const indent of ["\t", "    "]) {
    const { main } = await repo(t);
    put(main, indented(sample(), indent));
    const path = join(main, ".herdr", "bots.json");
    const text = readFileSync(path, "utf8");
    const edit = sample();
    edit.bots[1].role = "builds";
    await writeBots(main, edit, text);
    assert.equal(readFileSync(path, "utf8"), indented(edit, indent));
  }
  const fresh = join(scratch(t), "fresh");
  mkdirSync(fresh);
  await writeBots(fresh, sample(), null);
  assert.equal(readFileSync(join(fresh, ".herdr", "bots.json"), "utf8"), indented(sample(), 2));
});

test("writeBots from a worktree with no file of its own copies the main checkout's indentation (#230)", async (t) => {
  reset();
  const { main, tree } = await repo(t);
  put(main, indented(sample(), "\t"));
  const mainText = readFileSync(join(main, ".herdr", "bots.json"), "utf8");
  const edit = sample();
  edit.bots[1].role = "builds";
  await writeBots(main, edit, null, null, { dir: tree, before: mainText });
  assert.equal(readFileSync(join(tree, ".herdr", "bots.json"), "utf8"), indented(edit, "\t"));
});

test("writeBots on another machine keeps the file's tabs there (#230)", async (t) => {
  reset();
  state.hcCalls = [];
  state.hcAnswer = hcFileOps(state);
  t.after(() => { state.hcAnswer = () => ({ code: 0, stdout: "{}", stderr: "" }); });
  const key = join(scratch(t), "hedgefund");
  put(key, indented(sample(), "\t"));
  const path = join(key, ".herdr", "bots.json");
  const next = sample();
  next.bots[1].role = "trades";
  await writeBots(key, next, readFileSync(path, "utf8"), "vm");
  const now = readFileSync(path, "utf8");
  assert.equal(firstIndent(now), "\t");
  assert.equal(now, indented(next, "\t"));
});
