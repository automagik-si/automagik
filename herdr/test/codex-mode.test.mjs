// One Codex launch mode (#1125, the owner's ruling of 10 and 12 Nov): every Codex seat and every
// worker the pack builds runs `--approve-for-me` with the sandbox on, `--no-daemon` (hc --skill:
// else its commands run in Codex's shared server, outside hc) and the sandbox's network access,
// plus an `--add-dir` for each folder the launch derives (its git common dir, herdr-core's state
// and data folders, the tool caches), never the home folder or a whole XDG folder. A source's own
// approval and sandbox words are left out by name; an hc worker template keeps its own command
// (the owner's exception), a seat never runs a template's bypass, and Restart --tree keeps the
// exception only for a template worker. hc's not_found (exit 3) is the one answer that reads as a
// missing pane. Scratch projects and a fake hc only: the real hc, Codex and window are never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AGENTS, CODEX_MODE_ARGS, CODEX_NETWORK, absPath, cleanPath, codexClean, codexGrantPlan, codexGrantPaths, codexCleanNote, codexDirAllowed,
  codexDirVerdict, codexGrants, codexKeepDirs, codexWhere, codexWithheldWarning, homeWide, launchRun, withCodexGrants, withoutBriefing }
  from "../mods/am-sidebar/models.js";
import { helperPlan, restartPlan } from "../mods/am-sidebar/restart.js";
import { codexCommandCheck, codexForwards, codexTemplateRefusal, codexTemplateWarning, workerPlan } from "../mods/am-sidebar/workers.js";
import { IDENTITY_PROBE, RESOLVE_PROBE, canonHere, dirHere, idHere, idsThere, resolvedThere } from "../mods/am-sidebar/bin/automagik-herdr.mjs";
import { readJsonLines } from "./log-lines.mjs";
import { scratchProject, scratchRoot } from "./scratch-project.mjs";

const CLI = new URL("../mods/am-sidebar/bin/automagik-herdr.mjs", import.meta.url).pathname;
const FAKE_HC = new URL("./fake-hc.mjs", import.meta.url).pathname;
const MODE = [...CODEX_MODE_ARGS];
const ID = { main: "b-aaaaaaaaaa", dev: "b-cccccccccc" };
const exe = (path, text) => { writeFileSync(path, text); chmodSync(path, 0o755); };
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
const count = (words, w) => words.filter((x) => x === w).length;
// The flags that turn Codex's sandbox or approvals off: none may reach a seat or an ordinary worker.
const BYPASS = ["--dangerously-bypass-approvals-and-sandbox", "--yolo"];
// TEST-ONLY synthetic identity observer (#1142), for fixture paths that are on no disk ("/home/u",
// "/r/.git"): each distinct path its own numeric dev:ino, so only the path rules decide. It proves
// nothing about a real filesystem; the #1142 tests on real folders observe them with idHere and
// IDENTITY_PROBE instead.
const MODEL_IDS = new Map();
const MODEL_ID = (p) => { if (!MODEL_IDS.has(p)) MODEL_IDS.set(p, MODEL_IDS.size + 1); return `1:${MODEL_IDS.get(p)}`; };
const modelWhere = (opts) => codexWhere({ ...opts, id: MODEL_ID });
// The launch's one withheld warning (#1142), word for word: every folder withheld, or some of them.
const ALL_WITHHELD = "Codex extra folders withheld: the pack cannot prove they are outside the Herdr app home. It passes no additional folder "
  + "grants; writes outside permitted locations may require automatic review or fail. See #1151.";
const someWithheld = (n) => `Codex extra folders withheld: the pack cannot prove ${n} of them are outside the Herdr app home and passes no grant `
  + "for those; writes outside permitted locations may require automatic review or fail. See #1151.";

// ---- the source's own words (codexClean) ----

test("codexClean leaves out every approval and sandbox form it knows, by flag name, and keeps every other word", () => {
  const home = "/home/u";
  const cases = [
    [["--dangerously-bypass-approvals-and-sandbox"], "--dangerously-bypass-approvals-and-sandbox"],
    [["--yolo"], "--yolo"],
    [["-a", "never"], "-a"], [["-anever"], "-a"], [["-a=never"], "-a"],
    [["--ask-for-approval", "never"], "--ask-for-approval"], [["--ask-for-approval=on-request"], "--ask-for-approval"],
    [["-s", "danger-full-access"], "-s"], [["-sdanger-full-access"], "-s"], [["--sandbox", "read-only"], "--sandbox"],
    [["--sandbox=danger-full-access"], "--sandbox"],
    [["-c", 'sandbox_mode="danger-full-access"'], "-c sandbox_mode"], [["--config", 'approval_policy="never"'], "-c approval_policy"],
    [['--config=approvals_reviewer="user"'], "-c approvals_reviewer"], [['-csandbox_mode="danger-full-access"'], "-c sandbox_mode"],
    // codex-cli 0.167.0: this one overrides --approve-for-me (the effective sandbox becomes danger-full-access).
    [["-c", 'default_permissions=":danger-full-access"'], "-c default_permissions"],
    [['-cdefault_permissions=":danger-full-access"'], "-c default_permissions"],
    [['--config=default_permissions=":danger-full-access"'], "-c default_permissions"],
    [["-c", 'permission_profile="full"'], "-c permission_profile"], [["-c", "permissions.p.network.enabled=true"], "-c permissions"],
    [["-c", "sandbox_workspace_write.network_access=false"], "-c sandbox_workspace_write"],
    [["-c", 'sandbox_workspace_write.writable_roots=["/"]'], "-c sandbox_workspace_write"],
    [["--remote", "unix:///x.sock"], "--remote"], [["--remote=ws://h:1"], "--remote"], [["--remote-auth-token-env", "T"], "--remote-auth-token-env"],
    [["--add-dir", "/"], "--add-dir"], [["--add-dir", home], "--add-dir"], [["--add-dir=/home"], "--add-dir"],
  ];
  for (const [words, name] of cases) {
    const { argv, dropped } = codexClean(["codex", ...words, "-m", "gpt-6"], home);
    assert.deepEqual(argv, ["codex", "-m", "gpt-6"], `${words.join(" ")} is left out`);
    assert.deepEqual(dropped, [name], `${words.join(" ")} is named ${name}`);
  }
  // Unrelated words stay as written, a value that looks like a flag included; the pack's own words go quietly.
  const kept = ["codex", "-m", "-a", "-c", 'model="o3"', "--profile", "p", "--add-dir", "/srv/cache", "--enable", "x", "--disable", "hooks",
    "-C", "/w", "--worktree"];
  // #1142: an --add-dir is kept only when its observations prove it (here the test-only model observer).
  assert.deepEqual(codexClean([...kept, "--approve-for-me", "--no-daemon", "-c", CODEX_NETWORK], modelWhere({ home })),
    { argv: kept, dropped: [], unproved: [] });
  // Without observations it is withheld and counted for the launch's warning, never named as left out.
  assert.deepEqual(codexClean(["codex", "--add-dir", "/srv/cache", "-m", "x"], home), { argv: ["codex", "-m", "x"], dropped: [], unproved: ["/srv/cache"] });
  // After `--` nothing is a flag.
  assert.deepEqual(codexClean(["codex", "--", "-a", "--yolo"], home), { argv: ["codex", "--", "-a", "--yolo"], dropped: [], unproved: [] });
});

test("codexCleanNote names flags only, never a value", () => {
  const note = codexCleanNote(["codex", "-a", "never", "-c", 'default_permissions=":danger-full-access"', "--add-dir", "/home/u",
    "--sandbox=danger-full-access", "--remote", "unix:///home/u/s.sock"], "/home/u");
  assert.match(note, /-a, -c default_permissions, --add-dir, --sandbox, --remote: left out/);
  for (const value of ["never", "danger-full-access", "/home/u", "unix:"]) assert.equal(note.includes(value), false, value);
  assert.equal(codexCleanNote(["codex", "-m", "x"]), null);
});

// Config keys written in another valid TOML spelling were kept (#1125): a key is read by its
// meaning. `text` is a config word whose key is `name`; its value is a harmless placeholder.
function sameConfigKey(text, name, value) {
  for (const words of [["-c", text], ["--config", text], [`--config=${text}`], [`-c${text}`]]) {
    const { argv, dropped } = codexClean(["codex", ...words, "-m", "gpt-6"], "/home/u");
    assert.deepEqual(argv, ["codex", "-m", "gpt-6"], `${words.join(" ")} is left out`);
    assert.deepEqual(dropped, [`-c ${name}`], `${words.join(" ")} is named -c ${name}`);
  }
  const note = codexCleanNote(["codex", "-c", text]);
  assert.ok(note.includes(`names -c ${name}: left out`), note);
  assert.equal(note.includes(value), false, "the note never names the value");
}

// A config word kept as written, in every word form: `text` names no listed key.
function keptConfig(text) {
  for (const words of [["-c", text], ["--config", text], [`--config=${text}`], [`-c${text}`]]) {
    assert.deepEqual(codexClean(["codex", ...words, "-m", "gpt-6"], "/home/u"), { argv: ["codex", ...words, "-m", "gpt-6"], dropped: [], unproved: [] },
      `${words.join(" ")} is kept`);
  }
}

test("codexClean reads a config key with spaces around its dot as the same key (the network word so spelled too)", () => {
  sameConfigKey('sandbox_workspace_write . writable_roots=["/tmp/placeholder"]', "sandbox_workspace_write", "/tmp/placeholder");
  sameConfigKey("sandbox_workspace_write\t.  writable_roots = []", "sandbox_workspace_write", "[]");
  // The pack's network word goes quietly only as written; spelled so it is named, and launchRun adds the exact one.
  const spaced = "sandbox_workspace_write . network_access=true";
  assert.deepEqual(codexClean(["codex", "-c", spaced]).dropped, ["-c sandbox_workspace_write"]);
  const argv = launchRun("codex", ["codex", "-c", spaced], {});
  assert.equal(argv.includes(spaced), false);
  assert.equal(count(argv, CODEX_NETWORK), 1);
  assert.deepEqual(argv.slice(-MODE.length), MODE);
});

test("codexClean reads a double-quoted config key part as the same key", () => {
  sameConfigKey('"sandbox_workspace_write".writable_roots=["/tmp/placeholder"]', "sandbox_workspace_write", "/tmp/placeholder");
  sameConfigKey(' "sandbox_workspace_write" . "writable_roots" = []', "sandbox_workspace_write", "[]");
});

test("codexClean reads a single-quoted (literal) config key part as the same key", () => {
  sameConfigKey("'sandbox_workspace_write'.writable_roots=[\"/tmp/placeholder\"]", "sandbox_workspace_write", "/tmp/placeholder");
  sameConfigKey("'approval_policy'=\"on-request\"", "approval_policy", "on-request");
});

test("codexClean reads a config key written with a basic-string escape as the same key", () => {
  sameConfigKey('"sandbox\\u005Fmode"="read-only"', "sandbox_mode", "read-only");
  sameConfigKey('"sandbox\\U0000005fmode"="read-only"', "sandbox_mode", "read-only");
  sameConfigKey('"default_\\u0070ermissions"="read-only"', "default_permissions", "read-only");
  // A key whose quotes don't close is read as before: its raw text, one outer quote off.
  sameConfigKey('"sandbox_mode=read-only', "sandbox_mode", "read-only");
  // Another key stays as written, escapes and all.
  assert.deepEqual(codexClean(["codex", "-c", '"mod\\u0065l"="o3"']).argv, ["codex", "-c", '"mod\\u0065l"="o3"']);
});

test("codexClean drops a bare listed key followed by a part whose quote never closes", () => {
  sameConfigKey('sandbox_mode . "x=read-only', "sandbox_mode", "read-only");
  sameConfigKey("sandbox_mode\t.\t\"x=read-only", "sandbox_mode", "read-only");
  sameConfigKey("sandbox_workspace_write . 'writable_roots=[]", "sandbox_workspace_write", "[]");
});

test("codexClean drops a quoted listed key followed by a part whose quote never closes", () => {
  sameConfigKey("\"sandbox_mode\" . 'x=read-only", "sandbox_mode", "read-only");
  sameConfigKey("'sandbox_mode'.\"x=read-only", "sandbox_mode", "read-only");
  sameConfigKey('"sandbox_workspace_write"\t.\t"writable_roots=[]', "sandbox_workspace_write", "[]");
});

test("codexClean reads a config key written with TOML 1.1's \\xHH escape as the same key", () => {
  sameConfigKey('"sandbox\\x5fmode"="read-only"', "sandbox_mode", "read-only");
  sameConfigKey('"default_\\x70ermissions"="read-only"', "default_permissions", "read-only");
  sameConfigKey('"sandbox\\x5Fmode" . x = "read-only"', "sandbox_mode", "read-only");
  // Another key stays as written, escapes and all.
  assert.deepEqual(codexClean(["codex", "-c", '"mod\\x65l"="o3"']).argv, ["codex", "-c", '"mod\\x65l"="o3"']);
});

test("codexClean decodes the escapes of a listed key whose first (double) quote never closes", () => {
  sameConfigKey('"sandbox\\x5fmode=read-only', "sandbox_mode", "read-only");
  sameConfigKey('"sandbox\\x5Fmode=read-only', "sandbox_mode", "read-only");
  sameConfigKey('"default_\\u0070ermissions=read-only', "default_permissions", "read-only");
  sameConfigKey('"sandbox\\U0000005fmode . x=read-only', "sandbox_mode", "read-only");
  // Its parts are trimmed, as TOML's are: spaces around its dot or inside its open quote.
  sameConfigKey('"sandbox_mode . x=read-only', "sandbox_mode", "read-only");
  sameConfigKey('" sandbox_mode=read-only', "sandbox_mode", "read-only");
  // Another key so written stays as written; a key opening with a single quote is literal: nothing decoded.
  keptConfig('"mod\\x65l=o3');
  keptConfig('"mod\\u0065l=o3');
  keptConfig("'sandbox\\x5fmode=read-only");
});

