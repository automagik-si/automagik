// The briefing hook survives renames (Group 6b): hooks move onto <app home>/automagik-herdr/briefing.mjs,
// which runs whichever sidebar folder is installed; a worker's worktree is covered; each rewrite is
// backed up and journalled; the way back edits only what still holds the forward value; the CLI link
// follows the sidebar folder. Scratch app homes, projects and HOMEs only; neutral names throughout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ledgerPath } from "../mods/am-sidebar/workers.js";
import { BRIEFED_DIR, OURS, commandFor, directHookCommand, hookCommand, legacyHookCommand, mergeHook, stableBriefingPath,
  amPartEntryPath, amPartHookCommand, amPartHookCommandV1, amPartRunnerPath, scriptOf } from "../mods/am-sidebar/briefingText.mjs";
import {
  BACKUP_SUFFIX, HOOKS_JOURNAL, botPaneFolders, foldersOf, hooksNotice, knownProjects, ledgerFolders, migrateHooks, relink, retargetHooks, revertHooks, syncHooks,
  toStable, ownHook,
} from "../mods/am-sidebar/migrateHooks.mjs";

// git here must not read this host's global config.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PACK = join(ROOT, "mods", "am-sidebar");
const UPDATE = join(PACK, "update.mjs");
const NODE_DIR = dirname(process.execPath);
const read = (path) => readFileSync(path, "utf8");
const readJson = (path) => JSON.parse(read(path));
const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const git = (args, cwd) => execFileSync("git", args, { cwd, stdio: "pipe" });
const settings = (dir) => join(dir, ".claude", "settings.local.json");
const commands = (file) => readJson(file).hooks.UserPromptSubmit.flatMap((g) => g.hooks.map((h) => h.command));

function scratch(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "am-hooks-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, "app");
  const mods = join(app, "mods");
  mkdirSync(mods, { recursive: true });
  return { root, app, mods };
}

/** A git project with one commit; `worker`: also a bot worker's worktree at <project>/.claude/worktrees/<worker>. */
function project(root, name, worker) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(["init", "-q", dir]);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], dir);
  if (worker) git(["worktree", "add", "-q", "-b", worker, join(dir, ".claude", "worktrees", worker)], dir);
  return dir;
}

/** A settings.local.json as v0.2.0 left it, with permissions Claude Code wrote and another hook. */
const v020 = (app) => ({
  permissions: { allow: ["Bash(git status)"] },
  hooks: {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "brain recall" }] }, { hooks: [{ type: "command", command: legacyHookCommand(app), timeout: 10 }] }],
    Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
  },
});
const writeSettings = (dir, value) => write(settings(dir), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);

// ---- pure ----

test("OURS knows the entry point and both sidebar folders; mergeHook never adds a second hook beside any of them", () => {
  for (const path of ["/h/automagik-herdr/briefing.mjs", "/h/mods/spaces-agents/briefing.mjs", "/h/mods/am-sidebar/briefing.mjs"]) {
    assert.match(commandFor(path), OURS);
    const text = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: commandFor(path), timeout: 10 }] }] } });
    const merged = mergeHook(text, hookCommand("/h"));
    assert.deepEqual(JSON.parse(merged.text).hooks.UserPromptSubmit, [{ hooks: [{ type: "command", command: hookCommand("/h"), timeout: 10 }] }]);
  }
  assert.doesNotMatch("node /h/mods/pocket-link/briefing.mjs", OURS);
  assert.doesNotMatch("node /h/briefing.mjs", OURS);
});

test("an am-part hook is ours: classified, never doubled, and moved onto the stable entry once a pack is installed", () => {
  const app = "/h", store = "/am/parts/automagik.am";
  const command = amPartHookCommand(app, store);
  assert.match(command, OURS);
  assert.equal(scriptOf(command), amPartEntryPath(store));
  const text = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command, timeout: 10 }] }] } });
  assert.deepEqual(mergeHook(text, command), { text, changed: false }, "the stored command is left alone, not doubled");
  assert.deepEqual(JSON.parse(mergeHook(text, hookCommand(app)).text).hooks.UserPromptSubmit, [{ hooks: [{ type: "command", command: hookCommand(app), timeout: 10 }] }]);
  assert.equal(toStable(app)(command), hookCommand(app), "a pack install moves it to the stable entry, which runs am's briefing first");
  assert.equal(ownHook(app)(command), false, "the pack's uninstall leaves am's hook alone");
});

test("scriptOf refuses a hand-edited am-part command: every guard must line up with what it runs", () => {
  const app = "/h", store = "/am/parts/automagik.am";
  const runner = amPartRunnerPath(store), entry = amPartEntryPath(store);
  const amHome = store.replace(/\/parts\/automagik\.am$/, "");
  const shape = ({ guardRunner = runner, readRunner = guardRunner, guardEntry = entry, readEntry = guardEntry, runRunner = runner,
    runEntry = entry, home = amHome, shell = "sh", env = "", tail = "" }) =>
    `[ ! -f "${guardRunner}" ] || [ ! -r "${readRunner}" ] || [ ! -f "${guardEntry}" ] || [ ! -r "${readEntry}" ] || `
    + `HERDR_APP_HOME="${app}" AM_HOME="${home}"${env ? ` ${env}` : ""} ${shell} "${runRunner}" "${runEntry}"${tail}`;
  assert.equal(shape({}), amPartHookCommand(app, store), "every row is an edit of the command installHook writes");
  assert.equal(scriptOf(shape({})), entry, "the command as written is read");
  const rows = [
    ["a changed guard runner", { guardRunner: `${runner}.other`, readRunner: runner }],
    ["a changed readable-guard runner", { readRunner: `${runner}.other` }],
    ["a changed run runner", { runRunner: `${runner}.other` }],
    ["a changed guard entry", { guardEntry: `${entry}.other`, readEntry: entry }],
    ["a changed readable-guard entry", { readEntry: `${entry}.other` }],
    ["a changed run entry", { runEntry: `${entry}.other` }],
    ["a trailing command after the entry", { tail: "; echo mine" }],
    ["another shell instead of sh", { shell: "bash" }],
    ["an extra env word", { env: "EXTRA=1" }],
    // #815: edits that keep every guard in line with what runs, but whose runner or AM_HOME is
    // not the entry's own store's.
    ["the runner edited everywhere alike", { guardRunner: "/tmp/run.sh", runRunner: "/tmp/run.sh" }],
    ["another store's runner everywhere", { guardRunner: amPartRunnerPath("/x/parts/automagik.am"), runRunner: amPartRunnerPath("/x/parts/automagik.am") }],
    ["another AM_HOME", { home: "/x" }],
  ];
  for (const [what, edit] of rows) assert.equal(scriptOf(shape(edit)), null, what);
});

