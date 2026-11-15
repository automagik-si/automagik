// automagik-herdr, the command line (A11): every subcommand run as a program against scratch git
// projects under $TMPDIR, with a fake `hc` first on PATH (test/fake-hc.mjs) that records
// each call and answers from a state file, and a fake `herdr-app` (test/fake-herdr-app.mjs; no
// window unless a test opens one). The real hc and window are never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { checkBots, parseBots } from "../mods/am-sidebar/model.js";
import { writeBotsFile, findBot, CliError, listProject, causeLine } from "../mods/am-sidebar/bin/automagik-herdr.mjs";
import { GUARD_DIR, KILL_GUARD_DIR, ledgerPath, readLedger } from "../mods/am-sidebar/workers.js";
import { AGY_FIXED_DENY, AGY_SHELL_READ, agySettingsDir, agySettingsFile, withoutBriefing } from "../mods/am-sidebar/models.js";
import { WORKER_LINE, amPartHookCommand } from "../mods/am-sidebar/briefingText.mjs";
import { restartAnswer } from "../mods/am-sidebar/restart.js";
// Start and Restart put each bot's briefing in its agent's command (models.js withBriefing);
// the tests on the rest of the command compare it with those words out.
const strip = (words) => withoutBriefing("codex", withoutBriefing("claude", words));
const plain = (argv) => { const i = argv.indexOf("--"); return i < 0 ? strip(argv) : [...argv.slice(0, i + 1), ...strip(argv.slice(i + 1))]; };
// #1125: Codex's launch mode, spelled out, and a Codex run's --add-dir grants taken apart from its
// other words (the tool-cache grants follow the runner's environment, so tests compare the words).
const CODEX_MODE = ["--approve-for-me", "--disable", "hooks", "--no-daemon", "-c", "sandbox_workspace_write.network_access=true"];
const grantsApart = (words) => {
  const rest = [];
  const dirs = [];
  for (let i = 0; i < words.length; i += 1) {
    if (words[i] === "--add-dir") dirs.push(words[++i]);
    else rest.push(words[i]);
  }
  return { words: rest, dirs };
};
const codexWords = (words) => grantsApart(words).words;
// #823: an Antigravity launch's own permission file, and its words without those two.
const agySettingsPath = (s, botId, tail = "seat") => join(s.app, "automagik-herdr/agy-settings", `${botId}-${tail}.json`);
const withoutSettings = (words) => {
  const i = words.indexOf("--settings");
  return i < 0 ? words : [...words.slice(0, i), ...words.slice(i + 2)];
};
/**
 * A fresh Claude command's words with the `--session-id <uuid>` RFC 0021 adds checked and taken
 * out (exactly one, a UUID, last); any other command as it is.
 */
const SID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const freshClaude = (words) => {
  const i = words.indexOf("--session-id");
  if (i < 0) return words;
  assert.match(words[i + 1] ?? "", SID_SHAPE);
  assert.equal(words.lastIndexOf("--session-id"), i, "one --session-id");
  return [...words.slice(0, i), ...words.slice(i + 2)];
};
import { attachPath as attachFile, foldAttach as foldRows, readAttach as readRows } from "../mods/am-sidebar/attach.js";
import { readJsonLines } from "./log-lines.mjs";
import { assertScratchProject, scratchProject, scratchRoot, warnTmpdir } from "./scratch-project.mjs";

const CLI = new URL("../mods/am-sidebar/bin/automagik-herdr.mjs", import.meta.url).pathname;
// AUTOMAGIK_HERDR_TEST_RUNTIME=<bun or node path> runs the CLI with that runtime instead.
const RUNTIME = process.env.AUTOMAGIK_HERDR_TEST_RUNTIME || process.execPath;
const FAKE_HC = new URL("./fake-hc.mjs", import.meta.url).pathname;
const FAKE_APP = new URL("./fake-herdr-app.mjs", import.meta.url).pathname;
const FAKE_PGREP = new URL("./fake-pgrep.mjs", import.meta.url).pathname;
const FAKE_AGY = new URL("./fake-agy.mjs", import.meta.url).pathname;
const FAKE_GIT = new URL("./fake-git-trim.mjs", import.meta.url).pathname;
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const ID = { main: "b-aaaaaaaaaa", cap: "b-bbbbbbbbbb", dev: "b-cccccccccc", plan: "b-eeeeeeeeee" };

test("Hermes pairing CLI persists explicit identity, rejects duplicates and unpairs without deleting the Bot", (t) => {
  const s = scene(t);
  const made = s.cli(["create", "--name", "Research", "--agent", "hermes", "--hermes-home", "/srv/sample-hermes", "--hermes-profile", "research", "--json"]);
  assert.equal(made.code, 0, made.err);
  const file = JSON.parse(readFileSync(join(s.project, ".herdr/bots.json"), "utf8"));
  const bot = file.bots[0];
  assert.deepEqual(bot.hermes, { home: "/srv/sample-hermes", profile: "research" });
  const duplicate = s.cli(["create", "--name", "Twin", "--agent", "hermes", "--hermes-home", "/srv/sample-hermes", "--hermes-profile", "research"]);
  assert.notEqual(duplicate.code, 0);
  assert.match(duplicate.err, /already paired/);
  const cleared = s.cli(["edit", bot.id, "--no-hermes"]);
  assert.equal(cleared.code, 0, cleared.err);
  const after = JSON.parse(readFileSync(join(s.project, ".herdr/bots.json"), "utf8"));
  assert.equal(after.bots.length, 1);
  assert.equal(after.bots[0].hermes, undefined);
});

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
const exe = (path, text) => { writeFileSync(path, text); chmodSync(path, 0o755); };

/** A scratch world: a git project, a fake hc, a fake home and app home. `trimsGit`: a git whose
 * stdout is trimmed, as a Herdr exec would answer the rule (#626, #665). */
function scene(t, { terminals = [], briefing = true, amPart = false, window = { down: true }, trimsGit = false, isGit = true } = {}) {
  const root = scratchRoot(t, "hb-cli-");
  const project = scratchProject(root, "proj", { isGit, commit: isGit });
  const bin = join(root, "bin");
  mkdirSync(bin);
  exe(join(bin, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  exe(join(bin, "herdr-app"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_APP}" "$@"\n`);
  // The spare shell's children: never the host's processes.
  exe(join(bin, "pgrep"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_PGREP}" "$@"\n`);
  if (trimsGit) exe(join(bin, "git"), `#!/bin/sh\nREAL_GIT="${REAL_GIT}" exec "${process.execPath}" "${FAKE_GIT}" "$@"\n`);
  exe(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
  exe(join(bin, "codex"), "#!/bin/sh\nexit 0\n");
  // A stand-in agy (#793): its model table comes from the 1.5.3 fixture, never the host's CLI.
  exe(join(bin, "agy"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_AGY}" "$@"\n`);
  const agyLog = join(root, "agy.log");
  writeFileSync(agyLog, "");
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".config/herdr-app"), { recursive: true });
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ model: "sonnet" }));
  // The am part's installed store (RFC 0012), for a CLI-only host: no pack under the app home.
  if (amPart) {
    const store = join(home, ".automagik", "parts", "automagik.am", "current");
    mkdirSync(join(store, "bin"), { recursive: true });
    writeFileSync(join(store, "bin", "run.sh"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(store, "briefingEntry.mjs"), "// am's entry\n");
    writeFileSync(join(store, "briefing.mjs"), "// am's briefing\n");
  }
  const app = join(root, "app");
  mkdirSync(join(app, "mods/am-sidebar"), { recursive: true });
  if (briefing) writeFileSync(join(app, "mods/am-sidebar/briefing.mjs"), "// stand-in\n");
  const statePath = join(root, "hc.json");
  const logPath = join(root, "hc.log");
  writeFileSync(statePath, JSON.stringify({ terminals, next: 100 }));
  writeFileSync(logPath, "");
  const appState = join(root, "herdr-app.json"), appLog = join(root, "herdr-app.log");
  writeFileSync(appState, JSON.stringify(window));
  writeFileSync(appLog, "");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, HERDR_APP_HOME: app, HC_FAKE_STATE: statePath, HC_FAKE_LOG: logPath,
    HERDR_APP_FAKE_STATE: appState, HERDR_APP_FAKE_LOG: appLog, AUTOMAGIK_HERDR_TAB_WAIT_MS: "300", AGY_FAKE_LOG: agyLog, GIT_CEILING_DIRECTORIES: root };
  delete env.HC_TERMINAL_ID;
  delete env.HERMES_HOME; // a runner's own hermes home must not decide the hermes tests
  const cli = (args, { cwd = project, input, env: extra = {} } = {}) => {
    const r = spawnSync(RUNTIME, [CLI, ...args], { cwd, env: { ...env, ...extra }, input, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
  };
  const cliAsync = (args, { env: extra = {} } = {}) => new Promise((resolve) => {
    execFile(RUNTIME, [CLI, ...args], { cwd: project, env: { ...env, ...extra }, encoding: "utf8" }, (e, out, err) => resolve({ code: e ? e.code : 0, out, err }));
  });
  const calls = () => readJsonLines(logPath);
  const agyCalls = () => readFileSync(agyLog, "utf8").split("\n").filter(Boolean);
  const hcState = () => JSON.parse(readFileSync(statePath, "utf8"));
  const appCalls = () => readJsonLines(appLog);
  const windowNow = () => JSON.parse(readFileSync(appState, "utf8"));
  const botsPath = join(project, ".herdr/bots.json");
  const bots = () => JSON.parse(readFileSync(botsPath, "utf8"));
  const seed = (file) => { mkdirSync(join(project, ".herdr"), { recursive: true }); writeFileSync(botsPath, `${JSON.stringify(file, null, 2)}\n`); };
  return { root, project, app, home, env, cli, cliAsync, calls, agyCalls, hcState, appCalls, windowNow, bots, botsPath, seed };
}

const bot = (id, kind, extra = {}) => ({ id, name: `Bot ${id.slice(2, 4)}`, kind, look: { character: "star", colour: "blue" }, role: "r", instructions: "i", agent: "claude", ...extra });
const team = (extra = {}) => ({
  version: 1,
  categories: [{ id: "eng", title: "Engineering" }],
  bots: [
    bot(ID.main, "main", { name: "Genie" }),
    bot(ID.cap, "member", { name: "Captain", category: "eng" }),
    bot(ID.dev, "member", { name: "Dev", lead: ID.cap }),
    bot(ID.plan, "member", { name: "Studio", agent: undefined, planned: { wave: 3, note: "later" } }),
  ],
  ...extra,
});
/** An `hc get` answer for a terminal. */
const term = (address, { bot: b, argv = ["claude"], cwd = "/x", app = "claude-code", state = "live", created = 1, parent = null, msg, status = "idle" } = {}) => ({
  address, name: address, cwd, state, parent, created_ms: created, labels: b ? { bot: b } : {},
  foreground: { argv, cwd }, status: { app, state: status, ...(msg ? { msg } : {}) },
});
const runCall = (calls) => calls.find((c) => c[0] === "run");
/**
 * What an hc run call runs: the words after `--`, past the `/usr/bin/env PATH=…` every pane gets
 * (#213), a Claude pane's `-u CLAUDE_CONFIG_DIR` before it (the default login, #453) and every
 * other env word after PATH (a Hermes briefing's, the CLI's HERDR_APP_HOME, #650). `prefix` is
 * `/usr/bin/env` and that login pair when it is there, `env` the NAME=value words and `words` the
 * program on. A row that cares about an env word asserts `env`, so a lost or leaked one fails.
 */
const agentParts = (run) => {
  const w = run.slice(run.indexOf("--") + 1);
  const at = w[1] === "-u" && w[2] === "CLAUDE_CONFIG_DIR" ? 3 : 1;
  if (w[0] !== "/usr/bin/env" || !w[at]?.startsWith("PATH=")) return { prefix: [], env: [], words: w };
  let i = at;
  while (i < w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i])) i += 1;
  // A sandboxed dsh-tui pane runs through the per-pane hc helper (#631 PR B): the agent's words
  // are after the helper's own `--`.
  let words = w.slice(i);
  const helper = words.findIndex((word) => /\/hcPane\.mjs$/.test(word));
  if (helper >= 0) {
    const cut = words.indexOf("--", helper);
    words = cut < 0 ? [] : words.slice(cut + 1);
  }
  return { prefix: w.slice(0, at), env: w.slice(at, i), words };
};
const agentWords = (run) => agentParts(run).words;
const labelCalls = (calls) => calls.filter((c) => c[0] === "label");

// ---- create ----

test("paired Hermes restart resumes when stopped or beside a different paired bot", (t) => {
  for (const live of [false, true]) {
    const s = scene(t);
    exe(join(s.root, "bin/hermes"), "#!/bin/sh\nexit 0\n");
    s.seed(team({ bots: [
      bot(ID.main, "main", { name: "Research", agent: "hermes", hermes: { home: "/srv/research", profile: "default" } }),
      bot(ID.cap, "member", { name: "Other", agent: "hermes", hermes: { home: "/srv/other", profile: "default" } }),
    ] }));
    const terminals = [term("t2", { bot: ID.cap, argv: ["hermes"], cwd: s.project, app: "hermes" }),
      ...(live ? [term("t1", { bot: ID.main, argv: ["hermes"], cwd: s.project, app: "hermes" })] : [])];
    writeFileSync(s.env.HC_FAKE_STATE, JSON.stringify({ terminals, next: 100 }));
    const result = s.cli(["restart", "Research", "--json"]);
    assert.equal(result.code, 0, result.err);
    const launch = runCall(s.calls());
    assert.deepEqual(agentWords(launch), ["hermes", "--profile", "default", "--tui", "--continue", "Bot Chat"]);
    assert.ok(agentParts(launch).env.includes("HERMES_HOME=/srv/research"));
    assert.doesNotMatch(result.err, /latest conversation|restart again with --fresh/);
  }
});

test("create: the first bot must be main; then the main bot is written with an id, a default look and the agent", (t) => {
  const s = scene(t);
  const refused = s.cli(["create", "--name", "Dev", "--agent", "claude", "--kind", "member"]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /first bot in a project must be its main bot/);
  assert.equal(existsSync(s.botsPath), false, "nothing written");
  const made = s.cli(["create", "--name", "Genie", "--agent", "claude", "--role", "runs the team"]);
  assert.equal(made.code, 0, made.err);
  const id = made.out.trim();
  assert.match(id, /^b-[a-z2-7]{10}$/);
  const file = s.bots();
  assert.deepEqual(checkBots(file), []);
  assert.equal(file.bots[0].id, id);
  assert.equal(file.bots[0].kind, "main");
  assert.equal(file.bots[0].role, "runs the team");
  assert.equal(file.bots[0].instructions, "");
  assert.ok(file.bots[0].look.character && file.bots[0].look.colour);
  // A second bot defaults to member; a second main is refused.
  assert.equal(s.cli(["create", "--name", "Two", "--agent", "codex"]).code, 0);
  assert.equal(s.bots().bots[1].kind, "member");
  const twoMains = s.cli(["create", "--name", "Three", "--agent", "claude", "--kind", "main"]);
  assert.equal(twoMains.code, 1);
  assert.match(twoMains.err, /already has a main bot, Genie/);
});

// #234, RFC 0014 Q16: an edit made from a worktree is written in that worktree, so the main
// checkout stays clean for the merge's git pull; reads (ls, the project key) stay on the main checkout.
test("create and edit from a worktree write that worktree's file; the main checkout stays clean and is still what ls reads", (t) => {
  const s = scene(t);
  s.seed(team());
  git(s.project, "add", ".herdr/bots.json");
  git(s.project, "commit", "-q", "-m", "bots");
  const mainText = readFileSync(s.botsPath, "utf8");
  const wt = join(s.root, "wt");
  git(s.project, "worktree", "add", "-q", wt);
  const wtPath = join(wt, ".herdr/bots.json");
  const wtBots = () => JSON.parse(readFileSync(wtPath, "utf8")).bots;
  // From the worktree's folder (a subfolder of it too): its file, the project still the main checkout.
  mkdirSync(join(wt, "src"));
  const r = s.cli(["create", "--name", "Scout", "--agent", "claude", "--lead", ID.cap, "--json"], { cwd: join(wt, "src") });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().project, s.project);
  assert.match(r.err, new RegExp(`saved in ${wtPath}.*read ${s.botsPath}`));
  const scout = r.json().id;
  assert.deepEqual(wtBots().map((b) => b.name), ["Genie", "Captain", "Dev", "Studio", "Scout"]);
  assert.equal(readFileSync(s.botsPath, "utf8"), mainText, "the main checkout's file is untouched");
  assert.equal(git(s.project, "status", "--porcelain"), "", "the main checkout stays clean for git pull");
  // Reads stay on the main checkout: ls from the worktree shows its file, without Scout.
  const ls = s.cli(["ls", "--json"], { cwd: wt }).json().projects[0];
  assert.equal(ls.project, s.project);
  assert.ok(!ls.bots.some((b) => b.id === scout));
  // show and start read the main checkout, which hasn't Scout yet: the refusal names both files.
  for (const cmd of ["show", "start"]) {
    const no = s.cli([cmd, scout], { cwd: wt });
    assert.equal(no.code, 1, `${cmd}: ${no.err}`);
    assert.match(no.err, new RegExp(`No bot "${scout}" in ${s.botsPath}, which this command reads; it is in ${wtPath} \\(this worktree\\)`));
  }
  assert.equal(git(s.project, "status", "--porcelain"), "", "the main checkout stays clean");
  // A second edit from the same worktree starts from (and checks) the worktree's file: Scout is kept.
  const e = s.cli(["edit", scout, "--role", "scouting"], { cwd: wt });
  assert.equal(e.code, 0, e.err);
  const again = s.cli(["create", "--name", "Ranger", "--agent", "claude", "--lead", ID.cap], { cwd: wt });
  assert.equal(again.code, 0, again.err);
  assert.deepEqual(wtBots().map((b) => b.name), ["Genie", "Captain", "Dev", "Studio", "Scout", "Ranger"], "both worktree edits kept");
  assert.equal(wtBots().find((b) => b.id === scout).role, "scouting");
  // --project <worktree>, run from elsewhere: the worktree's file too.
  const named = s.cli(["category", "add", "ops", "--title", "Ops", "--project", wt], { cwd: s.root });
  assert.equal(named.code, 0, named.err);
  assert.ok(JSON.parse(readFileSync(wtPath, "utf8")).categories.some((c) => c.title === "Ops"));
  assert.equal(readFileSync(s.botsPath, "utf8"), mainText);
  assert.equal(git(s.project, "status", "--porcelain"), "");
  // From the main checkout: its own file, as before, with no note.
  const home = s.cli(["edit", ID.dev, "--role", "builds"]);
  assert.equal(home.code, 0, home.err);
  assert.doesNotMatch(home.err, /saved in/);
  assert.equal(s.bots().bots.find((b) => b.id === ID.dev).role, "builds");
  assert.ok(!wtBots().some((b) => b.id === ID.dev && b.role === "builds"), "the worktree's file is left alone");
});

test("a worktree with no bots.json of its own: the first edit starts from the main checkout's, written whole in the worktree", (t) => {
  const s = scene(t);
  const wt = join(s.root, "wt");
  git(s.project, "worktree", "add", "-q", wt);
  s.seed(team()); // the main checkout's file, not committed: the worktree has none
  const mainText = readFileSync(s.botsPath, "utf8");
  const wtPath = join(wt, ".herdr/bots.json");
  const r = s.cli(["create", "--name", "Scout", "--agent", "claude", "--lead", ID.cap, "--project", wt, "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().project, s.project);
  const written = readFileSync(wtPath, "utf8");
  assert.deepEqual(JSON.parse(written).bots.map((b) => b.name), ["Genie", "Captain", "Dev", "Studio", "Scout"]);
  assert.deepEqual(JSON.parse(written).categories, team().categories);
  assert.equal(written, `${JSON.stringify(JSON.parse(written), null, 2)}\n`, "the same format as any save");
  assert.equal(readFileSync(s.botsPath, "utf8"), mainText);
  // The main checkout's file was never committed: the note says its pull would stop on it.
  assert.match(r.err, new RegExp(`${s.botsPath} isn't committed: commit or remove it before pulling, or the pull stops on it`));
  // The second edit's guard checks the worktree's file (now there), not the main checkout's text.
  const e = s.cli(["edit", r.json().id, "--role", "scouting"], { cwd: wt });
  assert.equal(e.code, 0, e.err);
  assert.equal(JSON.parse(readFileSync(wtPath, "utf8")).bots.find((b) => b.name === "Scout").role, "scouting");
  assert.equal(readFileSync(s.botsPath, "utf8"), mainText);
  // The worktree's change merged: as warned, git stops on the untracked file; removed first, it goes in.
  git(wt, "add", ".herdr/bots.json");
  git(wt, "commit", "-q", "-m", "bots");
  assert.throws(() => execFileSync("git", ["merge", "-q", "wt"], { cwd: s.project, encoding: "utf8", stdio: "pipe" }),
    (err) => /untracked working tree files would be overwritten/.test(String(err.stderr)));
  rmSync(s.botsPath);
  git(s.project, "merge", "-q", "wt");
  assert.equal(git(s.project, "status", "--porcelain"), "");
  assert.equal(JSON.parse(readFileSync(s.botsPath, "utf8")).bots.find((b) => b.name === "Scout").role, "scouting");
  // Committed, the main checkout's file draws no warning.
  const after = s.cli(["edit", r.json().id, "--role", "ranging"], { cwd: wt });
  assert.equal(after.code, 0, after.err);
  assert.match(after.err, /saved in /);
  assert.doesNotMatch(after.err, /isn't committed/);
});

// #332, a follow-up to #234: a pull stops on the main checkout's committed bots.json too once
// it has local changes, not only on an untracked one; the note warns for either.
test("a worktree edit warns when the main checkout's bots.json has local changes, and the pull stops on it", (t) => {
  const s = scene(t);
  s.seed(team());
  git(s.project, "add", ".herdr/bots.json");
  git(s.project, "commit", "-q", "-m", "bots");
  const committed = readFileSync(s.botsPath, "utf8");
  const wt = join(s.root, "wt");
  git(s.project, "worktree", "add", "-q", wt);
  // An edit made on the main checkout (allowed by design), not committed: the file is tracked.
  const file = JSON.parse(committed);
  file.bots.find((b) => b.id === ID.dev).role = "local edit";
  writeFileSync(s.botsPath, `${JSON.stringify(file, null, 2)}\n`);
  assert.match(git(s.project, "status", "--porcelain"), /^ M \.herdr\/bots\.json$/m);
  // An edit from the worktree warns: a pull bringing it home stops on the main checkout's changes.
  const r = s.cli(["create", "--name", "Scout", "--agent", "claude", "--lead", ID.cap], { cwd: wt });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, new RegExp(`${s.botsPath} has local changes: commit or discard them before pulling, or the pull stops on it`));
  assert.doesNotMatch(r.err, /isn't committed/);
  // The worktree's change merged: git stops on the local changes; discarded, it goes in.
  git(wt, "add", ".herdr/bots.json");
  git(wt, "commit", "-q", "-m", "scout");
  assert.throws(() => execFileSync("git", ["merge", "-q", "wt"], { cwd: s.project, encoding: "utf8", stdio: "pipe" }),
    (err) => /Your local changes to the following files would be overwritten/.test(String(err.stderr)));
  writeFileSync(s.botsPath, committed);
  git(s.project, "merge", "-q", "wt");
  assert.equal(git(s.project, "status", "--porcelain"), "");
  assert.ok(s.bots().bots.some((b) => b.name === "Scout"));
  // Committed and clean, the main checkout's file draws no warning.
  const after = s.cli(["edit", ID.dev, "--role", "ranging"], { cwd: wt });
  assert.equal(after.code, 0, after.err);
  assert.match(after.err, /saved in /);
  assert.doesNotMatch(after.err, /isn't committed|has local changes/);
});

// #332 low: a committed bots.json deleted in the main checkout's working tree without staging
// (` D`) is not "local changes" and the pull does not stop: it restores the file with the
// worktree's version. Only the unstaged deletion gets this state.
test("a worktree edit says the main checkout's bots.json is deleted, and the pull restores it with the worktree's version", (t) => {
  const s = scene(t);
  s.seed(team());
  git(s.project, "add", ".herdr/bots.json");
  git(s.project, "commit", "-q", "-m", "bots");
  const wt = join(s.root, "wt");
  git(s.project, "worktree", "add", "-q", wt);
  const wtPath = join(wt, ".herdr/bots.json");
  rmSync(s.botsPath);
  assert.equal(git(s.project, "status", "--porcelain"), " D .herdr/bots.json\n");
  // An edit from the worktree warns that the file is deleted, not that it has local changes.
  const r = s.cli(["create", "--name", "Scout", "--agent", "claude", "--lead", ID.cap], { cwd: wt });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, new RegExp(`saved in ${wtPath} \\(this worktree\\); ls, whois and the sidebar read ${s.botsPath} until that change is merged there`));
  assert.match(r.err, new RegExp(`${s.botsPath} is deleted: `));
  assert.match(r.err, /brings it back with this worktree's version/);
  assert.doesNotMatch(r.err, /modified|has local changes|isn't committed|stops on it/);
  // The worktree's change merged: no stop; the main checkout's file comes back with its version.
  git(wt, "add", ".herdr/bots.json");
  git(wt, "commit", "-q", "-m", "scout");
  git(s.project, "merge", "-q", "wt");
  assert.equal(git(s.project, "status", "--porcelain"), "");
  assert.equal(readFileSync(s.botsPath, "utf8"), readFileSync(join(wt, ".herdr/bots.json"), "utf8"));
  assert.ok(s.bots().bots.some((b) => b.name === "Scout"));
});

// #665: a Herdr whose exec trims stdout gives the rule " D" without its leading space. The
// CLI's runProgram does not trim, so this feeds it a git that does: porcelain v2's explicit
// state field keeps the deletion deleted (a v1 two-byte read would say modified).
test("a trimmed git status answer still reads the main checkout's deleted bots.json (porcelain v2)", (t) => {
  const s = scene(t, { trimsGit: true });
  s.seed(team());
  git(s.project, "add", ".herdr/bots.json");
  git(s.project, "commit", "-q", "-m", "bots");
  const wt = join(s.root, "wt");
  git(s.project, "worktree", "add", "-q", "-b", "wt", wt);
  rmSync(s.botsPath);
  assert.equal(git(s.project, "status", "--porcelain"), " D .herdr/bots.json\n", "the real answer has the leading space a trim eats");
  const r = s.cli(["create", "--name", "Scout", "--agent", "claude", "--lead", ID.cap], { cwd: wt });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, new RegExp(`${s.botsPath} is deleted: `));
  assert.match(r.err, /a merge pull brings it back with this worktree's version/);
  assert.doesNotMatch(r.err, /has local changes|isn't committed/);
});

// #626: the deleted note assumed a merge pull. With pull.rebase=true git refuses an unstaged
// deletion instead, so the note names both modes; #665: with rebase.autoStash off it says that.
test("a worktree edit names the rebase pull mode for the main checkout's deleted bots.json (rebase.autoStash off)", (t) => {
  const s = scene(t);
  s.seed(team());
  git(s.project, "add", ".herdr/bots.json");
  git(s.project, "commit", "-q", "-m", "bots");
  const wt = join(s.root, "wt");
  git(s.project, "worktree", "add", "-q", "-b", "wt", wt);
  git(s.project, "config", "pull.rebase", "true");
  git(s.project, "config", "rebase.autoStash", "false");
  rmSync(s.botsPath);
  assert.equal(git(s.project, "status", "--porcelain"), " D .herdr/bots.json\n");
  const r = s.cli(["create", "--name", "Scout", "--agent", "claude", "--lead", ID.cap], { cwd: wt });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, new RegExp(`${s.botsPath} is deleted: a merge pull brings it back with this worktree's version`));
  assert.match(r.err, /pull\.rebase=true refuses the pull until the deletion is committed or discarded/);
  assert.doesNotMatch(r.err, /autoStash/);
  assert.doesNotMatch(r.err, /a pull here brings it back/);
  // As the note says: the rebase pull refuses while the deletion is unstaged, the file stays gone.
  git(wt, "add", ".herdr/bots.json");
  git(wt, "commit", "-q", "-m", "scout");
  assert.throws(() => git(s.project, "pull", ".", "wt"),
    (err) => /cannot pull with rebase: You have unstaged changes/.test(String(err.stderr)));
  assert.equal(existsSync(s.botsPath), false);
  // And as it says of a merge pull: that one brings the file back with the worktree's version.
  git(s.project, "pull", "-q", "--no-rebase", ".", "wt");
  assert.equal(git(s.project, "status", "--porcelain"), "");
  assert.ok(s.bots().bots.some((b) => b.name === "Scout"));
});

// #665: with rebase.autoStash=true git stashes the unstaged deletion and lets the rebase pull
// through; the stash apply then conflicts (UD), so the note says that instead of "refuses".
test("a worktree edit says rebase.autoStash stashes the deleted bots.json and the stash apply conflicts", (t) => {
  const s = scene(t);
  s.seed(team());
  git(s.project, "add", ".herdr/bots.json");
  git(s.project, "commit", "-q", "-m", "bots");
  const wt = join(s.root, "wt");
  git(s.project, "worktree", "add", "-q", "-b", "wt", wt);
  // The worktree commits an edit of the same file; main deletes it, unstaged.
  const wtPath = join(wt, ".herdr/bots.json");
  const file = JSON.parse(readFileSync(wtPath, "utf8"));
  file.bots.find((b) => b.id === ID.dev).role = "worktree edit";
  writeFileSync(wtPath, `${JSON.stringify(file, null, 2)}\n`);
  git(wt, "add", ".herdr/bots.json");
  git(wt, "commit", "-q", "-m", "worktree bots");
  git(s.project, "config", "pull.rebase", "true");
  git(s.project, "config", "rebase.autoStash", "true");
  rmSync(s.botsPath);
  assert.equal(git(s.project, "status", "--porcelain"), " D .herdr/bots.json\n");
  const r = s.cli(["edit", ID.dev, "--role", "ranging"], { cwd: wt });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, new RegExp(`${s.botsPath} is deleted: `));
  assert.match(r.err, /pull\.rebase=true with rebase\.autoStash=true stashes the deletion and lets the pull through/);
  assert.match(r.err, /then the stash apply conflicts \(UD\)/);
  assert.doesNotMatch(r.err, /refuses the pull until/);
  // As the note says: the pull goes through, and its autostash apply conflicts (UD).
  git(wt, "add", ".herdr/bots.json");
  git(wt, "commit", "-q", "-m", "ranging");
  git(s.project, "pull", ".", "wt");
  assert.match(git(s.project, "status", "--porcelain=v2"), /^u UD /m);
  assert.equal(existsSync(s.botsPath), true, "the pull brought the file back before the stash apply");
});

// #665: a staged deletion ("1 D.") read as "modified", whose "commit or discard" advice could
// commit the deletion and hit modify/delete. It has its own state and wording instead.
test("a worktree edit gives a staged bots.json deletion its own note, and the pull refuses it", (t) => {
  const s = scene(t);
  s.seed(team());
  git(s.project, "add", ".herdr/bots.json");
  git(s.project, "commit", "-q", "-m", "bots");
  const wt = join(s.root, "wt");
  git(s.project, "worktree", "add", "-q", "-b", "wt", wt);
  git(s.project, "rm", "-q", ".herdr/bots.json");
  assert.match(git(s.project, "status", "--porcelain=v2"), /^1 D\. /m);
  const r = s.cli(["create", "--name", "Scout", "--agent", "claude", "--lead", ID.cap], { cwd: wt });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, new RegExp(`${s.botsPath} has a staged deletion: restore and commit the file, or unstage the deletion, before pulling`));
  assert.match(r.err, /committing the deletion ends the pull in a modify\/delete conflict/);
  assert.doesNotMatch(r.err, /has local changes|isn't committed|is deleted:/);
  // As the note says: the staged deletion stops the pull (committed, it would conflict instead).
  git(wt, "add", ".herdr/bots.json");
  git(wt, "commit", "-q", "-m", "scout");
  assert.throws(() => git(s.project, "pull", "--no-rebase", ".", "wt"),
    (err) => /Your local changes to the following files would be overwritten/.test(String(err.stderr)));
  // Unstaging it leaves an unstaged deletion, which the merge pull restores.
  git(s.project, "restore", "--staged", ".herdr/bots.json");
  assert.match(git(s.project, "status", "--porcelain=v2"), /^1 \.D /m);
  git(s.project, "pull", "-q", "--no-rebase", ".", "wt");
  assert.equal(git(s.project, "status", "--porcelain"), "");
  assert.equal(readFileSync(s.botsPath, "utf8"), readFileSync(join(wt, ".herdr/bots.json"), "utf8"));
});

// #626: a committed deletion leaves porcelain empty, so the old note was silent, yet the pull
// ends in a modify/delete conflict. HEAD:path against the worktree's view now warns.
test("a worktree edit warns when the main checkout has committed its bots.json deletion", (t) => {
  const s = scene(t);
  s.seed(team());
  git(s.project, "add", ".herdr/bots.json");
  git(s.project, "commit", "-q", "-m", "bots");
  const wt = join(s.root, "wt");
  git(s.project, "worktree", "add", "-q", "-b", "wt", wt);
  // The worktree commits its change; main commits the deletion of the same file.
  const wtPath = join(wt, ".herdr/bots.json");
  const file = JSON.parse(readFileSync(wtPath, "utf8"));
  file.bots.find((b) => b.id === ID.dev).role = "worktree edit";
  writeFileSync(wtPath, `${JSON.stringify(file, null, 2)}\n`);
  git(wt, "add", ".herdr/bots.json");
  git(wt, "commit", "-q", "-m", "worktree bots");
  git(s.project, "rm", "-q", ".herdr/bots.json");
  git(s.project, "commit", "-q", "-m", "delete bots");
  assert.equal(git(s.project, "status", "--porcelain"), "");
  const r = s.cli(["edit", ID.dev, "--role", "ranging"], { cwd: wt });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, new RegExp(`${s.botsPath} has a committed deletion: a pull that brings this worktree's version ends in a modify/delete conflict`));
  assert.match(r.err, /restore and commit the file before pulling, or resolve the conflict after/);
  assert.doesNotMatch(r.err, /isn't committed|has local changes|is deleted: a merge pull/);
  // As the note says, the pull ends in a modify/delete conflict.
  git(wt, "add", ".herdr/bots.json");
  git(wt, "commit", "-q", "-m", "ranging");
  assert.throws(() => git(s.project, "merge", "-q", "wt"),
    (err) => /CONFLICT \(modify\/delete\)/.test(`${err.stdout}${err.stderr}`));
});

// #626: a main checkout that never had .herdr/bots.json is not a committed deletion: the pull
// only adds the worktree's file, so no warning.
test("a worktree edit does not warn when the main checkout never had a bots.json", (t) => {
  const s = scene(t);
  const wt = join(s.root, "wt");
  git(s.project, "worktree", "add", "-q", "-b", "wt", wt);
  assert.equal(git(s.project, "status", "--porcelain"), "");
  const made = s.cli(["create", "--name", "Genie", "--agent", "claude"], { cwd: wt });
  assert.equal(made.code, 0, made.err);
  assert.match(made.err, new RegExp(`saved in ${join(wt, ".herdr/bots.json")} \\(this worktree\\)`));
  assert.doesNotMatch(made.err, /committed deletion|modify\/delete|isn't committed|has local changes|is deleted/);
  // HEAD has no file there, and no commit ever touched the path: the pull only adds it.
  assert.equal(git(s.project, "status", "--porcelain"), "");
  assert.throws(() => git(s.project, "show", "HEAD:.herdr/bots.json"));
  assert.equal(git(s.project, "log", "-1", "--format=%H", "HEAD", "--", ".herdr/bots.json"), "");
});

// #626 F1: a deletion committed before the worktree branched is not a modify/delete: the merge
// base has no file, so the pull only adds the worktree's file — no warning, and a clean merge.
test("a worktree edit does not warn when main deleted bots.json before the worktree branched", (t) => {
  const s = scene(t);
  s.seed(team());
  git(s.project, "add", ".herdr/bots.json");
  git(s.project, "commit", "-q", "-m", "bots");
  git(s.project, "rm", "-q", ".herdr/bots.json");
  git(s.project, "commit", "-q", "-m", "delete bots");
  const wt = join(s.root, "wt");
  git(s.project, "worktree", "add", "-q", "-b", "wt", wt);
  assert.throws(() => git(s.project, "show", "HEAD:.herdr/bots.json"));
  const made = s.cli(["create", "--name", "Genie", "--agent", "claude"], { cwd: wt });
  assert.equal(made.code, 0, made.err);
  assert.doesNotMatch(made.err, /committed deletion|modify\/delete/);
  // The worktree's commit merges cleanly: the file is added, not a modify/delete conflict.
  git(wt, "add", ".herdr/bots.json");
  git(wt, "commit", "-q", "-m", "genie");
  git(s.project, "merge", "-q", "wt");
  assert.equal(git(s.project, "status", "--porcelain"), "");
  assert.ok(s.bots().bots.some((b) => b.name === "Genie"));
});

test("from a worktree branched before a bot was added: edit names both files, restart --save says why nothing was saved", (t) => {
  const s = restartScene(t);
  const wt = join(s.root, "wt");
  git(s.project, "worktree", "add", "-q", wt);
  // The worktree's own file, from before Genie: another main bot only.
  const wtText = `${JSON.stringify({ version: 1, categories: [], bots: [bot(ID.plan, "main", { name: "Old" })] }, null, 2)}\n`;
  mkdirSync(join(wt, ".herdr"), { recursive: true });
  writeFileSync(join(wt, ".herdr/bots.json"), wtText);
  const mainText = readFileSync(s.botsPath, "utf8");
  const e = s.cli(["edit", "Genie", "--role", "x"], { cwd: wt });
  assert.equal(e.code, 1, e.err);
  assert.match(e.err, new RegExp(`No bot "Genie" in ${join(wt, ".herdr/bots.json")}, this worktree's file, which edits change; ${s.botsPath} has it`));
  const r = s.cli(["restart", "Genie", "--agent", "codex", "--save", "--force", "--json"], { cwd: wt });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().saved, false);
  assert.match(r.err, /--save: .*wt\/\.herdr\/bots\.json, this worktree's file, has no Genie \(b-aaaaaaaaaa\), so codex wasn't saved/);
  assert.equal(readFileSync(join(wt, ".herdr/bots.json"), "utf8"), wtText);
  assert.equal(readFileSync(s.botsPath, "utf8"), mainText);
});

test("rm of the last bot from a worktree with no bots.json of its own is refused, and nothing is written", (t) => {
  const s = scene(t);
  const wt = join(s.root, "wt");
  git(s.project, "worktree", "add", "-q", wt);
  s.seed({ version: 1, categories: [], bots: [bot(ID.main, "main", { name: "Genie" })] });
  const mainText = readFileSync(s.botsPath, "utf8");
  const r = s.cli(["rm", ID.main], { cwd: wt });
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /last bot and .*wt\/\.herdr\/bots\.json isn't there, so nothing was removed/);
  assert.equal(existsSync(join(wt, ".herdr")), false);
  assert.equal(readFileSync(s.botsPath, "utf8"), mainText);
});

test("outside git, --project names the folder written, as before", (t) => {
  const s = scene(t);
  const other = join(s.root, "plain");
  mkdirSync(other);
  assert.equal(s.cli(["create", "--name", "Solo", "--agent", "claude", "--project", other]).code, 0);
  assert.ok(existsSync(join(other, ".herdr/bots.json")));
});

test("create --project names the project itself outside git, never the parent project above it", (t) => {
  const s = scene(t);
  // The owner's case: repos (no git) holds another project's bots.json; child under it has none.
  const repos = join(s.root, "repos");
  const child = join(repos, "child");
  mkdirSync(join(repos, ".herdr"), { recursive: true });
  mkdirSync(child);
  const parentText = `${JSON.stringify(team(), null, 2)}\n`;
  writeFileSync(join(repos, ".herdr/bots.json"), parentText);
  const r = s.cli(["create", "--name", "Child", "--agent", "claude", "--project", child, "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().project, child);
  const own = JSON.parse(readFileSync(join(child, ".herdr/bots.json"), "utf8"));
  assert.deepEqual(own.bots.map((b) => [b.name, b.kind]), [["Child", "main"]]);
  assert.equal(readFileSync(join(repos, ".herdr/bots.json"), "utf8"), parentText, "the parent's file is untouched");
  // Run from inside child with no --project, the walk-up now finds child's own file first.
  assert.equal(s.cli(["ls", "--json"], { cwd: child }).json().projects[0].project, child);
  // A folder that isn't there is refused, not made.
  const gone = s.cli(["create", "--name", "X", "--agent", "claude", "--project", join(repos, "nope")]);
  assert.equal(gone.code, 2);
  assert.match(gone.err, /is not a folder/);
  assert.equal(existsSync(join(repos, "nope")), false);
});

test("create refuses instructions over 4,000 characters, from the flag, a file or stdin", (t) => {
  const s = scene(t);
  const long = "x".repeat(4001);
  const r = s.cli(["create", "--name", "Genie", "--agent", "claude", "--instructions", long]);
  assert.equal(r.code, 1);
  assert.match(r.err, /4001 characters; the limit is 4000/);
  assert.equal(existsSync(s.botsPath), false);
  assert.equal(s.cli(["create", "--name", "Genie", "--agent", "claude", "--instructions-file", "-"], { input: long }).code, 1);
  const ok = s.cli(["create", "--name", "Genie", "--agent", "claude", "--instructions-file", "-"], { input: `${"y".repeat(4000)}\n` });
  assert.equal(ok.code, 0, ok.err);
  assert.equal(s.bots().bots[0].instructions.length, 4000);
});

test("create: lead, category, planned, look, model pin from the agent's list only", (t) => {
  const s = scene(t);
  s.seed(team());
  const bad = s.cli(["create", "--name", "Tess", "--agent", "claude", "--model", "gpt-free-text"]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /isn't a known claude model. Pick one of: .*claude-opus-5-5/);
  const unknownAgent = s.cli(["create", "--name", "Tess", "--agent", "nope"]);
  assert.match(unknownAgent.err, /isn't a coding agent Herdr knows/);
  const catUnderCaptain = s.cli(["create", "--name", "Tess", "--agent", "claude", "--lead", "Captain", "--category", "eng"]);
  assert.match(catUnderCaptain.err, /category goes only on a member that reports to the main bot/);
  const leadPlanned = s.cli(["create", "--name", "Tess", "--agent", "claude", "--lead", "Studio"]);
  assert.match(leadPlanned.err, /Studio is planned/);
  const dupName = s.cli(["create", "--name", "dev", "--agent", "claude"]);
  assert.match(dupName.err, /already named "Dev"/);

  const r = s.cli(["create", "--name", "Tess", "--agent", "claude", "--lead", "Captain", "--model", "claude-opus-5-5", "--character", "gem", "--colour", "rose", "--json"]);
  assert.equal(r.code, 0, r.err);
  const made = s.bots().bots.find((b) => b.id === r.json().id);
  assert.equal(made.lead, ID.cap);
  assert.equal(made.model, "claude-opus-5-5");
  assert.deepEqual(made.look, { character: "gem", colour: "rose" });
  const omni = s.cli(["create", "--name", "Octo", "--agent", "codex", "--category", "Engineering", "--omni", "--json"]);
  const o = s.bots().bots.find((b) => b.id === omni.json().id);
  assert.deepEqual(o.look, { character: "octopus", colour: "deepseek" });
  assert.equal(o.category, "eng");
  assert.equal(o.lead, undefined);
  const planned = s.cli(["create", "--name", "Later", "--planned-wave", "2", "--planned-note", "after auth", "--json"]);
  assert.equal(planned.code, 0, planned.err);
  const p = s.bots().bots.find((b) => b.id === planned.json().id);
  assert.deepEqual(p.planned, { wave: 2, note: "after auth" });
  assert.equal(p.agent, undefined);
  assert.equal(s.cli(["create", "--name", "Nobody"]).code, 2, "no agent and not planned");
  assert.deepEqual(checkBots(s.bots()), []);
});

test("Antigravity (#793): a pin comes from `agy models`, cached once; the settings label is refused", (t) => {
  const s = scene(t);
  s.seed(team());
  const cache = join(s.app, "automagik-herdr/antigravity-models.json");
  assert.equal(existsSync(cache), false);
  const made = s.cli(["create", "--name", "Ag", "--agent", "antigravity", "--model", "gemini-4-argon-high", "--json"]);
  assert.equal(made.code, 0, made.err);
  assert.equal(s.bots().bots.find((b) => b.id === made.json().id).model, "gemini-4-argon-high");
  assert.deepEqual(s.agyCalls(), ["models"], "one refresh wrote the cache");
  const written = JSON.parse(readFileSync(cache, "utf8"));
  assert.ok(written.models.some((m) => m.id === "claude-sonnet-5-5-high"), "the fixture table is cached");
  assert.deepEqual(readdirSync(join(s.app, "automagik-herdr")).filter((n) => n.startsWith("antigravity-models.json")),
    ["antigravity-models.json"], "the temp file was renamed into place");
  // The cache is fresh: a second CLI run reads it and never runs agy.
  const second = s.cli(["create", "--name", "Ag2", "--agent", "antigravity", "--model", "claude-opus-5-5-medium", "--json"]);
  assert.equal(second.code, 0, second.err);
  assert.deepEqual(s.agyCalls(), ["models"], "no second `agy models`");
  // The settings.json label is not a --model value; the refusal lists the ids it may take.
  const label = s.cli(["create", "--name", "Ag3", "--agent", "antigravity", "--model", "Gemini 4 Argon (High)"]);
  assert.equal(label.code, 1);
  assert.match(label.err, /isn't a known antigravity model\. Pick one of: .*gemini-4-argon-high/);
  assert.match(label.err, /claude-opus-5-5-high/, "the Claude ids are offered too");
  // Editing a bot onto antigravity keeps or replaces its pin only from that list.
  const edit = s.cli(["edit", "Genie", "--agent", "antigravity"]);
  assert.equal(edit.code, 0, edit.err);
  assert.equal(s.bots().bots[0].agent, "antigravity");
});

test("Antigravity (#793): a pin already in the cache starts without running agy, even when the cache is old", (t) => {
  const s = scene(t);
  const f = team();
  f.bots[0].agent = "antigravity";
  f.bots[0].model = "gemini-4-argon-high";
  s.seed(f);
  mkdirSync(join(s.app, "automagik-herdr"), { recursive: true });
  writeFileSync(join(s.app, "automagik-herdr/antigravity-models.json"), JSON.stringify({
    version: 1, source: "agy models", at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    models: [{ id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" }],
  }));
  const r = s.cli(["start", "Genie"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(s.agyCalls(), [], "a cached pin never refreshes, old cache and all");
  assert.deepEqual(plain(agentWords(runCall(s.calls()))),
    ["agy", "--settings", agySettingsPath(s, ID.main), "--dangerously-skip-permissions", "--mode", "auto", "--model", "gemini-4-argon-high"]);
  // The pin is not in the old cache: one refresh, then the refusal names the list it found.
  const s2 = scene(t);
  const f2 = team();
  f2.bots[0].agent = "antigravity";
  f2.bots[0].model = "gemini-9-nope";
  s2.seed(f2);
  mkdirSync(join(s2.app, "automagik-herdr"), { recursive: true });
  writeFileSync(join(s2.app, "automagik-herdr/antigravity-models.json"), JSON.stringify({
    version: 1, source: "agy models", at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    models: [{ id: "claude-opus-5-5-low", label: "Claude Opus 5.5 (Low)" }],
  }));
  const refused = s2.cli(["start", "Genie"]);
  assert.equal(refused.code, 1);
  assert.deepEqual(s2.agyCalls(), ["models"], "an unlisted pin refreshes once");
  assert.match(refused.err, /pinned to "gemini-9-nope"/);
});

test("Antigravity (#793): agy missing means no list, a clear refusal, and nothing started or written", (t) => {
  const s = scene(t);
  s.seed(team());
  rmSync(join(s.root, "bin", "agy"));
  const before = readFileSync(s.botsPath, "utf8");
  const env = { PATH: `${join(s.root, "bin")}:/usr/bin:/bin` };
  const r = s.cli(["create", "--name", "Ag", "--agent", "antigravity", "--model", "gemini-4-argon-high"], { env });
  assert.equal(r.code, 1);
  assert.match(r.err, /There is no list of antigravity models to pin from \(agy models has listed none: agy may not be installed, signed in, or cached yet\)/);
  assert.equal(existsSync(join(s.app, "automagik-herdr/antigravity-models.json")), false);
  assert.equal(readFileSync(s.botsPath, "utf8"), before, "nothing was written");
});

test("Antigravity #812: start and restart pass --mode auto by default and the chosen agyMode; an unknown mode is refused in one line", (t) => {
  const auto = scene(t);
  const plainBot = team();
  plainBot.bots[0].agent = "antigravity";
  auto.seed(plainBot);
  const started = auto.cli(["start", "Genie"]);
  assert.equal(started.code, 0, started.err);
  assert.deepEqual(plain(agentWords(runCall(auto.calls()))), ["agy", "--settings", agySettingsPath(auto, ID.main), "--dangerously-skip-permissions", "--mode", "auto"]);

  const s = scene(t);
  const chosen = team();
  chosen.bots[0].agent = "antigravity";
  chosen.bots[0].agyMode = "plan";
  s.seed(chosen);
  assert.equal(s.cli(["start", "Genie"]).code, 0);
  assert.deepEqual(plain(agentWords(runCall(s.calls()))), ["agy", "--settings", agySettingsPath(s, ID.main), "--dangerously-skip-permissions", "--mode", "plan"]);
  const restarted = s.cli(["restart", "Genie", "--force", "--json"]);
  assert.equal(restarted.code, 0, restarted.err);
  const second = s.calls().filter((c) => c[0] === "run")[1];
  assert.deepEqual(plain(agentWords(second)), ["agy", "--settings", agySettingsPath(s, ID.main), "--dangerously-skip-permissions", "--mode", "plan", "--continue"]);
  assert.deepEqual([restarted.json().mode, restarted.json().note], ["resume", null]);

  const bad = scene(t);
  const broken = team();
  broken.bots[0].agent = "antigravity";
  broken.bots[0].agyMode = "yolo";
  bad.seed(broken);
  const refused = bad.cli(["start", "Genie"]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /Genie: Antigravity mode "yolo" isn't one of accept-edits, auto, plan\. Fix it with am edit /);
  assert.equal(refused.err.split("\n").filter((line) => line.includes('Antigravity mode "yolo"')).length, 1, "one clear line");
  assert.equal(bad.calls().filter((c) => c[0] === "run").length, 0, "nothing started");
});

test("Antigravity #812: create/edit set agyMode (auto clears), show, ls and doctor print it; a bad one is refused", (t) => {
  const s = scene(t);
  s.seed(team());
  const made = s.cli(["create", "--name", "Ag", "--agent", "antigravity", "--agy-mode", "plan", "--json"]);
  assert.equal(made.code, 0, made.err);
  assert.equal(made.json().bot.agyMode, "plan");
  const saved = s.bots().bots.find((b) => b.name === "Ag");
  assert.equal(saved.agyMode, "plan");
  assert.match(s.cli(["show", "Ag"]).out, /agy mode     plan/);
  assert.match(s.cli(["ls"]).out, /agy-mode plan/);
  const bad = s.cli(["create", "--name", "Nope", "--agent", "antigravity", "--agy-mode", "yolo"]);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /--agy-mode: Antigravity mode "yolo" isn't one of accept-edits, auto, plan\./);
  assert.equal(s.cli(["edit", "Ag", "--agy-mode", "auto"]).code, 0);
  assert.equal(s.bots().bots.find((b) => b.name === "Ag").agyMode, undefined, "auto is the default, so it clears");
  assert.match(s.cli(["show", "Ag"]).out, /agy mode     auto/);
  const doctor = s.cli(["dsh-tui", "doctor", "--json"]);
  const row = doctor.json().checks.find((c) => c.check === `hc-proxy:${saved.id}`);
  assert.match(row.detail, /Ag: agy mode auto; agy trusted .*; agy allow /);
  assert.match(row.detail, new RegExp(`agy trusted ${s.project};`), "the seat's own folder is named (#879)");
  assert.match(row.detail, /agy deny .*command\(git push --force\)/);
});

test("mode #821: editing another agent warns that agy-mode only applies to Antigravity", (t) => {
  const s = scene(t);
  s.seed(team());
  const edited = s.cli(["edit", "Genie", "--agy-mode", "plan"]);
  assert.equal(edited.code, 0, edited.err);
  assert.match(edited.err, /--agy-mode only applies to Antigravity/);
  assert.equal(s.bots().bots[0].agyMode, "plan");
});

test("mode #821: empty modes read as auto in show, ls and doctor and clear on edit", (t) => {
  const s = scene(t);
  const file = team();
  Object.assign(file.bots[0], { agent: "antigravity", agyMode: "", worker: { agent: "antigravity", agyMode: "" } });
  s.seed(file);
  const shown = s.cli(["show", "Genie", "--json"]);
  assert.equal(shown.code, 0, shown.err);
  assert.equal(shown.json().agyMode, "auto");
  assert.equal(shown.json().worker.agyMode, "auto");
  assert.doesNotMatch(shown.err, /agyMode/);
  assert.match(s.cli(["ls"]).out, /agy-mode auto/);
  const doctor = s.cli(["dsh-tui", "doctor", "--json"]);
  const row = doctor.json().checks.find((c) => c.check === `hc-proxy:${ID.main}`);
  assert.match(row.detail, /agy mode auto/);
  const edited = s.cli(["edit", "Genie", "--agy-mode=", "--worker-agy-mode="]);
  assert.equal(edited.code, 0, edited.err);
  assert.equal(s.bots().bots[0].agyMode, undefined);
  assert.deepEqual(s.bots().bots[0].worker, { agent: "antigravity" });
});

test("Antigravity #823: start and restart write a private permission file and pass --settings; the roster adds rules", (t) => {
  const s = scene(t);
  const f = team();
  f.bots[0].agent = "antigravity";
  f.bots[0].agyPermissions = { allow: ["command(npm publish)"], deny: ["command(git stash)"] };
  s.seed(f);
  const started = s.cli(["start", "Genie"]);
  assert.equal(started.code, 0, started.err);
  const path = agySettingsPath(s, ID.main);
  assert.deepEqual(plain(agentWords(runCall(s.calls()))), ["agy", "--settings", path, "--dangerously-skip-permissions", "--mode", "auto"]);
  assert.equal(statSync(path).mode & 0o777, 0o600, "the launch's file is private");
  assert.equal(statSync(join(s.app, "automagik-herdr/agy-settings")).mode & 0o777, 0o700, "in a private folder");
  const data = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(data.permissions.allow.includes("command(hc)"));
  for (const rule of ["command(mkdir)", "command(chmod)", "command(rg)", "command(sort)", "command(uniq)", "command(sed -n)"]) {
    assert.ok(data.permissions.allow.includes(rule), `writer seat allow ${rule}`);
  }
  for (const tool of AGY_SHELL_READ) {
    assert.ok(data.permissions.allow.includes(`command(${tool})`), `seat allow command(${tool})`);
  }
  for (const bad of ["command(bash)", "command(sh)", "command(env)", "command(xargs)",
    "command(find)", "command(awk)", "command(tee)", "command(sed)"]) {
    assert.equal(data.permissions.allow.includes(bad), false, `seat never allows ${bad}`);
  }
  assert.ok(data.permissions.allow.includes("command(npm publish)"), "the roster's allow is added");
  assert.ok(data.permissions.allow.includes(`write_file(${s.project})`), "a bot writes in its project");
  for (const rule of ["command(gh pr create)", "command(gh pr edit)", "command(gh pr comment)"]) {
    assert.ok(data.permissions.allow.includes(rule), `a writer opens and updates its PR: ${rule}`);
  }
  assert.equal(data.permissions.allow.includes("command(gh release view)"), false,
    "the fixed gh release deny would shadow it");
  for (const rule of AGY_FIXED_DENY) assert.equal(data.permissions.allow.includes(rule), false);
  assert.equal(data.permissions.allow.some((r) => r.startsWith("write_file(") && !r.endsWith(`${s.project})`)), false,
    "and nowhere else");
  for (const rule of AGY_FIXED_DENY) assert.ok(data.permissions.deny.includes(rule), `fixed deny ${rule}`);
  assert.ok(data.permissions.deny.includes("command(git stash)"), "the roster's deny is added");
  // Restart: the same file, rewritten from the source as it is now, and resumed with it.
  f.bots[0].agyPermissions = { allow: ["command(npm publish)", "command(bun publish)"], deny: [] };
  f.bots[2].agent = "antigravity";
  f.bots[2].rank = "reviewer";
  s.seed(f);
  const restarted = s.cli(["restart", "Genie", "--force", "--json"]);
  assert.equal(restarted.code, 0, restarted.err);
  assert.deepEqual([restarted.json().mode, restarted.json().note], ["resume", null]);
  const second = s.calls().filter((c) => c[0] === "run")[1];
  assert.deepEqual(plain(agentWords(second)), ["agy", "--settings", path, "--dangerously-skip-permissions", "--mode", "auto", "--continue"]);
  const again = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(again.permissions.allow.includes("command(bun publish)"));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  for (const rule of AGY_FIXED_DENY) assert.ok(again.permissions.deny.includes(rule));
  // A reviewer seat (#840) gets all 24 read-only shell tools, no write_file, no writer-only tools, no launchers.
  const revStarted = s.cli(["start", "Dev"]);
  assert.equal(revStarted.code, 0, revStarted.err);
  const revData = JSON.parse(readFileSync(agySettingsPath(s, ID.dev), "utf8"));
  for (const rule of ["command(hc ls)", "command(hc get)", "command(hc read)", "command(hc wait)", "command(hc send)"]) {
    assert.ok(revData.permissions.allow.includes(rule), `reviewer seat allow ${rule}`);
  }
  for (const rule of ["command(hc)", "command(hc run)", "command(hc exec)"]) {
    assert.equal(revData.permissions.allow.includes(rule), false, `reviewer seat excludes ${rule}`);
  }
  for (const tool of AGY_SHELL_READ) {
    assert.ok(revData.permissions.allow.includes(`command(${tool})`), `reviewer seat allow command(${tool})`);
  }
  assert.equal(revData.permissions.allow.some((r) => r.startsWith("write_file(")), false);
  for (const rule of ["command(mkdir)", "command(chmod)", "command(rg)", "command(sort)", "command(uniq)", "command(sed -n)"]) {
    assert.equal(revData.permissions.allow.includes(rule), false, `reviewer seat excludes ${rule}`);
  }
  for (const bad of ["command(bash)", "command(sh)", "command(env)", "command(xargs)",
    "command(find)", "command(awk)", "command(tee)", "command(sed)"]) {
    assert.equal(revData.permissions.allow.includes(bad), false, `reviewer seat never allows ${bad}`);
  }
});

test("Antigravity #823: a symlinked permission folder or file is refused, never followed", (t) => {
  // A symlinked folder: the writer refuses and writes nothing through it.
  const s = scene(t);
  const f = team();
  f.bots[0].agent = "antigravity";
  s.seed(f);
  mkdirSync(join(s.app, "automagik-herdr"), { recursive: true });
  const elsewhere = join(s.root, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(s.app, "automagik-herdr/agy-settings"));
  const folder = s.cli(["start", "Genie"]);
  assert.equal(folder.code, 1);
  assert.match(folder.err, /is a symlink/);
  assert.deepEqual(readdirSync(elsewhere), [], "nothing written through the link");
  assert.equal(s.calls().filter((c) => c[0] === "run").length, 0, "nothing started");
  // A symlinked file: refused too, and its target is untouched.
  const s2 = scene(t);
  const f2 = team();
  f2.bots[0].agent = "antigravity";
  s2.seed(f2);
  mkdirSync(join(s2.app, "automagik-herdr/agy-settings"), { recursive: true });
  const target = join(s2.root, "target.json");
  writeFileSync(target, "{}\n");
  symlinkSync(target, agySettingsPath(s2, ID.main));
  const file = s2.cli(["start", "Genie"]);
  assert.equal(file.code, 1);
  assert.match(file.err, /is a symlink/);
  assert.equal(readFileSync(target, "utf8"), "{}\n", "the link's target is untouched");
});

test("Antigravity #823: --agy-allow/--agy-deny add rules, clear with one empty value, and show, ls and doctor print the lists", (t) => {
  const s = scene(t);
  s.seed(team());
  const made = s.cli(["create", "--name", "Ag", "--agent", "antigravity", "--agy-allow", "command(npm publish)",
    "--agy-allow", "command(hc)", "--agy-deny", "command(git stash)", "--json"]);
  assert.equal(made.code, 0, made.err);
  const saved = s.bots().bots.find((b) => b.id === made.json().id);
  assert.deepEqual(saved.agyPermissions, { allow: ["command(npm publish)", "command(hc)"], deny: ["command(git stash)"] });
  const show = s.cli(["show", "Ag"]).out;
  assert.match(show, new RegExp(`  agy trusted  ${s.project}`), "the seat trusts its project");
  assert.match(show, /agy allow .*command\(hc\)/);
  assert.match(show, /agy allow .*command\(npm publish\)/);
  assert.match(show, /agy deny .*command\(git stash\)/);
  assert.match(show, /agy deny .*command\(git push --force\)/, "the fixed denies are shown too");
  assert.match(s.cli(["ls"]).out, /agy-allow \d+ deny \d+/);
  // Given values replace that list; one empty value clears it.
  assert.equal(s.cli(["edit", "Ag", "--agy-allow", "command(bun)"]).code, 0);
  assert.deepEqual(s.bots().bots.find((b) => b.name === "Ag").agyPermissions.allow, ["command(bun)"]);
  assert.equal(s.cli(["edit", "Ag", "--agy-deny="]).code, 0);
  assert.deepEqual(s.bots().bots.find((b) => b.name === "Ag").agyPermissions, { allow: ["command(bun)"], deny: [] });
  assert.equal(s.cli(["edit", "Ag", "--no-agy-permissions"]).code, 0);
  assert.equal(s.bots().bots.find((b) => b.name === "Ag").agyPermissions, undefined);
  // Junk is refused by name, and nothing is saved.
  const before = readFileSync(s.botsPath, "utf8");
  const bad = s.cli(["edit", "Ag", "--agy-allow", "nope"]);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /--agy-allow: "nope" isn't a rule \(command\(\.\.\.\) or write_file\(\.\.\.\)\)/);
  assert.equal(readFileSync(s.botsPath, "utf8"), before, "nothing was saved");
  assert.equal(s.cli(["edit", "Ag", "--agy-allow", "write_file(rel)"]).code, 2);
  // Doctor: the effective lists per bot, and the host's sandbox row.
  assert.equal(s.cli(["edit", "Ag", "--agy-allow", "command(npm publish)"]).code, 0);
  const doctor = s.cli(["dsh-tui", "doctor", "--json"]).json();
  const row = doctor.checks.find((c) => c.check === `hc-proxy:${saved.id}`);
  assert.ok(row.agyPermissions.allow.includes("command(npm publish)"));
  assert.ok(row.agyPermissions.allow.includes(`write_file(${s.project})`));
  for (const rule of AGY_FIXED_DENY) assert.ok(row.agyPermissions.deny.includes(rule));
  // #879: the seat's own project folder, never its parent or the home; a worker's worktree is
  // only known at launch, so the plan names it as such.
  assert.deepEqual(row.agyPermissions.trustedWorkspaces, [s.project]);
  for (const wrong of [dirname(s.project), s.home, "/"]) {
    assert.equal(row.agyPermissions.trustedWorkspaces.includes(wrong), false, `never ${wrong}`);
  }
  assert.deepEqual(row.workerAgyPermissions.trustedWorkspaces, ["<worktree>"]);
  const doctorText = s.cli(["dsh-tui", "doctor"]).out;
  assert.match(doctorText, new RegExp(`agy trusted ${s.project}`));
  assert.match(doctorText, /worker agy trusted <worktree>/);
  const sandbox = doctor.checks.find((c) => c.check === "agy-sandbox");
  assert.ok(sandbox, "a host-level sandbox row when a bot runs agy");
  assert.equal(sandbox.ok, true);
  if (process.platform !== "linux" && process.platform !== "darwin") assert.match(sandbox.detail, /isn't one agy's terminal sandbox is known on/);
  assert.equal(doctor.checks.filter((c) => c.check === "agy-sandbox").length, 1, "one host-level row, not one per bot");
});

test("Antigravity #1046: every launch, review included, trusts its own folder; review stays read-only", (t) => {
  const s = scene(t);
  const f = team();
  f.bots[0].agent = "antigravity";
  f.bots[0].rank = "reviewer";
  f.bots[0].worker = { agent: "antigravity" };
  f.bots[1].agent = "antigravity";
  f.bots[1].rank = "dev";
  f.bots[1].worker = { agent: "antigravity" };
  s.seed(f);
  const doctor = s.cli(["dsh-tui", "doctor", "--json"]).json();
  const reviewer = doctor.checks.find((c) => c.check === `hc-proxy:${ID.main}`);
  assert.deepEqual(reviewer.agyPermissions.trustedWorkspaces, [s.project], "the reviewer seat trusts its project");
  assert.deepEqual(reviewer.workerAgyPermissions.trustedWorkspaces, ["<worktree>"], "its review worker trusts its worktree at launch");
  assert.equal(reviewer.agyPermissions.allow.some((rule) => rule.startsWith("write_file(")), false, "the reviewer seat stays read-only");
  assert.equal(reviewer.workerAgyPermissions.allow.some((rule) => rule.startsWith("write_file(")), false, "its review worker stays read-only");
  const text = s.cli(["dsh-tui", "doctor"]).out;
  assert.match(text, new RegExp(`agy trusted ${s.project}; agy allow `), "the reviewer seat prints its trusted folder");
  assert.match(text, /worker agy trusted <worktree>; worker agy allow /, "the review worker prints its worktree");
  // A writer seat and its writer worker: the project, and (at launch) its worktree.
  const writer = doctor.checks.find((c) => c.check === `hc-proxy:${ID.cap}`);
  assert.deepEqual(writer.agyPermissions.trustedWorkspaces, [s.project]);
  assert.deepEqual(writer.workerAgyPermissions.trustedWorkspaces, ["<worktree>"]);
  assert.match(text, new RegExp(`agy trusted ${s.project}; agy allow `));
  assert.match(text, /worker agy trusted <worktree>; worker agy allow /);
  // show carries the same effective rows as ls and doctor (botRow's JSON).
  const show = s.cli(["show", "Genie", "--json"]).json();
  assert.deepEqual(show.agyPermissions.trustedWorkspaces, [s.project]);
  assert.deepEqual(show.workerAgyPermissions.trustedWorkspaces, ["<worktree>"]);
  assert.match(s.cli(["show", "Genie"]).out, new RegExp(`agy trusted  ${s.project}`));
  const cap = s.cli(["show", "Captain", "--json"]).json();
  assert.deepEqual(cap.agyPermissions.trustedWorkspaces, [s.project]);
  assert.deepEqual(cap.workerAgyPermissions.trustedWorkspaces, ["<worktree>"]);
  // #884 Low B: plain show names the worker default's trusted folder too: the worktree
  // placeholder for every role, review included.
  assert.match(s.cli(["show", "Genie"]).out, new RegExp(`worker agy trusted  <worktree>`));
  assert.match(s.cli(["show", "Captain"]).out, /worker agy trusted  <worktree>/);
  // #1046: the reviewer seat's own start writes trustedWorkspaces: [project], so agy's trust
  // question is already answered, while its allow list stays read-only.
  const started = s.cli(["start", "Genie"]);
  assert.equal(started.code, 0, started.err);
  const seatFile = JSON.parse(readFileSync(agySettingsPath(s, ID.main), "utf8"));
  assert.deepEqual(seatFile.trustedWorkspaces, [s.project], "the reviewer seat's file names the project");
  assert.equal(seatFile.permissions.allow.some((rule) => rule.startsWith("write_file(")), false, "and writes nothing");
});

test("Antigravity #884 Low A: a project at the home folder trusts nothing and leaves the key out", (t) => {
  const s = scene(t);
  // The home folder is itself the project: its key resolves to HOME, which agy must never trust.
  git(s.home, "init", "-q");
  git(s.home, "commit", "-q", "--allow-empty", "-m", "start");
  const f = team();
  f.bots[0].agent = "antigravity";
  mkdirSync(join(s.home, ".herdr"), { recursive: true });
  writeFileSync(join(s.home, ".herdr/bots.json"), `${JSON.stringify(f, null, 2)}\n`);
  const show = s.cli(["show", "Genie", "--json"], { cwd: s.home }).json();
  assert.deepEqual(show.agyPermissions.trustedWorkspaces, [], "the home folder is never trusted");
  assert.match(s.cli(["show", "Genie"], { cwd: s.home }).out, /agy trusted  -/);
  const started = s.cli(["start", "Genie"], { cwd: s.home });
  assert.equal(started.code, 0, started.err);
  const data = JSON.parse(readFileSync(agySettingsPath(s, ID.main), "utf8"));
  assert.equal("trustedWorkspaces" in data, false, "the file leaves the key out");
  assert.ok(data.permissions.allow.includes(`write_file(${s.home})`), "the writer rule still names the project");
});

test("Antigravity #884: restart --cwd writes DIR into the seat's permission file, never the project", (t) => {
  const s = scene(t);
  const f = team();
  f.bots[0].agent = "antigravity";
  s.seed(f);
  const old = term("t5", { bot: ID.main, cwd: s.project, argv: ["agy", "--mode", "auto"], app: "antigravity" });
  old.foreground.cwd = s.project;
  old.labels = { ...old.labels, role: "main", "agent.session": SID };
  writeFileSync(join(s.root, "hc.json"), JSON.stringify({ terminals: [old], next: 100 }));
  const dir = join(s.root, "moved");
  mkdirSync(dir);
  assert.equal(s.cli(["restart", "Genie", "--cwd", dir, "--json"]).code, 0);
  const path = agySettingsPath(s, ID.main);
  assert.deepEqual(plain(agentWords(runCall(s.calls()))), ["agy", "--settings", path, "--dangerously-skip-permissions", "--mode", "auto", "--conversation", SID]);
  // #884 M1/Low 2: a seat started or restarted with --cwd DIR lists DIR, not the project.
  const data = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(data.trustedWorkspaces, [dir], "the folder the restart works in, exact");
  assert.ok(data.permissions.allow.includes(`write_file(${dir})`), "write_file names DIR");
  assert.equal(data.permissions.allow.includes(`write_file(${s.project})`), false, "never the project");
  assert.equal(data.trustedWorkspaces.includes(s.project), false, "the project isn't trusted");
  assert.equal(runCall(s.calls())[runCall(s.calls()).indexOf("--cwd") + 1], dir, "the pane runs in DIR");
});

test("Antigravity #823: restart --tree writes the permission file of a worker helper and resumes it with it", (t) => {
  const s = scene(t);
  const f = team();
  f.bots[0].agent = "antigravity";
  s.seed(f);
  const old = term("t5", { bot: ID.main, cwd: s.project, argv: ["agy"], app: "antigravity" });
  old.foreground = { argv: ["agy", "--mode", "auto"], cwd: s.project, pid: 1 };
  old.labels = { ...old.labels, role: "main", "agent.session": SID };
  const wt = join(s.root, "proj.worktrees", "fix-823");
  mkdirSync(wt, { recursive: true });
  const worker = { ...term("t7", { argv: ["agy", "--mode", "auto", "-i", "do the task"], app: "antigravity", cwd: wt, parent: "t5" }),
    name: "fix-823-dev", die_with_parent: true,
    argv: ["agy", "--mode", "auto", "-i", "do the task"],
    labels: { "worker.of": ID.main, branch: "fix/823", "worker.role": "dev" } };
  writeFileSync(join(s.root, "hc.json"), JSON.stringify({ terminals: [old, worker], next: 100 }));
  mkdirSync(join(s.app, "automagik-herdr"), { recursive: true });
  writeFileSync(ledgerPath(s.app), `${JSON.stringify({ event: "start", kind: "worker", terminal: "t7", pid: 1, botId: ID.main,
    task: "fix-823", branch: "fix/823", project: s.project, lead: ID.main, worktree: wt, agent: "antigravity", role: "dev" })}\n`);
  const r = s.cli(["restart", "Genie", "--tree", "--json"]);
  assert.equal(r.code, 0, r.err);
  const runs = s.calls().filter((c) => c[0] === "run");
  assert.equal(runs.length, 2, "the bot and its helper");
  const seatPath = agySettingsPath(s, ID.main);
  const helperPath = agySettingsFile(agySettingsDir(s.app), ID.main, "worker", "dev", wt);
  assert.deepEqual(plain(agentWords(runs[0])), ["agy", "--settings", seatPath, "--dangerously-skip-permissions", "--mode", "auto", "--conversation", SID]);
  assert.deepEqual(plain(agentWords(runs[1])), ["agy", "--dangerously-skip-permissions", "--mode", "auto", "--settings", helperPath, "--continue"]);
  assert.equal(statSync(helperPath).mode & 0o777, 0o600);
  // #879: each launch's file trusts its own folder, exact: the seat's project, the helper's worktree.
  const seat = JSON.parse(readFileSync(seatPath, "utf8"));
  assert.deepEqual(seat.trustedWorkspaces, [s.project], "the seat trusts its project");
  for (const wrong of [dirname(s.project), s.home, "/"]) {
    assert.equal(seat.trustedWorkspaces.includes(wrong), false, `the seat never trusts ${wrong}`);
  }
  const data = JSON.parse(readFileSync(helperPath, "utf8"));
  assert.deepEqual(data.trustedWorkspaces, [wt], "the helper trusts only its worktree");
  assert.equal(data.trustedWorkspaces.includes(s.project), false, "not the project");
  assert.equal(data.trustedWorkspaces.includes(dirname(wt)), false, "not the worktrees' parent");
  assert.ok(data.permissions.allow.includes(`write_file(${wt})`), "the helper writes in its worktree");
  assert.ok(!data.permissions.allow.includes(`write_file(${s.project})`), "not in the project");
  for (const rule of AGY_FIXED_DENY) assert.ok(data.permissions.deny.includes(rule));
});

// ---- edit, rm, category ----

test("#730 local save: two planned leads warn without blocking an unrelated edit", (t) => {
  const s = scene(t);
  const file = team();
  const lead = ID.plan;
  for (const b of file.bots.slice(1, 3)) b.lead = lead;
  s.seed(file);
  const saved = s.cli(["edit", "Genie", "--role", "updated"]);
  assert.equal(saved.code, 0, saved.err);
  assert.equal(s.bots().bots[0].role, "updated");
  for (const id of [ID.cap, ID.dev]) {
    assert.ok(saved.err.includes(`Warning: ${id}: lead ${lead} is planned; reports to the main bot`), saved.err);
    assert.equal(s.bots().bots.find((b) => b.id === id).lead, lead);
    assert.equal(s.cli(["show", id, "--json"]).json().lead, ID.main);
  }
});

test("#730 local save: explicitly choosing a planned lead still refuses create and edit", (t) => {
  const s = scene(t);
  s.seed(team());
  const before = readFileSync(s.botsPath, "utf8");
  for (const args of [["edit", "Dev"], ["create", "--name", "New", "--agent", "claude"]]) {
    const refused = s.cli([...args, "--lead", "Studio"]);
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
  ["self lead", (f) => { f.bots[2].lead = ID.dev; }, /leads back to this bot/],
  ["lead cycle", (f) => { f.bots[1].lead = ID.dev; f.bots[2].lead = ID.cap; }, /leads back to this bot/],
  ["unknown main kind", (f) => { f.bots[0].kind = "unknown"; }, /unknown kind/],
]) {
  test(`#730 local save: ${name} elsewhere still refuses`, (t) => {
    const s = scene(t);
    const file = team();
    breakFile(file);
    s.seed(file);
    const before = readFileSync(s.botsPath, "utf8");
    const refused = s.cli(["edit", "Studio", "--role", "updated"]);
    assert.equal(refused.code, 1, refused.err);
    assert.match(refused.err, why);
    assert.equal(readFileSync(s.botsPath, "utf8"), before);
  });
}

test("edit: partial changes keep the rest; --unplanned, --no-model; a lead cycle is refused", (t) => {
  const s = scene(t);
  const f = team();
  f.bots[1].model = "opus";
  f.bots[1].extra = "kept";
  s.seed(f);
  assert.equal(s.cli(["edit", "Captain", "--role", "leads eng", "--no-model"]).code, 0);
  let cap = s.bots().bots.find((b) => b.id === ID.cap);
  assert.equal(cap.role, "leads eng");
  assert.equal(cap.model, undefined);
  assert.equal(cap.extra, "kept");
  assert.equal(cap.category, "eng");
  assert.equal(cap.instructions, "i");
  const cycle = s.cli(["edit", "Captain", "--lead", "Dev"]);
  assert.equal(cycle.code, 1);
  assert.match(cycle.err, /Dev reports to Captain, so it can't be its lead/);
  const unplan = s.cli(["edit", ID.plan, "--unplanned"]);
  assert.match(unplan.err, /needs a coding agent/);
  assert.equal(s.cli(["edit", ID.plan, "--unplanned", "--agent", "codex"]).code, 0);
  assert.equal(s.bots().bots.find((b) => b.id === ID.plan).planned, undefined);
  assert.equal(s.cli(["edit", "Dev", "--lead", "Genie"]).code, 0);
  assert.equal(s.bots().bots.find((b) => b.id === ID.dev).lead, undefined, "the main bot as lead is stored as no lead");
  const json = s.cli(["edit", "Dev", "--name", "Developer", "--json"]).json();
  assert.equal(json.id, ID.dev);
  assert.equal(json.bot.name, "Developer");
  cap = s.bots().bots.find((b) => b.id === ID.cap);
  assert.equal(cap.name, "Captain");
});

test("rm: a main bot with members and a lead with members are refused; a member goes; the last bot deletes the file", (t) => {
  const s = scene(t);
  s.seed(team());
  const main = s.cli(["rm", "Genie"]);
  assert.equal(main.code, 1);
  assert.match(main.err, /main bot and its project still has 3 other bots/);
  const lead = s.cli(["rm", "Captain"]);
  assert.equal(lead.code, 1);
  assert.match(lead.err, /Captain leads Dev/);
  assert.equal(s.bots().bots.length, 4, "nothing written");
  for (const b of ["Dev", "Captain", "Studio"]) assert.equal(s.cli(["rm", b]).code, 0);
  const last = s.cli(["rm", "Genie", "--json"]);
  assert.equal(last.code, 0, last.err);
  assert.equal(last.json().deletedFile, true);
  assert.equal(existsSync(s.botsPath), false);
});

test("category add, edit, order, rm (refused while used); ls --json lists them", (t) => {
  const s = scene(t);
  s.seed(team());
  assert.equal(s.cli(["category", "add", "--title", "Quality", "--sub", "tests"]).out.trim(), "quality");
  assert.equal(s.cli(["category", "add", "--title", "Shared"]).out.trim(), "shared");
  assert.equal(s.cli(["category", "edit", "quality", "--sub", ""]).code, 0);
  assert.equal(s.bots().categories.find((c) => c.id === "quality").sub, undefined);
  assert.equal(s.cli(["category", "order", "shared", "quality"]).code, 0);
  assert.deepEqual(s.bots().categories.map((c) => c.id), ["shared", "quality", "eng"]);
  const used = s.cli(["category", "rm", "eng"]);
  assert.equal(used.code, 1);
  assert.match(used.err, /Captain is in eng/);
  assert.equal(s.cli(["category", "rm", "Shared"]).code, 0);
  const ls = s.cli(["category", "ls", "--json"]).json();
  assert.deepEqual(ls.categories.map((c) => [c.id, c.bots]), [["quality", []], ["eng", [ID.cap]]]);
});

// ---- the stale-snapshot rule ----

test("writeBotsFile refuses a stale snapshot and a file that appeared, writing nothing", (t) => {
  const s = scene(t);
  s.seed(team());
  const read = readFileSync(s.botsPath, "utf8");
  const raw = parseBots(read).raw;
  raw.bots[0].role = "changed";
  // Someone else's edit lands between the read and the write.
  const theirs = read.replace('"role": "r"', '"role": "theirs"');
  writeFileSync(s.botsPath, theirs);
  assert.throws(() => writeBotsFile(s.project, raw, read), (e) => e instanceof CliError && /changed since it was read/.test(e.message));
  assert.equal(readFileSync(s.botsPath, "utf8"), theirs);
  // A new file written by someone else after we saw none.
  const fresh = join(s.root, "fresh");
  mkdirSync(join(fresh, ".herdr"), { recursive: true });
  writeFileSync(join(fresh, ".herdr/bots.json"), "{}");
  assert.throws(() => writeBotsFile(fresh, team(), null), /changed since it was read/);
  // A write that would break the schema is refused before any read.
  assert.throws(() => writeBotsFile(s.project, { version: 1, categories: [], bots: [] }, theirs), /0 main bots/);
  // Through the injected file access: the re-read differs, so neither write runs.
  const io = { read: () => "y", mkdir() { throw new Error("no"); }, create() { throw new Error("no"); }, replace() { throw new Error("no"); } };
  assert.throws(() => writeBotsFile(s.project, team(), "x", io), /changed since/);
});

// ---- ls, show, model ----

test("ls --json: kind, lead, category, planned, agent, model detected → pinned → default, terminal, status", (t) => {
  const f = team();
  f.bots[2].model = "claude-opus-5-5";
  const s = scene(t, { terminals: [term("t5", { bot: ID.cap, argv: ["claude", "--dangerously-skip-permissions", "--model", "claude-opus-5-5"], status: "working" })] });
  s.seed(f);
  const r = s.cli(["ls", "--json"]);
  assert.equal(r.code, 0, r.err);
  const [p] = r.json().projects;
  assert.equal(p.project, s.project);
  assert.deepEqual(p.categories, [{ id: "eng", title: "Engineering" }]);
  const by = Object.fromEntries(p.bots.map((b) => [b.name, b]));
  assert.deepEqual(Object.keys(by), ["Genie", "Captain", "Dev", "Studio"]);
  assert.equal(by.Genie.kind, "main");
  assert.equal(by.Genie.lead, null);
  assert.deepEqual([by.Genie.model, by.Genie.modelSource, by.Genie.status, by.Genie.terminal], ["sonnet", "default", "not running", null]);
  assert.deepEqual([by.Captain.lead, by.Captain.category, by.Captain.model, by.Captain.modelSource, by.Captain.terminal, by.Captain.status],
    [ID.main, "eng", "claude-opus-5-5", "detected", "t5", "working"]);
  assert.deepEqual([by.Dev.lead, by.Dev.leadName, by.Dev.model, by.Dev.modelSource], [ID.cap, "Captain", "claude-opus-5-5", "pinned"]);
  assert.deepEqual(by.Studio.planned, { wave: 3, note: "later" });
  assert.equal(by.Studio.status, "planned");
  for (const key of ["id", "name", "kind", "lead", "category", "code", "planned", "agent", "model", "modelSource", "terminal", "status", "duplicate"]) assert.ok(key in by.Dev, key);
  assert.equal(by.Dev.code, true);
  const text = s.cli(["ls"]);
  assert.match(text.out, /Captain {2}→ Genie \[eng\] {2}claude {2}claude-opus-5-5 \(detected\) {2}working in t5/);
  const show = s.cli(["show", "dev", "--json"]).json();
  assert.equal(show.id, ID.dev);
  assert.equal(show.code, true);
  assert.equal(show.instructions, "i");
  assert.match(s.cli(["show", "Captain"]).out, /model {8}claude-opus-5-5 \(detected\)/);
  assert.match(s.cli(["show", "Captain"]).out, /code {9}true/);
  assert.match(s.cli(["show", "nobody"]).err, /No bot "nobody"/);
});

test("ls by the ledger: a shell pane shows no agent in front; the import takes the newest agent pane; --all adds remembered projects", (t) => {
  const s = scene(t, { terminals: [
    term("t1", { bot: ID.main, argv: ["zsh"] }),
    term("t2", { bot: ID.cap, created: 5 }), term("t3", { bot: ID.cap, created: 9, argv: ["claude", "--model", "opus"] }),
  ] });
  s.seed(team());
  const other = join(s.root, "other");
  mkdirSync(join(other, ".herdr"), { recursive: true });
  writeFileSync(join(other, ".herdr/bots.json"), JSON.stringify({ version: 1, categories: [], bots: [bot("b-dddddddddd", "main", { name: "Solo" })] }));
  writeFileSync(join(s.app, "shared.json"), JSON.stringify({ "spaces-agents.projects": [{ key: other, machine: null }, { key: join(s.root, "gone"), machine: null }, { key: "/r", machine: "vps" }] }));
  const by = Object.fromEntries(s.cli(["ls", "--json"]).json().projects[0].bots.map((b) => [b.name, b]));
  // The first run imports the labels: Genie's only pane, though a shell is in front; of
  // Captain's two, the newest with an agent in front. The ledger then ties one pane each.
  assert.deepEqual([by.Genie.terminal, by.Genie.status], ["t1", "no agent in front"]);
  assert.deepEqual([by.Captain.terminal, by.Captain.duplicate, by.Captain.model], ["t3", false, "opus"]);
  const all = s.cli(["ls", "--all", "--json"]).json().projects;
  assert.deepEqual(all.map((p) => p.project), [s.project, other]);
});

// automagik#227 (RFC 0014 Q16): a clone carries the main checkout's bot ids; a pane counts for
// its own project only, and an older ledger row with no project still counts by id alone.
test("ls and show (#227): the main checkout's pane is not the clone's; a row with no project counts by id", (t) => {
  const s = scene(t);
  // The pane runs in the main checkout (scene() makes the folder, so the terminal comes after).
  writeFileSync(join(s.root, "hc.json"), JSON.stringify({ ...s.hcState(),
    terminals: [term("t5", { bot: ID.cap, cwd: s.project, created: 7, status: "working" })] }));
  s.seed(team());
  const rows = () => readRows(readFileSync(attachFile(s.app), "utf8")).rows;
  const clone = join(s.root, "proj-clone");
  git(s.root, "clone", "-q", s.project, clone);
  mkdirSync(join(clone, ".herdr"), { recursive: true });
  writeFileSync(join(clone, ".herdr/bots.json"), readFileSync(s.botsPath, "utf8"));
  const captain = (cwd) => s.cli(["ls", "--json"], { cwd }).json().projects[0].bots.find((b) => b.id === ID.cap);
  // The first ls imports t5 into the ledger, bound to the main checkout that defines the bot.
  assert.deepEqual([captain(s.project).terminal, captain(s.project).status], ["t5", "working"]);
  assert.equal(rows().at(-1).project, s.project);
  assert.deepEqual([captain(clone).terminal, captain(clone).status], [null, "not running"]);
  const show = s.cli(["show", "Captain", "--json"], { cwd: clone }).json();
  assert.deepEqual([show.terminal, show.status], [null, "not running"]);
  assert.match(s.cli(["show", "Captain"], { cwd: s.project }).out, /t5/);
  // Start in the clone still refuses a second pane (the fold binds a bot once here) and says whose it is.
  const start = s.cli(["start", "Captain"], { cwd: clone });
  assert.equal(start.code, 0, start.err);
  assert.equal(start.out.trim(), `Captain is already running in t5, for ${s.project}.`);
  assert.equal(s.cli(["start", "Captain"], { cwd: s.project }).out.trim(), "Captain is already running in t5.");
  // An older row with no project: the pane counts for both checkouts, as before.
  writeFileSync(attachFile(s.app), `${JSON.stringify({ ...rows().at(-1), project: null })}\n`);
  assert.deepEqual([captain(clone).terminal, captain(clone).status], ["t5", "working"]);
  assert.deepEqual([captain(s.project).terminal, captain(s.project).status], ["t5", "working"]);
});

test("create, edit, category, start and attach list their project for the sidebar; ls --all reads the list", (t) => {
  const s = scene(t, { terminals: [term("t9", { cwd: "/x" })] });
  const list = join(s.app, "am-sidebar-projects.json");
  const listed = () => JSON.parse(readFileSync(list, "utf8"));
  // A folder that is there: start, attach and create take a gone one off the list (tidy).
  const elsewhere = join(s.root, "elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(list, JSON.stringify([elsewhere]));
  assert.equal(s.cli(["create", "--name", "Genie", "--agent", "claude"]).code, 0);
  assert.deepEqual(listed(), [elsewhere, s.project]);
  // Once each, the newest last.
  writeFileSync(list, JSON.stringify([s.project, elsewhere]));
  assert.equal(s.cli(["edit", "Genie", "--role", "lead"]).code, 0);
  assert.deepEqual(listed(), [elsewhere, s.project]);
  writeFileSync(list, "[]");
  assert.equal(s.cli(["category", "add", "--title", "Eng"]).code, 0);
  assert.deepEqual(listed(), [s.project]);
  writeFileSync(list, "[]");
  assert.equal(s.cli(["start", "Genie"]).code, 0);
  assert.deepEqual(listed(), [s.project]);
  // ls --all adds a listed project the sidebar never remembered.
  const other = scratchProject(s.root, "other", { bots: { version: 1, categories: [], bots: [bot("b-dddddddddd", "main", { name: "Solo" })] } });
  writeFileSync(list, JSON.stringify([other]));
  assert.deepEqual(s.cli(["ls", "--all", "--json"]).json().projects.map((p) => p.project), [s.project, other]);
  // Reading leaves the list alone; a read-only command adds nothing.
  assert.equal(s.cli(["show", "Genie"]).code, 0);
  assert.deepEqual(listed(), [other]);
});

test("twenty CLIs listing projects at once lose none of them", async (t) => {
  const app = scratchRoot(t, "hb-list-");
  const writer = `import { listProject } from ${JSON.stringify(CLI)};\nprocess.exitCode = listProject(process.argv[1], process.argv[2]) ? 0 : 1;`;
  const keys = Array.from({ length: 20 }, (_, i) => `/p/${i}`);
  const codes = await Promise.all(keys.map((key) => new Promise((done) => {
    execFile(process.execPath, ["--input-type=module", "-e", writer, key, app], (err) => done(err ? err.code ?? 1 : 0));
  })));
  assert.deepEqual(codes, keys.map(() => 0));
  const listed = JSON.parse(readFileSync(join(app, "am-sidebar-projects.json"), "utf8"));
  assert.deepEqual([...listed].sort(), [...keys].sort());
  assert.equal(existsSync(join(app, "am-sidebar-projects.json.lock")), false);
});

test("a stale project-list lock (a CLI killed mid-write) is taken over, and nothing is left behind", (t) => {
  const app = scratchRoot(t, "hb-lock-");
  const lock = join(app, "am-sidebar-projects.json.lock");
  writeFileSync(lock, "999999 someone-else");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  assert.equal(listProject("/p/a", app), true);
  assert.deepEqual(JSON.parse(readFileSync(join(app, "am-sidebar-projects.json"), "utf8")), ["/p/a"]);
  assert.deepEqual(readdirSync(app), ["am-sidebar-projects.json"]);
});

test("with no app home, nothing is listed and the command still succeeds; an unwritable list only warns", (t) => {
  const s = scene(t);
  rmSync(s.app, { recursive: true, force: true });
  assert.equal(s.cli(["create", "--name", "Genie", "--agent", "claude"]).code, 0);
  assert.equal(existsSync(s.app), false);
  mkdirSync(join(s.app, "am-sidebar-projects.json"), { recursive: true }); // a folder where the file goes
  const r = s.cli(["edit", "Genie", "--role", "lead"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /couldn't list .* so the sidebar shows it only once a space is open on it/);
});

// ---- forget (#229) ----

test("forget takes one project off the list, under its lock, and touches no folder, bots file or pane", (t) => {
  const s = scene(t, { terminals: [term("t9", { cwd: "/x" })] });
  s.seed(team());
  const list = join(s.app, "am-sidebar-projects.json");
  const gone = join(s.root, "gone"), other = join(s.root, "other");
  mkdirSync(other);
  writeFileSync(list, JSON.stringify([gone, s.project, other]));
  const bots = readFileSync(s.botsPath, "utf8");
  const r = s.cli(["forget", s.project]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `${s.project} forgotten: off ${list}.\n`);
  assert.equal(r.err, "");
  assert.deepEqual(JSON.parse(readFileSync(list, "utf8")), [gone, other], "only that entry; a gone one is left to tidy");
  assert.equal(readFileSync(s.botsPath, "utf8"), bots, "its folder and bots file stay");
  assert.deepEqual(readdirSync(s.app).sort(), ["am-sidebar-projects.json", "mods"], "no lock left behind");
  assert.deepEqual(s.calls(), [], "never asks hc: no pane is touched");
  assert.deepEqual(s.appCalls(), [], "never asks the window");
  // A gone folder by a relative path with a trailing slash, from its parent; --json.
  const json = s.cli(["forget", "gone/", "--json"], { cwd: s.root });
  assert.equal(json.code, 0, json.err);
  assert.deepEqual(json.json(), { forgotten: gone, list, sidebar_remembers: false });
  assert.deepEqual(JSON.parse(readFileSync(list, "utf8")), [other]);
});

test("forget refuses a project that isn't on the list, the list unchanged; --json says so on stdout", (t) => {
  const s = scene(t);
  const list = join(s.app, "am-sidebar-projects.json");
  const listed = JSON.stringify([join(s.root, "other")]);
  writeFileSync(list, listed);
  const r = s.cli(["forget", s.project]);
  assert.equal(r.code, 1);
  assert.equal(r.out, "");
  assert.equal(r.err, `am: ${s.project} isn't on the project list (${list}); am ls --all shows the projects there.\n`);
  assert.equal(readFileSync(list, "utf8"), listed, "byte for byte");
  const json = s.cli(["forget", s.project, "--json"]);
  assert.equal(json.code, 1);
  assert.deepEqual(json.json(), { error: r.err.slice("am: ".length, -1), project: s.project, forgotten: false });
  // One only the sidebar remembers: named as the sidebar's, and shared.json is never written.
  const shared = JSON.stringify({ "am.sidebar.projects": [{ key: s.project, machine: null }] });
  writeFileSync(join(s.app, "shared.json"), shared);
  const side = s.cli(["forget", s.project]);
  assert.equal(side.code, 1);
  assert.match(side.err, /isn't on this CLI's project list \(.*\); the sidebar remembers it on its own and forgets it once its \.herdr\/bots\.json is gone, so ls --all and the sidebar still show it until then\.\n$/);
  assert.equal(readFileSync(join(s.app, "shared.json"), "utf8"), shared);
  assert.equal(readFileSync(list, "utf8"), listed);
  // Usage: a project is needed, as the argument.
  assert.equal(s.cli(["forget"]).code, 2);
  assert.equal(s.cli(["forget", "--project", s.project]).code, 2);
  assert.equal(s.cli(["forget", s.project, "--machine", "build-box"]).code, 2);
  // No app home: nothing is listed, so it is refused, and no app home is made.
  rmSync(s.app, { recursive: true, force: true });
  assert.equal(s.cli(["forget", s.project]).code, 1);
  assert.equal(existsSync(s.app), false);
});

test("forget on both lists: off this CLI's, and it says the sidebar still shows it (review Medium 2)", (t) => {
  const s = scene(t);
  const list = join(s.app, "am-sidebar-projects.json"), other = join(s.root, "other");
  writeFileSync(list, JSON.stringify([s.project, other]));
  const shared = JSON.stringify({ "am.sidebar.projects": [{ key: s.project, machine: null }, { key: other, machine: "build-box" }] });
  writeFileSync(join(s.app, "shared.json"), shared);
  const r = s.cli(["forget", s.project]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `${s.project} forgotten: off ${list}.\n`);
  assert.equal(r.err, `am: ${s.project} is off this CLI's project list, but the sidebar remembers it on its own and forgets `
    + "it once its .herdr/bots.json is gone, so ls --all and the sidebar still show it until then.\n");
  assert.deepEqual(JSON.parse(readFileSync(list, "utf8")), [other]);
  assert.equal(readFileSync(join(s.app, "shared.json"), "utf8"), shared, "the sidebar's file is never written");
  // --json: true here; false for one only this CLI listed (another machine's sidebar entry doesn't count).
  writeFileSync(list, JSON.stringify([s.project, other]));
  assert.deepEqual(s.cli(["forget", s.project, "--json"]).json(), { forgotten: s.project, list, sidebar_remembers: true });
  const alone = s.cli(["forget", other, "--json"]);
  assert.equal(alone.err, "");
  assert.deepEqual(alone.json(), { forgotten: other, list, sidebar_remembers: false });
});

test("forget with the list's lock held: one refusal line, no stack, --json body; the list unchanged (review Low 3)", (t) => {
  const s = scene(t);
  const list = join(s.app, "am-sidebar-projects.json"), lock = `${list}.lock`;
  const listed = JSON.stringify([s.project]);
  writeFileSync(list, listed);
  writeFileSync(lock, `${process.pid} someone-else`); // fresh, and its holder alive: never taken over
  const r = s.cli(["forget", s.project, "--json"]);
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.err, /^\s+at /m, "no stack trace");
  const last = r.err.trim().split("\n").at(-1);
  assert.equal(last, `am: ${s.project} wasn't taken off ${list}: ${lock} is held by another am (pid ${process.pid})`);
  assert.deepEqual(r.json(), { error: last.slice("am: ".length), project: s.project, forgotten: false });
  assert.equal(readFileSync(list, "utf8"), listed);
  assert.equal(readFileSync(lock, "utf8"), `${process.pid} someone-else`, "another's lock is left alone");
});

test("forget takes over a stale project-list lock (a CLI killed mid-write) and leaves none", (t) => {
  const s = scene(t);
  const list = join(s.app, "am-sidebar-projects.json"), lock = `${list}.lock`;
  writeFileSync(list, JSON.stringify([s.project]));
  writeFileSync(lock, "999999 someone-else");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  const r = s.cli(["forget", s.project]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(readFileSync(list, "utf8")), []);
  assert.equal(existsSync(lock), false);
});

// ---- start ----

test("start a main bot: hc run --bg with the label, name, cwd, --no-parent, the pinned model; never --no-notify; the hook written and excluded", (t) => {
  const f = team();
  f.bots[0].model = "claude-opus-5-5";
  const s = scene(t);
  s.seed(f);
  const r = s.cli(["start", "Genie", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().terminal, "t100");
  const run = runCall(s.calls());
  // Every seat runs as /usr/bin/env PATH=<this PATH> <agent>, as a worker does (#213): without it
  // the pane would get herdr-core's PATH, which may have no node for an npm agent.
  // RFC 0021 (f) 2: a fresh Claude start runs on a session id Herdr chose, labelled on the pane.
  const sid = run.find((w) => w.startsWith("agent.session="))?.slice("agent.session=".length);
  assert.match(sid ?? "", SID_SHAPE);
  assert.deepEqual(run.slice(0, run.indexOf("--") + 2), ["run", "--bg", "--json", "--name", "genie", "--cwd", s.project, "--label", `bot=${ID.main}`, "--label", "role=main",
    "--label", `agent.session=${sid}`, "--no-parent", "--", "/usr/bin/env"]);
  // No claude-logins.json: the default login, the variable unset before PATH (#453).
  assert.deepEqual(run.slice(run.indexOf("--") + 2, run.indexOf("--") + 4), ["-u", "CLAUDE_CONFIG_DIR"], run.join(" "));
  assert.ok(run[run.indexOf("--") + 4].startsWith("PATH="), run.join(" "));
  assert.deepEqual(plain(agentWords(run)), ["claude", "--permission-mode", "auto", "--model", "claude-opus-5-5", "--session-id", sid]);
  const words = agentWords(run);
  assert.equal(words[1], "--append-system-prompt-file", "the briefing in its system prompt, right after the executable");
  // The seat row names the same session; output never shows it (RFC 0021).
  const seatRow = readLedger(readFileSync(join(s.app, "automagik-herdr/workers.jsonl"), "utf8")).find((x) => x.event === "start");
  assert.equal(seatRow.session, sid);
  assert.equal(r.out.includes(sid), false, "the --json answer masks it");
  assert.deepEqual(r.json().argv.slice(-2), ["--session-id", "***"]);
  assert.equal(r.json().labels["agent.session"], "***");
  assert.match(readFileSync(words[2], "utf8"), /^<herdr-bot>\nAutomagik Herdr briefing, written from \.herdr\/bots\.json/);
  assert.equal(run.includes("--no-notify"), false);
  assert.equal(run.some((a) => a.startsWith("herdr.space=") || a.startsWith("herdr.tab=")), false, "no placement labels unless asked");
  const settings = JSON.parse(readFileSync(join(s.project, ".claude/settings.local.json"), "utf8"));
  assert.match(settings.hooks.UserPromptSubmit[0].hooks[0].command, new RegExp(`${s.app}/mods/am-sidebar/briefing.mjs`));
  assert.match(readFileSync(join(s.project, ".git/info/exclude"), "utf8"), /\*\*\/\.claude\/settings\.local\.json/);
  assert.equal(git(s.project, "status", "--porcelain", "--", ".claude"), "");
  // Started: the next start reports the running pane and runs nothing.
  const again = s.cli(["start", "Genie"]);
  assert.equal(again.code, 0);
  assert.match(again.out, /already running in t100/);
  assert.equal(s.calls().filter((c) => c[0] === "run").length, 1);
});

test("start (#56) lands in the project's space, a project terminal's only when it shows the project; in a tab of its own", (t) => {
  // The window: the caller's space on another folder, and the project's, its second tab selected.
  const startIn = (callerLabels, { projectSpace = true } = {}) => {
    const s = scene(t);
    const spaces = [{ id: "sp-caller", folder: "/", machine: null, active: true, tabs: [{ id: "tb-c", active: true, terminals: [] }] }];
    if (projectSpace) {
      spaces.push({ id: "sp-proj", folder: s.project, machine: null, active: false,
        tabs: [{ id: "tb-a", active: false, terminals: [] }, { id: "tb-b", active: true, terminals: [] }] });
    }
    writeFileSync(join(s.root, "herdr-app.json"), JSON.stringify({ spaces }));
    s.seed(team());
    const caller = term("t20", { cwd: s.project, argv: ["claude"] }); // e.g. an orchestrator working in the project
    caller.labels = callerLabels;
    writeFileSync(join(s.root, "hc.json"), JSON.stringify({ terminals: [caller], next: 100 }));
    const r = s.cli(["start", "Genie", "--json"]);
    assert.equal(r.code, 0, r.err);
    r.appCalls = s.appCalls();
    r.calls = s.calls();
    return r;
  };
  // The caller's tab is in another space: the bot goes to the project's space, never its selected
  // tab, with one herdr-app ls for the whole start (placementOf and windowPlace share it).
  const away = startIn({ "herdr.space": "sp-caller", "herdr.tab": "tb-c" });
  assert.deepEqual([away.json().space, away.json().tab], ["sp-proj", null]);
  assert.deepEqual(away.appCalls, [["ls"]]);
  // The caller's tab is in the project's space: its space takes the bot, never its tab (an
  // orchestrator's), so Herdr opens the bot in a tab of its own.
  const home = startIn({ "herdr.space": "sp-proj", "herdr.tab": "tb-a" });
  assert.deepEqual([home.json().space, home.json().tab], ["sp-proj", null]);
  const labels = runCall(home.calls);
  assert.ok(labels.includes("herdr.space=sp-proj"), labels.join(" "));
  assert.equal(labels.some((a) => a.startsWith("herdr.tab=")), false, labels.join(" "));
  // No space shows the project: never the caller's tab; a new space on the project is opened (#71).
  const none = startIn({ "herdr.space": "sp-caller", "herdr.tab": "tb-c" }, { projectSpace: false });
  assert.deepEqual([none.json().space, none.json().tab], ["sp-new1", null]);
  assert.deepEqual(none.appCalls.slice(0, 3).map((c) => c.slice(0, 2)), [["ls"], ["do", "space.new"], ["ls"]]);
  // Then only looks at the window (for the bot's tab, to close the new space's spare shell's):
  // this fake window never shows the bot, so nothing is closed.
  assert.deepEqual([...new Set(none.appCalls.slice(3).map((c) => c[0]))], none.appCalls.length > 3 ? ["ls"] : []);
});

test("start a member: parent is its lead's live terminal, outliving it; else --no-parent; --space/--tab add placement labels", (t) => {
  const s = scene(t, { terminals: [term("t7", { bot: ID.cap, cwd: "/p" }), term("t8", { bot: ID.main, argv: ["bash"] })] });
  s.seed(team());
  assert.equal(s.cli(["start", "Dev", "--space", "sp1", "--tab", "tb2"]).code, 0);
  const run = runCall(s.calls());
  assert.deepEqual(run.slice(run.indexOf("--parent"), run.indexOf("--")), ["--parent", "t7", "--outlive-parent"]);
  assert.ok(run.includes("herdr.space=sp1") && run.includes("herdr.tab=tb2"));
  // Captain is attached to t7 (imported from its label): reported, not started twice. So is
  // Genie in t8, a shell in front or not: the ledger ties it. Detached, Genie starts, with no parent.
  assert.match(s.cli(["start", "Captain"]).out, /already running in t7/);
  assert.match(s.cli(["start", "Genie"]).out, /already running in t8/);
  assert.equal(s.cli(["detach", "Genie"]).code, 0);
  assert.equal(s.cli(["start", "Genie"]).code, 0);
  const runs = s.calls().filter((c) => c[0] === "run");
  assert.equal(runs.length, 2);
  assert.ok(runs[1].includes("--no-parent"));
});

test("start: --tab without --space is a usage mistake (exit 2), nothing started", (t) => {
  const s = scene(t);
  s.seed(team());
  const r = s.cli(["start", "Genie", "--tab", "tb2"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /--tab needs --space/);
  assert.equal(runCall(s.calls()), undefined);
});

test("start: the main bot not live gives --no-parent; planned and agentless bots are refused; a missing briefing script only warns", (t) => {
  const s = scene(t, { briefing: false });
  s.seed(team());
  const r = s.cli(["start", "Captain"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /gets no per-turn briefing: .*briefing\.mjs isn't there/);
  assert.equal(existsSync(join(s.project, ".claude/settings.local.json")), false);
  const run = runCall(s.calls());
  assert.ok(run.includes("--no-parent"));
  assert.equal(run.includes("--parent"), false);
  const planned = s.cli(["start", "Studio"]);
  assert.equal(planned.code, 1);
  assert.match(planned.err, /Studio is planned \(wave 3\)/);
  assert.equal(s.calls().filter((c) => c[0] === "run").length, 1);
});

test("start on a CLI-only host (no pack, the am part installed) writes am's entry hook, never the pack's", (t) => {
  const s = scene(t, { briefing: false, amPart: true });
  s.seed(team());
  const r = s.cli(["start", "Genie"]);
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.err, /gets no per-turn briefing/, "the am part's briefing is there: no warning");
  const settings = JSON.parse(readFileSync(join(s.project, ".claude/settings.local.json"), "utf8"));
  const store = join(s.home, ".automagik", "parts", "automagik.am");
  assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, amPartHookCommand(s.app, store));
  assert.ok(!settings.hooks.UserPromptSubmit[0].hooks[0].command.includes(join(s.app, "mods")), "never a pack path");
});

// ---- attach, detach ----

test("attach refuses a Claude pane whose session runs outside the project, naming both folders; nothing written", (t) => {
  const s = scene(t, { terminals: [term("t9", { cwd: "/elsewhere" })] });
  s.seed(team());
  const outside = scratchProject(s.root, "outside");
  const st = s.hcState();
  st.terminals[0].foreground.cwd = outside;
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  const r = s.cli(["attach", "Genie", "t9"]);
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`runs in ${outside}.*not to Genie's project ${s.project}`));
  assert.deepEqual(labelCalls(s.calls()), []);
  assert.equal(existsSync(join(outside, ".claude")), false);
  assert.deepEqual(s.hcState().terminals[0].labels, {});
});

test("attach refuses another bot's pane and a pane that isn't live; a planned bot is refused", (t) => {
  const s = scene(t, { terminals: [term("t4", { bot: ID.cap }), term("t5", { state: "finished" })] });
  s.seed(team());
  assert.match(s.cli(["attach", "Genie", "t4"]).err, /t4 already plays Captain \(b-bbbbbbbbbb\)/);
  assert.match(s.cli(["attach", "Genie", "t5"]).err, /t5 isn't a live terminal/);
  assert.match(s.cli(["attach", "Studio", "t4"]).err, /Studio is planned/);
  assert.match(s.cli(["attach", "Genie", "vps/t4"]).err, /vps\/t4 is on vps; name the bot's project there: --machine vps/);
  assert.deepEqual(labelCalls(s.calls()), []);
});

test("attach of a bot attached elsewhere is refused, naming the holder; --move moves it, labels following", (t) => {
  const s = scene(t);
  const sub = join(s.project, "pkg");
  mkdirSync(sub);
  const st = { terminals: [term("t1", { bot: ID.main, cwd: s.project }), term("t2", { cwd: sub })], next: 100 };
  st.terminals[1].foreground.cwd = sub;
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  s.seed(team());
  const bare = s.cli(["attach", "Genie", "t2"]);
  assert.equal(bare.code, 1);
  assert.match(bare.err, /Genie \(b-aaaaaaaaaa\) is attached to t1 \(since .*\); nothing was attached\. Move it with: am attach b-aaaaaaaaaa t2 --move/);
  assert.deepEqual(labelCalls(s.calls()), []);
  const r = s.cli(["attach", "Genie", "t2", "--move", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json().movedFrom, ["t1"]);
  assert.deepEqual(labelCalls(s.calls()), [["label", "t1", "bot="], ["label", "t2", `bot=${ID.main}`], ["label", "t2", "role=main"]]);
  const labels = Object.fromEntries(s.hcState().terminals.map((x) => [x.address, x.labels]));
  assert.deepEqual(labels, { t1: {}, t2: { bot: ID.main, role: "main" } });
  assert.ok(existsSync(join(sub, ".claude/settings.local.json")));
  assert.match(r.err, /no briefing, restart the bot: am restart b-[a-z2-7]{10} \(or the bot row's Restart\)/);
});

test("attach: a label write that fails only warns: the ledger has the move", (t) => {
  const s = scene(t);
  writeFileSync(join(s.root, "hc.json"), JSON.stringify({ terminals: [term("t1", { bot: ID.dev, app: "codex", argv: ["codex"] }), term("t2", { app: "codex", argv: ["codex"] })], failLabel: "t2" }));
  s.seed(team());
  const r = s.cli(["attach", "Dev", "t2", "--move"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /the ledger has it, but hc label t2 bot=b-cccccccccc failed/);
  assert.equal(s.cli(["whois", "t2", "--json"]).json().bot, ID.dev);
  assert.equal(s.cli(["whois", "t1", "--json"]).json().bot, null);
});

test("detach unties the bot from its ledger pane and takes the label off every local pane carrying it", (t) => {
  const s = scene(t, { terminals: [term("t1", { bot: ID.cap }), term("t2", { bot: ID.cap, argv: ["zsh"] })] });
  s.seed(team());
  const r = s.cli(["detach", "Captain", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json(), { id: ID.cap, defined: true, detached: ["t1"], labelsCleared: ["t1", "t2"] });
  assert.deepEqual(s.hcState().terminals.map((x) => x.labels), [{}, {}]);
  assert.match(s.cli(["detach", "Captain"]).out, /no pane on this computer/);
});

// ---- brief, errors ----

test("brief: a member blocked on a permission reads 'stuck (waiting for a permission answer)'", (t) => {
  const t3 = term("t3", { bot: ID.dev, status: "blocked" });
  t3.status.kind = "permission";
  const s = scene(t, { terminals: [t3, term("t2", { bot: ID.cap })] });
  s.seed(team());
  const r = s.cli(["brief", "Captain"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^- Dev .*: stuck \(needs a person to answer a permission\) at t3\.$/m);
});

test("brief prints the bot's briefing: a lead sees its members' status and reports; planned bots get none", (t) => {
  const s = scene(t, { terminals: [term("t3", { bot: ID.dev, status: "blocked", msg: "waiting on the schema" }), term("t2", { bot: ID.cap })] });
  s.seed(team());
  const r = s.cli(["brief", "Captain"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Captain/);
  assert.match(r.out, /Dev/);
  assert.match(r.out, /waiting on the schema/);
  const dev = s.cli(["brief", "Dev", "--json"]).json();
  assert.match(dev.briefing, /t2/, "a member is told its lead's terminal");
  assert.equal(s.cli(["brief", "Studio", "--json"]).json().briefing, null);
});

test("errors: stderr and a non-zero exit; unknown commands and options are usage errors; names must be unique", (t) => {
  const s = scene(t);
  s.seed(team());
  const unknown = s.cli(["frob"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /unknown command "frob"/);
  assert.equal(s.cli(["ls", "--bogus"]).code, 2);
  assert.equal(s.cli(["show"]).code, 2);
  assert.equal(s.cli(["--help"]).code, 0);
  const f = team();
  assert.throws(() => findBot({ ...f, bots: [...f.bots, bot("b-ffffffffff", "member", { name: "Dev" })] }, "Dev"), /2 bots are named "Dev"/);
  assert.equal(findBot(f, "genie").id, ID.main);
  const broken = s.botsPath;
  writeFileSync(broken, "{nope");
  const r = s.cli(["ls"]);
  assert.match(r.out, /not valid JSON|Unexpected token|Expected property name|JSON Parse error/);
});

// ---- review fixes ----

test("rm never deletes a file that still holds bots: members with no main bot are refused, file intact", (t) => {
  const s = scene(t);
  const f = team();
  f.bots = f.bots.filter((b) => b.kind !== "main"); // parseBots only warns about this
  s.seed(f);
  const before = readFileSync(s.botsPath, "utf8");
  const r = s.cli(["rm", "Studio"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /Not saved: .*0 main bots/);
  assert.equal(readFileSync(s.botsPath, "utf8"), before);
});

test("rm of the main bot counts entries parseBots left out as other bots", (t) => {
  const s = scene(t);
  s.seed({ version: 1, categories: [], bots: [bot(ID.main, "main", { name: "Genie" }), { id: ID.dev, kind: "member" }] });
  const r = s.cli(["rm", "Genie"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /still has 1 other bot/);
  assert.ok(existsSync(s.botsPath));
});

test("start places the pane in the space of a live terminal in the project; with none it warns the pane is unseen", (t) => {
  const s = scene(t);
  s.seed(team());
  const sub = join(s.project, "pkg");
  mkdirSync(sub);
  const placed = term("t20", { cwd: sub, argv: ["zsh"], app: "zsh" });
  placed.labels = { "herdr.space": "sp9", "herdr.tab": "tb3" };
  const elsewhere = term("t21", { cwd: s.root, argv: ["zsh"], app: "zsh" });
  elsewhere.labels = { "herdr.space": "sp-other" };
  writeFileSync(join(s.root, "hc.json"), JSON.stringify({ terminals: [elsewhere, placed], next: 100 }));
  const r = s.cli(["start", "Genie", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([r.json().space, r.json().tab], ["sp9", null]);
  const run = runCall(s.calls());
  assert.ok(run.includes("herdr.space=sp9") && !run.some((a) => a.startsWith("herdr.tab=")), run.join(" "));
  assert.doesNotMatch(r.err, /unseen/);
  // No terminal of the project carries a space and no window answers: started, with the warning.
  const s2 = scene(t);
  s2.seed(team());
  const r2 = s2.cli(["start", "Genie"]);
  assert.equal(r2.code, 0, r2.err);
  assert.match(r2.err, /No open Herdr space shows .*, so Herdr gives t100 no pane: it runs, unseen\. Watch it with hc attach t100/);
});

test("start with no space showing the project opens one on its folder and starts the bot in it; an open one is used", (t) => {
  const s = scene(t, { window: { spaces: [{ id: "sp1", name: "Other", folder: "/elsewhere", machine: null, active: true,
    tabs: [{ id: "tb1", name: "1", active: true, terminals: [] }] }] } });
  s.seed(team());
  const r = s.cli(["start", "Genie", "--json"]);
  assert.equal(r.code, 0, r.err);
  const made = s.appCalls().find((c) => c[0] === "do");
  assert.deepEqual(made && [made[1], JSON.parse(made[2])], ["space.new", { name: "proj", folder: s.project, machine: "" }]);
  assert.deepEqual([r.json().space, r.json().tab], ["sp-new1", null]);
  const run = runCall(s.calls());
  assert.ok(run.includes("herdr.space=sp-new1") && !run.some((a) => a.startsWith("herdr.tab=")), run.join(" "));
  assert.doesNotMatch(r.err, /unseen/);
  // That space is open now: the next bot starts in it, and no second space is made.
  assert.equal(s.cli(["start", "Captain"]).code, 0);
  assert.equal(s.appCalls().filter((c) => c[0] === "do").length, 1);
  assert.equal(s.windowNow().spaces.length, 2);
  assert.ok(runCall(s.calls().filter((c) => c.includes("bot=" + ID.cap))).includes("herdr.space=sp-new1"));
  // A project terminal still labelled with a space the window no longer shows (its last
  // pane closed): that label is passed over and a space is opened.
  const s3 = scene(t, { window: { spaces: [] } });
  s3.seed(team());
  const stale = term("t20", { cwd: s3.project, argv: ["zsh"], app: "zsh" });
  stale.labels = { "herdr.space": "sp9", "herdr.tab": "tb3" };
  writeFileSync(join(s3.root, "hc.json"), JSON.stringify({ terminals: [stale], next: 100 }));
  const r3 = s3.cli(["start", "Genie", "--json"]);
  assert.equal(r3.code, 0, r3.err);
  assert.deepEqual([r3.json().space, r3.json().tab], ["sp-new1", null]);
  // Another start opened a space on the folder at the same time: the first one is used and
  // the space this start opened is closed, so one space shows the project.
  const s4 = scene(t, { window: { spaces: [], rival: true } });
  s4.seed(team());
  const r4 = s4.cli(["start", "Genie", "--json"]);
  assert.equal(r4.code, 0, r4.err);
  assert.equal(r4.json().space, "sp-rival");
  assert.deepEqual(s4.appCalls().filter((c) => c[0] === "do").map((c) => [c[1], JSON.parse(c[2]).id ?? null]),
    [["space.new", null], ["space.close", "sp-new1"]]);
  assert.deepEqual(s4.windowNow().spaces.map((x) => x.id), ["sp-rival"]);
  // --space still picks the place: the window isn't asked.
  const s2 = scene(t, { window: { spaces: [] } });
  s2.seed(team());
  assert.equal(s2.cli(["start", "Genie", "--space", "sp7"]).code, 0);
  assert.deepEqual(s2.appCalls(), []);
});

test("start in a space it opened closes its lone shell tab only while it is the fresh shell space.new made, bare and idle", (t) => {
  // Herdr's real ls shape (no pane count): the shell (t-sh1) seen right after space.new as the
  // space's one tab and that tab's one terminal, idle with no child; Herdr shows the bot (t100) in tb-t100.
  const s = scene(t, { window: { spaces: [], place: true } });
  s.seed(team());
  const r = s.cli(["start", "Genie", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([r.json().space, r.json().tab], ["sp-new1", null]);
  // Never `confirmed`: Herdr asks the person only before closing a space's last tab.
  assert.deepEqual(s.appCalls().filter((c) => c[0] === "do").map((c) => [c[1], JSON.parse(c[2])]),
    [["space.new", { name: "proj", folder: s.project, machine: "" }], ["tab.close", { id: "tb-new1" }]]);
  assert.deepEqual(s.windowNow().spaces.map((x) => [x.id, x.tabs.map((tb) => tb.id)]), [["sp-new1", ["tb-t100"]]]);
  // The next bot starts in that space: nothing else is closed.
  assert.equal(s.cli(["start", "Captain"]).code, 0);
  assert.equal(s.appCalls().filter((c) => c[0] === "do").length, 2);
  // An ls that counts one pane there closes it too.
  const c = scene(t, { window: { spaces: [], place: true, paneCounts: true } });
  c.seed(team());
  assert.equal(c.cli(["start", "Genie"]).code, 0);
  assert.deepEqual(c.windowNow().spaces[0].tabs.map((tb) => tb.id), ["tb-t100"]);
  // Kept: a counted mod pane beside the shell; vim in front of the shell; the shell at its
  // prompt with a job left running (`sleep 99 &`: a child pgrep finds); its children unknown
  // (pgrep failing with exit 3 or with exit 1 and an error, or killed before it exits, as at its timeout).
  for (const extra of [{ paneCounts: true, modInSpare: true }, { shellBusy: true }, { shellJob: true }, { shellUnknown: true },
    { shellPgrepError: true }, { shellPgrepKilled: true }]) {
    const k = scene(t, { window: { spaces: [], place: true, ...extra } });
    k.seed(team());
    assert.equal(k.cli(["start", "Genie"]).code, 0);
    assert.deepEqual(k.appCalls().filter((c) => c[0] === "do").map((c) => c[1]), ["space.new"], JSON.stringify(extra));
    assert.deepEqual(k.windowNow().spaces[0].tabs.map((tb) => tb.id), ["tb-new1", "tb-t100"], JSON.stringify(extra));
  }
  // A bot Herdr doesn't show in time: the shell's tab is the space's only one, kept.
  const n = scene(t, { window: { spaces: [] } });
  n.seed(team());
  assert.equal(n.cli(["start", "Genie"]).code, 0);
  assert.deepEqual(n.appCalls().filter((c) => c[0] === "do").map((c) => c[1]), ["space.new"]);
  assert.deepEqual(n.windowNow().spaces[0].tabs.map((tb) => tb.id), ["tb-new1"]);
  // A space that was open already is never this start's: its tabs are left as they are.
  const o = scene(t, { window: { place: true, spaces: [{ id: "sp1", name: "proj", folder: "", machine: null, active: true,
    tabs: [{ id: "tb1", name: "1", active: true, terminals: [{ terminal: "t-sh9", pane: "p9" }] }] }] } });
  o.seed(team());
  const open = JSON.parse(readFileSync(join(o.root, "herdr-app.json"), "utf8"));
  open.spaces[0].folder = o.project;
  writeFileSync(join(o.root, "herdr-app.json"), JSON.stringify(open));
  assert.equal(o.cli(["start", "Genie"]).code, 0);
  assert.deepEqual(o.appCalls().filter((c) => c[0] === "do"), []);
  // (No spare to close, so the window isn't read again: the fake never adds the bot's tab.)
  assert.deepEqual(o.windowNow().spaces[0].tabs.map((tb) => tb.id), ["tb1"]);
  // AUTOMAGIK_HERDR_TAB_WAIT_MS=0 turns it off: no wait for the bot's tab, nothing closed.
  const off = scene(t, { window: { spaces: [], place: true } });
  off.seed(team());
  assert.equal(off.cli(["start", "Genie"], { env: { AUTOMAGIK_HERDR_TAB_WAIT_MS: "0" } }).code, 0);
  assert.deepEqual(off.appCalls().map((c) => c.slice(0, 2)), [["ls"], ["do", "space.new"], ["ls"]]);
});


test("start refuses an old free-text model pin, naming the fix; a pane started under a minute ago counts as running", (t) => {
  const f = team();
  f.bots[0].model = "Opus 5.5";
  const s = scene(t, { terminals: [term("t30", { bot: ID.cap, argv: ["sh", "-c", "claude"], app: "sh", created: Date.now() })] });
  s.seed(f);
  const r = s.cli(["start", "Genie"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /pinned to "Opus 5\.5", which isn't a claude model this computer lists\. Pick one with am edit b-aaaaaaaaaa --model/);
  const young = s.cli(["start", "Captain"]);
  assert.equal(young.code, 0);
  assert.match(young.out, /already running in t30/);
  assert.equal(s.calls().some((c) => c[0] === "run"), false);
});

test("a failing hc never reads as 'no pane': start, attach and detach refuse; ls and show say hc is unavailable", (t) => {
  const s = scene(t);
  s.seed(team());
  const st = { terminals: [term("t1", { bot: ID.main, cwd: s.project })], fail: ["server"] };
  st.terminals[0].foreground.cwd = s.project;
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  for (const args of [["start", "Genie"], ["attach", "Genie", "t1"], ["detach", "Genie"]]) {
    const r = s.cli(args);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.err, /hc server status failed: hc: can't reach the server/);
  }
  assert.equal(s.calls().some((c) => c[0] === "run" || c[0] === "label"), false);
  const ls = s.cli(["ls", "--json"]);
  assert.equal(ls.code, 0, ls.err);
  const genie = ls.json().projects[0].bots[0];
  assert.equal(genie.status, "hc unavailable");
  assert.match(genie.hcError, /can't reach the server/);
  assert.match(s.cli(["ls"]).out, /panes unknown: hc server status/);
  assert.equal(s.cli(["show", "Genie", "--json"]).json().status, "hc unavailable");
  assert.equal(s.cli(["brief", "Genie"]).code, 0, "the briefing still prints, members unreachable");
});

test("the CLI's own hc resolution skips guard folders it can vouch for: pack, am copy, stub once", (t) => {
  const s = scene(t);
  s.seed(team());
  const meter = { tasks: { "gl-1": { usd: 1.25, work_min: 30, lead_min: 4 } } };
  writeFileSync(join(s.root, "hc.json"), JSON.stringify({ terminals: [], next: 100, docs: { "herdr-meter": { value: meter, version: 7 } } }));
  const am = join(s.root, "am"), amGuard = join(am, "guard"), amRan = join(s.root, "am-guard-ran");
  mkdirSync(amGuard, { recursive: true });
  copyFileSync(join(GUARD_DIR, "..", "hcGuard.mjs"), join(am, "hcGuard.mjs"));
  writeFileSync(join(amGuard, "hc"), `#!/bin/sh\n: > "${amRan}"\nexit 9\n`);
  chmodSync(join(amGuard, "hc"), 0o755);
  const bin = join(s.root, "bin");
  const r = s.cli(["doc", "get", "herdr-meter"], { env: { PATH: `${GUARD_DIR}:${amGuard}:${bin}` } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), meter);
  assert.deepEqual(s.calls(), [["connect"]], "the stub hc was reached exactly once");
  assert.equal(existsSync(amRan), false, "the am guard copy was skipped, not run");
});

test("a planted hcGuard.mjs does not hide a folder from the CLI's own hc resolution", (t) => {
  const s = scene(t);
  s.seed(team());
  writeFileSync(join(s.root, "hc.json"), JSON.stringify({ terminals: [], next: 100 }));
  const planted = join(s.root, "planted"), plantedGuard = join(planted, "guard"), ran = join(s.root, "planted-ran");
  mkdirSync(plantedGuard, { recursive: true });
  writeFileSync(join(planted, "hcGuard.mjs"), "// planted, not a guard\n");
  writeFileSync(join(plantedGuard, "hc"), `#!/bin/sh\n: > "${ran}"\nexit 1\n`);
  chmodSync(join(plantedGuard, "hc"), 0o755);
  const r = s.cli(["ls", "--json"], { env: { PATH: `${GUARD_DIR}:${plantedGuard}:${join(s.root, "bin")}` } });
  assert.equal(r.code, 0, r.err);
  assert.equal(existsSync(ran), true, "the planted hc was reached, not skipped");
  const bot = r.json().projects[0].bots[0];
  assert.equal(bot.status, "hc unavailable", "the trusted call used the planted hc, which failed");
  assert.equal(s.calls().some((c) => c[0] === "server"), false, "the stub never answered the trusted call");
});

test("an attached pane with a shell in front stays the bot's: shown as no agent in front, never as another's", (t) => {
  const s = scene(t, { terminals: [term("t1", { bot: ID.main, argv: ["zsh"], app: "zsh" }), term("t2", { bot: ID.cap })] });
  s.seed(team());
  const bots = s.cli(["ls", "--json"]).json().projects[0].bots;
  const gets = s.calls().filter((c) => c[0] === "get").map((c) => c[1]);
  assert.ok(gets.includes("t2") && gets.includes("t1"));
  assert.deepEqual([bots.find((b) => b.id === ID.main).terminal, bots.find((b) => b.id === ID.main).status], ["t1", "no agent in front"]);
  assert.equal(bots.find((b) => b.id === ID.cap).terminal, "t2");
});

test("attach: a terminal argument that looks like an option is refused; a claude wrapper counts as a Claude pane", (t) => {
  const s = scene(t, { terminals: [term("t9", { argv: ["node", "/opt/claude.js"], app: "agent", cwd: "/elsewhere" })] });
  s.seed(team());
  const opt = s.cli(["attach", "Genie", "--", "--all"]);
  assert.equal(opt.code, 2);
  assert.match(opt.err, /"--all" isn't a terminal/);
  const outside = scratchProject(s.root, "outside");
  const st = s.hcState();
  st.terminals[0].foreground.cwd = outside;
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  const r = s.cli(["attach", "Genie", "t9"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /Not attached: this Claude session runs in/);
  assert.deepEqual(labelCalls(s.calls()), []);
});

test("ls over more bots than the eight-process cap completes, each live pane found", (t) => {
  const ids = Array.from({ length: 12 }, (_, i) => `b-${"abcdefghijkl"[i].repeat(10)}`);
  const s = scene(t, { terminals: ids.map((id, i) => term(`t${i + 1}`, { bot: id })) });
  s.seed({ version: 1, categories: [], bots: ids.map((id, i) => bot(id, i === 0 ? "main" : "member", { name: `B${i}` })) });
  const r = s.cli(["ls", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json().projects[0].bots.map((b) => b.terminal), ids.map((_, i) => `t${i + 1}`));
});

test("detach takes a removed bot's label off by its bare id; an unknown name is still refused", (t) => {
  const s = scene(t, { terminals: [term("t1", { bot: ID.dev }), term("t2", { bot: ID.dev, argv: ["zsh"], app: "zsh" })] });
  s.seed(team());
  const rm = s.cli(["rm", "Dev"]);
  assert.equal(rm.code, 0, rm.err);
  assert.match(rm.err, new RegExp(`t1 is still attached to it; detach it with: am detach ${ID.dev}`));
  const r = s.cli(["detach", ID.dev, "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json(), { id: ID.dev, defined: false, detached: ["t1"], labelsCleared: ["t1", "t2"] });
  assert.deepEqual(s.hcState().terminals.map((x) => x.labels), [{}, {}]);
  assert.match(s.cli(["detach", "Ghost"]).err, /No bot "Ghost"/);
  // No bots.json at all: a bare id still works.
  rmSync(s.botsPath);
  assert.equal(s.cli(["detach", ID.dev]).code, 0);
});

// ---- A16: pane labels ----

const labelsIn = (s) => Object.fromEntries(s.hcState().terminals.map((x) => [x.address, x.labels]));

test("--rank on create and edit: checked against the set, '' clears it; show and ls --json carry it", (t) => {
  const s = scene(t);
  s.seed(team());
  const bad = s.cli(["edit", "Dev", "--rank", "boss"]);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /--rank is one of captain, dev, tester, reviewer, fixer, integrator, pm, owner/);
  assert.equal(s.cli(["create", "--name", "Ana", "--agent", "claude", "--rank", "tester"]).code, 0);
  assert.equal(s.bots().bots.find((b) => b.name === "Ana").rank, "tester");
  assert.equal(s.cli(["edit", "Dev", "--rank", "reviewer"]).code, 0);
  assert.equal(s.cli(["show", "Dev", "--json"]).json().rank, "reviewer");
  assert.match(s.cli(["show", "Dev"]).out, /rank\s+reviewer/);
  assert.equal(s.cli(["ls", "--json"]).json().projects[0].bots.find((b) => b.name === "Dev").rank, "reviewer");
  assert.equal(s.cli(["edit", "Dev", "--rank", ""]).code, 0);
  assert.equal("rank" in s.bots().bots.find((b) => b.name === "Dev"), false);
  assert.equal(s.cli(["show", "Dev", "--json"]).json().rank, null);
});

test("start labels the pane: role from rank or captaincy, category, and the lead pane's squad, marked", (t) => {
  const lead = term("t7", { bot: ID.cap });
  lead.labels.squad = "memory";
  const s = scene(t, { terminals: [lead] });
  const f = team();
  f.bots.find((b) => b.id === ID.dev).rank = "dev";
  s.seed(f);
  assert.equal(s.cli(["start", "Dev"]).code, 0);
  const run = runCall(s.calls());
  const labels = run.flatMap((w, i) => (run[i - 1] === "--label" ? [w] : []));
  assert.deepEqual(labels.slice(0, 5), [`bot=${ID.dev}`, "role=dev", "category=eng", "squad=memory", "automagik-herdr.squad=memory"]);
  assert.match(labels[5] ?? "", /^agent\.session=[0-9a-f-]{36}$/, "a Claude start's chosen session (RFC 0021)");
  assert.equal(labels.length, 6);
});

test("attach labels the pane and keeps its own squad; detach takes off bot, role, category and only a copied squad", (t) => {
  const lead = term("t7", { bot: ID.cap });
  lead.labels.squad = "memory";
  const own = term("t8", { cwd: "/x" });
  own.labels.squad = "infra";
  const s = scene(t, { terminals: [lead, own, term("t9", { cwd: "/x" })] });
  const f = team();
  f.bots.find((b) => b.id === ID.dev).rank = "tester";
  s.seed(f);
  for (const [address] of [["t8"], ["t9"]]) {
    const st = s.hcState();
    st.terminals.find((x) => x.address === address).foreground.cwd = s.project;
    writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  }
  assert.equal(s.cli(["attach", "Dev", "t8"]).code, 0);
  assert.deepEqual(labelsIn(s).t8, { squad: "infra", bot: ID.dev, role: "tester", category: "eng" });
  // Moved to t9: t8 loses what Detach takes off, keeping its own squad; t9 copies the lead's.
  assert.equal(s.cli(["attach", "Dev", "t9", "--move"]).code, 0);
  assert.deepEqual(labelsIn(s).t8, { squad: "infra" });
  assert.deepEqual(labelsIn(s).t9, { bot: ID.dev, role: "tester", category: "eng", squad: "memory", "automagik-herdr.squad": "memory" });
  assert.equal(s.cli(["detach", "Dev"]).code, 0);
  assert.deepEqual(labelsIn(s).t9, {});
  // The captain's own squad stays on detach: this pack didn't put it there.
  assert.equal(s.cli(["detach", "Captain"]).code, 0);
  assert.deepEqual(labelsIn(s).t7, { squad: "memory" });
});

test("an edit relabels the live local panes it changes, the old and new leads included; a remote pane is never touched", (t) => {
  const s = scene(t, { terminals: [
    term("t1", { bot: ID.main }), term("t7", { bot: ID.cap }), term("t8", { bot: ID.dev }), term("far/t9", { bot: ID.dev }),
  ] });
  const f = team();
  f.bots.find((b) => b.id === ID.cap).rank = "integrator";
  s.seed(f);
  // Labels as Start would have set them.
  const st = s.hcState();
  Object.assign(st.terminals.find((x) => x.address === "t7").labels, { role: "captain", category: "eng" });
  Object.assign(st.terminals.find((x) => x.address === "t8").labels, { category: "eng" });
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  // Dev moves to the main bot, no category, rank dev: the captain leads nobody now.
  const r = s.cli(["edit", "Dev", "--lead", "Genie", "--rank", "dev", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json().relabelled.sort(), ["t7", "t8"]);
  const labels = labelsIn(s);
  assert.deepEqual(labels.t7, { bot: ID.cap, role: "integrator", category: "eng" });
  assert.deepEqual(labels.t8, { bot: ID.dev, role: "dev" });
  assert.deepEqual(labels["far/t9"], { bot: ID.dev });
  assert.equal(labelCalls(s.calls()).some((c) => c[1].includes("/")), false);
  // A change that moves no label: no label call.
  const before = labelCalls(s.calls()).length;
  assert.equal(s.cli(["edit", "Dev", "--role", "writes code"]).code, 0);
  assert.equal(labelCalls(s.calls()).length, before);
});

test("category add --id takes slug ids only; a hand-written non-slug id stays usable, with no category label", (t) => {
  const s = scene(t, { terminals: [term("t8", { bot: ID.dev })] });
  s.seed(team());
  const bad = s.cli(["category", "add", "--title", "Quality", "--id", "Quality Gate"]);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /--id "Quality Gate" isn't a category id: a lowercase slug/);
  assert.equal(s.cli(["category", "add", "--title", "Quality Gate!"]).code, 0);
  assert.ok(s.bots().categories.some((c) => c.id === "quality-gate"));
  // brain-v3 style: "Knowledge" written by hand. Edits of the file still work.
  const f = team();
  f.categories.push({ id: "Knowledge", title: "Knowledge" });
  s.seed(f);
  const r = s.cli(["edit", "Dev", "--lead", "Genie", "--category", "Knowledge", "--rank", "dev"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(s.bots().bots.find((b) => b.id === ID.dev).category, "Knowledge");
  assert.equal(s.cli(["edit", "Captain", "--role", "still editable"]).code, 0);
  // Its pane gets a role but no category= label.
  assert.deepEqual(labelsIn(s).t8, { bot: ID.dev, role: "dev" });
});

test("a lead change moves the squad copied from the old lead, and leaves a pane's own squad", (t) => {
  const cap = term("t7", { bot: ID.cap });
  cap.labels.squad = "memory";
  const main = term("t1", { bot: ID.main });
  main.labels.squad = "core";
  const dev = term("t8", { bot: ID.dev });
  Object.assign(dev.labels, { squad: "memory", "automagik-herdr.squad": "memory" });
  const s = scene(t, { terminals: [main, cap, dev] });
  s.seed(team());
  assert.equal(s.cli(["edit", "Dev", "--lead", "Genie"]).code, 0);
  assert.deepEqual([labelsIn(s).t8.squad, labelsIn(s).t8["automagik-herdr.squad"]], ["core", "core"]);
  // Its own squad (set after the copy) stays when the lead changes again.
  const st = s.hcState();
  st.terminals.find((x) => x.address === "t8").labels.squad = "ops";
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  assert.equal(s.cli(["edit", "Dev", "--lead", "Captain"]).code, 0);
  assert.equal(labelsIn(s).t8.squad, "ops");
  // Detach keeps that squad and takes the mark off.
  assert.equal(s.cli(["detach", "Dev"]).code, 0);
  assert.deepEqual(labelsIn(s).t8, { squad: "ops" });
});

test("attach leaves the pane matching the bot: a stale role or category from its last bot comes off; an unmarked squad stays", (t) => {
  const pane = term("t8", { cwd: "/x" });
  Object.assign(pane.labels, { role: "captain", category: "old", squad: "ops" });
  const s = scene(t, { terminals: [pane] });
  s.seed(team()); // Dev: no rank, under the captain (category eng)
  const st = s.hcState();
  st.terminals[0].foreground.cwd = s.project;
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  assert.equal(s.cli(["attach", "Dev", "t8"]).code, 0);
  assert.deepEqual(labelsIn(s).t8, { squad: "ops", bot: ID.dev, category: "eng" });
});

test("start: an edit landing during hc run relabels the new pane; a failed relabel reaches stderr", (t) => {
  const s = scene(t);
  s.seed(team());
  const edited = team();
  edited.bots.find((b) => b.id === ID.dev).rank = "reviewer";
  const st = s.hcState();
  st.onRunWrite = { path: s.botsPath, text: `${JSON.stringify(edited, null, 2)}\n` };
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  const ok = s.cli(["start", "Dev"]);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(labelsIn(s).t100.role, "reviewer");
  // Again, with the new pane refusing the label.
  s.seed(team());
  const st2 = s.hcState();
  st2.terminals = [];
  st2.failLabel = "t101";
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st2));
  const r = s.cli(["start", "Dev"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /t101's labels role=reviewer weren't set\./);
});

// ---- restart ----

// The replacement must keep its agent in front this long before the old pane ends (5s live).
process.env.AUTOMAGIK_HERDR_RESTART_STABLE_MS = "300";
const SID = "0f3c2a4e-1b2d-4c5e-9f60-718293a4b5c6";
const SID2 = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const screenFixture = (name) => readFileSync(new URL(`../mods/pocket-link/chat/fixtures/screens/${name}`, import.meta.url), "utf8");
const ledgerOf = (s) => readLedger(existsSync(ledgerPath(s.app)) ? readFileSync(ledgerPath(s.app), "utf8") : "");
const attachOf = (s) => readRows(existsSync(attachFile(s.app)) ? readFileSync(attachFile(s.app), "utf8") : "").rows;

/** Genie's live pane t5 in the project, placed in sp9/tb3, with a Claude session and a squad. */
function restartScene(t, { status = "idle", extra = [], session = SID, runAs, runScreen, paneArgv = null } = {}) {
  const s = scene(t);
  s.seed(team());
  const old = term("t5", { bot: ID.main, cwd: s.project, status });
  old.foreground.cwd = s.project;
  // A pane started with words the bot's definition may no longer name (hc get's launch argv).
  if (paneArgv) { old.argv = paneArgv; old.foreground.argv = paneArgv; }
  old.labels = { ...old.labels, role: "main", "herdr.space": "sp9", "herdr.tab": "tb3", squad: "core", ...(session ? { "agent.session": session } : {}) };
  writeFileSync(join(s.root, "hc.json"), JSON.stringify({ terminals: [old, ...extra], next: 100, ...(runAs ? { runAs } : {}), ...(runScreen ? { runScreen } : {}) }));
  return s;
}
const at = (calls, word, target) => calls.findIndex((c) => c[0] === word && (target === undefined || c[1] === target));

test("restart: the new pane resumes the session in the old one's space and tab, folder and labels; the old one ends only after", (t) => {
  const s = restartScene(t);
  const r = s.cli(["restart", "Genie"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), "t100", "prints the new terminal");
  assert.match(r.err, /Genie: t100 replaces t5, resuming its session by id\./);
  assert.ok(!r.err.includes(SID), r.err); // RFC 0021: never printed
  const calls = s.calls();
  const run = runCall(calls);
  assert.deepEqual(plain(agentWords(run)), ["claude", "--permission-mode", "auto", "--resume", SID]);
  assert.equal(agentWords(run).filter((w) => w === "--append-system-prompt-file").length, 1, "a restart starts with it too, once");
  assert.ok(["herdr.space=sp9", "herdr.tab=tb3", `bot=${ID.main}`, "role=main", "squad=core", `agent.session=${SID}`].every((l) => run.includes(l)), run.join(" "));
  assert.equal(run[run.indexOf("--cwd") + 1], s.project);
  // Started, seen live at several checks (hc get of the new pane), and only then the old one killed.
  const ran = at(calls, "run"), killed = at(calls, "kill", "t5");
  assert.ok(ran >= 0 && ran < killed, JSON.stringify(calls));
  const seen = calls.slice(ran, killed).filter((c) => c[0] === "get" && c[1] === "t100").length;
  assert.ok(seen >= 2, `the new pane was checked before the kill: ${JSON.stringify(calls)}`);
  assert.equal(calls.filter((c) => c[0] === "kill").length, 1);
  const state = s.hcState();
  assert.equal(state.terminals.find((x) => x.address === "t5").state, "finished");
  assert.equal(state.terminals.find((x) => x.address === "t100").state, "live");
  // The attach ledger: t5's binding detached (by start, moved), t100 attached (by start), and
  // exactly one live binding for Genie, on t100.
  const attach = attachOf(s);
  assert.deepEqual(attach.slice(-2).map((x) => [x.event, x.terminal, x.by, x.reason ?? null]), [["detach", "t5", "start", "moved"], ["attach", "t100", "start", null]]);
  const bound = [...foldRows(attach).byKey.values()].filter((b) => b.bot === ID.main);
  assert.deepEqual(bound.map((b) => b.terminal), ["t100"]);
  assert.equal(foldRows(attach).byBot.get(ID.main).terminal, "t100");
  const whois = s.cli(["whois", "--bot", ID.main, "--json"]);
  assert.equal(whois.json().terminal, "t100", whois.err);
  // The seat row and the resumed session's row, for t100.
  const rows = ledgerOf(s).filter((x) => x.terminal === "t100");
  assert.deepEqual(rows.map((x) => [x.event, x.kind ?? x.session]), [["start", "seat"], ["session", SID]]);
  assert.equal(rows[0].project, s.project);
  // A second restart resumes the same conversation: the label went with it (t100 is mid-turn in the fake).
  const again = s.cli(["restart", "Genie", "--force"]);
  assert.equal(again.code, 0, again.err);
  assert.deepEqual(plain(s.calls().filter((c) => c[0] === "run")[1]).slice(-5), ["claude", "--permission-mode", "auto", "--resume", SID]);
});

test("restart rebuilds the launch from the bot's source, never the old pane's argv (#597)", (t) => {
  // The Housekeeper repro: a pane once started with a retired proxy and -c. Its definition
  // (agent, model) no longer names them, so restart launches from the source and says so.
  const stale = ["claude", "--proxy=http://proxy.example:8080", "-c"];
  const s = restartScene(t, { paneArgv: stale });
  const r = s.cli(["restart", "Genie"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(plain(agentWords(runCall(s.calls()))), ["claude", "--permission-mode", "auto", "--resume", SID], "the source's command, resumed by the session");
  assert.match(r.err, /Genie: its pane's command differs from its source now \(drops --proxy=\*\*\*; adds --permission-mode=\*\*\*\): restarting from the source/);
  assert.equal(r.err.includes("proxy.example"), false, "the value is masked");
  // --fresh: the source's command, and never the old pane's resume words.
  const f = restartScene(t, { paneArgv: stale });
  const fresh = f.cli(["restart", "Genie", "--fresh", "--json"]);
  assert.equal(fresh.code, 0, fresh.err);
  const words = plain(agentWords(runCall(f.calls())));
  assert.deepEqual(freshClaude(words), ["claude", "--permission-mode", "auto"], "neither the proxy nor a resume word");
  assert.equal(words.some((w) => ["-c", "--continue", "--resume"].includes(w)), false);
});

test("#805 restart queues working panes, lists, replaces and cancels watchers", (t) => {
  const s = restartScene(t, { status: "working" });
  const r = s.cli(["restart", "Genie", "--json"], { env: { STRAY_CORE_VAR: "leaked" } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().queued, true);
  assert.equal(r.json().reason, "working");
  const file = join(s.app, "automagik-herdr/queued-restarts.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const queued = s.cli(["restart", "--queued", "--json"]);
  assert.equal(queued.code, 0, queued.err);
  assert.equal(queued.json().queued[0].terminal, "t5");
  assert.equal(queued.json().queued[0].watcher, r.json().watcher);
  const watcher = runCall(s.calls());
  for (const flag of ["--bg", "--rm", "--no-parent", "--run-queued"]) assert.ok(watcher.includes(flag));
  const envAt = watcher.indexOf("/bin/sh");
  assert.ok(envAt >= 0 && watcher[envAt + 1] === "-c", "the watcher starts through a shell");
  assert.match(watcher[envAt + 2], /exec \/usr\/bin\/env -i "\$@"/, "the watcher starts from an empty environment");
  for (const prefix of ["HOME=", "HERDR_APP_HOME=", "PATH="]) {
    const word = watcher.find((w) => w.startsWith(prefix));
    assert.ok(word && word.length > prefix.length, `the watcher gets ${prefix}`);
  }
  assert.equal(watcher.some((w) => w.startsWith("STRAY_CORE_VAR=")), false, "herdr-core's environment does not leak");
  assert.equal(at(s.calls(), "kill", "t5"), -1);
  const again = s.cli(["restart", "Genie"]);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /restart queued.*next idle/);
  assert.ok(at(s.calls(), "kill", r.json().watcher) >= 0);
  const canceled = s.cli(["restart", "--cancel", ID.main, "--json"]);
  assert.deepEqual(canceled.json(), { id: ID.main, canceled: true, terminal: "t5" });
  assert.deepEqual(s.cli(["restart", "--queued", "--json"]).json(), { queued: [] });
  assert.match(s.cli(["restart", "Genie", "--cancel"]).out, /No restart is queued/);
  const forced = s.cli(["restart", "Genie", "--force"]);
  assert.equal(forced.code, 0, forced.err);
});

test("#805 restart queues dialogs and tells the owner to answer", (t) => {
  for (const status of ["blocked", "idle", "working"]) {
    const s = restartScene(t, { status });
    const state = s.hcState();
    state.terminals[0].screen = "Do you want to proceed?\n> 1. Yes\n2. No";
    writeFileSync(join(s.root, "hc.json"), JSON.stringify(state));
    const r = s.cli(["restart", "Genie"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /blocked on dialog "Do you want to proceed\?".*the owner must answer.*Herdr never answers dialogs/);
    const q = s.cli(["restart", "--queued", "--json"]).json().queued[0];
    assert.equal(q.reason, "blocked");
    assert.deepEqual(q.dialog, { question: "Do you want to proceed?", who: "the owner" });
    assert.equal(s.calls().some((c) => ["send", "keys"].includes(c[0])), false);
  }
});

test("#805 restart immediately handles a background shell at an empty prompt", (t) => {
  const s = restartScene(t, { status: "working" });
  const state = s.hcState();
  state.terminals[0].screen = "1 background task\n❯ ";
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(state));
  const r = s.cli(["restart", "Genie", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().replaced, "t5");
  assert.equal(r.json().queued, undefined);
});

test("#805 queued watcher waits for idle, honors saved options and consumes its entry", async (t) => {
  const s = restartScene(t, { status: "working" });
  const q = s.cli(["restart", "Genie", "--fresh", "--json"]);
  assert.equal(q.code, 0, q.err);
  const file = join(s.app, "automagik-herdr/queued-restarts.json");
  const entry = JSON.parse(readFileSync(file, "utf8"))[0];
  const state = s.hcState();
  state.idleOnWait = "t5";
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(state));
  const r = await s.cliAsync(["restart", ID.main, "--run-queued", entry.id, "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).mode, "fresh");
  assert.ok(at(s.calls(), "wait", "t5") >= 0);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), []);
  assert.equal(s.cli(["restart", ID.main, "--run-queued", entry.id]).code, 0);
});

test("#805 a queued watcher runs as its own terminal, never the caller's pane", async (t) => {
  // #805's main case: the caller is the bot's own pane, restart typed inside t5. hc starts the
  // watcher as a terminal of its own (the queue's `watcher`); that run's HC_SOCKET and
  // HC_TERMINAL_ID are the ones the watcher must reach hc with, never t5's.
  const scenario = (t, tree) => {
    const s = tree ? treeScene(t).s : restartScene(t, { status: "working" });
    // The watcher finds hc on the PATH it was queued with; env -i strips the test's
    // HC_FAKE_* variables from it, so the fake carries its own state and log, as the real
    // hc carries its own core.
    exe(join(s.root, "bin", "hc"), `#!/bin/sh\nHC_FAKE_STATE="${join(s.root, "hc.json")}" `
      + `HC_FAKE_LOG="${join(s.root, "hc.log")}" exec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
    const caller = { HC_TERMINAL_ID: "t5", HC_SOCKET: join(s.root, "caller.sock"),
      HC_TERMINAL_SOCKET: join(s.root, "caller-terminal.sock") };
    if (tree) {
      const state = s.hcState();
      state.terminals.find((x) => x.address === "t5").status = { app: "claude-code", state: "working" };
      writeFileSync(join(s.root, "hc.json"), JSON.stringify(state));
    }
    const q = s.cli(["restart", "Genie", ...(tree ? ["--tree"] : []), "--json"], { env: caller });
    assert.equal(q.code, 0, q.err);
    assert.equal(q.json().queued, true, q.err);
    assert.equal(at(s.calls(), "kill"), -1, "queuing ended nothing");
    const watcher = q.json().watcher;
    assert.ok(watcher, "the queue started a watcher");
    // The pane reaches its prompt; the watcher fires as herdr-core starts it, with its own
    // run's terminal in HC_SOCKET and HC_TERMINAL_ID.
    const state = s.hcState();
    const pane = state.terminals.find((x) => x.address === "t5");
    pane.status = { app: "claude-code", state: "idle" };
    pane.screen = "❯ ";
    writeFileSync(join(s.root, "hc.json"), JSON.stringify(state));
    const run = runCall(s.calls());
    const words = run.slice(run.indexOf("--") + 1);
    const fired = spawnSync(words[0], words.slice(1), { cwd: s.project, encoding: "utf8",
      env: { ...s.env, HC_TERMINAL_ID: watcher, HC_SOCKET: join(s.root, "watcher.sock"),
        HC_TERMINAL_SOCKET: join(s.root, "watcher-terminal.sock") } });
    const why = `${fired.stderr}${fired.stdout}`;
    assert.equal(fired.signal, null, `the watcher was ended as its own caller: ${why}`);
    assert.equal(fired.status, 0, `the watcher didn't fire the restart: ${why}`);
    assert.doesNotMatch(fired.stderr, /This runs in t5/);
    // Nothing in the command hc starts names the caller's pane: not its id, nor either socket.
    assert.equal(words.includes(`HC_TERMINAL_ID=${caller.HC_TERMINAL_ID}`), false,
      "the watcher command carries the caller's terminal id");
    assert.equal(words.some((w) => w.includes(caller.HC_SOCKET)), false, "the watcher command carries the caller's socket");
    assert.equal(words.some((w) => w.includes(caller.HC_TERMINAL_SOCKET)), false,
      "the watcher command carries the caller's terminal socket");
    const calls = s.calls();
    const ran = calls.findIndex((c) => c[0] === "run" && !c.includes("--run-queued"));
    assert.ok(ran > 0, "the watcher started the replacement");
    assert.ok(at(calls, "kill", "t5") > ran, "the old pane ended only after the replacement started");
    assert.equal(at(calls, "kill", watcher), -1, "the watcher's own terminal was left alone");
    const after = s.hcState();
    const stateOf = (addr) => after.terminals.find((x) => x.address === addr)?.state;
    assert.equal(stateOf("t5"), "finished", "the old pane ended");
    assert.equal(stateOf(watcher), "live", "the watcher's own terminal was left alone");
    assert.deepEqual(JSON.parse(readFileSync(join(s.app, "automagik-herdr/queued-restarts.json"), "utf8")), []);
    if (!tree) {
      assert.equal(stateOf("t101"), "live", "the replacement runs");
      return;
    }
    assert.deepEqual(["t7", "t8"].map(stateOf), ["finished", "finished"]);
    assert.equal(stateOf("t9"), "live", "the member bot that outlives the pane is left alone");
    assert.ok(calls.some((c) => c[0] === "run" && c.includes("fix-213-dev")), "the worker ran again");
    assert.ok(calls.some((c) => c[0] === "run" && c.includes("rev-1")), "the template helper ran again");
    assert.ok(at(calls, "kill", "t5") < calls.findIndex((c) => c[0] === "run" && c.includes("fix-213-dev")),
      "the old pane ended before its helpers ran again");
  };
  await t.test("plain restart", (t) => scenario(t, false));
  await t.test("restart --tree", (t) => scenario(t, true));
});

test("#805 a direct restart cancels the queued entry and kills its watcher", (t) => {
  const s = restartScene(t, { status: "working" });
  assert.equal(s.cli(["restart", "Genie", "--json"]).json().queued, true);
  const file = join(s.app, "automagik-herdr/queued-restarts.json");
  const entry = JSON.parse(readFileSync(file, "utf8"))[0];
  const r = s.cli(["restart", "Genie", "--force", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().replaced, "t5");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), []);
  const calls = s.calls(), replacement = calls.find((c) => c[0] === "run" && !c.includes("--run-queued"));
  assert.ok(replacement, "the replacement was launched");
  assert.ok(calls.indexOf(replacement) < at(calls, "kill", entry.watcher), "the queue is canceled only after the launch");
  assert.ok(at(calls, "kill", entry.watcher) >= 0, "the superseded watcher was ended");
});

test("#805 a mid-turn pane with a background task still queues instead of being cut off", (t) => {
  for (const screen of ["1 background task\nesc to interrupt\n❯ ", "1 background task\nctrl+b to run in background\n❯ "]) {
    const s = restartScene(t, { status: "working" });
    const state = s.hcState();
    state.terminals[0].screen = screen;
    writeFileSync(join(s.root, "hc.json"), JSON.stringify(state));
    const r = s.cli(["restart", "Genie", "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json().queued, true, screen);
    assert.equal(r.json().reason, "working", screen);
    assert.equal(at(s.calls(), "kill", "t5"), -1, "the turn was not cut short");
  }
});

test("#805 assistant prose and a markdown list above an idle prompt restart immediately", (t) => {
  for (const screen of ["Do you want to merge it now?\n\n❯ ", "Should I allow the deploy?\n\n❯ ",
    "Completed steps:\n1. Read files\n2. Run tests\n❯ "]) {
    const s = restartScene(t, { status: "idle" });
    const state = s.hcState();
    state.terminals[0].screen = screen;
    writeFileSync(join(s.root, "hc.json"), JSON.stringify(state));
    const r = s.cli(["restart", "Genie", "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json().replaced, "t5", screen);
    assert.equal(r.json().queued, undefined, screen);
  }
});

test("#805 a queued restart waits for a helper that appeared and never ends it with force", async (t) => {
  const s = restartScene(t, { status: "working" });
  assert.equal(s.cli(["restart", "Genie", "--json"]).json().queued, true);
  const file = join(s.app, "automagik-herdr/queued-restarts.json");
  const entry = JSON.parse(readFileSync(file, "utf8"))[0];
  const state = s.hcState();
  state.terminals[0].status = { state: "idle" };
  state.terminals.push({ ...term("t7", { argv: ["codex"], app: "codex", parent: "t5", created: 2, status: "working" }),
    die_with_parent: true, exitAfterGets: 3 });
  state.surviveParent = ["t7"]; // the fake keeps it live if t5 is ended first
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(state));
  const r = await s.cliAsync(["restart", ID.main, "--run-queued", entry.id, "--json"], { env: { AUTOMAGIK_HERDR_QUEUE_POLL_MS: "1" } });
  assert.equal(r.code, 0, r.err);
  assert.equal(at(s.calls(), "kill", "t7"), -1, "the helper that appeared was never ended");
  const calls = s.calls(), replacement = calls.find((c) => c[0] === "run" && !c.includes("--run-queued"));
  assert.ok(replacement, "the replacement was launched");
  const helperGetIdx = calls.reduce((all, c, i) => (c[0] === "get" && c[1] === "t7" ? [...all, i] : all), []);
  const helperGets = helperGetIdx.filter((i) => i < calls.indexOf(replacement)).length;
  assert.ok(helperGets >= 4, `the replacement waited for the helper (${helperGets} gets)`);
  assert.ok(at(calls, "kill", "t5") > helperGetIdx[3], "t5 was ended only after t7 finished");
  assert.equal(s.hcState().terminals.find((x) => x.address === "t7").state, "finished", "the helper finished on its own");
  assert.equal(JSON.parse(r.out).replaced, "t5");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), []);
});

test("#805 a helper that never finishes ends the queue with a refusal notice", async (t) => {
  const s = restartScene(t, { status: "working" });
  assert.equal(s.cli(["restart", "Genie", "--json"]).json().queued, true);
  const file = join(s.app, "automagik-herdr/queued-restarts.json");
  const entry = JSON.parse(readFileSync(file, "utf8"))[0];
  const state = s.hcState();
  state.terminals[0].status = { state: "idle" };
  state.terminals[0].screen = "❯ ";
  state.terminals.push({ ...term("t7", { argv: ["codex"], app: "codex", parent: "t5", created: 2, status: "working" }), die_with_parent: true });
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(state));
  const r = await s.cliAsync(["restart", ID.main, "--run-queued", entry.id, "--json"],
    { env: { AUTOMAGIK_HERDR_QUEUE_POLL_MS: "10", AUTOMAGIK_HERDR_QUEUE_HELPER_WAIT_MS: "100" } });
  assert.equal(r.code, 1);
  assert.match(r.err, /has a helper that ends with it: t7/);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), []);
  const sent = s.calls().find((c) => c[0] === "send" && c[1] === "t5");
  assert.ok(sent, "the idle bot was told why");
  assert.match(sent[2], /queued restart refused — .*t7/);
  assert.equal(at(s.calls(), "kill", "t5"), -1);
});

test("#805 a failed queued fire leaves no stale entry", async (t) => {
  const s = restartScene(t, { status: "working" });
  assert.equal(s.cli(["restart", "Genie", "--json"]).json().queued, true);
  const file = join(s.app, "automagik-herdr/queued-restarts.json");
  const entry = JSON.parse(readFileSync(file, "utf8"))[0];
  const bots = s.bots();
  bots.bots.find((b) => b.id === ID.main).model = "not-a-model";
  writeFileSync(s.botsPath, `${JSON.stringify(bots, null, 2)}\n`);
  const state = s.hcState();
  state.terminals[0].status = { state: "idle" };
  state.terminals[0].screen = "❯ ";
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(state));
  const r = await s.cliAsync(["restart", ID.main, "--run-queued", entry.id, "--json"], { env: { AUTOMAGIK_HERDR_QUEUE_POLL_MS: "5" } });
  assert.equal(r.code, 1);
  assert.match(r.err, /pinned to "not-a-model"/);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), []);
});

test("#805 --cancel never kills a reused watcher address", (t) => {
  const s = restartScene(t, { status: "working" });
  const q = s.cli(["restart", "Genie", "--json"]);
  assert.equal(q.code, 0, q.err);
  const state = s.hcState();
  state.terminals.find((x) => x.address === q.json().watcher).labels = {};
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(state));
  assert.equal(s.cli(["restart", "--cancel", ID.main, "--json"]).json().canceled, true);
  assert.equal(at(s.calls(), "kill", q.json().watcher), -1);
});

test("#805 an empty poll override keeps the slow floor", async (t) => {
  const s = restartScene(t, { status: "blocked" });
  assert.equal(s.cli(["restart", "Genie", "--json"]).json().queued, true);
  const file = join(s.app, "automagik-herdr/queued-restarts.json");
  const entry = JSON.parse(readFileSync(file, "utf8"))[0];
  const running = s.cliAsync(["restart", ID.main, "--run-queued", entry.id, "--json"],
    { env: { AUTOMAGIK_HERDR_QUEUE_POLL_MS: "", AUTOMAGIK_HERDR_QUEUE_MAX_MS: "1000" } });
  await new Promise((done) => setTimeout(done, 300));
  assert.ok(s.calls().filter((c) => c[0] === "get" && c[1] === "t5").length <= 10, "an empty value is not 1ms");
  const r = await running;
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), []);
});

test("#805 the watcher checks helpers before asking cmdRestart", async (t) => {
  const s = restartScene(t, { status: "working" });
  assert.equal(s.cli(["restart", "Genie", "--json"]).json().queued, true);
  const file = join(s.app, "automagik-herdr/queued-restarts.json");
  const entry = JSON.parse(readFileSync(file, "utf8"))[0];
  const state = s.hcState();
  state.terminals[0].status = { state: "idle" };
  state.terminals[0].screen = "❯ ";
  state.terminals.push({ ...term("t7", { argv: ["codex"], app: "codex", parent: "t5", created: 2, status: "working" }), die_with_parent: true });
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(state));
  const reads = () => s.calls().filter((c) => c[0] === "read" && c[1] === "t5").length;
  const before = reads();
  const POLL_MS = 3000;
  // A slow-starting watcher: the first hc call of the run waits 800 ms, as a loaded runner's cold
  // node start does. The test waits for the read itself, never for a clock (a fixed 300 ms sleep
  // saw 0 reads here and failed the release cut once).
  const late = join(s.root, "late-start");
  exe(join(s.root, "bin", "hc"), `#!/bin/sh\nif [ ! -e "${late}" ]; then : > "${late}"; sleep 0.8; fi\n`
    + `exec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  const running = s.cliAsync(["restart", ID.main, "--run-queued", entry.id, "--json"],
    { env: { AUTOMAGIK_HERDR_QUEUE_POLL_MS: String(POLL_MS), AUTOMAGIK_HERDR_QUEUE_MAX_MS: "1000" } });
  const deadline = Date.now() + 10_000;
  while (reads() - before < 1 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
  assert.equal(reads() - before, 1, "the watcher's helper check read the pane once");
  const r = await running;
  // Exact with no clock: with max 1000 ms the watcher's second turn returns before it reads.
  assert.equal(reads() - before, 1, "one read in the whole run: cmdRestart was never asked");
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), []);
});

test("#805 a helper that appears between checks is still waited out", async (t) => {
  const s = restartScene(t, { status: "working" });
  assert.equal(s.cli(["restart", "Genie", "--json"]).json().queued, true);
  const file = join(s.app, "automagik-herdr/queued-restarts.json");
  const entry = JSON.parse(readFileSync(file, "utf8"))[0];
  const state = s.hcState();
  state.terminals[0].status = { state: "idle" };
  state.terminals[0].screen = "❯ ";
  state.addAfterLs = { nth: 1, terminal: { ...term("t7", { argv: ["codex"], app: "codex", parent: "t5", created: 2, status: "working" }),
    die_with_parent: true, exitAfterGets: 1 } };
  state.surviveParent = ["t7"];
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(state));
  const r = await s.cliAsync(["restart", ID.main, "--run-queued", entry.id, "--json"], { env: { AUTOMAGIK_HERDR_QUEUE_POLL_MS: "5" } });
  assert.equal(r.code, 0, r.err);
  const calls = s.calls();
  const helperGetIdx = calls.reduce((all, c, i) => (c[0] === "get" && c[1] === "t7" ? [...all, i] : all), []);
  assert.ok(helperGetIdx.length >= 2, "the helper was checked at fire time and after");
  assert.ok(at(calls, "kill", "t5") > helperGetIdx[1], "t5 was ended only after t7 finished");
  assert.equal(s.hcState().terminals.find((x) => x.address === "t7").state, "finished", "the helper finished on its own");
  assert.equal(at(calls, "kill", "t7"), -1);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), []);
});

test("#805 a pane that turns busy at fire time is waited out", async (t) => {
  const s = restartScene(t, { status: "working" });
  assert.equal(s.cli(["restart", "Genie", "--json"]).json().queued, true);
  const file = join(s.app, "automagik-herdr/queued-restarts.json");
  const entry = JSON.parse(readFileSync(file, "utf8"))[0];
  const state = s.hcState();
  state.terminals[0].status = { state: "idle" };
  state.terminals[0].screen = "❯ ";
  state.idleOnWait = "t5";
  state.onRead = { terminal: "t5", nth: 1, status: "working", screen: "Thinking… (5s · esc to interrupt)\n❯ " };
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(state));
  const r = await s.cliAsync(["restart", ID.main, "--run-queued", entry.id, "--json"], { env: { AUTOMAGIK_HERDR_QUEUE_POLL_MS: "5" } });
  assert.equal(r.code, 0, r.err);
  const calls = s.calls();
  const waitAt = at(calls, "wait", "t5");
  assert.ok(waitAt >= 0, "the busy pane was waited for");
  const replacement = calls.find((c) => c[0] === "run" && !c.includes("--run-queued"));
  assert.ok(replacement && calls.indexOf(replacement) > waitAt, "nothing was launched while it was busy");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), []);
});

test("#805 a blocked pane polls without spinning hc wait and restarts once answered", async (t) => {
  const s = restartScene(t, { status: "blocked" });
  assert.equal(s.cli(["restart", "Genie", "--json"]).json().queued, true);
  const file = join(s.app, "automagik-herdr/queued-restarts.json");
  const entry = JSON.parse(readFileSync(file, "utf8"))[0];
  const running = s.cliAsync(["restart", ID.main, "--run-queued", entry.id, "--json"], { env: { AUTOMAGIK_HERDR_QUEUE_POLL_MS: "25" } });
  const until = Date.now() + 2000;
  while (Date.now() < until && s.calls().filter((c) => c[0] === "get" && c[1] === "t5").length < 2) {
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.equal(at(s.calls(), "wait"), -1, "a blocked pane is polled, never hc wait");
  const state = s.hcState();
  state.terminals[0].status = { state: "idle" };
  state.terminals[0].screen = "❯ ";
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(state));
  let timer;
  const hang = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("the queued watcher did not restart")), 8000); });
  let r;
  try { r = await Promise.race([running, hang]); } finally { clearTimeout(timer); }
  assert.equal(r.code, 0, r.err);
  assert.equal(at(s.calls(), "wait"), -1);
  assert.equal(JSON.parse(r.out).replaced, "t5");
});

test("#805 a spinner above 10 todo lines still queues instead of cutting the turn", (t) => {
  const s = restartScene(t, { status: "working" });
  const todos = Array.from({ length: 10 }, (_, i) => `  ⎿ todo ${i + 1}`);
  const state = s.hcState();
  state.terminals[0].screen = ["Thinking… (5s · esc to interrupt)", ...todos, "────────", "❯ ", "────────", "  1 background task"].join("\n");
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(state));
  const r = s.cli(["restart", "Genie", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().queued, true);
  assert.equal(at(s.calls(), "kill", "t5"), -1);
});

test("#805 real Claude and Codex idle footers restart immediately", (t) => {
  for (const [name, prompt] of [["claude-idle.txt", '❯ Try "how does <filepath> work?"'], ["codex-idle.txt", "› Ask Codex to do anything"]]) {
    const s = restartScene(t, { status: "idle" });
    const state = s.hcState();
    state.terminals[0].screen = screenFixture(name).replace(prompt, `Do you want to create the PR now?\n\n${prompt}`);
    writeFileSync(join(s.root, "hc.json"), JSON.stringify(state));
    const r = s.cli(["restart", "Genie", "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json().replaced, "t5", name);
    assert.equal(r.json().queued, undefined, name);
  }
});

test("#805 a queued restart fires on an omp idle screen", async (t) => {
  const s = restartScene(t, { status: "working" });
  assert.equal(s.cli(["restart", "Genie", "--json"]).json().queued, true);
  const file = join(s.app, "automagik-herdr/queued-restarts.json");
  const entry = JSON.parse(readFileSync(file, "utf8"))[0];
  const state = s.hcState();
  state.terminals[0].status = { state: "idle" };
  state.terminals[0].screen = screenFixture("omp-idle.txt");
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(state));
  const r = await s.cliAsync(["restart", ID.main, "--run-queued", entry.id, "--json"], { env: { AUTOMAGIK_HERDR_QUEUE_POLL_MS: "5" } });
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).replaced, "t5");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), []);
});

test("#805 --queued prunes an entry whose watcher is gone", (t) => {
  const s = restartScene(t, { status: "working" });
  const q = s.cli(["restart", "Genie", "--json"]);
  assert.equal(q.code, 0, q.err);
  const file = join(s.app, "automagik-herdr/queued-restarts.json");
  const state = s.hcState();
  state.terminals.find((x) => x.address === q.json().watcher).state = "finished";
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(state));
  assert.deepEqual(s.cli(["restart", "--queued", "--json"]).json(), { queued: [] });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), []);
});

test("#805 a queued watcher expires at its max lifetime", async (t) => {
  const s = restartScene(t, { status: "blocked" });
  assert.equal(s.cli(["restart", "Genie", "--json"]).json().queued, true);
  const file = join(s.app, "automagik-herdr/queued-restarts.json");
  const entry = JSON.parse(readFileSync(file, "utf8"))[0];
  const r = await s.cliAsync(["restart", ID.main, "--run-queued", entry.id, "--json"],
    { env: { AUTOMAGIK_HERDR_QUEUE_POLL_MS: "25", AUTOMAGIK_HERDR_QUEUE_MAX_MS: "1000" } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), []);
  assert.equal(at(s.calls(), "kill", "t5"), -1);
});

test("restart refuses while a helper would end with the pane; a member bot that outlives it doesn't count", (t) => {
  const worker = { ...term("t7", { argv: ["codex"], app: "codex", parent: "t5" }), die_with_parent: true };
  const member = { ...term("t8", { bot: ID.cap, parent: "t5" }), die_with_parent: false };
  const s = restartScene(t, { extra: [worker, member] });
  const r = s.cli(["restart", "Genie"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /t5 has a helper that ends with it: t7\. Let it finish, pass --tree to restart it too \(resumed, under the new pane\), or pass --force to end it with the pane\./);
  assert.equal(runCall(s.calls()), undefined);
});

test("restart keeps the old pane when the new one never brings its agent up, exits, or exits after coming up", (t) => {
  process.env.AUTOMAGIK_HERDR_RESTART_WAIT_MS = "400";
  t.after(() => { delete process.env.AUTOMAGIK_HERDR_RESTART_WAIT_MS; });
  const s = restartScene(t, { runAs: "shell" });
  assert.equal(s.cli(["whois", "--bot", ID.main, "--json"]).json().terminal, "t5"); // the ledger imported t5
  const before = attachOf(s);
  const r = s.cli(["restart", "Genie"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /t100 didn't keep an agent in front within 0\.4s, so it was ended; t5 still runs Genie, untouched\./);
  assert.deepEqual(s.calls().filter((c) => c[0] === "kill").map((c) => c[1]), ["t100"], "the abandoned pane ended, never t5");
  assert.equal(s.hcState().terminals.find((x) => x.address === "t5").state, "live");
  assert.equal(ledgerOf(s).some((x) => x.terminal === "t100"), false, "no seat row for the abandoned pane");
  assert.deepEqual(attachOf(s).filter((x) => x.event !== "end"), before, "a failed replacement writes no attach rows");
  assert.equal(foldRows(attachOf(s)).byBot.get(ID.main).terminal, "t5");
  const s2 = restartScene(t, { runAs: "exit" });
  const r2 = s2.cli(["restart", "Genie"]);
  assert.equal(r2.code, 1);
  assert.match(r2.err, /t100 exited before its agent was up .*t5 still runs Genie, untouched\. Try am restart b-aaaaaaaaaa --fresh\./);
  assert.equal(at(s2.calls(), "kill"), -1);
  // Its agent in front at the first check, then gone (a stale --resume id): the old pane survives.
  delete process.env.AUTOMAGIK_HERDR_RESTART_WAIT_MS;
  const s3 = restartScene(t, { runAs: "flaky" });
  const r3 = s3.cli(["restart", "Genie"]);
  assert.equal(r3.code, 1);
  assert.match(r3.err, /t100 exited before its agent was up/);
  assert.equal(at(s3.calls(), "kill"), -1);
  assert.equal(s3.hcState().terminals.find((x) => x.address === "t5").state, "live");
  assert.equal(ledgerOf(s3).some((x) => x.terminal === "t100"), false);
  assert.equal(attachOf(s3).some((x) => x.terminal === "t100"), false, "no attach row for the replacement that exited");
  assert.equal(foldRows(attachOf(s3)).byBot.get(ID.main).terminal, "t5");
});

// #413: what codex leaves on its screen when a thread's model provider is gone.
const CODEX_GONE = "Error: model provider example-proxy is no longer configured (modelProviderNotConfigured)";
const CODEX_SCREEN = `$ codex resume 019a\n\x1b[31m${CODEX_GONE}\x1b[0m\n\n\u2500\u2500\u2500\u2500\n% \n`;

test("causeLine: the agent's last line that names a failure, past prompts, rules and colour codes", () => {
  assert.equal(causeLine(CODEX_SCREEN), CODEX_GONE);
  assert.equal(causeLine("starting\nno conversation found\n$ "), "no conversation found", "no failure word: the last line");
  assert.equal(causeLine("Error: bad flag\nRun codex --help for usage\n"), "Error: bad flag");
  assert.equal(causeLine("Error: bad flag\n(quit)\n"), "Error: bad flag", "a word in brackets is no failure code");
  assert.equal(causeLine("\n  \n% \n"), null);
  assert.equal(causeLine(""), null);
  assert.equal(causeLine(`error ${"x".repeat(400)}`).length, 300);
});

test("restart that exits before its agent is up names the agent's own last line, in the error and in --json (#413)", (t) => {
  const s = restartScene(t, { runAs: "exit", runScreen: CODEX_SCREEN });
  const r = s.cli(["restart", "Genie"]);
  assert.equal(r.code, 1);
  assert.ok(r.err.includes(`t100 exited before its agent was up; its agent said: "${CODEX_GONE}" (hc read t100 shows the rest); t5 still runs Genie, untouched.`), r.err);
  assert.equal(at(s.calls(), "kill"), -1);
  const s2 = restartScene(t, { runAs: "exit", runScreen: CODEX_SCREEN });
  const j = s2.cli(["restart", "Genie", "--json"]);
  assert.equal(j.code, 1);
  assert.deepEqual([j.json().cause, j.json().terminal], [CODEX_GONE, "t100"]);
  assert.match(j.json().error, /^t100 exited before its agent was up; its agent said: .*modelProviderNotConfigured/);
  assert.equal(s2.hcState().terminals.find((x) => x.address === "t5").state, "live", "the old pane still runs");
  // Nothing on the screen: the old wording, and a null cause.
  const s3 = restartScene(t, { runAs: "exit" });
  const k = s3.cli(["restart", "Genie", "--json"]);
  assert.match(k.err, /t100 exited before its agent was up \(hc read t100 says why\); t5 still runs Genie/);
  assert.equal(k.json().cause, null);
  // Another failure carries no detail: stderr only, stdout empty as before.
  const n = s3.cli(["restart", "Nobody", "--json"]);
  assert.notEqual(n.code, 0);
  assert.equal(n.out, "");
});

test("restart --json: a busy refusal says it is one, working or helpers, with the pane to wait on (#413)", (t) => {
  const s = restartScene(t, { status: "working" });
  const w = s.cli(["restart", "Genie", "--json"]);
  assert.equal(w.code, 0, w.err);
  assert.equal(w.json().queued, true);
  assert.equal(w.json().reason, "working");
  const worker = { ...term("t7", { argv: ["codex"], app: "codex", parent: "t5" }), die_with_parent: true };
  const s2 = restartScene(t, { extra: [worker] });
  const h = s2.cli(["restart", "Genie", "--json"]);
  assert.equal(h.code, 1);
  assert.deepEqual([h.json().refused, h.json().terminal], ["helpers", "t5"]);
  assert.match(h.json().error, /^t5 has a helper that ends with it: t7./);
  assert.equal(runCall(s2.calls()), undefined, "nothing started");
});

test("restart with no session id known: claude --continue, with a warning; --fresh starts a new conversation", (t) => {
  const s = restartScene(t, { session: "-rf" }); // not a session id: never passed to --resume
  const r = s.cli(["restart", "Genie", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([r.json().mode, r.json().replaced, r.json().terminal], ["resume", "t5", "t100"]);
  assert.deepEqual(plain(runCall(s.calls())).slice(-4), ["claude", "--permission-mode", "auto", "--continue"]);
  assert.match(r.err, /No Claude session id was known for t5, so t100 resumes the latest conversation in .* \(--continue\)/);
  const s2 = restartScene(t);
  const fresh = s2.cli(["restart", "Genie", "--fresh", "--json"]);
  assert.equal(fresh.code, 0, fresh.err);
  assert.equal(fresh.json().mode, "fresh");
  assert.deepEqual(freshClaude(plain(agentWords(runCall(s2.calls())))), ["claude", "--permission-mode", "auto"]);
});

test("restart --agent swaps fresh without touching bots.json; --save writes the agent and drops the old pin; --save alone is a usage mistake", (t) => {
  const s = restartScene(t);
  const before = readFileSync(s.botsPath, "utf8");
  const r = s.cli(["restart", "Genie", "--agent", "codex", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([r.json().mode, r.json().agent, r.json().saved], ["swap", "codex", false]);
  const swapped = grantsApart(plain(agentWords(runCall(s.calls()))));
  assert.deepEqual(swapped.words, ["codex", ...CODEX_MODE]);
  assert.equal(swapped.dirs[0], realpathSync(join(s.project, ".git")), "the project's .git, its first grant");
  assert.equal(readFileSync(s.botsPath, "utf8"), before, "bots.json untouched");
  // Again from the claude pin, written down this time (t100 is mid-turn in the fake: --force).
  const f = team();
  f.bots[0].model = "claude-opus-5-5";
  s.seed(f);
  const saved = s.cli(["restart", "Genie", "--agent", "codex", "--save", "--force"]);
  assert.equal(saved.code, 0, saved.err);
  assert.equal(s.bots().bots[0].agent, "codex");
  assert.equal("model" in s.bots().bots[0], false, "the claude pin is dropped");
  assert.match(saved.err, /bots\.json now says codex/);
  const lone = s.cli(["restart", "Genie", "--save"]);
  assert.equal(lone.code, 2);
  assert.match(lone.err, /--save keeps a swap/);
});

test("restart a codex bot resumes with codex resume --last; a bot not running is started as start does", (t) => {
  const s = scene(t, { terminals: [term("t6", { bot: ID.cap, argv: ["codex"], app: "codex", cwd: "/p" })] });
  const f = team();
  f.bots[1].agent = "codex";
  s.seed(f);
  const r = s.cli(["restart", "Captain", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(codexWords(plain(runCall(s.calls()))).slice(-(CODEX_MODE.length + 3)), ["codex", ...CODEX_MODE, "resume", "--last"]);
  assert.equal(r.json().replaced, "t6");
  // Genie isn't running: a plain start, nothing killed but t6.
  const started = s.cli(["restart", "Genie", "--json"]);
  assert.equal(started.code, 0, started.err);
  assert.deepEqual([started.json().mode, started.json().replaced], ["start", null]);
  assert.deepEqual(freshClaude(plain(agentWords(s.calls().filter((c) => c[0] === "run")[1]))), ["claude", "--permission-mode", "auto"]);
  assert.deepEqual(s.calls().filter((c) => c[0] === "kill").map((c) => c[1]), ["t6"]);
});

test("restart: the ledger's session row for the old pane stands in for a missing label; beside another bot's Claude, a new conversation, not --continue", (t) => {
  const s = restartScene(t, { session: null });
  mkdirSync(join(s.app, "automagik-herdr"), { recursive: true });
  writeFileSync(ledgerPath(s.app), [{ event: "session", terminal: "t5", session: SID2, transcript: "/x.jsonl" }, { event: "session", terminal: "t6", session: SID }]
    .map((x) => `${JSON.stringify(x)}\n`).join(""));
  const r = s.cli(["restart", "Genie"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(plain(runCall(s.calls())).slice(-5), ["claude", "--permission-mode", "auto", "--resume", SID2]);
  assert.deepEqual(ledgerOf(s).filter((x) => x.terminal === "t100" && x.event === "session").map((x) => [x.session, x.transcript]), [[SID2, "/x.jsonl"]]);
  // No label, no ledger row, and Captain's Claude in the same folder: refused, nothing started.
  const mate = term("t9", { bot: ID.cap, cwd: "" });
  const s2 = restartScene(t, { session: null, extra: [mate] });
  const st = s2.hcState();
  st.terminals.find((x) => x.address === "t9").cwd = s2.project;
  st.terminals.find((x) => x.address === "t9").foreground.cwd = s2.project;
  writeFileSync(join(s2.root, "hc.json"), JSON.stringify(st));
  const r2 = s2.cli(["restart", "Genie", "--json"]);
  assert.equal(r2.code, 0, r2.err);
  assert.equal(r2.json().mode, "fresh");
  assert.equal(r2.json().note, `no Claude session id is known for t5, and Captain (t9) also runs Claude in ${s2.project}, so --continue could resume theirs instead of Genie's`);
  assert.deepEqual(freshClaude(plain(agentWords(runCall(s2.calls())))), ["claude", "--permission-mode", "auto"], "no --continue");
  assert.doesNotMatch(r2.err, /No Claude session id was known/, "no --continue warning: it didn't continue");
});

// ---- #328: two bots on one agent in one folder ----

/**
 * Genie (t5) and Captain (t9) on `agent` in the project folder; `labels`: each pane's agent.session
 * (null: none); `captain`: over Captain's hc get, null for no pane at all; `extra`: more terminals.
 */
function shareScene(t, agent, { labels = [null, null], ledger = [], captain = {}, extra = [] } = {}) {
  const s = scene(t);
  const program = agent === "antigravity" ? "agy" : agent;
  if (agent !== "claude" && agent !== "codex") exe(join(s.root, "bin", program), "#!/bin/sh\nexit 0\n");
  const f = team();
  f.bots[0].agent = agent;
  f.bots[1].agent = agent;
  s.seed(f);
  const pane = (address, b, label, over = {}) => {
    const x = term(address, { bot: b, argv: [program], app: agent, cwd: s.project, ...over });
    if (label) x.labels = { ...x.labels, "agent.session": label };
    return x;
  };
  const terminals = [pane("t5", ID.main, labels[0]), ...(captain === null ? [] : [pane("t9", ID.cap, labels[1], captain)]), ...extra];
  writeFileSync(join(s.root, "hc.json"), JSON.stringify({ terminals, next: 100 }));
  if (ledger.length) {
    mkdirSync(join(s.app, "automagik-herdr"), { recursive: true });
    writeFileSync(ledgerPath(s.app), ledger.map((x) => `${JSON.stringify(x)}\n`).join(""));
  }
  return s;
}
const runsOf = (s) => s.calls().filter((c) => c[0] === "run");
/** A run's agent words without the briefing omp and its kin get at launch (models.js BRIEFING). */
const ownWords = (run) => codexWords(plain(agentWords(run))).filter((w) => !w.includes("<herdr-bot>"));

test("restart (#328): two bots on omp, then codex, in one folder: each resumes its own session id, from its label or the ledger", (t) => {
  for (const [agent, words] of [["omp", (id) => [`--resume=${id}`]], ["codex", (id) => [...CODEX_MODE, "resume", id]]]) {
    const s = shareScene(t, agent, { labels: ["sess-tester", "sess-dev"] });
    const a = s.cli(["restart", "Genie", "--json"]);
    assert.equal(a.code, 0, a.err);
    assert.deepEqual([a.json().mode, a.json().session], ["resume", "***"], agent); // RFC 0021: masked
    assert.deepEqual(ownWords(runsOf(s)[0]), [agent, ...words("sess-tester")], agent);
    assert.ok(runsOf(s)[0].includes("agent.session=sess-tester"), "the new pane keeps its own id for the next restart");
    const b = s.cli(["restart", "Captain", "--json"]);
    assert.equal(b.code, 0, b.err);
    assert.deepEqual([b.json().mode, b.json().session], ["resume", "***"], agent); // RFC 0021: masked
    assert.deepEqual(ownWords(runsOf(s)[1]), [agent, ...words("sess-dev")], agent);
  }
  // No labels: the ledger's session rows, each naming its agent, feed the same ids.
  const s = shareScene(t, "omp", { ledger: [{ event: "session", terminal: "t5", session: "sess-tester", agent: "omp" },
    { event: "session", terminal: "t9", session: "sess-dev", agent: "omp" }] });
  assert.equal(s.cli(["restart", "Genie"]).code, 0);
  assert.equal(s.cli(["restart", "Captain"]).code, 0);
  assert.deepEqual(runsOf(s).map(ownWords), [["omp", "--resume=sess-tester"], ["omp", "--resume=sess-dev"]]);
});

test("restart (#328): omp with no session id beside another bot's omp (its pane, or its seat row) starts fresh and says why; alone, --continue as before", (t) => {
  const s = shareScene(t, "omp");
  const r = s.cli(["restart", "Genie", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([r.json().mode, r.json().session], ["fresh", null]);
  const note = `no Oh My Pi session id is known for t5, and Captain (t9) also runs Oh My Pi in ${s.project}, so --continue could resume theirs instead of Genie's`;
  assert.equal(r.json().note, note);
  // The sidebar's Restart shows --json's warnings (restart.js restartAnswer): the why is there too.
  assert.ok(restartAnswer({ code: 0, out: r.json(), err: r.err }).warnings.includes(`Genie starts on a new conversation: ${note}.`), r.err);
  assert.deepEqual(ownWords(runCall(s.calls())), ["omp"], "no --continue");
  const text = shareScene(t, "omp").cli(["restart", "Genie"]);
  assert.equal(text.code, 0, text.err);
  assert.ok(text.err.includes("Genie: t100 replaces t5, a new conversation (no Oh My Pi session id is known for t5, and Captain (t9)"), text.err);
  assert.match(text.err, /also runs Oh My Pi in .*, so --continue could resume theirs instead of Genie's\)\./);
  // Captain's pane shows a shell now, but the workers ledger seated it there on omp: still a sharer.
  const seated = shareScene(t, "omp", { captain: { argv: ["zsh"], app: "zsh" },
    ledger: [{ event: "start", kind: "seat", terminal: "t9", botId: ID.cap, worktree: "", agent: "omp" }] });
  writeFileSync(ledgerPath(seated.app), `${JSON.stringify({ event: "start", kind: "seat", terminal: "t9", botId: ID.cap, worktree: seated.project, agent: "omp" })}\n`);
  const r3 = seated.cli(["restart", "Genie", "--json"]);
  assert.equal(r3.code, 0, r3.err);
  assert.equal(r3.json().mode, "fresh");
  assert.match(r3.json().note, /Captain \(t9\) also runs Oh My Pi/);
  // Captain on another agent, or in another folder: no sharer, so omp --continue as today, with the warning.
  for (const captain of [{ argv: ["codex"], app: "codex" }, { cwd: "/elsewhere" }]) {
    const alone = shareScene(t, "omp", { captain });
    const a = alone.cli(["restart", "Genie", "--json"]);
    assert.equal(a.code, 0, a.err);
    assert.equal(a.json().mode, "resume", JSON.stringify(captain));
    assert.deepEqual(ownWords(runCall(alone.calls())), ["omp", "--continue"]);
    assert.match(a.err, /No Oh My Pi session id was known for t5, so t100 resumes the latest conversation in .* \(--continue\)\. No other bot's Oh My Pi runs there/);
  }
  // --fresh is untouched: a new conversation, no note.
  const f = shareScene(t, "omp").cli(["restart", "Genie", "--fresh", "--json"]);
  assert.deepEqual([f.code, f.json().mode, f.json().note], [0, "fresh", null]);
});

/** Genie's restart in `s`: fresh, no --continue; its note. */
const freshNote = (s) => {
  const r = s.cli(["restart", "Genie", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().mode, "fresh", r.err);
  assert.deepEqual(ownWords(runCall(s.calls())), ["omp"], "no --continue");
  return r.json().note;
};
const fresh = freshNote;

test("restart (#328 review): an ended teammate's seat row in the folder is a sharer; one elsewhere or on another agent isn't", (t) => {
  // Captain's pane is gone (not in hc at all); its last seat row put it here on omp.
  const ended = shareScene(t, "omp", { captain: null,
    ledger: [{ event: "start", kind: "seat", terminal: "t9", botId: ID.cap, worktree: "", agent: "omp" }] });
  writeFileSync(ledgerPath(ended.app), `${JSON.stringify({ event: "start", kind: "seat", terminal: "t9", botId: ID.cap, worktree: ended.project, agent: "omp" })}\n`);
  assert.match(fresh(ended), /Captain \(t9, ended\) also ran Oh My Pi in .*, so --continue could resume theirs instead of Genie's/);
  // A seat row elsewhere, or on another agent, isn't one.
  for (const row of [{ worktree: "/elsewhere", agent: "omp" }, { agent: "codex" }]) {
    const other = shareScene(t, "omp", { captain: null, ledger: [{ event: "start", kind: "seat", terminal: "t9", botId: ID.cap, worktree: "", agent: "omp" }] });
    writeFileSync(ledgerPath(other.app), `${JSON.stringify({ event: "start", kind: "seat", terminal: "t9", botId: ID.cap, worktree: other.project, ...row })}\n`);
    assert.equal(other.cli(["restart", "Genie", "--json"]).json().mode, "resume", JSON.stringify(row));
  }
});

test("restart (#341): a teammate re-seated in a worktree still left its omp conversation here; Genie starts fresh, never --continue", (t) => {
  // Captain sat here on omp (t7), then was re-seated in a worktree of the project (same bot ids).
  const seats = (s, wt, last) => {
    mkdirSync(wt, { recursive: true });
    writeFileSync(ledgerPath(s.app), [{ terminal: "t7", worktree: s.project }, { terminal: last, worktree: wt }]
      .map((x) => `${JSON.stringify({ event: "start", kind: "seat", botId: ID.cap, agent: "omp", ...x })}\n`).join(""));
  };
  const seed = [{ event: "start", kind: "seat", terminal: "t0", botId: ID.cap, worktree: "/elsewhere", agent: "omp" }];
  // Both of Captain's panes ended: its old omp session here can still be the folder's latest.
  const gone = shareScene(t, "omp", { captain: null, ledger: seed });
  seats(gone, join(gone.root, "wt"), "t12");
  assert.match(fresh(gone), /^no Oh My Pi session id is known for t5, and Captain \(t7, ended\) also ran Oh My Pi in /);
  // Captain live in the worktree (t9): that pane isn't here, its old seat row here still is.
  const wt = join(scratchRoot(t, "herdr-341-"), "wt");
  const moved = shareScene(t, "omp", { captain: { cwd: wt }, ledger: seed });
  seats(moved, wt, "t9");
  const note = fresh(moved);
  assert.match(note, /Captain \(t7, ended\) also ran Oh My Pi in /);
  assert.doesNotMatch(note, /t9/, "the worktree pane isn't in this folder");
});

test("restart (#328 review): a teammate's omp inside the keep wrapper is a sharer", (t) => {
  // Captain's omp runs inside the keep wrapper (launchArgs.js unwrapKeep).
  const wrapped = shareScene(t, "omp", { captain: { argv: ["sh", "-c", '"$@"; exec "${SHELL:-sh}" -i', "sh", "omp"] } });
  assert.match(fresh(wrapped), /Captain \(t9\) also runs Oh My Pi/);
});

test("restart (#328 review): an omp started by hand in the folder (no bot) is a sharer", (t) => {
  // No bot label on t12; Captain elsewhere.
  const byHand = shareScene(t, "omp", { captain: { cwd: "/elsewhere" }, extra: [term("t12", { argv: ["omp"], app: "omp", cwd: "" })] });
  const st = byHand.hcState();
  for (const x of st.terminals.filter((x) => x.address === "t12")) { x.cwd = byHand.project; x.foreground.cwd = byHand.project; }
  writeFileSync(join(byHand.root, "hc.json"), JSON.stringify(st));
  assert.match(fresh(byHand), /a pane \(t12\) also runs Oh My Pi in /);
});

test("restart (#328 review): agy's --continue isn't limited to the folder, so another bot's agy anywhere is a sharer", (t) => {
  const s = shareScene(t, "antigravity", { captain: { cwd: "/elsewhere" } });
  const r = s.cli(["restart", "Genie", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().mode, "fresh", r.err);
  assert.equal(r.json().note, "no Antigravity session id is known for t5, and Captain (t9) also runs Antigravity, so --continue could resume theirs "
    + "instead of Genie's (Antigravity's --continue isn't limited to one folder)");
  assert.deepEqual(ownWords(runCall(s.calls())), ["agy", "--settings", agySettingsPath(s, ID.main), "--dangerously-skip-permissions", "--mode", "auto"]);
  // Alone on agy: --continue, as before.
  const alone = shareScene(t, "antigravity", { captain: { argv: ["codex"], app: "codex", cwd: "/elsewhere" } });
  const a = alone.cli(["restart", "Genie", "--json"]);
  assert.equal(a.json().mode, "resume", a.err);
  assert.deepEqual(ownWords(runCall(alone.calls())), ["agy", "--settings", agySettingsPath(alone, ID.main), "--dangerously-skip-permissions", "--mode", "auto", "--continue"]);
});

test("restart (#328 review): a ledger session row from an earlier pane at a reused address is never resumed", (t) => {
  // t5 was created at created_ms 5000; a row stamped before then is another pane's.
  const row = (at) => ({ event: "session", terminal: "t5", session: "old-pane", agent: "omp", at });
  const reused = shareScene(t, "omp", { captain: { argv: ["codex"], app: "codex" }, ledger: [row("1970-01-01T00:00:01.000Z")] });
  const st = reused.hcState();
  st.terminals.find((x) => x.address === "t5").created_ms = 5000;
  writeFileSync(join(reused.root, "hc.json"), JSON.stringify(st));
  const r = reused.cli(["restart", "Genie", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([r.json().mode, r.json().session], ["resume", null]);
  assert.deepEqual(ownWords(runCall(reused.calls())), ["omp", "--continue"], "no --resume=old-pane");
  // Stamped after the pane was created: its own, resumed.
  const own = shareScene(t, "omp", { captain: { argv: ["codex"], app: "codex" }, ledger: [row("1970-01-01T00:00:09.000Z")] });
  const st2 = own.hcState();
  st2.terminals.find((x) => x.address === "t5").created_ms = 5000;
  writeFileSync(join(own.root, "hc.json"), JSON.stringify(st2));
  assert.equal(own.cli(["restart", "Genie", "--json"]).json().session, "***"); // resumed; RFC 0021: masked
});

test("restart (#328): an agent with no resume starts fresh as before, a teammate beside it or not", (t) => {
  const s = shareScene(t, "opencode");
  const r = s.cli(["restart", "Genie", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([r.json().mode, r.json().note], ["fresh", "opencode has no resume this pack knows"]);
  assert.deepEqual(ownWords(runCall(s.calls())), ["opencode"]);
});

test("a bot restarting itself writes and prints everything before the kill that ends its own pane", (t) => {
  const s = restartScene(t);
  const r = s.cli(["restart", "Genie", "--agent", "codex", "--save", "--json"], { env: { HC_TERMINAL_ID: "t5" } });
  // The fake hc ends the CLI as the real kill of its own pane would: what it printed first stands.
  assert.equal(r.json().terminal, "t100", r.err);
  assert.deepEqual([r.json().replaced, r.json().mode, r.json().saved], ["t5", "swap", true]);
  assert.equal(s.bots().bots[0].agent, "codex", "saved before the kill");
  const calls = s.calls();
  assert.deepEqual(calls.at(-1), ["kill", "t5"], "the kill is the last hc call");
  assert.ok(ledgerOf(s).some((x) => x.terminal === "t100" && x.kind === "seat"));
});

test("restart: the bot attached elsewhere while the new pane came up: the new pane is ended, no rows written, the other binding kept", (t) => {
  const other = term("t9", { bot: null, cwd: "/elsewhere", created: 77 });
  const s = restartScene(t, { extra: [other] });
  assert.equal(s.cli(["whois", "--bot", ID.main, "--json"]).json().terminal, "t5");
  // While hc run starts t100, another CLI attaches Genie to t9 (an attach row, as attach --move writes).
  const rows = attachOf(s);
  const moved = { ...rows.find((x) => x.terminal === "t5"), terminal: "t9", created_ms: 77, by: "attach", at: new Date().toISOString() };
  const st = s.hcState();
  st.onRunWrite = { path: attachFile(s.app), text: [...rows, moved].map((x) => `${JSON.stringify(x)}\n`).join("") };
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  const r = s.cli(["restart", "Genie"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /Genie was attached to t9 while it restarted, so t100 was ended and nothing changed\./);
  assert.deepEqual(s.calls().filter((c) => c[0] === "kill").map((c) => c[1]), ["t100"]);
  assert.equal(attachOf(s).some((x) => x.terminal === "t100"), false);
  assert.equal(foldRows(attachOf(s)).byBot.get(ID.main).terminal, "t9");
});

// ---- history (#85): what a bot did, by the two ledgers ----

test("history: the bot's panes, starts, sessions (only while it held the pane) and workers; text and --json", (t) => {
  const s = scene(t);
  s.seed(team());
  mkdirSync(join(s.app, "automagik-herdr"), { recursive: true });
  const at = (m) => `2026-11-03T10:0${m}:00.000Z`;
  const row = (event, b, terminal, m, by) => ({ v: 1, event, bot: b, project: s.project, terminal, core: "c1", created_ms: 1, machine: null, by, at: at(m) });
  writeFileSync(attachFile(s.app), [row("attach", ID.dev, "t5", 1, "start"), row("detach", ID.dev, "t5", 3, "detach"), row("attach", ID.cap, "t5", 4, "attach")]
    .map((r) => `${JSON.stringify(r)}\n`).join(""), { mode: 0o600 });
  writeFileSync(ledgerPath(s.app), [
    { event: "start", kind: "seat", terminal: "t5", botId: ID.dev, agent: "claude", model: null, at: at(1) },
    { event: "session", terminal: "t5", session: "11111111-aaaa", transcript: "/x/dev.jsonl", at: at(2) },
    { event: "start", kind: "worker", terminal: "t8", botId: ID.dev, branch: "fix-x", role: "dev", agent: "codex", at: at(2) },
    { event: "session", terminal: "t5", session: "22222222-bbbb", transcript: "/x/captain.jsonl", at: at(5) },
  ].map((r) => `${JSON.stringify(r)}\n`).join(""));
  const json = s.cli(["history", "Dev", "--json"]);
  assert.equal(json.code, 0, json.err);
  const h = json.json();
  assert.equal(h.id, ID.dev);
  assert.equal(h.name, "Dev");
  assert.deepEqual(h.attach.map((r) => r.event), ["attach", "detach"]);
  assert.deepEqual(h.starts.map((r) => r.terminal), ["t5"]);
  assert.deepEqual(h.workers.map((r) => r.branch), ["fix-x"]);
  // One session row, Dev's (Captain's later session in t5 isn't Dev's); its id shown as *** (RFC 0021).
  assert.deepEqual(h.sessions.map((r) => [r.terminal, r.session]), [["t5", "***"]]);
  assert.equal(json.out.includes("11111111-aaaa"), false);
  assert.equal(h.transcript, "/x/dev.jsonl");
  const text = s.cli(["history", "Dev"]);
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /^Dev \(b-cccccccccc\)\n {2}what happened\n {4}2026-11-03 10:03 detached from t5 · by detach\n/);
  assert.match(text.out, / {2}workers\n {4}2026-11-03 10:02 fix-x · dev · codex · t8\n/);
  assert.match(text.out, / {2}transcript {3}\/x\/dev\.jsonl/);
  assert.equal(`${text.out}${text.err}`.includes("11111111-aaaa"), false, "no session id in text either");
  // The ledgers are only read.
  assert.equal(attachOf(s).length, 3);
  assert.equal(ledgerOf(s).length, 4);
});

test("history: no ledgers is an empty history; a removed bot by its bare id; an unknown name is refused", (t) => {
  const s = scene(t);
  s.seed(team());
  assert.match(s.cli(["history", "Studio"]).out, /nothing recorded on this computer/);
  const gone = s.cli(["history", "b-zzzzzzzzzz", "--json"]);
  assert.equal(gone.code, 0, gone.err);
  assert.deepEqual(gone.json(), { id: "b-zzzzzzzzzz", name: null, bot: "b-zzzzzzzzzz", attach: [], starts: [], workers: [], sessions: [], transcript: null });
  assert.match(s.cli(["history", "nobody"]).err, /No bot "nobody"/);
  assert.equal(s.cli(["history"]).code, 2);
});

// ---- restart #213: the old pane's folder, command and session; PATH; --tree ----

/** Captain on `agent` in pane t6 (hc get fields `over`), in project folder `cwd`, with an `omp` on PATH. */
function captainScene(t, { agent = "omp", over = {}, extra = [], templates = null } = {}) {
  const s = scene(t);
  const f = team();
  f.bots[1].agent = agent;
  s.seed(f);
  exe(join(s.root, "bin", "omp"), "#!/bin/sh\nexit 0\n");
  const old = { ...term("t6", { bot: ID.cap, app: agent }), ...over };
  writeFileSync(join(s.root, "hc.json"), JSON.stringify({ terminals: [old, ...extra], next: 100, ...(templates ? { templates } : {}) }));
  return s;
}
const runs = (s) => s.calls().filter((c) => c[0] === "run");

test("restart #413: codex can't resume a thread whose model provider is gone: one new pane on a new thread, the old id in the note", (t) => {
  const codexBot = (runQueue) => {
    const s = captainScene(t, { agent: "codex", over: { foreground: { argv: ["codex", "resume", SID], cwd: "/p" }, argv: ["codex", "resume", SID],
      labels: { bot: ID.cap, "agent.session": SID } } });
    const st = s.hcState();
    writeFileSync(join(s.root, "hc.json"), JSON.stringify({ ...st, runQueue }));
    return s;
  };
  const s = codexBot([{ runAs: "exit", screen: CODEX_SCREEN }]);
  const r = s.cli(["restart", "Captain", "--json"]);
  assert.equal(r.code, 0, r.err);
  const [first, second] = runs(s);
  assert.deepEqual(plain(agentWords(first)).slice(-2), ["resume", SID], "it tried the thread first");
  assert.deepEqual(codexWords(plain(agentWords(second))), ["codex", ...CODEX_MODE], "then a new thread");
  const j = r.json();
  assert.deepEqual([j.mode, j.terminal, j.replaced, j.session], ["fresh", "t101", "t6", null]);
  assert.equal(j.note, `codex can't resume its thread (***) (t100 said "${CODEX_GONE}"), so it starts on a new one`);
  assert.ok(j.warnings.some((w) => w.includes("its thread (***)")), "the sidebar's warnings say it too");
  assert.equal(`${r.out}${r.err}`.includes(SID), false, "the thread's id is never printed (RFC 0021)");
  assert.equal(s.hcState().terminals.find((x) => x.address === "t101").labels["agent.session"], undefined, "the dead thread's id isn't carried on");
  assert.ok(at(s.calls(), "kill", "t6") > at(s.calls(), "run"), "t6 ends once t101 is up");
  assert.equal(foldRows(attachOf(s)).byBot.get(ID.cap).terminal, "t101");
  // Any other resume failure is still a failure, with its own cause: one try, t6 untouched.
  const other = "Error: no rollout found for thread id " + SID;
  const s2 = codexBot([{ runAs: "exit", screen: `${other}\n% ` }]);
  const r2 = s2.cli(["restart", "Captain", "--json"]);
  assert.equal(r2.code, 1);
  // codex's own words, relayed with the thread id shown as *** (RFC 0021: no id in any output).
  assert.equal(r2.json().cause, other.split(SID).join("***"));
  assert.equal(`${r2.out}${r2.err}`.includes(SID), false);
  assert.equal(runs(s2).length, 1);
  assert.equal(at(s2.calls(), "kill"), -1);
  // The phrase without codex's code is another failure: no fresh start.
  const s4 = codexBot([{ runAs: "exit", screen: "Error: model provider example-proxy is no longer configured\n" }]);
  const r4 = s4.cli(["restart", "Captain", "--json"]);
  assert.equal(r4.code, 1);
  assert.equal(runs(s4).length, 1);
  // The new thread failing too: its own cause, t6 still untouched.
  const s3 = codexBot([{ runAs: "exit", screen: CODEX_SCREEN }, { runAs: "exit", screen: "Error: not logged in\n" }]);
  const r3 = s3.cli(["restart", "Captain", "--json"]);
  assert.equal(r3.code, 1);
  assert.deepEqual([r3.json().terminal, r3.json().cause], ["t101", "Error: not logged in"]);
  assert.equal(at(s3.calls(), "kill"), -1);
  assert.equal(s3.hcState().terminals.find((x) => x.address === "t6").state, "live");
});

test("restart #213/#597: an omp bot from a template, in a worktree, comes back on the template's CURRENT command, resumed", (t) => {
  const s0 = scene(t);
  const wt = join(s0.root, "proj.worktrees", "rust-cap");
  mkdirSync(wt, { recursive: true });
  const cmd = 'env PATH="$HOME/.bun/bin:$PATH" omp --auto-approve --model kimi/k3';
  const s = captainScene(t, { templates: [{ name: "dev-kimi", command: cmd }],
    over: { cwd: wt, foreground: { argv: ["bun", "/h/.bun/bin/omp", "--auto-approve", "--model", "kimi/k3"], cwd: wt },
      argv: ["sh", "-c", cmd], template: "dev-kimi" } });
  const r = s.cli(["restart", "Captain", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([r.json().replaced, r.json().mode, r.json().agent], ["t6", "resume", "omp"]);
  const run = runCall(s.calls());
  assert.equal(run[run.indexOf("--cwd") + 1], wt, "the old pane's folder, not the project's");
  // The template's own CURRENT command (its env, flags and model), with --continue as an argument.
  assert.deepEqual(agentWords(run), ["sh", "-c", `${cmd} "$@"`, "sh", "--continue"]);
  assert.ok(run.includes("worker.template=dev-kimi"), "the template's name goes with the new pane");
  assert.doesNotMatch(r.err, /differs from/, "its command is the template's: no line");
  // Again (t100 is mid-turn in the fake: --force), now with an omp session id on the pane: the
  // template is found by its label and the resume words come from the id.
  const st = s.hcState();
  st.terminals.find((x) => x.address === "t100").labels["agent.session"] = SID2;
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  const again = s.cli(["restart", "Captain", "--force", "--json"]);
  assert.equal(again.code, 0, again.err);
  assert.equal(again.json().session, "***"); // RFC 0021: masked
  const next = runs(s)[1];
  assert.equal(next[next.indexOf("--cwd") + 1], wt);
  assert.deepEqual(agentWords(next), ["sh", "-c", `${cmd} "$@"`, "sh", `--resume=${SID2}`]);
  assert.ok(next.includes(`agent.session=${SID2}`), "the session label goes with it");
  assert.ok(next.includes("worker.template=dev-kimi"), "and the template's name too");
  assert.doesNotMatch(again.err, /differs from/);
});

test("restart #597: a template hc no longer lists falls back to the agent row; its line names the template, not its text", (t) => {
  const cmd = 'env PATH="$HOME/.bun/bin:$PATH" omp --auto-approve --model kimi/k3';
  const s = captainScene(t, { templates: [], over: {
    foreground: { argv: ["omp", "--auto-approve"], cwd: "/x" }, argv: ["sh", "-c", cmd], template: "dev-kimi" } });
  const r = s.cli(["restart", "Captain", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(ownWords(runCall(s.calls())), ["omp", "--continue"], "the agent row, not the gone template");
  assert.match(r.err, /Captain: its pane's template dev-kimi differs from its source now: restarting from the source/);
  assert.equal(r.err.includes("auto-approve"), false, "never the template's text");
});

test("restart D2: a bot moved to dsh-tui whose pane's agent can't be read doesn't restart its old omp template", (t) => {
  const cmd = "omp --auto-approve --model kimi/k3";
  const s = captainScene(t, { agent: "dsh-tui", templates: [{ name: "old-omp", command: cmd }],
    over: { foreground: { argv: ["zsh"], cwd: "/x" }, argv: ["sh", "-c", cmd], template: "old-omp" } });
  exe(join(s.root, "bin", "dsh-tui"), "#!/bin/sh\nexit 0\n");
  const r = s.cli(["restart", "Captain", "--json"]);
  assert.equal(r.code, 0, r.err);
  const words = ownWords(runCall(s.calls()));
  assert.equal(words[0], "dsh-tui", JSON.stringify(words));
  assert.equal(words.includes("omp"), false, "never the old omp template");
  assert.match(r.err, /Captain: its pane's template old-omp differs from its source now: restarting from the source/);
});

test("restart F2: a quoted template command is read, and another agent's quoted command still never matches", (t) => {
  const cmd = 'sh -c "omp --auto-approve"';
  const s = captainScene(t, { templates: [{ name: "quoted", command: cmd }],
    over: { foreground: { argv: ["omp"], cwd: "/x" }, argv: ["sh", "-c", cmd], template: "quoted" } });
  const r = s.cli(["restart", "Captain", "--json"]);
  assert.equal(r.code, 0, r.err);
  const words = agentWords(runCall(s.calls()));
  assert.deepEqual(words.slice(0, 2), ["sh", "-c"], "the template's command, wrapped with its resume words");
  assert.ok(words[2].startsWith(cmd), words.join(" "));
  assert.doesNotMatch(r.err, /differs from/, "its command is the template's: no line");
  // The same quoted shape running another agent never matches this omp bot.
  const other = captainScene(t, { templates: [{ name: "quoted", command: 'sh -c "claude --model x"' }],
    over: { foreground: { argv: ["omp"], cwd: "/x" }, argv: ["sh", "-c", 'sh -c "claude --model x"'], template: "quoted" } });
  const o = other.cli(["restart", "Captain", "--json"]);
  assert.equal(o.code, 0, o.err);
  assert.deepEqual(ownWords(runCall(other.calls())), ["omp", "--continue"], "the agent row, not the quoted template");
  assert.match(o.err, /Captain: its pane's template quoted differs from its source now: restarting from the source/);
});

test("restart #597: a hand-started codex bot comes back from its source, not its old flags; the old pane's folder gone: the project's, said", (t) => {
  const s = captainScene(t, { agent: "codex", over: {
    cwd: "/gone/folder", foreground: { argv: ["codex", "-m", "gpt-a", "-c", "model_reasoning_effort=high", "resume", "--last"], cwd: "/gone/folder" },
    argv: ["/usr/bin/env", "PATH=/old", "codex", "-m", "gpt-a", "-c", "model_reasoning_effort=high", "resume", "--last"],
    labels: { bot: ID.cap, "agent.session": SID } } });
  const r = s.cli(["restart", "Captain", "--json"]);
  assert.equal(r.code, 0, r.err);
  const run = runCall(s.calls());
  assert.deepEqual(codexWords(plain(agentWords(run))), ["codex", ...CODEX_MODE, "resume", SID], "the source's command, resumed by its session");
  assert.match(r.err, /Captain: its pane's command differs from its source now \(drops -m=\*\*\*, -c=\*\*\*; adds --approve-for-me, --disable=\*\*\*, --no-daemon=\*\*\*\)/);
  assert.equal(r.err.includes("gpt-a"), false, "the value is masked");
  assert.equal(r.json().session, "***"); // RFC 0021: masked
  assert.equal(run[run.indexOf("--cwd") + 1], s.project);
  assert.match(r.err, /t6's folder \/gone\/folder isn't there now, so t100 runs in .*; its conversation may not be found there\./);
  // RFC 0021 (f) 5: a session id the restart carries, any harness, is a session row on the new
  // launch (its agent, core and created_ms), the id itself only in the ledger.
  const t100 = s.hcState().terminals.find((x) => x.address === "t100");
  assert.deepEqual(ledgerOf(s).filter((x) => x.event === "session").map((x) => [x.terminal, x.session, x.agent, x.core, x.created_ms]),
    [["t100", SID, "codex", "fakecore0000", t100.created_ms]]);
});

test("restart #213: the pane always gets the CLI's PATH, so a bare codex (#!/usr/bin/env node) finds the node this PATH has", (t) => {
  const s = captainScene(t, { agent: "codex", over: { foreground: { argv: ["codex"], cwd: "/x" }, argv: ["codex"] } });
  const nodeDir = join(s.root, "node-bin");
  mkdirSync(nodeDir);
  exe(join(nodeDir, "node"), "#!/bin/sh\necho v24.1.0\n");
  exe(join(s.root, "bin", "codex"), "#!/usr/bin/env node\n");
  const path = `${nodeDir}:${join(s.root, "bin")}:/usr/bin:/bin`;
  const r = s.cli(["restart", "Captain", "--json"], { env: { PATH: path } });
  assert.equal(r.code, 0, r.err);
  const run = runCall(s.calls());
  const parts = agentParts(run);
  // Before #213 nothing was passed here (this PATH already had node), and the pane got herdr-core's.
  assert.deepEqual(parts.prefix, ["/usr/bin/env"]);
  assert.deepEqual(parts.env, [`PATH=${KILL_GUARD_DIR}:${path}`, `HERDR_APP_HOME=${s.app}`],
    "the hc kill shim (#955), then the CLI's PATH, and its app home: no env word lost or leaked (#650)");
  assert.deepEqual(codexWords(plain(parts.words)), ["codex", ...CODEX_MODE, "resume", "--last"]);
});

/** Genie in t5 with two helpers that end with it (a worker on omp, a template on omp) and a member bot that outlives it. */
const SID3 = "3c3c3c3c-1b2d-4c5e-9f60-718293a4b5c6";

/**
 * The invariant --tree keeps (#256 reviews), at every fake hc call (the fake's .doubles file) and
 * at the end: no session id (agent.session or revive.session) is on two live panes, but for the
 * bot's own while its new pane proves itself (`bot`: [old, new], both idle then: a restart
 * without --tree has that window too, so a failed new pane leaves the old one running).
 */
function onePanePerSession(s, { bot = ["t5", "t100"] } = {}) {
  const live = new Map();
  for (const x of s.hcState().terminals.filter((y) => y.state === "live")) {
    const id = x.labels?.["agent.session"] ?? x.labels?.["revive.session"];
    if (id) live.set(id, [...(live.get(id) ?? []), x.address]);
  }
  for (const [id, panes] of live) assert.equal(panes.length, 1, `session ${id} is live in ${panes.join(", ")} at the end`);
  const file = join(s.root, "hc.json.doubles");
  const doubles = existsSync(file) ? readJsonLines(file) : [];
  for (const d of doubles) assert.deepEqual(d.panes, bot, `call ${d.call} (${d.word}): session ${d.session} live in ${d.panes.join(", ")}`);
  // The bot's pair only between the new pane's run and the old pane's kill.
  const calls = s.calls();
  const ran = calls.findIndex((c) => c[0] === "run" && c.includes(`agent.session=${SID}`));
  const killed = calls.findIndex((c) => c[0] === "kill" && c[1] === bot[0]);
  // d.call counts the fake's calls from 1, itself included, and sees the state before it acts: call ran+1 is the run itself.
  for (const d of doubles) assert.ok(d.call - 1 > ran && d.call - 1 <= killed, `call ${d.call} (${d.word}) outside the up-check (run ${ran}, kill ${killed})`);
}

/** treeScene with `third`: a codex helper t10 ("probe", session SID3) in a third folder, after t7 and t8. */
function treeScene(t, { workerStatus = "idle", third = false } = {}) {
  const s = restartScene(t);
  exe(join(s.root, "bin", "omp"), "#!/bin/sh\nexit 0\n");
  const wt1 = join(s.root, "proj.worktrees", "fix-213"), wt2 = join(s.root, "proj.worktrees", "review");
  mkdirSync(wt1, { recursive: true });
  mkdirSync(wt2, { recursive: true });
  const worker = { ...term("t7", { argv: ["bun", "/h/.bun/bin/omp", "--model=kimi/k3", "--thinking=high", "do the task"], app: "omp", cwd: wt1, parent: "t5", status: workerStatus }),
    name: "fix-213-dev", die_with_parent: true, argv: ["/usr/bin/env", "PATH=/x", "omp", "--model=kimi/k3", "--thinking=high", "do the task"],
    labels: { "worker.of": ID.main, branch: "fix/213", "worker.role": "dev", "worker.model": "kimi/k3", "worker.effort": "high" } };
  const reviewer = { ...term("t8", { argv: ["omp", "--auto-approve", "--model", "deepseek/flash"], app: "omp", cwd: wt2, parent: "t5" }),
    name: "rev-1", die_with_parent: true, argv: ["sh", "-c", "omp --auto-approve --model deepseek/flash"], template: "reviewer-flash",
    labels: { where: "Brain / review", "revive.agent": "omp", "revive.session": SID2 } };
  const member = { ...term("t9", { bot: ID.cap, parent: "t5" }), die_with_parent: false };
  const st = s.hcState();
  st.terminals.push(worker, reviewer, member);
  const wt3 = join(s.root, "proj.worktrees", "probe");
  if (third) {
    mkdirSync(wt3, { recursive: true });
    st.terminals.push({ ...term("t10", { argv: ["codex", "-m", "gpt-a"], app: "codex", cwd: wt3, parent: "t5" }), name: "probe", die_with_parent: true,
      argv: ["codex", "-m", "gpt-a"], labels: { "agent.session": SID3 } });
  }
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  mkdirSync(join(s.app, "automagik-herdr"), { recursive: true });
  writeFileSync(ledgerPath(s.app), `${JSON.stringify({ event: "start", kind: "worker", terminal: "t7", pid: 1, botId: ID.main, task: "fix-213", branch: "fix/213",
    project: s.project, lead: ID.main, worktree: wt1, agent: "omp", model: "kimi/k3", effort: "high", template: null, role: "dev" })}\n`);
  return { s, wt1, wt2, wt3 };
}

test("restart --tree: the helpers that end with the bot run again under its new pane, each in its folder, on its command, resumed", (t) => {
  const { s, wt1, wt2 } = treeScene(t);
  const r = s.cli(["restart", "Genie", "--tree", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().terminal, "t100");
  assert.deepEqual(r.json().helpers.map((h) => [h.name, h.replaced, h.terminal, h.agent, h.mode, h.up, h.error]),
    [["fix-213-dev", "t7", "t101", "omp", "resume", true, null], ["rev-1", "t8", "t102", "omp", "resume", true, null]]);
  const [, w, v] = runs(s);
  // The worker: rebuilt from its ledger row, so its task isn't sent again; its name, folder and labels kept.
  assert.deepEqual([w[w.indexOf("--name") + 1], w[w.indexOf("--cwd") + 1], w[w.indexOf("--parent") + 1]], ["fix-213-dev", wt1, "t100"]);
  assert.ok(["worker.of=b-aaaaaaaaaa", "branch=fix/213", "worker.role=dev"].every((l) => w.includes(l)), w.join(" "));
  assert.deepEqual(agentWords(w), ["omp", "--model=kimi/k3", "--thinking=high", "--continue"]);
  // The template helper: its own command, resumed.
  assert.deepEqual([v[v.indexOf("--name") + 1], v[v.indexOf("--cwd") + 1], v[v.indexOf("--parent") + 1]], ["rev-1", wt2, "t100"]);
  // The template helper: its own command, resumed by the session a reviver keeps in revive.session.
  assert.deepEqual(agentWords(v), ["sh", "-c", 'omp --auto-approve --model deepseek/flash "$@"', "sh", `--resume=${SID2}`]);
  // The old helpers end before their replacements start; the old pane last.
  const calls = s.calls();
  const killAt = (x) => at(calls, "kill", x), runAt = (name) => calls.findIndex((c) => c[0] === "run" && c.includes(name));
  // The old pane ends (its helpers with it) before any helper runs again; none is killed on its own.
  assert.ok(killAt("t5") > 0 && killAt("t5") < runAt("fix-213-dev") && runAt("fix-213-dev") < runAt("rev-1"), JSON.stringify(calls));
  assert.deepEqual([killAt("t7"), killAt("t8")], [-1, -1]);
  const state = s.hcState();
  assert.deepEqual(["t5", "t7", "t8", "t9", "t101", "t102"].map((x) => state.terminals.find((y) => y.address === x).state),
    ["finished", "finished", "finished", "live", "live", "live"], "the member bot that outlives the pane is left alone");
  // The worker's ledger row goes to its new terminal; helpers get no attach rows (they are no bots).
  assert.deepEqual(ledgerOf(s).filter((x) => x.terminal === "t101").map((x) => [x.kind, x.task, x.agent, x.model, x.effort]), [["worker", "fix-213", "omp", "kimi/k3", "high"]]);
  assert.equal(attachOf(s).some((x) => ["t101", "t102"].includes(x.terminal)), false);
  onePanePerSession(s);
  const text = treeScene(t).s.cli(["restart", "Genie", "--tree"]);
  assert.equal(text.code, 0, text.err);
  const lines = text.err.split("\n");
  assert.ok(lines.includes(`am: Genie's helper fix-213-dev: t101 replaces t7, resuming its last conversation (--continue).`), text.err);
  assert.ok(lines.includes("am: Genie's helper rev-1: t102 replaces t8, resuming its session by id (--resume=***)."), text.err);
  assert.equal(text.code, 0);
});

test("restart --tree #413: refused before anything starts while a pane waits for an answer or an agent reports no status; --force still goes", (t) => {
  const asking = treeScene(t, { workerStatus: "blocked" }).s;
  const r = asking.cli(["restart", "Genie", "--tree", "--json"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /t7 is waiting for an answer\. Nothing was started: answer it first, or pass --force to end it\./);
  assert.equal(runCall(asking.calls()), undefined);
  assert.equal(at(asking.calls(), "kill"), -1);
  const bot = treeScene(t).s;
  const held = bot.hcState();
  held.terminals.find((x) => x.address === "t5").status = { app: "claude-code", state: "blocked" };
  writeFileSync(join(bot.root, "hc.json"), JSON.stringify(held));
  const queued = bot.cli(["restart", "Genie", "--tree"]);
  assert.equal(queued.code, 0, queued.err);
  assert.match(queued.out, /restart queued.*the owner must answer/);
  assert.ok(runCall(bot.calls()).includes("--run-queued"));
  assert.equal(at(bot.calls(), "kill", "t5"), -1);
  const plainHelper = treeScene(t).s;
  const st = plainHelper.hcState();
  st.terminals.find((x) => x.address === "t8").status = null;
  writeFileSync(join(plainHelper.root, "hc.json"), JSON.stringify(st));
  const w = plainHelper.cli(["restart", "Genie", "--tree"]);
  assert.equal(w.code, 1);
  assert.match(w.err, /t8 doesn't tell hc whether it is busy, so --tree can't tell whether it has finished\. Nothing was started\. Look at it first, then pass --force to restart anyway\./);
  assert.equal(runCall(plainHelper.calls()), undefined);
  assert.equal(asking.cli(["restart", "Genie", "--tree", "--force"]).code, 0, "--force is the hand-run way past it");
});

test("restart --tree #413: a plain program reporting no status, a dev server say, passes as before and runs again", (t) => {
  const s = treeScene(t).s;
  const st = s.hcState();
  st.terminals.push({ ...term("t11", { argv: ["npm", "run", "dev"], app: "x", cwd: s.project, parent: "t5" }), status: null, die_with_parent: true, name: "dev", argv: ["sh", "-c", "npm run dev"] });
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  const r = s.cli(["restart", "Genie", "--tree", "--json"]);
  assert.doesNotMatch(r.err, /doesn't tell hc/);
  assert.ok(r.json().helpers.some((h) => h.replaced === "t11" && h.terminal), r.err);
});

test("restart --tree waits, before anything starts, for helpers and the old pane to be idle: a turn's note types into the old pane only then; still mid-turn after the wait refuses", (t) => {
  const busy = treeScene(t, { workerStatus: "working" }).s;
  const st = busy.hcState();
  st.terminals.find((x) => x.address === "t7").idleAfterGets = 2; // its turn ends during the wait: a note into t5, whose agent takes a turn
  writeFileSync(join(busy.root, "hc.json"), JSON.stringify(st));
  const r = busy.cli(["restart", "Genie", "--tree", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json().helpers.map((h) => [h.replaced, h.up]), [["t7", true], ["t8", true]]);
  const calls = busy.calls();
  const ran = calls.findIndex((c) => c[0] === "run");
  const notes = busy.hcState().notes ?? [];
  assert.deepEqual(notes.map((n) => [n.to, n.from]), [["t5", "t7"]]);
  assert.ok(notes.every((n) => n.call < ran), "the note went in, and t5's turn ended, before the new pane started");
  assert.ok(calls.slice(0, ran).filter((c) => c[0] === "get" && c[1] === "t5").length >= 3, "t5's own turn was waited for too");
  onePanePerSession(busy);
  // Still mid-turn when the wait runs out: refused, nothing started or ended.
  const stays = treeScene(t, { workerStatus: "working" }).s;
  const w = stays.cli(["restart", "Genie", "--tree"], { env: { AUTOMAGIK_HERDR_TREE_TURN_WAIT_MS: "1000" } });
  assert.equal(w.code, 1);
  assert.match(w.err, /t7 was still mid-turn 1s later\. Nothing was started: restart once it is idle, or pass --force to cut its turn\./);
  assert.equal(runCall(stays.calls()), undefined);
  assert.equal(at(stays.calls(), "kill"), -1);
  // From inside a helper, or inside the old pane (which --tree ends before its helpers run again): refused.
  const inside = treeScene(t).s;
  const me = inside.cli(["restart", "Genie", "--tree"], { env: { HC_TERMINAL_ID: "t7" } });
  assert.equal(me.code, 1);
  assert.match(me.err, /This runs in t7, one of t5's helpers, which --tree ends and runs again: run it from another terminal\./);
  const self = inside.cli(["restart", "Genie", "--tree"], { env: { HC_TERMINAL_ID: "t5" } });
  assert.equal(self.code, 1);
  assert.match(self.err, /This runs in t5, the pane --tree ends before its helpers run again: run restart --tree from another terminal\./);
  assert.equal(runCall(inside.calls()), undefined);
  // --force alone (no --tree): the helpers end with the pane, as before.
  const forced = treeScene(t).s;
  const f = forced.cli(["restart", "Genie", "--force", "--json"]);
  assert.equal(f.code, 0, f.err);
  assert.equal(runs(forced).length, 1, "only the bot runs again");
  assert.equal("helpers" in f.json(), false);
  assert.deepEqual(["t7", "t8"].map((x) => forced.hcState().terminals.find((y) => y.address === x).state), ["finished", "finished"]);
});

test("restart --tree: a helper whose turn starts and ends once the new pane is up types into no pane older than it (the old one has ended)", (t) => {
  const s = treeScene(t).s;
  const st = s.hcState();
  // t8 starts a turn as the bot's new pane starts (the 1st hc run) and ends it on its own clock at
  // the 2nd hc run (the first helper's), looked at or not. Had the old pane still run then (a
  // tree that runs helpers again before ending it), the note would go into t5.
  st.workingOnRun = ["t8"];
  st.terminals.find((x) => x.address === "t8").endTurnOn = { word: "run", nth: 2 };
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  const r = s.cli(["restart", "Genie", "--tree", "--json"]);
  assert.equal(r.code, 0, r.err);
  const calls = s.calls();
  const ran = calls.findIndex((c) => c[0] === "run");
  const notes = (s.hcState().notes ?? []).filter((n) => n.call - 1 > ran);
  assert.deepEqual(notes.filter((n) => !["t100", "t101", "t102"].includes(n.to)), [], `a note went into an old pane: ${JSON.stringify(notes)}`);
  assert.deepEqual(r.json().helpers.map((h) => [h.replaced, h.up]), [["t7", true], ["t8", true]]);
  onePanePerSession(s);
});

test("restart --tree: a helper that is itself a bot (started under the pane, then attached) keeps its binding: moved to its new terminal", (t) => {
  const s = restartScene(t);
  const wt = join(s.root, "proj.worktrees", "dev");
  mkdirSync(wt, { recursive: true });
  const dev = { ...term("t8", { bot: ID.dev, parent: "t5", cwd: wt }), die_with_parent: true, argv: ["claude", "--model", "m"] };
  const st = s.hcState();
  st.terminals.push(dev);
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  assert.equal(s.cli(["whois", "--bot", ID.dev, "--json"]).json().terminal, "t8", "the ledger imported t8 for Dev");
  const r = s.cli(["restart", "Genie", "--tree", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json().helpers.map((h) => [h.replaced, h.terminal, h.bot, h.up]), [["t8", "t101", ID.dev, true]]);
  assert.deepEqual(agentWords(runs(s)[1]), ["claude", "--model", "m", "--continue"]);
  const rows = attachOf(s).filter((x) => x.bot === ID.dev);
  assert.deepEqual(rows.slice(-2).map((x) => [x.event, x.terminal, x.by, x.reason ?? null]), [["detach", "t8", "start", "moved"], ["attach", "t101", "start", null]]);
  assert.equal(s.cli(["whois", "--bot", ID.dev, "--json"]).json().terminal, "t101");
  assert.deepEqual(ledgerOf(s).filter((x) => x.terminal === "t101").map((x) => [x.kind, x.botId, x.worktree]), [["seat", ID.dev, wt]]);
});

// ---- Claude logins (#453): claude-logins.json read at each launch, start, restart and --tree ----

test("start #453: login 2's folder by value after PATH; a bad record starts Claude on login A, warned; a codex bot never reads it", (t) => {
  const f = team();
  f.bots[1].agent = "codex";
  const s = scene(t);
  s.seed(f);
  const two = join(s.home, ".claude-2");
  mkdirSync(two);
  const record = join(s.app, "claude-logins.json");
  writeFileSync(record, JSON.stringify({ use: "2", logins: [{ id: "2", dir: two }] }));
  const r = s.cli(["start", "Genie", "--json"]);
  assert.equal(r.code, 0, r.err);
  let { prefix, env, words } = agentParts(runsOf(s).at(-1));
  assert.deepEqual(prefix, ["/usr/bin/env"]);
  assert.match(env[0], /^PATH=/);
  assert.deepEqual(env.slice(1), [`HERDR_APP_HOME=${s.app}`, `CLAUDE_CONFIG_DIR=${two}`],
    "the login's folder, by value, last: no env word lost or leaked (#650)");
  assert.equal(words[0], "claude");
  assert.doesNotMatch(r.err, /claude-logins/);
  assert.deepEqual(r.json().argv.slice(0, 1), ["claude"], "start's own argv is the agent's, as before");

  rmSync(record);
  mkdirSync(record); // unreadable: a folder in its place
  const codex = s.cli(["start", "Captain", "--json"]);
  assert.equal(codex.code, 0, codex.err);
  ({ prefix, env, words } = agentParts(runsOf(s).at(-1)));
  assert.equal(words[0], "codex");
  assert.deepEqual(env.slice(1), [`HERDR_APP_HOME=${s.app}`], `codex: no login words: ${env.join(" ")}`);
  assert.doesNotMatch(codex.err, /claude-logins/, "a codex launch never reads or warns about the record");

  const dev = s.cli(["start", "Dev", "--json"]);
  assert.equal(dev.code, 0, dev.err);
  ({ prefix, env, words } = agentParts(runsOf(s).at(-1)));
  assert.deepEqual(prefix, ["/usr/bin/env", "-u", "CLAUDE_CONFIG_DIR"], "login A, never a refusal");
  assert.deepEqual(env.slice(1), [`HERDR_APP_HOME=${s.app}`], "the CLI's app home only (#650)");
  assert.equal(words[0], "claude");
  assert.match(dev.err, /claude-logins\.json: can't be read \(EISDIR\); started on the default login/);
});

test("restart --tree #453: the bot's own -u launch is rebuilt on login 2; a Claude helper gets the words, a codex helper none", (t) => {
  const s = restartScene(t);
  const two = join(s.home, ".claude-2");
  mkdirSync(two);
  writeFileSync(join(s.app, "claude-logins.json"), JSON.stringify({ use: "2", logins: [{ id: "2", dir: two }] }));
  const st = s.hcState();
  // Genie was started on login A (its launch argv has -u): Restart rebuilds its command from the
  // source (claude and its session) and puts login 2's words in front (#597).
  st.terminals[0].argv = ["/usr/bin/env", "-u", "CLAUDE_CONFIG_DIR", "PATH=/old", "claude", "--model", "opus"];
  const wa = join(s.root, "wa"), wb = join(s.root, "wb");
  mkdirSync(wa);
  mkdirSync(wb);
  st.terminals.push({ ...term("t8", { parent: "t5", cwd: wa }), die_with_parent: true, argv: ["claude", "--model", "m"] });
  st.terminals.push({ ...term("t9", { parent: "t5", cwd: wb, argv: ["codex", "-m", "g"], app: "codex" }), die_with_parent: true, argv: ["codex", "-m", "g"] });
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  const r = s.cli(["restart", "Genie", "--tree", "--json"]);
  assert.equal(r.code, 0, r.err);
  const [bot, claude, codex] = runs(s).map(agentParts);
  assert.deepEqual(bot.prefix, ["/usr/bin/env"]);
  assert.deepEqual(bot.env.slice(1), [`HERDR_APP_HOME=${s.app}`, `CLAUDE_CONFIG_DIR=${two}`],
    "the app home and login 2: no env word lost or leaked (#650)");
  assert.deepEqual(plain(bot.words), ["claude", "--permission-mode", "auto", "--resume", SID], "the source's command, never the pane's --model");
  assert.match(r.err, /Genie: its pane's command differs from its source now \(drops --model=\*\*\*; adds --permission-mode=\*\*\*\)/);
  assert.deepEqual(claude.env.slice(1), [`CLAUDE_CONFIG_DIR=${two}`], "a helper (workerArgs) keeps its env words");
  assert.equal(claude.words[0], "claude");
  assert.equal(codex.words[0], "codex");
  assert.equal(codex.env.length, 1, `codex helper: PATH only: ${codex.env.join(" ")}`);
});

test("restart --tree #453: a Claude helper's by-hand line under a bad record carries login A's words and says why (review Low 2)", (t) => {
  const s = restartScene(t);
  writeFileSync(join(s.app, "claude-logins.json"), "{ not json");
  const st = s.hcState();
  const wa = join(s.root, "wa");
  mkdirSync(wa);
  st.terminals.push({ ...term("t8", { parent: "t5", cwd: wa }), name: "rev-9", die_with_parent: true, argv: ["claude", "--model", "m"] });
  st.failRun = ["rev-9"];
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  const r = s.cli(["restart", "Genie", "--tree", "--json"]);
  assert.equal(r.code, 1);
  const line = r.json().helpers[0].by_hand;
  assert.ok(pastedLine(t, line).join(" ").includes("/usr/bin/env -u CLAUDE_CONFIG_DIR PATH="), line);
  assert.match(r.err, new RegExp(`  ${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n(.*\\n)*.*# claude-logins\\.json: is not valid JSON; started on the default login`));
});

// ---- restart --tree: shared folders and failure paths (#256 review) ----

/** Genie's t5 with six codex helpers of one template in one folder (as t2p6's integrators), each with `labels(n)`. */
// #1142: a literal Codex run, the one shape whose words are proved to reach Codex as options.
const SIX_CMD = "codex --no-daemon -m gpt-6.1-sol -c model_reasoning_effort=high";
function sixScene(t, labels = () => ({}), cmd = SIX_CMD) {
  const s = restartScene(t);
  const wt = join(s.root, "proj.worktrees", "integration");
  mkdirSync(wt, { recursive: true });
  const names = ["acc-262", "acc-261b", "acc-218", "acc-264b", "acc-265", "e8-v16b"];
  const st = s.hcState();
  names.forEach((name, n) => st.terminals.push({ ...term(`t${20 + n}`, { argv: ["codex", "--no-daemon", "-m", "gpt-6.1-sol"], app: "codex", cwd: wt, parent: "t5" }),
    name, die_with_parent: true, argv: ["sh", "-c", cmd], template: "integrator", labels: { where: "Brain / Integrator", ...labels(n) } }));
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  return { s, wt, cmd, names };
}
const idOf = (n) => `01a1a160-cb95-74a2-b6ad-6b0a3ae94f1${n}`;

test("restart --tree: six codex helpers in one folder resume each its own session (revive.session); with none known, refused, or fresh with --fresh-shared", (t) => {
  const { s, wt, cmd, names } = sixScene(t, (n) => ({ "revive.agent": "codex", "revive.session": idOf(n), "revive.cwd": "x" }));
  const r = s.cli(["restart", "Genie", "--tree", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json().helpers.map((h) => [h.name, h.session, h.mode, h.up]), names.map((name) => [name, "***", "resume", true]));
  assert.deepEqual(runs(s).slice(1).map((w) => [w[w.indexOf("--cwd") + 1], ...agentWords(w).slice(-2)]), names.map((_, n) => [wt, "resume", idOf(n)]));
  assert.ok(runs(s).slice(1).every((w) => agentWords(w)[2] === `${cmd} "$@"`));
  onePanePerSession(s);
  // None known: every one of them would take the folder's latest. Refused before anything starts.
  const bare = sixScene(t).s;
  const refused = bare.cli(["restart", "Genie", "--tree"]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, new RegExp(`${names.join(", ")} would resume the latest codex conversation in .*integration \\(no session id\\), `
    + `which ${names.join(", ")} all use: one could pick up another's\\. Nothing was started\\. Give each an agent\\.session label, or pass --fresh-shared`));
  assert.equal(runCall(bare.calls()), undefined);
  assert.equal(at(bare.calls(), "kill"), -1);
  // --fresh-shared: each starts its own new conversation, with its command, and says why.
  const fresh = bare.cli(["restart", "Genie", "--tree", "--fresh-shared", "--json"]);
  assert.equal(fresh.code, 0, fresh.err);
  assert.deepEqual(fresh.json().helpers.map((h) => [h.mode, h.session]), names.map(() => ["fresh", null]));
  assert.match(fresh.json().helpers[0].note, /no session id, and its folder .*integration has other codex sessions \(--fresh-shared\)/);
  // #1125: these panes ran an hc template but are no template worker (no worker.template label):
  // each keeps its command and gets the launch-mode words it lacks after it, through "$@".
  const lacking = ["--approve-for-me", "--disable", "hooks", "-c", "sandbox_workspace_write.network_access=true"];
  assert.ok(runs(bare).slice(1).every((w) => JSON.stringify(codexWords(agentWords(w))) === JSON.stringify(["sh", "-c", `${cmd} "$@"`, "sh", ...lacking])),
    JSON.stringify(runs(bare).slice(1).map(agentWords)));
  assert.equal(s.cli(["restart", "Genie", "--fresh-shared"]).code, 2, "--fresh-shared goes with --tree");
  // #1142: the fixture's old command, behind an env PATH wrapper, is no shape the pack proves passes the words: each helper
  // is refused by name before anything starts, never run again as written.
  const wrapped = sixScene(t, (n) => ({ "revive.agent": "codex", "revive.session": idOf(n), "revive.cwd": "x" }),
    `env PATH="$HOME/.bun/bin:$PATH" ${SIX_CMD}`).s;
  const no = wrapped.cli(["restart", "Genie", "--tree"]);
  assert.equal(no.code, 1);
  for (const name of names) {
    assert.match(no.err, new RegExp(`${name} can't be run again: its command runs Codex but can't pass the pack's Codex words to Codex as options`));
  }
  assert.equal(runCall(wrapped.calls()), undefined, "nothing started");
  assert.equal(at(wrapped.calls(), "kill"), -1, "nothing ended");
});

/** The resume line --tree printed (its hc run line), checked to parse as sh, then run as sh would split it. */
function pastedLine(t, line) {
  const r = spawnSync("sh", ["-n", "-c", line], { encoding: "utf8" });
  assert.equal(r.status, 0, `sh -n rejects: ${line}\n${r.stderr}`);
  const words = spawnSync("sh", ["-c", `for w in ${line.replace(/^hc /, "")}; do printf '%s\\0' "$w"; done`], { encoding: "utf8" });
  return words.stdout.split("\0").slice(0, -1);
}

test("restart --tree: hc run failing for helper 2 of 3: helpers 1 and 3 run again, the old pane ends, helper 2's line runs as pasted, exit 1", (t) => {
  const { s, wt2 } = treeScene(t, { third: true });
  const st = s.hcState();
  st.failRun = ["rev-1"];
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  const r = s.cli(["restart", "Genie", "--tree", "--json"]);
  assert.equal(r.code, 1, "the bot and two helpers restarted, one didn't");
  assert.equal(r.json().terminal, "t100");
  assert.deepEqual(r.json().helpers.map((h) => [h.replaced, h.terminal, h.up, Boolean(h.error)]), [["t7", "t101", true, false], ["t8", null, false, true], ["t10", "t102", true, false]]);
  const shown = r.json().helpers[1].by_hand;
  // RFC 0021: the line shows *** for the session id; put back as its note says, it is the same
  // words the restart ran for it: its name, folder, labels, parent, the seat's PATH and its command, resumed.
  assert.equal(shown.includes(SID2), false);
  const line = shown.split("***").join(SID2);
  const tried = s.calls().find((c) => c[0] === "run" && c.includes("rev-1"));
  assert.deepEqual(pastedLine(t, line), tried);
  assert.deepEqual([tried[tried.indexOf("--cwd") + 1], tried[tried.indexOf("--parent") + 1]], [wt2, "t100"]);
  assert.ok(tried.includes(`revive.session=${SID2}`) && tried.includes("/usr/bin/env") && tried.some((w) => w.startsWith("PATH=")), tried.join(" "));
  assert.deepEqual(agentWords(tried).slice(-2), ["sh", `--resume=${SID2}`]);
  assert.ok(r.err.includes(`t8 (rev-1) wasn't run again: hc run failed (hc: can't start rev-1). Its conversation is kept; to run it again by hand:\n`
    + `am:   ${shown}\n`) || r.err.includes(`  ${shown}\n  # resumes its session by id`), r.err);
  assert.match(r.err, /# resumes its session by id: put the id where \*\*\* stands; hc get t8 shows it/);
  assert.equal(`${r.out}${r.err}`.includes(SID2), false, "no session id printed");
  assert.deepEqual(codexWords(agentWords(runs(s).at(-1))), ["codex", "-m", "gpt-a", ...CODEX_MODE, "resume", SID3], "helper 3 resumed by its id, in the launch mode");
  const state = s.hcState();
  assert.deepEqual(["t5", "t7", "t8", "t10", "t100", "t101", "t102"].map((x) => state.terminals.find((y) => y.address === x).state),
    ["finished", "finished", "finished", "finished", "live", "live", "live"], "the old pane always ends");
  onePanePerSession(s);
});

test("restart --tree failing with a gone folder on the project list: pruned, no note, the last stderr line stays the helper's (review Low 4)", (t) => {
  const { s } = treeScene(t, { third: true });
  const st = s.hcState();
  st.failRun = ["rev-1"];
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  const list = join(s.app, "am-sidebar-projects.json"), gone = join(s.root, "gone");
  writeFileSync(list, JSON.stringify([gone]));
  const r = s.cli(["restart", "Genie", "--tree"]);
  assert.equal(r.code, 1, r.err);
  assert.ok(!JSON.parse(readFileSync(list, "utf8")).includes(gone), "the prune still ran");
  assert.doesNotMatch(r.err, /taken off the project list/);
  assert.equal(restartAnswer({ code: r.code, err: r.err }).refused,
    "Genie's helper probe: t102 replaces t10, resuming its session by id (resume ***); check the log and try again.");
  assert.doesNotMatch(restartAnswer({ code: r.code, err: r.err }).refused, /^am: tidy:/);
  assert.match(r.err, /t8 \(rev-1\) wasn't run again: hc run failed/);
});

test("restart --tree: a helper that survives its parent's end (and its kill) is said, never run twice nor offered by hand; one never up, or that hc can't read, is reported", (t) => {
  // t7 outlives t5's end and its own kill fails: it holds its session, so no second pane and no hand line.
  const stuck = treeScene(t).s;
  const st = stuck.hcState();
  st.surviveParent = ["t7"];
  st.failKill = "t7";
  writeFileSync(join(stuck.root, "hc.json"), JSON.stringify(st));
  const k = stuck.cli(["restart", "Genie", "--tree", "--json"]);
  assert.equal(k.code, 1);
  assert.match(k.err, /t7 \(fix-213-dev\) it still runs after its parent ended \(hc kill t7 failed: kill refused on t7\): it holds its session, so it isn't run again/);
  assert.deepEqual(k.json().helpers.map((h) => [h.replaced, h.up, h.still_running, h.by_hand]), [["t7", false, true, null], ["t8", true, false, null]]);
  assert.equal(runs(stuck).filter((c) => c.includes("fix-213-dev")).length, 0, "t7 never started twice");
  assert.deepEqual(["t5", "t7"].map((x) => stuck.hcState().terminals.find((y) => y.address === x).state), ["finished", "live"]);
  onePanePerSession(stuck);
  // A helper that survives its parent but ends on its own kill: run again.
  const once = treeScene(t).s;
  const st1 = once.hcState();
  st1.surviveParent = ["t7"];
  writeFileSync(join(once.root, "hc.json"), JSON.stringify(st1));
  const o = once.cli(["restart", "Genie", "--tree", "--json"]);
  assert.equal(o.code, 0, o.err);
  assert.ok(at(once.calls(), "kill", "t7") > at(once.calls(), "kill", "t5"));
  assert.deepEqual(o.json().helpers.map((h) => h.up), [true, true]);
  // Never up: reported with its line, which parses.
  process.env.AUTOMAGIK_HERDR_RESTART_WAIT_MS = "400";
  t.after(() => { delete process.env.AUTOMAGIK_HERDR_RESTART_WAIT_MS; });
  const late = treeScene(t).s;
  const st2 = late.hcState();
  st2.runAsFor = { "fix-213-dev": "shell" };
  writeFileSync(join(late.root, "hc.json"), JSON.stringify(st2));
  const r = late.cli(["restart", "Genie", "--tree", "--json"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /t7 \(fix-213-dev\) wasn't run again: t101 didn't keep an agent in front within 0\.4s, so it was ended\. Its conversation is kept/);
  assert.match(r.err, /# a worker: its workers-ledger row \(task fix-213\) isn't copied/);
  pastedLine(t, r.json().helpers[0].by_hand);
  assert.deepEqual(["t101", "t102", "t5"].map((x) => late.hcState().terminals.find((y) => y.address === x).state), ["finished", "live", "finished"]);
  onePanePerSession(late);
  // hc get of t7 fails once the bot's pane starts: unknown is not gone; no second copy.
  const blind = treeScene(t).s;
  const st3 = blind.hcState();
  st3.failGetOnRun = ["t7"];
  writeFileSync(join(blind.root, "hc.json"), JSON.stringify(st3));
  const b = blind.cli(["restart", "Genie", "--tree"]);
  assert.equal(b.code, 1);
  assert.match(b.err, /t7 \(fix-213-dev\) wasn't run again: hc get t7 failed \(hc: server error reading t7\), so it may still run; with it possibly running, a second copy would share its session\./);
  assert.equal(runs(blind).filter((c) => c.includes("fix-213-dev")).length, 0);
  assert.equal(blind.hcState().terminals.find((y) => y.address === "t5").state, "finished");
});

test("restart --tree refuses before anything starts: a gone folder, a helper hc can't read, a helper's own helpers, one session named twice", (t) => {
  const { s: gone, wt2 } = treeScene(t);
  rmSync(wt2, { recursive: true });
  const g = gone.cli(["restart", "Genie", "--tree"]);
  assert.equal(g.code, 1);
  assert.match(g.err, new RegExp(`t8's folder ${wt2} isn't there\\. Nothing was started\\.`));
  assert.equal(runCall(gone.calls()), undefined);
  const blind = treeScene(t).s;
  const st = blind.hcState();
  st.failGet = ["t8"];
  writeFileSync(join(blind.root, "hc.json"), JSON.stringify(st));
  const b = blind.cli(["restart", "Genie", "--tree"]);
  assert.equal(b.code, 1);
  assert.match(b.err, /hc get t8 failed \(hc: server error reading t8\): --tree can't check t5's helper\. Nothing was started\./);
  assert.equal(runCall(blind.calls()), undefined);
  const nest = treeScene(t).s;
  const st4 = nest.hcState();
  st4.terminals.push({ ...term("t30", { argv: ["codex"], app: "codex", parent: "t7" }), die_with_parent: true });
  writeFileSync(join(nest.root, "hc.json"), JSON.stringify(st4));
  const n = nest.cli(["restart", "Genie", "--tree"]);
  assert.equal(n.code, 1);
  assert.match(n.err, /--tree restarts t5's helpers, not theirs: t30 \(under t7\) would end with its parent and not run again\. Nothing was started\./);
  assert.equal(runCall(nest.calls()), undefined);
  const f = nest.cli(["restart", "Genie", "--tree", "--force"]);
  assert.equal(f.code, 0, f.err);
  assert.match(f.err, /--force: t30 \(under t7\) ends with its parent and isn't run again\./);
  // t8 labelled with Genie's own session: two panes would run it.
  const dup = treeScene(t).s;
  const st5 = dup.hcState();
  st5.terminals.find((x) => x.address === "t8").labels["revive.session"] = SID;
  writeFileSync(join(dup.root, "hc.json"), JSON.stringify(st5));
  const d = dup.cli(["restart", "Genie", "--tree"]);
  assert.equal(d.code, 1);
  assert.match(d.err, /Genie and rev-1 would all resume one session \(\*\*\*\): one session runs in one pane\. Nothing was started\./);
  assert.equal(d.err.includes(SID), false);
  assert.equal(runCall(dup.calls()), undefined);
});

test("restart --tree: a helper bot whose attach row can't be written runs, and is named with the attach to run; exit 1", (t) => {
  const s = restartScene(t);
  const wt = join(s.root, "proj.worktrees", "dev");
  mkdirSync(wt, { recursive: true });
  const st = s.hcState();
  st.terminals.push({ ...term("t8", { bot: ID.dev, parent: "t5", cwd: wt }), die_with_parent: true, argv: ["claude"] });
  st.noCreated = ["t8"]; // its replacement (named t8 too) has no created_ms: attachMoved can't be given one
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  assert.equal(s.cli(["whois", "--bot", ID.dev, "--json"]).json().terminal, "t8");
  const r = s.cli(["restart", "Genie", "--tree"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /t8 runs again in t101, but bot b-cccccccccc's attach row wasn't written \(hc get gave no created_ms for t101\): am attach b-cccccccccc t101\./);
  assert.equal(s.hcState().terminals.find((y) => y.address === "t101").state, "live");
});

test("restart: the pane's PATH leaves out the caller's venv, node_modules/.bin and folders under the project, and always has /usr/bin and /bin", (t) => {
  const s = captainScene(t, { agent: "codex", over: { foreground: { argv: ["codex"], cwd: "/x" }, argv: ["codex"] } });
  const bin = join(s.root, "bin");
  const path = [join(s.project, ".venv/bin"), join(s.project, "node_modules/.bin"), "/opt/tool/node_modules/.bin", "/v/env/bin", bin].join(":");
  const r = s.cli(["restart", "Captain", "--json"], { env: { PATH: path, VIRTUAL_ENV: "/v/env" } });
  assert.equal(r.code, 0, r.err);
  const run = runCall(s.calls());
  assert.equal(run[run.indexOf("--") + 2], `PATH=${KILL_GUARD_DIR}:${bin}:/usr/bin:/bin`);
});

test("restart (#955): from a pane with the hc kill shim first on PATH, the CLI still ends the old pane (the real hc), and the new pane has the shim once", (t) => {
  const s = captainScene(t, { agent: "codex", over: { foreground: { argv: ["codex"], cwd: "/x" }, argv: ["codex"] } });
  const bin = join(s.root, "bin");
  // The caller is no main bot's seat: its own `hc kill` through the shim would be refused, and a
  // restart that ended its old pane that way would stop here.
  const path = `${KILL_GUARD_DIR}:${bin}:${dirname(process.execPath)}:/usr/bin:/bin`;
  const r = s.cli(["restart", "Captain", "--json"], { env: { PATH: path } });
  assert.equal(r.code, 0, r.err);
  assert.ok(s.calls().some((call) => call[0] === "kill" && call[1] === "t6"), "the old pane was ended through the real hc");
  const run = runCall(s.calls());
  const word = run[run.indexOf("--") + 2];
  assert.ok(word.startsWith(`PATH=${KILL_GUARD_DIR}:`), word);
  assert.equal(word.split(":").filter((dir) => dir.endsWith("/hc-kill")).length, 1, "the shim's folder is on the new pane's PATH once");
});

test("attach by a pane's name writes hc's terminal id, so whois by id finds it (#261 review)", (t) => {
  const s = scene(t);
  s.seed(team());
  const st = JSON.parse(readFileSync(join(s.root, "hc.json"), "utf8"));
  st.terminals = [{ ...term("t4", { cwd: s.project }), name: "mypane" }];
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  const r = s.cli(["attach", "Genie", "mypane", "--json"]);
  assert.equal(r.code, 0, r.err);
  const w = s.cli(["whois", "t4", "--json"]);
  assert.equal(w.json().bot, ID.main);
  assert.equal(w.json().terminal, "t4");
});

test("restart --cwd: a folder of the same Claude slug resumes the session by id there; another slug is refused unless --fresh; helpers keep their folders", (t) => {
  const s = restartScene(t);
  const from = join(s.root, "repos", "automagik-herdr"), to = join(s.root, "repos", "automagik", "herdr"), other = join(s.root, "elsewhere");
  for (const d of [from, to, other]) mkdirSync(d, { recursive: true });
  const st = s.hcState();
  const t5 = st.terminals.find((x) => x.address === "t5");
  t5.cwd = from;
  t5.foreground.cwd = from;
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  // automagik-herdr and automagik/herdr: one slug, so Claude finds the session in the new folder.
  const r = s.cli(["restart", "Genie", "--cwd", to, "--json"]);
  assert.equal(r.code, 0, r.err);
  const run = runCall(s.calls());
  assert.equal(run[run.indexOf("--cwd") + 1], to);
  assert.deepEqual(plain(agentWords(run)), ["claude", "--permission-mode", "auto", "--resume", SID]);
  assert.deepEqual([r.json().mode, r.json().session, r.json().replaced], ["resume", "***", "t5"]);
  // Another slug: refused, nothing started or ended; --fresh starts a new conversation there.
  const s2 = restartScene(t);
  const st2 = s2.hcState();
  Object.assign(st2.terminals.find((x) => x.address === "t5"), { cwd: from, foreground: { ...st2.terminals[0].foreground, cwd: from } });
  writeFileSync(join(s2.root, "hc.json"), JSON.stringify(st2));
  const refused = s2.cli(["restart", "Genie", "--cwd", other]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, new RegExp(`Claude keeps Genie's conversation under its folder's slug, .*automagik-herdr \\(.*\\); .*elsewhere is .*-elsewhere, `
    + `so a resume there would find nothing\\. Nothing was started\\. Restart with --fresh`));
  assert.equal(runCall(s2.calls()), undefined);
  assert.equal(at(s2.calls(), "kill"), -1);
  const fresh = s2.cli(["restart", "Genie", "--cwd", other, "--fresh", "--json"]);
  assert.equal(fresh.code, 0, fresh.err);
  const run2 = runCall(s2.calls());
  assert.equal(run2[run2.indexOf("--cwd") + 1], other);
  assert.deepEqual([freshClaude(plain(agentWords(run2))), fresh.json().mode], [["claude", "--permission-mode", "auto"], "fresh"]);
  // Not a folder: a usage mistake.
  assert.equal(s2.cli(["restart", "Genie", "--cwd", join(s2.root, "nope")]).code, 2);
  // --tree --cwd: the bot moves, its helpers run again in their own folders.
  const { s: tr, wt1, wt2 } = treeScene(t);
  const moved = join(tr.root, "moved");
  mkdirSync(moved);
  const tree = tr.cli(["restart", "Genie", "--tree", "--cwd", moved, "--fresh", "--json"]);
  assert.equal(tree.code, 0, tree.err);
  const [bot, w, v] = runs(tr);
  assert.deepEqual([bot, w, v].map((c) => c[c.indexOf("--cwd") + 1]), [moved, wt1, wt2]);
  onePanePerSession(tr);
});

test("restart --cwd: a non-Claude resume into another folder is said; --cwd with --machine is refused; a Claude bot's briefing hook goes into DIR", (t) => {
  const from = "/never/used";
  const s = captainScene(t, { agent: "codex", over: { foreground: { argv: ["codex"], cwd: from }, argv: ["codex"], cwd: from } });
  const a = join(s.root, "a"), b = join(s.root, "b");
  mkdirSync(a);
  mkdirSync(b);
  const st = s.hcState();
  Object.assign(st.terminals.find((x) => x.address === "t6"), { cwd: a, foreground: { argv: ["codex"], cwd: a } });
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  const r = s.cli(["restart", "Captain", "--cwd", b, "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, new RegExp(`t100 runs in ${b}, not ${a}: codex finds its last conversation by folder, so it may not find it there\\.`));
  const run = runCall(s.calls());
  assert.deepEqual([run[run.indexOf("--cwd") + 1], ...codexWords(plain(agentWords(run)))], [b, "codex", ...CODEX_MODE, "resume", "--last"]);
  // --machine: refused before anything is read or started, whatever DIR is.
  const m = s.cli(["restart", "Captain", "--machine", "box", "--cwd", b]);
  assert.equal(m.code, 2);
  assert.match(m.err, /--cwd is a folder on this computer; a restart on a linked machine keeps the old pane's\./);
  assert.equal(runs(s).length, 1, "nothing more started");
  // Claude: the briefing hook is written into DIR, as the help says.
  const c = restartScene(t);
  const dir = join(c.root, "moved");
  mkdirSync(dir);
  const moved = c.cli(["restart", "Genie", "--cwd", dir, "--fresh"]);
  assert.equal(moved.code, 0, moved.err);
  const hook = JSON.parse(readFileSync(join(dir, ".claude/settings.local.json"), "utf8"));
  assert.match(hook.hooks.UserPromptSubmit[0].hooks[0].command, /briefing\.mjs/);
});

// ---- the briefing in each agent's command: once, right after the executable ----

/** A scene whose main bot runs `agent` (a stand-in executable on PATH), started once. */
function agentScene(t, agent, { config = null } = {}) {
  const s = scene(t);
  exe(join(s.root, "bin", agent), "#!/bin/sh\nexit 0\n");
  if (config) { mkdirSync(join(s.home, dirname(config.path)), { recursive: true }); writeFileSync(join(s.home, config.path), config.text); }
  const file = team();
  file.bots[0].agent = agent;
  s.seed(file);
  return s;
}
const briefingWords = (words) => words.map((w, i) => [w, i]).filter(([w]) => w.includes("<herdr-bot>"));

test("worker scope: start and brief agree for git, worktree, opted-out and non-git projects", (t) => {
  for (const mode of ["git", "worktree", "opt-out", "non-git"]) {
    const s = scene(t, { isGit: mode !== "non-git" });
    const file = team();
    if (mode === "opt-out") file.bots[0].code = false;
    s.seed(file);
    let cwd = s.project;
    if (mode === "worktree") {
      cwd = join(s.root, "tree");
      git(s.project, "worktree", "add", "-q", "-b", "tree", cwd);
    }
    const full = s.cli(["brief", "Genie", "--json"], { cwd });
    assert.equal(full.code, 0, full.err);
    const started = s.cli(["start", "Genie", "--json"], { cwd });
    assert.equal(started.code, 0, started.err);
    const words = agentWords(runCall(s.calls()));
    const path = words[words.indexOf("--append-system-prompt-file") + 1];
    const launch = readFileSync(path, "utf8");
    const expected = mode === "git" || mode === "worktree";
    for (const text of [full.json().briefing, launch]) {
      assert.equal(text.includes(WORKER_LINE), expected, mode);
      if (!expected) assert.doesNotMatch(text, /worker/i);
    }
  }
});

test("code setting: create, edit, unrelated edits and invalid input preserve the stored choice, and ls, show and help print it", (t) => {
  const s = scene(t);
  s.seed(team());
  assert.match(s.cli(["--help"]).out, /edit <bot> \[the create options\] \[--code true\|false\]/);
  const made = s.cli(["create", "--name", "Writer", "--agent", "claude", "--code", "false"]);
  assert.equal(made.code, 0, made.err);
  const writer = () => s.bots().bots.find((b) => b.name === "Writer");
  assert.equal(writer().code, false);
  assert.equal(s.cli(["ls", "--json"]).json().projects[0].bots.find((b) => b.name === "Writer").code, false);
  assert.match(s.cli(["ls"]).out, /Writer {2}→ Genie {2}code false {2}claude/);
  assert.equal(s.cli(["show", "Writer", "--json"]).json().code, false);
  assert.match(s.cli(["show", "Writer"]).out, /code {9}false/);
  const role = s.cli(["edit", "Writer", "--role", "Writes prose"]);
  assert.equal(role.code, 0, role.err);
  assert.equal(writer().code, false);
  const before = readFileSync(s.botsPath, "utf8");
  for (const value of ["off", "0", "", "False"]) {
    const invalid = s.cli(["edit", "Writer", "--code", value]);
    assert.equal(invalid.code, 2, invalid.err);
    assert.match(invalid.err, /--code is true or false/);
    assert.equal(readFileSync(s.botsPath, "utf8"), before);
  }
  const enabled = s.cli(["edit", "Writer", "--code", "true"]);
  assert.equal(enabled.code, 0, enabled.err);
  assert.equal(writer().code, true);
  assert.equal(s.cli(["ls", "--json"]).json().projects[0].bots.find((b) => b.name === "Writer").code, true);
  const listed = s.cli(["ls"]).out;
  assert.match(listed, /Writer {2}→ Genie {2}claude/);
  assert.doesNotMatch(listed, /code true/);
  assert.equal(s.cli(["show", "Writer", "--json"]).json().code, true);
  assert.match(s.cli(["show", "Writer"]).out, /code {9}true/);
  assert.ok(s.cli(["brief", "Writer", "--json"]).json().briefing.includes(WORKER_LINE));
});

test("start: omp, pi and grok get the briefing once, as the word or value right after their executable", (t) => {
  for (const [agent, flag] of [["omp", null], ["pi", "--append-system-prompt"], ["grok", "--rules"]]) {
    const s = agentScene(t, agent);
    const r = s.cli(["start", "Genie", "--json"]);
    assert.equal(r.code, 0, r.err);
    const words = agentWords(runCall(s.calls()));
    assert.equal(words[0], agent);
    const found = briefingWords(words);
    assert.equal(found.length, 1, `${agent}: one copy`);
    if (flag) assert.deepEqual([words[1], found[0][1]], [flag, 2], `${agent}: ${flag} <text> first`);
    else assert.deepEqual([found[0][1], found[0][0].startsWith("--append-system-prompt=<herdr-bot>\n")], [1, true]);
    assert.match(found[0][0], /You are Genie, this project's main bot/);
  }
});

test("restart: an omp bot's pane command is not reused: one briefing, the new one, the source's words and a line naming the dropped flag (#597)", (t) => {
  const s = agentScene(t, "omp");
  assert.equal(s.cli(["start", "Genie", "--json"]).code, 0);
  const first = agentWords(runCall(s.calls()));
  const st = s.hcState();
  const pane = st.terminals.find((x) => x.labels?.bot === ID.main);
  pane.argv = ["/usr/bin/env", "PATH=/bin", "omp", "--thinking=high", ...first.slice(1)];
  pane.foreground = { argv: ["omp", "--thinking=high", ...first.slice(1)], cwd: s.project };
  pane.status = { app: "omp", state: "idle" };
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  const file = s.bots();
  file.bots[0].instructions = "Edited.";
  s.seed(file);
  const r = s.cli(["restart", "Genie", "--json"]);
  assert.equal(r.code, 0, r.err);
  const words = agentWords(s.calls().filter((c) => c[0] === "run").at(-1));
  const found = briefingWords(words);
  assert.equal(found.length, 1, "never twice");
  assert.equal(found[0][1], 1, "right after the executable");
  assert.match(found[0][0], /Edited\./, "the new text, not the old");
  assert.equal(words.includes("--thinking=high"), false, "the pane's old flag isn't carried over");
  assert.ok(words.includes("--continue"), "the source's own resume words");
  assert.match(r.err, /Genie: its pane's command differs from its source now \(drops --thinking=\*\*\*\)/);
});

test("start: hermes gets the briefing in its environment, unless its config sets its own prompt (then a warning)", (t) => {
  const plainStart = agentScene(t, "hermes");
  const r = plainStart.cli(["start", "Genie", "--json"]);
  assert.equal(r.code, 0, r.err);
  const run = runCall(plainStart.calls());
  const { prefix, env, words } = agentParts(run);
  assert.deepEqual(prefix, ["/usr/bin/env"]);
  assert.match(env[0], /^PATH=/);
  assert.equal(env.length, 3, `PATH, the app home and the briefing: no env word lost or leaked: ${env.join(" ")}`);
  assert.equal(env[1], `HERDR_APP_HOME=${plainStart.app}`, "the CLI's app home beside the briefing's env (#650)");
  assert.match(env[2], /^HERMES_EPHEMERAL_SYSTEM_PROMPT=<herdr-bot>\n/);
  assert.equal(words[0], "hermes");
  for (const text of ["agent:\n  system_prompt: Be terse.\n", "display:\n  personality: pirate\n"]) {
    const own = agentScene(t, "hermes", { config: { path: ".hermes/config.yaml", text } });
    const o = own.cli(["start", "Genie", "--json"]);
    assert.equal(o.code, 0, o.err);
    assert.ok(!agentParts(runCall(own.calls())).env.some((x) => x.startsWith("HERMES_EPHEMERAL_SYSTEM_PROMPT=")), text);
    assert.match(o.json().warnings.join("\n"), /hermes' config\.yaml sets a personality or agent\.system_prompt/);
  }
});

// #230: a project's formatter may use tabs (Biome's default) or four spaces. Every write keeps
// the indentation the file has; a new file is two spaces, as before.
const indented = (file, indent) => `${JSON.stringify(file, null, indent)}\n`;
const seedAs = (s, file, indent) => { mkdirSync(dirname(s.botsPath), { recursive: true }); writeFileSync(s.botsPath, indented(file, indent)); };
test("create, edit, rm and category keep bots.json's indentation (#230): tabs and four spaces stay", (t) => {
  for (const indent of ["\t", "    "]) {
    const s = scene(t);
    seedAs(s, team(), indent);
    const steps = [
      ["create", "--name", "Scout", "--agent", "claude"],
      ["edit", "Dev", "--role", "builds"],
      ["rm", "Scout"],
      ["category", "add", "--title", "Quality"],
      ["category", "edit", "quality", "--sub", "tests"],
      ["category", "order", "quality", "eng"],
      ["category", "rm", "quality"],
    ];
    for (const args of steps) {
      const r = s.cli(args);
      assert.equal(r.code, 0, `${args.join(" ")}: ${r.err}`);
      const text = readFileSync(s.botsPath, "utf8");
      assert.equal(text, indented(JSON.parse(text), indent), `${args.join(" ")} kept ${JSON.stringify(indent)}`);
    }
  }
});

test("a new bots.json is two spaces (#230); one from a worktree copies the main checkout's indentation", (t) => {
  const s = scene(t);
  const made = s.cli(["create", "--name", "Genie", "--agent", "claude"]);
  assert.equal(made.code, 0, made.err);
  const text = readFileSync(s.botsPath, "utf8");
  assert.equal(text, indented(JSON.parse(text), 2));
  const tabs = scene(t);
  const wt = join(tabs.root, "wt");
  git(tabs.project, "worktree", "add", "-q", wt);
  seedAs(tabs, team(), "\t"); // the main checkout's file, not committed: the worktree has none
  const e = tabs.cli(["edit", "Dev", "--role", "scouting"], { cwd: wt });
  assert.equal(e.code, 0, e.err);
  const wtText = readFileSync(join(wt, ".herdr/bots.json"), "utf8");
  assert.equal(JSON.parse(wtText).bots.find((b) => b.name === "Dev").role, "scouting");
  assert.equal(wtText, indented(JSON.parse(wtText), "\t"));
});

test("restart --save keeps bots.json's tabs (#230)", (t) => {
  const s = restartScene(t);
  seedAs(s, team(), "\t");
  const r = s.cli(["restart", "Genie", "--agent", "codex", "--save", "--force"]);
  assert.equal(r.code, 0, r.err);
  const text = readFileSync(s.botsPath, "utf8");
  assert.equal(JSON.parse(text).bots[0].agent, "codex");
  assert.equal(text, indented(JSON.parse(text), "\t"));
});

// ---- import (#232): a running hc team as bots ----

/** A seat: a live pane with an hc name, a squad label and an agent in front, run in `cwd`. */
const seat = (address, name, squad, { argv = ["claude"], app = "claude-code", labels = {}, ...rest } = {}) => {
  const x = term(address, { argv, app, ...rest });
  x.name = name;
  x.labels = { ...(squad ? { squad } : {}), ...labels };
  return x;
};
/** Two squads, a pane with no agent in front, a worker, a finished pane and an unlabelled one. */
const hcTeam = () => [
  term("t1", { bot: ID.main }),
  seat("t7", "runtime-cap", "runtime"),
  seat("t8", "runtime-dev", "runtime", { argv: ["codex"], app: "codex" }),
  seat("t9", "runtime-test", "runtime"),
  seat("t10", "infra-lead", "infra", { labels: { role: "captain" } }),
  seat("t11", "infra-review", "infra", { argv: ["codex"], app: "codex" }),
  seat("t12", "runtime-shell", "runtime", { argv: ["zsh"], app: null }),
  seat("t13", "runtime-helper", "runtime", { labels: { "worker.of": ID.main } }),
  seat("t14", "runtime-gone", "runtime", { state: "finished" }),
  seat("t20", "elsewhere", null),
];
/** A scene whose panes run in its project (a Claude seat's session must be the project's). */
function importScene(t, terminals = hcTeam(), file = { version: 1, categories: [], bots: [bot(ID.main, "main", { name: "Genie" })] }) {
  const s = scene(t, { terminals });
  const st = s.hcState();
  for (const x of st.terminals) { x.cwd = s.project; x.foreground.cwd = s.project; }
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  s.seed(file);
  return s;
}
const ledgerText = (s) => (existsSync(attachFile(s.app)) ? readFileSync(attachFile(s.app), "utf8") : "");
// The calls that would start, move, end or type into a pane: the import never makes one.
const paneMoves = (s) => s.calls().filter((c) => ["run", "kill", "send", "keys", "move", "interrupt"].includes(c[0]));

test("import --from-hc: the dry run prints the plan, captains first, and changes nothing", (t) => {
  const s = importScene(t);
  const before = readFileSync(s.botsPath, "utf8");
  const r = s.cli(["import", "--from-hc"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /\(dry run: nothing is changed\)/);
  assert.match(r.out, /squad infra\n {4}t10 {2}create infra-lead \(captain by role=captain, reports to Genie, claude\), then attach\n {4}t11 {2}create infra-review \(member, lead infra-lead, rank reviewer, codex\)/);
  assert.match(r.out, /squad runtime\n {4}t7 {2}create runtime-cap \(captain by name, reports to Genie, claude\), then attach\n {4}t8 {2}create runtime-dev \(member, lead runtime-cap, rank dev, codex\)/);
  assert.match(r.out, /t9 {2}create runtime-test \(member, lead runtime-cap, rank tester, claude\)/);
  assert.match(r.out, /skipped t12 \(runtime-shell\): no coding agent in front/);
  assert.match(r.out, /skipped t13 \(runtime-helper\): a worker/);
  assert.doesNotMatch(r.out, /runtime-gone|elsewhere/);
  assert.match(r.out, /Run it with --apply: 5 seat\(s\) to import\./);
  assert.equal(readFileSync(s.botsPath, "utf8"), before, "bots.json untouched");
  // #486 L1: not even the attach ledger's one-time import (t1's bot= label) is written.
  assert.equal(existsSync(attachFile(s.app)), false, "no attach ledger made");
  assert.deepEqual(labelCalls(s.calls()), [], "no label");
  assert.deepEqual(paneMoves(s), []);
  const j = s.cli(["import", "--from-hc", "--json"]);
  assert.equal(j.code, 0, j.err);
  const plan = j.json();
  assert.equal(plan.dryRun, true);
  assert.deepEqual(plan.seats.map((x) => [x.terminal, x.name, x.action, x.captain, x.lead, x.rank, x.agent, x.id]), [
    ["t10", "infra-lead", "create", true, "Genie", "captain", "claude", null],
    ["t11", "infra-review", "create", false, "infra-lead", "reviewer", "codex", null],
    ["t7", "runtime-cap", "create", true, "Genie", "captain", "claude", null],
    ["t8", "runtime-dev", "create", false, "runtime-cap", "dev", "codex", null],
    ["t9", "runtime-test", "create", false, "runtime-cap", "tester", "claude", null],
  ]);
  assert.deepEqual(plan.seats.filter((x) => x.captain).map((x) => [x.name, x.captainBy]), [["infra-lead", "role"], ["runtime-cap", "name"]]);
  assert.equal(readFileSync(s.botsPath, "utf8"), before);
  assert.equal(existsSync(attachFile(s.app)), false);
});

test("import --from-hc --apply creates and attaches every seat; a second run changes nothing", (t) => {
  const s = importScene(t);
  const r = s.cli(["import", "--from-hc", "--apply"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Import of the panes labelled squad= into .*:\n {2}squad infra/);
  assert.match(r.out, /runtime-dev \(b-[a-z2-7]{10}\) is now t8, created\./);
  const file = s.bots();
  assert.deepEqual(checkBots(file), []);
  const by = (n) => file.bots.find((b) => b.name === n);
  for (const n of ["runtime-cap", "infra-lead"]) assert.deepEqual([by(n).kind, by(n).lead, by(n).rank], ["member", undefined, "captain"]);
  assert.equal(by("runtime-dev").lead, by("runtime-cap").id);
  assert.equal(by("runtime-dev").agent, "codex");
  assert.equal(by("runtime-test").lead, by("runtime-cap").id);
  assert.equal(by("infra-review").lead, by("infra-lead").id);
  assert.equal(file.bots.length, 6);
  // The ledger: one attach per seat, by attach, none moved; whois answers by it.
  const rows = attachOf(s).filter((x) => x.by !== "import");
  assert.deepEqual(rows.map((x) => [x.event, x.terminal, x.bot, x.reason ?? null]).sort(), [
    ["attach", "t10", by("infra-lead").id, null], ["attach", "t11", by("infra-review").id, null],
    ["attach", "t7", by("runtime-cap").id, null], ["attach", "t8", by("runtime-dev").id, null],
    ["attach", "t9", by("runtime-test").id, null],
  ]);
  const whois = s.cli(["whois", "t8", "--json"]).json();
  assert.equal(whois.bot, by("runtime-dev").id);
  assert.deepEqual(Object.keys(whois).sort(), ["bot", "core", "created_ms", "project", "since", "terminal"], "bots.whois-json@1's keys");
  assert.equal(labelsIn(s).t8.bot, by("runtime-dev").id);
  assert.equal(labelsIn(s).t12.bot, undefined, "a skipped pane is left as it is");
  assert.deepEqual(paneMoves(s), [], "no pane started, moved or ended");
  // Again: the same plan, every seat already plays its bot; no file, ledger or label changes.
  const botsBefore = readFileSync(s.botsPath, "utf8");
  const ledgerBefore = ledgerText(s);
  const labelsBefore = labelCalls(s.calls()).length;
  const again = s.cli(["import", "--from-hc", "--apply"]);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /t8 {2}runtime-dev \(b-[a-z2-7]{10}\) already plays it: nothing to do/);
  assert.match(again.out, /Nothing to do: every seat already plays its bot\./);
  assert.equal(readFileSync(s.botsPath, "utf8"), botsBefore);
  assert.equal(ledgerText(s), ledgerBefore);
  assert.equal(labelCalls(s.calls()).length, labelsBefore);
  assert.deepEqual(paneMoves(s), []);
  // A run cut short leaves a bot defined but attached nowhere: the next run only attaches it.
  assert.equal(s.cli(["detach", "runtime-dev"]).code, 0);
  const resume = s.cli(["import", "--from-hc", "--apply", "--json"]);
  assert.equal(resume.code, 0, resume.err);
  const out = resume.json();
  assert.deepEqual(out.seats.filter((x) => x.action !== "already").map((x) => [x.terminal, x.action, x.id]), [["t8", "attach", by("runtime-dev").id]]);
  assert.deepEqual(out.attached.map((x) => [x.terminal, x.created]), [["t8", false]]);
  assert.equal(s.bots().bots.length, 6, "nothing created twice");
  assert.equal(s.cli(["whois", "t8", "--json"]).json().bot, by("runtime-dev").id);
});

test("import refuses the whole run on a conflict with an existing bot; nothing is written", (t) => {
  const taken = term("t30", { bot: ID.dev });
  const terminals = [...hcTeam(), taken, seat("t31", "loose-a", "loose"), seat("t32", "loose-b", "loose")];
  const s = importScene(t, terminals, { version: 1, categories: [], bots: [
    bot(ID.main, "main", { name: "Genie" }),
    // runtime-dev plays t30, so its seat t8 can't be it; Genie's pane carries a squad label.
    bot(ID.dev, "member", { name: "runtime-dev" }),
    bot(ID.cap, "member", { name: "Spare" }),
  ] });
  // The ledger first (its one-time import from labels), then a bot= label on t11 by hand.
  assert.equal(s.cli(["whois", "t30", "--json"]).json().bot, ID.dev);
  const st = s.hcState();
  st.terminals.find((x) => x.address === "t1").labels.squad = "runtime";
  st.terminals.find((x) => x.address === "t11").labels.bot = ID.cap;
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  const before = readFileSync(s.botsPath, "utf8");
  const r = s.cli(["import", "--from-hc", "--apply"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /import refused, nothing was changed: 4 conflict\(s\)/);
  assert.match(r.out, /conflict: t1 already plays Genie \(b-aaaaaaaaaa\); the import never takes another bot's pane/);
  assert.match(r.out, /conflict: runtime-dev \(b-cccccccccc\) already plays t30, not t8; the import never moves a bot/);
  assert.match(r.out, /conflict: t11 \(infra-review\) is labelled bot=b-bbbbbbbbbb, Spare \(b-bbbbbbbbbb\)/);
  assert.match(r.out, /conflict: Squad loose has no captain/);
  assert.equal(readFileSync(s.botsPath, "utf8"), before);
  assert.deepEqual(attachOf(s).filter((x) => x.by !== "import"), []);
  assert.deepEqual(labelCalls(s.calls()), []);
  assert.deepEqual(paneMoves(s), []);
  // The dry run says the same and exits 1 too.
  assert.equal(s.cli(["import", "--from-hc"]).code, 1);
  assert.equal(readFileSync(s.botsPath, "utf8"), before);
});

test("import: needs --from-hc, works on this computer only, and refuses with no main bot", (t) => {
  const s = importScene(t, hcTeam(), { version: 1, categories: [], bots: [] });
  assert.equal(s.cli(["import"]).code, 2);
  assert.match(s.cli(["import", "--from-hc", "--machine", "vps"]).err, /import works on this computer only/);
  const r = s.cli(["import", "--from-hc", "--apply"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /has no main bot; the import makes captains and members under it/);
  assert.deepEqual(paneMoves(s), []);
});

/** The scene's hc state, changed by `edit` and written back; a pane added runs in the project. */
const hcEdit = (s, edit) => {
  const st = s.hcState();
  edit(st.terminals, (x) => st.terminals.find((y) => y.address === x));
  for (const x of st.terminals) { x.cwd = s.project; x.foreground.cwd = s.project; }
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
};

test("import's dry run (#486 L1) sees the ledger's one-time import and ended panes, and writes neither", (t) => {
  // t1 plays Genie by its bot= label only (no ledger yet), and carries a squad label.
  const terminals = hcTeam();
  terminals[0].labels = { ...terminals[0].labels, squad: "runtime" };
  const s = importScene(t, terminals);
  const r = s.cli(["import", "--from-hc"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /conflict: t1 already plays Genie \(b-aaaaaaaaaa\)/);
  assert.equal(existsSync(attachFile(s.app)), false, "the one-time import is worked out, not written");
  hcEdit(s, (_, at) => { delete at("t1").labels.squad; });
  assert.equal(s.cli(["import", "--from-hc", "--apply"]).code, 0);
  // A seat hc no longer confirms: the dry run leaves its end row to a command that writes.
  hcEdit(s, (_, at) => { at("t9").state = "finished"; });
  const ledger = ledgerText(s);
  const d = s.cli(["import", "--from-hc"]);
  assert.equal(d.code, 0, d.err);
  assert.equal(ledgerText(s), ledger, "no end row from the dry run");
  s.cli(["whois", "t9", "--json"]);
  assert.ok(attachOf(s).some((x) => x.event === "end" && x.terminal === "t9" && x.by === "sweep"), "whois writes it");
});

test("import refuses a defined bot of another agent than its pane, naming both (#486 L2)", (t) => {
  const defined = (agent) => ({ version: 1, categories: [], bots: [bot(ID.main, "main", { name: "Genie" }), bot(ID.cap, "member", { name: "runtime-cap", agent })] });
  const s = importScene(t, hcTeam(), defined("codex"));
  const before = readFileSync(s.botsPath, "utf8");
  const r = s.cli(["import", "--from-hc", "--apply"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /import refused, nothing was changed: 2 conflict\(s\)/);
  assert.match(r.out, /conflict: t7 \(runtime-cap\) runs claude, and runtime-cap \(b-bbbbbbbbbb\) is defined with agent codex; the import never attaches a bot to another agent's pane\. Edit it first \(am edit b-bbbbbbbbbb --agent claude\)/);
  assert.match(r.out, /conflict: Squad runtime has no captain/, "its seat is out of the plan");
  assert.equal(readFileSync(s.botsPath, "utf8"), before);
  assert.deepEqual(attachOf(s).filter((x) => x.by !== "import"), []);
  assert.deepEqual(labelCalls(s.calls()), []);
  // The pane's agent: the bot is attached, the others made under it.
  s.seed(defined("claude"));
  const ok = s.cli(["import", "--from-hc", "--apply", "--json"]);
  assert.equal(ok.code, 0, ok.err);
  assert.deepEqual(ok.json().attached.filter((x) => x.terminal === "t7").map((x) => [x.id, x.created]), [[ID.cap, false]]);
  assert.equal(s.bots().bots.find((b) => b.name === "runtime-dev").lead, ID.cap);
  assert.deepEqual(paneMoves(s), []);
});

test("import's captain by name is the squad's name then -cap or -captain (#486 L3)", (t) => {
  const s = importScene(t, [
    term("t1", { bot: ID.main }),
    seat("t7", "web-lead", "web"),
    seat("t8", "escape-cap", "web"),
    seat("t9", "cap", "web"),
    seat("t10", "web-cap", "web", { labels: { role: "dev" } }),
  ]);
  const none = s.cli(["import", "--from-hc"]);
  assert.equal(none.code, 1);
  assert.match(none.out, /conflict: Squad web has no captain/);
  hcEdit(s, (all) => { all.push(seat("t11", "Web_Captain", "web")); });
  const byName = s.cli(["import", "--from-hc", "--json"]);
  assert.equal(byName.code, 0, byName.err);
  assert.deepEqual(byName.json().seats.map((x) => [x.terminal, x.captain, x.captainBy, x.lead, x.rank]), [
    ["t11", true, "name", "Genie", "captain"],
    ["t7", false, null, "Web_Captain", null],
    ["t8", false, null, "Web_Captain", null],
    ["t9", false, null, "Web_Captain", null],
    ["t10", false, null, "Web_Captain", "dev"],
  ]);
  assert.match(s.cli(["import", "--from-hc"]).out, /t11 {2}create Web_Captain \(captain by name, reports to Genie, claude\)/);
  hcEdit(s, (_, at) => { at("t11").name = "web-two"; at("t11").template = "web-cap"; });
  const byTemplate = s.cli(["import", "--from-hc", "--json"]).json();
  assert.deepEqual(byTemplate.seats.filter((x) => x.captain).map((x) => [x.terminal, x.captainBy]), [["t11", "template"]]);
  assert.equal(existsSync(attachFile(s.app)), false);
});

test("import gives a seat already playing its bot its lost labels back, with no ledger row (#486 L5)", (t) => {
  const s = importScene(t);
  assert.equal(s.cli(["import", "--from-hc", "--apply"]).code, 0);
  const want = labelsIn(s).t8;
  hcEdit(s, (_, at) => { delete at("t8").labels.bot; delete at("t8").labels.role; });
  const botsBefore = readFileSync(s.botsPath, "utf8");
  const ledgerBefore = ledgerText(s);
  const workersBefore = readFileSync(ledgerPath(s.app), "utf8");
  const labelsBefore = labelCalls(s.calls()).length;
  const dry = s.cli(["import", "--from-hc"]);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /t8 {2}runtime-dev \(b-[a-z2-7]{10}\) already plays it: its lost labels go back \(bot=b-[a-z2-7]{10} role=/);
  assert.match(dry.out, /t9 {2}runtime-test \(b-[a-z2-7]{10}\) already plays it: nothing to do/);
  assert.match(dry.out, /Run it with --apply: 1 seat\(s\) to import\./);
  assert.equal(labelCalls(s.calls()).length, labelsBefore, "the dry run labels nothing");
  const r = s.cli(["import", "--from-hc", "--apply", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json().attached.map((x) => [x.terminal, x.created, x.already]), [["t8", false, true]]);
  assert.deepEqual(labelsIn(s).t8, want);
  assert.equal(readFileSync(s.botsPath, "utf8"), botsBefore);
  assert.equal(ledgerText(s), ledgerBefore, "no attach row");
  assert.equal(readFileSync(ledgerPath(s.app), "utf8"), workersBefore, "no workers-ledger row");
  assert.match(s.cli(["import", "--from-hc"]).out, /Nothing to do: every seat already plays its bot\./);
  assert.deepEqual(paneMoves(s), []);
});

test("launch-path #453: where a launch finds a program and the PATH its pane gets; nulls when none has it", (t) => {
  const s = scene(t);
  const r = s.cli(["launch-path", "claude"]);
  assert.equal(r.code, 0, r.err);
  const { program, path } = r.json();
  assert.equal(program, join(s.root, "bin", "claude"), "the stand-in, found by PATH as a launch finds it");
  assert.ok(path.split(":").includes(join(s.root, "bin")) && path.split(":").includes("/usr/bin"), path);
  assert.deepEqual(s.cli(["launch-path", "no-such-agent-453"]).json(), { program: null, path: null });
  assert.equal(s.cli(["launch-path"]).code, 2);
  assert.equal(s.cli(["launch-path", "-x"]).code, 2);
});

test("start #225/#223: the ledger lock stays fresh across a slow hc run, so two starts at once start the bot once", async (t) => {
  const s = scene(t);
  s.seed(team());
  // hc run answers after 0.6 s, past a 400 ms stale limit: a lock not kept fresh is taken over by
  // the waiting start, which finds no binding yet and starts the bot again. Short, so the
  // waiting start's 3 s ledger-lock wait has room under load.
  exe(join(s.root, "bin/hc"), `#!/bin/sh\nif [ "$1" = run ]; then sleep 0.6; fi\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  const env = { AUTOMAGIK_HERDR_LOCK_STALE_MS: "400" };
  const both = await Promise.all([s.cliAsync(["start", "Genie"], { env }), s.cliAsync(["start", "Genie"], { env })]);
  assert.equal(s.calls().filter((c) => c[0] === "run").length, 1, both.map((r) => r.err).join("\n"));
  assert.deepEqual(both.map((r) => r.code), [0, 0], both.map((r) => r.err).join("\n"));
  assert.ok(both.some((r) => /Genie is already running in t100\./.test(r.out)), both.map((r) => r.out).join("\n"));
});

// ---- RFC 0021 delivery 3: the rows meter attribution needs (synthetic ids only) ----

const rowsOf_ = (s, event) => ledgerOf(s).filter((x) => x.event === event);
const seatRows = (s) => ledgerOf(s).filter((x) => x.event === "start" && x.kind === "seat");
const modeOf = (path) => statSync(path).mode & 0o777;
const createdOf = (s, address) => s.hcState().terminals.find((x) => x.address === address).created_ms;

test("RFC 0021: a seat start row carries core, created_ms, role, lead and squad; the ledger is 0600, made or appended", (t) => {
  const s = scene(t);
  const f = team();
  f.bots.find((b) => b.id === ID.dev).rank = "dev";
  s.seed(f);
  // An existing ledger made under umask 002 (0664): the next append makes it the owner's alone.
  mkdirSync(join(s.app, "automagik-herdr"), { recursive: true });
  writeFileSync(ledgerPath(s.app), "");
  chmodSync(ledgerPath(s.app), 0o664);
  assert.equal(s.cli(["start", "Captain"]).code, 0);
  assert.equal(modeOf(ledgerPath(s.app)), 0o600, "set to 0600 on append");
  assert.equal(s.cli(["start", "Dev"]).code, 0);
  const [cap, dev] = seatRows(s);
  // Captain reports to the main bot and leads Dev: its own squad. Dev's squad is its captain's.
  assert.deepEqual([cap.terminal, cap.core, cap.created_ms, cap.role, cap.lead, cap.squad], ["t100", "fakecore0000", createdOf(s, "t100"), "captain", ID.main, ID.cap]);
  assert.deepEqual([dev.terminal, dev.core, dev.created_ms, dev.role, dev.lead, dev.squad], ["t101", "fakecore0000", createdOf(s, "t101"), "dev", ID.cap, ID.cap]);
  assert.ok(Number.isSafeInteger(cap.created_ms));
  // A new ledger: 0600 from the start.
  const fresh = scene(t);
  fresh.seed(team());
  assert.equal(fresh.cli(["start", "Genie"]).code, 0);
  assert.equal(modeOf(ledgerPath(fresh.app)), 0o600);
  const main = seatRows(fresh)[0];
  assert.deepEqual([main.role, main.lead, main.squad], ["main", null, null], "the main bot heads no squad");
  // #883: a symlink at the ledger's path is not followed: the file behind it keeps its bytes and
  // its mode, and the start goes on with a warning.
  const linked = scene(t);
  linked.seed(team());
  const behind = join(linked.root, "behind.jsonl");
  writeFileSync(behind, "keep\n");
  chmodSync(behind, 0o644);
  mkdirSync(dirname(ledgerPath(linked.app)), { recursive: true });
  symlinkSync(behind, ledgerPath(linked.app));
  const viaLink = linked.cli(["start", "Genie"]);
  assert.equal(viaLink.code, 0, viaLink.err);
  assert.match(viaLink.err, /isn't in automagik-herdr\/workers\.jsonl, so its usage won't be tied to it: ELOOP/);
  assert.equal(readFileSync(behind, "utf8"), "keep\n");
  assert.equal(modeOf(behind), 0o644);
});

test("RFC 0021: core comes from hc server status, created_ms from hc get", (t) => {
  const s = scene(t);
  s.seed(team());
  const st = s.hcState();
  st.core = { id: "core-synthetic-1", name: "fake" };
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  assert.equal(s.cli(["start", "Genie"]).code, 0);
  const row = seatRows(s)[0];
  assert.deepEqual([row.core, row.created_ms], ["core-synthetic-1", createdOf(s, "t100")]);
  assert.ok(s.calls().some((c) => c[0] === "server" && c[1] === "status"), "asked hc server status");
});

test("RFC 0021: a fresh Claude launch gets a new id; restart resumes that id; --fresh gets another; each replaced launch gets its end row", (t) => {
  const s = scene(t);
  s.seed(team());
  assert.equal(s.cli(["start", "Genie"]).code, 0);
  const first = seatRows(s)[0];
  assert.match(first.session, SID_SHAPE);
  const label = (address) => s.hcState().terminals.find((x) => x.address === address).labels["agent.session"];
  assert.equal(label("t100"), first.session, "labelled with the same id");
  // A restart resumes it: --resume <that id>, never a new --session-id.
  const r = s.cli(["restart", "Genie", "--force", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().mode, "resume");
  const resumed = s.calls().filter((c) => c[0] === "run")[1];
  assert.deepEqual(plain(agentWords(resumed)), ["claude", "--permission-mode", "auto", "--resume", first.session]);
  assert.equal(resumed.includes("--session-id"), false);
  assert.equal(r.out.includes(first.session), false, "--json shows no session id");
  assert.equal(r.json().session, "***");
  const second = seatRows(s)[1];
  assert.deepEqual([second.terminal, second.session], ["t101", first.session]);
  // The old launch ended only once its kill succeeded: its end row, keyed by core, terminal, created_ms.
  assert.deepEqual(rowsOf_(s, "end").map((x) => [x.kind, x.terminal, x.core, x.created_ms, x.reason]),
    [["seat", "t100", "fakecore0000", createdOf(s, "t100"), "replaced"]]);
  // --fresh: a new id, not the old one.
  const f = s.cli(["restart", "Genie", "--fresh", "--force", "--json"]);
  assert.equal(f.code, 0, f.err);
  const third = seatRows(s)[2];
  assert.match(third.session, SID_SHAPE);
  assert.notEqual(third.session, first.session);
  const freshRun = s.calls().filter((c) => c[0] === "run")[2];
  assert.deepEqual(plain(agentWords(freshRun)).slice(-2), ["--session-id", third.session]);
  assert.equal(label("t102"), third.session);
  assert.equal(f.out.includes(third.session), false);
  assert.deepEqual(f.json().argv.slice(-2), ["--session-id", "***"]);
  assert.deepEqual(rowsOf_(s, "end").map((x) => x.terminal), ["t100", "t101"]);
});

test("RFC 0021: a restart whose kill of the old pane fails writes no end row", (t) => {
  const s = restartScene(t);
  const st = s.hcState();
  st.failKill = "t5";
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  const r = s.cli(["restart", "Genie"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /t5 wasn't ended/);
  assert.deepEqual(rowsOf_(s, "end"), []);
  // The new seat row names the resumed session; the old pane's own id goes nowhere else.
  assert.deepEqual(seatRows(s).map((x) => [x.terminal, x.session]), [["t100", SID]]);
});

test("RFC 0021: a command that picks its own session gets no --session-id", (t) => {
  const s = scene(t);
  s.seed(team());
  const own = "11111111-2222-4333-8444-555555555555";
  writeFileSync(join(s.app, "programs.json"), `${JSON.stringify({ programs: { claude: { run: [join(s.root, "bin", "claude"), "--session-id", own] } } })}\n`);
  assert.equal(s.cli(["start", "Genie"]).code, 0);
  const run = runCall(s.calls());
  assert.equal(run.filter((w) => w === "--session-id").length, 1, "the person's own, alone");
  assert.equal(run[run.indexOf("--session-id") + 1], own);
  assert.equal(run.some((w) => w.startsWith("agent.session=")), false);
  assert.equal(seatRows(s)[0].session, null, "no id Herdr didn't choose");
});

test("RFC 0021: attach writes a seat row with role, lead, squad, core and created_ms", (t) => {
  const pane = term("t7", { cwd: "/x", created: 4242 });
  const s = scene(t, { terminals: [pane] });
  s.seed(team());
  const st = s.hcState();
  st.terminals[0].cwd = s.project;
  st.terminals[0].foreground.cwd = s.project;
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  const r = s.cli(["attach", "Captain", "t7"]);
  assert.equal(r.code, 0, r.err);
  const row = seatRows(s)[0];
  assert.deepEqual([row.terminal, row.core, row.created_ms, row.role, row.lead, row.squad], ["t7", "fakecore0000", 4242, "captain", ID.main, ID.cap]);
});

test("RFC 0021: restart --tree ends the replaced launches, keeps a worker's frozen squad, tags the seat", (t) => {
  const { s } = treeScene(t);
  // The worker's row froze its squad at launch; the registry has changed since (Genie heads none).
  const rows = ledgerOf(s).map((x) => (x.terminal === "t7" ? { ...x, squad: ID.cap, core: "fakecore0000", created_ms: 1 } : x));
  writeFileSync(ledgerPath(s.app), rows.map((x) => `${JSON.stringify(x)}\n`).join(""));
  const r = s.cli(["restart", "Genie", "--tree", "--json"]);
  assert.equal(r.code, 0, r.err);
  const worker = ledgerOf(s).find((x) => x.event === "start" && x.terminal === "t101");
  assert.deepEqual([worker.kind, worker.squad, worker.lead, worker.role, worker.core, worker.created_ms],
    ["worker", ID.cap, ID.main, "dev", "fakecore0000", createdOf(s, "t101")], "copied, not recomputed");
  const seat = seatRows(s).find((x) => x.terminal === "t100");
  assert.deepEqual([seat.role, seat.lead, seat.squad, seat.session], ["main", null, null, SID]);
  // The bot's old pane and the logged worker ended: end rows; the template helper has no row to end.
  assert.deepEqual(rowsOf_(s, "end").map((x) => [x.kind, x.terminal, x.created_ms, x.reason]).sort(),
    [["seat", "t5", 1, "replaced"], ["worker", "t7", 1, "replaced"]]);
  assert.equal(r.out.includes(SID2), false, "a helper's session isn't printed");
});

/** A scene whose app home is inside the project (a project app home, `.herdr/app-home`). */
function projectHomeScene(t, { ignore = null } = {}) {
  const s = scene(t);
  s.seed(team());
  if (ignore !== null) { writeFileSync(join(s.project, ".gitignore"), ignore); git(s.project, "add", ".gitignore"); git(s.project, "commit", "-qm", "ignore"); }
  const app = join(s.project, ".herdr/app-home");
  mkdirSync(join(app, "mods/am-sidebar"), { recursive: true });
  writeFileSync(join(app, "mods/am-sidebar/briefing.mjs"), "// stand-in\n");
  return { s, app, exclude: join(s.project, ".git/info/exclude") };
}

test("RFC 0021: a project app home git doesn't ignore goes in the clone's exclude file once, with one warning", (t) => {
  const { s, app, exclude } = projectHomeScene(t);
  const before = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  const r = s.cli(["start", "Genie"], { env: { HERDR_APP_HOME: app } });
  assert.equal(r.code, 0, r.err);
  const lines = readFileSync(exclude, "utf8").split("\n");
  assert.equal(lines.filter((l) => l === "/.herdr/app-home/").length, 1);
  assert.equal(r.err.split("\n").filter((l) => l.includes("didn't ignore it")).length, 1, r.err);
  assert.equal(git(s.project, "check-ignore", "-q", "--no-index", ".herdr/app-home/automagik-herdr/workers.jsonl"), "");
  assert.equal(readFileSync(exclude, "utf8").startsWith(before), true, "only added to");
  // The next run: ignored now, nothing added, nothing said.
  const again = s.cli(["start", "Captain"], { env: { HERDR_APP_HOME: app } });
  assert.equal(again.code, 0, again.err);
  assert.equal(readFileSync(exclude, "utf8").split("\n").filter((l) => l === "/.herdr/app-home/").length, 1);
  assert.equal(again.err.includes("ignore"), false, again.err);
  assert.equal(git(s.project, "status", "--porcelain", "--", ".gitignore"), "", "no tracked file touched");
});

test("RFC 0021: a project app home already ignored adds nothing to the exclude file", (t) => {
  const { s, app, exclude } = projectHomeScene(t, { ignore: ".herdr/app-home/\n" });
  const r = s.cli(["start", "Genie"], { env: { HERDR_APP_HOME: app } });
  assert.equal(r.code, 0, r.err);
  // (The briefing hook adds its own settings.local.json line there, as always; nothing for the app home.)
  assert.equal((existsSync(exclude) ? readFileSync(exclude, "utf8") : "").includes(".herdr/app-home"), false);
  assert.equal(r.err.includes("ignore"), false, r.err);
});

// ---- RFC 0021 delivery 3, review round: the Fixer's and the Herdr Captain's items ----

test("RFC 0021: a ledger git tracks under a project app home is detected and said, with what to do", (t) => {
  const { s, app, exclude } = projectHomeScene(t);
  mkdirSync(join(app, "automagik-herdr"), { recursive: true });
  writeFileSync(join(app, "automagik-herdr/workers.jsonl"), "");
  git(s.project, "add", "-f", ".herdr/app-home/automagik-herdr/workers.jsonl");
  git(s.project, "commit", "-qm", "a ledger committed by mistake");
  const r = s.cli(["start", "Genie"], { env: { HERDR_APP_HOME: app } });
  assert.equal(r.code, 0, r.err);
  const said = r.err.split("\n").filter((l) => l.includes("is tracked by git"));
  assert.equal(said.length, 1, r.err);
  assert.match(said[0], /\.herdr\/app-home\/automagik-herdr\/workers\.jsonl is tracked by git in .*: an exclude can't untrack a file, so it stays in git until you run git rm --cached \.herdr\/app-home\/automagik-herdr\/workers\.jsonl there and commit that/);
  // The line goes in anyway, once, so the file stays out once untracked.
  assert.equal(readFileSync(exclude, "utf8").split("\n").filter((l) => l === "/.herdr/app-home/").length, 1);
  assert.equal(git(s.project, "ls-files", ".herdr/app-home/automagik-herdr/workers.jsonl").trim(), ".herdr/app-home/automagik-herdr/workers.jsonl",
    "the CLI untracks nothing itself");
});

test("RFC 0021: an app home at a work tree's root excludes only its ledger folder, never the whole tree", (t) => {
  const s = scene(t);
  s.seed(team());
  mkdirSync(join(s.project, "mods/am-sidebar"), { recursive: true });
  writeFileSync(join(s.project, "mods/am-sidebar/briefing.mjs"), "// stand-in\n");
  const r = s.cli(["start", "Genie"], { env: { HERDR_APP_HOME: s.project } });
  assert.equal(r.code, 0, r.err);
  const lines = readFileSync(join(s.project, ".git/info/exclude"), "utf8").split("\n");
  assert.equal(lines.includes("/*"), false);
  assert.equal(lines.filter((l) => l === "/automagik-herdr/").length, 1);
  assert.equal(git(s.project, "check-ignore", "-q", "automagik-herdr/workers.jsonl"), "");
});

test("RFC 0021: one end row per launch: restart --tree and the worktree sweep both see the helper end", (t) => {
  const { s } = treeScene(t);
  // t7's worker made its worktree and its row has the launch key, so the sweep looks at it too.
  const rows = ledgerOf(s).map((x) => (x.terminal === "t7" ? { ...x, created: true, core: "fakecore0000", created_ms: 1 } : x));
  writeFileSync(ledgerPath(s.app), rows.map((x) => `${JSON.stringify(x)}\n`).join(""));
  assert.equal(s.cli(["restart", "Genie", "--tree"]).code, 0);
  // Its replacement ends too; both finished long enough ago for the sweep to look.
  const st = s.hcState();
  for (const x of st.terminals) if (["t7", "t101"].includes(x.address)) Object.assign(x, { state: "finished", finished_ms: Date.now() - 20 * 60_000 });
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  for (let i = 0; i < 2; i += 1) assert.equal(s.cli(["reap"]).code, 0);
  const ends = (terminal) => ledgerOf(s).filter((x) => x.event === "end" && x.terminal === terminal).map((x) => x.reason);
  assert.deepEqual(ends("t7"), ["replaced"], "the sweep adds none for a launch --tree ended");
  assert.deepEqual(ends("t101"), ["finished"], "the replacement's own, once, though the sweep ran twice");
  assert.deepEqual(ends("t5"), ["replaced"]);
});

test("reap #899: a finished launch's end row and its branch's pr rows reach workers.jsonl, with no worktree left to remove", (t) => {
  const ended = Date.now() - 20 * 60_000;
  const s = scene(t, { terminals: [{ ...term("t7", { state: "finished", created: 5 }), finished_ms: ended, reason: "exited", exit_code: 2, signal: null }] });
  // A stand-in gh: what it was asked, and gh.json as its answer. The real one is never run.
  const ghLog = join(s.root, "gh.log"), ghJson = join(s.root, "gh.json");
  exe(join(s.root, "bin", "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${ghLog}"\ncat "${ghJson}"\n`);
  const pr = (state, extra = {}) => [{ number: 12, state, createdAt: "2026-02-03T05:00:00Z", mergedAt: null, closedAt: null, baseRefName: "main",
    title: "TITLE-MARK", author: { login: "AUTHOR-MARK" }, url: "https://example.invalid/URL-MARK", headRefOid: "SHA-MARK", ...extra }];
  writeFileSync(ghJson, JSON.stringify(pr("OPEN")));
  // The worker's branch: one commit on top of where its worktree started. The worktree itself is gone already.
  const base = git(s.project, "rev-parse", "HEAD").trim();
  git(s.project, "branch", "-q", "fix/213");
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", "-m", "work", "-p", base, `${base}^{tree}`],
    { cwd: s.project, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: "2026-02-03T04:05:06Z", GIT_COMMITTER_DATE: "2026-02-03T04:05:06Z" } })
    .trim().split("\n").forEach((sha) => git(s.project, "update-ref", "refs/heads/fix/213", sha));
  mkdirSync(join(s.app, "automagik-herdr"), { recursive: true });
  const start = { event: "start", kind: "worker", terminal: "t7", pid: 1, botId: ID.main, task: "gh-213", branch: "fix/213", project: s.project, lead: ID.main,
    worktree: join(s.root, "wt-gone"), base, created: true, core: "fakecore0000", created_ms: 5, at: new Date(Date.now() - 2 * 3600_000).toISOString() };
  writeFileSync(ledgerPath(s.app), `${JSON.stringify(start)}\n`, { mode: 0o600 });
  const first = s.cli(["reap"]);
  assert.equal(first.code, 0, first.err);
  assert.equal(first.out.trim(), `kept ${start.worktree}: `
    + "can't verify missing worktree repository ownership");
  const open = { event: "pr", project: s.project, branch: "fix/213", task: "gh-213", pr: 12, state: "open", first_commit_at: "2026-02-03T04:05:06.000Z",
    opened_at: "2026-02-03T05:00:00.000Z", merged_at: null, closed_at: null, core: "fakecore0000" };
  const at = (rows) => rows.map(({ at: _at, ...row }) => row);
  assert.deepEqual(ledgerOf(s).slice(1).map(({ at: when, ...row }) => (row.event === "end" ? { ...row, at: when } : row)), [
    { event: "end", kind: "worker", terminal: "t7", core: "fakecore0000", created_ms: 5, reason: "finished", hc_reason: "exited", exit_code: 2, at: new Date(ended).toISOString() },
    open,
  ]);
  // The pull request merges: one more row, and then it is asked for no more.
  writeFileSync(ghJson, JSON.stringify(pr("MERGED", { mergedAt: "2026-02-04T00:00:00Z", closedAt: "2026-02-04T00:00:00Z" })));
  for (let i = 0; i < 3; i += 1) assert.equal(s.cli(["reap"]).code, 0);
  assert.deepEqual(at(ledgerOf(s).filter((x) => x.event === "pr")), [open,
    { ...open, state: "merged", merged_at: "2026-02-04T00:00:00.000Z", closed_at: "2026-02-04T00:00:00.000Z" }]);
  assert.equal(ledgerOf(s).filter((x) => x.event === "end").length, 1);
  assert.deepEqual(readFileSync(ghLog, "utf8").trim().split("\n"),
    Array(2).fill("pr list --head fix/213 --state all --json number,state,createdAt,mergedAt,closedAt,baseRefName --limit 20"));
  const text = readFileSync(ledgerPath(s.app), "utf8");
  assert.doesNotMatch(text, /MARK/, "no title, author, address or commit of the pull request");
  assert.equal(statSync(ledgerPath(s.app)).mode & 0o777, 0o600);
  // Every row is one usagemeter's reader takes (ledger.rs parse_pr): its keys, and no other.
  for (const row of ledgerOf(s).filter((x) => x.event === "pr")) {
    assert.deepEqual(Object.keys(row), ["event", "project", "branch", "task", "pr", "state", "first_commit_at", "opened_at", "merged_at", "closed_at", "core", "at"]);
  }
});

/** Every session id the scene's ledger and hc labels hold. */
const heldSessions = (s) => new Set([...ledgerOf(s).map((x) => x.session),
  ...s.hcState().terminals.flatMap((x) => [x.labels?.["agent.session"], x.labels?.["revive.session"]])].filter((x) => typeof x === "string" && x.length >= 6));
/** Asserts no output `r` (stdout and stderr) holds any of `ids`. */
const noIdIn = (ids, r, what) => { for (const id of ids) assert.equal(`${r.out}${r.err}`.includes(id), false, `${what} printed a session id: ${r.out}${r.err}`); };

test("RFC 0021: no session id in any output: start, restart (resume, --fresh, --tree, a by-hand line, a refusal), history, worker", (t) => {
  // start and restart, --json and text.
  const s = scene(t);
  s.seed(team());
  const outs = [];
  outs.push(["start --json", s.cli(["start", "Genie", "--json"])]);
  outs.push(["restart --json", s.cli(["restart", "Genie", "--force", "--json"])]);
  outs.push(["restart", s.cli(["restart", "Genie", "--force"])]);
  outs.push(["restart --fresh", s.cli(["restart", "Genie", "--fresh", "--force"])]);
  outs.push(["history --json", s.cli(["history", "Genie", "--json"])]);
  outs.push(["history", s.cli(["history", "Genie"])]);
  for (const [what, r] of outs) { assert.equal(r.code, 0, `${what}: ${r.err}`); noIdIn(heldSessions(s), r, what); }
  assert.ok(heldSessions(s).size >= 2, "the sweep had ids to look for");
  // --tree, text and --json, a helper resumed by its revive.session id.
  const tree = treeScene(t).s;
  const tj = tree.cli(["restart", "Genie", "--tree", "--json"]);
  assert.equal(tj.code, 0, tj.err);
  noIdIn(heldSessions(tree), tj, "restart --tree --json");
  const tt = treeScene(t).s;
  const tx = tt.cli(["restart", "Genie", "--tree"]);
  noIdIn(heldSessions(tt), tx, "restart --tree");
  // A helper that can't run again: its by-hand line, --json and text.
  for (const json of [true, false]) {
    const hs = treeScene(t).s;
    const st = hs.hcState();
    st.failRun = ["rev-1"];
    writeFileSync(join(hs.root, "hc.json"), JSON.stringify(st));
    const r = hs.cli(["restart", "Genie", "--tree", ...(json ? ["--json"] : [])]);
    if (json) assert.ok(r.json().helpers.some((h) => h.by_hand), r.out);
    assert.match(r.err, /to run it again by hand/);
    assert.match(r.err, /put the id where \*\*\* stands/);
    noIdIn(heldSessions(hs), r, `a by-hand line${json ? " (--json)" : ""}`);
  }
  // A refusal naming two runs on one session.
  const twice = treeScene(t).s;
  const ts = twice.hcState();
  ts.terminals.find((x) => x.address === "t8").labels["revive.session"] = SID;
  writeFileSync(join(twice.root, "hc.json"), JSON.stringify(ts));
  const refused = twice.cli(["restart", "Genie", "--tree", "--json"]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /would all resume one session \(\*\*\*\)/);
  noIdIn(heldSessions(twice), refused, "the one-session refusal");
});

test("RFC 0021: an anchored ignore that already covers the ledger adds nothing to the exclude file and says nothing", (t) => {
  for (const ignore of ["/.herdr/app-home/automagik-herdr/workers.jsonl\n", "/.herdr/app-home/\n"]) {
    const { s, app, exclude } = projectHomeScene(t, { ignore });
    const r = s.cli(["start", "Genie"], { env: { HERDR_APP_HOME: app } });
    assert.equal(r.code, 0, r.err);
    assert.equal((existsSync(exclude) ? readFileSync(exclude, "utf8") : "").includes(".herdr/app-home"), false, ignore);
    assert.equal(/ignore|tracked by git/.test(r.err), false, r.err);
  }
});

test("RFC 0021: no session id in the codex provider-gone note, on stderr or in --json", (t) => {
  for (const json of [true, false]) {
    const s = captainScene(t, { agent: "codex", over: { foreground: { argv: ["codex", "resume", SID], cwd: "/p" }, argv: ["codex", "resume", SID],
      labels: { bot: ID.cap, "agent.session": SID } } });
    const st = s.hcState();
    writeFileSync(join(s.root, "hc.json"), JSON.stringify({ ...st, runQueue: [{ runAs: "exit", screen: CODEX_SCREEN }] }));
    const r = s.cli(["restart", "Captain", ...(json ? ["--json"] : [])]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /codex can't resume its thread \(\*\*\*\)/);
    noIdIn(new Set([SID]), r, `the provider-gone note${json ? " (--json)" : ""}`);
  }
});

test("cross-project lead (#850): create, edit, ls, show, brief and dsh-tui doctor support reciprocal --lead-project and --cross-member", (t) => {
  const s = scene(t);
  s.seed(team());

  // Create a second git project (spoke) under s.root.
  const spoke = join(s.root, "spoke");
  mkdirSync(spoke);
  git(spoke, "init", "-q");
  git(spoke, "commit", "-q", "--allow-empty", "-m", "start");

  // Create SpokeMain in spoke reporting to Genie in s.project via --lead and --lead-project.
  // Before Genie reciprocates with --cross-member, the CLI warns that the link is one-sided.
  const createdMain = s.cli([
    "create",
    "--project", spoke,
    "--kind", "main",
    "--name", "SpokeMain",
    "--agent", "claude",
    "--omni",
    "--lead", "Genie",
    "--lead-project", s.project,
    "--json",
  ]);
  assert.equal(createdMain.code, 0, createdMain.err);
  assert.match(createdMain.err, /is one-sided/);
  const spokeMainId = createdMain.json().id;
  assert.equal(createdMain.json().bot.lead, ID.main);
  assert.equal(createdMain.json().bot.leadProject, s.project);

  // Create SpokeMember in spoke reporting to Captain in s.project.
  const createdMem = s.cli([
    "create",
    "--project", spoke,
    "--name", "SpokeMember",
    "--agent", "claude",
    "--omni",
    "--lead", "Captain",
    "--lead-project", s.project,
    "--json",
  ]);
  assert.equal(createdMem.code, 0, createdMem.err);
  assert.match(createdMem.err, /is one-sided/);
  assert.equal(createdMem.json().bot.lead, ID.cap);
  assert.equal(createdMem.json().bot.leadProject, s.project);

  // While one-sided, dsh-tui doctor flags the lead checks as not ok (is one-sided).
  const docOneSided = s.cli(["dsh-tui", "doctor", "--project", spoke, "--json"]);
  const oneSidedChecks = docOneSided.json().checks.filter((c) => c.check.startsWith("lead:"));
  assert.equal(oneSidedChecks.length, 2);
  assert.equal(oneSidedChecks.every((c) => !c.ok && /is one-sided/.test(c.detail)), true);

  // Reciprocate from s.project on Genie and Captain via --cross-member <bot>@<dir>.
  const recGenie = s.cli(["edit", "Genie", "--project", s.project, "--cross-member", `SpokeMain@${spoke}`, "--json"]);
  assert.equal(recGenie.code, 0, recGenie.err);
  assert.equal(recGenie.err, "");
  assert.deepEqual(recGenie.json().bot.crossMembers, [{ id: spokeMainId, project: spoke }]);

  const recCap = s.cli(["edit", "Captain", "--project", s.project, "--cross-member", `SpokeMember@${spoke}`, "--json"]);
  assert.equal(recCap.code, 0, recCap.err);
  assert.equal(recCap.err, "");

  // Refusals: missing folder, folder with no .herdr/bots.json, missing bot, planned lead, or cross-project cycle.
  const missingDir = s.cli(["edit", "SpokeMember", "--project", spoke, "--lead", "Genie", "--lead-project", join(s.root, "nope")]);
  assert.equal(missingDir.code, 2);
  assert.match(missingDir.err, /is not a folder/);

  const noBotsDir = join(s.root, "empty-proj");
  mkdirSync(noBotsDir);
  const noBots = s.cli(["edit", "SpokeMember", "--project", spoke, "--lead", "Genie", "--lead-project", noBotsDir]);
  assert.equal(noBots.code, 1);
  assert.match(noBots.err, /No \.herdr\/bots\.json in/);

  const noSuchBot = s.cli(["edit", "SpokeMember", "--project", spoke, "--lead", "Nobody", "--lead-project", s.project]);
  assert.equal(noSuchBot.code, 1);
  assert.match(noSuchBot.err, /no bot "Nobody"/i);

  const plannedLead = s.cli(["edit", "SpokeMember", "--project", spoke, "--lead", "Studio", "--lead-project", s.project]);
  assert.equal(plannedLead.code, 1);
  assert.match(plannedLead.err, /planned/);

  // Cross-project cycle refusal: editing Captain in s.project to report to SpokeMember in spoke.
  const cycle = s.cli(["edit", "Captain", "--project", s.project, "--lead", "SpokeMember", "--lead-project", spoke]);
  assert.equal(cycle.code, 1);
  assert.match(cycle.err, /reports to Captain, so it can't be its lead/);

  // ls, show, brief, and dsh-tui doctor in spoke and s.project once reciprocal.
  const lsOut = s.cli(["ls", "--project", spoke]);
  assert.equal(lsOut.code, 0, lsOut.err);
  assert.match(lsOut.out, new RegExp(`main → Genie \\(${s.project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));
  assert.match(lsOut.out, new RegExp(`→ Captain \\(${s.project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));

  const showJson = s.cli(["show", "SpokeMain", "--project", spoke, "--json"]);
  assert.equal(showJson.code, 0, showJson.err);
  assert.equal(showJson.json().lead, ID.main);
  assert.equal(showJson.json().leadName, "Genie");
  assert.equal(showJson.json().leadProject, s.project);
  const showText = s.cli(["show", "SpokeMain", "--project", spoke]);
  assert.equal(showText.code, 0, showText.err);
  assert.match(showText.out, new RegExp(`lead\\s+Genie \\(${ID.main}\\) in ${s.project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

  const showGenie = s.cli(["show", "Genie", "--project", s.project]);
  assert.equal(showGenie.code, 0, showGenie.err);
  assert.match(showGenie.out, /cross members\s+SpokeMain/);

  const briefSpoke = s.cli(["brief", "SpokeMain", "--project", spoke]);
  assert.equal(briefSpoke.code, 0, briefSpoke.err);
  assert.match(briefSpoke.out, /Your lead: Genie \(bot b-aaaaaaaaaa\)/);

  const briefHub = s.cli(["brief", "Genie", "--project", s.project]);
  assert.equal(briefHub.code, 0, briefHub.err);
  assert.match(briefHub.out, new RegExp(`SpokeMain \\(bot ${spokeMainId}`));

  const doc = s.cli(["dsh-tui", "doctor", "--project", spoke, "--json"]);
  const docChecks = doc.json().checks.filter((c) => c.check.startsWith("lead:"));
  assert.equal(docChecks.length, 2);
  assert.equal(docChecks.every((c) => c.ok), true);

  // Clearing with --no-lead-project, --lead-project="", and --no-cross-members.
  const clearMain = s.cli(["edit", "SpokeMain", "--project", spoke, "--no-lead-project", "--json"]);
  assert.equal(clearMain.code, 0, clearMain.err);
  assert.equal(clearMain.json().bot.lead, undefined);
  assert.equal(clearMain.json().bot.leadProject, undefined);

  const clearMem = s.cli(["edit", "SpokeMember", "--project", spoke, "--lead-project=", "--json"]);
  assert.equal(clearMem.code, 0, clearMem.err);
  assert.equal(clearMem.json().bot.lead, undefined);
  assert.equal(clearMem.json().bot.leadProject, undefined);

  const clearGenieCm = s.cli(["edit", "Genie", "--project", s.project, "--no-cross-members", "--json"]);
  assert.equal(clearGenieCm.code, 0, clearGenieCm.err);
  assert.equal(clearGenieCm.json().bot.crossMembers, undefined);
});

test("#858: scratch helpers isolate TMPDIR inside a project with .git and .herdr/bots.json, warn once, and fail loudly on an unisolated folder", (t) => {
  const box = scratchRoot(t, "hb-858-");
  const outer = join(box, "outer");
  const nestedTmp = join(outer, ".tmp");
  mkdirSync(join(outer, ".herdr"), { recursive: true });
  mkdirSync(nestedTmp, { recursive: true });
  git(outer, "init", "-q");
  git(outer, "commit", "-q", "--allow-empty", "-m", "init");
  const outerBotsPath = join(outer, ".herdr/bots.json");
  const outerBefore = `${JSON.stringify({ version: 1, categories: [], bots: [bot(ID.main, "main", { name: "Outer" })] }, null, 2)}\n`;
  writeFileSync(outerBotsPath, outerBefore);

  const herdrOnly = join(box, "herdr-only");
  mkdirSync(join(herdrOnly, ".herdr"), { recursive: true });
  mkdirSync(join(herdrOnly, "tmp"), { recursive: true });
  writeFileSync(join(herdrOnly, ".herdr/bots.json"), outerBefore);

  const linkToNested = join(box, "linked-tmp");
  symlinkSync(nestedTmp, linkToNested);

  for (const [unsafeTmp, expectedOuter] of [[nestedTmp, outer], [join(herdrOnly, "tmp"), herdrOnly], [linkToNested, outer]]) {
    const lines = [];
    const line = warnTmpdir(unsafeTmp, { once: false, write: (s) => lines.push(s) });
    assert.equal(lines.length, 1);
    assert.equal(line.trim().split("\n").length, 1, "one-line warning");
    assert.match(line, new RegExp(`TMPDIR .*inside project/git folder ${expectedOuter}`));
    assert.match(line, /set TMPDIR to a folder outside every project folder \(for example TMPDIR=\/tmp\)/);
  }

  const prevTmp = process.env.TMPDIR;
  try {
    process.env.TMPDIR = nestedTmp;
    const s = scene(t);
    assert.equal(s.project.startsWith(nestedTmp), true, "scratch project lives under nested TMPDIR");
    const created = s.cli(["create", "--name", "Solo", "--agent", "claude", "--json"]);
    assert.equal(created.code, 0, created.err);
    assert.equal(created.json().project, s.project);
    const edited = s.cli(["edit", "Solo", "--role", "Inner role", "--json"]);
    assert.equal(edited.code, 0, edited.err);
    assert.equal(s.bots().bots[0].role, "Inner role");

    const sPlain = scene(t, { isGit: false });
    assert.equal(sPlain.project.startsWith(nestedTmp), true);
    const createdPlain = sPlain.cli(["create", "--name", "PlainSolo", "--agent", "claude", "--json"]);
    assert.equal(createdPlain.code, 0, createdPlain.err);
    assert.equal(createdPlain.json().project, sPlain.project);
  } finally {
    if (prevTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prevTmp;
  }

  const missedGit = join(nestedTmp, "missed-git");
  mkdirSync(missedGit, { recursive: true });
  assert.throws(
    () => assertScratchProject(missedGit, { ceiling: box, env: {} }),
    new RegExp(`^Error: Scratch project ${missedGit} resolved to outer project ${outer} instead of itself \\(#858\\)\\.$`),
  );

  const missedHerdr = join(herdrOnly, "tmp", "missed-herdr");
  mkdirSync(missedHerdr, { recursive: true });
  assert.throws(
    () => assertScratchProject(missedHerdr, { ceiling: join(herdrOnly, "tmp"), env: {} }),
    new RegExp(`^Error: Scratch project ${missedHerdr} resolved to outer project ${herdrOnly} instead of itself \\(#858\\)\\.$`),
  );

  assert.equal(readFileSync(outerBotsPath, "utf8"), outerBefore, "outer .herdr/bots.json is byte-identical");
  assert.equal(readFileSync(join(herdrOnly, ".herdr/bots.json"), "utf8"), outerBefore, "herdr-only .herdr/bots.json is byte-identical");
});

test("#858: non-git scratch folder stops at the scene ceiling and create --project reports a resolved parent project", (t) => {
  const s = scene(t);
  git(s.root, "init", "-q");
  const rootBotsPath = join(s.root, ".herdr/bots.json");
  const rootBefore = `${JSON.stringify({ version: 1, categories: [], bots: [bot(ID.main, "main", { name: "Outer" })] }, null, 2)}\n`;
  mkdirSync(join(s.root, ".herdr"), { recursive: true });
  writeFileSync(rootBotsPath, rootBefore);

  const plain = join(s.root, "plain");
  mkdirSync(plain);
  const solo = s.cli(["create", "--name", "Solo", "--agent", "claude", "--project", plain, "--json"]);
  assert.equal(solo.code, 0, solo.err);
  assert.equal(solo.json().project, plain);
  assert.equal(solo.err, "", "exact non-git --project emits no resolved-parent note");
  assert.equal(readFileSync(rootBotsPath, "utf8"), rootBefore, "outer root bots.json untouched");
  assert.ok(existsSync(join(plain, ".herdr/bots.json")));

  const sub = join(s.project, "sub");
  mkdirSync(sub);
  const resolved = s.cli(["create", "--name", "Genie", "--agent", "claude", "--project", sub, "--json"]);
  assert.equal(resolved.code, 0, resolved.err);
  assert.equal(resolved.json().project, s.project);
  assert.match(resolved.err, new RegExp(`saved in ${s.botsPath} \\(project ${s.project}, resolved from --project ${sub}\\)\\.`));

  const plainMode = s.cli(["create", "--name", "Member", "--agent", "claude", "--project", sub]);
  assert.equal(plainMode.code, 0, plainMode.err);
  assert.match(plainMode.out.trim(), /^b-[a-z2-7]{10}$/);
  assert.match(plainMode.err, new RegExp(`saved in ${s.botsPath} \\(project ${s.project}, resolved from --project ${sub}\\)\\.`));
});


test("#805 queued watchers stop on cancellation, replacement or a vanished/reused target", async (t) => {
  for (const change of ["cancel", "replace", "finished", "gone", "reused"]) {
    const s = restartScene(t, { status: "working" });
    assert.equal(s.cli(["restart", "Genie", "--json"]).code, 0);
    const file = join(s.app, "automagik-herdr/queued-restarts.json");
    const entry = JSON.parse(readFileSync(file))[0];
    if (["cancel", "replace"].includes(change)) {
      const running = s.cliAsync(["restart", ID.main, "--run-queued", entry.id]);
      // Wait for evidence that this watcher is polling before changing its queue.
      const until = Date.now() + 5000;
      while (at(s.calls(), "wait", "t5") < 0 && Date.now() < until) await new Promise((done) => setTimeout(done, 20));
      assert.ok(at(s.calls(), "wait", "t5") >= 0);
      const r = s.cli(change === "cancel" ? ["restart", "--cancel", "Genie"] : ["restart", "Genie"]);
      assert.equal(r.code, 0, r.err);
      const result = await running;
      assert.equal(result.code, 0, result.err);
      assert.equal(at(s.calls(), "kill", "t5"), -1);
      assert.equal(JSON.parse(readFileSync(file)).length, change === "replace" ? 1 : 0);
    } else {
      const state = s.hcState();
      if (change === "gone") state.terminals = state.terminals.filter((p) => p.address !== "t5");
      else if (change === "finished") state.terminals[0].state = "finished";
      else state.terminals[0].created_ms += 1;
      writeFileSync(join(s.root, "hc.json"), JSON.stringify(state));
      if (change === "finished") assert.deepEqual(s.cli(["restart", "--queued", "--json"]).json(), { queued: [] });
      const r = s.cli(["restart", ID.main, "--run-queued", entry.id]);
      assert.equal(r.code, 0, r.err);
      assert.equal(at(s.calls(), "kill", "t5"), -1);
      assert.deepEqual(JSON.parse(readFileSync(file)), []);
    }
  }
});

test("#805 a busy parent's doomed helpers still refuse before queueing", (t) => {
  const worker = { ...term("t7", { parent: "t5" }), die_with_parent: true };
  const s = restartScene(t, { status: "working", extra: [worker] });
  const r = s.cli(["restart", "Genie", "--json"]);
  assert.equal(r.code, 1);
  assert.equal(r.json().refused, "helpers");
  assert.equal(runCall(s.calls()), undefined);
});