// A listed key under a profile (the 1142 known limit): `--profile <name>` applies it, so it goes too,
// named `-c profiles.*.<key>`, never by the profile's name or its value.
test("codexClean drops a listed key under a profile, in every spelling, named without the profile", () => {
  sameConfigKey('profiles.p.sandbox_mode="read-only"', "profiles.*.sandbox_mode", "read-only");
  sameConfigKey('profiles . p\t.  sandbox_mode = "read-only"', "profiles.*.sandbox_mode", "read-only");
  sameConfigKey('"profiles"."p".\'sandbox_mode\'="read-only"', "profiles.*.sandbox_mode", "read-only");
  sameConfigKey('profiles.p."sandbox\\x5fmode"="read-only"', "profiles.*.sandbox_mode", "read-only");
  sameConfigKey('profiles.p."approval\\u005Fpolicy"="on-request"', "profiles.*.approval_policy", "on-request");
  sameConfigKey('profiles."p\\u002Eq".default_permissions="read-only"', "profiles.*.default_permissions", "read-only");
  sameConfigKey('profiles.p.sandbox_workspace_write.writable_roots=["/tmp/placeholder"]', "profiles.*.sandbox_workspace_write",
    "/tmp/placeholder");
  sameConfigKey("profiles.p.permissions.x.network.enabled=false", "profiles.*.permissions", "false");
  sameConfigKey('profiles.p.permission_profile="read-only"', "profiles.*.permission_profile", "read-only");
  sameConfigKey('profiles.p.approvals_reviewer="user"', "profiles.*.approvals_reviewer", "user");
  // A later quote that never closes: the parts before it.
  sameConfigKey('profiles.p.sandbox_mode . "x=read-only', "profiles.*.sandbox_mode", "read-only");
  // A first quote that never closes: the raw reading, its escapes decoded.
  sameConfigKey('"profiles.p.sandbox_mode=read-only', "profiles.*.sandbox_mode", "read-only");
  sameConfigKey('"profiles . p . sandbox\\x5fmode=read-only', "profiles.*.sandbox_mode", "read-only");
  // A profile name holding a quote TOML reads on past the `=`: Codex's own split (the raw reading) names the key.
  sameConfigKey('profiles.p".sandbox_mode=read-only".x=1', "profiles.*.sandbox_mode", "read-only");
  // The note names no profile.
  const note = codexCleanNote(["codex", "-c", 'profiles.pq.sandbox_mode="read-only"', "-c", 'profiles."pq".approval_policy="on-request"']);
  assert.ok(note.includes("names -c profiles.*.sandbox_mode, -c profiles.*.approval_policy: left out"), note);
  assert.equal(note.includes("pq"), false, "the note never names the profile");
});

test("codexClean drops profiles or one profile set whole (a table that can hold any listed key), named -c profiles", () => {
  sameConfigKey('profiles={p={model="o3"}}', "profiles", "o3");
  sameConfigKey('profiles.p={model="o3"}', "profiles", "o3");
  sameConfigKey(' "profiles" . \'p\' = {}', "profiles", "{}");
  sameConfigKey("profiles . \"p.sandbox_mode=read-only", "profiles", "read-only");
  sameConfigKey('"profiles . p={}', "profiles", "{}");
});

test("codexClean keeps a profile's other keys as written", () => {
  keptConfig('profiles.p.model="o3"');
  keptConfig('profiles . "p" . model = "o3"');
  keptConfig('profiles.p.model_reasoning_effort="low"');
  keptConfig('"profiles.p.model=o3');
  keptConfig('profiles.p.model . "x=o3');
  keptConfig('model="profiles.p.sandbox_mode"');
});

test("launchRun: a Codex run always ends in the launch mode, each word once, before a `--`, whatever its source or codexAuto says", () => {
  for (const run of [["codex"], ["codex", "--approve-for-me"], ["codex", "--no-daemon", "--approve-for-me", "-c", CODEX_NETWORK],
    ["codex", "--dangerously-bypass-approvals-and-sandbox"], ["codex", "-a", "never", "-s", "workspace-write"], ["/opt/codex", "--yolo"]]) {
    for (const bot of [{}, { codexAuto: false }, { codexAuto: true }]) {
      const argv = launchRun("codex", run, bot);
      assert.deepEqual(argv.slice(-MODE.length), MODE, run.join(" "));
      for (const w of ["--approve-for-me", "--no-daemon"]) assert.equal(count(argv, w), 1, `${w} once: ${run.join(" ")}`);
      assert.deepEqual(argv.filter((w) => BYPASS.includes(w) || ["-a", "-s"].includes(w)), [], run.join(" "));
    }
  }
  assert.deepEqual(launchRun("codex", ["codex", "-m", "x", "--", "task"], {}), ["codex", "-m", "x", ...MODE, "--", "task"]);
  // Only Codex: another agent's run is as before.
  assert.deepEqual(launchRun("claude", ["claude"], { codexAuto: false }), ["claude", "--permission-mode", "auto"]);
});

test("--no-daemon and the network word survive every restart shape, the worker plan and a tree helper's rebuild", () => {
  const bot = { id: ID.main, name: "Genie", agent: "codex", model: "gpt-6" };
  const run = launchRun("codex", ["codex", "--yolo"], bot);
  const shapes = {
    resume: restartPlan({ bot, run, runningAgent: "codex", session: "s-1" }),
    fresh: restartPlan({ bot, run, runningAgent: "codex", fresh: true }),
    swapModel: restartPlan({ bot, run, runningAgent: "codex", model: "gpt-7" }),
    swapAgent: restartPlan({ bot: { ...bot, agent: "claude" }, run, runningAgent: "claude", agent: "codex" }),
    worker: { argv: workerPlan({ ...bot, agent: "claude" }, { agent: "codex" }).argv },
    helper: helperPlan({ get: { address: "t7", cwd: "/w", argv: ["codex", "--yolo"], foreground: { argv: ["codex", "--yolo"], cwd: "/w" } },
      worker: { agent: "codex", worktree: "/w" }, agents: AGENTS, bot }),
  };
  for (const [name, p] of Object.entries(shapes)) {
    assert.deepEqual(p.argv.slice(1, 1 + MODE.length), MODE, name);
    // Spelled out, not read from the table: hc requires --no-daemon (hc --skill), and the network word with it.
    assert.equal(count(p.argv, "--no-daemon"), 1, `${name}: --no-daemon`);
    assert.equal(p.argv.includes("sandbox_workspace_write.network_access=true"), true, `${name}: network on`);
    assert.deepEqual(p.argv.filter((w) => BYPASS.includes(w)), [], name);
  }
  assert.deepEqual(shapes.resume.argv.slice(1 + MODE.length), ["resume", "s-1", "--model", "gpt-6"]);
});

// ---- the folders a launch may write (codexGrants, withCodexGrants) ----

test("codexGrants: the git dirs, herdr-core's state and data folders and the tool caches, from the environment, only when there", () => {
  const home = "/home/u";
  const there = new Set(["/r/.git/worktrees/w", "/r/.git", "/x/state/herdr-core", "/home/u/.local/share/herdr-core", "/home/u/go/pkg/mod", "/home/u/.cache/go-build",
    "/home/u/.npm", "/home/u/.local/share/pnpm/store", "/home/u/.cache/pnpm", "/home/u/.bun/install/cache"]);
  const env = { XDG_STATE_HOME: "/x/state" };
  // These paths are on no disk: the test-only model observer stands for the launch machine's observations.
  const where = modelWhere({ home });
  assert.deepEqual(codexGrants({ where, env, gitDir: "/r/.git/worktrees/w", gitCommonDir: "/r/.git", isDir: (d) => there.has(d) }), [...there]);
  // A main checkout's git dir is its common dir: granted once.
  assert.deepEqual(codexGrants({ where, env, gitDir: "/r/.git", gitCommonDir: "/r/.git", isDir: (d) => d === "/r/.git" }), ["/r/.git"]);
  // Only what is there; no git dir when there is none.
  assert.deepEqual(codexGrants({ where, env: {}, gitCommonDir: null, isDir: (d) => d === "/home/u/.npm" }), ["/home/u/.npm"]);
  // The environment names each cache; a relative XDG value is ignored for its default (the XDG rule).
  const named = { GOMODCACHE: "/m", GOCACHE: "/b", npm_config_cache: "/n", BUN_INSTALL_CACHE_DIR: "/c", XDG_DATA_HOME: "rel" };
  assert.deepEqual(codexGrants({ where, env: named, isDir: () => true }).filter((d) => !d.includes("herdr-core") && !d.includes("pnpm")),
    ["/m", "/b", "/n", "/c"]);
  // #1142, each candidate on its own: a general folder whose place can't be proved (a .. with no resolver) withholds only
  // the candidate under it, counted; the others are granted.
  assert.deepEqual(codexGrantPlan({ where, env: { ...named, XDG_CACHE_HOME: "/q/../q" }, isDir: () => true }), {
    dirs: ["/home/u/.local/state/herdr-core", "/home/u/.local/share/herdr-core", "/m", "/b", "/n", "/home/u/.local/share/pnpm/store", "/c"],
    unproved: ["/q/../q/pnpm"] });
  // Without observations nothing is proved: every derived folder there is withheld and counted.
  const blind = codexGrantPlan({ home, env: named, isDir: () => true });
  assert.deepEqual(blind.dirs, []);
  assert.equal(blind.unproved.length, codexGrantPaths({ home, env: named }).candidates.length);
});

test("codexGrants never grants the root, the home folder, a folder above it, or a whole XDG, cache, GOPATH or Bun folder", () => {
  const home = "/home/u";
  const wide = { GOMODCACHE: home, GOCACHE: "/", npm_config_cache: "/home", BUN_INSTALL_CACHE_DIR: `${home}/.cache`,
    XDG_STATE_HOME: home, XDG_DATA_HOME: "/", GOPATH: `${home}/.local` };
  const got = codexGrants({ where: modelWhere({ home }), env: wide, gitDir: home, gitCommonDir: "/", isDir: () => true });
  assert.ok(got.length > 0, "the narrow ones are still granted: this checks something");
  for (const d of got) {
    assert.equal(homeWide(d, home), false, d);
    for (const general of [`${home}/.cache`, `${home}/.local`, `${home}/.local/share`, `${home}/.local/state`, `${home}/.config`, `${home}/go`, `${home}/.bun`]) {
      assert.notEqual(d, general, d);
    }
  }
  assert.equal(got.includes("/"), false);
  assert.equal(homeWide("/home/u/.npm", home), false);
  assert.equal(homeWide("/home", home), true);
});

test("withCodexGrants puts each --add-dir right after the mode words: before resume and the task; nothing without them", () => {
  const argv = [...launchRun("codex", ["codex"], {}), "resume", "--last", "-m", "x"];
  assert.deepEqual(withCodexGrants(argv, ["/r/.git", "/c"]), ["codex", ...MODE, "--add-dir", "/r/.git", "--add-dir", "/c", "resume", "--last", "-m", "x"]);
  assert.deepEqual(withCodexGrants(argv, []), argv);
  const shell = ["sh", "-c", 'codex --yolo "$@"', "sh", "resume"];
  assert.deepEqual(withCodexGrants(shell, ["/r/.git"]), shell, "a template's command is never rewritten");
  assert.deepEqual(withCodexGrants(["claude", "--permission-mode", "auto"], ["/r/.git"]), ["claude", "--permission-mode", "auto"]);
});

// ---- templates: read, never rewritten ----

test("codexCommandCheck reads a template's Codex words; the --no-daemon warning names the template and the fix", () => {
  const full = `codex --approve-for-me --disable hooks --no-daemon -c ${CODEX_NETWORK} -m x`;
  assert.deepEqual(codexCommandCheck(full), { conflicts: [], missing: [], lost: [], forwards: true, single: true });
  assert.deepEqual(codexCommandCheck("A=1 codex -m x"), { conflicts: [], missing: MODE, lost: [], forwards: true, single: true });
  // #1142: env is a program run before Codex, not one of the forms codexForwards proves.
  assert.equal(codexCommandCheck("env A=1 codex -m x").forwards, false);
  assert.deepEqual(codexCommandCheck("codex --no-daemon --dangerously-bypass-approvals-and-sandbox -a never").conflicts,
    ["--dangerously-bypass-approvals-and-sandbox", "-a"]);
  assert.equal(codexCommandCheck('sh -c "codex --approve-for-me"').single, false, "words after an outer sh -c never reach codex");
  assert.equal(codexCommandCheck("codex -m a; codex -m b").single, false);
  assert.equal(codexCommandCheck("claude --model x"), null);
  assert.equal(codexCommandCheck("codex x; claude y"), null, "two agents: not read as Codex's");
  // The local template before t1wb's fix: workspace-write, approval never, no --no-daemon.
  const local = "codex --sandbox workspace-write --ask-for-approval never -c sandbox_workspace_write.network_access=true --add-dir /r/.git";
  assert.match(codexTemplateWarning("codex-worker", local), /^Template codex-worker runs Codex without --no-daemon.*Add --no-daemon/);
  assert.equal(codexTemplateWarning("mac-dev", "codex --no-daemon --dangerously-bypass-approvals-and-sandbox -m x"), null,
    "the owner's bypass template: no warning, no refusal");
  assert.equal(codexTemplateWarning("rev", "claude --model x"), null);
});