test("#815: the am part's earlier form (existence guards only) is still ours, held to its store, and replaced in place", () => {
  const app = "/h", store = "/am/parts/automagik.am";
  const runner = amPartRunnerPath(store), entry = amPartEntryPath(store);
  const v1 = amPartHookCommandV1(app, store);
  assert.equal(v1, `[ ! -f "${runner}" ] || [ ! -f "${entry}" ] || HERDR_APP_HOME="${app}" AM_HOME="/am" sh "${runner}" "${entry}"`);
  assert.match(v1, OURS);
  assert.equal(scriptOf(v1), entry);
  assert.equal(scriptOf(v1.replaceAll(runner, "/tmp/run.sh")), null, "its runner edited everywhere alike");
  assert.equal(scriptOf(v1.replace('AM_HOME="/am"', 'AM_HOME="/x"')), null, "another AM_HOME");
  assert.equal(scriptOf(v1.replace(`[ ! -f "${runner}" ]`, `[ ! -f "${runner}.other" ]`)), null, "a guard out of line");
  const text = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: v1, timeout: 10 }] }] } });
  assert.deepEqual(JSON.parse(mergeHook(text, amPartHookCommand(app, store)).text).hooks.UserPromptSubmit,
    [{ hooks: [{ type: "command", command: amPartHookCommand(app, store), timeout: 10 }] }], "today's form, in place, never doubled");
  assert.equal(toStable(app)(v1), hookCommand(app), "a pack install moves it to the stable entry");
});

test("retargetHooks: only the pack's command shape moves, every other byte stays; odd shapes and bad JSON are reported", () => {
  const legacy = legacyHookCommand("/h");
  const text = `{\n    "permissions":{"allow":["Bash(ls)"]},\n  "hooks": {"UserPromptSubmit": [ {"hooks": [{"type":"command","command":${JSON.stringify(legacy)}}]} ]}\n}`;
  const r = retargetHooks(text, toStable("/h"));
  assert.deepEqual(r.edits, [{ before: legacy, after: hookCommand("/h") }]);
  assert.equal(r.text, text.replace(JSON.stringify(legacy), JSON.stringify(hookCommand("/h"))), "byte for byte but the command");
  // Already there: no edit. Another app home's (or a checkout's) script is not this run's to move.
  assert.deepEqual(retargetHooks(r.text, toStable("/h")).edits, []);
  assert.deepEqual(retargetHooks(text, toStable("/other")), { text, edits: [], odd: [] });
  // The same command under another event first: only the UserPromptSubmit one changes, in place.
  const twice = `{"hooks": {"SessionStart": [{"hooks": [{"type":"command","command":${JSON.stringify(legacy)}}]}],\n "UserPromptSubmit": [{"hooks": [{"type":"command","command":${JSON.stringify(legacy)}}]}]}}\n`;
  const at = twice.lastIndexOf(JSON.stringify(legacy));
  assert.equal(retargetHooks(twice, toStable("/h")).text,
    twice.slice(0, at) + JSON.stringify(hookCommand("/h")) + twice.slice(at + JSON.stringify(legacy).length));
  // The person's own command around our script: reported, kept.
  const odd = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "node /h/mods/spaces-agents/briefing.mjs | tee /tmp/log" }] }] } });
  assert.deepEqual(retargetHooks(odd, toStable("/h")), { text: odd, edits: [], odd: ["node /h/mods/spaces-agents/briefing.mjs | tee /tmp/log"] });
  assert.match(retargetHooks("{ nope", toStable("/h")).error, /not valid JSON/);
  assert.match(retargetHooks("[]", toStable("/h")).error, /not a JSON object/);
  // A command the file spells with its own escapes can't be swapped in place: reported, never re-serialised.
  const escaped = text.replace(JSON.stringify(legacy), JSON.stringify(legacy).replaceAll("/", "\\/"));
  assert.match(retargetHooks(escaped, toStable("/h")).error, /can't be changed in place/);
});

// ---- on scratch projects ----

test("migrateHooks: a project and its worker's worktree move, each backed up and journalled; a second run does nothing", (t) => {
  const s = scratch(t);
  const proj = project(s.root, "proj", "w1");
  const worker = join(proj, ".claude", "worktrees", "w1");
  writeSettings(proj, v020(s.app));
  writeSettings(worker, { permissions: { allow: ["Edit"] }, hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: legacyHookCommand(s.app), timeout: 10 }] }] } });
  const before = { proj: read(settings(proj)), worker: read(settings(worker)) };
  assert.deepEqual(foldersOf([proj]).map((f) => realpathSync(f)), [proj, worker].map((f) => realpathSync(f)));

  const r = migrateHooks([proj], { appHome: s.app });
  assert.deepEqual(r.rewritten, [settings(proj), settings(worker)]);
  assert.deepEqual(r.skipped, []);
  const moved = readJson(settings(proj));
  assert.deepEqual(commands(settings(proj)), ["brain recall", hookCommand(s.app)]);
  assert.deepEqual(moved.permissions, v020(s.app).permissions);
  assert.deepEqual(moved.hooks.Stop, v020(s.app).hooks.Stop);
  assert.deepEqual(commands(settings(worker)), [hookCommand(s.app)]);
  assert.deepEqual(readJson(settings(worker)).permissions, { allow: ["Edit"] });
  assert.equal(read(settings(proj) + BACKUP_SUFFIX), before.proj, "the original, beside it");
  assert.equal(read(settings(worker) + BACKUP_SUFFIX), before.worker);
  const journal = readJson(join(s.app, "automagik-herdr", HOOKS_JOURNAL));
  assert.deepEqual(journal.hooks.map((e) => [e.file, e.before, e.after]), [
    [settings(proj), legacyHookCommand(s.app), hookCommand(s.app)],
    [settings(worker), legacyHookCommand(s.app), hookCommand(s.app)],
  ]);

  const again = migrateHooks([proj], { appHome: s.app });
  assert.deepEqual(again, { rewritten: [], skipped: [], journal: null });
  assert.equal(existsSync(`${settings(proj)}${BACKUP_SUFFIX}-2`), false, "no second backup");
  assert.deepEqual(readJson(join(s.app, "automagik-herdr", HOOKS_JOURNAL)), journal);
});

