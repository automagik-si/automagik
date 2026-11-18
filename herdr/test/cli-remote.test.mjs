// automagik-herdr --machine (automagik#206): a project on a linked machine, read and written
// there through hc (file read|edit --on, exec --on), by the rule a local edit follows. The
// linked machine "vm" is test/fake-hc.mjs's: a scratch home, its files paths here. The real hc
// and window are never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkBots, PROJECTS_FILE } from "../mods/am-sidebar/model.js";
import { readJsonLines } from "./log-lines.mjs";
import { scratchProject, scratchRoot } from "./scratch-project.mjs";

const CLI = new URL("../mods/am-sidebar/bin/automagik-herdr.mjs", import.meta.url).pathname;
const FAKE_HC = new URL("./fake-hc.mjs", import.meta.url).pathname;
const MAIN = "b-aaaaaaaaaa", DEV = "b-cccccccccc";
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

function scene(t, { state = "connected" } = {}) {
  const root = scratchRoot(t, "hb-remote-cli-");
  const bin = join(root, "bin"), home = join(root, "home"), app = join(root, "app"), vm = join(root, "vm");
  for (const d of [bin, home, app, vm]) mkdirSync(d, { recursive: true });
  writeFileSync(join(bin, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  chmodSync(join(bin, "hc"), 0o755);
  // Never the real window: a herdr-app that fails, first on PATH.
  writeFileSync(join(bin, "herdr-app"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "herdr-app"), 0o755);
  // The project there: a git repository in vm's home, and this computer's own folder elsewhere.
  const project = scratchProject(vm, "hedgefund", { commit: true });
  const local = join(root, "here");
  mkdirSync(local);
  const statePath = join(root, "hc.json"), logPath = join(root, "hc.log");
  writeFileSync(statePath, JSON.stringify({ terminals: [], next: 100, machines: [{ name: "vm", state, uname: "Linux x86_64", home: vm }] }));
  writeFileSync(logPath, "");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, HERDR_APP_HOME: app, HC_FAKE_STATE: statePath, HC_FAKE_LOG: logPath, GIT_CEILING_DIRECTORIES: root };
  delete env.HC_TERMINAL_ID;
  const cli = (args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: local, env, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
  };
  const on = ["--machine", "vm", "--project", project];
  const botsPath = join(project, ".herdr/bots.json");
  const calls = () => readJsonLines(logPath);
  const setState = (fn) => { const s = JSON.parse(readFileSync(statePath, "utf8")); fn(s); writeFileSync(statePath, JSON.stringify(s)); };
  return { root, project, local, app, cli, on, botsPath, calls, setState, bots: () => JSON.parse(readFileSync(botsPath, "utf8")) };
}

test("create --machine: the file is made there through hc, the first bot main; nothing lands on this computer", (t) => {
  const s = scene(t);
  const made = s.cli(["create", ...s.on, "--name", "Hedge", "--agent", "claude", "--json"]);
  assert.equal(made.code, 0, made.err);
  const out = made.json();
  assert.equal(out.project, s.project);
  assert.equal(out.machine, "vm");
  assert.deepEqual(checkBots(s.bots()), []);
  assert.equal(s.bots().bots[0].kind, "main");
  assert.ok(s.calls().some((c) => c[0] === "exec" && c.includes("--on") && c.includes("vm") && c.includes("sh")), "an exclusive create there");
  assert.equal(existsSync(join(s.local, ".herdr")), false);
  // The CLI's project list is this computer's: a linked machine's project isn't put in it.
  assert.equal(existsSync(join(s.app, PROJECTS_FILE)), false);
  // A second bot: an edit of the file there, by hc file edit with the text read.
  const two = s.cli(["create", ...s.on, "--name", "Trader", "--agent", "claude"]);
  assert.equal(two.code, 0, two.err);
  assert.equal(s.bots().bots[1].kind, "member");
  const edit = s.calls().find((c) => c[0] === "file" && c[1] === "edit");
  assert.ok(edit && edit.includes("vm") && edit.at(-1) === s.botsPath);
});

test("--machine keys --project there by the same rule: a worktree's folder is its main checkout's project", (t) => {
  const s = scene(t);
  const wt = join(s.root, "vm", "hedgefund-wt");
  git(s.project, "worktree", "add", "-q", wt);
  const r = s.cli(["create", "--machine", "vm", "--project", wt, "--name", "Hedge", "--agent", "claude", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().project, s.project);
  assert.ok(existsSync(s.botsPath));
  assert.equal(existsSync(join(wt, ".herdr")), false);
  assert.ok(s.calls().some((c) => c[0] === "exec" && c.includes("--cwd") && c.includes("git")), "git asked there");
});

test("ls, show, edit, category and rm --machine work on the file there", (t) => {
  const s = scene(t);
  assert.equal(s.cli(["create", ...s.on, "--name", "Hedge", "--agent", "claude"]).code, 0);
  assert.equal(s.cli(["create", ...s.on, "--name", "Trader", "--agent", "claude"]).code, 0);
  const ls = s.cli(["ls", ...s.on, "--json"]);
  assert.equal(ls.code, 0, ls.err);
  const [p] = ls.json().projects;
  assert.equal(p.project, s.project);
  assert.equal(p.machine, "vm");
  assert.deepEqual(p.bots.map((b) => [b.name, b.status, b.machine]), [["Hedge", "not running", "vm"], ["Trader", "not running", "vm"]]);
  const text = s.cli(["ls", ...s.on]);
  assert.match(text.out, new RegExp(`^${s.project} on vm$`, "m"));
  assert.match(s.cli(["show", "Trader", ...s.on]).out, /project {6}.* on vm/);
  const edited = s.cli(["edit", "Trader", ...s.on, "--role", "trades", "--json"]);
  assert.equal(edited.code, 0, edited.err);
  assert.equal(edited.json().machine, "vm");
  assert.equal(s.bots().bots[1].role, "trades");
  const cat = s.cli(["category", "add", ...s.on, "--title", "Desk", "--json"]);
  assert.equal(cat.code, 0, cat.err);
  assert.deepEqual(s.bots().categories.map((c) => c.id), [cat.json().category.id]);
  assert.equal(s.cli(["rm", "Trader", ...s.on]).code, 0);
  const last = s.cli(["rm", "Hedge", ...s.on, "--json"]);
  assert.equal(last.code, 0, last.err);
  assert.equal(last.json().deletedFile, true);
  assert.equal(existsSync(s.botsPath), false);
  assert.match(last.err, /bots\.json on vm was deleted/);
});

const PLAN = "b-eeeeeeeeee", CAP = "b-bbbbbbbbbb";
const fallbackTeam = () => ({
  version: 1, categories: [], bots: [
    { id: MAIN, name: "Main", kind: "main" },
    { id: CAP, name: "Captain", kind: "member", lead: PLAN },
    { id: DEV, name: "Dev", kind: "member", lead: PLAN },
    { id: PLAN, name: "Studio", kind: "member", planned: { wave: 3 } },
  ].map((b) => ({ look: { character: "star", colour: "blue" }, role: "", instructions: "", agent: "claude", ...b })),
});
const seedFallbackTeam = (s, file) => {
  mkdirSync(join(s.project, ".herdr"), { recursive: true });
  writeFileSync(s.botsPath, `${JSON.stringify(file, null, 2)}\n`);
};

test("#730 linked save: two planned leads warn without blocking an unrelated edit", (t) => {
  const s = scene(t);
  seedFallbackTeam(s, fallbackTeam());
  const lead = PLAN;
  const saved = s.cli(["edit", "Main", ...s.on, "--role", "updated"]);
  assert.equal(saved.code, 0, saved.err);
  assert.equal(s.bots().bots[0].role, "updated");
  for (const id of [CAP, DEV]) {
    assert.ok(saved.err.includes(`Warning: ${id}: lead ${lead} is planned; reports to the main bot`), saved.err);
    assert.equal(s.bots().bots.find((b) => b.id === id).lead, lead);
    assert.equal(s.cli(["show", id, ...s.on, "--json"]).json().lead, MAIN);
  }
  assert.ok(s.calls().some((c) => c[0] === "file" && c[1] === "edit" && c.includes("vm")));
});

test("#730 linked save: explicitly choosing a planned lead still refuses create and edit", (t) => {
  const s = scene(t);
  seedFallbackTeam(s, fallbackTeam());
  const before = readFileSync(s.botsPath, "utf8");
  for (const args of [["edit", "Dev"], ["create", "--name", "New", "--agent", "claude"]]) {
    const refused = s.cli([...args, ...s.on, "--lead", "Studio"]);
    assert.equal(refused.code, 1, refused.err);
    assert.match(refused.err, /Studio is planned, so it can't lead a bot yet\./);
    assert.equal(readFileSync(s.botsPath, "utf8"), before);
  }
});

for (const [name, breakFile, why] of [
  ["unknown lead", (f) => { f.bots[2].lead = "b-zzzzzzzzzz"; }, /lead b-zzzzzzzzzz is missing/],
  ["empty lead", (f) => { f.bots[2].lead = ""; }, /lead  is missing/],
  ["non-text number lead", (f) => { f.bots[2].lead = 42; }, /lead 42 is missing/],
  ["non-text boolean lead", (f) => { f.bots[2].lead = false; }, /lead false is missing/],
  ["non-text object lead", (f) => { f.bots[2].lead = {}; }, /lead \[object Object\] is missing/],
  ["non-text array lead", (f) => { f.bots[2].lead = []; }, /lead  is missing/],
  ["duplicate ids", (f) => f.bots.push({ ...f.bots[2] }), /id used twice/],
  ["self lead", (f) => { f.bots[2].lead = DEV; }, /leads back to this bot/],
  ["lead cycle", (f) => { f.bots[1].lead = DEV; f.bots[2].lead = CAP; }, /leads back to this bot/],
  ["unknown main kind", (f) => { f.bots[0].kind = "unknown"; }, /unknown kind/],
]) {
  test(`#730 linked save: ${name} elsewhere still refuses`, (t) => {
    const s = scene(t);
    const file = fallbackTeam();
    breakFile(file);
    seedFallbackTeam(s, file);
    const before = readFileSync(s.botsPath, "utf8");
    const refused = s.cli(["edit", "Studio", ...s.on, "--role", "updated"]);
    assert.equal(refused.code, 1, refused.err);
    assert.match(refused.err, why);
    assert.equal(readFileSync(s.botsPath, "utf8"), before);
  });
}

test("--machine: an edit that landed there since the read is never overwritten", (t) => {
  const s = scene(t);
  assert.equal(s.cli(["create", ...s.on, "--name", "Hedge", "--agent", "claude"]).code, 0);
  const theirs = `${JSON.stringify({ ...s.bots(), categories: [{ id: "x", title: "Theirs" }] }, null, 2)}\n`;
  s.setState((st) => { st.editRace = theirs; });
  const r = s.cli(["edit", "Hedge", ...s.on, "--role", "mine"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /Not saved: .*bots\.json on vm changed since it was read/);
  assert.equal(readFileSync(s.botsPath, "utf8"), theirs);
});

test("--machine refusals: no --project, a relative one, a folder not there, a machine away, an unknown one", (t) => {
  const s = scene(t);
  const noProject = s.cli(["ls", "--machine", "vm"]);
  assert.equal(noProject.code, 2);
  assert.match(noProject.err, /--machine needs --project/);
  assert.match(s.cli(["ls", "--machine", "vm", "--project", "hedgefund"]).err, /absolute path/);
  const missing = s.cli(["ls", "--machine", "vm", "--project", join(s.root, "vm", "gone")]);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /is not a folder on vm/);
  assert.match(s.cli(["ls", "--machine", "nosuch", "--project", s.project]).err, /nosuch can't be reached/);
  assert.match(s.cli(["ls", "--machine=-x", "--project", s.project]).err, /isn't a machine name/);
  assert.match(s.cli(["ls", "--all", ...s.on]).err, /without --all/);
});

test("--machine with a command still on this computer only (worker, brief, history, tidy) is refused, never run here instead", (t) => {
  const s = scene(t);
  for (const args of [["history", "Hedge"], ["brief", "Hedge"], ["worker", "task", "--branch", "x"], ["tidy"]]) {
    const r = s.cli([...args, ...s.on]);
    assert.equal(r.code, 2, args.join(" "));
    assert.match(r.err, /works on this computer only for now/);
  }
  assert.deepEqual(s.calls(), [], "nothing asked of hc");
});

test("--machine on a machine that isn't connected: a failure that says so, nothing written", (t) => {
  const s = scene(t);
  assert.equal(s.cli(["create", ...s.on, "--name", "Hedge", "--agent", "claude"]).code, 0);
  const before = readFileSync(s.botsPath, "utf8");
  s.setState((st) => { st.machines[0].state = "disconnected"; });
  const r = s.cli(["edit", "Hedge", ...s.on, "--role", "x"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /vm can't be reached|not connected/);
  assert.doesNotMatch(r.err, /changed since/);
  assert.equal(readFileSync(s.botsPath, "utf8"), before);
});

test("--machine: an edit that landed there but lost its answer is reported saved, once", (t) => {
  const s = scene(t);
  assert.equal(s.cli(["create", ...s.on, "--name", "Hedge", "--agent", "claude"]).code, 0);
  s.setState((st) => { st.loseEditAnswer = true; });
  const r = s.cli(["create", ...s.on, "--name", "Trader", "--agent", "claude"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(s.bots().bots.map((b) => b.name), ["Hedge", "Trader"], "one Trader, no retry needed");
});

test("--machine: a project folder with spaces and a quote goes through as it is", (t) => {
  const s = scene(t);
  const odd = scratchProject(join(s.root, "vm"), "hedge fund's \"desk\"");
  const r = s.cli(["create", "--machine", "vm", "--project", odd, "--name", "Hedge", "--agent", "claude", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().project, odd);
  assert.equal(JSON.parse(readFileSync(join(odd, ".herdr/bots.json"), "utf8")).bots[0].name, "Hedge");
  assert.equal(s.cli(["edit", "Hedge", "--machine", "vm", "--project", odd, "--role", "trades"]).code, 0);
  assert.equal(JSON.parse(readFileSync(join(odd, ".herdr/bots.json"), "utf8")).bots[0].role, "trades");
});

test("--machine: git there getting no answer is 'can't be reached', never 'not in git'", (t) => {
  const s = scene(t);
  s.setState((st) => { st.execUnanswered = ["git"]; });
  const r = s.cli(["create", ...s.on, "--name", "Hedge", "--agent", "claude"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /vm can't be reached: vm stopped answering/);
  assert.equal(existsSync(s.botsPath), false);
});

test("--machine: a create that landed there before the link dropped is reported saved, once", (t) => {
  const s = scene(t);
  s.setState((st) => { st.loseExecAnswer = "sh"; });
  const r = s.cli(["create", ...s.on, "--name", "Hedge", "--agent", "claude"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(s.bots().bots.map((b) => b.name), ["Hedge"]);
});

test("create, edit and rm --machine keep the file's tabs there (#230); a new file there is two spaces", (t) => {
  const s = scene(t);
  const made = s.cli(["create", ...s.on, "--name", "Hedge", "--agent", "claude"]);
  assert.equal(made.code, 0, made.err);
  const first = readFileSync(s.botsPath, "utf8");
  assert.equal(first, `${JSON.stringify(JSON.parse(first), null, 2)}\n`);
  writeFileSync(s.botsPath, `${JSON.stringify(JSON.parse(first), null, "\t")}\n`);
  for (const args of [["create", "--name", "Trader", "--agent", "claude"], ["edit", "Trader", "--role", "trades"], ["rm", "Trader"]]) {
    const r = s.cli([...args, ...s.on]);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.err}`);
    const text = readFileSync(s.botsPath, "utf8");
    assert.equal(text, `${JSON.stringify(JSON.parse(text), null, "\t")}\n`, `${args.join(" ")} kept tabs`);
  }
});