test("a seat's Codex template: kept with the words it lacks and the grants through \"$@\", or set aside by flag name", () => {
  const bot = { agent: "codex" };
  const run = launchRun("codex", ["codex"], bot);
  const plan = (command, extra = {}) => restartPlan({ bot, run, runningAgent: "codex", session: "s-1",
    template: { name: "seat-tpl", command }, grants: ["/r/.git"], ...extra });
  // Compliant, words missing: the template's command, then the missing mode words, the grants, the resume.
  const kept = plan("codex -m x");
  assert.deepEqual(kept.argv, ["sh", "-c", 'codex -m x "$@"', "sh", ...MODE, "--add-dir", "/r/.git", "resume", "s-1"]);
  assert.deepEqual([kept.template, kept.granted, kept.templateNote], ["seat-tpl", true, null]);
  // Compliant and complete: only the grants and the resume.
  const full = plan(`codex --approve-for-me --disable hooks --no-daemon -c ${CODEX_NETWORK}`);
  assert.deepEqual(full.argv.slice(4), ["--add-dir", "/r/.git", "resume", "s-1"]);
  // The owner's worker bypass never reaches a seat: the agent row, and a note with flag names only.
  const bypass = plan("codex --no-daemon --dangerously-bypass-approvals-and-sandbox -s danger-full-access");
  assert.deepEqual([bypass.template, bypass.granted], [null, false]);
  assert.deepEqual(bypass.argv, [...run, "resume", "s-1"]);
  assert.match(bypass.templateNote, /template seat-tpl names --dangerously-bypass-approvals-and-sandbox, -s, so it started from its agent row/);
  assert.equal(bypass.templateNote.includes("danger-full-access"), false, "a flag's value is never printed");
  // One that can't take words after it (an outer sh -c, a trailing comment) is set aside too.
  for (const command of ['sh -c "codex -m x"', "codex -m x # pinned"]) {
    const p = plan(command);
    assert.deepEqual([p.template, p.argv.slice(0, run.length)], [null, run], command);
    assert.match(p.templateNote, /can't pass the pack's Codex words to Codex as options/);
  }
  // Another agent's template is as before (#213).
  const claude = restartPlan({ bot: { agent: "claude" }, run: ["claude"], runningAgent: "claude", template: { name: "c", command: "claude --x" }, fresh: true });
  assert.deepEqual([claude.template, claude.templateNote], ["c", null]);
});