test("migrateHooks leaves and reports a file that isn't JSON, a linked file, a linked .claude and another hook shape", (t) => {
  const s = scratch(t);
  const bad = project(s.root, "bad");
  writeSettings(bad, `{ "hooks": ${JSON.stringify(legacyHookCommand(s.app))}, nope`);
  const linked = project(s.root, "linked");
  const real = join(s.root, "elsewhere.json");
  write(real, `${JSON.stringify(v020(s.app), null, 2)}\n`);
  mkdirSync(join(linked, ".claude"));
  symlinkSync(real, settings(linked));
  const dirLinked = project(s.root, "dir-linked");
  write(join(s.root, "shared-claude", "settings.local.json"), `${JSON.stringify(v020(s.app))}\n`);
  symlinkSync(join(s.root, "shared-claude"), join(dirLinked, ".claude"));
  const odd = project(s.root, "odd");
  writeSettings(odd, { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `node ${s.app}/mods/spaces-agents/briefing.mjs --quiet` }] }] } });
  const bytes = [settings(bad), real, join(s.root, "shared-claude", "settings.local.json"), settings(odd)].map(read);

  const r = migrateHooks([bad, linked, dirLinked, odd, join(s.root, "gone")], { appHome: s.app });
  assert.deepEqual(r.rewritten, []);
  assert.deepEqual(r.skipped.map((x) => x.file), [settings(bad), settings(linked), settings(dirLinked), settings(odd)]);
  assert.match(r.skipped[0].reason, /not valid JSON.*left as it is/);
  assert.match(r.skipped[1].reason, /a link/);
  assert.match(r.skipped[2].reason, /\.claude folder is a link/);
  assert.match(r.skipped[3].reason, /another shape/);
  assert.deepEqual([settings(bad), real, join(s.root, "shared-claude", "settings.local.json"), settings(odd)].map(read), bytes, "nothing written");
  assert.equal(readdirSync(join(bad, ".claude")).length, 1, "no backup of a file left alone");
  assert.equal(existsSync(join(s.app, "automagik-herdr", HOOKS_JOURNAL)), false);
});

test("a backup never replaces an earlier one", (t) => {
  const s = scratch(t);
  const proj = project(s.root, "proj");
  writeSettings(proj, v020(s.app));
  write(settings(proj) + BACKUP_SUFFIX, "earlier\n");
  const original = read(settings(proj));
  assert.deepEqual(migrateHooks([proj], { appHome: s.app }).rewritten, [settings(proj)]);
  assert.equal(read(settings(proj) + BACKUP_SUFFIX), "earlier\n");
  assert.equal(read(`${settings(proj)}${BACKUP_SUFFIX}-2`), original);
});

test("revertHooks edits only commands still holding the forward value, keeps what Claude Code wrote since, once", (t) => {
  const s = scratch(t);
  const kept = project(s.root, "kept");
  const changed = project(s.root, "changed");
  const fresh = project(s.root, "fresh");
  writeSettings(kept, v020(s.app));
  writeSettings(changed, v020(s.app));
  migrateHooks([kept, changed], { appHome: s.app });
  // Since the upgrade: Claude Code added a permission; the person pointed one hook elsewhere; a
  // new bot's Start wrote the entry point's command in a project the migration never saw.
  const k = readJson(settings(kept));
  k.permissions.allow.push("Bash(npm test)");
  writeSettings(kept, k);
  const c = readJson(settings(changed));
  c.hooks.UserPromptSubmit[1].hooks[0].command = commandFor("/mine/briefing.mjs");
  writeSettings(changed, c);
  writeSettings(fresh, { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: hookCommand(s.app), timeout: 10 }] }] } });
  const changedBytes = read(settings(changed));

  const r = revertHooks([kept, changed, fresh], { appHome: s.app });
  assert.deepEqual(r.restored.sort(), [settings(fresh), settings(kept)].sort());
  assert.deepEqual(r.skipped.map((x) => x.file), [settings(changed)]);
  assert.match(r.skipped[0].reason, /^no longer r="[^"]*\/mods\/am-sidebar\/bin\/run\.sh"; .*: left as it is$/);
  assert.deepEqual(commands(settings(kept)), ["brain recall", legacyHookCommand(s.app)]);
  assert.deepEqual(readJson(settings(kept)).permissions.allow, ["Bash(git status)", "Bash(npm test)"]);
  assert.deepEqual(commands(settings(fresh)), [legacyHookCommand(s.app)]);
  assert.equal(read(settings(changed)), changedBytes);
  assert.ok(existsSync(settings(kept) + BACKUP_SUFFIX), "the backups stay");
  assert.deepEqual(readJson(join(s.app, "automagik-herdr", HOOKS_JOURNAL)).hooks, []);
  assert.deepEqual(revertHooks([kept, changed, fresh], { appHome: s.app }).restored, [], "a second revert does nothing");
});

test("discovery: an Attach in a subfolder, the ledger's and a pane's folders; never an unknown repo root, a nested repo or a link", (t) => {
  const s = scratch(t);
  const hook = { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: legacyHookCommand(s.app), timeout: 10 }] }] } };
  // A repository whose bot was attached from a pane in packages/api (the same project key).
  const repo = project(s.root, "repo", "w1");
  const sub = join(repo, "packages", "api");
  writeSettings(sub, hook);
  // Deeper than the scan goes, but the ledger names it (a seat's folder), and a pane's folder elsewhere.
  const deep = join(repo, "a", "b", "c", "d", "e");
  writeSettings(deep, hook);
  write(join(s.app, "automagik-herdr", "workers.jsonl"), `${JSON.stringify({ event: "start", kind: "seat", worktree: deep })}\n{torn\n`);
  const pane = project(s.root, "pane-only");
  writeSettings(pane, hook);
  // Never entered: node_modules, a nested repository, a linked folder; a monorepo's root when only a subfolder is known.
  writeSettings(join(repo, "node_modules", "x"), hook);
  const nested = project(repo, "vendor/lib");
  writeSettings(nested, hook);
  writeSettings(join(s.root, "outside"), hook);
  symlinkSync(join(s.root, "outside"), join(repo, "linked"));
  const mono = project(s.root, "mono");
  writeSettings(mono, hook);
  mkdirSync(join(mono, "pkg", "a"), { recursive: true });
  const untouched = [join(repo, "node_modules", "x"), nested, join(s.root, "outside"), mono].map((d) => [d, read(settings(d))]);

  assert.deepEqual(ledgerFolders(s.app), [deep]);
  const r = migrateHooks([repo, join(mono, "pkg", "a")], { appHome: s.app, also: [...ledgerFolders(s.app), pane] });
  assert.deepEqual(r.rewritten.sort(), [settings(sub), settings(deep), settings(pane)].sort());
  for (const [dir, text] of untouched) assert.equal(read(settings(dir)), text, `${dir} left alone`);
  assert.deepEqual(revertHooks([repo, join(mono, "pkg", "a")], { appHome: s.app, also: [deep, pane] }).restored.sort(), r.rewritten.sort());
});

test("botPaneFolders: the folders of live, bot-labelled local panes; none when hc doesn't answer", () => {
  const answers = {
    "ls --json": { terminals: [{ address: "t1", state: "live" }, { address: "t2", state: "live" }, { address: "m1/t3", state: "live" }, { address: "t4", state: "exited" }] },
    "get t1 --json": { labels: { bot: "b-aaaaaaaaaa" }, cwd: "/p/sub" },
    "get t2 --json": { labels: {}, cwd: "/p/shell" },
  };
  const run = (cmd, args) => { const a = answers[args.join(" ")]; if (cmd !== "hc" || !a) throw new Error("no"); return JSON.stringify(a); };
  assert.deepEqual(botPaneFolders(run), ["/p/sub"]);
  assert.deepEqual(botPaneFolders(() => { throw new Error("no hc"); }), []);
});
test("botPaneFolders: the foreground's cwd wins over the pane's own (Attach writes the hook there)", () => {
  const answers = {
    "ls --json": { terminals: [{ address: "t1", state: "live", cwd: "/p/row" }] },
    "get t1 --json": { labels: { bot: "b-aaaaaaaaaa" }, cwd: "/p/shell", foreground: { cwd: "/p/attached" } },
  };
  const run = (cmd, args) => { const a = answers[args.join(" ")]; if (cmd !== "hc" || !a) throw new Error("no"); return JSON.stringify(a); };
  assert.deepEqual(botPaneFolders(run), ["/p/attached"]);
});

test("knownProjects: the sidebar's remembered projects (both keys) and the CLI's lists, this computer's only", (t) => {
  const s = scratch(t);
  write(join(s.app, "shared.json"), JSON.stringify({
    "am.sidebar.projects": [{ key: "/p/a" }, { key: "/p/remote", machine: "m1" }], "spaces-agents.projects": [{ key: "/p/b" }],
  }));
  write(join(s.app, "am-sidebar-projects.json"), JSON.stringify(["/p/c", "relative"]));
  write(join(s.app, "spaces-agents-projects.json"), JSON.stringify(["/p/a", "/p/d"]));
  assert.deepEqual(knownProjects(s.app, ["/p/open"]), ["/p/a", "/p/b", "/p/c", "/p/d", "/p/open"]);
});

// ---- the acceptance runs: the real pack copied into a scratch app home ----

const MAIN_ID = "b-aaaaaaaaaa";
/** A fake `hc` in sh: this terminal carries the main bot's label, and nothing else is running. */
const FAKE_HC = `#!/bin/sh
case "$1" in
  get) printf '%s' '{"address":"t1","labels":{"bot":"${MAIN_ID}"},"created_ms":1000,"parent":null,"foreground":{"argv":["claude"],"cwd":"/"},"status":{"app":"claude-code","state":"idle"}}' ;;
  ls) printf '%s' '{"machines":[],"terminals":[{"address":"t1","state":"live","status":"idle","parent":null}]}' ;;
  *) exit 1 ;;
esac
`;

/** An app home holding a copy of the pack's sidebar folder, a project with one Claude bot, and a fake hc. */
function botHome(t) {
  const s = scratch(t);
  cpSync(PACK, join(s.mods, "spaces-agents"), { recursive: true });
  const proj = project(s.root, "proj", "w1");
  write(join(proj, ".herdr", "bots.json"), JSON.stringify({
    version: 1, categories: [],
    bots: [{ id: MAIN_ID, name: "Genie", kind: "main", look: { character: "star", colour: "blue" }, role: "Runs the project", instructions: "", agent: "claude" }],
  }));
  write(join(s.app, "spaces-agents-projects.json"), JSON.stringify([proj]));
  writeSettings(proj, v020(s.app));
  const bin = join(s.root, "bin");
  write(join(bin, "hc"), FAKE_HC);
  chmodSync(join(bin, "hc"), 0o755);
  // Run once before any timing: macOS checks a new executable on its first run, which can take
  // longer than briefing.mjs's 1.5 s per call. The 2 s criterion is about the hook, not that check.
  execFileSync(join(bin, "hc"), ["ls"]);
  /** The hook as Claude Code runs it: `sh -c <command>` in the project, stdin the event, then closed.
   * Each call is a pane's first turn (what it printed is forgotten) unless `keep`. */
  const hook = (command, { input = "{}", appHome = true, keep = false } = {}) => {
    if (!keep) rmSync(join(s.app, "automagik-herdr", "briefed"), { recursive: true, force: true });
    const started = Date.now();
    const env = { PATH: `${bin}:${NODE_DIR}:/usr/bin:/bin`, HOME: s.root, HC_TERMINAL_ID: "t1", CLAUDE_PROJECT_DIR: proj };
    if (appHome) env.HERDR_APP_HOME = s.app;
    const r = spawnSync("sh", ["-c", command], { cwd: proj, input, encoding: "utf8", env });
    return { ...r, ms: Date.now() - started };
  };
  return { ...s, proj, worker: join(proj, ".claude", "worktrees", "w1"), hook };
}

test("acceptance: a v0.2.0 hook is moved and backed up; through the new command the block comes within 2 s", (t) => {
  const s = botHome(t);
  const original = read(settings(s.proj));
  const r = syncHooks({ modsDir: s.mods });
  assert.equal(r.direction, "forward");
  assert.deepEqual(r.rewritten, [settings(s.proj)]);
  assert.equal(read(stableBriefingPath(s.app)), read(join(PACK, "briefingEntry.mjs")), "the entry point is in place");
  assert.equal(statSync(stableBriefingPath(s.app)).mode & 0o777, 0o600, "made the owner's alone (RFC 0021 delivery 3)");
  assert.equal(read(settings(s.proj) + BACKUP_SUFFIX), original);
  const command = commands(settings(s.proj))[1];
  assert.equal(command, hookCommand(s.app));
  const run = s.hook(command);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^<herdr-bot>\n/, `${run.ms} ms, stderr: ${run.stderr}`);
  assert.match(run.stdout, /You are Genie, this project's main bot/);
  assert.equal(run.stderr, "");
  assert.ok(run.ms < 2000, `the block took ${run.ms} ms`);
  // As Claude Code runs it, with no HERDR_APP_HOME: the script finds its app home from its own
  // place, so the session it records lands in this scratch app home's ledger.
  const bare = s.hook(command, { appHome: false, input: JSON.stringify({ session_id: "s-1" }) });
  assert.match(bare.stdout, /You are Genie/);
  assert.match(read(ledgerPath(s.app)), /"session":"s-1"/);
});