test("Restart --tree keeps the template exception only for a template worker; seats' helpers and other panes run the launch mode", () => {
  const bypassShell = "codex --dangerously-bypass-approvals-and-sandbox -m x";
  const get = (labels, extra = {}) => ({ address: "t7", name: "w7", cwd: "/w", labels, argv: ["sh", "-c", bypassShell],
    foreground: { argv: ["codex", "--dangerously-bypass-approvals-and-sandbox", "-m", "x"], cwd: "/w" }, ...extra });
  const base = { agents: AGENTS, bot: { agent: "codex" }, grants: ["/r/.git"] };
  // A template worker (its worker.template label, or its ledger row): its command as it is, the bypass kept.
  for (const [labels, worker] of [[{ "worker.of": ID.dev, "worker.template": "mac-dev" }, null], [{ "worker.of": ID.dev }, { agent: null, template: "mac-dev", worktree: "/w" }]]) {
    const p = helperPlan({ ...base, get: get(labels), worker });
    assert.equal(p.error, undefined);
    assert.deepEqual(p.argv.slice(0, 3), ["sh", "-c", `${bypassShell} "$@"`]);
    assert.match(p.warning, /without --no-daemon/, "named, never refused");
  }
  // The same command on a pane that isn't a template worker (hc's own template record alone, or no label): refused by flag name.
  for (const g of [get({}, { template: "mac-dev" }), get({ "worker.of": ID.dev }, { template: "mac-dev" }), get({})]) {
    const p = helperPlan({ ...base, get: g });
    assert.match(p.error, /can't be run again: its command runs Codex with --dangerously-bypass-approvals-and-sandbox/);
    assert.equal(p.error.includes("-m x"), false);
  }
  // A plain Codex pane (an argv command, not a template): rebuilt in the launch mode, its bypass named and gone.
  const plain = helperPlan({ ...base, get: { address: "t8", name: "h8", cwd: "/w", labels: {}, argv: ["codex", "--yolo", "-m", "x"],
    foreground: { argv: ["codex", "--yolo", "-m", "x"], cwd: "/w" } } });
  assert.deepEqual(plain.argv, ["codex", "-m", "x", ...MODE, "--add-dir", "/r/.git", "resume", "--last"]);
  assert.match(plain.warning, /h8's command named --yolo: left out/);
  // An ordinary worker: rebuilt from its row in the launch mode, with the grants.
  const worker = helperPlan({ ...base, get: get({ "worker.of": ID.dev }), worker: { agent: "codex", worktree: "/w" } });
  assert.deepEqual(worker.argv, ["codex", ...MODE, "--add-dir", "/r/.git", "resume", "--last"]);
  // A compliant shell pane that isn't a template worker: its command, the missing words and grants after it.
  const shell = helperPlan({ ...base, get: { ...get({}), argv: ["sh", "-c", "codex -m x"], foreground: { argv: ["codex", "-m", "x"], cwd: "/w" } } });
  assert.deepEqual(shell.argv, ["sh", "-c", 'codex -m x "$@"', "sh", ...MODE, "--add-dir", "/r/.git", "resume", "--last"]);
});

// ---- #1142: the folder policy, resolved where the launch runs ----

/** A scratch tree standing for a launch's machine: its home, its app home, ordinary folders, links and a file. */
function tree(t) {
  const root = realpathSync(scratchRoot(t, "hb-1142-"));
  const home = join(root, "home"), app = join(home, ".config/herdr-app");
  for (const d of [join(app, "sub"), join(app, "pnpm"), join(home, "work"), join(home, ".config/other"), join(home, ".npm"), join(root, "shared"),
    join(root, "state/herdr-core")]) mkdirSync(d, { recursive: true });
  symlinkSync(home, join(root, "to-home"));
  symlinkSync(app, join(root, "to-app"));
  symlinkSync(join(root, "nowhere"), join(root, "dangling"));
  writeFileSync(join(root, "file"), "x");
  return { root, home, app };
}
/** RESOLVE_PROBE run by a real sh over `paths` (as codexOn sends them: cleanPath), read back by resolvedThere: how that machine resolves each. */
const probe = (paths) => {
  const r = spawnSync("sh", ["-c", RESOLVE_PROBE, "sh", ...[...new Set(paths.map(cleanPath).filter(Boolean))]], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return resolvedThere(r.stdout);
};
/** Canonical `p` and each folder above it, up to the root. */
const chainOf = (p) => { const out = []; for (let c = p; ; c = c.slice(0, c.lastIndexOf("/")) || "/") { out.push(c); if (c === "/") return out; } };
/** IDENTITY_PROBE run by a real sh on `paths` and every folder above each, read back by idsThere: that machine's dev:ino per path. */
const observe = (home, paths) => {
  const all = [...new Set(paths.flatMap(chainOf))];
  const r = spawnSync("sh", ["-c", IDENTITY_PROBE, "sh", home, ...all], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return idsThere(r.stdout, all);
};
/**
 * codexOn's two probes for a tree: RESOLVE_PROBE on `paths` and the roots, then IDENTITY_PROBE on each canonical answer
 * and every folder above it. { where, resolve, isDir }.
 */
const machineWhere = (paths, home, appHome = null) => {
  const asked = [home, ...(appHome ? [appHome] : []), `${home}/.config/herdr-app`, ...paths];
  const { resolve, isDir } = probe(asked);
  const plain = codexWhere({ home, appHome, resolve });
  const id = plain.home ? observe(plain.home, asked.map((q) => plain.canon(q)).filter(Boolean)) : null;
  return { where: codexWhere({ home, appHome, resolve, id }), resolve, isDir };
};
/** The launch rules for a tree, every path in `paths` (and the roots) resolved and observed there by the probes. */
const whereOn = (paths, home, appHome) => machineWhere(paths, home, appHome).where;

test("#1142 an --add-dir naming the home folder or an app home by any alias (dot, parent, symlink, inside, above) goes; ordinary folders stay", (t) => {
  const { root, home, app } = tree(t);
  const blocked = [`${home}/.`, `${home}/`, `${home}/work/..`, join(root, "to-home"), `${join(root, "to-home")}/`, app, join(app, "sub"),
    join(root, "to-app"), join(root, "to-app", "sub"), join(home, ".config"), root, "/", "..", "sub"];
  // Places that can't be proved there (a dangling link, a file in the way, a folder that isn't there to observe): withheld.
  const unknown = [join(root, "dangling"), join(root, "dangling", "x"), join(root, "file", "x"), join(home, "new-folder")];
  const allowed = [join(home, "work"), join(home, ".config/other"), join(home, ".npm"), join(root, "to-home", "work"), join(root, "shared")];
  const where = whereOn([...blocked, ...unknown, ...allowed], home, app);
  const { argv, dropped, unproved } = codexClean(["codex", ...[...blocked, ...unknown, ...allowed].flatMap((d) => ["--add-dir", d]), "-m", "x"], where);
  // Each kept one is passed as the canonical value it was checked as (#1142): the path through a link as its target.
  assert.deepEqual(addDirs(argv), allowed.map((d) => (d === join(root, "to-home", "work") ? join(home, "work") : d)),
    "positive controls: a project folder, an app home's sibling, a cache, a path through a link");
  assert.deepEqual(dropped, ["--add-dir"], "named by flag, never by value");
  assert.deepEqual(unproved, unknown, "withheld and counted by the launch's warning, never named as left out");
  assert.deepEqual(codexClean(["codex", `--add-dir=${home}/.`, `--add-dir=${join(home, "work")}`], where).argv, ["codex", `--add-dir=${join(home, "work")}`]);
  // launchRun the same way; a word after -- is no option and stays as written.
  assert.deepEqual(launchRun("codex", ["codex", "--add-dir", join(root, "to-home"), "--", "--add-dir", home], {}, where), ["codex", ...MODE, "--", "--add-dir", home]);
  for (const d of [home, root, "/", app, join(app, "sub"), join(home, ".config")]) assert.equal(codexDirAllowed(d, where), false, d);
  for (const d of [join(home, "work"), join(home, ".config/other"), join(root, "shared")]) assert.equal(codexDirAllowed(d, where), true, d);
  // The default app home under the home folder stays protected whatever the effective one is.
  assert.equal(codexDirAllowed(app, whereOn([], home, join(root, "shared"))), false);
  // A finished argv (a linked machine's): the same rule, by codexKeepDirs.
  assert.deepEqual(codexKeepDirs(["codex", ...MODE, "--add-dir", `${home}/.`, "--add-dir", join(home, "work"), "--add-dir", join(root, "dangling"),
    "resume", "--last"], where), { argv: ["codex", ...MODE, "--add-dir", join(home, "work"), "resume", "--last"], dropped: true,
    unproved: [join(root, "dangling")] });
});

test("#1142 codexGrants: a cache or XDG override naming the home folder or an app home by any alias is never granted; real caches are", (t) => {
  const { root, home, app } = tree(t);
  const env = { GOCACHE: app, npm_config_cache: `${home}/.`, GOMODCACHE: join(root, "to-home"), XDG_CACHE_HOME: join(root, "to-app"),
    BUN_INSTALL_CACHE_DIR: join(home, ".npm"), XDG_STATE_HOME: join(root, "state") };
  const { where, isDir } = machineWhere([...Object.values(env), join(root, "to-app/pnpm"), join(root, "to-app/go-build"),
    join(root, "state/herdr-core"), join(home, ".local/share"), join(home, ".local/share/herdr-core"), join(home, ".local/share/pnpm/store"),
    join(home, ".config"), join(home, ".local"), join(home, "go"), join(home, ".bun"), join(home, ".bun/install/cache")], home, app);
  // The folders that aren't there (the data folder's) are just not granted; nothing is withheld.
  assert.deepEqual(codexGrantPlan({ where, env, isDir }), { dirs: [join(root, "state/herdr-core"), join(home, ".npm")], unproved: [] });
});

test("#1142 a linked machine's folders are resolved there: the probe answers per path; a path it wasn't asked about proves nothing", (t) => {
  const { root, home, app } = tree(t);
  const { resolve, isDir } = probe([`${home}/.`, join(root, "to-home"), join(root, "dangling", "x"), join(root, "file", "x"), join(home, "new-folder"),
    join(root, "to-app", "sub")]);
  assert.equal(resolve(home), home);
  assert.equal(resolve(join(root, "to-home")), home);
  assert.equal(resolve(join(root, "dangling", "x")), null, "a dangling link proves nothing");
  assert.equal(resolve(join(root, "file", "x")), null, "nor a file in the way");
  assert.equal(resolve(join(home, "new-folder")), join(home, "new-folder"), "a missing tail: its nearest folder's place");
  assert.equal(isDir(join(home, "new-folder")), false);
  assert.equal(resolve(join(root, "to-app", "sub")), join(app, "sub"));
  assert.equal(isDir(join(app, "sub")), true);
  // Never this computer's answer: a path the machine wasn't asked about resolves to nothing, so it is withheld and counted.
  assert.equal(resolve(join(home, "work")), null);
  assert.deepEqual(codexKeepDirs(["codex", "--add-dir", join(home, "work")], codexWhere({ home, appHome: app, resolve, id: idHere })),
    { argv: ["codex"], dropped: false, unproved: [join(home, "work")] });
  // A root it can't resolve is still protected as written.
  assert.equal(codexDirAllowed(app, codexWhere({ home, appHome: app, resolve: () => null })), false);
});

/** A real sh runs `argv` with a fake codex first on PATH that prints its arguments: what Codex receives. */
function codexReceives(t, argv) {
  const bin = join(realpathSync(scratchRoot(t, "hb-fakecodex-")), "bin");
  mkdirSync(bin);
  exe(join(bin, "codex"), '#!/bin/sh\nfor a do printf "%s\\n" "$a"; done\n');
  const r = spawnSync(argv[0], argv.slice(1), { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split("\n").filter(Boolean);
}
/** Codex's options (its words before any --) hold every mode word, and --no-daemon comes once. */
const modeAsOptions = (got, name) => {
  const cut = got.indexOf("--");
  const options = cut < 0 ? got : got.slice(0, cut);
  for (const m of MODE) assert.ok(options.includes(m), `${name}: ${m} before any --: ${JSON.stringify(got)}`);
  assert.equal(count(got, "--no-daemon"), 1, `${name}: --no-daemon once: ${JSON.stringify(got)}`);
};

test("#1142 a seat's Codex template is kept only when Codex provably gets the pack's words as options; checked by a real sh", (t) => {
  const bot = { agent: "codex" };
  const run = launchRun("codex", ["codex"], bot);
  const plan = (command, extra = {}) => restartPlan({ bot, run, runningAgent: "codex", session: "s-1", template: { name: "seat-tpl", command },
    grants: ["/r/.git"], ...extra });
  // Proven: Codex runs last and is the only taker of "$@" (its own, or the one the pack adds).
  for (const command of ["codex -m x", 'codex -m x "$@"', 'A=1 exec codex -m x "$@"', 'export A=b; codex -m x']) {
    const p = plan(command);
    assert.deepEqual([p.template, p.granted, p.templateNote], ["seat-tpl", true, null], command);
    const got = codexReceives(t, p.argv);
    modeAsOptions(got, command);
    assert.equal(got[got.indexOf("--add-dir") + 1], "/r/.git", command);
  }
  // Not proven: an earlier "$@" or $* takes the words; a -- makes them prompt text. The agent row, said by name.
  for (const [command, why] of [['printf "" "$@"; codex', /can't pass the pack's Codex words to Codex as options/],
    [`printf '%s' "$*"; codex -m x`, /can't pass/], ["codex --", /can't pass/], ['codex -m x -- "$@"', /can't pass/],
    ['env A=1 codex -m x "$@"', /can't pass/],
    ["codex -- --no-daemon", /puts --no-daemon after its --, where Codex reads them as prompt text/]]) {
    const p = plan(command);
    assert.deepEqual([p.template, p.granted], [null, false], command);
    assert.match(p.templateNote, why, command);
    modeAsOptions(codexReceives(t, p.argv), command);
  }
  // A template naming the home folder or an app home is set aside too (the launch's rules; the test-only model observer).
  const where = modelWhere({ home: "/home/u", appHome: "/home/u/.config/herdr-app" });
  for (const command of ["codex --add-dir /home/u/.", "codex --add-dir /home/u/.config/herdr-app", "codex --add-dir /home/u/.config"]) {
    const p = plan(command, { where });
    assert.deepEqual([p.template, p.granted], [null, false], command);
    assert.match(p.templateNote, /template seat-tpl names --add-dir, so it started from its agent row/, command);
  }
  assert.equal(plan("codex --add-dir /home/u/work", { where }).template, "seat-tpl", "an ordinary folder is fine");
});

test("#1142 a Restart --tree helper's shell command runs again only when Codex provably gets the words; else refused by name", (t) => {
  const base = { agents: AGENTS, bot: { agent: "codex" }, grants: ["/r/.git"] };
  const helper = (command, extra = {}) => helperPlan({ ...base, ...extra, get: { address: "t7", name: "h7", cwd: "/w", labels: {},
    argv: ["sh", "-c", command], foreground: { argv: ["codex"], cwd: "/w" } } });
  for (const command of ["codex -m x", 'codex -m x "$@"']) {
    const p = helper(command);
    assert.equal(p.error, undefined, command);
    modeAsOptions(codexReceives(t, p.argv), command);
  }
  for (const [command, why] of [['printf "" "$@"; codex', /h7 can't be run again: its command runs Codex but can't pass the pack's Codex words to Codex as options/],
    ["codex --", /can't pass/], ["codex -- --no-daemon", /puts --no-daemon after its --/]]) {
    const p = helper(command);
    assert.match(p.error ?? "", why, command);
    assert.equal(p.argv, undefined, command);
  }
  const home = helper("codex --add-dir /home/u/.", { where: codexWhere({ home: "/home/u" }) });
  assert.match(home.error, /h7 can't be run again: its command runs Codex with --add-dir/);
});

/** tree() plus a shared folder holding a link to a child of the home folder, one to a child of the app home, and a real folder. */
function linkTree(t) {
  const { root, home, app } = tree(t);
  const S = join(root, "shared");
  mkdirSync(join(S, "real"));
  symlinkSync(join(home, "work"), join(S, "home-link"));
  symlinkSync(join(app, "sub"), join(S, "app-link"));
  const up = (name) => `${join(S, name)}/..`;
  return { root, home, app, S, up };
}
/** This computer's resolver, as canonHere answers it: the realpath of the exact form (kernel semantics), null when it isn't there. */
const realHere = (p) => canonHere(p);

test("#1142 a symlink's .. is resolved the filesystem's way, never as text; each --add-dir passed is the value checked (source, probe, grants)", (t) => {
  const { home, app, S, up } = linkTree(t);
  // As text each says S; the filesystem says the home folder and the app home.
  assert.equal(realpathSync.native(up("home-link")), home);
  assert.equal(realpathSync.native(up("app-link")), app);
  assert.equal(cleanPath(`${up("home-link")}/./`), up("home-link"), "cleanPath keeps a .. for the filesystem");
  assert.equal(codexWhere({ home }).canon(up("real")), null, "without a resolver a .. proves nothing");
  const there = probe([up("home-link"), up("app-link"), `${join(S, "missing")}/..`, `${join(S, "missing")}/../real`]);
  assert.equal(there.resolve(up("home-link")), home, "the probe's cd -P: the parent of the link's target");
  assert.equal(there.resolve(up("app-link")), app);
  assert.equal(there.resolve(`${join(S, "missing")}/..`), null, "a .. after a part that isn't there proves nothing");
  assert.equal(there.resolve(`${join(S, "missing")}/../real`), null);
  // This computer's resolver (a seat's start here) answers the same way.
  assert.equal(canonHere(up("home-link")), home);
  assert.equal(canonHere(up("app-link")), app);
  assert.equal(canonHere(`${join(S, "missing")}/..`), null, "a .. after a part that isn't there proves nothing here either");
  assert.equal(canonHere(`${join(S, "missing")}/../real`), null);
  assert.equal(canonHere(join(S, "missing", "x")), join(S, "missing", "x"), "a missing tail without ..: its nearest folder's place");
  // A resolver's answer is used only when it is canonical itself.
  assert.equal(codexWhere({ home, resolve: () => `${S}/real/..` }).canon(S), null);
  const words = ["codex", "--add-dir", up("home-link"), "--add-dir", up("app-link"), "--add-dir", up("real"), "--add-dir", join(S, "home-link"),
    `--add-dir=${up("app-link")}`, `--add-dir=${up("real")}`, "-m", "x"];
  const local = codexWhere({ home, appHome: app, resolve: realHere, id: idHere });
  const remote = whereOn([...words.slice(1)].map((w) => w.replace(/^--add-dir=/, "")).filter((w) => w.startsWith("/")), home, app);
  for (const [name, where] of [["here", local], ["through the probe", remote]]) {
    const { argv, dropped, unproved } = codexClean(words, where);
    // S/real/.. is passed as S and the link as its target; the two whose .. reaches the home folder or the app home go.
    assert.deepEqual(argv, ["codex", "--add-dir", S, "--add-dir", join(home, "work"), `--add-dir=${S}`, "-m", "x"], name);
    assert.deepEqual([dropped, unproved], [["--add-dir"], []], name);
    for (const v of [...addDirs(argv), S]) assert.equal(realpathSync.native(v), v, `${name}: passed as its canonical value`);
    assert.deepEqual(addDirs(launchRun("codex", words, {}, where)), [S, join(home, "work")], name);
    assert.deepEqual(codexKeepDirs(words, where), { argv, dropped: true, unproved: [] }, name);
  }
  // A derived folder whose .. leads to the home folder or the app home is never granted; one whose .. leads to S is, as S.
  const env = { GOCACHE: up("home-link"), XDG_CACHE_HOME: up("app-link"), GOMODCACHE: up("real") };
  const grants = codexGrants({ where: local, env, isDir: dirHere });
  assert.deepEqual(grants, [S, join(home, ".npm")]);
  for (const g of grants) assert.ok(![home, app].includes(realpathSync.native(g)), g);
});

test("#1142 a template's --add-dir is kept only when written as the canonical value it is checked as: the seat falls back, the helper is refused", (t) => {
  const { root, home, app, S, up } = linkTree(t);
  const where = codexWhere({ home, appHome: app, resolve: realHere, id: idHere });
  const bot = { agent: "codex" };
  const run = launchRun("codex", ["codex"], bot, where);
  const plan = (command) => restartPlan({ bot, run, runningAgent: "codex", session: "s-1", template: { name: "seat-tpl", command }, grants: [], where });
  const helper = (command) => helperPlan({ agents: AGENTS, bot, grants: [], where, get: { address: "t7", name: "h7", cwd: root, labels: {},
    argv: ["sh", "-c", command], foreground: { argv: ["codex"], cwd: root } } });
  // To home, to the app home, and three safe folders whose text isn't their canonical value: none is rewritten in a template.
  for (const value of [up("home-link"), up("app-link"), up("real"), join(S, "home-link"), `${S}/./real`, `${S}/real/`]) {
    const command = `codex --add-dir ${value} "$@"`;
    const p = plan(command);
    assert.deepEqual([p.template, p.granted], [null, false], value);
    assert.match(p.templateNote, /template seat-tpl names --add-dir, so it started from its agent row/, value);
    const got = codexReceives(t, p.argv);
    modeAsOptions(got, value);
    assert.equal(got.includes(value), false, `${value}: the template's own value never reaches Codex`);
    const h = helper(command);
    assert.match(h.error ?? "", /h7 can't be run again: its command runs Codex with --add-dir/, value);
    assert.equal(h.argv, undefined, value);
  }
  // Positive control: written as its canonical value, kept, granted and passed byte for byte, by the seat and the helper.
  const command = `codex --add-dir ${join(S, "real")} "$@"`;
  const p = plan(command);
  assert.deepEqual([p.template, p.granted, p.templateNote], ["seat-tpl", true, null]);
  for (const argv of [p.argv, helper(command).argv]) {
    const got = codexReceives(t, argv);
    modeAsOptions(got, command);
    assert.deepEqual(addDirs(got), [join(S, "real")]);
  }
});

test("#1142 a template's words are proved to reach Codex only for one literal shape; set --, shift and every other form fall back or are refused", (t) => {
  const bot = { agent: "codex" };
  const run = launchRun("codex", ["codex"], bot);
  const plan = (command) => restartPlan({ bot, run, runningAgent: "codex", session: "s-1", template: { name: "seat-tpl", command }, grants: ["/r/.git"] });
  const helper = (command) => helperPlan({ agents: AGENTS, bot, grants: ["/r/.git"], get: { address: "t7", name: "h7", cwd: "/w", labels: {},
    argv: ["sh", "-c", command], foreground: { argv: ["codex"], cwd: "/w" } } });
  // What Codex receives holds the mode words exactly once each, in their order, as options: all before any --.
  const intact = (got, name) => {
    const at = got.indexOf(MODE[0]);
    assert.deepEqual(got.slice(at, at + MODE.length), MODE, `${name}: ${JSON.stringify(got)}`);
    for (const m of MODE) assert.equal(count(got, m), 1, `${name}: ${m} once: ${JSON.stringify(got)}`);
    const cut = got.indexOf("--");
    assert.ok(at >= 0 && (cut < 0 || at + MODE.length <= cut), `${name}: before any --: ${JSON.stringify(got)}`);
  };
  // At a9492cb5, set -- gave Codex none of them and shift dropped --approve-for-me, with the template kept and granted.
  for (const command of ['set --; codex "$@"', 'shift; codex "$@"']) {
    const p = plan(command);
    assert.deepEqual([p.template, p.granted], [null, false], command);
    assert.match(p.templateNote, /its template seat-tpl can't pass the pack's Codex words to Codex as options, so it started from its agent row/, command);
    assert.equal(p.argv[0], "codex", command);
    intact(codexReceives(t, p.argv), command);
    const h = helper(command);
    assert.match(h.error ?? "", /h7 can't be run again: its command runs Codex but can't pass the pack's Codex words to Codex as options/, command);
    assert.equal(h.argv, undefined, command);
  }
  const unproved = ['set -- a; codex "$@"', 'eval shift; codex "$@"', '. /dev/null; codex "$@"', 'source /dev/null; codex "$@"', 'command shift; codex "$@"',
    'f() { shift; }; f; codex "$@"', 'trap "" HUP; codex "$@"', 'if true; then codex "$@"; fi', 'true | codex "$@"', '( codex "$@" )', '{ codex "$@"; }',
    'codex "$@" &', 'codex "$@" >/dev/null', 'cd "$(pwd)"; codex "$@"', 'cd `pwd`; codex "$@"', 'codex "$*"', "codex $@", 'codex "${@}"',
    'codex -m $M "$@"', 'X=--; codex $X "$@"', "codex '--' \"$@\"", 'exec -a x codex "$@"', 'env A=b codex "$@"', 'cd /tmp && codex "$@"',
    'git status; codex "$@"', 'codex "$@" "$@"', 'codex ~/x "$@"', 'codex * "$@"', "codex\n", 'codex "$@" || true', 'codex -m x # note',
    // #1142: an assignment that moves the launch's folders or program; a Codex word of unknown arity or without its value.
    'HOME=/tmp/x codex "$@"', 'export CODEX_HOME=/tmp/x; codex "$@"', "XDG_CONFIG_HOME=/tmp/x codex", 'PATH=/tmp/x codex "$@"',
    'npm_config_cache=/tmp/x codex "$@"', 'export GOPATH=/tmp/x; codex "$@"', "HERDR_APP_HOME=/tmp/x codex", "codex -m", 'codex -m "$@"',
    'codex --profile "$@"', 'codex -c "$@"', 'codex --add-dir "$@"', 'codex exec "$@"', "codex resume", 'codex review "$@"', 'codex --foo "$@"',
    'codex "$@" exec', 'codex "$@" -m', 'codex -m -x "$@"'];
  for (const command of unproved) {
    assert.equal(codexForwards(command), false, command);
    const p = plan(command);
    assert.deepEqual([p.template, p.granted], [null, false], command);
    intact(codexReceives(t, p.argv), command);
    const h = helper(command);
    assert.match(h.error ?? "", /h7 can't be run again/, command);
    assert.equal(h.argv, undefined, command);
  }
  // Proved: a literal Codex run with the template's own "$@" or the one the pack appends, after literal assignments or export.
  for (const command of ['codex "$@"', "codex -m x", 'A=1 exec codex -m m "$@"', 'export A=b; codex "$@"', "A=b; codex -m 'o \"3\"'",
    'codex "$@" -m x', "A=b && codex -m x", 'codex --model=x "$@"', 'codex -mx "$@"', 'codex --oss "$@"', 'codex "$@" --search']) {
    assert.equal(codexForwards(command), true, command);
    const p = plan(command);
    assert.deepEqual([p.template, p.granted, p.templateNote], ["seat-tpl", true, null], command);
    const got = codexReceives(t, p.argv);
    intact(got, command);
    assert.deepEqual(addDirs(got), ["/r/.git"], command);
    const h = helper(command);
    assert.equal(h.error, undefined, command);
    intact(codexReceives(t, h.argv), command);
  }
  // Codex named by its path is the same run (read only here: no path to a real Codex is ever executed by a test).
  assert.equal(codexForwards('/opt/tools/codex "$@" -m x'), true);
});

/**
 * A home folder H with its default app home, both herdr-core folders, caches, a repo and a cache root inside a data
 * folder; spellings of it; and a home B like it but without an app home (none installed there).
 */
function homeTree(t) {
  const root = realpathSync(scratchRoot(t, "hb-1142-h-"));
  const H = join(root, "home"), B = join(root, "bare");
  for (const d of [".config/herdr-app", ".local/state/herdr-core", ".local/share/herdr-core", ".npm", "go-mod", "proj/.git", "data/cache", "plain"]) {
    mkdirSync(join(H, d), { recursive: true });
  }
  for (const d of [".local/state/herdr-core", ".npm", "plain"]) mkdirSync(join(B, d), { recursive: true });
  mkdirSync(join(root, "x"));
  symlinkSync(H, join(root, "alias"));
  symlinkSync(root, join(root, "up"));
  symlinkSync(join(root, "nowhere"), join(H, "gp"));
  // H as written, through a symlink, through a .., and under a symlinked folder above it.
  return { root, H, B, spellings: [H, join(root, "alias"), `${root}/x/../home`, join(root, "up", "home")] };
}
/** codexOn's pipeline for a machine whose HOME is spelled `home`: one inventory, probed by a real sh (both probes), weighed by codexGrantPlan. */
const linkedGrants = (home, env, extra = {}) => {
  const inventory = codexGrantPaths({ home, env, ...extra });
  const { where, isDir } = machineWhere([...inventory.candidates, ...inventory.general], home);
  return codexGrantPlan({ where, env, isDir, paths: inventory });
};
/** localCodexGrantPlan's: this computer's resolver, stat and folder check. */
const localGrants = (home, env, extra = {}) => codexGrantPlan({ where: codexWhere({ home, resolve: canonHere, id: idHere }), home, env, isDir: dirHere,
  ...extra });

test("#1142 one inventory: a HOME spelled through a symlink, a .. or a linked folder keeps both core folders and every general folder out, here and there", (t) => {
  const { H, spellings } = homeTree(t);
  const core = [join(H, ".local/state/herdr-core"), join(H, ".local/share/herdr-core")];
  for (const home of spellings) {
    const cases = [
      [{}, { gitDir: `${home}/proj/.git` }, [join(H, "proj/.git"), ...core, join(H, ".npm")]],
      [{ npm_config_cache: `${home}/.local` }, {}, core],
      [{ XDG_STATE_HOME: `${home}/.local/state`, GOMODCACHE: `${home}/go-mod` }, {}, [...core, join(H, "go-mod"), join(H, ".npm")]],
      // A cache folder named above a general folder (GOCACHE above XDG_CACHE_HOME) is no cache.
      [{ XDG_CACHE_HOME: `${home}/data/cache`, GOCACHE: `${home}/data` }, {}, [...core, join(H, ".npm")]],
    ];
    for (const [env, extra, want] of cases) {
      // "there, where only": the rules and no inventory, as a direct call gives them; built from the home as spelled (where.spelled).
      const inventory = codexGrantPaths({ home, env, ...extra });
      const asked = machineWhere([...inventory.candidates, ...inventory.general], home);
      const whereOnly = codexGrantPlan({ where: asked.where, env, isDir: asked.isDir, ...extra });
      for (const [name, plan] of [["there", linkedGrants(home, env, extra)], ["here", localGrants(home, env, extra)], ["there, where only", whereOnly]]) {
        assert.deepEqual(plan, { dirs: want, unproved: [] }, `${name} ${home} ${JSON.stringify(env)}`);
      }
    }
    // #1142, each candidate on its own: a general folder that can't be resolved (a dangling GOPATH) withholds only the
    // candidate under it (Go's module cache), counted once; the other folders are granted.
    for (const [name, plan] of [["there", linkedGrants(home, { GOPATH: `${home}/gp` })], ["here", localGrants(home, { GOPATH: `${home}/gp` })]]) {
      assert.deepEqual(plan, { dirs: [...core, join(H, ".npm")], unproved: [cleanPath(`${home}/gp/pkg/mod`)] }, `${name} ${home}`);
      assert.equal(codexWithheldWarning(plan.unproved.length, plan.dirs.length), someWithheld(1), `${name} ${home}`);
    }
  }
});

test("#1142 a protected root that can't be resolved withholds every --add-dir and every derived folder, with the warning; resolved roots keep the narrow ones", (t) => {
  const { H } = homeTree(t);
  const narrow = ["codex", "--add-dir", join(H, "plain")];
  for (const [label, opts] of [["a relative HOME", { home: "rel/home" }], ["an empty HOME", { home: "" }], ["a relative app home", { home: H, appHome: "rel/app" }],
    ["a resolver error", { home: H, resolve: () => { throw new Error("no"); } }]]) {
    const where = codexWhere({ resolve: canonHere, id: idHere, ...opts });
    assert.ok(where.unproved.length, label);
    assert.equal(where.canon(join(H, "plain")), null, `${label}: canon proves nothing`);
    assert.equal(codexDirVerdict(join(H, "plain"), where), "unproved", `${label}: nor does the folder rule allow a canonical folder`);
    const cleaned = codexClean(narrow, where);
    assert.deepEqual(cleaned, { argv: ["codex"], dropped: [], unproved: [join(H, "plain")] }, `${label}: even a narrow folder, withheld and counted`);
    const plan = codexGrantPlan({ where, home: opts.home, env: {}, isDir: dirHere });
    assert.deepEqual(plan.dirs, [], label);
    // The launch's one warning: nothing passed, so no additional grants at all; never named as a flag left out.
    assert.equal(codexWithheldWarning(new Set([...cleaned.unproved, ...plan.unproved]).size, 0), ALL_WITHHELD, label);
    assert.equal(codexCleanNote(narrow, where), null, label);
  }
  const ok = codexWhere({ home: H, resolve: canonHere, id: idHere });
  assert.deepEqual(ok.unproved, []);
  assert.deepEqual(codexClean(narrow, ok), { argv: narrow, dropped: [], unproved: [] }, "the narrow folder stays");
  assert.equal(codexCleanNote(narrow, ok), null);
});

test("#1142 a home whose default app home isn't there, or can't be observed: every folder withheld, here and there, with the full warning", (t) => {
  const { B } = homeTree(t);
  const narrow = ["codex", "--add-dir", join(B, "plain")];
  const want = { dirs: [], unproved: [join(B, ".local/state/herdr-core"), join(B, ".npm")] };
  // Resolved (its folder above is there), but nothing there to observe: the app home walk fails, so nothing is proved.
  for (const [name, where, plan] of [["here", codexWhere({ home: B, resolve: canonHere, id: idHere }), localGrants(B, {})],
    ["there", whereOn([join(B, "plain")], B, null), linkedGrants(B, {})]]) {
    assert.deepEqual(where.unproved, [], `${name}: resolved`);
    assert.equal(codexDirVerdict(join(B, "plain"), where), "unproved", name);
    const cleaned = codexClean(narrow, where);
    assert.deepEqual(cleaned, { argv: ["codex"], dropped: [], unproved: [join(B, "plain")] }, name);
    assert.deepEqual(plan, want, name);
    assert.equal(codexWithheldWarning(new Set([...cleaned.unproved, ...plan.unproved]).size, plan.dirs.length), ALL_WITHHELD, name);
  }
  // Positive control: made, the same home's folders are granted.
  mkdirSync(join(B, ".config/herdr-app"), { recursive: true });
  for (const [name, plan] of [["here", localGrants(B, {})], ["there", linkedGrants(B, {})]]) {
    assert.deepEqual(plan, { dirs: want.unproved, unproved: [] }, `${name}: with its app home`);
  }
});

test("#1142 each candidate on its own: one that isn't there is just not granted, one whose folder check fails after it resolved is withheld and counted", (t) => {
  const { H } = homeTree(t);
  const env = { XDG_CACHE_HOME: join(H, "no-cache"), GOMODCACHE: join(H, "go-mod"), GOCACHE: join(H, "no-go-build"), npm_config_cache: join(H, ".npm") };
  const core = [join(H, ".local/state/herdr-core"), join(H, ".local/share/herdr-core")];
  const where = codexWhere({ home: H, resolve: canonHere, id: idHere });
  // Positive control: the absent cache root (and everything under it) withholds nothing.
  assert.deepEqual(codexGrantPlan({ where, env, isDir: dirHere }), { dirs: [...core, join(H, "go-mod"), join(H, ".npm")], unproved: [] });
  // Each resolved here; then the folder check of one answers neither yes nor no, and another's throws.
  for (const [label, bad] of [["unknown", () => null], ["undefined", () => undefined], ["a throw", () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); }]]) {
    const isDir = (p) => (p === join(H, "go-mod") || p === join(H, ".npm") ? bad() : dirHere(p));
    const plan = codexGrantPlan({ where, env, isDir });
    assert.deepEqual(plan, { dirs: core, unproved: [join(H, "go-mod"), join(H, ".npm")] }, label);
    assert.equal(codexWithheldWarning(plan.unproved.length, plan.dirs.length), someWithheld(2), label);
  }
  // Only those: every check failing withholds them all, counted once each, and says no additional grants.
  const none = codexGrantPlan({ where, env, isDir: () => null });
  assert.deepEqual(none.dirs, []);
  assert.equal(codexWithheldWarning(none.unproved.length, none.dirs.length), ALL_WITHHELD);
  assert.equal(codexWithheldWarning(0, 3), null, "nothing withheld: no warning");
});

test("#1142 an unreadable candidate (EACCES) is withheld and counted beside a missing one and the granted ones, here and there; an unreadable app home withholds all",
  { skip: process.getuid?.() === 0 ? "root reads every folder: no EACCES to observe" : false }, (t) => {
  const { H } = homeTree(t);
  const locked = join(H, "locked");
  mkdirSync(join(locked, "cache"), { recursive: true });
  const env = { XDG_CACHE_HOME: join(H, "no-cache"), GOCACHE: join(locked, "cache"), GOMODCACHE: join(H, "no-such-mod"), npm_config_cache: join(H, ".npm") };
  const extra = { gitDir: join(H, "proj/.git") };
  const want = [join(H, "proj/.git"), join(H, ".local/state/herdr-core"), join(H, ".local/share/herdr-core"), join(H, ".npm")];
  chmodSync(locked, 0);
  try {
    for (const [name, plan] of [["there", linkedGrants(H, env, extra)], ["here", localGrants(H, env, extra)]]) {
      assert.deepEqual(plan, { dirs: want, unproved: [join(locked, "cache")] }, name);
      assert.equal(codexWithheldWarning(plan.unproved.length, plan.dirs.length), someWithheld(1), name);
    }
    // The folder check here (dirHere): a stat that fails but not as "not there" (EACCES) is unknown, never "not there".
    writeFileSync(join(H, "a-file"), "x");
    assert.deepEqual([dirHere(join(locked, "cache")), dirHere(join(H, "no-such")), dirHere(join(H, "a-file")), dirHere(join(H, "a-file", "x")),
      dirHere(join(H, "plain"))], [null, false, false, false, true]);
    // t29q at f9bfba1a: EACCES read as unknown here and as "different" there. Now both are unknown: that folder is
    // withheld (compared as written, so identity alone decides), and a readable one beside it is not.
    const ids = observe(H, [join(locked, "cache"), join(H, "plain"), join(H, ".config/herdr-app")]);
    assert.deepEqual([idHere(join(locked, "cache")), ids(join(locked, "cache"))], [null, null], "a stat that fails is no identity, here or there");
    for (const [name, id] of [["here", idHere], ["there", ids]]) {
      const where = codexWhere({ home: H, id });
      assert.equal(codexDirVerdict(join(locked, "cache"), where), "unproved", name);
      assert.equal(codexDirVerdict(join(H, "plain"), where), "ok", `${name}: only that folder`);
    }
  } finally {
    chmodSync(locked, 0o755);
  }
  // The folder above the app home unreadable: that root can't be proved, so every folder is withheld.
  chmodSync(join(H, ".config"), 0);
  try {
    for (const [name, plan] of [["there", linkedGrants(H, {}, extra)], ["here", localGrants(H, {}, extra)]]) {
      assert.deepEqual(plan.dirs, [], name);
      assert.ok(plan.unproved.length >= 3, `${name}: ${JSON.stringify(plan.unproved)}`);
      assert.equal(codexWithheldWarning(plan.unproved.length, 0), ALL_WITHHELD, name);
    }
  } finally {
    chmodSync(join(H, ".config"), 0o755);
  }
});

test("#1142 by object identity: an alias the paths don't show is refused, here (stat) and there (IDENTITY_PROBE); a failed observation withholds", (t) => {
  const { root, home, app } = tree(t);
  mkdirSync(join(home, ".local"));
  for (const [link, to] of [["h-alias", home], ["a-alias", app], ["above-app", join(home, ".config")], ["l-alias", join(home, ".local")],
    ["dangling-id", join(root, "nowhere")], ["loop-a", join(root, "loop-b")], ["loop-b", join(root, "loop-a")]]) symlinkSync(to, join(root, link));
  const weighed = ["h-alias", "a-alias", "a-alias/sub", "above-app", "l-alias", "shared", "missing", "dangling-id", "loop-a"].map((d) => join(root, d));
  const general = [join(home, ".local")];
  // Paths compared as written (no resolver): only identity can see these aliases. Observed as codexOn does: each
  // folder weighed, the home folder, each app home and each general folder, with every folder above them.
  const apps = codexWhere({ home, appHome: app }).appHomes;
  const observed = [...new Set([home, ...apps, ...general, ...weighed].flatMap(chainOf))];
  const r = spawnSync("sh", ["-c", IDENTITY_PROBE, "sh", home, ...observed], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  for (const [name, id] of [["here", idHere], ["there", idsThere(r.stdout, observed)]]) {
    const where = codexWhere({ home, appHome: app, id });
    for (const d of ["h-alias", "a-alias", "a-alias/sub", "above-app"]) assert.equal(codexDirVerdict(join(root, d), where), "refused", `${name} ${d}`);
    assert.equal(codexDirVerdict(join(root, "l-alias"), where, general), "refused", `${name}: a general folder, for a derived one`);
    assert.equal(codexDirVerdict(join(root, "l-alias"), where), "ok", `${name}: an --add-dir may name it`);
    assert.equal(codexDirVerdict(join(root, "shared"), where, general), "ok", `${name}: an ordinary folder`);
    // A failed stat (missing, a dangling link, a loop) is unknown, never "different": that folder alone is withheld.
    for (const d of ["missing", "dangling-id", "loop-a"]) assert.equal(codexDirVerdict(join(root, d), where), "unproved", `${name} ${d}`);
  }
  // The answer there: only what it observed, as observed. One "?" or malformed line withholds that folder; a root's
  // withholds every folder; an answer that is unsupported, short, longer, headless or empty (a failed hc exec) proves nothing.
  const lines = r.stdout.split("\n");
  const edited = (p, v) => lines.map((l, i) => (i === observed.indexOf(p) + 1 ? v : l)).join("\n");
  const verdict = (stdout, d = join(root, "shared")) => codexDirVerdict(d, codexWhere({ home, appHome: app, id: idsThere(stdout, observed) }), general);
  assert.equal(verdict(r.stdout), "ok", "positive control");
  for (const bad of ["?", "12:34:56", "1:x", "", "1"]) {
    assert.equal(verdict(edited(join(root, "shared"), bad)), "unproved", `its own line ${JSON.stringify(bad)}`);
    assert.equal(verdict(edited(join(root, "shared"), bad), join(root, "h-alias")), "refused", `${JSON.stringify(bad)}: another folder's answer stands`);
  }
  for (const p of [home, app, join(home, ".config"), root]) assert.equal(verdict(edited(p, "?")), "unproved", `a protected root's walk: ${p}`);
  for (const [label, stdout] of [["unsupported", "unsupported\n"], ["short", lines.slice(0, -2).join("\n")], ["longer", `${r.stdout}1:1\n`],
    ["headless", lines.slice(1).join("\n")], ["empty", ""],
    // The right number of lines under a first line that isn't "ok" (say, a shell's own line): read as nothing.
    ["not ok first", ["ko", ...lines.slice(1)].join("\n")], ["unsupported first", ["unsupported", ...lines.slice(1)].join("\n")]]) {
    assert.equal(verdict(stdout), "unproved", label);
    assert.equal(verdict(stdout, join(root, "h-alias")), "unproved", `${label}: nothing is proved either way`);
  }
  assert.equal(idsThere(r.stdout, observed)(join(root, "not-asked")), null, "a path it wasn't asked about: no answer, no shortcut");
  // Only a dev:ino is an identity: an observer's other answer (for the folder, or for an app home) is unknown.
  for (const bad of ["?", "", "unsupported", "12", "1:2:3", "a:b", 7]) {
    for (const [whose, at] of [["the folder", join(root, "shared")], ["an app home", app]]) {
      const where = codexWhere({ home, appHome: app, id: (p) => (p === at ? bad : idHere(p)) });
      assert.equal(codexDirVerdict(join(root, "shared"), where), "unproved", `${whose}: ${JSON.stringify(bad)}`);
    }
  }
  const odd = spawnSync("sh", ["-c", IDENTITY_PROBE, "sh", join(root, "nowhere"), join(root, "shared"), home], { encoding: "utf8" });
  assert.equal(odd.stdout.trim(), "unsupported", "no folder to pick stat's form on");
  // Its symlink form is refused: the path is resolved first (realpath), and an app home is above it.
  assert.equal(codexDirVerdict(canonHere(join(root, "a-alias", "sub")), codexWhere({ home, appHome: app, resolve: canonHere, id: idHere })), "refused");
  // A bind mount (modelled: a folder with another's dev:ino) of an app home itself, or of a folder above one, is refused.
  const bindOf = (target) => (p) => (p === join(root, "shared") ? idHere(target) : idHere(p));
  for (const target of [app, join(home, ".config"), home]) {
    assert.equal(codexDirVerdict(join(root, "shared"), codexWhere({ home, appHome: app, id: bindOf(target) })), "refused", target);
  }
  // KNOWN LIMIT (tracked in #1151; t29q's model at f9bfba1a): a bind mount that shows a folder INSIDE an app home
  // under another path has that folder's dev:ino, and no folder above it is an app home, so the walk can't tell: it is
  // still allowed. A model result, recorded as it is: not fixed, and not a mount test.
  assert.equal(codexDirVerdict(join(root, "shared"), codexWhere({ home, appHome: app, id: bindOf(join(app, "sub")) })), "ok",
    "KNOWN LIMIT #1151: a bind of an app home's descendant is still allowed");
});

test("#1142 the home rule alone: with the app home outside the home folder, the home folder and every folder above it stay refused", (t) => {
  // In the usual layout the default app home lies under the home folder, so the app-home rule refuses the same folders
  // and the home rule never decides alone. A linked ~/.config puts the app home elsewhere: then only the home rule does.
  const root = realpathSync(scratchRoot(t, "hb-1142-"));
  const home = join(root, "u", "home"), cfg = join(root, "e", "cfg"), shared = join(root, "s", "shared");
  for (const d of [home, join(cfg, "herdr-app"), shared]) mkdirSync(d, { recursive: true });
  symlinkSync(cfg, join(home, ".config"));
  const where = (id) => codexWhere({ home, resolve: canonHere, id });
  assert.deepEqual(where(idHere).appHomes, [join(cfg, "herdr-app")], "the default app home resolves outside the home folder");
  assert.equal(codexDirVerdict(shared, where(idHere)), "ok", "positive control");
  // A bind mount (modelled: a folder with another's dev:ino) of the home folder, or of the folder above it.
  const bindOf = (target) => (p) => (p === shared ? idHere(target) : idHere(p));
  for (const target of [home, join(root, "u")]) assert.equal(codexDirVerdict(shared, where(bindOf(target))), "refused", target);
});

test("#1142 a Codex seat on a linked machine whose HOME is an alias: both core folders and the caches it names are granted as canonical values, .local stays out, start and restart", (t) => {
  const root = realpathSync(scratchRoot(t, "hb-1142-va-"));
  const bin = join(root, "bin"), home = join(root, "home"), app = join(root, "app"), vm = join(root, "vm"), vmBin = join(root, "vm-bin"), alias = join(root, "vm-alias");
  for (const d of [bin, home, app, vmBin, join(home, ".config/herdr-app"), join(vm, ".config/herdr-app"), join(vm, ".local/state/herdr-core"),
    join(vm, ".local/share/herdr-core"), join(vm, "go-mod")]) mkdirSync(d, { recursive: true });
  symlinkSync(vm, alias);
  symlinkSync(join(root, "nowhere"), join(vm, "gp"));
  symlinkSync(join(root, "nowhere"), join(vm, "dangling"));
  exe(join(bin, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  exe(join(bin, "herdr-app"), "#!/bin/sh\nexit 1\n");
  exe(join(vmBin, "codex"), "#!/bin/sh\nexit 0\n");
  exe(join(vmBin, "uname"), "#!/bin/sh\necho Linux\n");
  const project = scratchProject(vm, "proj", { commit: true, bots: { version: 1, categories: [], bots: [
    { id: ID.dev, name: "Dev", kind: "main", agent: "codex", look: { character: "star", colour: "blue" }, role: "r", instructions: "i" }] } });
  const statePath = join(root, "hc.json"), logPath = join(root, "hc.log");
  const blank = Object.fromEntries(["HERDR_APP_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "GOPATH", "GOMODCACHE",
    "GOCACHE", "npm_config_cache", "NPM_CONFIG_CACHE", "BUN_INSTALL", "BUN_INSTALL_CACHE_DIR"].map((k) => [k, ""]));
  const machine = (env) => writeFileSync(statePath, JSON.stringify({ next: 100, terminals: [],
    machines: [{ name: "vm", id: "core-of-vm", state: "connected", uname: "Linux x86_64", home: alias, path: vmBin, env: { ...blank, ...env } }] }));
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, HERDR_APP_HOME: app, HC_FAKE_STATE: statePath, HC_FAKE_LOG: logPath, LANG: "C",
    GIT_CEILING_DIRECTORIES: root, XDG_DATA_HOME: "", AUTOMAGIK_HERDR_TAB_WAIT_MS: "0" };
  const cli = (...args) => {
    writeFileSync(logPath, "");
    const r = spawnSync(process.execPath, [CLI, ...args, "--machine", "vm", "--project", project, "--json"], { cwd: root, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return { r, argv: launched(readJsonLines(logPath).find((c) => c[0] === "run")) };
  };
  machine({ npm_config_cache: `${alias}/.local`, GOMODCACHE: `${alias}/go-mod` });
  const want = [realpathSync(join(project, ".git")), join(vm, ".local/state/herdr-core"), join(vm, ".local/share/herdr-core"), join(vm, "go-mod")];
  const start = cli("start", "Dev");
  assert.deepEqual(addDirs(start.argv), want, "both core folders and the named cache, canonical; never the whole .local");
  modeAsOptions(start.argv.slice(1), "the linked seat");
  const again = cli("restart", "Dev", "--fresh", "--force");
  assert.deepEqual(addDirs(again.argv), want, "its restart: the same");
  for (const r of [start.r, again.r]) assert.equal(r.stderr.includes("Codex extra folders withheld"), false, "nothing withheld: no warning");
  // #1142, each candidate on its own: a general folder there that can't be resolved (a dangling GOPATH) withholds only
  // Go's module cache under it, and an --add-dir through a dangling link only itself (written twice: one folder); the
  // other folders are granted. One warning per launch, counting each withheld folder once (the module cache is named
  // in programs.json too: one folder).
  const once = (stderr, text) => stderr.split(text).length - 1;
  writeFileSync(join(app, "programs.json"), `${JSON.stringify({ programs: { codex: { run: ["codex", "--add-dir", `${alias}/dangling/x`,
    `--add-dir=${alias}/dangling/x`, "--add-dir", `${alias}/gp/pkg/mod`] } } })}\n`);
  machine({ GOPATH: `${alias}/gp` });
  const kept = [realpathSync(join(project, ".git")), join(vm, ".local/state/herdr-core"), join(vm, ".local/share/herdr-core")];
  for (const verb of [["start", "Dev"], ["restart", "Dev", "--fresh", "--force"]]) {
    const held = cli(...verb);
    assert.deepEqual(addDirs(held.argv), kept, verb[0]);
    modeAsOptions(held.argv.slice(1), verb[0]);
    assert.equal(once(held.r.stderr, `vm: ${someWithheld(2)}`), 1, `${verb[0]}: ${held.r.stderr}`);
    assert.equal(once(held.r.stderr, "Codex extra folders withheld"), 1, `${verb[0]}: one warning for the launch`);
    assert.equal(/working folder only/.test(held.r.stderr), false);
  }
  // The same seat started on this computer, its GOPATH the same dangling link (here too, through the alias), the same --add-dirs.
  exe(join(bin, "codex"), "#!/bin/sh\nexit 0\n");
  writeFileSync(logPath, "");
  const here = spawnSync(process.execPath, [CLI, "start", "Dev", "--project", project, "--json"], { cwd: root, encoding: "utf8",
    env: { ...env, ...blank, HERDR_APP_HOME: app, GOPATH: `${alias}/gp` } });
  assert.equal(here.status, 0, here.stderr);
  assert.deepEqual(addDirs(launched(readJsonLines(logPath).find((c) => c[0] === "run"))), [realpathSync(join(project, ".git"))]);
  assert.equal(once(here.stderr, someWithheld(2)), 1, here.stderr);
  assert.equal(once(here.stderr, "Codex extra folders withheld"), 1);
});

test("#1142 a template worker keeps the owner's command as written, never with the pack's folders; a Codex option after its -- is refused", (t) => {
  const base = { agents: AGENTS, bot: { agent: "codex" }, grants: ["/r/.git"], where: codexWhere({ home: "/home/u" }) };
  const tw = (command) => helperPlan({ ...base, get: { address: "t7", name: "w7", cwd: "/w", labels: { "worker.of": ID.dev, "worker.template": "tpl" },
    argv: ["sh", "-c", command], foreground: { argv: ["codex"], cwd: "/w" } } });
  // Its own flags before --: run as written (its bypass and its own --add-dir too), no pack folder, no granted classification.
  const command = "codex --no-daemon --dangerously-bypass-approvals-and-sandbox --add-dir /home/u -m x";
  const owner = tw(command);
  assert.equal(owner.error, undefined);
  assert.deepEqual(owner.argv.slice(0, 4), ["sh", "-c", `${command} "$@"`, "sh"]);
  assert.equal(owner.argv.includes("/r/.git"), false, "no pack-injected --add-dir");
  assert.equal("granted" in owner, false);
  assert.equal(owner.warning, null);
  const got = codexReceives(t, owner.argv);
  assert.deepEqual(got.slice(0, 2), ["--no-daemon", "--dangerously-bypass-approvals-and-sandbox"], "the owner's flags reach Codex as options");
  // #1142, warning-only (no --no-daemon among its options): recovered as written, warned, never with the pack's folders or granted.
  const warned = tw("codex -m x");
  assert.equal(warned.error, undefined);
  assert.deepEqual(warned.argv.slice(0, 4), ["sh", "-c", 'codex -m x "$@"', "sh"]);
  assert.equal(warned.argv.includes("/r/.git") || warned.argv.includes("--add-dir"), false, "no pack-injected --add-dir");
  assert.equal(warned.argv.includes("--no-daemon"), false, "its command is never rewritten");
  assert.equal("granted" in warned, false);
  assert.match(warned.warning, /^Template tpl runs Codex without --no-daemon/);
  // A Codex option after its --: refused before anything runs, by name.
  const lost = tw("codex -- --no-daemon");
  assert.match(lost.error, /w7 can't be run again: Template tpl runs Codex with --no-daemon after its --, where Codex reads it as prompt text.*not started/);
  assert.equal(lost.argv, undefined);
  assert.match(codexTemplateRefusal("tpl", "codex -m x -- --no-daemon --approve-for-me"), /with --no-daemon, --approve-for-me after its --/);
  assert.match(codexTemplateRefusal("tpl", "codex -- -c sandbox_mode=x --add-dir /r"), /with -c, --add-dir after its --/);
  assert.equal(codexTemplateRefusal("tpl", "codex --no-daemon -m x -- fix-it"), null, "a prompt after -- is no option");
  assert.equal(codexTemplateRefusal("tpl", command), null);
  // The warning reads options only: --no-daemon after -- is missing.
  assert.match(codexTemplateWarning("tpl", "codex -- --no-daemon"), /without --no-daemon/);
  assert.equal(codexCommandCheck("codex -- --no-daemon").missing.includes("--no-daemon"), true);
});

// ---- the CLI: starts, workers and hc's answers ----

/** A scratch world: a git project whose Codex Dev plays t1, a fake hc and an app home; XDG folders under the root. */
function scene(t, { programs = null, templates = [], env: more = {} } = {}) {
  const root = scratchRoot(t, "hb-codexmode-");
  const bots = { version: 1, categories: [], bots: [
    { id: ID.main, name: "Genie", kind: "main", agent: "claude", look: { character: "star", colour: "blue" }, role: "r", instructions: "i" },
    { id: ID.dev, name: "Dev", kind: "member", agent: "codex", look: { character: "star", colour: "blue" }, role: "r", instructions: "i" }] };
  const project = scratchProject(root, "proj", { branch: "main", commit: true, bots });
  const bin = join(root, "bin"), home = join(root, "home"), app = join(root, "app");
  // The default app home under the home folder is there too, as on an installed machine (#1142: one that isn't withholds every folder).
  for (const d of [bin, join(home, ".npm"), join(home, ".config/herdr-app"), join(root, "state/herdr-core"), join(root, "data/herdr-core"),
    join(app, "mods/am-sidebar")]) {
    mkdirSync(d, { recursive: true });
  }
  exe(join(bin, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  exe(join(bin, "herdr-app"), "#!/bin/sh\necho \"no window in tests\" >&2\nexit 1\n");
  for (const a of ["codex", "claude"]) exe(join(bin, a), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(app, "mods/am-sidebar/briefing.mjs"), "// stand-in\n");
  if (programs) writeFileSync(join(app, "programs.json"), `${JSON.stringify({ programs })}\n`);
  const statePath = join(root, "hc.json"), logPath = join(root, "hc.log");
  const term = (address, labels) => ({ address, name: address, cwd: project, state: "live", parent: null, created_ms: 1, labels,
    foreground: { argv: ["codex"], cwd: project, pid: 4000 }, status: { app: "codex", state: "idle" } });
  writeFileSync(statePath, JSON.stringify({ terminals: [term("t1", { bot: ID.dev })], next: 100, templates }));
  writeFileSync(logPath, "");
  // No attach ledger yet: its one-time import ties t1 to Dev by its bot label, as worker.test.mjs's scenes do.
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, HERDR_APP_HOME: app, HC_FAKE_STATE: statePath, HC_FAKE_LOG: logPath, LANG: "C",
    GIT_CEILING_DIRECTORIES: root, XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"),
    HC_SOCKET: join(root, "unproxied.sock"), AUTOMAGIK_HERDR_TAB_WAIT_MS: "0", AUTOMAGIK_HERDR_RESTART_STABLE_MS: "1", ...more };
  env.HC_TERMINAL_SOCKET = env.HC_SOCKET;
  const cli = (args, { from = "t1" } = {}) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: project, env: { ...env, ...(from ? { HC_TERMINAL_ID: from } : {}) }, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const state = () => JSON.parse(readFileSync(statePath, "utf8"));
  const setState = (f) => { const now = state(); f(now); writeFileSync(statePath, JSON.stringify(now)); };
  const runs = () => readJsonLines(logPath).filter((c) => c[0] === "run");
  const grants = [realpathSync(join(project, ".git")), join(root, "state/herdr-core"), join(root, "data/herdr-core"), join(home, ".npm")];
  return { root, project, home, app, cli, runs, setState, grants };
}
/** What an `hc run` call launches, past `/usr/bin/env NAME=value…` and the seat's briefing. */
const launched = (call) => {
  const words = call.slice(call.indexOf("--") + 1);
  let i = words[0] === "/usr/bin/env" ? 1 : 0;
  while (i && i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += 1;
  return withoutBriefing("codex", words.slice(i));
};
const addDirs = (argv) => argv.flatMap((w, i) => (w === "--add-dir" ? [argv[i + 1]] : []));

test("a Codex seat's start: the launch mode, its source's bypass words left out by name, the derived grants and never the home folder", (t) => {
  const s = scene(t, { programs: { codex: { run: ["codex", "--dangerously-bypass-approvals-and-sandbox", "-c", 'sandbox_mode="danger-full-access"',
    "--add-dir", "/"] } } });
  s.setState((st) => { st.terminals = []; }); // Dev isn't running: this is its start.
  const r = s.cli(["start", "Dev", "--json"], { from: null });
  assert.equal(r.code, 0, r.err);
  const argv = launched(s.runs()[0]);
  assert.deepEqual(argv.slice(0, 1 + MODE.length), ["codex", ...MODE]);
  assert.deepEqual(addDirs(argv), s.grants);
  assert.deepEqual(argv.filter((w) => BYPASS.includes(w) || w.startsWith("sandbox_mode")), []);
  assert.equal(addDirs(argv).some((d) => homeWide(d, s.home) || d === "/"), false);
  assert.match(r.err, /programs\.json's Codex command names --dangerously-bypass-approvals-and-sandbox, -c sandbox_mode, --add-dir: left out/);
  assert.equal(r.err.includes("danger-full-access"), false, "no value printed");
});

test("a Codex worker in a linked worktree may write its own git dir and the main checkout's .git (its common dir); a template keeps hc's template form", (t) => {
  const s = scene(t, { templates: [
    { name: "old-codex", command: "codex --sandbox workspace-write --ask-for-approval never -c sandbox_workspace_write.network_access=true" },
    { name: "mac-dev", command: "codex --no-daemon --dangerously-bypass-approvals-and-sandbox -m gpt-6.1-sol" }] });
  const r = s.cli(["worker", "fix the thing", "--branch", "fix/1125-a", "--agent", "codex", "--json"]);
  assert.equal(r.code, 0, r.err);
  const argv = launched(s.runs().at(-1));
  assert.deepEqual(argv.slice(0, 1 + MODE.length), ["codex", ...MODE]);
  const worktree = realpathSync(join(s.project, ".claude/worktrees/fix-1125-a"));
  assert.equal(git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir").trim(), realpathSync(join(s.project, ".git")));
  // Its own git dir (Codex keeps it read-only beside the common dir: a commit there failed in the e2e without it), then the common dir.
  const own = git(worktree, "rev-parse", "--path-format=absolute", "--git-dir").trim();
  assert.equal(own, join(realpathSync(join(s.project, ".git")), "worktrees/fix-1125-a"));
  assert.deepEqual(addDirs(argv), [own, ...s.grants], "never the worktree's own .git file");
  assert.equal(argv.at(-1), "fix the thing");
  // A template without --no-daemon: started in hc's template form (its instructions kept), one warning with the fix.
  const old = s.cli(["worker", "task two", "--branch", "fix/1125-b", "--template", "old-codex", "--json"]);
  assert.equal(old.code, 0, old.err);
  assert.deepEqual(s.runs().at(-1).slice(-2), ["old-codex", "task two"]);
  assert.match(old.err, /Template old-codex runs Codex without --no-daemon.*Add --no-daemon/);
  // #1142, warning-only: it starts in hc's template form, never with the pack's folders and never classified granted.
  const oldCall = s.runs().at(-1);
  assert.equal(oldCall.includes("--add-dir"), false, "a warning-only template worker gets no pack-injected --add-dir");
  assert.equal(oldCall.includes("worker.template=old-codex"), true, "labelled as that template's worker");
  assert.equal(oldCall.includes("--"), false, "hc's template form: the template runs its own command, never an argv of the pack's");
  assert.equal("granted" in JSON.parse(old.out), false, "a warning-only template worker is never classified granted");
  // The owner's bypass template: neither refused nor warned, its command untouched.
  const mac = s.cli(["worker", "task three", "--branch", "fix/1125-c", "--template", "mac-dev", "--json"]);
  assert.equal(mac.code, 0, mac.err);
  assert.deepEqual(s.runs().at(-1).slice(-2), ["mac-dev", "task three"]);
  assert.equal(/no-daemon/.test(mac.err), false);
});

test("hc's answers about the calling pane are told apart: not found, a failed lookup, an unreadable answer; nothing starts", (t) => {
  const s = scene(t);
  const before = s.runs().length;
  const missing = s.cli(["worker", "x", "--branch", "fix/1125-d", "--agent", "codex"], { from: "t9" });
  assert.equal(missing.code, 1);
  assert.match(missing.err, /t9 isn't a terminal hc knows \(hc get: not found\)/);
  s.setState((st) => { st.failGet = ["t1"]; });
  const failed = s.cli(["worker", "x", "--branch", "fix/1125-d", "--agent", "codex"]);
  assert.equal(failed.code, 1);
  assert.match(failed.err, /hc couldn't look up this pane \(t1\).*hc get t1 failed: hc: server error reading t1 \(exit 1\).*Nothing was started/s);
  assert.equal(/isn't a terminal hc knows/.test(failed.err), false, "a failed lookup never reads as a missing pane");
  s.setState((st) => { st.failGet = []; st.badGet = ["t1"]; });
  const bad = s.cli(["worker", "x", "--branch", "fix/1125-d", "--agent", "codex"]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /hc couldn't look up this pane \(t1\).*printed no JSON/s);
  assert.equal(s.runs().length, before, "no hc run on any refusal");
});

test("#1142 a Codex seat's start resolves programs.json's --add-dir here: a symlink to the home folder, an app home, its parent and a dangling link go", (t) => {
  const s = scene(t);
  symlinkSync(s.home, join(s.root, "to-home"));
  symlinkSync(join(s.root, "nowhere"), join(s.root, "dangling"));
  mkdirSync(join(s.root, "shared/real"), { recursive: true });
  const app = join(s.root, "app");
  // #1142: a link to a child of the home folder or of the app home, then .., is that folder, not shared/.
  for (const d of [join(s.home, "child"), join(app, "child")]) mkdirSync(d, { recursive: true });
  symlinkSync(join(s.home, "child"), join(s.root, "shared/home-link"));
  symlinkSync(join(app, "child"), join(s.root, "shared/app-link"));
  writeFileSync(join(app, "programs.json"), `${JSON.stringify({ programs: { codex: { run: ["codex", "--add-dir", join(s.root, "to-home"),
    "--add-dir", join(app, "x"), "--add-dir", join(s.home, ".config"), "--add-dir", `${s.home}/work/..`, "--add-dir", join(s.root, "dangling", "x"),
    "--add-dir", join(s.root, "shared"), "--add-dir", `${s.root}/shared/home-link/..`, "--add-dir", `${s.root}/shared/app-link/..`,
    "--add-dir", `${s.root}/shared/real/../real`] } } })}\n`);
  s.setState((st) => { st.terminals = []; });
  const r = s.cli(["start", "Dev", "--json"], { from: null });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(addDirs(launched(s.runs()[0])), [join(s.root, "shared"), join(s.root, "shared/real"), ...s.grants],
    "ordinary folders stay, each as its canonical value, before the derived ones");
  assert.match(r.err, /programs\.json's Codex command names --add-dir: left out/);
  // The two whose place can't be proved here (a dangling link; a .. after a folder that isn't there): withheld, counted, said once.
  assert.equal(r.err.split(someWithheld(2)).length - 1, 1, r.err);
});

test("#1142 the CLI refuses a worker template that puts a Codex option after its --, before anything starts; the owner's flags before -- run", (t) => {
  const s = scene(t, { templates: [{ name: "lost-dd", command: "codex -m x -- --no-daemon" },
    { name: "mac-dev", command: "codex --no-daemon --dangerously-bypass-approvals-and-sandbox -m gpt-6.1-sol" }] });
  const before = s.runs().length;
  const r = s.cli(["worker", "task", "--branch", "fix/1142-a", "--template", "lost-dd", "--json"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /Template lost-dd runs Codex with --no-daemon after its --, where Codex reads it as prompt text.*not started/);
  assert.equal(s.runs().length, before, "no hc run");
  assert.equal(existsSync(join(s.project, ".claude/worktrees/fix-1142-a")), false, "no worktree made");
  const mac = s.cli(["worker", "task", "--branch", "fix/1142-b", "--template", "mac-dev", "--json"]);
  assert.equal(mac.code, 0, mac.err);
  const call = s.runs().at(-1);
  assert.deepEqual(call.slice(-2), ["mac-dev", "task"]);
  assert.equal(call.includes("--add-dir"), false, "no pack-injected --add-dir for a template worker");
  assert.equal("granted" in JSON.parse(mac.out), false);
});

test("#1142 the CLI says what a Codex launch withheld once per launch, counting each folder once: start, restart, --tree helpers, workers; never for a template worker", (t) => {
  const out = realpathSync(scratchRoot(t, "hb-1142-out-"));
  symlinkSync(join(out, "nowhere"), join(out, "dangling"));
  symlinkSync(join(out, "nowhere"), join(out, "gp"));
  // Withheld: an --add-dir through a dangling link (written twice: one folder) and Go's module cache under a dangling GOPATH,
  // which programs.json names too (one folder, named and derived: counted once).
  const s = scene(t, { programs: { codex: { run: ["codex", "--add-dir", join(out, "dangling/x"), `--add-dir=${join(out, "dangling/x")}`,
    "--add-dir", join(out, "gp/pkg/mod")] } },
    templates: [{ name: "mac-dev", command: "codex --no-daemon --dangerously-bypass-approvals-and-sandbox -m gpt-6.1-sol" }],
    env: { GOPATH: join(out, "gp") } });
  const text = someWithheld(2);
  const times = (stderr, x) => stderr.split(x).length - 1;
  const said = (r, label, n = 1) => {
    assert.equal(r.code, 0, `${label}: ${r.err}`);
    assert.equal(times(r.err, text), n, `${label}: ${r.err}`);
    assert.equal(times(r.err, "Codex extra folders withheld"), n, `${label}: one warning per launch`);
    assert.equal(/working folder only/.test(r.err), false, label);
  };
  // A worker in the launch mode: its launch's warning; the folders that are proved still granted.
  said(s.cli(["worker", "task one", "--branch", "fix/1142-w", "--agent", "codex", "--json"]), "worker");
  const own = realpathSync(join(s.project, ".git/worktrees/fix-1142-w"));
  assert.deepEqual(addDirs(launched(s.runs().at(-1))), [own, ...s.grants], "worker");
  // A template worker runs its own command: nothing of the pack's, no warning.
  said(s.cli(["worker", "task two", "--branch", "fix/1142-t", "--template", "mac-dev", "--json"]), "template worker", 0);
  // Restart --tree: the seat's launch and its Codex worker's, one warning each (the worker's by its name); the template worker none.
  const tree = s.cli(["restart", "Dev", "--tree", "--fresh", "--force", "--json"], { from: null });
  said(tree, "restart --tree", 2);
  assert.equal(times(tree.err, `fix-1142-w: ${text}`), 1, "the helper's, by its name");
  // A restart alone, then two starts: one each.
  said(s.cli(["restart", "Dev", "--fresh", "--force", "--json"], { from: null }), "restart");
  for (const n of [1, 2]) {
    s.setState((st) => { st.terminals = []; });
    said(s.cli(["start", "Dev", "--json"], { from: null }), `start ${n}`);
    assert.deepEqual(addDirs(launched(s.runs().at(-1))), s.grants, `start ${n}`);
  }
});

/** scene() whose seat t1 runs a compliant Codex seat template, the agent row naming an --add-dir through a dangling link. */
function templateSeat(t, env = {}) {
  const out = realpathSync(scratchRoot(t, "hb-1142-tpl-"));
  symlinkSync(join(out, "nowhere"), join(out, "dangling"));
  symlinkSync(join(out, "nowhere"), join(out, "gp"));
  const s = scene(t, { programs: { codex: { run: ["codex", "--add-dir", join(out, "dangling/x")] } },
    templates: [{ name: "codex-seat", command: "codex -m x" }], env: typeof env === "function" ? env(out) : env });
  s.setState((st) => { Object.assign(st.terminals[0], { template: "codex-seat", argv: ["sh", "-c", 'codex -m x "$@"'],
    foreground: { ...st.terminals[0].foreground, argv: ["codex", "-m", "x"] } }); });
  const restart = () => {
    const r = s.cli(["restart", "Dev", "--fresh", "--force", "--json"], { from: null });
    assert.equal(r.code, 0, r.err);
    const argv = launched(s.runs().at(-1));
    assert.deepEqual(argv.slice(0, 4), ["sh", "-c", 'codex -m x "$@"', "sh"], "the seat's template, kept");
    assert.equal(argv.join(" ").includes(join(out, "dangling")), false, "the agent row's --add-dir is no part of this launch");
    return { r, argv };
  };
  return { ...s, out, restart };
}

test("#1142 a restarted Codex seat template's warning counts its own launch: no warning when every derived folder is proved, whatever the agent row names", (t) => {
  const s = templateSeat(t);
  const { r, argv } = s.restart();
  assert.deepEqual(addDirs(argv), s.grants, "every derived folder proved and granted");
  assert.equal(r.err.includes("Codex extra folders withheld"), false, `nothing this launch would pass was withheld: ${r.err}`);
});

test("#1142 a restarted Codex seat template with one derived folder withheld: exactly one warning, counting that folder only", (t) => {
  const s = templateSeat(t, (out) => ({ GOPATH: join(out, "gp") }));
  const { r, argv } = s.restart();
  assert.deepEqual(addDirs(argv), s.grants, "the proved ones still granted");
  assert.equal(r.err.split("Codex extra folders withheld").length - 1, 1, `one warning for the launch: ${r.err}`);
  assert.equal(r.err.split(`Dev: ${someWithheld(1)}`).length - 1, 1, `the module cache under the dangling GOPATH, alone: ${r.err}`);
});

test("#1142 a Codex seat on a linked machine: its --add-dir words and derived folders are weighed by that machine's home and app home", (t) => {
  const root = realpathSync(scratchRoot(t, "hb-1142-vm-"));
  const bin = join(root, "bin"), home = join(root, "home"), app = join(root, "app"), vm = join(root, "vm"), vmBin = join(root, "vm-bin");
  for (const d of [bin, home, app, vmBin, join(vm, ".config/herdr-app"), join(vm, ".npm"), join(vm, ".local/state/herdr-core"), join(vm, "shared")]) {
    mkdirSync(d, { recursive: true });
  }
  symlinkSync(vm, join(vm, "link-home"));
  // #1142: links there to a child of that machine's home and of its app home, then ..: that folder, resolved there.
  for (const d of [join(vm, "child"), join(vm, ".config/herdr-app/child"), join(vm, "shared/real")]) mkdirSync(d, { recursive: true });
  symlinkSync(join(vm, "child"), join(vm, "shared/home-link"));
  symlinkSync(join(vm, ".config/herdr-app/child"), join(vm, "shared/app-link"));
  exe(join(bin, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  exe(join(bin, "herdr-app"), "#!/bin/sh\nexit 1\n");
  exe(join(vmBin, "codex"), "#!/bin/sh\nexit 0\n");
  exe(join(vmBin, "uname"), "#!/bin/sh\necho Linux\n");
  // This computer's rules alone would keep every one of these: none is under its home or app home.
  writeFileSync(join(app, "programs.json"), `${JSON.stringify({ programs: { codex: { run: ["codex", "--add-dir", `${vm}/.`,
    "--add-dir", join(vm, "link-home"), "--add-dir", join(vm, ".config/herdr-app/x"), "--add-dir", join(vm, ".config"), "--add-dir", join(vm, "shared"),
    "--add-dir", `${vm}/shared/home-link/..`, "--add-dir", `${vm}/shared/app-link/..`, "--add-dir", `${vm}/shared/real/../real`] } } })}\n`);
  const project = scratchProject(vm, "proj", { commit: true, bots: { version: 1, categories: [], bots: [
    { id: ID.dev, name: "Dev", kind: "main", agent: "codex", look: { character: "star", colour: "blue" }, role: "r", instructions: "i" }] } });
  const statePath = join(root, "hc.json"), logPath = join(root, "hc.log");
  const blank = Object.fromEntries(["HERDR_APP_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "GOPATH", "GOMODCACHE",
    "GOCACHE", "npm_config_cache", "NPM_CONFIG_CACHE", "BUN_INSTALL", "BUN_INSTALL_CACHE_DIR"].map((k) => [k, ""]));
  blank.GOCACHE = `${vm}/shared/app-link/..`; // that machine's app home, through a link and ..: never granted
  writeFileSync(statePath, JSON.stringify({ next: 100, terminals: [],
    machines: [{ name: "vm", id: "core-of-vm", state: "connected", uname: "Linux x86_64", home: vm, path: vmBin, env: blank }] }));
  writeFileSync(logPath, "");
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, HERDR_APP_HOME: app, HC_FAKE_STATE: statePath, HC_FAKE_LOG: logPath, LANG: "C",
    GIT_CEILING_DIRECTORIES: root, XDG_DATA_HOME: "", AUTOMAGIK_HERDR_TAB_WAIT_MS: "0" };
  const r = spawnSync(process.execPath, [CLI, "start", "Dev", "--machine", "vm", "--project", project, "--json"], { cwd: root, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const call = readJsonLines(logPath).find((c) => c[0] === "run");
  const argv = launched(call);
  assert.deepEqual(argv.slice(0, 1), ["codex"]);
  assert.deepEqual(addDirs(argv), [join(vm, "shared"), join(vm, "shared/real"), realpathSync(join(project, ".git")), join(vm, ".local/state/herdr-core"),
    join(vm, ".npm")]);
  modeAsOptions(argv.slice(1), "the linked seat");
  assert.match(r.stderr, /vm: an --add-dir in Codex's command names the home folder, an app home, a folder above one or a relative path: left out \(#1142\)\./);
  assert.equal(r.stderr.includes("Codex extra folders withheld"), false, "each one is refused by a rule: nothing withheld, no warning");
  assert.ok(readJsonLines(logPath).some((c) => c[0] === "exec" && c.includes("vm") && c.some((w) => typeof w === "string" && w.includes("pwd -P"))),
    "resolved there, through hc exec");
  // Its restart there weighs the same words there: the same folders, each as its canonical value.
  writeFileSync(logPath, "");
  const again = spawnSync(process.execPath, [CLI, "restart", "Dev", "--machine", "vm", "--project", project, "--fresh", "--force", "--json"],
    { cwd: root, env, encoding: "utf8" });
  assert.equal(again.status, 0, again.stderr);
  const rerun = readJsonLines(logPath).find((c) => c[0] === "run");
  assert.deepEqual(addDirs(launched(rerun)), addDirs(argv), "the restart's folders");
  modeAsOptions(launched(rerun).slice(1), "the linked restart");
});