test("the entry point runs am's copy first; a missing or broken am copy falls back to the sidebar's", (t) => {
  const s = botHome(t);
  syncHooks({ modsDir: s.mods });
  const command = commands(settings(s.proj))[1];
  // The am part's store (RFC 0012): <HOME>/.automagik/parts/automagik.am/<version>/, `current` on it.
  const part = join(s.root, ".automagik", "parts", "automagik.am");
  const sidebar = join(s.mods, "spaces-agents", "briefing.mjs");
  const working = read(sidebar);

  // No am yet (no store, then a dangling `current`): the sidebar's copy runs, silently.
  assert.match(s.hook(command).stdout, /You are Genie/);
  mkdirSync(part, { recursive: true });
  symlinkSync("3.0.0", join(part, "current"));
  const dangling = s.hook(command);
  assert.match(dangling.stdout, /You are Genie/);
  assert.equal(dangling.stderr, "");

  // A working am copy runs, not the sidebar's (broken here to prove it), and with no
  // HERDR_APP_HOME it is told the entry point's app home: its session lands in that ledger.
  cpSync(PACK, join(part, "3.0.0"), { recursive: true });
  writeFileSync(sidebar, "throw new Error('the sidebar copy ran');\n");
  const am = s.hook(command, { appHome: false, input: JSON.stringify({ session_id: "s-am" }) });
  assert.equal(am.status, 0, am.stderr);
  assert.match(am.stdout, /You are Genie/);
  assert.equal(am.stderr, "");
  assert.match(read(ledgerPath(s.app)), /"session":"s-am"/);

  // The entry point as am places it: a link to am's own copy. Run through the link with no
  // HERDR_APP_HOME, it still knows its app home from the path the hook named (node resolves the
  // link for the module itself), so am's briefing runs and the session lands in this app home.
  const entry = stableBriefingPath(s.app);
  rmSync(entry);
  symlinkSync(join(part, "current", "briefingEntry.mjs"), entry);
  const linked = s.hook(command, { appHome: false, input: JSON.stringify({ session_id: "s-linked" }) });
  assert.equal(linked.status, 0, linked.stderr);
  assert.match(linked.stdout, /You are Genie/);
  assert.equal(linked.stderr, "");
  assert.match(read(ledgerPath(s.app)), /"session":"s-linked"/);
  process.env.AM_HOME = join(s.root, ".automagik");
  try { assert.equal(syncHooks({ modsDir: s.mods }).direction, "forward", "the pack's sync leaves am's link and goes on"); } finally { delete process.env.AM_HOME; }
  assert.ok(lstatSync(entry).isSymbolicLink());

  // A broken am copy (its import throws) never silences the briefing: the sidebar's runs.
  writeFileSync(sidebar, working);
  writeFileSync(join(part, "3.0.0", "briefing.mjs"), "throw new Error('broken am');\n");
  const broken = s.hook(command);
  assert.equal(broken.status, 0, broken.stderr);
  assert.match(broken.stdout, /^<herdr-bot>\n/);
  assert.match(broken.stdout, /You are Genie/);
  assert.match(broken.stderr, /broken am/);
});

test("an am copy older than the sidebar's never shadows it; one at least as new runs first", (t) => {
  const s = botHome(t);
  syncHooks({ modsDir: s.mods });
  const command = commands(settings(s.proj))[1];
  const amDir = join(s.root, ".automagik", "parts", "automagik.am", "3.0.0");
  mkdirSync(amDir, { recursive: true });
  symlinkSync("3.0.0", join(dirname(amDir), "current"));
  writeFileSync(join(amDir, "briefing.mjs"), "process.stdout.write('am ran\\n');\n");
  const sidebarVersion = read(join(PACK, "VERSION")).trim();
  const [major, minor] = sidebarVersion.split(".").map(Number);
  const runs = (version) => {
    if (version === null) rmSync(join(amDir, "VERSION"), { force: true });
    else writeFileSync(join(amDir, "VERSION"), `${version}\n`);
    return s.hook(command);
  };
  // Older (an am that stopped updating), or with no VERSION: the sidebar's briefing runs, am's never.
  for (const version of [`${major}.${minor - 1}.999`, null]) {
    const r = runs(version);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /You are Genie/, `am at ${version}`);
    assert.doesNotMatch(r.stdout, /am ran/);
  }
  // The same version, or newer: am's runs first.
  for (const version of [sidebarVersion, `${major}.${minor + 1}.0`]) assert.equal(runs(version).stdout, "am ran\n", `am at ${version}`);
});

test("an am copy that throws after printing, reading stdin or joining: one briefing, the sidebar's, the whole input, one session row", (t) => {
  const s = botHome(t);
  syncHooks({ modsDir: s.mods });
  const command = commands(settings(s.proj))[1];
  const amDir = join(s.root, ".automagik", "parts", "automagik.am", "3.0.0");
  mkdirSync(amDir, { recursive: true });
  symlinkSync("3.0.0", join(dirname(amDir), "current"));
  // The sidebar's own version: am's copy goes first only when it is not older.
  cpSync(join(PACK, "VERSION"), join(amDir, "VERSION"));
  const once = (out) => assert.equal(out.split("<herdr-bot>").length - 1, 1, `exactly one briefing:\n${out}`);

  // It printed part of a briefing, then threw: none of it reaches the hook's output.
  writeFileSync(join(amDir, "briefing.mjs"), "process.stdout.write('<herdr-bot>\\npartial from am\\n');\nthrow new Error('am broke after printing');\n");
  const printed = s.hook(command, { input: JSON.stringify({ session_id: "s-printed" }) });
  assert.equal(printed.status, 0, printed.stderr);
  assert.match(printed.stdout, /^<herdr-bot>\n/);
  assert.match(printed.stdout, /You are Genie/);
  assert.doesNotMatch(printed.stdout, /partial from am/);
  once(printed.stdout);
  assert.match(printed.stderr, /am broke after printing/);
  assert.match(read(ledgerPath(s.app)), /"session":"s-printed"/);

  // It read the whole of stdin, then threw: the sidebar's copy still gets all of it.
  writeFileSync(join(amDir, "briefing.mjs"), [
    "let text = '';",
    "for await (const chunk of process.stdin) text += chunk;",
    "process.stdout.write(`am read ${text.length} bytes\\n`);",
    "throw new Error('am broke after reading stdin');",
  ].join("\n"));
  const consumed = s.hook(command, { input: JSON.stringify({ session_id: "s-consumed" }) });
  assert.equal(consumed.status, 0, consumed.stderr);
  assert.match(consumed.stdout, /You are Genie/);
  assert.doesNotMatch(consumed.stdout, /am read/);
  once(consumed.stdout);
  assert.match(consumed.stderr, /am broke after reading stdin/);
  assert.match(read(ledgerPath(s.app)), /"session":"s-consumed"/, "the sidebar's copy saw the hook's whole input");

  // A real am copy that joined the session and marked it briefed, then threw: the sidebar's attempt
  // still prints the briefing (the entry put back the record am wrote) and joins too, but the
  // ledger gets one session row. hc label fails here (the fake has none), so the next turn tries
  // again: still one row.
  rmSync(amDir, { recursive: true });
  cpSync(PACK, amDir, { recursive: true });
  writeFileSync(join(amDir, "briefing.mjs"), `${read(join(PACK, "briefing.mjs"))}\nthrow new Error('am broke after joining');\n`);
  const rows = () => read(ledgerPath(s.app)).split("\n").filter((l) => l.includes('"session":"s-joined"')).length;
  for (const turn of [1, 2]) {
    const joined = s.hook(command, { input: JSON.stringify({ session_id: "s-joined" }) });
    assert.equal(joined.status, 0, joined.stderr);
    once(joined.stdout);
    assert.match(joined.stderr, /am broke after joining/);
    assert.equal(rows(), 1, `turn ${turn}: one session row for s-joined`);
  }
  // The entry can't import briefingText.mjs (a copy of it sits outside mods/): it names the folder itself.
  assert.equal(BRIEFED_DIR, "automagik-herdr/briefed");
  assert.match(read(join(PACK, "briefingEntry.mjs")), /join\(process\.env\.HERDR_APP_HOME \|\| appHome, "automagik-herdr", "briefed"\)/);
});

test("an am copy that keeps failing: one briefing in three turns of one conversation; other panes' records stay as they were", (t) => {
  const s = botHome(t);
  syncHooks({ modsDir: s.mods });
  const command = commands(settings(s.proj))[1];
  const amDir = join(s.root, ".automagik", "parts", "automagik.am", "3.0.0");
  mkdirSync(dirname(amDir), { recursive: true });
  cpSync(PACK, amDir, { recursive: true });
  symlinkSync("3.0.0", join(dirname(amDir), "current"));
  const briefed = join(s.app, BRIEFED_DIR);
  const prints = (o) => { assert.equal(o.status, 0, o.stderr); return o.stdout.split("<herdr-bot>").length - 1; };
  const turns = (input) => [1, 2, 3].map(() => prints(s.hook(command, { input, keep: true })));

  // The control: a working am copy prints once in three turns.
  assert.deepEqual(turns(JSON.stringify({ session_id: "s-ok" })), [1, 0, 0]);

  // A real am copy that briefs (and records it), then throws, every turn. While it runs, another
  // pane writes its own records (a conversation's, its pane records, a temp file mid-write): none
  // of those is this hook's to put back.
  const other = { "s-other.json": "{\"hash\":\"B\",\"offset\":0}\n", "t9_5.json": "{\"hash\":\"C\",\"offset\":0}\n",
    "pane-t9_5.json": "{\"session\":\"s-other\"}\n", "s-other.json.4242.tmp": "mid-write" };
  writeFileSync(join(amDir, "briefing.mjs"), [
    read(join(PACK, "briefing.mjs")),
    "const fs = process.getBuiltinModule('node:fs');",
    `for (const [name, text] of Object.entries(${JSON.stringify(other)})) fs.writeFileSync(${JSON.stringify(briefed)} + '/' + name, text);`,
    "throw new Error('am broke after briefing');",
  ].join("\n"));
  for (const input of [JSON.stringify({ session_id: "s-bad" }), "{}"]) {
    assert.deepEqual(turns(input), [1, 0, 0], `a failing am copy, input ${input}`);
    for (const [name, text] of Object.entries(other)) assert.equal(read(join(briefed, name)), text, `${name} survives`);
  }
  // The working conversation's record is no business of the failing hooks either: still seen.
  assert.equal(prints(s.hook(command, { input: JSON.stringify({ session_id: "s-ok" }), keep: true })), 0);
});

test("migration: a hook installed before the briefing moved to launch prints it once in three turns, its settings file untouched", (t) => {
  // The command in settings.local.json runs the installed pack's briefing.mjs (through the entry
  // point or the folder's own path), so the update that replaces that script is the migration:
  // no settings file needs a rewrite for the per-turn print to stop.
  const s = botHome(t);
  syncHooks({ modsDir: s.mods });
  const before = read(settings(s.proj));
  for (const command of [commands(settings(s.proj))[1], legacyHookCommand(s.app)]) {
    rmSync(join(s.app, "automagik-herdr", "briefed"), { recursive: true, force: true });
    const input = JSON.stringify({ session_id: "s-1" });
    const outs = [1, 2, 3].map(() => s.hook(command, { input, keep: true }));
    for (const o of outs) assert.equal(o.status, 0, o.stderr);
    assert.equal(outs.filter((o) => /You are Genie/.test(o.stdout)).length, 1, command);
  }
  assert.equal(read(settings(s.proj)), before);
});

test("acceptance: after a later folder rename (simulated), the same hook still runs; a rollback to v0.3 puts v0.3's path back", (t) => {
  const s = botHome(t);
  syncHooks({ modsDir: s.mods });
  const command = commands(settings(s.proj))[1];
  // Group 7's rename, simulated: the sidebar folder becomes am-sidebar; no settings file changes.
  renameSync(join(s.mods, "spaces-agents"), join(s.mods, "am-sidebar"));
  const run = s.hook(command);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /You are Genie/);
  assert.ok(run.ms < 2000, `the block took ${run.ms} ms`);
  // The old path is gone now: it would have printed nothing.
  assert.equal(s.hook(legacyHookCommand(s.app)).stdout, "");
  const again = syncHooks({ modsDir: s.mods });
  assert.deepEqual([again.direction, again.rewritten], ["forward", []], "nothing to move after the rename");

  // A rollback to a v0.3-shaped spaces-agents (no entry point of its own): the hooks go back.
  renameSync(join(s.mods, "am-sidebar"), join(s.mods, "spaces-agents"));
  rmSync(join(s.mods, "spaces-agents", "briefingEntry.mjs"));
  const back = syncHooks({ modsDir: s.mods });
  assert.equal(back.direction, "back");
  assert.deepEqual(back.restored, [settings(s.proj)]);
  assert.deepEqual(commands(settings(s.proj)), ["brain recall", legacyHookCommand(s.app)]);
  assert.deepEqual(readJson(settings(s.proj)).permissions, v020(s.app).permissions);
  assert.match(s.hook(legacyHookCommand(s.app)).stdout, /You are Genie/);
});

test("relink: the CLI link follows the sidebar folder; --version works through it; a file or another link stays", (t) => {
  const s = scratch(t);
  cpSync(PACK, join(s.mods, "am-sidebar"), { recursive: true });
  const bin = join(s.root, "home", ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const link = join(bin, "automagik-herdr");
  symlinkSync(join(s.mods, "spaces-agents", "bin", "automagik-herdr.mjs"), link);
  const owned = new Set(["am-sidebar"]);
  assert.match(relink({ binDir: bin, modsDir: s.mods, owned }), /^linked .*automagik-herdr to /);
  // The folder ships the bin/automagik-herdr wrapper (it runs the .mjs through bin/run.sh): the link names it.
  assert.equal(readlinkSync(link), join(s.mods, "am-sidebar", "bin", "automagik-herdr"));
  const v = spawnSync(link, ["--version"], { encoding: "utf8", env: { PATH: `${NODE_DIR}:/usr/bin:/bin`, HOME: join(s.root, "home"), HERDR_APP_HOME: s.app } });
  assert.equal(v.status, 0, v.stderr);
  assert.equal(v.stdout, `am ${read(join(PACK, "VERSION")).trim()}\n`);
  assert.equal(relink({ binDir: bin, modsDir: s.mods, owned }), null, "already there");
  assert.deepEqual(readdirSync(bin).sort(), ["am", "automagik-herdr"], "am's link made beside it, no temp name left");
  // Another link, a file, nothing: left as they are.
  rmSync(link);
  symlinkSync("/usr/bin/true", link);
  assert.equal(relink({ binDir: bin, modsDir: s.mods, owned }), null);
  assert.equal(readlinkSync(link), "/usr/bin/true");
  rmSync(link);
  write(link, "#!/bin/sh\necho mine\n");
  assert.match(relink({ binDir: bin, modsDir: s.mods, owned }), /left .* alone: it is a file, not a link/);
  assert.equal(read(link), "#!/bin/sh\necho mine\n");
  rmSync(link);
  assert.equal(relink({ binDir: bin, modsDir: s.mods, owned }), null);
  assert.equal(existsSync(link), false);
});

test("relink: am's link follows the sidebar folder on a rollback, is made when missing, and a file or another link stays", (t) => {
  const s = scratch(t);
  cpSync(PACK, join(s.mods, "am-sidebar"), { recursive: true });
  const bin = join(s.root, "home", ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const am = join(bin, "am");
  const wrapper = join(s.mods, "am-sidebar", "bin", "automagik-herdr");
  const owned = new Set(["am-sidebar"]);
  // A link to the .mjs (the pack before its wrapper) moves to the wrapper, like the old name's.
  symlinkSync(join(s.mods, "am-sidebar", "bin", "automagik-herdr.mjs"), am);
  assert.match(relink({ binDir: bin, modsDir: s.mods, owned }), /^linked .*\/am to /);
  assert.equal(readlinkSync(am), wrapper);
  assert.equal(relink({ binDir: bin, modsDir: s.mods, owned }), null, "already there");
  // Missing (an install from before am's link): made.
  rmSync(am);
  assert.match(relink({ binDir: bin, modsDir: s.mods, owned }), /^linked .*\/am to /);
  assert.equal(readlinkSync(am), wrapper);
  // A link elsewhere and a file are the person's.
  rmSync(am);
  symlinkSync("/usr/bin/true", am);
  assert.equal(relink({ binDir: bin, modsDir: s.mods, owned }), null);
  assert.equal(readlinkSync(am), "/usr/bin/true");
  rmSync(am);
  write(am, "mine\n");
  assert.match(relink({ binDir: bin, modsDir: s.mods, owned }), /left .*\/am alone: it is a file/);
  assert.equal(read(am), "mine\n");
  // Not owned by the record: no link made.
  rmSync(am);
  assert.equal(relink({ binDir: bin, modsDir: s.mods, owned: new Set() }), null);
  assert.equal(lstatSync(am, { throwIfNoEntry: false }), undefined);
});

/** The pack's sidebar folder as an am-sidebar release tarball (PACK_MODS overridden), at `version`. */
function amSidebarPack(root, version) {
  const tree = join(root, `pack-${version}`);
  const dir = join(tree, "am-sidebar");
  cpSync(PACK, dir, { recursive: true });
  renameSync(join(dir, "release.js"), join(dir, "releaseFull.js"));
  write(join(dir, "release.js"), 'export * from "./releaseFull.js";\nexport const PACK_MODS = ["am-sidebar"];\n');
  write(join(dir, "VERSION"), `${version}\n`);
  const out = join(root, `automagik-herdr-pack-${version}.tgz`);
  execFileSync("tar", ["-czf", out, "-C", tree, "am-sidebar"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  return out;
}

test("update.mjs: install across the rename moves the hooks; rollback to v0.3 puts them and the CLI link back; pocket-link untouched", (t) => {
  const s = botHome(t);
  // v0.3-shaped: spaces-agents with no entry point, the record listing it, the CLI linked to it.
  rmSync(join(s.mods, "spaces-agents", "briefingEntry.mjs"));
  write(join(s.app, "automagik-herdr", "installed-by-install.sh"), "version=0.3.0\nmods=spaces-agents\nbefore=none\n");
  write(join(s.mods, "pocket-link", ".state", "pairing.key"), "secret\n");
  writeSettings(s.worker, { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: legacyHookCommand(s.app), timeout: 10 }] }] } });
  const home = join(s.root, "home");
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const link = join(bin, "automagik-herdr");
  const env = { HOME: home, PATH: `${NODE_DIR}:/usr/bin:/bin`, AUTOMAGIK_HERDR_NO_UPDATE: "1" };
  const cli = (...args) => spawnSync(process.execPath, [UPDATE, ...args, "--mods", s.mods], { env, encoding: "utf8" });

  const tgz = amSidebarPack(s.root, "9.9.9");
  const installed = cli("install", "--from", tgz, "--version", "9.9.9");
  assert.equal(installed.status, 0, installed.stderr);
  assert.ok(existsSync(join(s.mods, "am-sidebar", "briefing.mjs")) && !existsSync(join(s.mods, "spaces-agents")));
  assert.deepEqual(commands(settings(s.proj)), ["brain recall", hookCommand(s.app)]);
  assert.deepEqual(commands(settings(s.worker)), [hookCommand(s.app)], "the worker's worktree too");
  // The notice, last: each rewritten file with its project, running sessions, unknown projects.
  const said = installed.stderr.split("\n").filter((l) => l.startsWith("notice: ")).map((l) => l.slice(8));
  assert.match(said[0], /^IMPORTANT: the bots' briefing hook moved to a new path in 2 settings files:$/);
  for (const dir of [s.proj, s.worker]) assert.ok(said.includes(`  ${dir}: ${settings(dir)}`), `${dir} is listed: ${said.join("\n")}`);
  assert.ok(said.some((l) => /keeps the OLD hook and gets NO briefing until it is restarted\. Restart the bot: am restart <bot> \(or the bot row's Restart\)/.test(l)));
  assert.ok(said.some((l) => /not rewritten .*am start <bot>.*am attach <bot>/.test(l)));
  assert.ok(installed.stderr.trimEnd().endsWith(said.at(-1)), "the notice is the last thing logged");
  const viaEntry = s.hook(hookCommand(s.app));
  assert.match(viaEntry.stdout, /You are Genie/, `the hook runs am-sidebar's briefing (${viaEntry.ms} ms, stderr: ${viaEntry.stderr})`);

  // install.sh would link the CLI to am-sidebar's wrapper; the rollback points it back.
  symlinkSync(join(s.mods, "am-sidebar", "bin", "automagik-herdr"), link);
  const back = cli("rollback");
  assert.equal(back.status, 0, back.stderr);
  assert.match(back.stderr, /^notice: IMPORTANT: the bots' briefing hook went back to the older release's path in 2 settings files:$/m);
  assert.match(back.stderr, /^notice: A Claude session already running in those projects keeps the hook it loaded/m);
  assert.ok(existsSync(join(s.mods, "spaces-agents", "briefing.mjs")) && !existsSync(join(s.mods, "am-sidebar")));
  assert.deepEqual(commands(settings(s.proj)), ["brain recall", legacyHookCommand(s.app)]);
  assert.deepEqual(commands(settings(s.worker)), [legacyHookCommand(s.app)]);
  assert.deepEqual(readJson(settings(s.proj)).permissions, v020(s.app).permissions);
  // The kept spaces-agents (this checkout's) ships the wrapper too: the link names it.
  assert.equal(readlinkSync(link), join(s.mods, "spaces-agents", "bin", "automagik-herdr"));
  const v = spawnSync(link, ["--version"], { encoding: "utf8", env: { PATH: `${NODE_DIR}:/usr/bin:/bin`, HOME: home, HERDR_APP_HOME: s.app } });
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, /^am \d+\.\d+\.\d+\n$/);
  assert.equal(read(join(s.mods, "pocket-link", ".state", "pairing.key")), "secret\n");
  assert.deepEqual(readdirSync(join(s.mods, "pocket-link")), [".state"]);
});

test("revertHooks: a direct hook (written with no entry point to place) goes back to v0.3's path too", (t) => {
  const s = scratch(t);
  const proj = project(s.root, "direct");
  writeSettings(proj, { permissions: { allow: ["Edit"] }, hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: directHookCommand(s.app), timeout: 10 }] }] } });
  assert.match(directHookCommand(s.app), /\/mods\/am-sidebar\/briefing\.mjs"$/);
  const r = revertHooks([proj], { appHome: s.app });
  assert.deepEqual(r.restored, [settings(proj)]);
  assert.deepEqual(commands(settings(proj)), [legacyHookCommand(s.app)]);
  assert.deepEqual(readJson(settings(proj)).permissions, { allow: ["Edit"] });
  assert.deepEqual(revertHooks([proj], { appHome: s.app }).restored, [], "nothing the second time");
});

test("hooksNotice: every file with its project, the running sessions, unknown projects; nothing when nothing moved", () => {
  const files = ["/p/a/.claude/settings.local.json", "/p/b/sub/.claude/settings.local.json"];
  const forward = hooksNotice({ direction: "forward", rewritten: files, skipped: [] });
  assert.deepEqual(forward.slice(0, 3), ["IMPORTANT: the bots' briefing hook moved to a new path in 2 settings files:",
    `  /p/a: ${files[0]}`, `  /p/b/sub: ${files[1]}`]);
  assert.match(forward[3], /running .* keeps the OLD hook and gets NO briefing until it is restarted\. Restart the bot: am restart <bot> \(or the bot row's Restart\)\.$/);
  assert.match(forward[4], /^Projects the pack doesn't know about were not rewritten/);
  const back = hooksNotice({ direction: "back", restored: [files[0]], skipped: [] });
  assert.equal(back[0], "IMPORTANT: the bots' briefing hook went back to the older release's path in 1 settings file:");
  assert.equal(back.length, 3, "no unknown-projects line on the way back");
  for (const none of [null, undefined, { direction: null, skipped: [] }, { direction: "forward", rewritten: [], skipped: [] },
    { direction: "back", restored: [], skipped: [], crossed: true }]) assert.deepEqual(hooksNotice(none), []);
  // Across the rename with nothing rewritten: still the warning, and both lines.
  const silent = hooksNotice({ direction: "forward", rewritten: [], skipped: [], crossed: true });
  assert.equal(silent.length, 3);
  assert.match(silent[0], /^IMPORTANT: the sidebar moved to a new folder, and no settings file's briefing hook was rewritten/);
  assert.match(silent[1], /a bot's project keeps the OLD hook and gets NO briefing/);
  assert.match(silent[2], /^Projects the pack doesn't know about were not rewritten/);
});
